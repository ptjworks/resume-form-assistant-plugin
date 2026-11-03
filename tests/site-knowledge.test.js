// #429 第十项：招聘平台的已知行为（上传简历后会覆盖已填内容、字数按字节算）和文本框的字数上限。
// 字数统计的结构照真组件写：antd 4 带 showCount 的多行文本没有 maxlength，上限在外层的 data-count；antd 5 只设 count.max 的输入框
// 只有「0 / 10」；Element 的 show-word-limit 是 el-input__count。只有虚构的值。
const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const knowledge = require("../site-knowledge.js");

const page = (html = "") => new JSDOM(`<body>${html}</body>`).window.document;
const id = (doc, href) => knowledge.detect(doc, href)?.id || null;

test("platforms are known by their own hosts, and the old Beisen portal and 51job's new forms are not", () => {
  const doc = page();
  assert.equal(id(doc, "https://app.mokahr.com/campus_apply/example/123"), "moka");
  assert.equal(id(doc, "https://example.jobs.feishu.cn/campus/position/1/apply"), "feishu");
  assert.equal(id(doc, "https://example.zhiye.com/campus/jobs/form?jobAdId=1"), "beisen");
  assert.equal(id(doc, "https://example.italent.cn/portal/apply"), "beisen");
  assert.equal(id(doc, "https://campus.dayee.com/apply"), "dayee");
  assert.equal(id(doc, "https://careers.ctrip.com/index.html"), "ctrip");
  // 北森旧版门户的解析只截短专业名，不提示。
  assert.equal(id(doc, "https://example.zhiye.com/Portal/Apply/Index"), null);
  assert.equal(id(doc, "https://example.zhiye.com/campusxq/apply"), null);
  // 旧版是 IIS 站点，路径不分大小写，Portal 后面不带斜杠也算。
  assert.equal(id(doc, "https://example.zhiye.com/portal/apply"), null);
  assert.equal(id(doc, "https://example.zhiye.com/Portal"), null);
  assert.equal(id(doc, "https://example.zhiye.com/portals/apply"), "beisen");
  assert.equal(id(doc, "https://xyz.51job.com/External/Apply.aspx"), "51job-classic");
  assert.equal(id(doc, "https://xyz.51job.com/consumer/apply"), null);
  assert.equal(id(doc, "https://q.yingjiesheng.com/resume"), "yingjiesheng");
  assert.equal(id(doc, "https://jobs.example.test/apply"), null);
  assert.equal(id(doc, "not a url"), null);
});

test("Moka, Feishu and Beisen on a company's own domain are known by their page features, one feature alone is not enough", () => {
  const href = "https://careers.example.test/apply";
  assert.equal(id(page(`<div class="apply-field-name"><div class="sd-Select-container"></div></div>`), href), "moka");
  assert.equal(id(page(`<script>window._MOKA_ENV_ = {}</script>`), href), "moka");
  assert.equal(id(page(`<div class="ud-formily-item" data-form-field-id="f1"></div>`), href), "feishu");
  assert.equal(id(page(`<div class="form-item form-item--phoenix"><div class="phoenix-select"></div></div>`), href), "beisen");
  for (const html of [`<div class="apply-field-name"></div>`, `<div class="ud-formily-item"></div>`, `<div class="phoenix-select"></div>`,
    `<script src="/static/_MOKA_ENV_.js"></script>`, `<p>_MOKA_ENV_</p>`]) {
    assert.equal(id(page(html), href), null, html);
  }
});

