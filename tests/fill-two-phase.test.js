// #402：AI 慢的时候先填本地规则能确定的空字段，AI 请求同时在后台进行；AI 回来后只补剩下的字段。
// 按 manifest 的顺序在 jsdom 里加载全部 content script；AI_FILL 交给 vm 里真实的 ai-worker.js，
// 只有「桌面」是替身：测试自己决定 AI 什么时候回、回什么，或者超时。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
const { refsFor, catalogOf } = require("./helpers/ai-refs.js");

const ROOT = path.join(__dirname, "..");
const SCRIPTS = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).content_scripts[0].js;
const RESUME = [["基本信息", "姓名", "测试用户"], ["基本信息", "邮箱", "tester@example.com"], ["基本信息", "手机号码", "13800138000"],
  ["基本信息", "性别", "男"], ["教育经历", "毕业院校", "示例大学"], ["教育经历", "专业", "示例专业"], ["求职意向", "期望城市", "示例市"]];
// 本该很快结束的填写如果还在等 AI（main 上就是这样），限时失败而不是卡住。
const within = (promise, ms = 5000) => Promise.race([promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error("the fill is still waiting")), ms).unref())]);
const lineOf = (report, key) => (report.match(new RegExp(`^${key}: (.*)$`, "m")) || [])[1];

// jsdom 不排版：可见的元素都给一个框，隐藏的没有。
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

// 真实的 ai-worker.js；桌面替身把每次请求记下来，由测试决定怎么回。
function aiWorker(clock, resume = RESUME) {
  const calls = [];
  const cancels = [];
  let lastResume = [];
  const context = vm.createContext({
    importScripts() {}, ResumeProAIHelpers: require("../ai-helpers.js"), ResumeProProfile: require("../profile-fields.js"),
    ResumeProFormAgent: require("../form-agent.js"), AbortController, TextEncoder, performance: { now: () => clock.now },
    crypto: { randomUUID: () => `call-${calls.length + cancels.length + 1}` }, console
  });
  context.self = {
    postMessage(message) {
      if (message.kind === "desktop-cancel") { cancels.push(message.callId); return; }
      if (message.kind !== "desktop-complete") return;
      const fields = JSON.parse(message.user.split("\n")[1]);
      const call = { fields, labels: fields.map((field) => field.label), prompt: message.user };
      const answer = (reply) => context.self.onmessage({ data: { kind: "desktop-result", callId: message.callId, reply } });
      // 按题目名回答；不传就只回这几项里资料有的。
      // AI 只回资料编号（#429 第 11 项）：按值写的回答照这次发出去的目录换成编号。
      call.reply = (values = null) => answer({ ok: true, text: refsFor(message.user, lastResume, JSON.stringify(fields
        .map((field) => ({ fieldId: field.fieldId, value: (values || Object.fromEntries(resume.map(([, key, value]) => [key, value])))[field.label] }))
        .filter((item) => item.value))) });
      call.fail = (reply) => answer({ ok: false, ...reply });
      calls.push(call);
    }
  };
  vm.runInContext(fs.readFileSync(path.join(ROOT, "ai-worker.js"), "utf8"), context);
  const sender = { tab: { id: 1 }, frameId: 0, documentId: "doc" };
  return {
    calls, cancels,
    dispatch: (message) => new Promise((resolve) => {
      const copy = JSON.parse(JSON.stringify(message));
      if (Array.isArray(copy.resumeFields)) lastResume = copy.resumeFields;
      const keepOpen = context.dispatchAiMessage(copy, sender, (reply) => resolve(JSON.parse(JSON.stringify(reply ?? null))));
      if (!keepOpen && copy.type !== "CANCEL_AI_FILL") resolve(undefined);
    })
  };
}

const item = (id, label, control) => `<div class="form-item" id="${id}-item"><label for="${id}">${label}</label>${control}</div>`;
const input = (id, label, { type = "text", value = "" } = {}) => item(id, label, `<input id="${id}" name="${id}" type="${type}" value="${value}">`);

// body 是表单内容；confirm 返回 true/false；onGender：选了性别后页面要做的事（新出现字段之类）；resume 是简历资料；
// custom 是「我的信息」里的补充字段；site 是桌面里这个网站记住的回答（#429），null 表示桌面不支持；
// 也可以是函数：拿第几次读取，回答案数组，回 null 表示这次桌面没连上；字符串是后台回的状态（forbidden 之类）。
function page(t, body, { confirm = () => true, onGender = null, resume = RESUME, custom = [], site = null, siteKey = "jobs.example.test" } = {}) {
  const dom = new JSDOM(`<!doctype html><html><head><title>网上申请</title></head><body><form id="apply">${body}</form></body></html>`,
    { runScripts: "outside-only", pretendToBeVisual: true, url: "https://jobs.example.test/apply/form" });
  const w = dom.window;
  t.after(() => w.close());
  layout(w);
  Object.defineProperty(w.document, "readyState", { get: () => "loading", configurable: true });
  const listen = w.document.addEventListener.bind(w.document);
  w.document.addEventListener = (type, ...rest) => (type === "DOMContentLoaded" ? undefined : listen(type, ...rest));
  w.__RESUME_PRO_TEST__ = true;
  const confirms = [];
  w.confirm = (text) => { confirms.push(text); return confirm(text); };
  const clock = { now: 0 };
  const worker = aiWorker(clock, resume);
  const groups = [...new Set(resume.map(([group]) => group))].map((name) => ({ name,
    fields: resume.filter(([group]) => group === name).map(([, key, value]) => ({ key, value })) }));
  const template = { id: "t", name: "虚构模板", groups };
  const data = { templates: [{ id: "t", name: "虚构模板", fieldCount: resume.length }], activeTemplate: template,
    profile: { values: {}, family: [], custom }, profileRevision: 0 };
  const sent = [];
  w.chrome = {
    runtime: { id: "test-extension", getURL: (file) => `chrome-extension://test-extension/${file}`, getManifest: () => ({ version: "0.4.4" }),
      onMessage: { addListener(listener) { w.__panel = listener; } },
      sendMessage: async (message) => {
        sent.push(message.type);
        if (message.type === "DESKTOP_RESUME_READ") return { status: "ok", data };
        if (message.type === "DESKTOP_SITE_ANSWERS_READ") {
          if (typeof site === "string") return { status: site };
          const answers = typeof site === "function" ? site(sent.filter((type) => type === message.type).length) : site;
          if (answers) return { status: "ok", site: siteKey, answers };
          return { status: typeof site === "function" ? "unavailable" : "unsupported" };
        }
        if (["ENSURE_AI_HOST", "AI_HOST_READY"].includes(message.type)) return { ready: true };
        if (message.type === "AI_FILL" || message.type === "CANCEL_AI_FILL") return worker.dispatch(message);
        return {};
      } },
    storage: { local: { get: async () => ({}), set: async () => {} }, session: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener() {} } }
  };
  for (const file of SCRIPTS) w.eval(fs.readFileSync(path.join(ROOT, file), "utf8"));
  const gender = w.document.getElementById("gender");
  if (gender && onGender) gender.addEventListener("change", () => onGender(w.document));
  const ui = { status: { textContent: "", className: "" }, diag: { value: "" }, cancel: { hidden: true, disabled: false, onclick: null },
    hint: { hidden: true, textContent: "" }, fill: { disabled: false, textContent: "" } };
  ui.status.classList = { contains: (name) => String(ui.status.className).split(/\s+/).includes(name) };
  const diagnostics = { hidden: true, open: false, querySelector: (selector) => (selector === "#resume-pro-diagnostics-text" ? ui.diag : null) };
  const parts = { "#resume-pro-status": ui.status, "#resume-pro-diagnostics": diagnostics,
    "#resume-pro-diagnostics-text": ui.diag, "#resume-pro-cancel-fill": ui.cancel, "#resume-pro-wait-hint": ui.hint, "#resume-pro-ai-fill": ui.fill };
  const helpers = w.ResumeProHighlightTest;
  helpers.setShadowRoot({ querySelectorAll: () => [], querySelector: (selector) => parts[selector] || null });
  const value = (id) => w.document.getElementById(id).value;
  return {
    w, ui, worker, clock, confirms, sent, value,
    run: () => within(helpers.handleAiFillClick({ currentTarget: ui.fill }), 15000),
    // 等到 check() 成立；最多等 ms 毫秒（main 上先填不会发生，限时失败而不是卡住）。
    async until(check, ms = 3000) {
      const end = Date.now() + ms;
      while (!check()) {
        if (Date.now() > end) return false;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return true;
    },
    async report() {
      return new Promise((resolve) => w.__panel({ type: "RESUME_PANEL_STATUS" }, { id: "test-extension" },
        (reply) => resolve(JSON.parse(JSON.stringify(reply)))));
    }
  };
}

