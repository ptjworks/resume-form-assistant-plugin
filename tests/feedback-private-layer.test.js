// #497 报告看得出原因：用本地夹具造出几类问题（下拉没有选项、日期格式不符、资料里有却没匹配上、扫描出错），
// 跑真的一键填写（按 manifest 加载全部 content script），再交给真的后台发送，核对公开部分的固定词、私有部分的内容和脱敏。
// 夹具都是合成的，只有虚构的值。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
const core = require("../extension/feedback-core.js");

const ROOT = path.join(__dirname, "..", "extension");
const SCRIPTS = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).content_scripts[0].js;
const ORIGIN = "chrome-extension://test-extension/";

function layout(w) {
  const box = { top: 10, left: 10, width: 300, height: 30, right: 310, bottom: 40, x: 10, y: 10, toJSON() { return this; } };
  const empty = { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() { return this; } };
  const shown = (el) => !el.closest("[hidden]");
  w.Element.prototype.getBoundingClientRect = function () { return shown(this) ? box : empty; };
  w.Element.prototype.getClientRects = function () { return shown(this) ? [box] : []; };
  w.Element.prototype.scrollIntoView = function () {};
}

// resume：模板里的 { 字段名: 值 }。ai(message, ids)：AI 替身的回复，ids 是题目 → fieldId。
function page(t, { body, resume, ai, setup, agreed = true }) {
  const dom = new JSDOM(`<!doctype html><html><head><title>投递简历</title></head><body>${body}</body></html>`,
    { runScripts: "outside-only", pretendToBeVisual: true, url: "https://demo.jobs.example.test/campus/apply" });
  const w = dom.window;
  t.after(() => w.close());
  layout(w);
  setup?.(w);
  Object.defineProperty(w.document, "readyState", { get: () => "loading", configurable: true });
  const listen = w.document.addEventListener.bind(w.document);
  w.document.addEventListener = (type, ...rest) => (type === "DOMContentLoaded" ? undefined : listen(type, ...rest));
  w.__RESUME_PRO_TEST__ = true;
  w.confirm = () => true;
  const template = { id: "t", name: "虚构模板", groups: [{ name: "基本信息", fields: Object.entries(resume).map(([key, value]) => ({ key, value })) }] };
  const data = { templates: [{ id: "t", name: "虚构模板", fieldCount: Object.keys(resume).length }], activeTemplate: template,
    profile: { values: {}, family: [], custom: [] }, profileRevision: 0 };
  const reports = [];
  w.chrome = {
    runtime: { id: "test-extension", getURL: (file) => ORIGIN + file, getManifest: () => ({ version: "0.5.0" }),
      onMessage: { addListener() {} },
      sendMessage: async (message) => {
        if (message.type === "FEEDBACK_AUTO") { reports.push(message.report); return null; }
        if (message.type === "DESKTOP_RESUME_READ") return { status: "ok", data };
        if (["ENSURE_AI_HOST", "AI_HOST_READY"].includes(message.type)) return { ready: true };
        if (message.type !== "AI_FILL") return {};
        const ids = Object.fromEntries(message.formFields.map((field) => [field.label, field.fieldId]));
        return ai(message, ids);
      } },
    storage: { local: { get: async (key) => (key === "feedbackStateV1" && agreed ? { feedbackStateV1: { consent: true, consentVersion: 3 } } : {}), set: async () => {} }, session: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener() {} } }
  };
  const context = dom.getInternalVMContext();
  for (const file of SCRIPTS) new vm.Script(fs.readFileSync(path.join(ROOT, file), "utf8"), { filename: ORIGIN + file }).runInContext(context);
  const ui = { status: { textContent: "", className: "" }, diag: { value: "" }, cancel: { hidden: true, disabled: false, onclick: null },
    fill: { disabled: false, textContent: "" } };
  const parts = { "#resume-pro-status": ui.status, "#resume-pro-diagnostics": { hidden: true, open: false },
    "#resume-pro-diagnostics-text": ui.diag, "#resume-pro-cancel-fill": ui.cancel, "#resume-pro-ai-fill": ui.fill };
  const helpers = w.ResumeProHighlightTest;
  helpers.setShadowRoot({ querySelectorAll: () => [], querySelector: (selector) => parts[selector] || null });
  return { w, doc: w.document, ui, reports, run: () => helpers.handleAiFillClick({ currentTarget: ui.fill }) };
}

