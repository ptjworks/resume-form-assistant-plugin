// #429 第 4 项：网页上的上传框。结构照真组件写（antd 5 Upload、Element UI el-upload、原生 file 框），只有虚构的值。
const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const slots = require("../upload-slots.js");
const scan = require("../field-scan.js");

const hidden = el => Boolean(el.closest("[hidden], [style*='display: none'], [style*='display:none']"));
const isVisible = el => !hidden(el);
const page = (html, url = "https://jobs.example.test/apply") => new JSDOM(`<body><form>${html}</form></body>`, { url }).window.document;
const describe = (input, root, uploads) => scan.uploadItem(input, root, { isVisible, uploads });
const found = doc => slots.find(doc, { isVisible, describe });

const antd = ({ id, title, accept = "", extra = "", list = "", picture = false }) => `
  <div class="ant-form-item"><div class="ant-row ant-form-item-row">
    <div class="ant-col ant-form-item-label"><label for="${id}" title="${title}">${title}</label></div>
    <div class="ant-col ant-form-item-control"><div class="ant-form-item-control-input"><div class="ant-form-item-control-input-content">
      <span class="ant-upload-wrapper${picture ? " ant-upload-picture-card-wrapper" : ""}">
        <div class="ant-upload ant-upload-select${picture ? " ant-upload-select-picture-card" : ""}"><span tabindex="0" class="ant-upload" role="button">
          <input id="${id}" type="file" accept="${accept}" style="display: none;"><button type="button" class="ant-btn"><span>上传文件</span></button>
        </span></div>
        <div class="ant-upload-list ant-upload-list-text">${list}</div>
      </span></div></div>
      ${extra ? `<div class="ant-form-item-extra">${extra}</div>` : ""}
    </div></div></div>`;
const element = ({ id, title, accept = "", tip = "", picture = false, list = "" }) => `
  <div class="el-form-item"><label class="el-form-item__label">${title}</label><div class="el-form-item__content"><div>
    <div tabindex="0" class="el-upload ${picture ? "el-upload--picture-card" : "el-upload--text"}"><button type="button" class="el-button">点击上传</button>
      <input id="${id}" type="file" name="file" accept="${accept}" class="el-upload__input" style="display: none;"></div>
    ${tip ? `<div class="el-upload__tip">${tip}</div>` : ""}
    <ul class="el-upload-list ${picture ? "el-upload-list--picture-card" : "el-upload-list--text"}">${list}</ul>
  </div></div></div>`;

const FILES = [
  { fileId: "r1", kind: "resume", name: "测试用户_简历.pdf", label: "中文", mime: "application/pdf", byteSize: 120000, sha256: "a".repeat(64), isDefault: true, templateIds: [] },
  { fileId: "r2", kind: "resume", name: "Test_Resume.pdf", label: "英文", mime: "application/pdf", byteSize: 90000, sha256: "b".repeat(64), isDefault: false, templateIds: [] },
  { fileId: "p1", kind: "photo", name: "证件照.jpg", label: "蓝底一寸", mime: "image/jpeg", byteSize: 85000, sha256: "c".repeat(64), isDefault: true, templateIds: [] },
  { fileId: "t1", kind: "transcript", name: "成绩单.pdf", label: "", mime: "application/pdf", byteSize: 3 * 1024 * 1024, sha256: "d".repeat(64), isDefault: true, templateIds: [] }
];

