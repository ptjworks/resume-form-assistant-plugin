#!/usr/bin/env node
// #429 第 11 项：一键填写里 AI 那一步的手动评测，比较两种发法填对、填错、没填的题数。
//   keys：现在的发法，资料只发编号、分组和字段名，AI 回编号，值在本地取（ai-worker.js）。
//   values：之前的发法，资料连值一起发，AI 回值。代码在 scripts/eval-fill-legacy.js，不进插件包，下个版本删掉。
// 资料（tests/fixtures/fill-eval/resume.json）和网页字段（pages.json）都是虚构的，每题人工标了该填的值。
// 跑的是真实的 ai-worker.js（本地规则 + AI + 本地核对），只把桌面换成直接请求服务商；打分按 content.js 填写时的规矩：
// 下拉要落到选项上，日期按题目取开始或结束，级联要认得出地区。
//
// 模拟模型（不联网，CI 里也跑）：node scripts/eval-fill.mjs --mock empty
// 真实模型（会产生费用，不进 CI）：Key 只从环境变量读，用 1Password 注入，不出现在命令行和结果里：
//   op-dev run --env-file <只写 RESUME_PRO_EVAL_API_KEY=op://… 的文件> -- node scripts/eval-fill.mjs \
//     --base-url https://host/v1 --model name --confirm-paid [--runs 3] [--modes keys,values] [--out result.json]
//   --base-url 只收 https；本机（localhost、127.0.0.1、::1）调试的 http 服务另加 --allow-http。
//   --pad N 往资料里补 N 道无关的长题目，测整份目录装不下时的分批。
// 结果文件只有每题的结论（对、错、没填）、计数、耗时和字节数；不含模型原文。
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const helpers = require("../ai-helpers.js");
const profileApi = require("../profile-fields.js");
const regions = (() => {
  const scope = {};
  vm.runInNewContext(readFileSync(join(ROOT, "region-data.js"), "utf8"), { self: scope });
  return scope.ResumeProRegions;
})();
const WORKER = readFileSync(join(ROOT, "ai-worker.js"), "utf8");
// 之前的发法：在同一个 vm 里接着 ai-worker.js 跑，把 handleAiFill 换掉。
const LEGACY = readFileSync(join(ROOT, "scripts", "eval-fill-legacy.js"), "utf8");
const SITE_GROUP = profileApi.SITE_GROUP;

// 和 content.js 一样拼资料：模板（桌面解析的字段按 semanticizeParsedFields 改过名）在前，「我的信息」里没重名的在后；
// 本网站存过的回答（#452）放最后。
export function loadCorpus(dir = join(ROOT, "tests", "fixtures", "fill-eval")) {
  const resume = JSON.parse(readFileSync(join(dir, "resume.json"), "utf8"));
  const { pages } = JSON.parse(readFileSync(join(dir, "pages.json"), "utf8"));
  const resumeFields = [
    ...profileApi.mergeResumeFields(helpers.semanticizeParsedFields(resume.template), profileApi.profileToResumeFields(resume.profile)),
    ...(resume.siteAnswers || []).map(({ key, value }) => ({ group: SITE_GROUP, key, value }))
  ];
  return { resumeFields, pages: pages.map((page) => ({ ...page, formFields: page.fields.map(formField) })) };
}

// pages.json 的简写展开成 content.js 交给 worker 的字段（addScannedControls）。
export function formField(spec) {
  const base = { fieldId: spec.id, label: spec.label, placeholder: spec.placeholder || "", ariaLabel: "", group: spec.group || "",
    name: "", idAttr: "" };
  switch (spec.kind) {
    case "select":
      return { ...base, controlKind: "native-select", tagName: "select", inputType: "select", options: spec.options || [], dynamicOptions: false,
        ...(spec.cascadeGroup ? { cascadeGroup: spec.cascadeGroup, cascadeLevel: spec.cascadeLevel } : {}) };
    case "radio":
      return { ...base, controlKind: "radio", tagName: "input", inputType: "radio", options: spec.options || [] };
    case "custom-select":
      return { ...base, controlKind: "custom-select", tagName: "input", inputType: "select", options: [], dynamicOptions: true,
        ...(spec.multiple ? { multiple: true } : {}) };
    case "cascader":
      return { ...base, controlKind: "cascader", tagName: "input", inputType: "select", options: [], dynamicOptions: true, cascade: true };
    case "date":
      return { ...base, controlKind: "date", tagName: "input", inputType: "date-picker", pickerType: "element",
        pickerInputType: spec.picker || "date", options: [] };
    case "textarea":
      return { ...base, controlKind: "textarea", tagName: "textarea", inputType: "textarea", options: [], dynamicOptions: false };
    default:
      return { ...base, controlKind: "text", tagName: "input", inputType: "text", options: [], dynamicOptions: false };
  }
}