// The report as the worker sends it, with the user's agreement to notice 3.
async function send(report) {
  const { createFeedback } = await import("../extension/link/feedback.mjs");
  const data = {}; const bodies = [];
  const worker = createFeedback({ storage: { get: async () => structuredClone(data), set: async value => Object.assign(data, structuredClone(value)) },
    version: "0.5.0", os: "Windows / Chrome 140", install: () => "development",
    fetchImpl: async (url, request) => { bodies.push({ url, ...JSON.parse(request.body) }); return new Response('{"ok":true,"id":"x"}'); } });
  await worker.setConsent(true);
  const result = await worker.automatic(report, "demo.jobs.example.test");
  assert.equal(result.ok, true, JSON.stringify(result));
  return bodies[0];
}

const lineOf = (text, key) => text.split("\n").find((line) => line.startsWith(`${key}: `))?.slice(key.length + 2);
const item = (label, control) => `<div class="form-item"><label>${label}</label>${control}</div>`;

test("资料里有、AI 却没匹配上的字段达到 3 项：别的都填上了也上报 ai_missed，公开部分只有类别，私有部分有题目且已脱敏", async (t) => {
  const body = `<form><h3>基本信息</h3>
    ${item("姓名", '<input id="name">')}
    ${item("民族（如汉族）", '<input id="ethnic">')}
    ${item("婚否", '<select id="marital"><option value="">请选择</option><option>未婚</option><option>已婚</option></select>')}
    ${item("目前求职状态", '<input id="status">')}
    ${item("联系人 13912345678 的备注", '<input id="note">')}
  </form>`;
  const resume = { 姓名: "测试用户", 民族: "汉族", 婚姻状况: "未婚", 求职状态: "应届生", 手机号码: "13800000000" };
  const p = page(t, { body, resume, ai: (message, ids) => ({ success: true, matches: [], diagnostics: { ruleMatches: 0, aiFields: message.formFields.length,
    aiMatches: 0, promptBytes: 900, apiMs: 1200, errorCode: "none",
    // The worker's list of fields the AI saw and left alone; the note field has no kind of the resume.
    unansweredIds: [ids["民族（如汉族）"], ids["婚否"], ids["目前求职状态"], ids["联系人 13912345678 的备注"]].filter(Boolean) } }) });
  const result = await p.run();
  assert.equal(result.filledCount, 1, p.ui.diag.value);
  assert.equal(result.unfilledCount, 0);
  const report = p.reports.find((entry) => entry.kind === "fill_partial");
  assert.ok(report, JSON.stringify(p.reports.map((entry) => entry.kind)));
  // Public part: the category, and the misses by kind; no title, no value.
  assert.equal(lineOf(report.diagnostics, "error_category"), "ai_missed");
  assert.equal(lineOf(report.diagnostics, "ai_missed"), "民族=1,婚姻状况=1,求职状态=1,unknown=1");
  assert.equal(lineOf(report.diagnostics, "ai_missed_in_resume"), "民族,婚姻状况,求职状态");
  assert.equal(lineOf(report.diagnostics, "ai_missed_with_data"), "3");
  const sent = await send(report);
  assert.equal(sent.url, "https://feedback.19991107.xyz/feedback");
  assert.equal(sent.error_type, "fill_partial");
  assert.match(sent.user_description, /^build: dev$/m);
  for (const text of ["民族（如汉族）", "婚否", "目前求职状态", "13912345678", "测试用户", "汉族", "应届生"]) {
    assert.ok(!sent.user_description.includes(text), `${text} reached the public part`);
  }
  // Private part: titles, the group title, the native select's options as the page lists them, redacted.
  const hidden = sent.private_diagnostics;
  assert.equal(hidden.split("\n")[0], "--- 私有诊断 v1 ---");
  // 题目里有资料里的文字（汉族）：整段换掉。
  assert.match(hidden, /^\[AI未匹配 1\]\nlabel: 〔内容〕\nsection: 基本信息\nkind: 民族\nin_resume: yes$/m);
  assert.match(hidden, /^label: 目前求职状态\nsection: 基本信息\nkind: 求职状态\nin_resume: yes$/m);
  assert.match(hidden, /^label: 婚否\nsection: 基本信息\nkind: 婚姻状况\nin_resume: yes\noptions: 请选择 \| 未婚 \| 已婚$/m);
  assert.match(hidden, /^label: 〔内容〕\nsection: 基本信息\nkind: unknown\nin_resume: no$/m, "a title with a phone number is replaced");
  assert.match(hidden, /^\[页面大纲\]\n\[区块\] 基本信息\n/m);
  assert.match(hidden, /^> {1}e\d+ select ← 婚否$/m, "the failing field's line is marked");
  assert.match(hidden, /^ {2}e\d+ input\[text\] ← 姓名$/m, "a field that got filled is context, not marked");
  for (const text of ["13912345678", "13800000000", "测试用户", "应届生", "汉族"]) assert.ok(!hidden.includes(text), `${text} reached the private part`);
  assert.ok(new TextEncoder().encode(hidden).length <= 16384);
});