test("a box is known by its title first, then its button and hint; anything named alongside a certificate or ID is not uploaded", () => {
  const kind = (title, texts = [], accept = "", picture = false) => slots.classify({ title, texts, accept, picture });
  assert.deepEqual(kind("简历附件"), { kind: "resume", reason: "" });
  assert.deepEqual(kind("附件简历"), { kind: "resume", reason: "" });
  assert.deepEqual(kind("Resume / CV"), { kind: "resume", reason: "" });
  assert.deepEqual(kind("证件照"), { kind: "photo", reason: "" });
  assert.deepEqual(kind("一寸免冠照片"), { kind: "photo", reason: "" });
  assert.deepEqual(kind("个人照片", [], "image/*"), { kind: "photo", reason: "" });
  assert.deepEqual(kind("成绩单"), { kind: "transcript", reason: "" });
  // 证件、证书、作品这类不传，和照片这样的词一起出现也一样。
  for (const title of ["身份证照片", "学生证扫描件", "获奖证书", "作品集", "毕业证书", "生活照", "推荐信"]) {
    assert.equal(kind(title).kind, "other", title);
  }
  // 题目说不清：看按钮和提示。
  assert.deepEqual(kind("附件", ["上传简历"]), { kind: "resume", reason: "" });
  assert.deepEqual(kind("", ["请上传一寸照片"], "image/*"), { kind: "photo", reason: "" });
  assert.deepEqual(kind("附件", ["点击上传"]), { kind: "unknown", reason: "unknown_kind" });
  // 一个框说中两类：认不准。
  assert.deepEqual(kind("简历及照片"), { kind: "unknown", reason: "ambiguous_kind" });
  assert.deepEqual(kind("附件", ["上传简历", "上传照片"]), { kind: "unknown", reason: "ambiguous_kind" });
  // 收的文件类型对不上：只收图片的框不传简历，只收 PDF 的框不传照片；照片墙要简历的也不传。
  assert.deepEqual(kind("简历", [], "image/*"), { kind: "unknown", reason: "accept_mismatch" });
  assert.deepEqual(kind("证件照", [], ".pdf"), { kind: "unknown", reason: "accept_mismatch" });
  assert.deepEqual(kind("简历", [], "", true), { kind: "unknown", reason: "style_mismatch" });
  assert.deepEqual(kind("证件照", [], "", true), { kind: "photo", reason: "" });
});

test("a size limit is read from the site's own words; numbers that are not a limit are not", () => {
  const KB = 1024, MB = 1024 * 1024;
  assert.equal(slots.limitBytes(["支持 PDF、Word，不超过 5MB"]), 5 * MB);
  assert.equal(slots.limitBytes(["只能上传jpg/png文件，且不超过500kb"]), 500 * KB);
  assert.equal(slots.limitBytes(["文件小于2M"]), 2 * MB);
  assert.equal(slots.limitBytes(["大小限制：10M"]), 10 * MB);
  assert.equal(slots.limitBytes(["1MB以内"]), 1 * MB);
  assert.equal(slots.limitBytes(["max 2MB"]), 2 * MB);
  assert.equal(slots.limitBytes(["不超过 5MB", "照片不超过 200K"]), 200 * KB, "the smallest limit wins");
  for (const text of ["支持 pdf 格式", "最多上传 3 个文件", "建议尺寸 295×413", "简历 2M"]) assert.equal(slots.limitBytes([text]), null, text);
});

test("accept is read as browsers read it", () => {
  assert.equal(slots.accepts("", "application/pdf"), true);
  assert.equal(slots.accepts(".pdf,.doc,.docx", "application/pdf", "a.pdf"), true);
  assert.equal(slots.accepts(".pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx"), false);
  assert.equal(slots.accepts("image/*", "image/png"), true);
  assert.equal(slots.accepts("image/*", "application/pdf"), false);
  assert.equal(slots.accepts("image/jpeg, image/png", "image/jpeg"), true);
  assert.equal(slots.accepts("pdf,jpg", "image/jpeg", "a.jpg"), true, "an extension written without the dot");
});

test("the boxes on an antd 5 and an Element UI form are found with their titles, kinds and limits", () => {
  const doc = page(`
    <div class="ant-form-item"><div class="ant-form-item-label"><label for="name">姓名</label></div><input id="name"></div>
    ${antd({ id: "resume", title: "简历附件", accept: ".pdf,.doc,.docx", extra: "支持 PDF、Word，不超过 5MB" })}
    ${element({ id: "photo", title: "个人照片", accept: "image/*", tip: "只能上传jpg/png文件，且不超过500kb", picture: true })}
    ${antd({ id: "works", title: "作品集" })}
    ${element({ id: "misc", title: "其他附件" })}`);
  const list = found(doc);
  assert.deepEqual(list.map(slot => [slot.input.id, slot.title, slot.kind, slot.reason, slot.limit]), [
    ["resume", "简历附件", "resume", "", 5 * 1024 * 1024],
    ["photo", "个人照片", "photo", "", 500 * 1024],
    ["works", "作品集", "other", "other_kind", 10 * 1024 * 1024],
    ["misc", "其他附件", "unknown", "unknown_kind", 10 * 1024 * 1024]
  ]);
  assert.equal(list[0].root.className, "ant-upload-wrapper");
  assert.equal(list[1].picture, true);
});