const BASIC = input("name", "姓名") + input("email", "邮箱", { type: "email" }) + input("phone", "手机号码", { type: "tel" })
  + input("school", "毕业院校") + input("major", "专业");

test("the fields local rules can fill are on the page before the AI answers; the AI's are filled after it does", async (t) => {
  const p = page(t, BASIC);
  const running = p.run();
  const early = await p.until(() => p.value("name") && p.value("email") && p.value("phone") && p.worker.calls.length === 1);
  assert.ok(early, `local fields wait for the AI: ${JSON.stringify(["name", "email", "phone"].map(p.value))}`);
  assert.deepEqual(["name", "email", "phone"].map(p.value), ["测试用户", "tester@example.com", "13800138000"]);
  assert.deepEqual(["school", "major"].map(p.value), ["", ""], "the AI's fields wait for the AI");
  // 送 AI 的只有本地规则匹配不上的；先填完以后按钮说已经先填了几项。
  assert.deepEqual(p.worker.calls[0].labels, ["毕业院校", "专业"]);
  await p.until(() => /已先填 3 项，AI 匹配中/.test(p.ui.fill.textContent));
  assert.match(p.ui.fill.textContent, /^已先填 3 项，AI 匹配中\.\.\. \d+s$/);
  assert.equal(p.ui.cancel.hidden, false, "the AI wait can still be cancelled");
  p.worker.calls[0].reply();
  const result = await running;
  assert.deepEqual(["name", "email", "phone", "school", "major"].map(p.value),
    ["测试用户", "tester@example.com", "13800138000", "示例大学", "示例专业"]);
  assert.equal(result.outcome, "success", p.ui.diag.value);
  assert.equal(result.filledCount, 5);
  assert.equal(p.ui.status.textContent, "已填写 5 个字段。");
  assert.equal(p.confirms.length, 0);
  // 首轮的口径不变：本地 3、AI 2，匹配 5、填上 5。
  const report = (await p.report()).diagnosticsReport;
  assert.equal(lineOf(report, "candidates"), "5");
  assert.equal(lineOf(report, "matched"), "5");
  assert.equal(lineOf(report, "filled"), "5");
  assert.equal(lineOf(report, "local_matches"), "3");
  assert.equal(lineOf(report, "ai_matches"), "2");
  assert.equal(lineOf(report, "drop_reasons"), "-");
  assert.match(p.ui.diag.value, /AI 返回前先填：3 项/);
});

for (const [stage, message] of [
  ["first_byte", "日常模型等了 120 秒没有回复，服务商可能太忙或模型太慢，可以稍后重试，或在桌面设置换模型。"],
  ["connect", "日常模型等了 120 秒还没连上服务商（api.example.com），请检查网络或代理。"],
  ["body", "日常模型的服务商已经响应，但等了 120 秒还没收到完整结果，可能是模型太慢或网络慢，可以稍后重试，或在桌面设置换模型。"]
]) {
  test(`an AI timeout (${stage}) leaves the early local fill in place and says where the request stopped`, async (t) => {
    const p = page(t, BASIC);
    const running = p.run();
    assert.ok(await p.until(() => p.value("phone") && p.worker.calls.length === 1), "filled before the timeout");
    p.clock.now = 120_000;
    p.worker.calls[0].fail({ reason: "timeout", host: "api.example.com", timeoutStage: stage });
    const result = await running;
    assert.deepEqual(["name", "email", "phone", "school", "major"].map(p.value),
      ["测试用户", "tester@example.com", "13800138000", "", ""]);
    assert.equal(result.outcome, "partial");
    assert.equal(result.filledCount, 3);
    assert.equal(p.ui.status.textContent, `本地已填写 3 项；${message}`);
    const report = (await p.report()).diagnosticsReport;
    assert.equal(lineOf(report, "error_code"), "timeout");
    assert.equal(lineOf(report, "ai_timeout_stage"), stage);
    assert.equal(lineOf(report, "matched"), "3");
    assert.equal(lineOf(report, "drop_reasons"), "no_result=2");
  });
}

test("cancelling the AI wait keeps what was filled early and writes nothing more", async (t) => {
  const p = page(t, BASIC);
  const running = p.run();
  assert.ok(await p.until(() => p.value("phone") && p.worker.calls.length === 1 && /AI 匹配中/.test(p.ui.fill.textContent)),
    "filled before the cancel");
  await p.ui.cancel.onclick();
  const result = await running;
  assert.equal(p.worker.cancels.length, 1, "the desktop call was cancelled");
  assert.deepEqual(["name", "email", "phone", "school", "major"].map(p.value),
    ["测试用户", "tester@example.com", "13800138000", "", ""]);
  assert.equal(result.outcome, "partial");
  assert.equal(result.filledCount, 3);
  assert.equal(p.ui.status.textContent, "本地已填写 3 项；已按你的操作取消 AI 等待。取消不保证上游停止计算或停止计费。");
  assert.equal(p.ui.cancel.hidden, true);
});

test("cancelling while the early fill is still writing only cancels the AI wait; the local fields are still written", async (t) => {
  // 按钮写的是「取消 AI 等待（保留本地匹配）」：第二个字段正在写时按，本地匹配照常写完，只是不再等 AI。
  const p = page(t, BASIC);
  p.w.document.getElementById("email").addEventListener("input", () => p.ui.cancel.onclick(), { once: true });
  const result = await within(p.run());
  assert.equal(p.worker.cancels.length, 1, "the AI request is cancelled");
  assert.deepEqual(["name", "email", "phone", "school", "major"].map(p.value),
    ["测试用户", "tester@example.com", "13800138000", "", ""]);
  assert.equal(result.outcome, "partial");
  assert.equal(result.filledCount, 3);
  assert.equal(p.ui.status.textContent, "本地已填写 3 项；已按你的操作取消 AI 等待。取消不保证上游停止计算或停止计费。");
  await p.until(() => false, 50);
  assert.equal(p.worker.calls.length, 1);
});