test("下拉点开后一直在加载、没有选项：公开部分有控件的样子和等待过程，私有部分有题目、分组和出错字段附近的页面结构", async (t) => {
  const body = `<form><h3>教育信息</h3>
    <label id="q">学历层次</label><button type="button" role="combobox" aria-labelledby="q" aria-controls="choices" aria-expanded="false">请选择</button>
    ${item("毕业院校", '<input id="school">')}
  </form><div id="choices" role="listbox" hidden></div>`;
  const resume = { 学历: "硕士", 毕业院校: "示例大学" };
  const p = page(t, { body, resume, setup: (w) => {
    const combo = w.document.querySelector('[role="combobox"]');
    combo.onclick = () => {
      const list = w.document.getElementById("choices");
      list.hidden = false; list.setAttribute("aria-busy", "true");
      list.innerHTML = '<span class="list-loading"></span>';
      combo.setAttribute("aria-expanded", "true");
    };
  }, ai: (message, ids) => ({ success: true, matches: [{ fieldId: ids["学历层次"], value: "硕士" }, { fieldId: ids["毕业院校"], value: "示例大学" }]
    .filter((match) => match.fieldId), diagnostics: { ruleMatches: 0, aiFields: message.formFields.length, aiMatches: 2, promptBytes: 500, apiMs: 800, errorCode: "none" } }) });
  const result = await p.run();
  assert.equal(result.unfilledCount, 1, p.ui.diag.value);
  const report = p.reports.find((entry) => entry.kind === "fill_partial");
  assert.ok(report, JSON.stringify(p.reports.map((entry) => entry.kind)));
  const line = report.diagnostics.split("\n").find((entry) => entry.startsWith("- 学历: "));
  assert.ok(line, report.diagnostics);
  assert.match(line, / opened=listbox /);
  assert.match(line, / form=dropdown search=no remote=yes multi=no open_ms=\d+ wait_ms=\d+ spinner=yes reason=options_not_rendered$/);
  const sent = await send(report);
  assert.ok(sent.user_description.includes(line), "the worker keeps every new word");
  assert.ok(!sent.user_description.includes("学历层次"));
  const hidden = sent.private_diagnostics;
  assert.match(hidden, /^\[未填字段 1\]\nlabel: 学历层次\nsection: 教育信息\nkind: 学历\nreason: options_not_rendered$/m);
  assert.doesNotMatch(hidden, /^options: /m, "an empty list lists nothing");
  assert.match(hidden, /^> {1}e\d+ combobox ← 学历层次$/m);
  for (const text of ["硕士", "示例大学"]) assert.ok(!hidden.includes(text), `${text} reached the private part`);
});

