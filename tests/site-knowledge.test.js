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

test("length counts characters, or bytes with a Chinese character as 2", () => {
  assert.equal(knowledge.measure("示例大学 A1"), 7);
  assert.equal(knowledge.measure("示例大学 A1", true), 11);
  assert.equal(knowledge.measure("", true), 0);
  assert.equal(knowledge.measure("é", true), 1, "Latin-1 letters count 1");
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
  assert.equal(limit("plain"), 0);
  assert.equal(limit("first"), 0, "a counter shared by two boxes is not this box's");
  assert.equal(limit("account"), 0, "only a counter written as n / max counts");
  assert.equal(knowledge.limitOf(doc.createElement("select")), 0);
});