// AI 回来、填完它自己的字段以后：先填的字段被上面 AI 选的题目清空了，按原值再填一次，和原来从上往下填的结果一样。
test("a local field the page clears when the AI's choice above it changes is filled again after that choice", async (t) => {
  // 证件类型现在本地就填（#429），这里用交给 AI 的国籍。
  const resume = [["基本信息", "国籍", "中国"], ["基本信息", "身份证号", "110101199001011234"], ...RESUME];
  const TYPE = item("nation", "国籍", `<select id="nation" name="nation"><option value="">请选择</option><option value="1">中国</option><option value="2">其他</option></select>`);
  const p = page(t, input("name", "姓名") + TYPE + input("idNo", "证件号码"), { resume });
  // 常见的 Vue watch：国籍一变，证件号码清空。
  p.w.document.getElementById("nation").addEventListener("change", () => {
    const number = p.w.document.getElementById("idNo");
    number.value = "";
    number.dispatchEvent(new p.w.Event("input", { bubbles: true }));
  });
  const running = p.run();
  assert.ok(await p.until(() => p.value("idNo") && p.worker.calls.length === 1 && /AI 匹配中/.test(p.ui.fill.textContent)),
    "the number is filled before the AI answers");
  assert.deepEqual(p.worker.calls[0].labels, ["国籍"]);
  p.worker.calls[0].reply();
  const result = await running;
  assert.deepEqual(["name", "nation", "idNo"].map(p.value), ["测试用户", "1", "110101199001011234"]);
  assert.equal(result.outcome, "success", p.ui.diag.value);
  assert.equal(result.filledCount, 3);
  assert.equal(p.ui.status.textContent, "已填写 3 个字段。");
  const report = (await p.report()).diagnosticsReport;
  assert.equal(lineOf(report, "filled"), "3");
  assert.equal(lineOf(report, "drop_reasons"), "-");
  assert.equal(p.sent.filter((type) => type === "FEEDBACK_AUTO").length, 0);
});

// #269 智联那类：先填时选了某项，页面把后面还空着的字段整块换成新节点。AI 回来时它们不是「已有内容」。
test("an early choice that makes the page rebuild the AI's empty fields asks no overwrite question", async (t) => {
  const GENDER = item("gender", "性别", `<select id="gender" name="gender"><option value="">请选择</option><option value="m">男</option><option value="f">女</option></select>`);
  const p = page(t, input("name", "姓名") + GENDER + input("school", "毕业院校") + input("major", "专业"), {
    confirm: () => false,
    onGender: (doc) => {
      for (const [id, label] of [["school", "毕业院校"], ["major", "专业"]]) {
        const holder = doc.createElement("div");
        holder.innerHTML = input(id, label);
        doc.getElementById(`${id}-item`).replaceWith(holder.firstChild);
      }
    }
  });
  const running = p.run();
  assert.ok(await p.until(() => p.value("gender") === "m" && p.worker.calls.length === 1 && /AI 匹配中/.test(p.ui.fill.textContent)),
    "the select is chosen before the AI answers");
  p.worker.calls[0].reply();
  const result = await running;
  assert.deepEqual(p.confirms, []);
  assert.deepEqual(["name", "gender", "school", "major"].map(p.value), ["测试用户", "m", "示例大学", "示例专业"]);
  assert.equal(result.outcome, "success", p.ui.diag.value);
  assert.equal(result.filledCount, 4);
});

// 同上，但用户在等 AI 时往重画出来的新字段里填了：和没重画的字段一样保留不覆盖，不当成「页面已变化、没填上」。
test("a field the early choice rebuilt and the user then typed into while the AI works is kept, not reported as unfilled", async (t) => {
  const GENDER = item("gender", "性别", `<select id="gender" name="gender"><option value="">请选择</option><option value="m">男</option><option value="f">女</option></select>`);
  const p = page(t, input("name", "姓名") + GENDER + input("school", "毕业院校") + input("major", "专业"), {
    onGender: (doc) => {
      for (const [id, label] of [["school", "毕业院校"], ["major", "专业"]]) {
        const holder = doc.createElement("div");
        holder.innerHTML = input(id, label);
        doc.getElementById(`${id}-item`).replaceWith(holder.firstChild);
      }
    }
  });
  const running = p.run();
  assert.ok(await p.until(() => p.value("gender") === "m" && p.worker.calls.length === 1 && /AI 匹配中/.test(p.ui.fill.textContent)),
    "the select is chosen before the AI answers");
  const school = p.w.document.getElementById("school");
  school.value = "自己填的学校";
  school.dispatchEvent(new p.w.Event("input", { bubbles: true }));
  p.worker.calls[0].reply();
  const result = await running;
  assert.deepEqual(p.confirms, []);
  assert.deepEqual(["name", "gender", "school", "major"].map(p.value), ["测试用户", "m", "自己填的学校", "示例专业"]);
  assert.equal(result.outcome, "partial");
  assert.equal(result.filledCount, 3);
  assert.equal(result.unfilledCount, 0);
  assert.equal(p.ui.status.textContent, "已填写 3 个字段。等 AI 时有改动的 1 项没有覆盖：毕业院校，请核对。");
  const report = (await p.report()).diagnosticsReport;
  assert.equal(lineOf(report, "drop_reasons"), "changed_while_waiting=1");
  assert.equal(p.sent.filter((type) => type === "FEEDBACK_AUTO").length, 0, "the user's own input is not reported");
});

// AI 比先填先回来：诊断里的匹配往返是 AI 回来的时间，不含等先填写完的时间。
test("the match time is the AI's round trip even when the early fill takes longer", async (t) => {
  const GENDER = item("gender", "性别", `<select id="gender" name="gender"><option value="">请选择</option><option value="m">男</option><option value="f">女</option></select>`);
  const p = page(t, input("name", "姓名") + GENDER + input("school", "毕业院校"), {
    // 选完以后页面还要变一阵（校验、重画），先填要等页面安静。
    onGender: (doc) => {
      let n = 0;
      const tick = () => { if (n++ < 30) { doc.getElementById("apply").setAttribute("class", `v${n}`); setTimeout(tick, 40); } };
      tick();
    }
  });
  const running = p.run();
  assert.ok(await p.until(() => p.worker.calls.length === 1));
  p.worker.calls[0].reply();
  const result = await running;
  assert.equal(result.filledCount, 3);
  const timings = lineOf((await p.report()).diagnosticsReport, "timings_ms");
  const [match, fill] = ["match", "fill"].map((key) => Number(new RegExp(`${key}=(\\d+)`).exec(timings)?.[1]));
  assert.ok(fill > 1000, timings);
  assert.ok(match < 500, timings);
  assert.match(p.ui.diag.value, /AI 返回前先填：2 项/);
});

