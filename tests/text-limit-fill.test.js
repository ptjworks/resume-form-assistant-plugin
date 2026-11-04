// #429 第十项在一键填写里：超过字数上限的不写，没填上的原因写明超过几字上限；字数按字节算的站点（51job 旧版）按字节量；
// 上限告诉 AI；上传简历后会覆盖已填内容的平台，侧栏状态里带一句提示。
// 按 manifest 的顺序在 jsdom 里加载全部 content script，AI_FILL 交给 vm 里真实的 ai-worker.js，只有「桌面」是替身
// （同 fill-two-phase.test.js）。只有虚构的值。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
const { refsFor } = require("./helpers/ai-refs.js");

const ROOT = path.join(__dirname, "..");
const SCRIPTS = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).content_scripts[0].js;
const within = (promise, ms = 15000) => Promise.race([promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error("the fill is still waiting")), ms).unref())]);

function layout(w) {
  const rectOf = (el) => {
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const css = w.getComputedStyle(node);
      if (node.hidden || css.display === "none" || css.visibility === "hidden") return null;
    }
    return { top: 10, left: 10, width: 300, height: 30, right: 310, bottom: 40, x: 10, y: 10, toJSON() { return this; } };
  };
  const empty = { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() { return this; } };
  w.Element.prototype.getBoundingClientRect = function () { return rectOf(this) || empty; };
  w.Element.prototype.getClientRects = function () { const rect = rectOf(this); return rect ? [rect] : []; };
  w.Element.prototype.scrollIntoView = function () {};
  for (const side of ["Width", "Height"]) {
    Object.defineProperty(w.HTMLElement.prototype, `offset${side}`, { configurable: true,
      get() { return rectOf(this)?.[side.toLowerCase()] || 0; } });
  }
}

// AI 只回资料编号（#429 第 11 项）：answers 也放进资料（page），回答时按发出去的目录换成编号。
function aiWorker(answers, resume) {
  const calls = [];
  const context = vm.createContext({
    importScripts() {}, ResumeProAIHelpers: require("../ai-helpers.js"), ResumeProProfile: require("../profile-fields.js"),
    ResumeProFormAgent: require("../form-agent.js"), AbortController, TextEncoder, performance: { now: () => 0 },
    crypto: { randomUUID: () => `call-${calls.length + 1}` }, console
  });
  context.self = {
    postMessage(message) {
      if (message.kind !== "desktop-complete") return;
      const fields = JSON.parse(message.user.split("\n")[1]);
      calls.push({ fields, system: message.system });
      context.self.onmessage({ data: { kind: "desktop-result", callId: message.callId,
        reply: { ok: true, text: refsFor(message.user, resume,
          JSON.stringify(fields.map((field) => ({ fieldId: field.fieldId, value: answers[field.label] })).filter((item) => item.value))) } } });
    }
  };
  vm.runInContext(fs.readFileSync(path.join(ROOT, "ai-worker.js"), "utf8"), context);
  const sender = { tab: { id: 1 }, frameId: 0, documentId: "doc" };
  return {
    calls,
    dispatch: (message) => new Promise((resolve) => {
      const copy = JSON.parse(JSON.stringify(message));
      const keepOpen = context.dispatchAiMessage(copy, sender, (reply) => resolve(JSON.parse(JSON.stringify(reply ?? null))));
      if (!keepOpen && copy.type !== "CANCEL_AI_FILL") resolve(undefined);
    })
  };
}

const row = (id, label, control) => `<div class="form-item"><label for="${id}">${label}</label>${control}</div>`;
const RESUME = [["基本信息", "姓名", "测试用户"]];