test("日期格式不符：公开部分报日期控件和原因码，私有部分有题目；出生日期的值不出现", async (t) => {
  const body = `<form><h3>个人信息</h3>${item("出生日期", '<input id="birth" type="month">')}${item("姓名", '<input id="name">')}</form>`;
  const resume = { 姓名: "测试用户", 出生年月: "九八年六月" };
  // 资料里的日期写不成「1998-06」：worker 不交给控件，记作日期不对（ai-worker.js 的 pickerDate）。
  const p = page(t, { body, resume, ai: (message, ids) => ({ success: true, matches: [{ fieldId: ids["出生日期"], value: "", blocked: "invalid_date" }].filter((match) => match.fieldId),
    diagnostics: { ruleMatches: 0, aiFields: message.formFields.length, aiMatches: 1, promptBytes: 400, apiMs: 600, errorCode: "none" } }) });
  const result = await p.run();
  assert.equal(result.unfilledCount, 1, p.ui.diag.value);
  const report = p.reports.find((entry) => entry.kind === "fill_partial");
  assert.ok(report, JSON.stringify(p.reports.map((entry) => entry.kind)));
  const line = report.diagnostics.split("\n").find((entry) => entry.startsWith("- 出生日期: "));
  assert.match(line || "", /^- 出生日期: input\[month\] form=date reason=invalid_date$/, report.diagnostics);
  const sent = await send(report);
  const hidden = sent.private_diagnostics;
  assert.match(hidden, /^\[未填字段 1\]\nlabel: 出生日期\nsection: 个人信息\nkind: 出生日期\nreason: invalid_date$/m);
  for (const text of ["九八年六月", "测试用户"]) {
    assert.ok(!JSON.stringify(sent).includes(text), `${text} was sent`);
  }
});

test("扫描出错：公开部分有异常类型和读的是哪个属性，原文脱敏后只在私有部分", async (t) => {
  const body = `<form>${item("姓名", '<input id="name">')}${item("邮箱", '<input id="email">')}</form>`;
  const p = page(t, { body, resume: { 姓名: "测试用户" }, setup: (w) => {
    // 扫描整页时就会读到的属性出错：读一个不存在的对象的 style，原文里还带着页面上的邮箱。
    Object.defineProperty(w.document.getElementById("email"), "tagName", { configurable: true, get() {
      const missing = undefined; void "user@example.test"; return missing.style; } });
  }, ai: () => ({ success: true, matches: [], diagnostics: { errorCode: "none" } }) });
  await p.run();
  const crash = p.reports.find((entry) => entry.kind === "exception");
  assert.ok(crash, JSON.stringify(p.reports));
  assert.equal(crash.property, "style");
  const failed = p.reports.find((entry) => entry.kind === "fill_failed");
  assert.ok(failed, JSON.stringify(p.reports.map((entry) => entry.kind)));
  assert.equal(lineOf(failed.diagnostics, "exception_type"), "TypeError");
  assert.equal(lineOf(failed.diagnostics, "error_property"), "style");
  const sent = await send(failed);
  assert.doesNotMatch(sent.user_description, /Cannot read/);
  assert.match(sent.private_diagnostics, /^\[异常\]\ntype: TypeError\nmessage: Cannot read properties of undefined \(reading 'style'\)$/m);
  const crashSent = await send(crash);
  assert.match(crashSent.user_description, /^\[错误\]\nerror_property: style$/m);
  assert.doesNotMatch(crashSent.user_description, /Cannot read/);
  assert.match(crashSent.private_diagnostics, /message: Cannot read properties of undefined \(reading 'style'\)/);
});