test("when the AI request itself fails after the early fill, the early text fields still get their final sync", async (t) => {
  const p = page(t, BASIC);
  // AI 请求通道断开：sendMessage 被拒绝，不是桌面回了失败。
  let fail;
  const send = p.w.chrome.runtime.sendMessage;
  p.w.chrome.runtime.sendMessage = (message) => message.type === "AI_FILL"
    ? new Promise((_, reject) => { fail = reject; }) : send(message);
  const running = p.run();
  assert.ok(await p.until(() => p.value("phone") && fail && /AI 匹配中/.test(p.ui.fill.textContent)), "filled before the failure");
  let synced = 0;
  for (const id of ["name", "email", "phone"]) p.w.document.getElementById(id).addEventListener("blur", () => { synced += 1; });
  fail(new Error("AI 请求通道已断开。"));
  const result = await running;
  assert.equal(synced, 3, "each early text field is focused and blurred once more");
  assert.deepEqual(["name", "email", "phone", "school", "major"].map(p.value),
    ["测试用户", "tester@example.com", "13800138000", "", ""]);
  assert.equal(result.outcome, "partial");
  assert.equal(result.filledCount, 3);
  assert.equal(p.ui.status.textContent, "AI 请求通道已断开。已先填写 3 项，请核对网页。");
});

const OCCUPIED = input("name", "姓名") + input("email", "邮箱", { type: "email", value: "old@example.com" }) + input("phone", "手机号码", { type: "tel" })
  + input("school", "毕业院校") + input("major", "专业", { value: "原来的专业" });

test("a field the user changes while the AI works is kept; fields with content from the start are asked about once, after the AI", async (t) => {
  const p = page(t, OCCUPIED);
  const running = p.run();
  assert.ok(await p.until(() => p.value("name") && p.value("phone") && p.worker.calls.length === 1), "empty local fields go first");
  assert.equal(p.value("email"), "old@example.com", "a local field with content waits for the question");
  assert.equal(p.confirms.length, 0, "nothing asked before the AI answers");
  p.w.document.getElementById("school").value = "自己填的学校";
  p.worker.calls[0].reply();
  const result = await running;
  assert.equal(p.confirms.length, 1);
  assert.match(p.confirms[0], /本次将重新填写 2 个已有内容的字段/);
  assert.match(p.confirms[0], /剩下的字段也不再填写，已经先填的不受影响/);
  assert.deepEqual(["name", "email", "phone", "school", "major"].map(p.value),
    ["测试用户", "tester@example.com", "13800138000", "自己填的学校", "示例专业"]);
  assert.equal(result.filledCount, 4);
  assert.equal(result.outcome, "partial");
  assert.equal(p.ui.status.textContent, "已填写 4 个字段。等 AI 时有改动的 1 项没有覆盖：毕业院校，请核对。");
  // 漏斗对得上：匹配 5、填上 4，差的那项记作等 AI 时有改动；用户自己的改动不自动上报。
  const report = (await p.report()).diagnosticsReport;
  assert.equal(lineOf(report, "matched"), "5");
  assert.equal(lineOf(report, "filled"), "4");
  assert.equal(lineOf(report, "drop_reasons"), "changed_while_waiting=1");
  assert.match(p.ui.diag.value, /丢弃原因：等 AI 时有改动 1/);
  assert.equal(p.sent.filter((type) => type === "FEEDBACK_AUTO").length, 0);
});

test("declining the overwrite after the early fill keeps the early fields and writes nothing else", async (t) => {
  const p = page(t, OCCUPIED, { confirm: () => false });
  const running = p.run();
  assert.ok(await p.until(() => p.value("phone") && p.worker.calls.length === 1), "empty local fields go first");
  p.worker.calls[0].reply();
  const result = await running;
  assert.equal(p.confirms.length, 1);
  assert.deepEqual(["name", "email", "phone", "school", "major"].map(p.value),
    ["测试用户", "old@example.com", "13800138000", "", "原来的专业"]);
  assert.equal(result.outcome, "partial");
  assert.equal(result.filledCount, 2);
  assert.equal(p.ui.status.textContent, "已取消后续填写，已有内容的字段没有改动。此前已填写 2 项，请核对网页。");
  const auto = p.sent.filter((type) => type === "FEEDBACK_AUTO");
  assert.equal(auto.length, 0, "the user's own choice is not reported");
});

test("a choice made in the early fill that reveals a new field: the new field is caught up after the AI's own fields", async (t) => {
  const GENDER = item("gender", "性别", `<select id="gender" name="gender"><option value="">请选择</option><option value="m">男</option><option value="f">女</option></select>`);
  const p = page(t, input("name", "姓名") + GENDER + input("school", "毕业院校"), {
    onGender: (doc) => {
      if (doc.getElementById("city")) return;
      const holder = doc.createElement("div");
      // 题目名和资料里的名称不一样：本地对不上，要交给 AI 补填。
      holder.innerHTML = input("city", "意向工作城市");
      doc.getElementById("apply").append(holder.firstChild);
    }
  });
  const running = p.run();
  assert.ok(await p.until(() => p.value("name") && p.value("gender") === "m" && p.worker.calls.length === 1),
    "the select is chosen before the AI answers");
  assert.equal(p.value("school"), "");
  p.worker.calls[0].reply();
  assert.ok(await p.until(() => p.worker.calls.length === 2), "the new field goes to the AI after the first answer");
  assert.deepEqual(p.worker.calls[0].labels, ["毕业院校"]);
  assert.deepEqual(p.worker.calls[1].labels, ["意向工作城市"]);
  assert.equal(p.value("school"), "示例大学", "the AI's own fields are written before the catch-up");
  p.worker.calls[1].reply({ 意向工作城市: "示例市" });
  const result = await running;
  assert.equal(p.value("city"), "示例市");
  assert.equal(result.outcome, "success", p.ui.diag.value);
  assert.equal(result.filledCount, 4);
  assert.equal(result.fieldCount, 4);
  assert.equal(p.ui.status.textContent, "已填写 4 个字段（其中新出现的字段补填 1 项）。");
});

test("after the user cancels the AI wait, a field revealed by an early choice is not sent to the AI again", async (t) => {
  const GENDER = item("gender", "性别", `<select id="gender" name="gender"><option value="">请选择</option><option value="m">男</option><option value="f">女</option></select>`);
  const p = page(t, input("name", "姓名") + GENDER + input("school", "毕业院校"), {
    onGender: (doc) => {
      if (doc.getElementById("city")) return;
      const holder = doc.createElement("div");
      holder.innerHTML = input("city", "意向工作城市");
      doc.getElementById("apply").append(holder.firstChild);
    }
  });
  const running = p.run();
  assert.ok(await p.until(() => p.value("gender") === "m" && p.w.document.getElementById("city") && /AI 匹配中/.test(p.ui.fill.textContent)),
    "the early fill is done and the new field is there");
  await p.ui.cancel.onclick();
  const result = await running;
  assert.equal(p.worker.calls.length, 1, "no catch-up request after the cancel");
  assert.equal(p.value("city"), "");
  assert.equal(result.outcome, "partial");
  assert.equal(result.filledCount, 2);
  assert.equal(result.fieldCount, 4);
  assert.equal(p.ui.status.textContent,
    "本地已填写 2 项；新出现的 1 项没有补填：意向工作城市，请手动补上。已按你的操作取消 AI 等待。取消不保证上游停止计算或停止计费。");
  const report = (await p.report()).diagnosticsReport;
  assert.equal(lineOf(report, "error_code"), "cancelled");
  assert.match(lineOf(report, "drop_reasons"), /not_sent=1/);
});

