// #429 第 4 项在一键填写里：侧栏确认后才上传；先传简历、等网站解析完、把解析改掉的值改回去、照常填写、最后传证件照。
// 按 manifest 的顺序在 jsdom 里加载全部 content script，AI_FILL 交给真实的 ai-worker.js，后台按真实的 link/upload-grants.mjs
// 认侧栏的确认；网站是替身（选了文件就列出来，几秒后「解析」改表单），等待用假时钟。只有虚构的值。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { JSDOM } = require("jsdom");
const SLOTS = require("../upload-slots.js");

const ROOT = path.join(__dirname, "..");
const SCRIPTS = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).content_scripts[0].js;
const within = (promise, ms = 20000) => Promise.race([promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error("still waiting")), ms).unref())]);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// 文件内容和文件名里各放一个记号：它们只能出现在网页的上传框和侧栏的结果里。
const CONTENT = "%PDF-1.7\nCONTENT-MARKER-7f3a\n%%EOF";
const PHOTO = "\xff\xd8\xff\xe0PHOTO-MARKER-c51e";
const sha = (text) => crypto.createHash("sha256").update(Buffer.from(text, "latin1")).digest("hex");
const RESUME_FILE = { fileId: "66666666-6666-4666-8666-666666666601", kind: "resume", name: "NAME-MARKER_简历.pdf", label: "", mime: "application/pdf",
  byteSize: Buffer.byteLength(CONTENT, "latin1"), sha256: sha(CONTENT), isDefault: true, templateIds: [], updatedAt: "2026-11-03T08:00:00Z" };
const PHOTO_FILE = { fileId: "66666666-6666-4666-8666-666666666602", kind: "photo", name: "证件照.jpg", label: "蓝底一寸", mime: "image/jpeg",
  byteSize: Buffer.byteLength(PHOTO, "latin1"), sha256: sha(PHOTO), isDefault: true, templateIds: [], updatedAt: "2026-11-03T08:00:00Z" };
const BYTES = { [RESUME_FILE.fileId]: CONTENT, [PHOTO_FILE.fileId]: PHOTO };
const MARKERS = ["CONTENT-MARKER", "PHOTO-MARKER", "NAME-MARKER", Buffer.from(CONTENT, "latin1").toString("base64").slice(0, 24)];

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
    Object.defineProperty(w.HTMLElement.prototype, `offset${side}`, { configurable: true, get() { return rectOf(this)?.[side.toLowerCase()] || 0; } });
  }
}

// jsdom 没有 DataTransfer，file 框的 files 也只收它自己的 FileList：换成和浏览器一样能用的替身。
function fileInputs(w) {
  w.DataTransfer = class {
    constructor() { this.list = []; this.items = { add: (file) => this.list.push(file) }; }
    get files() { return Object.assign([...this.list], { item: (index) => this.list[index] }); }
  };
  const picked = new WeakMap();
  Object.defineProperty(w.HTMLInputElement.prototype, "files", { configurable: true,
    get() { return this.type === "file" ? picked.get(this) || [] : null; }, set(value) { picked.set(this, value); } });
}

function aiWorker(answers, sent) {
  const context = vm.createContext({
    importScripts() {}, ResumeProAIHelpers: require("../ai-helpers.js"), ResumeProProfile: require("../profile-fields.js"),
    ResumeProFormAgent: require("../form-agent.js"), AbortController, TextEncoder, performance: { now: () => 0 },
    crypto: { randomUUID: () => crypto.randomUUID() }, console
  });
  context.self = {
    postMessage(message) {
      if (message.kind !== "desktop-complete") return;
      sent.push(JSON.stringify(message));
      const fields = JSON.parse(message.user.split("\n")[1]);
      context.self.onmessage({ data: { kind: "desktop-result", callId: message.callId,
        reply: { ok: true, text: JSON.stringify(fields.map((field) => ({ fieldId: field.fieldId, value: answers[field.label] })).filter((item) => item.value)) } } });
    }
  };
  vm.runInContext(fs.readFileSync(path.join(ROOT, "ai-worker.js"), "utf8"), context);
  const sender = { tab: { id: 1 }, frameId: 0, documentId: "doc" };
  return (message) => new Promise((resolve) => {
    const copy = JSON.parse(JSON.stringify(message));
    const keepOpen = context.dispatchAiMessage(copy, sender, (reply) => resolve(JSON.parse(JSON.stringify(reply ?? null))));
    if (!keepOpen && copy.type !== "CANCEL_AI_FILL") resolve(undefined);
  });
}

function clock() {
  let time = 0;
  const tasks = [];
  return {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
      for (const task of tasks.filter((item) => item.at <= time)) { tasks.splice(tasks.indexOf(task), 1); task.run(); }
      await settle();
    },
    after: (delay, run) => tasks.push({ at: time + delay, run }),
    // jsdom 里脚本发的事件都不是浏览器发的：测试里用户的输入打上 byUser 记号。
    trusted: (event) => event.byUser === true
  };
}

// 用户自己在框里输入（浏览器发的 input 事件）。
function typeAsUser(p, id, value) {
  const el = p.w.document.getElementById(id);
  el.value = value;
  const event = new p.w.Event("input", { bubbles: true });
  event.byUser = true;
  el.dispatchEvent(event);
}

const row = (id, label, control) => `<div class="form-item"><label for="${id}">${label}</label>${control}</div>`;
const antdUpload = (id, title, accept = ".pdf,.doc,.docx") => `
  <div class="ant-form-item"><div class="ant-form-item-label"><label title="${title}">${title}</label></div>
    <div class="ant-form-item-control"><span class="ant-upload-wrapper">
      <div class="ant-upload ant-upload-select"><span class="ant-upload" role="button"><input id="${id}" type="file" accept="${accept}" style="display:none"><button type="button">上传文件</button></span></div>
      <div class="ant-upload-list ant-upload-list-text"></div></span></div></div>`;
const elementPhoto = (id, title) => `
  <div class="el-form-item"><label class="el-form-item__label">${title}</label><div class="el-form-item__content">
    <div class="el-upload el-upload--picture-card"><i class="el-icon-plus"></i><input id="${id}" type="file" accept="image/*" class="el-upload__input" style="display:none"></div>
    <ul class="el-upload-list el-upload-list--picture-card"></ul></div></div>`;