test("没同意第 3 版说明的手动反馈：不带私有部分，也不带这次新增的词", async () => {
  const { createFeedback } = await import("../extension/link/feedback.mjs");
  const data = {};
  const worker = createFeedback({ storage: { get: async () => structuredClone(data), set: async value => Object.assign(data, structuredClone(value)) },
    version: "0.5.0", os: "Windows / Chrome 140", fetchImpl: async () => new Response("{}") });
  const block = core.fillReport({ fieldCount: 2, category: "ai_missed", stage: "match", aiMissed: [{ kind: "学校", inResume: true }],
    unfilledControls: [{ label: "最高学历", kind: "学历", reasonCode: "no_option_match", form: { form: "dropdown", search: true, waitMs: 900 },
      control: { tag: "input", type: "text" } }] });
  const consented = worker.preview({ description: "", diagnostics: core.diagnostics(block, { manual: true }), private: core.privateReport({ unfilled: [{ label: "最高学历", kind: "学历" }] }) });
  assert.match(consented.user_description, /^build: dev$/m);
  assert.match(consented.user_description, /^- 学历: input\[text\] form=dropdown search=yes wait_ms=900 reason=no_option_match$/m);
  assert.match(consented.private_diagnostics, /label: 最高学历/);
  const legacy = worker.preview({ description: "", legacy: true, diagnostics: core.diagnostics(block, { manual: true, legacy: true }),
    private: core.privateReport({ unfilled: [{ label: "最高学历", kind: "学历" }] }) });
  assert.equal(legacy.private_diagnostics, undefined);
  for (const words of ["build:", "[AI未匹配]", "ai_missed", "form=", "search=", "wait_ms="]) assert.ok(!legacy.user_description.includes(words), words);
  assert.match(legacy.user_description, /^- 学历: input\[text\] reason=no_option_match$/m);
});

test("私有层发送前再查一遍：只收字符串，换上自己的首行，再按描述的规则脱敏，不超过 16384 字节", () => {
  assert.equal(core.privateLayer(undefined), "");
  assert.equal(core.privateLayer({ label: "x" }), "");
  assert.equal(core.privateLayer("--- 私有诊断 v1 ---\n"), "");
  const forged = core.privateLayer("--- 私有诊断 v9 ---\nlabel: 邮箱 a@example.com 电话 13800138000 https://evil.example/x token=abcdef123456789");
  assert.equal(forged.split("\n")[0], "--- 私有诊断 v1 ---");
  for (const text of ["a@example.com", "13800138000", "evil.example", "abcdef123456789"]) assert.ok(!forged.includes(text), text);
  const huge = core.privateLayer(`--- 私有诊断 v1 ---\n${"题".repeat(20000)}`);
  assert.ok(new TextEncoder().encode(huge).length <= 16384);
  assert.equal(core.utf8Length("a题😀"), 1 + 3 + 4);
});

test("组件库的大版本只看类名：antd 3/4/5/6，Element UI 和 Element Plus；认不出就不报", () => {
  const w = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only" }).window;
  w.eval(fs.readFileSync(path.join(ROOT, "custom-controls.js"), "utf8"));
  const version = (html) => {
    w.document.body.innerHTML = html;
    const root = w.document.body.firstElementChild;
    return w.ResumeProCustomControls.libraryVersion(w.ResumeProCustomControls.describe({ element: root.querySelector("input") || root, root }));
  };
  assert.equal(version('<div class="ant-select"><div class="ant-select-selection"><input></div></div>'), "antd3");
  assert.equal(version('<div class="ant-select"><div class="ant-select-selector"><input></div></div>'), "antd4");
  assert.equal(version('<div class="ant-select css-dev-only-do-not-override-1x2y3z"><div class="ant-select-selector"><input></div></div>'), "antd5");
  assert.equal(version('<div class="ant-select css-ab12c"><div class="ant-select-content"><input></div></div>'), "antd6");
  assert.equal(version('<div class="el-select"><div class="el-input"><input class="el-input__inner"></div></div>'), "element-ui");
  assert.equal(version('<div class="el-select"><div class="el-select__wrapper"><input></div></div>'), "element-plus");
  assert.equal(version('<div class="arco-select"><input></div>'), "");
  assert.equal(w.ResumeProCustomControls.libraryVersion(null), "");
  w.close();
});