// 和语料里的题都无关的虚构存档题，字段名截到 60 字后也有五十多个字。
export function padding(count) {
  return Array.from({ length: Math.max(0, Math.min(1000, count)) }, (_, i) => ({ group: SITE_GROUP,
    key: `存档题${i + 1}：请结合第${i + 1}个虚构场景，谈谈你会如何安排一次跨城市的志愿者物资调配，并估算所需的车辆和人手`,
    value: `虚构存档回答${i + 1}` }));
}

// 题型，按它分开数。
export function fieldType(spec) {
  if (spec.open) return "开放题";
  if (spec.kind === "textarea") return "长文本";
  if (spec.kind === "date") return "日期";
  if (spec.kind === "cascader" || spec.cascadeGroup) return "地区";
  if (spec.multiple) return "多选";
  if (["select", "radio", "custom-select"].includes(spec.kind)) return "下拉单选";
  return "文本";
}

const optionIndex = (options, value) => helpers.findSelectOptionIndex(options, value);
const regionPath = (value) => regions.resolve(value)?.path.filter((part) => !part.placeholder).map((part) => part.name).join("/") || "";

// 一题的结论：correct 填对，wrong 填错，missed 该填没填（包括值落不到选项上、页面填不进去的），
// empty 该空着也空着，written 开放题被 AI 现写了一段（不算对错，单列）。
export function scoreField(spec, value) {
  const filled = typeof value === "string" && value.trim() !== "";
  if (spec.expect === null) return !filled ? "empty" : spec.open ? "written" : "wrong";
  if (!filled) return "missed";
  const options = spec.pageOptions || spec.options;
  if (["select", "radio", "custom-select"].includes(spec.kind) && options?.length) {
    if (spec.multiple) {
      const got = helpers.splitMultipleValues(value, options).map((part) => optionIndex(options, part));
      if (got.some((index) => index < 0)) return "missed";
      const want = helpers.splitMultipleValues(spec.expect, options).map((part) => optionIndex(options, part));
      return got.length === want.length && want.every((index) => got.includes(index)) ? "correct" : "wrong";
    }
    const got = optionIndex(options, value);
    if (got < 0) return "missed";
    return got === optionIndex(options, spec.expect) ? "correct" : "wrong";
  }
  if (spec.kind === "cascader") {
    const got = regionPath(value);
    if (!got) return "missed";
    return got === regionPath(spec.expect) ? "correct" : "wrong";
  }
  if (spec.kind === "date") {
    const hint = [spec.label, spec.placeholder].filter(Boolean).join(" ");
    const mode = spec.picker || "date";
    const picked = helpers.rangeDateValue(value, hint);
    const got = helpers.normalizeDateValue(picked, mode);
    if (!/^\d{4}-\d{2}(-\d{2})?$/.test(got)) return helpers.rangeDateParts(value) ? "missed" : "wrong";
    return got === helpers.normalizeDateValue(spec.expect, mode) ? "correct" : "wrong";
  }
  const same = (a, b) => helpers.normalizeText(a) === helpers.normalizeText(b);
  return [spec.expect, ...(spec.anyOf || [])].some((want) => same(value, want)) ? "correct" : "wrong";
}