async function page(t, body, { url = "https://app.mokahr.com/campus_apply/example/1", answers = {}, files = [RESUME_FILE, PHOTO_FILE], listStatus = "ok", hold = null, silent = [], gate = null, replies = {}, skip = [], tabEvents = true } = {}) {
  const { createUploadGrants, handleUploadMessage, revokeOnNavigation } = await import("../link/upload-grants.mjs");
  const dom = new JSDOM(`<!doctype html><html><head><title>网上申请</title></head><body><form id="apply">${body}</form></body></html>`,
    { runScripts: "outside-only", pretendToBeVisual: true, url });
  const w = dom.window;
  t.after(() => w.close());
  layout(w);
  fileInputs(w);
  Object.defineProperty(w.document, "readyState", { get: () => "loading", configurable: true });
  const listen = w.document.addEventListener.bind(w.document);
  w.document.addEventListener = (type, ...rest) => (type === "DOMContentLoaded" ? undefined : listen(type, ...rest));
  w.__RESUME_PRO_TEST__ = true;
  const seen = { messages: [], replies: [], stored: [], logs: [], ai: [], confirms: 0, events: [] };
  w.confirm = () => { seen.confirms += 1; return true; };
  for (const level of ["log", "info", "warn", "error", "debug"]) w.console[level] = (...args) => seen.logs.push(args.map(String).join(" "));
  const ai = aiWorker(answers, seen.ai);
  const data = { templates: [{ id: "t", name: "虚构模板", fieldCount: 1 }],
    activeTemplate: { id: "t", name: "虚构模板", groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "测试用户" }] }] },
    profile: { values: {}, family: [], custom: [] }, profileRevision: 0 };
  // 后台：侧栏的确认（grant）和取文件都走真实的 upload-grants.mjs；文件按块读的部分由 #457 的测试管，这里直接给整份。
  const grants = createUploadGrants();
  const desktop = {
    list: async () => listStatus === "ok" ? { status: "ok", files } : { status: listStatus },
    fetch: async (file) => (hold && await hold(), { status: "ok", name: file.name, mime: file.mime, byteSize: file.byteSize, sha256: file.sha256,
      bytesBase64: Buffer.from(BYTES[file.fileId], "latin1").toString("base64") })
  };
  // 照 Chrome 来：tabs.get 给标签页现在的地址；消息的 sender.url 是页面载入时的地址，pushState、改 hash 以后也不变；
  // 标签页换了地址，后台收到 tabs.onUpdated。tabEvents 为 false 时后台没收到（通知晚到），看页面自己交回确认。
  const loaded = w.location.href;
  const tabListeners = [];
  const api = { runtime: { id: "test-extension", getURL: (file) => `chrome-extension://test-extension/${file}` },
    tabs: { get: async () => ({ url: w.location.href }), onUpdated: { addListener: (fn) => tabListeners.push(fn) } } };
  revokeOnNavigation(api, grants);
  if (tabEvents) {
    let shown = loaded;
    const moved = () => {
      if (w.location.href === shown) return;
      shown = w.location.href;
      for (const fn of tabListeners) fn(9, { url: shown });
    };
    for (const name of ["pushState", "replaceState"]) {
      const original = w.history[name].bind(w.history);
      w.history[name] = (...args) => { original(...args); moved(); };
    }
    w.addEventListener("hashchange", moved);
    w.addEventListener("popstate", moved);
  }
  const background = (message) => new Promise((resolve) => {
    const answer = (reply) => { seen.replies.push(JSON.stringify(reply)); resolve(reply); };
    const kept = handleUploadMessage({ api, grants, files: desktop, slots: SLOTS }, message, { id: "test-extension", tab: { id: 9 }, frameId: 0, url: loaded }, answer);
    if (kept === null) answer({});
  });
  w.chrome = {
    runtime: { id: "test-extension", getURL: (file) => `chrome-extension://test-extension/${file}`, getManifest: () => ({ version: "0.5.0" }),
      onMessage: { addListener(listener) { w.__panel = listener; } },
      sendMessage: async (message) => {
        seen.messages.push(JSON.stringify(message));
        if (message.type === "DESKTOP_RESUME_READ") return { status: "ok", data };
        if (["ENSURE_AI_HOST", "AI_HOST_READY"].includes(message.type)) return { ready: true };
        if (message.type === "AI_FILL" || message.type === "CANCEL_AI_FILL") return ai(message);
        // silent 里的消息后台一直不回（桌面卡住）。
        if (silent.includes(message.type)) return new Promise(() => {});
        // replies 里的消息后台照这里给的回。
        if (replies[message.type]) return replies[message.type];
        if (String(message.type).startsWith("DESKTOP_RESUME_FILE")) {
          // gate：后台算好了回答，先压着，等测试放行再交给页面（看晚到的回答怎么处理）。
          const reply = await background(message);
          if (gate) await gate(message);
          return reply;
        }
        return {};
      } },
    storage: { local: { get: async () => ({}), set: async (value) => { seen.stored.push(JSON.stringify(value)); } },
      session: { get: async () => ({}), set: async (value) => { seen.stored.push(JSON.stringify(value)); } }, onChanged: { addListener() {} } }
  };
  // skip 里的内容脚本不加载（看它没加载上时会怎样）。
  for (const file of SCRIPTS.filter((name) => !skip.includes(name))) w.eval(fs.readFileSync(path.join(ROOT, file), "utf8"));
  const ui = { status: { textContent: "", className: "" }, diag: { value: "" }, cancel: { hidden: true, disabled: false, onclick: null },
    hint: { hidden: true, textContent: "" }, fill: { disabled: false, textContent: "一键 AI 填写" } };
  ui.status.classList = { contains: (name) => String(ui.status.className).split(/\s+/).includes(name) };
  const diagnostics = { hidden: true, open: false, querySelector: (selector) => (selector === "#resume-pro-diagnostics-text" ? ui.diag : null) };
  const parts = { "#resume-pro-status": ui.status, "#resume-pro-diagnostics": diagnostics, "#resume-pro-diagnostics-text": ui.diag,
    "#resume-pro-cancel-fill": ui.cancel, "#resume-pro-wait-hint": ui.hint, "#resume-pro-ai-fill": ui.fill };
  const hooks = w.ResumeProHighlightTest;
  hooks.setShadowRoot({ querySelectorAll: () => [], querySelector: (selector) => parts[selector] || null });
  const fills = [];
  ui.fill.click = () => { fills.push(hooks.handleAiFillClick({ currentTarget: ui.fill })); };
  const time = clock();
  hooks.setUploadClock(time);
  const send = (message) => new Promise((resolve) => {
    const kept = w.__panel(message, { id: "test-extension" }, (reply) => resolve(JSON.parse(JSON.stringify(reply ?? null))));
    if (kept === false) settle().then(() => resolve(undefined));
  });
  const status = () => send({ type: "RESUME_PANEL_STATUS" });
  return {
    w, ui, seen, time, fills, grants, value: (id) => w.document.getElementById(id).value, status, send,
    // 侧栏点「上传并填写」：先告诉后台这个标签页、这个网站、这几个文件，再让页面开始。
    confirm: async (choices) => {
      const offer = (await status()).upload;
      const chosen = choices || offer.slots.filter((slot) => slot.fileId).map((slot) => ({ slot: slot.id, fileId: slot.fileId }));
      const rows = chosen.map((choice) => files.find((file) => file.fileId === choice.fileId)).filter(Boolean);
      if (rows.length) grants.grant(9, w.location.href, `${offer.epoch}:${offer.version}`, rows.map((file) => ({ fileId: file.fileId, sha256: file.sha256 })));
      return send({ type: "RESUME_PANEL_UPLOAD", action: "confirm", version: offer.version, epoch: offer.epoch, choices: chosen });
    },
    finished: async () => {
      for (let i = 0; i < 2000; i += 1) {
        const now = await status();
        if (now.upload?.phase !== "running" && !now.busy) return now;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("the upload is still running");
    }
  };
}

// 替身网站：选了文件就在列表里列出来；简历传上 3 秒后「解析」：姓名填上解析的值、兴趣爱好被清空。
function fakeSite(p, { parse = true, dialog = false, silentPhoto = false, failResume = false } = {}) {
  const doc = p.w.document;
  doc.getElementById("resume").addEventListener("change", (event) => {
    const file = event.target.files[0];
    p.seen.events.push("resume");
    if (failResume) {
      // 网站拒收：文件项标成出错，弹一条报错提示。
      doc.querySelector(".ant-upload-list").innerHTML = `<div class="ant-upload-list-item ant-upload-list-item-error"><span title="${file.name}">${file.name}</span></div>`;
      doc.body.insertAdjacentHTML("beforeend", `<div class="ant-message"><div class="ant-message-notice"><span>文件格式不对，上传失败</span></div></div>`);
      return;
    }
    doc.querySelector(".ant-upload-list").innerHTML = `<div class="ant-upload-list-item ant-upload-list-item-done"><span title="${file.name}">${file.name}</span></div>`;
    if (dialog) {
      p.time.after(2000, () => doc.body.insertAdjacentHTML("beforeend", `<div class="ant-modal" role="dialog"><div class="ant-modal-body">检测到已填写的信息，是否用简历内容覆盖？</div><button type="button" id="overwrite">覆盖</button><button type="button">取消</button></div>`));
      return;
    }
    if (!parse) return;
    p.time.after(3000, () => {
      p.seen.events.push("parse");
      const name = doc.getElementById("name");
      name.value = "解析出的名字";
      name.dispatchEvent(new p.w.Event("input", { bubbles: true }));
      doc.getElementById("hobby").value = "";
    });
  });
  doc.getElementById("photo")?.addEventListener("change", () => {
    p.seen.events.push("photo");
    // 网站收了文件却什么都不显示：一秒后用户按停止。
    if (silentPhoto) { p.time.after(1000, () => { p.send({ type: "RESUME_PANEL_CANCEL" }); }); return; }
    doc.querySelector(".el-upload-list").innerHTML = `<li class="el-upload-list__item is-success"><img class="el-upload-list__item-thumbnail" src="blob:https://app.mokahr.com/1"></li>`;
  });
  doc.getElementById("school").addEventListener("input", () => p.seen.events.push("fill"));
}

function spinAfterResume(p) {
  p.w.document.getElementById("resume").addEventListener("change", () => {
    p.w.document.body.insertAdjacentHTML("beforeend", `<div class="ant-spin ant-spin-spinning" id="spin"></div>`);
  });
}

const FORM = row("name", "姓名", `<input id="name">`) + row("hobby", "兴趣爱好", `<input id="hobby" value="看书">`)
  + row("school", "毕业院校", `<input id="school">`) + antdUpload("resume", "简历附件") + elementPhoto("photo", "证件照")
  + antdUpload("works", "作品集", "");