// Two ARIA dropdowns: the first one's list is fine, the second answers with a list that has no matching option.
function twoSelects(order) {
  const select = (id, label) => `<label id="${id}-q">${label}</label><button type="button" id="${id}" role="combobox" aria-labelledby="${id}-q" aria-controls="${id}-list" aria-expanded="false">请选择</button><div id="${id}-list" role="listbox" hidden></div>`;
  return { body: `<form><h3>教育信息</h3>${order.map(([id, label]) => select(id, label)).join("")}</form>`,
    setup: (w) => {
      for (const [id, , choices] of order) {
        const combo = w.document.getElementById(id);
        combo.onclick = () => {
          const list = w.document.getElementById(`${id}-list`);
          list.hidden = false; list.innerHTML = "";
          for (const text of choices) {
            const option = w.document.createElement("div"); option.setAttribute("role", "option"); option.textContent = text;
            option.onclick = () => { combo.textContent = text; combo.setAttribute("aria-expanded", "false"); option.setAttribute("aria-selected", "true"); list.hidden = true; };
            list.append(option);
          }
          combo.setAttribute("aria-expanded", "true");
        };
      }
    } };
}
const both = { 学历层次: "硕士", 所学专业: "历史学" };
const answer = (message, ids) => ({ success: true, matches: Object.entries(both).filter(([label]) => ids[label]).map(([label, value]) => ({ fieldId: ids[label], value })),
  diagnostics: { ruleMatches: 0, aiFields: message.formFields.length, aiMatches: 2, promptBytes: 500, apiMs: 800, errorCode: "none" } });

test("一个下拉的列表是在插件这次已经选过别的下拉之后才点开的：私有部分不收它的选项（可能按前面选的值加载）", async (t) => {
  const after = twoSelects([["degree", "学历层次", ["本科", "硕士"]], ["major", "所学专业", ["计算机科学", "数学"]]]);
  const p = page(t, { ...after, resume: { 学历: "硕士", 专业: "历史学" }, ai: answer });
  const result = await p.run();
  assert.equal(result.filledCount, 1, p.ui.diag.value);
  const report = p.reports.find((entry) => entry.kind === "fill_partial");
  assert.ok(report?.private, JSON.stringify(p.reports.map((entry) => entry.kind)));
  assert.match(report.private, /^\[未填字段 1\]\nlabel: 所学专业\nsection: 教育信息\nkind: 专业\nreason: no_option_match$/m);
  assert.doesNotMatch(report.private, /计算机科学/);

  // The same list opened first, before any choice: it is listed, in page order, nothing marked.
  const first = twoSelects([["major", "所学专业", ["计算机科学", "数学"]], ["degree", "学历层次", ["本科", "硕士"]]]);
  const q = page(t, { ...first, resume: { 学历: "硕士", 专业: "历史学" }, ai: answer });
  await q.run();
  const own = q.reports.find((entry) => entry.kind === "fill_partial");
  assert.match(own?.private || "", /^kind: 专业\nreason: no_option_match\noptions: 计算机科学 \| 数学$/m);
});

test("没同意自动报告：填完不做私有诊断，自动报告也不带它", async (t) => {
  const after = twoSelects([["major", "所学专业", ["计算机科学", "数学"]]]);
  const p = page(t, { ...after, agreed: false, resume: { 专业: "历史学" }, ai: answer });
  await p.run();
  const report = p.reports.find((entry) => entry.kind === "fill_failed" || entry.kind === "fill_partial");
  assert.ok(report, JSON.stringify(p.reports));
  assert.equal(report.private, undefined);
});

