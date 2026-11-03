// #429 第 4 项：侧栏里上传前的确认卡片和上传结果。卡片列出「哪个文件 → 哪个框 → 哪个网站」，点一次才传；
// 确认时侧栏先告诉后台这个标签页、这个网站、选的这几个文件，再让页面开始。真实的 sidepanel.html 和脚本，浏览器接口是替身。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const HTML = fs.readFileSync(path.join(ROOT, "sidepanel.html"), "utf8");
const SCRIPTS = [...HTML.matchAll(/<script src="([^"]+)"><\/script>/g)].map((hit) => hit[1]);
const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const SHA = (char) => char.repeat(64);
const FILES = [
  { fileId: "r1", kind: "resume", name: "测试用户_简历.pdf", label: "中文", mime: "application/pdf", byteSize: 1258291, sha256: SHA("a"), isDefault: true, templateIds: [] },
  { fileId: "r2", kind: "resume", name: "Test_Resume.pdf", label: "英文", mime: "application/pdf", byteSize: 90000, sha256: SHA("b"), isDefault: false, templateIds: [] },
  { fileId: "p1", kind: "photo", name: "证件照.jpg", label: "蓝底一寸", mime: "image/jpeg", byteSize: 87040, sha256: SHA("c"), isDefault: true, templateIds: [] }
];
const OFFER = {
  phase: "offer", version: 3, epoch: "e1", host: "app.mokahr.com", platform: "Moka",
  slots: [
    { id: "upload-0", title: "简历附件", kind: "resume", reason: "", fileId: "r1", accept: ".pdf,.doc,.docx", limit: 10485760, siteLimit: null },
    { id: "upload-1", title: "证件照", kind: "photo", reason: "", fileId: "p1", accept: "image/*", limit: 512000, siteLimit: 512000 },
    { id: "upload-2", title: "作品集", kind: "other", reason: "other_kind", fileId: "", accept: "", limit: 10485760, siteLimit: null }
  ],
  restore: { count: 2, labels: ["兴趣爱好", "期望城市"], pending: false }
};

async function openPanel(t, { upload = OFFER, tabUrl = "https://app.mokahr.com/campus_apply/example/1", files = FILES } = {}) {
  const dom = new JSDOM(HTML, { url: "chrome-extension://ext/sidepanel.html", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  t.after(() => w.close());
  const calls = [];
  const state = { status: { ready: true, busy: false, upload }, tab: { id: 7, url: tabUrl } };
  let updated = null;
  w.chrome = {
    runtime: {
      id: "ext", getURL: (file) => `chrome-extension://ext/${file}`, getManifest: () => ({ version: "0.5.0" }),
      onMessage: { addListener() {} },
      sendMessage: async (message) => {
        calls.push({ to: "worker", message: JSON.parse(JSON.stringify(message)) });
        if (message.type === "DESKTOP_RESUME_READ") return { status: "ok", data: {
          templates: [{ id: "t", name: "虚构模板", fieldCount: 1 }],
          activeTemplate: { id: "t", name: "虚构模板", groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "测试用户" }] }] },
          profile: { values: {}, family: [], custom: [] }, profileRevision: 1 } };
        if (message.type === "DESKTOP_RESUME_FILES_LIST") return { status: "ok", files };
        if (message.type === "DESKTOP_RESUME_FILES_GRANT") return { status: "ok" };
        return { status: "ok" };
      },
      openOptionsPage() {}
    },
    storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } },
    tabs: {
      query: async () => [state.tab],
      sendMessage: async (tabId, message) => {
        calls.push({ to: "page", tabId, message: JSON.parse(JSON.stringify(message)) });
        if (message.type === "RESUME_PANEL_STATUS") return JSON.parse(JSON.stringify(state.status));
        if (message.type === "RESUME_PANEL_TARGET") return { ok: true, targetAvailable: false };
        return { ok: true };
      },
      create: async () => {},
      onActivated: { addListener() {} },
      onUpdated: { addListener(listener) { updated = listener; } }
    }
  };
  w.navigator.clipboard = { writeText: async () => {} };
  for (const file of SCRIPTS) w.eval(fs.readFileSync(path.join(ROOT, file), "utf8"));
  await flush();
  const get = (id) => w.document.getElementById(id);
  return {
    w, calls, state, get,
    poll: async () => { updated?.(state.tab.id, { status: "complete" }); await flush(); },
    rows: () => [...get("upload-rows").querySelectorAll(".upload-row")].map((row) => ({
      title: row.querySelector(".upload-row__title")?.textContent,
      chosen: row.querySelector("select")?.value ?? null,
      options: [...row.querySelectorAll("option")].map((option) => option.textContent),
      note: row.querySelector(".upload-row__note")?.textContent || ""
    })),
    pageCalls: (type) => calls.filter((call) => call.to === "page" && call.message.type === type).map((call) => call.message),
    workerCalls: (type) => calls.filter((call) => call.to === "worker" && call.message.type === type).map((call) => call.message)
  };
}