test("after the side panel's yes: resume first, then the parse, the user's value back, the fill, and the photo last", async (t) => {
  const p = await page(t, FORM, { answers: { "毕业院校": "示例大学" } });
  fakeSite(p);
  // 侧栏的进度就是这个按钮上的字：记下每一次的。
  const steps = [];
  let shown = p.ui.fill.textContent;
  Object.defineProperty(p.ui.fill, "textContent", { configurable: true, get: () => shown, set: (value) => { shown = value; steps.push(value); } });
  const started = await p.send({ type: "RESUME_PANEL_FILL" });
  assert.deepEqual(started, { ok: true, upload: true });
  // 侧栏卡片：网站、每个框给的文件、会改回哪些。确认之前什么都没传，也没填。
  const offer = (await p.status()).upload;
  assert.equal(offer.phase, "offer");
  assert.equal(offer.host, "app.mokahr.com");
  assert.equal(offer.platform, "Moka");
  assert.deepEqual(offer.slots.map((slot) => [slot.title, slot.kind, slot.fileId, slot.reason]), [
    ["简历附件", "resume", RESUME_FILE.fileId, ""], ["证件照", "photo", PHOTO_FILE.fileId, ""], ["作品集", "other", "", "other_kind"]]);
  assert.deepEqual(offer.restore, { count: 1, labels: ["兴趣爱好"], pending: false });
  assert.deepEqual(p.seen.events, []);
  assert.equal(p.fills.length, 0);
  assert.equal(p.seen.messages.some((message) => message.includes("DESKTOP_RESUME_FILE_FETCH")), false);

  assert.deepEqual(await p.confirm(), { ok: true });
  const done = await p.finished();
  await Promise.all(p.fills);
  assert.deepEqual(p.seen.events, ["resume", "parse", "fill", "photo"]);
  // 等解析时说大约要多久，过了最短时间说最多等多久；网站 3 秒就改完了表单，也等够 Moka 的 12 秒才填。
  assert.ok(steps.includes("正在等网站解析简历，大约 12 秒（已等 3 秒）…"), steps.join(" | "));
  assert.ok(steps.includes("正在等网站解析简历，已等 12 秒，最多 60 秒…"), steps.join(" | "));
  assert.deepEqual([...new Set(steps.filter((text) => !text.startsWith("正在等网站解析简历")))].slice(0, 3),
    ["正在从桌面取文件…", "正在上传简历…", "正在扫描网页..."]);
  assert.equal(p.w.document.getElementById("resume").files[0].name, RESUME_FILE.name);
  assert.equal(p.w.document.getElementById("photo").files[0].name, PHOTO_FILE.name);
  assert.equal(p.w.document.getElementById("works").files.length, 0);
  // 兴趣爱好是用户填的，解析清空了：改回去。姓名原来空着、解析填上的：按资料填，不问要不要覆盖。
  assert.deepEqual(["name", "hobby", "school"].map(p.value), ["测试用户", "看书", "示例大学"]);
  assert.equal(p.seen.confirms, 0);
  assert.equal(done.upload.phase, "done");
  assert.deepEqual(done.upload.lines, [
    `简历附件：已上传 ${RESUME_FILE.name}。`,
    "证件照：已上传 证件照.jpg。",
    "作品集：插件只传简历附件、证件照和成绩单，这一项请自己上传。",
    "改回了网站解析改掉的 1 项：兴趣爱好。"
  ]);
  // 等解析至少等了 Moka 的 12 秒。
  assert.match(p.ui.diag.value, /上传：框 resume 1、photo 1、other 1；结果 done 2、skipped 1；没传的原因 other_kind 1；解析等待 done，12\.\d s；改回 1，没改回 0，停下后又变过 0，等解析时用户改过 0，停下没处理 0，网站填的 0/);
});

test("file contents and names stay out of messages, storage, logs, diagnostics, reports and AI requests", async (t) => {
  const p = await page(t, FORM, { answers: { "毕业院校": "示例大学" } });
  fakeSite(p);
  await p.send({ type: "RESUME_PANEL_FILL" });
  await p.confirm();
  const done = await p.finished();
  await Promise.all(p.fills);
  const outgoing = p.seen.messages;
  assert.ok(outgoing.some((message) => message.includes("AI_FILL")), "the fill asked the AI");
  for (const marker of MARKERS) {
    for (const message of outgoing) assert.equal(message.includes(marker), false, `a message carries ${marker}: ${message.slice(0, 120)}`);
    for (const item of [...p.seen.stored, ...p.seen.logs, ...p.seen.ai]) assert.equal(item.includes(marker), false, marker);
    assert.equal(p.ui.diag.value.includes(marker), false, `diagnostics carry ${marker}`);
    assert.equal(String(done.diagnosticsReport || "").includes(marker), false);
  }
  // 侧栏的结果说了传的是哪个文件：只给用户看。
  assert.ok(done.upload.lines.some((line) => line.includes(RESUME_FILE.name)));
});

test("a parse that runs past the limit stops before filling; the next fill puts the user's values back first", async (t) => {
  const p = await page(t, FORM, { answers: { "毕业院校": "示例大学" } });
  fakeSite(p);
  // 网站一直在转圈：等到 60 秒上限。
  // 传上简历以后网站一直在转圈（传之前就有的转圈不算忙，见 busy 的 baseline）。
  spinAfterResume(p);
  await p.send({ type: "RESUME_PANEL_FILL" });
  await p.confirm();
  let done = await p.finished();
  assert.equal(p.fills.length, 0, "nothing filled");
  assert.deepEqual(done.upload.lines.slice(0, 2), ["网站还在解析简历，等页面不动了再点一键填写。", `简历附件：已上传 ${RESUME_FILE.name}。`]);
  assert.equal(p.w.document.getElementById("photo").files.length, 0, "the photo waits too");
  assert.deepEqual(["name", "hobby"].map(p.value), ["解析出的名字", ""], "the parse landed after we stopped waiting");
  // 页面不转了，用户再点一键填写：简历框里已经有文件不再传，卡片说先改回兴趣爱好。
  p.w.document.getElementById("spin").remove();
  assert.deepEqual(await p.send({ type: "RESUME_PANEL_FILL" }), { ok: true, upload: true });
  const offer = (await p.status()).upload;
  assert.deepEqual(offer.slots.map((slot) => [slot.title, slot.reason]), [["简历附件", "has_file"], ["证件照", ""], ["作品集", "other_kind"]]);
  assert.deepEqual(offer.restore, { count: 1, labels: ["兴趣爱好"], pending: true, laterCount: 0, later: [] });
  await p.confirm();
  done = await p.finished();
  await Promise.all(p.fills);
  assert.deepEqual(["name", "hobby", "school"].map(p.value), ["测试用户", "看书", "示例大学"]);
  assert.deepEqual(p.seen.events, ["resume", "parse", "fill", "photo"]);
  assert.ok(done.upload.lines.includes("改回了网站解析改掉的 1 项：兴趣爱好。"));
});

test("a dialog from the site stops everything and is never clicked", async (t) => {
  const p = await page(t, FORM, { answers: { "毕业院校": "示例大学" } });
  fakeSite(p, { dialog: true });
  let clicked = false;
  p.w.document.addEventListener("click", (event) => { if (event.target.id === "overwrite") clicked = true; }, true);
  await p.send({ type: "RESUME_PANEL_FILL" });
  await p.confirm();
  const done = await p.finished();
  assert.equal(clicked, false);
  assert.equal(p.fills.length, 0);
  assert.equal(done.upload.lines[0], "网站在问「检测到已填写的信息，是否用简历内容覆盖？」，请自己选，选完再点一键填写。");
  // 简历本身已经交给网站了，单独说；对话框不算进简历框的结果里。
  assert.equal(done.upload.lines[1], `简历附件：已上传 ${RESUME_FILE.name}。`);
  assert.equal(p.w.document.getElementById("photo").files.length, 0);
});

test("only fill: nothing is fetched or uploaded and the page fills as before", async (t) => {
  const p = await page(t, FORM, { answers: { "毕业院校": "示例大学" } });
  fakeSite(p);
  await p.send({ type: "RESUME_PANEL_FILL" });
  const offer = (await p.status()).upload;
  assert.deepEqual(await p.send({ type: "RESUME_PANEL_UPLOAD", action: "fill", version: offer.version, epoch: offer.epoch }), { ok: true });
  await Promise.all(p.fills);
  assert.equal(p.fills.length, 1);
  assert.equal(p.value("school"), "示例大学");
  assert.deepEqual(p.seen.events.filter((event) => event !== "fill"), []);
  assert.equal(p.seen.messages.some((message) => message.includes("DESKTOP_RESUME_FILE_FETCH")), false);
  assert.equal((await p.status()).upload, null);
});

test("a card is not used once the page has moved on, or when a file is not one the side panel confirmed", async (t) => {
  const p = await page(t, FORM, { answers: { "毕业院校": "示例大学" } });
  fakeSite(p);
  await p.send({ type: "RESUME_PANEL_FILL" });
  const offer = (await p.status()).upload;
  p.w.history.pushState({}, "", "/campus_apply/example/2");
  assert.deepEqual(await p.send({ type: "RESUME_PANEL_UPLOAD", action: "confirm", version: offer.version, epoch: offer.epoch,
    choices: [{ slot: "upload-0", fileId: RESUME_FILE.fileId }] }), { ok: false, error: "网页已经变了，请重新点一键填写。" });
  assert.equal((await p.status()).upload, null);
  assert.equal(p.w.document.getElementById("resume").files.length, 0);
  // 新的一页、新的卡片；侧栏没向后台确认就让页面开始：后台不给文件，什么都不传。
  await p.send({ type: "RESUME_PANEL_FILL" });
  const next = (await p.status()).upload;
  assert.deepEqual(await p.send({ type: "RESUME_PANEL_UPLOAD", action: "confirm", version: next.version, epoch: next.epoch,
    choices: [{ slot: "upload-0", fileId: RESUME_FILE.fileId }] }), { ok: true });
  const done = await p.finished();
  await Promise.all(p.fills);
  assert.equal(p.w.document.getElementById("resume").files.length, 0);
  assert.ok(done.upload.lines.includes("简历附件：没有在侧栏确认，没有上传。"));
  // 选了卡片上没有的框：不认。
  await p.send({ type: "RESUME_PANEL_FILL" });
  const third = (await p.status()).upload;
  const refused = await p.send({ type: "RESUME_PANEL_UPLOAD", action: "confirm", version: third.version, epoch: third.epoch,
    choices: [{ slot: "upload-9", fileId: RESUME_FILE.fileId }] });
  assert.deepEqual(refused, { ok: false, error: "选的文件放不进对应的上传框，请重新选。" });
  // 给证件照框选了简历：页面在确认前不知道文件是什么，取到以后按文件本身核对，放不进就不传。
  p.grants.grant(9, p.w.location.href, `${third.epoch}:${third.version}`, [{ fileId: RESUME_FILE.fileId, sha256: RESUME_FILE.sha256 }]);
  assert.deepEqual(await p.send({ type: "RESUME_PANEL_UPLOAD", action: "confirm", version: third.version, epoch: third.epoch,
    choices: [{ slot: "upload-1", fileId: RESUME_FILE.fileId }] }), { ok: true });
  const last = await p.finished();
  await Promise.all(p.fills);
  assert.equal(p.w.document.getElementById("photo").files.length, 0);
  assert.equal(p.w.document.getElementById("resume").files.length, 0);
  assert.ok(last.upload.lines.includes("证件照：选的文件放不进这个框，没有上传。"), last.upload.lines.join(" | "));
  // 证件照框选错了文件不算简历没传上：这是会覆盖的平台，填写照常进行。
  assert.equal(last.upload.lines.some((line) => line.includes("简历上传失败")), false, last.upload.lines.join(" | "));
  assert.equal(p.value("school"), "示例大学");
});

