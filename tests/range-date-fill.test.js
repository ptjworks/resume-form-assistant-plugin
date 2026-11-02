// #429 区间日期在一键填写里：开始、结束两个字段，填其中一个时把另一头排着的值一起交给控件层，一次点开填完两头；
// 轮到另一头只核对。另一头要等 AI 的，这一头也不在 AI 回来前先填。
// 按 manifest 的顺序在 jsdom 里加载全部 content script，AI_FILL 交给 vm 里真实的 ai-worker.js，只有「桌面」是替身
// （和 fill-two-phase.test.js 一样）。页面上的区间是 Element 式的替身：两个框各打各的字，回车提交并收起，只打一头弹层一收就丢。
// 只有虚构的值。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const SCRIPTS = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).content_scripts[0].js;
const within = (promise, ms = 15000) => Promise.race([promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error("the fill is still waiting")), ms).unref())]);
const lineOf = (report, key) => (report.match(new RegExp(`^${key}: (.*)$`, "m")) || [])[1];

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

function aiWorker(resume) {
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
      const call = { labels: fields.map((field) => field.label) };
      call.reply = (values) => context.self.onmessage({ data: { kind: "desktop-result", callId: message.callId,
        reply: { ok: true, text: JSON.stringify(fields.map((field) => ({ fieldId: field.fieldId, value: values[field.label] })).filter((item) => item.value)) } } });
      calls.push(call);
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

const RESUME = [["基本信息", "姓名", "测试用户"], ["教育经历", "在校时间", "2019.09-2023.06"]];
const RANGE = `<div class="form-item"><label class="form-label">在校时间</label>
  <div class="el-date-editor el-range-editor el-date-editor--daterange">
    <input class="el-range-input" placeholder="开始日期"><span>至</span><input class="el-range-input" placeholder="结束日期"></div></div>`;
const NAME = `<div class="form-item"><label for="name">姓名</label><input id="name" name="name"></div>`;

function page(t, { custom = [] } = {}) {
  const dom = new JSDOM(`<!doctype html><html><head><title>网上申请</title></head><body><form id="apply">${NAME}${RANGE}</form></body></html>`,
    { runScripts: "outside-only", pretendToBeVisual: true, url: "https://jobs.example.test/apply/form" });
  const w = dom.window;
  t.after(() => w.close());
  layout(w);
  Object.defineProperty(w.document, "readyState", { get: () => "loading", configurable: true });
  const listen = w.document.addEventListener.bind(w.document);
  w.document.addEventListener = (type, ...rest) => (type === "DOMContentLoaded" ? undefined : listen(type, ...rest));
  w.__RESUME_PRO_TEST__ = true;
  w.confirm = () => true;
  const worker = aiWorker(RESUME);
  const groups = [...new Set(RESUME.map(([group]) => group))].map((name) => ({ name,
    fields: RESUME.filter(([group]) => group === name).map(([, key, value]) => ({ key, value })) }));
  const data = { templates: [{ id: "t", name: "虚构模板", fieldCount: RESUME.length }], activeTemplate: { id: "t", name: "虚构模板", groups },
    profile: { values: {}, family: [], custom }, profileRevision: 0 };
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

  // Element 式的区间：一聚焦、一点就打开日历；框里的字 change 时收下，两头都收下了才提交；回车收起（要等 Vue 处理完改动）。
  const doc = w.document;
  const boxes = Array.from(doc.querySelectorAll(".el-range-input"));
  const log = { opened: 0, writes: 0 };
  let model = null, pending = [null, null], panel = null, dirty = false;
  const show = () => boxes.forEach((box, index) => { box.value = model ? model[index] : ""; });
  const close = () => { panel?.remove(); panel = null; pending = [null, null]; show(); };
  const open = () => {
    if (panel) return;
    log.opened += 1;
    panel = doc.createElement("div");
    panel.className = "el-picker-panel el-date-range-picker el-popper";
    panel.innerHTML = `<div class="el-picker-panel__body"><table class="el-date-table"><tbody><tr><td class="available"><div><span>1</span></div></td></tr></tbody></table></div>`;
    doc.body.append(panel);
  };
  doc.querySelector(".el-range-editor").addEventListener("click", open);
  boxes.forEach((box, index) => {
    box.addEventListener("focus", open);
    box.addEventListener("input", () => { log.writes += 1; });
    box.addEventListener("change", () => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(box.value)) return;
      pending[index] = box.value;
      const pair = [pending[0] || model?.[0], pending[1] || model?.[1]];
      dirty = true;
      Promise.resolve().then(() => { dirty = false; });
      if (pair[0] && pair[1] && pair[0] <= pair[1]) { model = pair; pending = [null, null]; }
    });
    box.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close();
      if (event.key === "Enter" && !dirty && model && !pending[0] && !pending[1]) close();
    });
  });
  doc.addEventListener("mousedown", (event) => {
    if (panel && !panel.contains(event.target) && !doc.querySelector(".el-range-editor").contains(event.target)) close();
  });

  const ui = { status: { textContent: "", className: "" }, diag: { value: "" }, cancel: { hidden: true, disabled: false, onclick: null },
    hint: { hidden: true, textContent: "" }, fill: { disabled: false, textContent: "" } };
  ui.status.classList = { contains: (name) => String(ui.status.className).split(/\s+/).includes(name) };
  const diagnostics = { hidden: true, open: false, querySelector: (selector) => (selector === "#resume-pro-diagnostics-text" ? ui.diag : null) };
  const parts = { "#resume-pro-status": ui.status, "#resume-pro-diagnostics": diagnostics,
    "#resume-pro-diagnostics-text": ui.diag, "#resume-pro-cancel-fill": ui.cancel, "#resume-pro-wait-hint": ui.hint, "#resume-pro-ai-fill": ui.fill };
  const highlight = w.ResumeProHighlightTest;
  highlight.setShadowRoot({ querySelectorAll: () => [], querySelector: (selector) => parts[selector] || null });
  return {
    w, ui, worker, log, boxes, model: () => model, open: () => Boolean(panel),
    run: () => within(highlight.handleAiFillClick({ currentTarget: ui.fill })),
    async until(check, ms = 3000) {
      const end = Date.now() + ms;
      while (!check()) {
        if (Date.now() > end) return false;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return true;
    },
    report: () => new Promise((resolve) => w.__panel({ type: "RESUME_PANEL_STATUS" }, { id: "test-extension" },
      (reply) => resolve(JSON.parse(JSON.stringify(reply)).diagnosticsReport)))
  };
}

