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
    after: (delay, run) => tasks.push({ at: time + delay, run })
  };
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

async function page(t, body, { url = "https://app.mokahr.com/campus_apply/example/1", answers = {}, files = [RESUME_FILE, PHOTO_FILE], listStatus = "ok", hold = null } = {}) {
  const { createUploadGrants, handleUploadMessage } = await import("../link/upload-grants.mjs");
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
  const seen = { messages: [], stored: [], logs: [], ai: [], confirms: 0, events: [] };
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
  const api = { runtime: { id: "test-extension", getURL: (file) => `chrome-extension://test-extension/${file}` }, tabs: { get: async () => ({ url: w.location.href }) } };
  const background = (message) => new Promise((resolve) => {
    const kept = handleUploadMessage({ api, grants, files: desktop }, message, { id: "test-extension", tab: { id: 9 }, frameId: 0, url: w.location.href }, resolve);
    if (kept === null) resolve({});
  });
  w.chrome = {
    runtime: { id: "test-extension", getURL: (file) => `chrome-extension://test-extension/${file}`, getManifest: () => ({ version: "0.5.0" }),
      onMessage: { addListener(listener) { w.__panel = listener; } },
      sendMessage: async (message) => {
        seen.messages.push(JSON.stringify(message));
        if (message.type === "DESKTOP_RESUME_READ") return { status: "ok", data };
        if (["ENSURE_AI_HOST", "AI_HOST_READY"].includes(message.type)) return { ready: true };
        if (message.type === "AI_FILL" || message.type === "CANCEL_AI_FILL") return ai(message);
        if (String(message.type).startsWith("DESKTOP_RESUME_FILE")) return background(message);
        return {};
      } },
    storage: { local: { get: async () => ({}), set: async (value) => { seen.stored.push(JSON.stringify(value)); } },
      session: { get: async () => ({}), set: async (value) => { seen.stored.push(JSON.stringify(value)); } }, onChanged: { addListener() {} } }
  };
  for (const file of SCRIPTS) w.eval(fs.readFileSync(path.join(ROOT, file), "utf8"));
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
      if (rows.length) grants.grant(9, new URL(w.location.href).origin, rows.map((file) => ({ fileId: file.fileId, sha256: file.sha256 })));
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
function fakeSite(p, { parse = true, dialog = false, silentPhoto = false } = {}) {
  const doc = p.w.document;
  doc.getElementById("resume").addEventListener("change", (event) => {
    const file = event.target.files[0];
    p.seen.events.push("resume");
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
  assert.match(p.ui.diag.value, /上传：框 resume 1、photo 1、other 1；结果 done 2、skipped 1；没传的原因 other_kind 1；解析等待 done，12\.\d s；改回 1，没改回 0，网站填的 0/);
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
  p.w.document.body.insertAdjacentHTML("beforeend", `<div class="ant-spin ant-spin-spinning" id="spin"></div>`);
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
  assert.deepEqual(offer.restore, { count: 1, labels: ["兴趣爱好"], pending: true });
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
  // 给认不出要什么的框选了它收不下的文件：不认。
  await p.send({ type: "RESUME_PANEL_FILL" });
  const third = (await p.status()).upload;
  const refused = await p.send({ type: "RESUME_PANEL_UPLOAD", action: "confirm", version: third.version, epoch: third.epoch,
    choices: [{ slot: "upload-1", fileId: RESUME_FILE.fileId }] });
  assert.deepEqual(refused, { ok: false, error: "选的文件放不进对应的上传框，请重新选。" });
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
  // 会覆盖的平台：不能传时侧栏还是原来那句提示。
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