test("with an old desktop there is no card: the fill runs and the result says why nothing was uploaded", async (t) => {
  const p = await page(t, FORM, { answers: { "毕业院校": "示例大学" }, listStatus: "unsupported" });
  fakeSite(p);
  assert.deepEqual(await p.send({ type: "RESUME_PANEL_FILL" }), { ok: true });
  await Promise.all(p.fills);
  assert.equal(p.value("school"), "示例大学");
  const now = await p.status();
  assert.equal(now.upload.phase, "done");
  assert.deepEqual(now.upload.lines, [
    "简历附件：桌面程序版本较旧，不能上传文件；更新桌面程序，或者自己上传。",
    "证件照：桌面程序版本较旧，不能上传文件；更新桌面程序，或者自己上传。",
    "作品集：桌面程序版本较旧，不能上传文件；更新桌面程序，或者自己上传。"
  ]);
  // 会覆盖的平台：点一键填写时已经问过桌面，回答是不能传，提示马上是原来那句，不用再等。
  assert.equal(now.siteHint, "Moka 上传简历后会重新解析并覆盖已填内容，请先上传简历再填写。");
});

test("a page without a file of the kind it asks for gets no card and a line pointing to the desktop", async (t) => {
  const p = await page(t, row("name", "姓名", `<input id="name">`) + elementPhoto("photo", "证件照"),
    { url: "https://jobs.example.test/apply", files: [RESUME_FILE] });
  assert.deepEqual(await p.send({ type: "RESUME_PANEL_FILL" }), { ok: true });
  await Promise.all(p.fills);
  const now = await p.status();
  assert.deepEqual(now.upload.lines, ["这页要证件照，桌面里还没有。到桌面「简历资料 › 附件」添加，或者自己上传。"]);
  assert.equal(now.upload.addFiles, true);
});

test("stopping while the files come from the desktop uploads and fills nothing", async (t) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let asked = false;
  const p = await page(t, FORM, { answers: { "毕业院校": "示例大学" }, hold: () => { asked = true; return held; } });
  fakeSite(p);
  await p.send({ type: "RESUME_PANEL_FILL" });
  await p.confirm();
  for (let i = 0; i < 200 && !asked; i += 1) await settle();
  const running = await p.status();
  assert.equal(running.busy, true);
  assert.equal(running.cancelLabel, "停止上传");
  assert.deepEqual(await p.send({ type: "RESUME_PANEL_CANCEL" }), { ok: true });
  release();
  const done = await p.finished();
  assert.equal(p.fills.length, 0);
  assert.equal(p.w.document.getElementById("resume").files.length, 0);
  assert.equal(p.w.document.getElementById("photo").files.length, 0);
  assert.equal(done.upload.lines[0], "已停止，没有上传，也没有填写。");
});

test("stopping while waiting on the photo says it was handed over but not confirmed", async (t) => {
  const p = await page(t, FORM, { answers: { "毕业院校": "示例大学" } });
  fakeSite(p, { silentPhoto: true });
  await p.send({ type: "RESUME_PANEL_FILL" });
  await p.confirm();
  const done = await p.finished();
  await Promise.all(p.fills);
  assert.equal(p.w.document.getElementById("photo").files[0].name, PHOTO_FILE.name);
  assert.ok(done.upload.lines.includes("证件照：传了 证件照.jpg，没确认网站收到，请看一下网页。"), done.upload.lines.join(" | "));
});

test("when the user stops the fill, the files after it are not uploaded", async (t) => {
  const p = await page(t, FORM, { answers: { "毕业院校": "示例大学" } });
  fakeSite(p);
  // 填到毕业院校（AI 给的值，写入阶段）时用户按了停止。
  p.w.document.getElementById("school").addEventListener("input", () => { p.ui.cancel.onclick?.(); }, { once: true });
  await p.send({ type: "RESUME_PANEL_FILL" });
  await p.confirm();
  const done = await p.finished();
  await Promise.all(p.fills);
  assert.match(p.ui.status.textContent, /已停止/);
  assert.equal(p.w.document.getElementById("photo").files.length, 0);
  assert.equal(p.seen.events.includes("photo"), false);
  assert.ok(done.upload.lines.includes("证件照：没有上传。"), done.upload.lines.join(" | "));
  assert.ok(done.upload.lines.includes(`简历附件：已上传 ${RESUME_FILE.name}。`));
});

test("when the site refuses the resume, nothing is filled and nothing else is uploaded", async (t) => {
  const p = await page(t, FORM, { answers: { "毕业院校": "示例大学" } });
  fakeSite(p, { failResume: true });
  await p.send({ type: "RESUME_PANEL_FILL" });
  await p.confirm();
  const done = await p.finished();
  // 网站可能其实收到了文件、过一会儿才解析：不能接着填，否则解析结果会把填好的盖掉。
  assert.equal(p.fills.length, 0);
  assert.equal(p.value("school"), "");
  assert.equal(p.w.document.getElementById("photo").files.length, 0);
  assert.deepEqual(done.upload.lines.slice(0, 3), [
    "简历上传失败，所以没有继续填写。请在网页上看一下简历框，自己传好简历、等页面不动了，再点一键填写。",
    "简历附件：网站提示「文件格式不对，上传失败」，没有传上。",
    "证件照：没有上传。"
  ]);
  assert.match(p.ui.diag.value, /解析等待 upload_failed/);
});

test("on a platform that parses, a resume that never reached the site stops the fill as well", async (t) => {
  const p = await page(t, FORM, { answers: { "毕业院校": "示例大学" } });
  fakeSite(p);
  await p.send({ type: "RESUME_PANEL_FILL" });
  const offer = (await p.status()).upload;
  // 后台只给证件照（简历没有确认）：简历取不到，照片取到了也不传。
  p.grants.grant(9, p.w.location.href, `${offer.epoch}:${offer.version}`, [{ fileId: PHOTO_FILE.fileId, sha256: PHOTO_FILE.sha256 }]);
  assert.deepEqual(await p.send({ type: "RESUME_PANEL_UPLOAD", action: "confirm", version: offer.version, epoch: offer.epoch,
    choices: [{ slot: "upload-0", fileId: RESUME_FILE.fileId }, { slot: "upload-1", fileId: PHOTO_FILE.fileId }] }), { ok: true });
  const done = await p.finished();
  assert.equal(p.fills.length, 0);
  assert.equal(p.w.document.getElementById("resume").files.length, 0);
  assert.equal(p.w.document.getElementById("photo").files.length, 0);
  assert.deepEqual(done.upload.lines.slice(0, 3), [
    "简历上传失败，所以没有继续填写。请在网页上看一下简历框，自己传好简历、等页面不动了，再点一键填写。",
    "简历附件：没有在侧栏确认，没有上传。",
    "证件照：没有上传。"
  ]);
});

test("只填写，不改回 leaves the values the site changed, drops the record and says so", async (t) => {
  const p = await page(t, FORM, { answers: { "毕业院校": "示例大学" } });
  fakeSite(p);
  // 传上简历以后网站一直在转圈（传之前就有的转圈不算忙，见 busy 的 baseline）。
  spinAfterResume(p);
  await p.send({ type: "RESUME_PANEL_FILL" });
  await p.confirm();
  await p.finished();
  p.w.document.getElementById("spin").remove();
  await p.send({ type: "RESUME_PANEL_FILL" });
  const offer = (await p.status()).upload;
  assert.deepEqual(offer.restore, { count: 1, labels: ["兴趣爱好"], pending: true, laterCount: 0, later: [] });
  assert.deepEqual(await p.send({ type: "RESUME_PANEL_UPLOAD", action: "fill", version: offer.version, epoch: offer.epoch }), { ok: true });
  await Promise.all(p.fills);
  assert.equal(p.value("hobby"), "", "not put back");
  assert.equal(p.value("school"), "示例大学");
  assert.deepEqual((await p.status()).upload.lines, ["这次没有改回上次被网站改掉的 1 项，请核对：兴趣爱好。"]);
  // 记录不留：下一次一键填写不再提改回，免得把这次填好的又改回去。
  await p.send({ type: "RESUME_PANEL_FILL" });
  assert.equal((await p.status()).upload.restore, null);
});

test("an upload result belongs to its page: after an in-page navigation it is gone", async (t) => {
  const p = await page(t, FORM, { answers: { "毕业院校": "示例大学" }, listStatus: "unsupported" });
  fakeSite(p);
  await p.send({ type: "RESUME_PANEL_FILL" });
  await Promise.all(p.fills);
  const now = await p.status();
  assert.equal(now.upload.phase, "done");
  assert.equal(now.upload.host, "app.mokahr.com");
  p.w.history.pushState({}, "", "/campus_apply/example/2");
  assert.equal((await p.status()).upload, null);
});