test("only the platforms whose resume upload overwrites the form get a hint", () => {
  const moka = knowledge.detect(page(), "https://app.mokahr.com/apply");
  assert.equal(knowledge.uploadHint(moka), "Moka 上传简历后会重新解析并覆盖已填内容，请先上传简历再填写。");
  assert.equal(knowledge.uploadHint(knowledge.detect(page(), "https://x.jobs.feishu.cn/apply")), "飞书招聘上传简历后会重新解析并覆盖已填内容，请先上传简历再填写。");
  assert.equal(knowledge.uploadHint(knowledge.detect(page(), "https://xyz.51job.com/a/Apply.aspx")), "");
  assert.equal(knowledge.uploadHint(null), "");
  assert.deepEqual(knowledge.platforms.filter((item) => item.overwrites).map((item) => item.id), ["moka", "feishu", "beisen", "dayee", "ctrip"]);
  assert.deepEqual(knowledge.platforms.filter((item) => item.bytes).map((item) => item.id), ["51job-classic", "yingjiesheng"]);
});

test("whether a site counts bytes is read from its address alone", () => {
  assert.equal(knowledge.countsBytes("https://xyz.51job.com/External/Apply.aspx"), true);
  assert.equal(knowledge.countsBytes("https://young.yingjiesheng.com/resume"), true);
  assert.equal(knowledge.countsBytes("https://xyz.51job.com/consumer/apply"), false);
  assert.equal(knowledge.countsBytes("https://app.mokahr.com/apply"), false);
  assert.equal(knowledge.countsBytes("about:blank"), false);
});

test("length counts characters, or bytes with a Chinese character as 2", () => {
  assert.equal(knowledge.measure("示例大学 A1"), 7);
  assert.equal(knowledge.measure("示例大学 A1", true), 11);
  assert.equal(knowledge.measure("", true), 0);
  assert.equal(knowledge.measure("é", true), 1, "Latin-1 letters count 1");
  // emoji 在 JavaScript 里占两个码元：按字节的站点算一个字、2 字节；按字符和浏览器的 maxlength 一样算 2。
  assert.equal(knowledge.measure("😀", true), 2);
  assert.equal(knowledge.measure("示例😀A", true), 7);
  assert.equal(knowledge.measure("😀"), 2);
});

test("a box's limit is its maxlength, or the component's own counter when it has none", () => {
  const doc = page(`
    <input id="native" maxlength="8">
    <div class="ant-input-textarea ant-input-textarea-show-count" data-count="0 / 20"><textarea id="antd4"></textarea></div>
    <span class="ant-input-affix-wrapper"><input id="antd5"><span class="ant-input-suffix"><span class="ant-input-show-count-suffix">3 / 10</span></span></span>
    <div class="el-textarea"><textarea id="element" maxlength="20"></textarea><span class="el-input__count">0/20</span></div>
    <div class="row"><input id="plain"></div>
    <div class="pair"><input id="first"><input id="second"><span class="count">0 / 5</span></div>
    <div class="row"><input id="account"><span class="account-count">共 3 项</span></div>`);
  const limit = (name) => knowledge.limitOf(doc.getElementById(name));
  assert.equal(limit("native"), 8);
  assert.equal(limit("antd4"), 20);
  assert.equal(limit("antd5"), 10);
  assert.equal(limit("element"), 20);
  assert.equal(limit("plain"), null);
  assert.equal(limit("first"), null, "a counter shared by two boxes is not this box's");
  assert.equal(limit("account"), null, "only a counter written as n / max counts");
  assert.equal(knowledge.limitOf(doc.createElement("select")), null);
});