function page(t, body, { url = "https://jobs.example.test/apply/form", answers = {} } = {}) {
  const dom = new JSDOM(`<!doctype html><html><head><title>网上申请</title></head><body><form id="apply">${body}</form></body></html>`,
    { runScripts: "outside-only", pretendToBeVisual: true, url });
  const w = dom.window;
  t.after(() => w.close());
  layout(w);
  Object.defineProperty(w.document, "readyState", { get: () => "loading", configurable: true });
  const listen = w.document.addEventListener.bind(w.document);
  w.document.addEventListener = (type, ...rest) => (type === "DOMContentLoaded" ? undefined : listen(type, ...rest));
  w.__RESUME_PRO_TEST__ = true;
  w.confirm = () => true;
  const fields = [...RESUME.map(([, key, value]) => ({ key, value })), ...Object.entries(answers).map(([key, value]) => ({ key, value }))];
  const worker = aiWorker(answers, fields.map((field) => ({ group: "基本信息", ...field })));
  const data = { templates: [{ id: "t", name: "虚构模板", fieldCount: fields.length }],
    activeTemplate: { id: "t", name: "虚构模板", groups: [{ name: "基本信息", fields }] },
    profile: { values: {}, family: [], custom: [] }, profileRevision: 0 };
  w.chrome = {
    runtime: { id: "test-extension", getURL: (file) => `chrome-extension://test-extension/${file}`, getManifest: () => ({ version: "0.4.4" }),
      onMessage: { addListener(listener) { w.__panel = listener; } },
      sendMessage: async (message) => {
        if (message.type === "DESKTOP_RESUME_READ") return { status: "ok", data };
        if (["ENSURE_AI_HOST", "AI_HOST_READY"].includes(message.type)) return { ready: true };
        if (message.type === "AI_FILL" || message.type === "CANCEL_AI_FILL") return worker.dispatch(message);
        return {};
      } },
    storage: { local: { get: async () => ({}), set: async () => {} }, session: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener() {} } }
  };
  for (const file of SCRIPTS) w.eval(fs.readFileSync(path.join(ROOT, file), "utf8"));
  const ui = { status: { textContent: "", className: "" }, diag: { value: "" }, cancel: { hidden: true, disabled: false, onclick: null },
    hint: { hidden: true, textContent: "" }, fill: { disabled: false, textContent: "" } };
  ui.status.classList = { contains: (name) => String(ui.status.className).split(/\s+/).includes(name) };
  const diagnostics = { hidden: true, open: false, querySelector: (selector) => (selector === "#resume-pro-diagnostics-text" ? ui.diag : null) };
  const parts = { "#resume-pro-status": ui.status, "#resume-pro-diagnostics": diagnostics,
    "#resume-pro-diagnostics-text": ui.diag, "#resume-pro-cancel-fill": ui.cancel, "#resume-pro-wait-hint": ui.hint, "#resume-pro-ai-fill": ui.fill };
  const highlight = w.ResumeProHighlightTest;
  highlight.setShadowRoot({ querySelectorAll: () => [], querySelector: (selector) => parts[selector] || null });
  return {
    w, ui, worker, value: (id) => w.document.getElementById(id).value,
    run: () => within(highlight.handleAiFillClick({ currentTarget: ui.fill })),
    status: () => new Promise((resolve) => w.__panel({ type: "RESUME_PANEL_STATUS" }, { id: "test-extension" },
      (reply) => resolve(JSON.parse(JSON.stringify(reply)))))
  };
}

const LONG_SCHOOL = "示例大学附属第一学院";
const LONG_ESSAY = "热爱学习，积极主动，具有良好的团队合作精神和沟通能力，能够承受较大的工作压力。";

test("a value over a box's limit is left out and reported with the limit; values that fit are filled", async (t) => {
  const p = page(t, row("school", "毕业院校", `<input id="school" maxlength="6">`)
    + row("major", "专业", `<input id="major" maxlength="10">`)
    // antd 4 带 showCount 的多行文本：没有 maxlength，上限只在外层的 data-count。
    + row("essay", "自我评价", `<div class="ant-input-textarea ant-input-textarea-show-count" data-count="0 / 20"><textarea id="essay"></textarea></div>`)
    + row("award", "获奖情况", `<textarea id="award"></textarea>`),
  { answers: { "毕业院校": LONG_SCHOOL, "专业": "示例专业", "自我评价": LONG_ESSAY, "获奖情况": "校级一等奖学金" } });
  const result = await p.run();
  assert.deepEqual(["school", "major", "essay", "award"].map(p.value), ["", "示例专业", "", "校级一等奖学金"]);
  assert.equal(result.filledCount, 2);
  assert.equal(result.unfilledCount, 2);
  assert.match(p.ui.status.textContent, /毕业院校（超过 6 字上限）/);
  assert.match(p.ui.status.textContent, /自我评价（超过 20 字上限）/);
  const report = (await p.status()).diagnosticsReport;
  assert.equal((report.match(/reason=too_long$/gm) || []).length, 2);
  // AI 拿到了上限。
  const sent = Object.fromEntries(p.worker.calls[0].fields.map((field) => [field.label, field.maxLength]));
  assert.deepEqual(sent, { "毕业院校": 6, "专业": 10, "自我评价": 20, "获奖情况": undefined });
  assert.match(p.worker.calls[0].system, /17\. 带 maxLength 的字段照常对应/);
});