test("the platform hint waits for the desktop's answer, then says one-click fill uploads the resume first", async (t) => {
  const p = await page(t, FORM);
  assert.equal((await p.status()).siteHint, "");
  await settle();
  assert.equal((await p.status()).siteHint, "Moka 上传简历后会重新解析并覆盖已填内容。一键填写会先上传简历，等解析完再填写。");
});

test("a box that seems to hold a file already (its name shown as text, with spaces) is left alone", async (t) => {
  const seemsTaken = `
    <div class="ant-form-item"><div class="ant-form-item-label"><label title="简历附件">简历附件</label></div>
      <div class="ant-form-item-control"><span class="ant-upload-wrapper">
        <div class="ant-upload ant-upload-select"><span class="ant-upload" role="button"><input id="resume" type="file" accept=".pdf" style="display:none"><button type="button">上传文件</button></span></div>
        <div class="ant-upload-list ant-upload-list-text"></div></span>
        <span class="uploaded">我的 简历 (终版).pdf</span></div></div>`;
  const p = await page(t, row("school", "毕业院校", `<input id="school">`) + seemsTaken + elementPhoto("photo", "证件照"),
    { url: "https://jobs.example.test/apply", answers: { "毕业院校": "示例大学" } });
  fakeSite(p);
  await p.send({ type: "RESUME_PANEL_FILL" });
  const offer = (await p.status()).upload;
  assert.deepEqual(offer.slots.map((slot) => [slot.title, slot.reason, slot.fileId]), [["简历附件", "file_unsure", ""], ["证件照", "", PHOTO_FILE.fileId]]);
  await p.confirm();
  const done = await p.finished();
  await Promise.all(p.fills);
  assert.equal(p.w.document.getElementById("resume").files.length, 0);
  assert.equal(p.w.document.getElementById("photo").files[0].name, PHOTO_FILE.name);
  assert.ok(done.upload.lines.includes("简历附件：框里像是已经有文件了，没有上传，请看一下网页。"), done.upload.lines.join(" | "));
  assert.match(p.ui.diag.value, /没传的原因 file_unsure 1/);
});

test("a progress bar or a status line that was on the page before the upload does not keep the wait going", async (t) => {
  // 页面上常驻一个步骤进度条和一句「审核处理中」：传简历之前就在，不说明网站在解析。
  const p = await page(t, FORM + `<div role="progressbar" aria-valuenow="40">40%</div><p>资料审核处理中</p>`, { answers: { "毕业院校": "示例大学" } });
  fakeSite(p);
  await p.send({ type: "RESUME_PANEL_FILL" });
  await p.confirm();
  const done = await p.finished();
  await Promise.all(p.fills);
  assert.deepEqual(p.seen.events, ["resume", "parse", "fill", "photo"]);
  assert.match(p.ui.diag.value, /解析等待 done，12\.\d s/);
  assert.ok(!done.upload.lines.some((line) => line.includes("还在解析")));
});

test("after a stop, a box the user changed by hand is not put back; the one only the site changed is", async (t) => {
  const form = FORM + row("city", "期望城市", `<input id="city" value="北京">`);
  const p = await page(t, form, { answers: { "毕业院校": "示例大学" } });
  fakeSite(p, { parse: false });
  spinAfterResume(p);
  // 网站解析在 3 秒时清空兴趣爱好、把期望城市改成上海，然后一直转圈：等到上限停下。
  p.w.document.getElementById("resume").addEventListener("change", () => p.time.after(3000, () => {
    p.w.document.getElementById("hobby").value = "";
    p.w.document.getElementById("city").value = "上海";
  }));
  await p.send({ type: "RESUME_PANEL_FILL" });
  await p.confirm();
  await p.finished();
  assert.deepEqual(["hobby", "city"].map(p.value), ["", "上海"]);
  // 停下以后用户自己改了兴趣爱好：不知道是谁改的，不改回，列出来；期望城市停下以后没变过，改回。
  p.w.document.getElementById("hobby").value = "跑步";
  p.w.document.getElementById("spin").remove();
  await p.send({ type: "RESUME_PANEL_FILL" });
  const offer = (await p.status()).upload;
  assert.deepEqual(offer.restore, { count: 1, labels: ["期望城市"], pending: true, laterCount: 1, later: ["兴趣爱好"] });
  await p.confirm();
  const done = await p.finished();
  await Promise.all(p.fills);
  assert.deepEqual(["hobby", "city"].map(p.value), ["跑步", "北京"]);
  assert.ok(done.upload.lines.includes("改回了网站解析改掉的 1 项：期望城市。"), done.upload.lines.join(" | "));
  assert.ok(done.upload.lines.includes("这几项在上次停下以后又变过，没有改回，请核对：兴趣爱好。"), done.upload.lines.join(" | "));
});

test("before the yes the page hears which file id goes into which box, never names, labels or digests", async (t) => {
  const p = await page(t, FORM, { answers: { "毕业院校": "示例大学" } });
  fakeSite(p);
  await p.status();
  await settle();
  await p.send({ type: "RESUME_PANEL_FILL" });
  const offer = (await p.status()).upload;
  assert.deepEqual(offer.slots.map((slot) => slot.fileId), [RESUME_FILE.fileId, PHOTO_FILE.fileId, ""]);
  assert.ok(p.seen.replies.length >= 2, "the hint and the card each asked the worker");
  for (const reply of p.seen.replies) {
    for (const secret of [RESUME_FILE.name, PHOTO_FILE.name, PHOTO_FILE.label, RESUME_FILE.sha256, PHOTO_FILE.sha256]) {
      assert.equal(reply.includes(secret), false, `${secret} reached the page: ${reply.slice(0, 120)}`);
    }
  }
  assert.equal(p.seen.messages.some((message) => message.includes("DESKTOP_RESUME_FILES_LIST")), false, "the page never asks for the list");
});

test("a box the user changes while the site parses is not put back, and the result says so", async (t) => {
  const p = await page(t, FORM, { answers: { "毕业院校": "示例大学" } });
  fakeSite(p);
  // 网站 3 秒时清空兴趣爱好；用户 5 秒时自己在兴趣爱好里写了游泳，7 秒时在空着的毕业院校里写了自己的学校。
  p.w.document.getElementById("resume").addEventListener("change", () => {
    p.time.after(5000, () => typeAsUser(p, "hobby", "游泳"));
    p.time.after(7000, () => typeAsUser(p, "school", "用户写的学校"));
  });
  await p.send({ type: "RESUME_PANEL_FILL" });
  await p.confirm();
  const done = await p.finished();
  await Promise.all(p.fills);
  assert.equal(p.value("hobby"), "游泳", "not put back");
  assert.ok(done.upload.lines.includes("等网站解析时你改过这几项，没有改回，请核对：兴趣爱好。"), done.upload.lines.join(" | "));
  assert.equal(done.upload.lines.some((line) => line.startsWith("改回了")), false);
  // 用户自己写在空框里的不算网站解析填的：填写要覆盖它之前先问。网站解析填的姓名照常填，不问。
  assert.equal(p.seen.confirms, 1);
  assert.deepEqual(["name", "school"].map(p.value), ["测试用户", "示例大学"]);
  assert.match(p.ui.diag.value, /改回 0，没改回 0，停下后又变过 0，等解析时用户改过 1，/);
});

test("after a stop, a box the user changed while the site was parsing is not put back either", async (t) => {
  const form = FORM + row("city", "期望城市", `<input id="city" value="北京">`);
  const p = await page(t, form, { answers: { "毕业院校": "示例大学" } });
  fakeSite(p, { parse: false });
  spinAfterResume(p);
  // 网站 3 秒时清空兴趣爱好，用户 5 秒时把期望城市改成深圳；网站一直在转圈，等到上限停下。
  p.w.document.getElementById("resume").addEventListener("change", () => {
    p.time.after(3000, () => { p.w.document.getElementById("hobby").value = ""; });
    p.time.after(5000, () => typeAsUser(p, "city", "深圳"));
  });
  await p.send({ type: "RESUME_PANEL_FILL" });
  await p.confirm();
  await p.finished();
  p.w.document.getElementById("spin").remove();
  await p.send({ type: "RESUME_PANEL_FILL" });
  const offer = (await p.status()).upload;
  assert.deepEqual(offer.restore, { count: 1, labels: ["兴趣爱好"], pending: true, laterCount: 1, later: ["期望城市"] });
  await p.confirm();
  const done = await p.finished();
  await Promise.all(p.fills);
  assert.deepEqual(["hobby", "city"].map(p.value), ["看书", "深圳"]);
  assert.ok(done.upload.lines.includes("改回了网站解析改掉的 1 项：兴趣爱好。"), done.upload.lines.join(" | "));
  assert.ok(done.upload.lines.includes("等网站解析时你改过这几项，没有改回，请核对：期望城市。"), done.upload.lines.join(" | "));
});