test("only text-like boxes take maxlength, and only a component's own counter counts", () => {
  const doc = page(`
    <input id="number" type="number" maxlength="4"><input id="date" type="date" maxlength="4">
    <input id="email" type="email" maxlength="30"><input id="tel" type="tel" maxlength="11">
    <div class="field"><input id="paged"><span class="page-count">1 / 3</span></div>
    <div class="field"><input id="stepped"><div class="steps-count">2/5</div></div>
    <div class="field" data-count="1 / 3"><input id="data"></div>
    <div class="arco-input-group-wrapper"><input id="arco"><span class="arco-input-word-limit">0/30</span></div>
    <div class="van-field"><textarea id="vant"></textarea><div class="van-field__word-limit">0/200</div></div>
    <div class="ivu-input-wrapper"><input id="iview"><span class="ivu-input-word-count">0/50</span></div>
    <div class="el-input"><input id="element-count"><span class="el-input__count">0/15</span></div>
    <div class="x-textarea"><textarea id="textarea-count"></textarea><span class="x-textarea__count">0/40</span></div>
    <div class="list"><input id="listed"><span class="list__count">1 / 3</span></div>`);
  const limit = (name) => knowledge.limitOf(doc.getElementById(name));
  // 数字、日期框按规范不认 maxlength。
  assert.equal(limit("number"), null);
  assert.equal(limit("date"), null);
  assert.equal(limit("email"), 30);
  assert.equal(limit("tel"), 11);
  // 分页、步骤这类「n / m」不是字数统计；data-count 只认字数统计外层（带 X-show-count）上的。
  assert.equal(limit("paged"), null);
  assert.equal(limit("stepped"), null);
  assert.equal(limit("data"), null);
  assert.equal(limit("arco"), 30);
  assert.equal(limit("vant"), 200);
  assert.equal(limit("iview"), 50);
  // __count 只认输入框、多行文本组件的（el-input__count 这类），列表的 list__count「1 / 3」不算。
  assert.equal(limit("element-count"), 15);
  assert.equal(limit("textarea-count"), 40);
  assert.equal(limit("listed"), null);
});

test("a limit of 0 is taken as no limit: such boxes were filled before, and 0 is hardly a real limit on a live site", () => {
  const doc = page(`
    <input id="zero" maxlength="0"><input id="negative" maxlength="-1">
    <div class="ant-input-textarea ant-input-textarea-show-count" data-count="0 / 0"><textarea id="counted"></textarea></div>
    <div class="el-input"><input id="zero-count" maxlength="0"><span class="el-input__count">0/0</span></div>`);
  const limit = (name) => knowledge.limitOf(doc.getElementById(name));
  assert.equal(limit("zero"), null);
  assert.equal(limit("negative"), null);
  assert.equal(limit("counted"), null);
  assert.equal(limit("zero-count"), null);
});

test("a frame without an address of its own takes the address of the frame around it", () => {
  const { window } = new JSDOM(`<body><iframe id="outer"></iframe></body>`, { url: "https://xyz.51job.com/consumer/apply" });
  const outer = window.document.getElementById("outer").contentDocument;
  Object.defineProperty(outer, "URL", { value: "https://xyz.51job.com/External/Apply.aspx" });
  const inner = outer.body.appendChild(outer.createElement("iframe")).contentDocument;
  assert.equal(inner.URL, "about:blank");
  assert.equal(knowledge.addressOf(inner, "https://top.example.test/"), "https://xyz.51job.com/External/Apply.aspx");
  assert.equal(knowledge.addressOf(window.document, "https://top.example.test/"), "https://xyz.51job.com/consumer/apply");
  const lone = new JSDOM("<body></body>").window.document;
  assert.equal(knowledge.addressOf(lone, "https://top.example.test/"), "https://top.example.test/");
  window.close();
});

test("the Form2Offer license ships inside site-knowledge.js", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.join(__dirname, "..");
  const license = fs.readFileSync(path.join(root, "scripts/licenses/form2offer-e7be145.txt"), "utf8");
  const notice = license.slice(license.indexOf("MIT License")).trim().split("\n").map((line) => line.trimEnd()).join("\n");
  const header = fs.readFileSync(path.join(root, "site-knowledge.js"), "utf8").split("\n")
    .filter((line) => line.startsWith("//")).map((line) => line.replace(/^\/\/ ?/, "").trimEnd()).join("\n");
  assert.ok(header.includes(notice), "the copyright and permission notice are in the file header");
  assert.match(fs.readFileSync(path.join(root, "desktop/scripts/pack-plugin.js"), "utf8"), /^\s*"site-knowledge\.js",$/m);
});