test("the card lists the site, each box with the file the page suggests, and what will be put back", async (t) => {
  const p = await openPanel(t);
  await p.poll();
  assert.equal(p.get("task-panel").hidden, false);
  assert.equal(p.get("task-flow-upload").hidden, false);
  assert.equal(p.get("task-title").textContent, "上传文件到网页");
  assert.equal(p.get("upload-site").textContent, "上传到 app.mokahr.com");
  assert.deepEqual(p.rows(), [
    { title: "简历附件", chosen: "r1", options: ["不传", "测试用户_简历.pdf（1.2 MB） · 中文", "Test_Resume.pdf（88 KB） · 英文"], note: "" },
    { title: "证件照", chosen: "p1", options: ["不传", "证件照.jpg（85 KB） · 蓝底一寸"], note: "" },
    { title: "作品集", chosen: "", options: ["不传", "测试用户_简历.pdf（1.2 MB） · 中文", "Test_Resume.pdf（88 KB） · 英文", "证件照.jpg（85 KB） · 蓝底一寸"],
      note: "不是简历附件、证件照或成绩单，默认不传。" }
  ]);
  assert.deepEqual([...p.get("upload-notes").querySelectorAll("li")].map((item) => item.textContent), [
    "Moka上传简历后会重新解析：先传简历，等解析完再填写，最后传其他文件。",
    "上传后网站会重新解析，已填的 2 项会改回：兴趣爱好、期望城市；表单被网站重排时可能改不回，改不回的会列出来。"
  ]);
  assert.equal(p.get("upload-confirm").textContent, "上传并填写");
  assert.equal(p.get("upload-confirm").disabled, false);
  assert.equal(p.workerCalls("DESKTOP_RESUME_FILES_GRANT").length, 0, "nothing is granted by showing the card");
});

test("上传并填写 first tells the worker this tab, this site and only the chosen files, then starts the page", async (t) => {
  const p = await openPanel(t);
  await p.poll();
  const photo = p.get("upload-rows").querySelector('select[data-upload-slot="upload-1"]');
  photo.value = "";
  photo.dispatchEvent(new p.w.Event("change", { bubbles: true }));
  await flush();
  p.get("upload-confirm").click();
  await flush();
  assert.deepEqual(p.workerCalls("DESKTOP_RESUME_FILES_GRANT"), [{ type: "DESKTOP_RESUME_FILES_GRANT", tabId: 7, origin: "https://app.mokahr.com",
    files: [{ fileId: "r1", sha256: SHA("a") }] }]);
  assert.deepEqual(p.pageCalls("RESUME_PANEL_UPLOAD"), [{ type: "RESUME_PANEL_UPLOAD", action: "confirm", version: 3, epoch: "e1",
    choices: [{ slot: "upload-0", fileId: "r1" }] }]);
  const order = p.calls.filter((call) => ["DESKTOP_RESUME_FILES_GRANT", "RESUME_PANEL_UPLOAD"].includes(call.message.type)).map((call) => call.message.type);
  assert.deepEqual(order, ["DESKTOP_RESUME_FILES_GRANT", "RESUME_PANEL_UPLOAD"]);
});

test("只填写 and 取消 never grant a file", async (t) => {
  const p = await openPanel(t);
  await p.poll();
  p.get("upload-fill").click();
  await flush();
  p.get("upload-cancel").click();
  await flush();
  assert.deepEqual(p.pageCalls("RESUME_PANEL_UPLOAD").map((message) => message.action), ["fill", "cancel"]);
  assert.equal(p.workerCalls("DESKTOP_RESUME_FILES_GRANT").length, 0);
});

test("a card for another site than the tab shows is not drawn and cannot be confirmed", async (t) => {
  const p = await openPanel(t, { tabUrl: "https://evil.example.test/apply" });
  await p.poll();
  assert.equal(p.get("task-flow-upload").hidden, true);
  assert.equal(p.get("task-panel").hidden, true);
  p.get("upload-confirm").click();
  await flush();
  assert.equal(p.workerCalls("DESKTOP_RESUME_FILES_GRANT").length, 0);
  assert.equal(p.pageCalls("RESUME_PANEL_UPLOAD").length, 0);
});