test("a page with no local match fills exactly as before: one AI request, then everything", async (t) => {
  const p = page(t, input("school", "毕业院校") + input("major", "专业"));
  const running = p.run();
  assert.ok(await p.until(() => p.worker.calls.length === 1));
  assert.match(p.ui.fill.textContent, /^AI 匹配中\.\.\. \d+s$/);
  p.worker.calls[0].reply();
  const result = await running;
  assert.deepEqual(["school", "major"].map(p.value), ["示例大学", "示例专业"]);
  assert.equal(result.outcome, "success");
  assert.doesNotMatch(p.ui.diag.value, /AI 返回前先填/);
});

// 等 AI 的提示（#402）：30 秒就出现，先填过的说已经填了几项；网页里的旧侧栏是隐藏的，提示经状态交给侧栏显示。
test("after 30 seconds the wait hint says how many fields are already filled, and the side panel gets it", async () => {
  const { loadHighlightHelpers } = require("./helpers/content-harness.js");
  let clock = 0;
  let finish;
  const formElements = [];
  const messages = [];
  const ctx = loadHighlightHelpers({ formElements, aiHelpers: require("../ai-helpers.js"), performance: { now: () => clock },
    sendMessage: (message) => {
      messages.push(message);
      if (message.type === "CANCEL_AI_FILL") {
        finish({ success: true, warning: "已按你的操作取消 AI 等待。", matches: [{ fieldId: "field-0", value: "测试用户" }],
          diagnostics: { errorCode: "cancelled", ruleMatches: 1, aiFields: 1 } });
        return Promise.resolve({ cancelled: true });
      }
      return new Promise((resolve) => { finish = resolve; });
    } });
  for (const label of ["姓名", "学校"]) {
    const field = new ctx.HTMLInputElement();
    field.setAttribute("data-label", label);
    formElements.push(field);
  }
  const cancel = { hidden: true }, hint = { hidden: true, textContent: "" }, button = { disabled: false, textContent: "" };
  ctx.helpers.setShadowRoot({ querySelector: (selector) => ({ "#resume-pro-cancel-fill": cancel, "#resume-pro-wait-hint": hint })[selector] || null,
    querySelectorAll: () => [] });
  ctx.helpers.setCurrentStore({ templates: [{ id: "one", groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "测试用户" }, { key: "学校", value: "大学乙" }] }] }],
    activeTemplateId: "one" });
  const pending = ctx.helpers.handleAiFillClick({ currentTarget: button });
  for (let i = 0; i < 50 && !/已先填/.test(button.textContent); i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(formElements[0].value, "测试用户", "filled before the AI answers");
  assert.equal(button.textContent, "已先填 1 项，AI 匹配中... 0s");
  const timer = ctx.timers.find((item) => item.delay === 1000);
  clock = 29_000;
  timer.callback();
  assert.equal(hint.hidden, true);
  assert.equal((await ctx.sendPanelMessage({ type: "RESUME_PANEL_STATUS" })).waitHint, "");
  clock = 30_000;
  timer.callback();
  assert.equal(button.textContent, "已先填 1 项，AI 匹配中... 30s");
  assert.equal(hint.hidden, false);
  assert.equal(hint.textContent, "已经先填了 1 项，剩下的还在等 AI。可以接着等，也可以点取消，已填的会保留。");
  assert.equal((await ctx.sendPanelMessage({ type: "RESUME_PANEL_STATUS" })).waitHint, hint.textContent);
  await cancel.onclick();
  const result = await within(pending);
  assert.equal(messages.filter((message) => message.type === "CANCEL_AI_FILL").length, 1);
  assert.equal(formElements[1].value, "");
  assert.equal(result.filledCount, 1);
  assert.equal(hint.hidden, true);
  assert.equal((await ctx.sendPanelMessage({ type: "RESUME_PANEL_STATUS" })).waitHint, "", "nothing left over once the fill ends");
});

// 选项列表还没加载好的自定义下拉（字典接口慢、或要等上面的题目选好）：先填时点开没有选项，
// AI 回来时选项已经有了。原来所有字段都等 AI 回来才填，这一项能填上；先填没填上的要在 AI 回来后再试一次。
const SLOW_GENDER = `<div class="form-item" id="gender-item"><label class="title">性别</label>`
  + `<label class="sd-Input-container-3Fx sd-Select-container-9Qa select"><input id="gender" class="sd-Input-input-7Kd" readonly placeholder="请选择"></label></div>`;
function slowOptions(p, choices = ["男", "女"]) {
  const state = { loaded: false, opened: 0 };
  const doc = p.w.document;
  const gender = doc.getElementById("gender");
  gender.addEventListener("click", () => {
    state.opened += 1;
    if (!state.loaded) return;
    const popup = doc.createElement("div");
    popup.className = "sd-Dropdown-dropdown-2Lm";
    for (const text of choices) {
      const option = doc.createElement("div");
      option.className = "sd-Menu-content-item-5Rt";
      option.innerHTML = `<div class="option-label-8Hn">${text}</div>`;
      option.addEventListener("click", () => {
        gender.value = text;
        gender.dispatchEvent(new p.w.Event("input", { bubbles: true }));
        gender.dispatchEvent(new p.w.Event("change", { bubbles: true }));
        popup.remove();
      });
      popup.append(option);
    }
    doc.body.append(popup);
  });
  return state;
}

test("a custom select whose options were not there yet during the early fill is tried once more after the AI answers", async (t) => {
  const p = page(t, input("name", "姓名") + SLOW_GENDER + input("school", "毕业院校"));
  const options = slowOptions(p);
  const running = p.run();
  assert.ok(await p.until(() => p.value("name") && options.opened > 0 && /AI 匹配中/.test(p.ui.fill.textContent), 8000),
    "the early fill has tried the select");
  assert.equal(p.value("gender"), "");
  options.loaded = true;
  p.worker.calls[0].reply();
  const result = await running;
  assert.deepEqual(["name", "gender", "school"].map(p.value), ["测试用户", "男", "示例大学"], p.ui.diag.value);
  assert.equal(result.outcome, "success", p.ui.diag.value);
  assert.equal(result.filledCount, 3);
  assert.equal(result.unfilledCount, 0);
  assert.equal(p.ui.status.textContent, "已填写 3 个字段。");
  const report = (await p.report()).diagnosticsReport;
  assert.equal(lineOf(report, "filled"), "3");
  assert.equal(lineOf(report, "drop_reasons"), "-");
  assert.equal(p.sent.filter((type) => type === "FEEDBACK_AUTO").length, 0);
});