test("on a site that counts bytes a Chinese character counts 2; the same value fits elsewhere", async (t) => {
  const body = row("school", "毕业院校", `<input id="school" maxlength="10">`) + row("major", "专业", `<input id="major" maxlength="10">`);
  const answers = { "毕业院校": "示例大学附属", "专业": "示例专业" };
  const bytes = page(t, body, { url: "https://xyz.51job.com/External/Apply.aspx", answers });
  await bytes.run();
  assert.deepEqual(["school", "major"].map(bytes.value), ["", "示例专业"]);
  assert.match(bytes.ui.status.textContent, /毕业院校（超过 10 字节上限，汉字算 2）/);
  assert.deepEqual(bytes.worker.calls[0].fields.map((field) => field.lengthUnit), ["byte", "byte"]);

  const chars = page(t, body, { answers });
  await chars.run();
  assert.deepEqual(["school", "major"].map(chars.value), ["示例大学附属", "示例专业"]);
  assert.deepEqual(chars.worker.calls[0].fields.map((field) => field.lengthUnit), [undefined, undefined]);
});

test("a box with maxlength 0 is filled as before: 0 is not taken as a limit", async (t) => {
  const p = page(t, row("en", "英文名", `<input id="en" maxlength="0">`) + row("major", "专业", `<input id="major">`),
    { answers: { "英文名": "Alex Li", "专业": "示例专业" } });
  await p.run();
  assert.deepEqual(["en", "major"].map(p.value), ["Alex Li", "示例专业"]);
  assert.doesNotMatch(p.ui.status.textContent, /上限/);
  assert.deepEqual(p.worker.calls[0].fields.map((field) => field.maxLength), [undefined, undefined]);
});

test("the side panel status carries an upload hint on platforms whose resume upload overwrites the form", async (t) => {
  const form = row("name", "姓名", `<input id="name">`);
  // 页面上没有空着的简历框：一键填写不会先传简历，不用问桌面，直接是这句（有简历框时见 upload-flow.test.js）。
  assert.equal((await page(t, form, { url: "https://app.mokahr.com/campus_apply/example/1" }).status()).siteHint,
    "Moka 上传简历后会重新解析并覆盖已填内容，请先上传简历再填写。");
  // 跑在公司自己域名上的飞书：按页面特征认。
  const feishu = `<div class="ud-formily-item" data-form-field-id="f1">${form}</div>`;
  assert.equal((await page(t, feishu, { url: "https://careers.example.test/apply" }).status()).siteHint,
    "飞书招聘上传简历后会重新解析并覆盖已填内容，请先上传简历再填写。");
  assert.equal((await page(t, form).status()).siteHint, "");
  assert.equal((await page(t, form, { url: "https://xyz.51job.com/External/Apply.aspx" }).status()).siteHint, "");
});

test("filling reads no page features, and the upload hint is looked up again only after 2 seconds", async (t) => {
  const form = row("school", "毕业院校", `<input id="school" maxlength="6">`) + row("major", "专业", `<input id="major" maxlength="10">`);
  const p = page(t, `<div class="ud-formily-item" data-form-field-id="f1">${form}</div>`,
    { url: "https://careers.example.test/apply", answers: { "毕业院校": "示例大学", "专业": "示例专业" } });
  const knowledge = p.w.ResumeProSiteKnowledge;
  const detect = knowledge.detect;
  let reads = 0;
  knowledge.detect = (...args) => { reads += 1; return detect(...args); };
  await p.run();
  assert.deepEqual(["school", "major"].map(p.value), ["示例大学", "示例专业"]);
  assert.equal(reads, 0, "byte counting goes by the address; filling does not read page features per box");
  // 侧栏轮询：2 秒内用上次认的；页面换掉（飞书的特征没了）后过了 2 秒再认，提示收起。
  let now = Date.now();
  p.w.Date.now = () => now;
  const hint = "飞书招聘上传简历后会重新解析并覆盖已填内容，请先上传简历再填写。";
  assert.equal((await p.status()).siteHint, hint);
  assert.equal((await p.status()).siteHint, hint);
  assert.equal(reads, 1);
  p.w.document.querySelector(".ud-formily-item").classList.remove("ud-formily-item");
  now += 1000;
  assert.equal((await p.status()).siteHint, hint);
  now += 1500;
  assert.equal((await p.status()).siteHint, "");
  assert.equal(reads, 2);
});