test("代码异常的原文只留代码本身的英文报错：引号里不是标识符的、中文和长数字都换掉，后台再做一遍结果不变", async () => {
  const cases = [
    ["Cannot read properties of undefined (reading 'style')", "Cannot read properties of undefined (reading 'style')"],
    ["Unexpected token '张' in JSON at position 3", "Unexpected token '〔内容〕' in JSON at position 3"],
    ["学校 示例大学 not found", "〔内容〕 〔内容〕 not found"],
    ["Failed to fetch https://x.example/a for 13800138000", "Failed to fetch [网址] for [数字]"],
    ['bad value "Zhang San, 2001" here', 'bad value "〔内容〕" here']
  ];
  for (const [raw, kept] of cases) {
    assert.equal(core.codeMessage(raw), kept, raw);
    assert.equal(core.codeMessage(kept), kept, `again: ${raw}`);
  }
  // The worker applies it to whatever message a page hands it.
  const sent = await send({ kind: "exception", name: "TypeError", source: "error", stack: "content.js:1:1", message: "学校 示例大学 not found" });
  assert.match(sent.private_diagnostics, /^message: 〔内容〕 〔内容〕 not found$/m);
  assert.doesNotMatch(sent.private_diagnostics, /示例大学/);
});

test("手动反馈的描述很长时，诊断从末尾按整行截掉，[来源] 和前面的段都在，总长不超过 5000", async () => {
  const { createFeedback } = await import("../extension/link/feedback.mjs");
  const data = {};
  const worker = createFeedback({ storage: { get: async () => structuredClone(data), set: async value => Object.assign(data, structuredClone(value)) },
    version: "0.5.0", os: "Windows / Chrome 140", fetchImpl: async () => new Response("{}") });
  const unfilled = Array.from({ length: 10 }, (_, at) => ({ label: `学校${at}`, kind: "学校", reasonCode: "no_option_match", observed: { opened: "listbox", hasOptions: true },
    form: { form: "dropdown", search: true, remote: true, multi: false, version: "antd5", openMs: 123456, waitMs: 654321, spinner: true },
    control: { tag: "input", type: "text", role: "combobox", readOnly: true, picker: "antd", library: "antd", popup: "listbox" } }));
  const block = core.fillReport({ fieldCount: 10, category: "fill_rejected", stage: "fill", unfilledControls: unfilled,
    aiMissed: core.KIND_NAMES.map(kind => ({ kind, inResume: kind !== "unknown" })) });
  const text = worker.preview({ description: "很长的描述".repeat(300), diagnostics: core.diagnostics(block, { manual: true }) }).user_description;
  assert.ok(text.length <= 5000, String(text.length));
  assert.match(text, /^\[来源\]\napp_version: 0\.5\.0\nos: Windows \/ Chrome 140\nbuild: dev$/m);
  assert.match(text, /^\[错误\]\nerror_category: fill_rejected$/m);
  const last = text.split("\n").at(-1);
  assert.ok(block.split("\n").includes(last), `cut inside a line: ${last}`);
});

test("地区类的下拉（就叫「现居住地」、看不出是哪一级）不收选项；出错字段在后面的区块里也有大纲", async (t) => {
  const body = `<form><h3>基本信息</h3>${item("姓名", '<input id="name">')}
    <h3>联系方式</h3>${item("邮箱", '<input id="email">')}
    <h3>户籍信息</h3>${item("现居住地", '<select id="city"><option value="">请选择</option><option>广州</option><option>深圳</option></select>')}
    ${item("党派", '<select id="pol"><option value="">请选择</option><option>党员</option><option>群众</option></select>')}
    ${item("民族信息", '<input id="ethnic">')}
    ${item("城市", '<select id="town"><option value="">请选择</option><option>杭州</option><option>宁波</option></select>')}</form>`;
  const p = page(t, { body, resume: { 姓名: "测试用户", 现住址: "深圳", 政治面貌: "群众", 民族: "汉族" }, ai: (message, ids) => ({ success: true, matches: [],
    diagnostics: { ruleMatches: 0, aiFields: message.formFields.length, aiMatches: 0, promptBytes: 500, apiMs: 800, errorCode: "none",
      unansweredIds: [ids["现居住地"], ids["党派"], ids["民族信息"], ids["城市"]].filter(Boolean) } }) });
  await p.run();
  const hidden = p.reports.find((entry) => entry.private)?.private || "";
  assert.match(hidden, /^label: 现居住地\nsection: 户籍信息\nkind: 现居住地\nin_resume: yes$/m, hidden);
  assert.doesNotMatch(hidden, /广州|深圳|杭州|宁波/, "a region list, whether or not the kind table knows the title");
  assert.ok(hidden.includes("label: 城市"), hidden);
  // Not a region field: its list is kept, in page order, nothing marked.
  assert.match(hidden, /^label: 党派\nsection: 户籍信息\nkind: 政治面貌\nin_resume: yes\noptions: 请选择 \| 党员 \| 群众$/m);
  assert.match(hidden, /^\[页面大纲\]\n\[区块\] 户籍信息\n/m, "the block of a field after the first ones");
  assert.match(hidden, /^> {1}e\d+ select ← 现居住地$/m);
});