// 选项要等上面的题目选好才加载（上面那题要 AI）：AI 回来后按页面顺序，先选上面的，再试这一项。
test("an early select whose options load after the AI's choice above it is tried again after that choice", async (t) => {
  const NATION = item("nation", "国籍", `<select id="nation" name="nation"><option value="">请选择</option><option value="cn">中国</option><option value="other">其他</option></select>`);
  const resume = [["基本信息", "国籍", "中国"], ...RESUME];
  const p = page(t, input("name", "姓名") + NATION + SLOW_GENDER, { resume });
  const options = slowOptions(p);
  p.w.document.getElementById("nation").addEventListener("change", () => { options.loaded = true; });
  const running = p.run();
  assert.ok(await p.until(() => p.value("name") && options.opened > 0 && /AI 匹配中/.test(p.ui.fill.textContent), 8000));
  assert.deepEqual(p.worker.calls[0].labels, ["国籍"]);
  p.worker.calls[0].reply();
  const result = await running;
  assert.deepEqual(["name", "nation", "gender"].map(p.value), ["测试用户", "cn", "男"], p.ui.diag.value);
  assert.equal(result.outcome, "success", p.ui.diag.value);
  assert.equal(result.filledCount, 3);
});

test("a custom select whose options never come is tried only once more and reported once", async (t) => {
  const p = page(t, input("name", "姓名") + SLOW_GENDER + input("school", "毕业院校"));
  const options = slowOptions(p);
  const running = p.run();
  assert.ok(await p.until(() => p.value("name") && options.opened > 0 && /AI 匹配中/.test(p.ui.fill.textContent), 8000),
    "the early fill has tried the select");
  const early = options.opened;
  p.worker.calls[0].reply();
  const result = await running;
  assert.ok(options.opened > early, "opened again after the AI answered");
  assert.deepEqual(["name", "gender", "school"].map(p.value), ["测试用户", "", "示例大学"]);
  assert.equal(result.outcome, "partial");
  assert.equal(result.filledCount, 2);
  assert.equal(result.unfilledCount, 1);
  assert.equal(p.ui.status.textContent, "已填写 2 个字段。1 项没填上：性别（没有发现选项），请手动补上。");
  const report = (await p.report()).diagnosticsReport;
  assert.equal(lineOf(report, "drop_reasons"), "not_written=1");
  assert.equal((p.ui.diag.value.match(/- 性别：/g) || []).length, 1, p.ui.diag.value);
});

test("an early select whose list is there but has no matching option is not tried again", async (t) => {
  const p = page(t, input("name", "姓名") + SLOW_GENDER + input("school", "毕业院校"),
    { resume: RESUME.map(([group, key, value]) => [group, key, key === "性别" ? "女" : value]) });
  const options = slowOptions(p, ["男", "保密"]);
  options.loaded = true;
  const running = p.run();
  assert.ok(await p.until(() => p.value("name") && options.opened > 0 && /AI 匹配中/.test(p.ui.fill.textContent), 8000));
  p.worker.calls[0].reply();
  const result = await running;
  assert.equal(options.opened, 1, `not opened again: ${p.ui.diag.value}`);
  assert.equal(p.value("gender"), "");
  assert.equal(result.unfilledCount, 1);
  assert.match(p.ui.diag.value, /- 性别：.*没有匹配的选项$/m);
});

// #429 第五项：补充字段里存过的回答（别的网页上答过、用户勾选存下的），题目原样对得上的不等 AI，和本地规则一起先填。
// 期望薪资这类不这样复用，照旧交给 AI。
const radios = (id, label, options) => `<fieldset class="form-item" id="${id}-item"><legend>${label}</legend>${options.map((option) =>
  `<label><input type="radio" name="${id}" value="${option}">${option}</label>`).join("")}</fieldset>`;
const SAVED = [{ key: "是否服从调剂", value: "是" }, { key: "每周可实习天数", value: "5天" }, { key: "期望薪资", value: "面议" }];

test("a saved answer to the same question is filled with the local matches; a salary question still goes to the AI", async (t) => {
  const p = page(t, input("name", "姓名") + radios("adjust", "是否服从调剂", ["是", "否"]) + input("days", "每周可实习天数")
    + input("salary", "期望薪资") + input("school", "毕业院校"), { custom: SAVED });
  const checked = () => p.w.document.querySelector("input[name=adjust]:checked")?.value || "";
  const running = p.run();
  assert.ok(await p.until(() => p.value("name") && checked() && p.value("days") && p.worker.calls.length === 1),
    `saved answers wait for the AI: ${JSON.stringify([p.value("name"), checked(), p.value("days")])}`);
  assert.deepEqual([checked(), p.value("days"), p.value("salary")], ["是", "5天", ""]);
  assert.deepEqual(p.worker.calls[0].labels, ["期望薪资", "毕业院校"]);
  p.worker.calls[0].reply({ 期望薪资: "面议", 毕业院校: "示例大学" });
  const result = await running;
  assert.deepEqual([p.value("salary"), p.value("school")], ["面议", "示例大学"]);
  assert.equal(result.outcome, "success", p.ui.diag.value);
  assert.equal(result.filledCount, 5);
  const report = (await p.report()).diagnosticsReport;
  assert.equal(lineOf(report, "local_matches"), "3");
  assert.equal(lineOf(report, "ai_matches"), "2");
});

test("a field revealed later takes a saved answer to the same question locally, but a salary question goes to the AI", async (t) => {
  const GENDER = item("gender", "性别", `<select id="gender" name="gender"><option value="">请选择</option><option value="m">男</option><option value="f">女</option></select>`);
  const p = page(t, input("name", "姓名") + GENDER + input("school", "毕业院校"), {
    custom: SAVED,
    onGender: (doc) => {
      if (doc.getElementById("days")) return;
      const holder = doc.createElement("div");
      holder.innerHTML = input("days", "每周可实习天数") + input("salary", "期望薪资");
      doc.getElementById("apply").append(...holder.children);
    }
  });
  const running = p.run();
  assert.ok(await p.until(() => p.value("gender") === "m" && p.worker.calls.length === 1));
  p.worker.calls[0].reply();
  assert.ok(await p.until(() => p.worker.calls.length === 2), "the salary question goes to the AI after the first answer");
  assert.deepEqual(p.worker.calls[1].labels, ["期望薪资"]);
  assert.equal(p.value("days"), "5天", "the saved answer is filled without the AI");
  p.worker.calls[1].reply({ 期望薪资: "面议" });
  const result = await running;
  assert.equal(p.value("salary"), "面议");
  assert.equal(result.outcome, "success", p.ui.diag.value);
  assert.equal(result.filledCount, 5);
});

