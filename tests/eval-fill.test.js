// #429 第 11 项填写评测（scripts/eval-fill.mjs）：语料能读、打分按填写时的规矩、模拟模型不联网也能跑完。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () => import(pathToFileURL(path.join(__dirname, "..", "scripts", "eval-fill.mjs")).href);

test("the fill corpus builds the resume the way the page does and every question has an answer key", async () => {
  const { loadCorpus } = await load();
  const corpus = loadCorpus();
  const keys = corpus.resumeFields.map((field) => field.key);
  // 桌面解析的字段名改成了「学校名 + 教育经历 - …」，「我的信息」、补充字段、本网站回答都在。
  assert.ok(keys.includes("江城理工大学教育经历-学校"), keys.join(" | "));
  assert.ok(keys.includes("现居住地") && keys.includes("父亲工作单位") && keys.includes("号码1"));
  assert.ok(corpus.resumeFields.some((field) => field.group === "本网站回答"));
  const ids = corpus.pages.flatMap((page) => page.fields.map((field) => `${page.name}/${field.id}`));
  assert.equal(new Set(ids).size, ids.length);
  for (const page of corpus.pages) {
    for (const field of page.fields) {
      assert.ok("expect" in field, `${page.name}/${field.id}`);
      assert.ok(!(field.open && field.expect !== null), `${page.name}/${field.id}: an open question has no answer key`);
    }
  }
  assert.ok(ids.length >= 100);
});

test("scoring follows the fill: options, page-only options, date ends, regions and open questions", async () => {
  const { scoreField } = await load();
  const select = { kind: "select", options: ["请选择", "大学英语四级", "大学英语六级"], expect: "大学英语六级" };
  assert.equal(scoreField(select, "CET-6"), "correct");
  assert.equal(scoreField(select, "CET-4"), "wrong");
  assert.equal(scoreField(select, "雅思"), "missed", "a value no option takes is not filled on the page");
  assert.equal(scoreField(select, ""), "missed");
  assert.equal(scoreField({ kind: "custom-select", pageOptions: ["本科", "硕士"], expect: "硕士" }, "硕士研究生"), "correct");
  assert.equal(scoreField({ kind: "custom-select", multiple: true, pageOptions: ["北京", "深圳"], expect: "深圳" }, "深圳、北京"), "wrong");
  const end = { kind: "date", picker: "month", label: "毕业时间", expect: "2023-06" };
  assert.equal(scoreField(end, "2019.09-2023.06"), "correct");
  assert.equal(scoreField(end, "2019.09"), "wrong");
  assert.equal(scoreField({ kind: "date", picker: "month", label: "在校时间", expect: "2023-06" }, "2019.09-2023.06"), "missed");
  const city = { kind: "cascader", expect: "广东省/深圳市/南山区" };
  assert.equal(scoreField(city, "广东省深圳市南山区"), "correct");
  assert.equal(scoreField(city, "广东省深圳市南山区科苑路 8 号"), "missed");
  assert.equal(scoreField(city, "广东省/深圳市/福田区"), "wrong");
  assert.equal(scoreField({ kind: "textarea", open: true, expect: null }, "随便写的一段"), "written");
  assert.equal(scoreField({ kind: "text", expect: null }, "13800000000"), "wrong");
  assert.equal(scoreField({ kind: "text", expect: null }, ""), "empty");
  assert.equal(scoreField({ kind: "text", expect: "A公司", anyOf: ["A公司 经理"] }, "A公司 经理"), "correct");
});

test("with a mock model that answers nothing both prompts leave only the local matches", async () => {
  const { loadCorpus, evaluate, mockModel } = await load();
  const result = await evaluate(loadCorpus(), { modes: ["keys", "values"], runs: 1, complete: mockModel("empty") });
  const { keys, values } = result.byMode;
  assert.equal(keys.correct, values.correct);
  assert.equal(keys.wrong, values.wrong);
  assert.equal(keys.failedRequests, 0);
  assert.ok(keys.correct >= 20, "the local rules fill the basic questions");
  assert.ok(keys.promptBytes < values.promptBytes, "the keys prompt carries no values");
  assert.ok(result.fields.every((field) => field.keys.join() === field.values.join()));
});

test("the key goes only to https unless http is asked for by name", async () => {
  const { baseUrlAllowed } = await load();
  assert.equal(baseUrlAllowed("https://api.example.test/v1"), true);
  assert.equal(baseUrlAllowed("http://api.example.test/v1"), false);
  assert.equal(baseUrlAllowed("http://127.0.0.1:8080/v1", true), true);
  assert.equal(baseUrlAllowed("http://localhost:8080/v1", true), true);
  assert.equal(baseUrlAllowed("http://[::1]:8080/v1", true), true);
  assert.equal(baseUrlAllowed("http://api.example.test/v1", true), false, "http leaves this machine only never");
  assert.equal(baseUrlAllowed("ftp://api.example.test"), false);
  assert.equal(baseUrlAllowed("not a url"), false);
});