test("a box with nothing on the desktop says so and offers the desktop page; a card from a parse that was cut short offers 改回并填写", async (t) => {
  const p = await openPanel(t, { files: [FILES[0]], upload: { ...OFFER, slots: [
    { id: "upload-0", title: "简历附件", kind: "resume", reason: "has_file", fileId: "", accept: "", limit: 10485760, siteLimit: null },
    { id: "upload-1", title: "证件照", kind: "photo", reason: "no_file", fileId: "", accept: "image/*", limit: 10485760, siteLimit: null }],
  restore: { count: 1, labels: ["兴趣爱好"], pending: true } } });
  await p.poll();
  assert.deepEqual(p.rows().map((row) => [row.title, row.chosen, row.note]), [
    ["简历附件", null, "已经有文件了，不替换。"], ["证件照", null, "桌面里还没有证件照。打开桌面简历资料"]]);
  assert.equal(p.get("upload-confirm").textContent, "改回并填写");
  assert.equal(p.get("upload-confirm").disabled, false);
  p.get("upload-rows").querySelector("[data-upload-open]").click();
  await flush();
  assert.deepEqual(p.workerCalls("DESKTOP_OPEN_VIEW"), [{ type: "DESKTOP_OPEN_VIEW", view: "resume" }]);
  p.get("upload-confirm").click();
  await flush();
  assert.equal(p.workerCalls("DESKTOP_RESUME_FILES_GRANT").length, 0, "nothing to upload, nothing to grant");
  assert.deepEqual(p.pageCalls("RESUME_PANEL_UPLOAD").map((message) => [message.action, message.choices]), [["confirm", []]]);
});

test("while uploading the stop button says 停止上传; afterwards the result lists each box and goes away on 知道了", async (t) => {
  const p = await openPanel(t, { upload: { phase: "running", version: 3, epoch: "e1" } });
  p.state.status = { ready: true, busy: true, phase: "正在等网站解析简历，大约 12 秒（已等 4 秒）…", canCancel: true, cancelLabel: "停止上传", upload: { phase: "running", version: 3, epoch: "e1" } };
  await p.poll();
  assert.equal(p.get("cancel-button").hidden, false);
  assert.equal(p.get("cancel-button").textContent, "停止上传");
  assert.equal(p.get("fill-progress-phase").textContent, "正在等网站解析简历，大约 12 秒（已等 4 秒）…");
  assert.equal(p.get("task-panel").hidden, true);
  p.state.status = { ready: true, busy: false, upload: { phase: "done", version: 3, epoch: "e1", tone: "warn",
    lines: ["简历附件：已上传 测试用户_简历.pdf。", "证件照：传了 证件照.jpg，没确认网站收到，请看一下网页。", 42], addFiles: false } };
  await p.poll();
  assert.equal(p.get("cancel-button").hidden, true);
  assert.equal(p.get("upload-result").hidden, false);
  assert.equal(p.get("upload-result").className, "upload-result is-warn");
  assert.deepEqual([...p.get("upload-result-list").querySelectorAll("li")].map((item) => item.textContent),
    ["简历附件：已上传 测试用户_简历.pdf。", "证件照：传了 证件照.jpg，没确认网站收到，请看一下网页。"]);
  assert.equal(p.get("upload-result-open").hidden, true);
  p.get("upload-result-dismiss").click();
  await flush();
  assert.deepEqual(p.pageCalls("RESUME_PANEL_UPLOAD").map((message) => message.action), ["dismiss"]);
});

test("anything off-shape from the page is dropped rather than drawn", async (t) => {
  const p = await openPanel(t, { upload: { ...OFFER, epoch: "", slots: OFFER.slots } });
  await p.poll();
  assert.equal(p.get("task-flow-upload").hidden, true, "no epoch, no card");
  p.state.status = { ready: true, upload: { ...OFFER, slots: [{ id: "<img src=x>", title: "x", kind: "resume" }, { ...OFFER.slots[0], title: "<b>简历</b>".repeat(30) }] } };
  await p.poll();
  const rows = p.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title.length, 80);
  assert.equal(p.get("upload-rows").querySelector("b"), null, "page text is never markup");
});

test("when the page turns the card down, the yes given to the worker is taken back", async (t) => {
  const p = await openPanel(t);
  await p.poll();
  const send = p.w.chrome.tabs.sendMessage;
  p.w.chrome.tabs.sendMessage = async (tabId, message) => message.type === "RESUME_PANEL_UPLOAD"
    ? { ok: false, error: "这张卡片已经过期，请重新点一键填写。" } : send(tabId, message);
  p.get("upload-confirm").click();
  await flush();
  assert.deepEqual(p.workerCalls("DESKTOP_RESUME_FILES_GRANT").length, 1);
  assert.deepEqual(p.workerCalls("DESKTOP_RESUME_FILES_REVOKE"), [{ type: "DESKTOP_RESUME_FILES_REVOKE", tabId: 7 }]);
  assert.equal(p.get("panel-toast").textContent, "这张卡片已经过期，请重新点一键填写。");
});