// 后来冒出来的题和页面上原有的同名：和首轮一样算同名题不止一个，不用存过的回答，交给 AI。
test("a field revealed later with the same question as one already on the page goes to the AI, not to the saved answer", async (t) => {
  const GENDER = item("gender", "性别", `<select id="gender" name="gender"><option value="">请选择</option><option value="m">男</option><option value="f">女</option></select>`);
  const p = page(t, input("name", "姓名") + GENDER + input("days", "每周可实习天数") + input("school", "毕业院校"), {
    custom: SAVED,
    onGender: (doc) => {
      if (doc.getElementById("days2")) return;
      const holder = doc.createElement("div");
      holder.innerHTML = input("days2", "每周可实习天数");
      doc.getElementById("apply").append(holder.firstChild);
    }
  });
  const running = p.run();
  assert.ok(await p.until(() => p.value("days") === "5天" && p.worker.calls.length === 1), "the only such question at first takes the saved answer");
  p.worker.calls[0].reply();
  assert.ok(await p.until(() => p.worker.calls.length === 2), "the second one goes to the AI");
  assert.deepEqual(p.worker.calls[1].labels, ["每周可实习天数"]);
  // AI 只能挑资料里的一项（#429 第 11 项），这里挑的正是存过的回答。
  p.worker.calls[1].reply({ 每周可实习天数: "5天" });
  const result = await running;
  assert.deepEqual([p.value("days"), p.value("days2")], ["5天", "5天"]);
  assert.equal(result.outcome, "success", p.ui.diag.value);
});

// 辅助填写只把选中区域的字段发给 worker：区域外还有同名的题时，和整张表一起数，不用存过的回答。
test("an assisted fill counts same questions across the whole page, not just the chosen block", async (t) => {
  const p = page(t, `<div id="first">${input("days1", "每周可实习天数")}</div><div id="second">${input("days2", "每周可实习天数")}${input("school", "毕业院校")}</div>`,
    { custom: SAVED });
  const running = within(p.w.ResumeProHighlightTest.handleAiFillClick({ currentTarget: p.ui.fill },
    { scopes: [p.w.document.getElementById("second")] }), 15000);
  assert.ok(await p.until(() => p.worker.calls.length === 1));
  assert.deepEqual(p.worker.calls[0].labels, ["每周可实习天数", "毕业院校"]);
  p.worker.calls[0].reply({ 每周可实习天数: "5天", 毕业院校: "示例大学" });
  await running;
  assert.deepEqual([p.value("days1"), p.value("days2"), p.value("school")], ["", "5天", "示例大学"]);
});

// #429 第五项第 2 点：问到对方公司的题，用这个网站记住的回答在 AI 回来之前填；补充字段里同名的不用。
const SITE = [{ key: "是否有亲属在本公司工作", value: "否" }];
const COMPANY = radios("relative", "是否有亲属在本公司工作", ["是", "否"]);
// AI 只能挑资料里填得进选项的一项（#429 第 11 项）：换了说法的补充字段，本地不认作同一题，留给 AI。
const RELATIVE_ELSEWHERE = [{ key: "是否有亲属在本行工作", value: "否" }];

test("a company question takes this site's remembered answer with the local matches, not the custom field's", async (t) => {
  const p = page(t, input("name", "姓名") + COMPANY + input("salary", "期望薪资"),
    { custom: [{ key: "是否有亲属在本公司工作", value: "是" }], site: SITE });
  const checked = () => p.w.document.querySelector("input[name=relative]:checked")?.value || "";
  const running = p.run();
  assert.ok(await p.until(() => checked() && p.worker.calls.length === 1), `the site answer waits for the AI: ${checked()}`);
  assert.equal(checked(), "否");
  assert.deepEqual(p.worker.calls[0].labels, ["期望薪资"]);
  assert.equal(p.sent.filter((type) => type === "DESKTOP_SITE_ANSWERS_READ").length, 1);
  p.worker.calls[0].reply({ 期望薪资: "面议" });
  const result = await running;
  assert.equal(result.outcome, "success", p.ui.diag.value);
  assert.equal(lineOf((await p.report()).diagnosticsReport, "local_matches"), "2");
});

test("without a remembered answer, or with a desktop that has none, the company question goes to the AI", async (t) => {
  for (const site of [null, []]) {
    const p = page(t, input("name", "姓名") + COMPANY, { site, custom: RELATIVE_ELSEWHERE });
    const running = p.run();
    assert.ok(await p.until(() => p.worker.calls.length === 1));
    assert.deepEqual(p.worker.calls[0].labels, ["是否有亲属在本公司工作"]);
    p.worker.calls[0].reply({ 是否有亲属在本公司工作: "否" });
    assert.equal((await running).outcome, "success");
  }
});

test("a page with no question about the company never asks the desktop for site answers", async (t) => {
  const p = page(t, BASIC, { site: SITE });
  const running = p.run();
  assert.ok(await p.until(() => p.worker.calls.length === 1));
  p.worker.calls[0].reply();
  await running;
  assert.equal(p.sent.includes("DESKTOP_SITE_ANSWERS_READ"), false);
});

test("a company question revealed later reads the site answers then, and is filled without the AI", async (t) => {
  const GENDER = item("gender", "性别", `<select id="gender" name="gender"><option value="">请选择</option><option value="m">男</option><option value="f">女</option></select>`);
  const p = page(t, input("name", "姓名") + GENDER + input("school", "毕业院校"), {
    site: SITE,
    onGender: (doc) => {
      if (doc.getElementById("relative-item")) return;
      const holder = doc.createElement("div");
      holder.innerHTML = COMPANY;
      doc.getElementById("apply").append(holder.firstChild);
    }
  });
  const running = p.run();
  assert.ok(await p.until(() => p.value("gender") === "m" && p.worker.calls.length === 1));
  assert.equal(p.sent.includes("DESKTOP_SITE_ANSWERS_READ"), false, "nothing about the company on the page yet");
  p.worker.calls[0].reply();
  const result = await running;
  assert.equal(p.w.document.querySelector("input[name=relative]:checked")?.value, "否");
  assert.equal(p.worker.calls.length, 1, "the revealed company question did not go to the AI");
  assert.equal(result.outcome, "success", p.ui.diag.value);
});

// 第一次读网站回答时桌面没连上：后来冒出的公司题再读一次；桌面明确不支持就不再读。
test("a company question revealed later reads the site answers again after a failed read, but not from a desktop that lacks them", async (t) => {
  const GENDER = item("gender", "性别", `<select id="gender" name="gender"><option value="">请选择</option><option value="m">男</option><option value="f">女</option></select>`);
  const reveal = (doc) => {
    if (doc.getElementById("intern")) return;
    const holder = doc.createElement("div");
    holder.innerHTML = input("intern", "是否曾在本行实习");
    doc.getElementById("apply").append(holder.firstChild);
  };
  const retried = page(t, input("name", "姓名") + GENDER + COMPANY, {
    site: (read) => (read === 1 ? null : [{ key: "是否曾在本行实习", value: "否" }]), onGender: reveal, custom: RELATIVE_ELSEWHERE
  });
  let running = retried.run();
  assert.ok(await retried.until(() => retried.value("gender") === "m" && retried.worker.calls.length === 1));
  retried.worker.calls[0].reply({ 是否有亲属在本公司工作: "否" });
  await running;
  assert.equal(retried.value("intern"), "否", "filled from the second read");
  assert.equal(retried.sent.filter((type) => type === "DESKTOP_SITE_ANSWERS_READ").length, 2);
  assert.equal(retried.worker.calls.length, 1, "the revealed question did not go to the AI");

  // 桌面不支持，或者后台不认这个发送方：再读结果也一样，只读一次。
  for (const site of [null, "forbidden"]) {
    const old = page(t, input("name", "姓名") + GENDER + COMPANY, { site, onGender: reveal, custom: RELATIVE_ELSEWHERE });
    running = old.run();
    assert.ok(await old.until(() => old.value("gender") === "m" && old.worker.calls.length === 1));
    old.worker.calls[0].reply({ 是否有亲属在本公司工作: "否" });
    assert.ok(await old.until(() => old.worker.calls.length === 2), "the revealed question goes to the AI");
    old.worker.calls[1].reply({ 是否曾在本行实习: "否" });
    await running;
    assert.equal(old.sent.filter((type) => type === "DESKTOP_SITE_ANSWERS_READ").length, 1, `asked once (${site})`);
  }
});