test("a box that changed after the yes voids the card: nothing is fetched, uploaded or filled", async (t) => {
  const p = await page(t, FORM, { answers: { "毕业院校": "示例大学" } });
  fakeSite(p);
  await p.send({ type: "RESUME_PANEL_FILL" });
  // 卡片开着时，网站把简历框改成只收 Word。
  p.w.document.getElementById("resume").setAttribute("accept", ".doc,.docx");
  assert.deepEqual(await p.confirm(), { ok: true });
  const done = await p.finished();
  assert.equal(p.fills.length, 0);
  assert.deepEqual(p.seen.events, []);
  assert.equal(p.seen.messages.some((message) => message.includes("DESKTOP_RESUME_FILE_FETCH")), false);
  assert.deepEqual(done.upload.lines, ["上传框和确认时不一样了，这张卡片作废，没有上传，也没有填写。请重新点一键填写，再确认一次。",
    "作品集：插件只传简历附件、证件照和成绩单，这一项请自己上传。"]);
  assert.match(p.ui.diag.value, /结果 card_void 2、skipped 1/);
});

test("a photo box that changed by the time it is reached is not uploaded; the card is void from there on", async (t) => {
  const p = await page(t, FORM, { answers: { "毕业院校": "示例大学" } });
  fakeSite(p);
  // 填写时网站把证件照框换成只收 PNG。
  p.w.document.getElementById("school").addEventListener("input", () => p.w.document.getElementById("photo").setAttribute("accept", "image/png"), { once: true });
  await p.send({ type: "RESUME_PANEL_FILL" });
  await p.confirm();
  const done = await p.finished();
  await Promise.all(p.fills);
  assert.equal(p.w.document.getElementById("resume").files[0].name, RESUME_FILE.name);
  assert.equal(p.value("school"), "示例大学");
  assert.equal(p.w.document.getElementById("photo").files.length, 0);
  assert.ok(done.upload.lines.includes("上传框和确认时不一样了，这张卡片作废，后面的文件没有上传。请重新点一键填写，再确认一次。"), done.upload.lines.join(" | "));
});

test("on a platform that parses, a stop before the resume reaches the site keeps the record; the next fill lists what changed since", async (t) => {
  const p = await page(t, FORM, { answers: { "毕业院校": "示例大学" } });
  fakeSite(p);
  await p.send({ type: "RESUME_PANEL_FILL" });
  const offer = (await p.status()).upload;
  // 后台只给证件照（简历没有确认）：简历取不到，停下。
  p.grants.grant(9, p.w.location.href, `${offer.epoch}:${offer.version}`, [{ fileId: PHOTO_FILE.fileId, sha256: PHOTO_FILE.sha256 }]);
  await p.send({ type: "RESUME_PANEL_UPLOAD", action: "confirm", version: offer.version, epoch: offer.epoch,
    choices: [{ slot: "upload-0", fileId: RESUME_FILE.fileId }, { slot: "upload-1", fileId: PHOTO_FILE.fileId }] });
  await p.finished();
  assert.equal(p.fills.length, 0);
  // 用户照提示自己传了简历，网站解析清空了兴趣爱好。
  const resume = p.w.document.getElementById("resume");
  resume.files = [new p.w.File(["x"], "自己传的简历.pdf", { type: "application/pdf" })];
  resume.dispatchEvent(new p.w.Event("change", { bubbles: true }));
  await p.time.sleep(3000);
  assert.equal(p.value("hobby"), "");
  // 再点一键填写：简历框里有文件了，只传证件照；兴趣爱好在停下以后变的，认不准是谁改的，不改回，列出来。
  await p.send({ type: "RESUME_PANEL_FILL" });
  const next = (await p.status()).upload;
  assert.deepEqual(next.slots.map((slot) => slot.reason), ["has_file", "", "other_kind"]);
  await p.confirm();
  const done = await p.finished();
  await Promise.all(p.fills);
  assert.equal(p.value("hobby"), "");
  assert.ok(done.upload.lines.includes("这几项在上次停下以后又变过，没有改回，请核对：兴趣爱好。"), done.upload.lines.join(" | "));
});

test("questions the parse adds count as the site's: the fill writes them without asking", async (t) => {
  const p = await page(t, FORM, { answers: { "毕业院校": "示例大学", "政治面貌": "共青团员" } });
  fakeSite(p);
  // 解析在毕业院校后面加了一道题，并填上了。
  p.w.document.getElementById("resume").addEventListener("change", () => p.time.after(3000, () => {
    p.w.document.getElementById("school").closest(".form-item").insertAdjacentHTML("afterend", row("party", "政治面貌", `<input id="party" value="群众">`));
  }));
  await p.send({ type: "RESUME_PANEL_FILL" });
  await p.confirm();
  const done = await p.finished();
  await Promise.all(p.fills);
  assert.equal(p.value("party"), "共青团员");
  assert.equal(p.seen.confirms, 0, "no overwrite question for what the parse wrote");
  assert.equal(done.upload.lines.some((line) => line.includes("政治面貌")), false);
});

test("a stop while putting values back lists the ones not looked at yet", async (t) => {
  const form = FORM + row("city", "期望城市", `<input id="city" value="北京">`);
  const p = await page(t, form, { answers: { "毕业院校": "示例大学" } });
  fakeSite(p, { parse: false });
  p.w.document.getElementById("resume").addEventListener("change", () => p.time.after(3000, () => {
    p.w.document.getElementById("hobby").value = "";
    p.w.document.getElementById("city").value = "上海";
  }));
  // 改回兴趣爱好的时候用户按了停止。
  p.w.document.getElementById("hobby").addEventListener("input", () => { p.send({ type: "RESUME_PANEL_CANCEL" }); }, { once: true });
  await p.send({ type: "RESUME_PANEL_FILL" });
  await p.confirm();
  const done = await p.finished();
  assert.equal(p.fills.length, 0);
  assert.deepEqual(["hobby", "city"].map(p.value), ["看书", "上海"]);
  assert.ok(done.upload.lines.includes("已停止，没有填写。"), done.upload.lines.join(" | "));
  assert.ok(done.upload.lines.includes("改回了网站解析改掉的 1 项：兴趣爱好。"), done.upload.lines.join(" | "));
  assert.ok(done.upload.lines.includes("改回时停下了，这几项没有处理，请核对：期望城市。"), done.upload.lines.join(" | "));
});

test("the platform hint says nothing about uploading when no resume on the desktop fits the box", async (t) => {
  // 简历框只收 Word，桌面里只有 PDF。
  const p = await page(t, row("name", "姓名", `<input id="name">`) + antdUpload("resume", "简历附件", ".doc,.docx"));
  assert.equal((await p.status()).siteHint, "");
  await settle();
  assert.equal((await p.status()).siteHint, "Moka 上传简历后会重新解析并覆盖已填内容，请先上传简历再填写。");
});

// 把页面上某个时长的计时器改成马上到点（测试里不真等几秒、几十秒）。
function shorten(p, ms) {
  const timer = p.w.setTimeout.bind(p.w);
  p.w.setTimeout = (fn, delay, ...rest) => timer(fn, delay === ms ? 0 : delay, ...rest);
}

test("a desktop that never answers does not hold the fill or the hint: they go on as if it could not be reached", async (t) => {
  const p = await page(t, FORM, { answers: { "毕业院校": "示例大学" }, silent: ["DESKTOP_RESUME_FILES_PLAN"] });
  fakeSite(p);
  shorten(p, 5000);
  // 侧栏提示：问桌面的时候先不给，到点按连不上，还是原来那句；之后照常再问。
  assert.equal((await p.status()).siteHint, "");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await p.status()).siteHint, "Moka 上传简历后会重新解析并覆盖已填内容，请先上传简历再填写。");
  // 一键填写：没有卡片，照常填写，结果里说桌面连不上。
  assert.deepEqual(await within(p.send({ type: "RESUME_PANEL_FILL" })), { ok: true });
  await Promise.all(p.fills);
  assert.equal(p.value("school"), "示例大学");
  const now = await p.status();
  assert.ok(now.upload.lines.includes("简历附件：桌面暂时连不上，没有上传。"), now.upload.lines.join(" | "));
  assert.deepEqual(p.seen.events.filter((event) => event !== "fill"), []);
});

test("a file read that never finishes ends at the limit; on a platform that parses nothing is filled", async (t) => {
  const p = await page(t, FORM, { answers: { "毕业院校": "示例大学" }, hold: () => new Promise(() => {}) });
  fakeSite(p);
  shorten(p, 60000);
  await p.send({ type: "RESUME_PANEL_FILL" });
  await p.confirm();
  const done = await p.finished();
  assert.equal(p.fills.length, 0);
  assert.equal(p.w.document.getElementById("resume").files.length, 0);
  assert.deepEqual(done.upload.lines.slice(0, 2), [
    "简历上传失败，所以没有继续填写。请在网页上看一下简历框，自己传好简历、等页面不动了，再点一键填写。",
    "简历附件：没能从桌面取到文件，没有上传。"
  ]);
});

test("stopping while a file read hangs stops at once", async (t) => {
  let asked = false;
  const p = await page(t, FORM, { answers: { "毕业院校": "示例大学" }, hold: () => { asked = true; return new Promise(() => {}); } });
  fakeSite(p);
  await p.send({ type: "RESUME_PANEL_FILL" });
  await p.confirm();
  for (let i = 0; i < 200 && !asked; i += 1) await settle();
  assert.deepEqual(await p.send({ type: "RESUME_PANEL_CANCEL" }), { ok: true });
  const done = await within(p.finished(), 5000);
  assert.equal(p.fills.length, 0);
  assert.equal(done.upload.lines[0], "已停止，没有上传，也没有填写。");
});