test("two boxes side by side do not take each other's title; hidden, disabled and folder boxes are skipped", () => {
  const doc = page(`
    <div class="uploads"><p>中文简历</p><div class="x-upload"><input id="zh" type="file" style="display:none"><span>选择文件</span></div>
      <p>英文简历</p><div class="x-upload"><input id="en" type="file" style="display:none"><span>选择文件</span></div></div>
    <div hidden>${antd({ id: "folded", title: "简历附件" })}</div>
    <label>证明材料 <input id="off" type="file" disabled></label>
    <label>文件夹 <input id="dir" type="file" webkitdirectory></label>
    <div id="resume-pro-sidebar"><input id="ours" type="file"></div>`);
  const list = slots.find(doc, { isVisible, describe, exclude: el => Boolean(el.closest("#resume-pro-sidebar")) });
  assert.deepEqual(list.map(slot => [slot.input.id, slot.title, slot.language]), [["zh", "中文简历", ["zh"]], ["en", "英文简历", ["en"]]]);
});

test("a native file box and one hidden behind a button of its own are both found", () => {
  const doc = page(`
    <div class="row"><label for="cv">个人简历</label><input id="cv" type="file" accept=".pdf"></div>
    <div class="row"><span class="title">证件照</span><label class="btn">选择图片<input id="pic" type="file" accept="image/png,image/jpeg" hidden></label></div>`);
  assert.deepEqual(found(doc).map(slot => [slot.input.id, slot.kind, slot.root.tagName]), [["cv", "resume", "INPUT"], ["pic", "photo", "LABEL"]]);
});

test("a box that already holds a file is seen as taken", () => {
  const doc = page(`
    ${antd({ id: "a", title: "简历附件", list: `<div class="ant-upload-list-item-container"><div class="ant-upload-list-item ant-upload-list-item-done"><span class="ant-upload-list-item-name" title="测试用户_简历.pdf">测试用户_简历.pdf</span></div></div>` })}
    ${element({ id: "b", title: "证件照", accept: "image/*", picture: true, list: `<li class="el-upload-list__item is-success"><img class="el-upload-list__item-thumbnail" src="blob:https://jobs.example.test/1"></li>` })}
    <div class="row"><span>成绩单</span><div class="x-upload"><input id="c" type="file" style="display:none"><span>上传</span></div><span class="file">成绩单.pdf</span></div>
    ${antd({ id: "d", title: "证件照", extra: "支持 .jpg .png 格式" })}`);
  assert.deepEqual(found(doc).map(slot => [slot.input.id, slot.hasFile]), [["a", true], ["b", true], ["c", true], ["d", false]]);
});

test("a file is picked by template, then the default, then the only one; otherwise the user picks", () => {
  const slot = (kind, extra = {}) => ({ kind, reason: "", accept: "", limit: 10 * 1024 * 1024, language: [], ...extra });
  assert.deepEqual(slots.chooseFile(slot("resume"), FILES), { fileId: "r1", reason: "" }, "the default one");
  const bound = FILES.map(file => file.fileId === "r2" ? { ...file, templateIds: ["t-en"] } : file);
  assert.deepEqual(slots.chooseFile(slot("resume"), bound, { templateId: "t-en" }), { fileId: "r2", reason: "" }, "bound to this template");
  assert.deepEqual(slots.chooseFile(slot("resume"), bound, { templateId: "t-zh" }), { fileId: "r1", reason: "" }, "a file bound to another template is not used");
  const noDefault = FILES.map(file => ({ ...file, isDefault: false }));
  assert.deepEqual(slots.chooseFile(slot("resume"), noDefault), { fileId: null, reason: "choose" });
  assert.deepEqual(slots.chooseFile(slot("photo"), noDefault), { fileId: "p1", reason: "" }, "the only photo");
  assert.deepEqual(slots.chooseFile(slot("resume", { language: ["en"] }), FILES), { fileId: "r2", reason: "" }, "an English box takes the English one");
  assert.deepEqual(slots.chooseFile(slot("transcript", { limit: 2 * 1024 * 1024 }), FILES), { fileId: null, reason: "too_large", byteSize: 3 * 1024 * 1024 });
  assert.deepEqual(slots.chooseFile(slot("resume", { accept: "image/*" }), FILES), { fileId: null, reason: "not_accepted" });
  assert.deepEqual(slots.chooseFile(slot("photo"), FILES.filter(file => file.kind !== "photo")), { fileId: null, reason: "no_file" });
  assert.deepEqual(slots.chooseFile(slot("other", { reason: "other_kind" }), FILES), { fileId: null, reason: "other_kind" });
  assert.deepEqual(slots.chooseFile(slot("unknown", { reason: "unknown_kind" }), FILES), { fileId: null, reason: "unknown_kind" });
  assert.equal(slots.fits(slot("unknown", { accept: ".pdf" }), FILES[0]), true);
  assert.equal(slots.fits(slot("unknown", { accept: ".pdf" }), FILES[2]), false);
});