// 公司题本地填不了（页面上同名的有两道）时交给 AI：资料里可以有这个网站自己记住的回答，别的网站的不会有。
test("a company question left to the AI may see this site's remembered answer, never another site's", async (t) => {
  const twice = input("r1", "是否有亲属在本公司工作") + input("r2", "是否有亲属在本公司工作");
  const answer = [{ key: "是否有亲属在本公司工作", value: "父亲在本公司财务部任职" }];
  for (const [siteKey, expected] of [["jobs.example.test", true], ["other.example.test", false]]) {
    const p = page(t, input("name", "姓名") + twice, { site: answer, siteKey });
    const running = p.run();
    assert.ok(await p.until(() => p.worker.calls.length === 1));
    assert.deepEqual(p.worker.calls[0].labels, ["是否有亲属在本公司工作", "是否有亲属在本公司工作"]);
    // 发给 AI 的资料目录只有字段名（#429 第 11 项）：看有没有这个网站那一组。
    assert.equal(catalogOf(p.worker.calls[0].prompt).some((entry) => entry.group === "本网站回答"), expected, siteKey);
    assert.equal(p.worker.calls[0].prompt.includes("财务部"), false, "the remembered answer itself is never sent");
    p.worker.calls[0].reply({});
    await running;
  }
});

// 后来冒出公司题时才读到的网站回答，和一开始就有的资料一样：诊断里带着它的字段名要藏起来。
test("a remembered answer read for a question revealed later is hidden in field names of the diagnostics too", async (t) => {
  const GENDER = item("gender", "性别", `<select id="gender" name="gender"><option value="">请选择</option><option value="m">男</option><option value="f">女</option></select>`);
  const p = page(t, input("name", "姓名") + GENDER + input("school", "毕业院校"), {
    site: [{ key: "是否有亲属在本公司工作", value: "父亲在本公司财务部任职" }],
    onGender: (doc) => {
      if (doc.getElementById("relative")) return;
      const holder = doc.createElement("div");
      holder.innerHTML = input("relative", "是否有亲属在本公司工作") + input("echo", "父亲在本公司财务部任职情况说明");
      doc.getElementById("apply").append(...holder.children);
      const echo = doc.getElementById("echo");
      for (const type of ["input", "change", "blur"]) echo.addEventListener(type, () => { echo.value = ""; });
    }
  });
  const running = p.run();
  assert.ok(await p.until(() => p.value("gender") === "m" && p.worker.calls.length === 1));
  p.worker.calls[0].reply();
  assert.ok(await p.until(() => p.worker.calls.length === 2), "the echoing field goes to the AI");
  // AI 只能挑资料里的一项（#429 第 11 项）；挑哪一项都一样，页面会把它清掉。
  p.worker.calls[1].reply({ 父亲在本公司财务部任职情况说明: "测试用户" });
  const result = await running;
  assert.equal(p.value("relative"), "父亲在本公司财务部任职");
  assert.equal(result.unfilledCount, 1, "the echoing field is reported as not filled");
  assert.match(p.ui.diag.value, /- （字段名已隐藏）：input\[text\]/);
  assert.equal(p.ui.diag.value.includes("财务部"), false);
});

// #429 证件类型按资料和号码本地填；资料写的和号码对不上的不填，报「和证件号码对不上」，也不交给 AI。
const ID_PAGE = (selected = "") => input("name", "姓名") + item("idType", "证件类型", `<select id="idType" name="idType"><option value="">请选择</option>`
  + [["1", "居民身份证"], ["2", "港澳台居民居住证"], ["3", "护照"]].map(([value, text]) => `<option value="${value}"${value === selected ? " selected" : ""}>${text}</option>`).join("")
  + `</select>`) + input("idNo", "证件号码") + input("school", "毕业院校");

test("the ID number picks the ID type before the AI answers when the profile states none", async (t) => {
  const p = page(t, ID_PAGE(), { resume: [["基本信息", "证件号码", "810000199408230021"], ...RESUME] });
  const running = p.run();
  assert.ok(await p.until(() => p.value("idNo") && p.worker.calls.length === 1), "filled before the AI answers");
  assert.deepEqual(["idType", "idNo"].map(p.value), ["2", "810000199408230021"]);
  assert.deepEqual(p.worker.calls[0].labels, ["毕业院校"]);
  p.worker.calls[0].reply();
  const result = await running;
  assert.equal(result.outcome, "success", p.ui.diag.value);
  assert.equal(result.filledCount, 4);
});

test("an ID type the number contradicts is left empty and reported, not sent to the AI", async (t) => {
  const resume = [["基本信息", "证件类型", "居民身份证"], ["基本信息", "证件号码", "810000199408230021"], ...RESUME];
  const p = page(t, ID_PAGE(), { resume });
  const running = p.run();
  assert.ok(await p.until(() => p.value("idNo") && p.worker.calls.length === 1), "the number is filled before the AI answers");
  assert.deepEqual(p.worker.calls[0].labels, ["毕业院校"]);
  p.worker.calls[0].reply();
  const result = await running;
  assert.deepEqual(["name", "idType", "idNo", "school"].map(p.value), ["测试用户", "", "810000199408230021", "示例大学"]);
  assert.equal(result.filledCount, 3);
  assert.equal(result.unfilledCount, 1);
  assert.equal(p.ui.status.textContent, "已填写 3 个字段。1 项没填上：证件类型（和证件号码对不上），请手动补上。");
  const report = (await p.report()).diagnosticsReport;
  assert.match(report, /^- .*: select reason=id_type_mismatch$/m);
});

test("a contradicted ID type that already has a value asks no overwrite question and stays as it is", async (t) => {
  const resume = [["基本信息", "证件类型", "护照"], ["基本信息", "证件号码", "11010519491231002X"], ...RESUME];
  const p = page(t, ID_PAGE("1"), { resume, confirm: () => false });
  const running = p.run();
  assert.ok(await p.until(() => p.worker.calls.length === 1), "the AI is asked");
  assert.deepEqual(p.worker.calls[0].labels, ["毕业院校"]);
  p.worker.calls[0].reply();
  const result = await running;
  assert.equal(p.confirms.length, 0);
  assert.deepEqual(["idType", "idNo", "school"].map(p.value), ["1", "11010519491231002X", "示例大学"]);
  assert.equal(result.unfilledCount, 1);
});