// 真实的 ai-worker.js：mode 是 keys 或 values；complete(system, user) 代替桌面，返回 { ok, text } 或 { ok: false, reason }。
export async function runPage(page, resumeFields, { mode, complete }) {
  const requests = [];
  const context = vm.createContext({
    importScripts() {}, ResumeProAIHelpers: helpers, ResumeProProfile: profileApi, ResumeProRegions: regions,
    AbortController, TextEncoder, performance, crypto: { randomUUID }
  });
  context.self = {
    postMessage(message) {
      if (message.kind !== "desktop-complete") return;
      const started = performance.now();
      Promise.resolve().then(() => complete(message.system, message.user)).catch((error) => ({ ok: false, reason: String(error?.message || "request_failed").slice(0, 40) }))
        .then((reply) => {
          requests.push({ ms: Math.round(performance.now() - started), bytes: Buffer.byteLength(message.user), ok: Boolean(reply?.ok),
            reason: reply?.ok ? "" : reply?.reason || "", tokens: reply?.tokens || null });
          context.self.onmessage({ data: { kind: "desktop-result", callId: message.callId, reply } });
        });
    }
  };
  vm.runInContext(WORKER, context);
  if (mode === "values") vm.runInContext(LEGACY, context);
  const result = JSON.parse(JSON.stringify(await context.handleAiFill({ formFields: page.formFields, resumeFields })));
  const values = new Map(result.matches.filter((match) => !match.blocked).map((match) => [match.fieldId, match.value]));
  // value 只给 --verbose 在控制台看（资料是虚构的），不写进结果文件。
  const fields = page.fields.map((spec) => ({ id: spec.id, label: spec.label, type: fieldType(spec), outcome: scoreField(spec, values.get(spec.id)),
    value: values.get(spec.id) ?? "" }));
  return { page: page.name, mode, fields, requests, ruleMatches: result.diagnostics.ruleMatches, aiFields: result.diagnostics.aiFields,
    aiMatches: result.diagnostics.aiMatches, errorCode: result.diagnostics.errorCode };
}

const OUTCOMES = ["correct", "wrong", "missed", "empty", "written"];

export function tally(rows) {
  const counts = Object.fromEntries(OUTCOMES.map((key) => [key, 0]));
  for (const row of rows) for (const field of row.fields) counts[field.outcome] += 1;
  const requests = rows.flatMap((row) => row.requests);
  return { ...counts, total: rows.reduce((sum, row) => sum + row.fields.length, 0), requests: requests.length,
    failedRequests: requests.filter((request) => !request.ok).length,
    promptBytes: requests.reduce((sum, request) => sum + request.bytes, 0),
    avgMs: requests.length ? Math.round(requests.reduce((sum, request) => sum + request.ms, 0) / requests.length) : null };
}

// 每题在各次运行里的结论，看两种发法哪题变了。
export function compareFields(rows) {
  const byField = new Map();
  for (const row of rows) {
    for (const field of row.fields) {
      const key = `${row.page}/${field.id}`;
      if (!byField.has(key)) byField.set(key, { page: row.page, id: field.id, label: field.label, type: field.type, keys: [], values: [], filled: { keys: [], values: [] } });
      byField.get(key)[row.mode].push(field.outcome);
      byField.get(key).filled[row.mode].push(field.value);
    }
  }
  return [...byField.values()];
}

export async function evaluate(corpus, { modes = ["keys", "values"], runs = 1, complete }) {
  const rows = [];
  for (let run = 0; run < runs; run++) {
    for (const page of corpus.pages) {
      for (const mode of modes) rows.push({ run, ...(await runPage(page, corpus.resumeFields, { mode, complete })) });
    }
  }
  return { byMode: Object.fromEntries(modes.map((mode) => [mode, tally(rows.filter((row) => row.mode === mode))])),
    fields: compareFields(rows), rows };
}

// 模拟模型：empty 什么都不回，只剩本地规则。
export function mockModel(kind) {
  if (kind !== "empty") throw new Error(`没有这种模拟模型：${kind}`);
  return async () => ({ ok: true, text: "[]" });
}

// http 只在 --allow-http 时、而且只发到本机（localhost、127.0.0.1、::1）：Key 在请求头里，不能明文出本机。
export function baseUrlAllowed(baseUrl, allowHttp = false) {
  let url;
  try { url = new URL(baseUrl); } catch { return false; }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return url.protocol === "https:" || (allowHttp && url.protocol === "http:" && local);
}

// OpenAI 兼容接口，和桌面发的同形：system + user，temperature 0，非流式。OpenCode 要带稳定的 x-opencode-session。
export function realModel({ baseUrl, model, apiKey, fetchImpl = fetch }) {
  const session = randomUUID();
  const opencode = /(^|\.)opencode\.ai$/i.test(new URL(baseUrl).hostname);
  return async (system, user) => {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, "user-agent": "wangshen-kuaitian-eval/0.1",
        ...(opencode ? { "x-opencode-session": session } : {}) },
      body: JSON.stringify({ model, temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: user }] })
    });
    if (!response.ok) return { ok: false, reason: `http_${response.status}` };
    const body = await response.json();
    const tokens = body.usage ? { prompt: body.usage.prompt_tokens || 0, completion: body.usage.completion_tokens || 0 } : null;
    return { ok: true, text: body.choices?.[0]?.message?.content || "", tokens };
  };
}