test("a file is put into the box as a picked file: input.files is set, then input and change are fired", () => {
  const dom = new JSDOM(`<body><input id="f" type="file"></body>`);
  const w = dom.window;
  w.DataTransfer = class {
    constructor() { this.list = []; this.items = { add: file => this.list.push(file) }; }
    get files() { return Object.assign([...this.list], { item: index => this.list[index] }); }
  };
  const input = w.document.getElementById("f");
  // jsdom 的 files 只收它自己的 FileList，造不出来：换成普通的存取。
  let picked = [];
  Object.defineProperty(input, "files", { configurable: true, get: () => picked, set: (value) => { picked = value; } });
  const events = [];
  for (const type of ["input", "change"]) input.addEventListener(type, () => events.push([type, input.files[0]?.name]));
  const file = new w.File(["x"], "测试用户_简历.pdf", { type: "application/pdf" });
  assert.deepEqual(slots.put({ input }, file), { ok: true });
  assert.deepEqual(events, [["input", "测试用户_简历.pdf"], ["change", "测试用户_简历.pdf"]]);
  input.remove();
  assert.deepEqual(slots.put({ input }, file), { ok: false, reason: "slot_gone" });
});

test("what the site did with the file: a done or failed list item, an error message, or a dialog", () => {
  const doc = page(`${antd({ id: "a", title: "简历附件" })}<div class="ant-message"></div>`);
  const [slot] = found(doc);
  const docs = [doc];
  const seen = slots.before(slot, docs, isVisible);
  const list = slot.scope.querySelector(".ant-upload-list");
  assert.equal(slots.state(slot, "测试用户_简历.pdf", seen, docs, isVisible).state, "none");
  list.innerHTML = `<div class="ant-upload-list-item ant-upload-list-item-uploading"><span title="测试用户_简历.pdf">测试用户_简历.pdf</span><div class="ant-progress" role="progressbar"></div></div>`;
  assert.equal(slots.state(slot, "测试用户_简历.pdf", seen, docs, isVisible).state, "uploading");
  list.innerHTML = `<div class="ant-upload-list-item ant-upload-list-item-done"><span title="测试用户_简历.pdf">测试用户_简历.pdf</span></div>`;
  assert.equal(slots.state(slot, "测试用户_简历.pdf", seen, docs, isVisible).state, "done");
  list.innerHTML = `<div class="ant-upload-list-item ant-upload-list-item-error"><span title="测试用户_简历.pdf">测试用户_简历.pdf</span></div>`;
  doc.querySelector(".ant-message").innerHTML = `<div class="ant-message-notice"><span>文件大小不能超过 2MB</span></div>`;
  assert.deepEqual(slots.state(slot, "测试用户_简历.pdf", seen, docs, isVisible), { state: "error", message: "文件大小不能超过 2MB" });
  list.innerHTML = "";
  assert.deepEqual(slots.state(slot, "测试用户_简历.pdf", seen, docs, isVisible), { state: "error", message: "文件大小不能超过 2MB" },
    "Element drops a refused file from its list; the message is what is left");
  doc.querySelector(".ant-message").innerHTML = "";
  doc.body.insertAdjacentHTML("beforeend", `<div class="ant-modal" role="dialog"><div class="ant-modal-body">是否用简历内容覆盖已填写的信息？</div><button>覆盖</button><button>取消</button></div>`);
  assert.deepEqual(slots.state(slot, "测试用户_简历.pdf", seen, docs, isVisible), { state: "dialog", message: "是否用简历内容覆盖已填写的信息？覆盖取消" });
});

test("busy: a spinner, a loading mask or a short 'parsing' line, never the panel's own text", () => {
  const doc = page(`<div id="x"></div><div id="resume-pro-sidebar"><span>正在上传…</span></div>`);
  const exclude = el => Boolean(el.closest("#resume-pro-sidebar"));
  assert.equal(slots.busy([doc], isVisible, exclude), false);
  doc.getElementById("x").innerHTML = `<div class="ant-spin ant-spin-spinning"></div>`;
  assert.equal(slots.busy([doc], isVisible, exclude), true);
  doc.getElementById("x").innerHTML = `<p>简历解析中，请稍候</p>`;
  assert.equal(slots.busy([doc], isVisible, exclude), true);
  doc.getElementById("x").innerHTML = `<p hidden>简历解析中</p><p>我们会在解析中保留你的信息，提交前请检查各项内容是否正确无误。</p>`;
  assert.equal(slots.busy([doc], isVisible, exclude), false, "a hidden line and a long paragraph do not count");
});