test("只同意过旧版说明的人：手动反馈预览按旧内容，不带私有层；旧版本里 ai_missed 读作 unknown；伪造的首行去掉", async () => {
  const { installFeedback, STORAGE_KEY } = await import("../extension/link/feedback.mjs");
  const origin = "chrome-extension://test/";
  // A grant under notice 2, the way an earlier build stored it.
  const data = { [STORAGE_KEY]: { consent: true, consentVersion: 2, anonymousId: "11111111-2222-4333-8444-555555555555", recent: {}, hourly: [], fillHourly: [], backoff: 0, manualAt: 0 } };
  let listener;
  const api = {
    runtime: { id: "test", getURL: p => origin + p, getManifest: () => ({ version: "0.5.0" }), onMessage: { addListener: fn => { listener = fn; } } },
    storage: { local: { get: async () => structuredClone(data), set: async value => Object.assign(data, structuredClone(value)) } },
    tabs: { get: async () => ({ url: "https://jobs.example.test/apply" }) }
  };
  installFeedback(api);
  const page = { id: "test", url: `${origin}sidepanel.html`, documentId: "doc" };
  const block = core.fillReport({ fieldCount: 3, filledCount: 3, category: "ai_missed", stage: "match", aiMissed: [{ kind: "学校", inResume: true }] });
  const preview = await new Promise(resolve => listener({ type: "FEEDBACK_PREVIEW", description: "", diagnostics: block, tabId: 1,
    private: core.privateReport({ unfilled: [{ label: "最高学历", kind: "学历" }] }) }, page, resolve));
  assert.equal(preview.ok, true);
  assert.equal(preview.payload.private_diagnostics, undefined);
  assert.doesNotMatch(preview.payload.user_description, /build:|\[AI未匹配\]|ai_missed/);
  assert.match(preview.payload.user_description, /^\[错误\]\nerror_category: unknown$/m);
  // A header a page put in front, of any version, is replaced by the worker's own.
  const layer = core.privateLayer("--- 私有诊断 v9 ---\nlabel: 最高学历");
  assert.equal(layer, "--- 私有诊断 v1 ---\nlabel: 最高学历");
});

test("先填了学校这类文本框、再点开的下拉：列表可能按填的学校加载，私有部分不收它的选项", async (t) => {
  const select = twoSelects([["major", "所学专业", ["计算机科学", "数学"]]]);
  const body = select.body.replace('<form><h3>教育信息</h3>', `<form><h3>教育信息</h3>${item("毕业学校", '<input id="school">')}`);
  const p = page(t, { body, setup: select.setup, resume: { 学校名称: "示例大学", 专业: "历史学" },
    ai: (message, ids) => ({ success: true, matches: [{ fieldId: ids["毕业学校"], value: "示例大学" }, { fieldId: ids["所学专业"], value: "历史学" }].filter(match => match.fieldId),
      diagnostics: { ruleMatches: 0, aiFields: message.formFields.length, aiMatches: 2, promptBytes: 500, apiMs: 800, errorCode: "none" } }) });
  const result = await p.run();
  assert.equal(p.doc.getElementById("school").value, "示例大学", p.ui.diag.value);
  assert.equal(result.unfilledCount, 1);
  const report = p.reports.find((entry) => entry.kind === "fill_partial");
  assert.match(report?.private || "", /^label: 所学专业\nsection: 教育信息\nkind: 专业\nreason: no_option_match$/m);
  assert.doesNotMatch(report.private, /计算机科学/);
});