test("a whole form drawn again while the site parses is still watched: values written into the new boxes keep the wait going", async (t) => {
  const p = await page(t, FORM, { url: "https://jobs.example.test/apply", answers: { "毕业院校": "示例大学" } });
  fakeSite(p, { parse: false });
  // 传上简历 0.6 秒后，网站把这几道题整个重画了一遍（框的个数不变）；1.8 秒时把解析结果写进新框。
  p.w.document.getElementById("resume").addEventListener("change", () => {
    p.time.after(600, () => {
      for (const item of p.w.document.querySelectorAll(".form-item")) item.outerHTML = item.outerHTML;
    });
    p.time.after(1800, () => {
      p.w.document.getElementById("name").value = "解析出的名字";
      p.w.document.getElementById("hobby").value = "";
    });
  });
  await p.send({ type: "RESUME_PANEL_FILL" });
  await p.confirm();
  const done = await p.finished();
  await Promise.all(p.fills);
  // 读的是新框：1.8 秒写进去也看得见，安静 1.5 秒以后（3.4 秒）才结束等待。还看旧框的话 2.2 秒就结束了。
  assert.match(p.ui.diag.value, /解析等待 done，3\.4 s/);
  assert.deepEqual(["name", "hobby", "school"].map(p.value), ["测试用户", "看书", "示例大学"]);
  assert.ok(done.upload.lines.includes("改回了网站解析改掉的 1 项：兴趣爱好。"), done.upload.lines.join(" | "));
  assert.equal(p.seen.confirms, 0, "what the parse wrote into the new boxes is the site's");
});

test("on a platform that parses, a card voided before anything was fetched keeps the record too", async (t) => {
  const p = await page(t, FORM, { answers: { "毕业院校": "示例大学" } });
  fakeSite(p);
  await p.send({ type: "RESUME_PANEL_FILL" });
  // 卡片开着时证件照框改成只收 PNG：卡片作废，什么都没取。
  p.w.document.getElementById("photo").setAttribute("accept", "image/png");
  await p.confirm();
  const voided = await p.finished();
  assert.equal(voided.upload.lines[0], "上传框和确认时不一样了，这张卡片作废，没有上传，也没有填写。请重新点一键填写，再确认一次。");
  // 用户自己传了简历，网站解析清空了兴趣爱好。
  const resume = p.w.document.getElementById("resume");
  resume.files = [new p.w.File(["x"], "自己传的简历.pdf", { type: "application/pdf" })];
  resume.dispatchEvent(new p.w.Event("change", { bubbles: true }));
  await p.time.sleep(3000);
  // 再点一键填写：简历框有文件了，证件照框不收桌面里的照片，没有卡片，照常填写；兴趣爱好在停下以后变的，
  // 认不准是谁改的，不改回，列出来。
  assert.deepEqual(await p.send({ type: "RESUME_PANEL_FILL" }), { ok: true });
  await Promise.all(p.fills);
  const now = await p.status();
  assert.equal(p.value("hobby"), "");
  assert.ok(now.upload.lines.includes("这几项在上次停下以后又变过，没有改回，请核对：兴趣爱好。"), now.upload.lines.join(" | "));
});

test("the hint learns of a resume added on the desktop when one-click fill asks, and asks again after a while", async (t) => {
  const files = [PHOTO_FILE];
  const p = await page(t, FORM, { answers: { "毕业院校": "示例大学" }, files });
  fakeSite(p);
  const real = p.w.Date.now.bind(p.w.Date);
  let later = 0;
  p.w.Date.now = () => real() + later;
  const before = "Moka 上传简历后会重新解析并覆盖已填内容，请先上传简历再填写。";
  const after = "Moka 上传简历后会重新解析并覆盖已填内容。一键填写会先上传简历，等解析完再填写。";
  await p.status();
  await settle();
  assert.equal((await p.status()).siteHint, before);
  // 用户在桌面里加了简历附件：提示还在用刚才的回答。
  files.push(RESUME_FILE);
  later += 2100;
  assert.equal((await p.status()).siteHint, before);
  // 点一键填写：卡片要问桌面，问到的也给提示用。
  await p.send({ type: "RESUME_PANEL_FILL" });
  later += 2100;
  assert.equal((await p.status()).siteHint, after);
  // 用户又在桌面里把简历附件删了：15 秒以后再问，提示跟着变。
  await p.send({ type: "RESUME_PANEL_UPLOAD", action: "cancel", version: (await p.status()).upload.version, epoch: (await p.status()).upload.epoch });
  files.splice(files.indexOf(RESUME_FILE), 1);
  later += 15100;
  await p.status();
  await settle();
  later += 2100;
  assert.equal((await p.status()).siteHint, before);
});

test("a resume chosen for an 'other material' box is not the resume: it goes last, after the fill, and nothing waits on it", async (t) => {
  const p = await page(t, FORM, { answers: { "毕业院校": "示例大学" } });
  fakeSite(p);
  p.w.document.getElementById("works").addEventListener("change", () => p.seen.events.push("works"));
  await p.send({ type: "RESUME_PANEL_FILL" });
  // 用户只给「作品集」框选了简历文件，简历框、证件照框都不传。
  const done = await (async () => { await p.confirm([{ slot: "upload-2", fileId: RESUME_FILE.fileId }]); return p.finished(); })();
  await Promise.all(p.fills);
  assert.equal(p.w.document.getElementById("resume").files.length, 0);
  assert.equal(p.w.document.getElementById("works").files[0].name, RESUME_FILE.name);
  assert.deepEqual(p.seen.events, ["fill", "works"], "filled first, the material last; no parse wait");
  assert.equal(done.upload.lines.some((line) => line.includes("简历上传失败")), false, done.upload.lines.join(" | "));
});

test("a photo box the parse drew again is still the photo box: the photo goes up", async (t) => {
  const p = await page(t, FORM, { answers: { "毕业院校": "示例大学" } });
  fakeSite(p);
  // 网站解析时把证件照这一题整个重画了（file 框、上传区都是新节点，题目、格式不变）。新框传上以后显示缩略图。
  p.w.document.getElementById("resume").addEventListener("change", () => p.time.after(3000, () => {
    const item = p.w.document.getElementById("photo").closest(".el-form-item");
    item.outerHTML = item.outerHTML;
    p.w.document.getElementById("photo").addEventListener("change", () => {
      p.seen.events.push("photo");
      p.w.document.querySelector(".el-upload-list").innerHTML = `<li class="el-upload-list__item is-success"><img class="el-upload-list__item-thumbnail" src="blob:https://app.mokahr.com/2"></li>`;
    });
  }));
  await p.send({ type: "RESUME_PANEL_FILL" });
  await p.confirm();
  const done = await p.finished();
  await Promise.all(p.fills);
  assert.equal(p.w.document.getElementById("photo").files[0].name, PHOTO_FILE.name);
  assert.ok(done.upload.lines.includes("证件照：已上传 证件照.jpg。"), done.upload.lines.join(" | "));
  assert.equal(done.upload.lines.some((line) => line.includes("作废")), false);
});

test("when the upload ends while another AI task is busy, the fill button gets its words back now and its use back when that task lets go", async (t) => {
  const p = await page(t, FORM, { answers: { "毕业院校": "示例大学" } });
  fakeSite(p);
  const hooks = p.w.ResumeProHighlightTest;
  // 传证件照的时候，用户在侧栏开始了别的 AI 任务（占着忙碌状态）。
  p.w.document.getElementById("photo").addEventListener("change", () => hooks.setAiBusy(true));
  await p.send({ type: "RESUME_PANEL_FILL" });
  await p.confirm();
  // 页面一直报忙（别的任务占着），只等上传结束。
  for (let i = 0; i < 2000 && (await p.status()).upload?.phase === "running"; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await p.status()).upload.phase, "done");
  await Promise.all(p.fills);
  assert.equal(p.ui.fill.textContent, "一键 AI 填写");
  assert.equal(p.ui.fill.disabled, true, "still busy elsewhere");
  hooks.setAiBusy(false);
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(p.ui.fill.disabled, false);
});

test("a hint answer that comes back after a newer one is dropped", async (t) => {
  const files = [PHOTO_FILE];
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let first = true;
  // 第一次问桌面（平台提示）的回答压住：它是按「桌面里还没有简历」算的。
  const gate = (message) => {
    if (message.type !== "DESKTOP_RESUME_FILES_PLAN" || !first) return Promise.resolve();
    first = false;
    return held;
  };
  const p = await page(t, FORM, { answers: { "毕业院校": "示例大学" }, files, gate });
  fakeSite(p);
  const real = p.w.Date.now.bind(p.w.Date);
  let later = 0;
  p.w.Date.now = () => real() + later;
  assert.equal((await p.status()).siteHint, "");
  // 这时用户在桌面里加了简历，点一键填写：问到的新回答是能先传简历。
  files.push(RESUME_FILE);
  await p.send({ type: "RESUME_PANEL_FILL" });
  // 旧回答这才回来：过期了，丢掉。
  release();
  await settle();
  later += 2100;
  assert.equal((await p.status()).siteHint, "Moka 上传简历后会重新解析并覆盖已填内容。一键填写会先上传简历，等解析完再填写。");
});