function clock() {
  let time = 0;
  return { now: () => time, sleep: async (ms) => { time += ms; }, at: () => time };
}

test("waiting for the parse: a known platform waits its minimum even when the form goes quiet", async () => {
  const c = clock();
  const reads = [];
  const read = () => {
    reads.push(c.at());
    // 1 秒时传完，3 秒时网站改了表单，之后不再变。
    return { signature: c.at() >= 3000 ? "parsed" : "before", busy: false, upload: c.at() >= 1000 ? "done" : "uploading" };
  };
  const result = await slots.waitForParse(read, { ...c, minMs: 12000, quietMs: 2000, maxMs: 60000, extendMs: 60000, earlyOnChange: false });
  assert.equal(result.status, "done");
  assert.equal(result.changed, true);
  assert.equal(result.elapsed, 12000);
});

test("waiting for the parse: a known platform may end early once the page was busy after the upload and then went quiet", async () => {
  const c = clock();
  const read = () => ({ signature: c.at() >= 5000 ? "parsed" : "before",
    busy: c.at() >= 2000 && c.at() < 5000, upload: c.at() >= 1000 ? "done" : "uploading" });
  const result = await slots.waitForParse(read, { ...c, minMs: 25000, quietMs: 2000, maxMs: 60000 });
  assert.deepEqual([result.status, result.elapsed], ["done", 7000]);
});

test("the upload's own progress bar is not a sign the parse is over", async () => {
  const c = clock();
  const read = () => ({ signature: "same", busy: c.at() < 1000, upload: c.at() < 1000 ? "uploading" : "done" });
  const result = await slots.waitForParse(read, { ...c, minMs: 12000, quietMs: 2000, maxMs: 60000 });
  assert.deepEqual([result.status, result.elapsed], ["done", 12000]);
});

test("waiting for the parse stops on a dialog, a failed upload, a stop, and at the limit", async () => {
  let c = clock();
  let result = await slots.waitForParse(() => ({ signature: "s", busy: false, upload: "done", dialog: c.at() >= 4000 ? "是否覆盖已填写的信息？" : "" }), { ...c, minMs: 12000 });
  assert.deepEqual([result.status, result.text, result.elapsed], ["dialog", "是否覆盖已填写的信息？", 4000]);
  c = clock();
  result = await slots.waitForParse(() => ({ signature: "s", busy: false, upload: c.at() >= 600 ? "error" : "uploading" }), { ...c, minMs: 12000 });
  assert.deepEqual([result.status, result.elapsed], ["upload_failed", 600]);
  c = clock();
  result = await slots.waitForParse(() => ({ signature: "s", busy: false, upload: "done" }), { ...c, minMs: 12000, stopped: () => c.at() >= 1000 });
  assert.deepEqual([result.status, result.elapsed], ["stopped", 1000]);
  c = clock();
  result = await slots.waitForParse(() => ({ signature: "s", busy: true, upload: "done" }), { ...c, minMs: 25000, maxMs: 60000 });
  assert.deepEqual([result.status, result.elapsed, result.busy], ["timeout", 60000, true]);
});

test("waiting on a site that is not known to parse: quiet for 1.5 s is enough; a change ends it early and stretches the limit", async () => {
  let c = clock();
  let result = await slots.waitForParse(() => ({ signature: "s", busy: false, upload: "done" }), { ...c, minMs: 1000, quietMs: 1500, maxMs: 10000, extendMs: 15000, earlyOnChange: true });
  assert.deepEqual([result.status, result.elapsed, result.changed], ["done", 1600, false]);
  c = clock();
  // 值一直在变到 12 秒：比 10 秒的上限晚，因为变过，上限放宽到 15 秒。
  result = await slots.waitForParse(() => ({ signature: String(Math.min(c.at(), 12000)), busy: false, upload: "done" }),
    { ...c, minMs: 1000, quietMs: 1500, maxMs: 10000, extendMs: 15000, earlyOnChange: true });
  assert.deepEqual([result.status, result.elapsed, result.changed], ["done", 13600, true]);
});