test("both ends of a range the AI answers are filled in one opening, and the end only gets checked", async (t) => {
  const p = page(t);
  const running = p.run();
  assert.ok(await p.until(() => p.worker.calls.length === 1));
  assert.deepEqual(p.worker.calls[0].labels, ["在校时间（开始）", "在校时间（结束）"]);
  p.worker.calls[0].reply({ "在校时间（开始）": "2019.09", "在校时间（结束）": "2023.06" });
  const result = await running;
  assert.equal(result.outcome, "success", p.ui.diag.value);
  assert.equal(result.filledCount, 3);
  assert.deepEqual(p.model(), ["2019-09-01", "2023-06-01"]);
  assert.equal(p.log.opened, 1, "the end field does not open the calendar again");
  assert.equal(p.log.writes, 2);
  assert.equal(p.open(), false);
  assert.equal(lineOf(await p.report(), "filled"), "3");
});

test("a range end the local rules know waits for the AI's other end, then both are filled together", async (t) => {
  // 「我的信息」里存过开始（题目原样对得上，本地就能填），结束要等 AI。
  const p = page(t, { custom: [{ key: "在校时间（开始）", value: "2019-09-01" }] });
  const running = p.run();
  assert.ok(await p.until(() => p.worker.calls.length === 1 && /AI 匹配中/.test(p.ui.fill.textContent)));
  assert.deepEqual(p.worker.calls[0].labels, ["在校时间（结束）"]);
  assert.equal(p.w.document.getElementById("name").value, "测试用户", "the name is filled early");
  assert.equal(p.log.opened, 0, "the start does not go alone before the AI answers");
  p.worker.calls[0].reply({ "在校时间（结束）": "2023-06-30" });
  const result = await running;
  assert.equal(result.outcome, "success", p.ui.diag.value);
  assert.equal(result.filledCount, 3);
  assert.equal(result.unfilledCount, 0);
  assert.deepEqual(p.model(), ["2019-09-01", "2023-06-30"]);
  assert.equal(p.log.opened, 1);
});

test("a range the AI answers only one end of is left alone and reported as missing an end", async (t) => {
  const p = page(t);
  const running = p.run();
  assert.ok(await p.until(() => p.worker.calls.length === 1));
  p.worker.calls[0].reply({ "在校时间（开始）": "2019.09" });
  const result = await running;
  assert.equal(result.filledCount, 1);
  assert.equal(result.unfilledCount, 1);
  assert.equal(p.model(), null);
  assert.equal(p.log.opened, 0, "nothing was opened");
  assert.match(p.ui.status.textContent, /在校时间（开始）（起止日期缺一头）/);
  // 上报里不带字段名，只有控件结构和原因码。
  assert.match(await p.report(), /^- （字段名已隐藏）: input\[text\] picker=element lib=element reason=range_incomplete$/m);
});