test("when the worker refuses the plan request, the result says the box was not handled, not that the desktop is down, and the diagnostics say why", async (t) => {
  // 简历框的 accept 长得离谱，后台不收这个请求（invalid_payload）。
  const accept = Array.from({ length: 500 }, (_, index) => `.x${index}`).join(",") + ",.pdf";
  assert.ok(accept.length > 2000);
  const p = await page(t, row("school", "毕业院校", `<input id="school">`) + antdUpload("resume", "简历附件", accept),
    { url: "https://jobs.example.test/apply", answers: { "毕业院校": "示例大学" } });
  fakeSite(p);
  assert.deepEqual(await p.send({ type: "RESUME_PANEL_FILL" }), { ok: true });
  await Promise.all(p.fills);
  assert.equal(p.value("school"), "示例大学");
  const now = await p.status();
  assert.deepEqual(now.upload.lines, ["简历附件：插件没能处理这个上传框，没有上传，请自己上传。"]);
  assert.match(p.ui.diag.value, /上传：框 resume 1；结果 skipped 1；没传的原因 plan_invalid 1/);
});

test("without the upload helper only uploading is off: one-click fill fills as before and the diagnostics say why nothing was uploaded", async (t) => {
  const p = await page(t, FORM, { answers: { "毕业院校": "示例大学" }, skip: ["upload-slots.js"] });
  fakeSite(p);
  assert.equal(p.w.ResumeProUploadSlots, undefined);
  assert.deepEqual(await p.send({ type: "RESUME_PANEL_FILL" }), { ok: true });
  await Promise.all(p.fills);
  assert.equal(p.value("school"), "示例大学");
  assert.equal(p.w.document.getElementById("resume").files.length, 0);
  assert.match(p.ui.diag.value, /上传：框 无；结果 无；没传的原因 upload_helper_missing 1/);
  // 平台提示用原来那句：不会说一键填写能先传简历。
  assert.equal((await p.status()).siteHint, "Moka 上传简历后会重新解析并覆盖已填内容，请先上传简历再填写。");
});

test("a plan the worker turns down for this sender is not called a desktop that is down, and the diagnostics keep its status", async (t) => {
  const p = await page(t, FORM, { answers: { "毕业院校": "示例大学" }, replies: { DESKTOP_RESUME_FILES_PLAN: { status: "forbidden" } } });
  fakeSite(p);
  assert.deepEqual(await p.send({ type: "RESUME_PANEL_FILL" }), { ok: true });
  await Promise.all(p.fills);
  const now = await p.status();
  assert.deepEqual(now.upload.lines.slice(0, 2), ["简历附件：插件没能处理这个上传框，没有上传，请自己上传。", "证件照：插件没能处理这个上传框，没有上传，请自己上传。"]);
  assert.equal(now.upload.lines.some((line) => line.includes("连不上")), false);
  assert.match(p.ui.diag.value, /没传的原因 plan_forbidden 3；问桌面 forbidden；/);
});

test("a page that moves on, or whose upload ends, gives back what is left of its yes", async (t) => {
  // 后台没收到标签页换地址的通知：这里看页面自己交回。
  const p = await page(t, FORM, { answers: { "毕业院校": "示例大学" }, tabEvents: false });
  fakeSite(p);
  await p.send({ type: "RESUME_PANEL_FILL" });
  const offer = (await p.status()).upload;
  const card = `${offer.epoch}:${offer.version}`;
  const href = p.w.location.href;
  p.grants.grant(9, href, card, [{ fileId: RESUME_FILE.fileId, sha256: RESUME_FILE.sha256 }]);
  // 单页应用在同一个网站里换了地址：页面一发现卡片过期，就告诉后台这张卡片的确认不要了。
  p.w.history.pushState({}, "", "/campus_apply/example/2");
  await p.status();
  await settle();
  assert.ok(p.seen.messages.some((message) => message.includes("DESKTOP_RESUME_FILES_RELEASE")));
  assert.equal(p.grants.take(9, href, RESUME_FILE.fileId, card), null);
  // 上传结束：侧栏确认过、页面没用上的文件（证件照框选了不传）也作废。
  await p.send({ type: "RESUME_PANEL_FILL" });
  const next = (await p.status()).upload;
  const nextCard = `${next.epoch}:${next.version}`;
  p.grants.grant(9, p.w.location.href, nextCard, [RESUME_FILE, PHOTO_FILE].map((file) => ({ fileId: file.fileId, sha256: file.sha256 })));
  await p.send({ type: "RESUME_PANEL_UPLOAD", action: "confirm", version: next.version, epoch: next.epoch,
    choices: [{ slot: "upload-0", fileId: RESUME_FILE.fileId }] });
  await p.finished();
  await Promise.all(p.fills);
  await settle();
  assert.equal(p.w.document.getElementById("resume").files[0].name, RESUME_FILE.name);
  assert.equal(p.grants.take(9, p.w.location.href, PHOTO_FILE.fileId, nextCard), null, "the unused yes for the photo is gone");
});

test("a yes is gone once the tab moved away, even when it is back at the same address before the upload starts", async (t) => {
  const p = await page(t, FORM, { answers: { "毕业院校": "示例大学" } });
  fakeSite(p);
  await p.send({ type: "RESUME_PANEL_FILL" });
  const offer = (await p.status()).upload;
  p.grants.grant(9, p.w.location.href, `${offer.epoch}:${offer.version}`, [{ fileId: RESUME_FILE.fileId, sha256: RESUME_FILE.sha256 }]);
  // 侧栏确认以后、页面开始上传以前，网站跳到下一页又回到这一页：页面看地址没变照常开始，后台不给文件。
  p.w.history.pushState({}, "", "/campus_apply/example/2");
  p.w.history.pushState({}, "", "/campus_apply/example/1");
  assert.deepEqual(await p.send({ type: "RESUME_PANEL_UPLOAD", action: "confirm", version: offer.version, epoch: offer.epoch,
    choices: [{ slot: "upload-0", fileId: RESUME_FILE.fileId }] }), { ok: true });
  const done = await p.finished();
  await Promise.all(p.fills);
  assert.ok(p.seen.messages.some((message) => message.includes("DESKTOP_RESUME_FILE_FETCH")), "the page asked for the file");
  assert.equal(p.w.document.getElementById("resume").files.length, 0);
  assert.ok(done.upload.lines.includes("简历附件：没有在侧栏确认，没有上传。"), done.upload.lines.join(" | "));
});

test("a filled box that is only out of sight now, its value unchanged, is not listed as one that could not be put back", async (t) => {
  const form = FORM + row("city", "期望城市", `<input id="city" value="北京">`);
  const p = await page(t, form, { answers: { "毕业院校": "示例大学" } });
  fakeSite(p);
  spinAfterResume(p);
  await p.send({ type: "RESUME_PANEL_FILL" });
  await p.confirm();
  await p.finished();
  p.w.document.getElementById("spin").remove();
  // 网站分步显示：期望城市这一题现在藏起来了，值没变。
  p.w.document.getElementById("city").closest(".form-item").hidden = true;
  await p.send({ type: "RESUME_PANEL_FILL" });
  await p.confirm();
  const done = await p.finished();
  await Promise.all(p.fills);
  assert.equal(p.value("hobby"), "看书");
  assert.equal(p.value("city"), "北京");
  assert.equal(done.upload.lines.some((line) => line.includes("期望城市")), false, done.upload.lines.join(" | "));
  assert.match(p.ui.diag.value, /改回 1，没改回 0，/);
});

test("while the fill runs inside an upload, busy and stop are the fill's own", async (t) => {
  const p = await page(t, FORM, { answers: { "毕业院校": "示例大学" } });
  fakeSite(p);
  const hooks = p.w.ResumeProHighlightTest;
  const seen = [];
  const status = () => {
    let reply = null;
    p.w.__panel({ type: "RESUME_PANEL_STATUS" }, { id: "test-extension" }, (value) => { reply = value; });
    return reply;
  };
  // 填写写到毕业院校时（填写那一步）：看填写自己在忙、和它不忙时侧栏收到的样子。
  p.w.document.getElementById("school").addEventListener("input", () => {
    const busy = status();
    hooks.setAiBusy(false);
    const idle = status();
    hooks.setAiBusy(true);
    seen.push({ busy: busy.busy, label: busy.cancelLabel, idle: idle.busy, upload: busy.upload?.phase });
  }, { once: true });
  await p.send({ type: "RESUME_PANEL_FILL" });
  await p.confirm();
  await p.finished();
  await Promise.all(p.fills);
  assert.deepEqual(seen, [{ busy: true, label: "", idle: false, upload: "running" }]);
});

test("after a stop, a filled box only out of sight with its value unchanged is not listed next time either", async (t) => {
  const form = FORM + row("city", "期望城市", `<input id="city" value="北京">`);
  const p = await page(t, form, { answers: { "毕业院校": "示例大学" } });
  // 网站一直在转圈、没改任何已填的框：等到上限停下，记下的值留到下一次。
  fakeSite(p, { parse: false });
  spinAfterResume(p);
  await p.send({ type: "RESUME_PANEL_FILL" });
  await p.confirm();
  await p.finished();
  p.w.document.getElementById("spin").remove();
  p.w.document.getElementById("city").closest(".form-item").hidden = true;
  // 再点一键填写：没有要改回的，期望城市只是藏起来了，不列出来。
  await p.send({ type: "RESUME_PANEL_FILL" });
  const offer = (await p.status()).upload;
  assert.equal(offer.restore, null);
  await p.confirm();
  const done = await p.finished();
  await Promise.all(p.fills);
  assert.equal(done.upload.lines.some((line) => line.includes("期望城市")), false, done.upload.lines.join(" | "));
});