async function main(argv) {
  const option = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : "";
  };
  const corpus = loadCorpus(option("--corpus") || undefined);
  const runs = Math.max(1, Math.min(10, Number(option("--runs")) || 1));
  const modes = (option("--modes") || "keys,values").split(",").filter((mode) => ["keys", "values"].includes(mode));
  let complete;
  let label;
  if (option("--mock")) {
    complete = mockModel(option("--mock"));
    label = `mock:${option("--mock")}`;
  } else {
    const baseUrl = option("--base-url");
    const name = option("--model");
    const apiKey = process.env.RESUME_PRO_EVAL_API_KEY || "";
    if (!baseUrl || !name || !apiKey) {
      console.error("真实模型评测需要 --base-url、--model 和环境变量 RESUME_PRO_EVAL_API_KEY；只想检查流程请用 --mock empty。");
      process.exit(2);
    }
    // Key 放在请求头里：只发到 https。本机调试的 http 服务另加 --allow-http。
    if (!baseUrlAllowed(baseUrl, argv.includes("--allow-http"))) {
      console.error("--base-url 要用 https（本机 localhost、127.0.0.1、::1 上的 http 服务加 --allow-http）。");
      process.exit(2);
    }
    if (!argv.includes("--confirm-paid")) {
      console.error(`这会向 ${new URL(baseUrl).host} 发送约 ${corpus.pages.length * runs * modes.length} 次以上的请求并产生费用。确认后加上 --confirm-paid 再运行。`);
      process.exit(2);
    }
    complete = realModel({ baseUrl, model: name, apiKey });
    label = `${new URL(baseUrl).host} / ${name}`;
  }
  // --pad N：资料里补 N 道和这些表无关的长题目（本网站回答，虚构），凑出整份目录装不下的情形。
  if (option("--pad")) corpus.resumeFields.push(...padding(Number(option("--pad")) || 0));
  const only = option("--pages") ? new Set(option("--pages").split(",")) : null;
  if (only) corpus.pages = corpus.pages.filter((page) => only.has(page.name));
  const result = await evaluate(corpus, { modes, runs, complete });
  const questions = corpus.pages.reduce((sum, page) => sum + page.fields.length, 0);
  console.log(`模型：${label}；${corpus.pages.length} 张表 ${questions} 题 × ${runs} 次`);
  console.table(Object.fromEntries(Object.entries(result.byMode).map(([mode, t]) => [mode, {
    填对: t.correct, 填错: t.wrong, 没填: t.missed, 该空着: t.empty, 开放题现写: t.written, 请求: t.requests, 失败请求: t.failedRequests,
    发出字节: t.promptBytes, 平均毫秒: t.avgMs
  }])));
  // 一整张表 AI 一题都没给的（服务商偶尔秒回一个空数组），单独列出来，比较时心里有数。
  for (const row of result.rows.filter((row) => row.aiFields > 0 && row.aiMatches === 0)) {
    console.log(`第 ${row.run + 1} 次 ${row.page}（${row.mode}）：AI 一题没给，错误码 ${row.errorCode}`);
  }
  const changed = result.fields.filter((field) => field.keys.join() !== field.values.join());
  if (changed.length) {
    console.log("两种发法结论不同的题（keys | values，每次运行一个结论）：");
    for (const field of changed) {
      console.log(`  ${field.page}/${field.id} ${field.label}（${field.type}）：${field.keys.join(",")} | ${field.values.join(",")}`);
      if (argv.includes("--verbose")) console.log(`      keys 填了：${JSON.stringify(field.filled.keys)}；values 填了：${JSON.stringify(field.filled.values)}`);
    }
  }
  if (option("--out")) {
    const output = { model: label, at: new Date().toISOString(), runs, modes, questions, byMode: result.byMode,
      fields: result.fields.map(({ filled, ...field }) => field),
      requests: result.rows.map((row) => ({ run: row.run, page: row.page, mode: row.mode, aiFields: row.aiFields, aiMatches: row.aiMatches,
        errorCode: row.errorCode, requests: row.requests })) };
    writeFileSync(option("--out"), `${JSON.stringify(output, null, 2)}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`评测没有完成：${error?.message || error}`);
    process.exit(1);
  });
}
