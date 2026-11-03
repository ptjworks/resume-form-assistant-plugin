// #429 第 11 项：发给 AI 的只有题目、选项和资料的编号、分组、字段名；AI 回编号，值在 worker 里按编号取资料原文。
// 资料全是虚构的。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "ai-worker.js"), "utf8");
const helpers = require("../ai-helpers.js");
const { catalogOf, refOf } = require("./helpers/ai-refs.js");
const { pathToFileURL } = require("node:url");
const regions = (() => {
  const scope = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "region-data.js"), "utf8"), { self: scope });
  return scope.ResumeProRegions;
})();

// respond(message, catalog) 返回 AI 的回答（数组或文字）；legacy 接着跑评测用的旧发值方式（scripts/eval-fill-legacy.js）。
function worker(respond = () => [], { legacy = false, withRegions = true } = {}) {
  const calls = [];
  let sequence = 0;
  const context = vm.createContext({
    importScripts() {}, ResumeProAIHelpers: helpers, ResumeProProfile: require("../profile-fields.js"),
    AbortController, TextEncoder, performance: { now: () => 0 }, crypto: { randomUUID: () => `call-${++sequence}` },
    ResumeProRegions: regions
  });
  context.self = {
    postMessage(message) {
      if (message.kind !== "desktop-complete") return;
      calls.push(message);
      const answer = respond(message, catalogOf(message.user));
      const text = typeof answer === "string" ? answer : JSON.stringify(answer);
      queueMicrotask(() => context.self.onmessage({ data: { kind: "desktop-result", callId: message.callId, reply: { ok: true, text } } }));
    }
  };
  if (!withRegions) delete context.ResumeProRegions;
  vm.runInContext(source, context);
  if (legacy) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "scripts", "eval-fill-legacy.js"), "utf8"), context);
  return { calls, context, run: async (input) => JSON.parse(JSON.stringify(await context.handleAiFill(input))) };
}

const fieldsOf = (call) => JSON.parse(call.user.split("\n")[1]);
const valueOf = (result, fieldId) => result.matches.find((match) => match.fieldId === fieldId)?.value;

test("the request carries the questions and the resume keys, and no resume value", async () => {
  // 桌面解析出来的字段名带着学校、公司名（semanticizeParsedFields），也不能出去。
  const resume = helpers.semanticizeParsedFields([
    { group: "教育经历", key: "教育1学校", value: "虚构理工学院" },
    { group: "教育经历", key: "教育1专业", value: "虚构材料工程" },
    { group: "教育经历", key: "教育1时间", value: "2019.09-2023.06" },
    { group: "教育经历", key: "教育2学校", value: "虚构师范大学" },
    { group: "教育经历", key: "教育2专业", value: "虚构高分子化学" },
    { group: "实习经历", key: "实习1公司", value: "虚构云计算有限公司" },
    { group: "实习经历", key: "实习1内容", value: "负责虚构数据平台的接口测试与文档整理" }
  ]).concat([
    { group: "基本信息", key: "姓名", value: "欧阳虚构" },
    { group: "基本信息", key: "手机号码", value: "13912345678" },
    { group: "基本信息", key: "邮箱", value: "fictional.user@example.test" },
    { group: "基本信息", key: "证件号码", value: "11010519491231002X" },
    { group: "基本信息", key: "家庭住址", value: "虚构省虚构市虚构路 8 号" },
    { group: "家庭主要成员", key: "父亲姓名", value: "欧阳虚父" },
    { group: "家庭主要成员", key: "父亲工作单位", value: "虚构机械厂" },
    { group: "补充字段", key: "号码1", value: "13800001111" },
    { group: "补充字段", key: "为什么选择我们", value: "因为虚构公司的产品让我印象深刻" },
    { group: "本网站回答", key: "期望工作城市", value: "虚构城" },
    // 别的分组里以别项的值开头、或在中间带着别项的值的字段名（A30）。
    { group: "户籍信息", key: "虚构城户口信息-类型", value: "集体户" },
    { group: "获奖情况", key: "奖项名称", value: "虚构杯一等奖" },
    { group: "获奖情况", key: "虚构杯一等奖-获奖时间", value: "2022.05" },
    { group: "本网站回答", key: "在虚构理工学院期间最有成就感的事", value: "带队拿了奖" }
  ]);
  const env = worker();
  await env.run({
    formFields: [
      { fieldId: "school", label: "毕业院校", inputType: "text" },
      { fieldId: "company", label: "实习单位", inputType: "text" },
      { fieldId: "work", label: "工作内容", tagName: "textarea", inputType: "textarea" },
      { fieldId: "father", label: "父亲工作单位", group: "家庭成员", inputType: "text" },
      { fieldId: "why", label: "你为什么选择我们", tagName: "textarea", inputType: "textarea" },
      { fieldId: "city", label: "期望工作城市", inputType: "text" },
      { fieldId: "contact", label: "备用联系电话", inputType: "text" }
    ],
    resumeFields: resume
  });
  assert.equal(env.calls.length, 1);
  const sent = env.calls.map((call) => `${call.system}\n${call.user}`).join("\n");
  for (const field of resume) {
    assert.ok(!sent.includes(String(field.value)), `${field.key} 的值不该发出去`);
  }
  // 解析出来的字段名换回「教育经历1-学校」，同一段编号相同；值的形态照发，「号码1」看得出是手机号的样子。
  const catalog = catalogOf(env.calls[0].user);
  const keys = catalog.map((entry) => entry.key);
  assert.ok(keys.includes("教育经历1-学校") && keys.includes("教育经历1-专业") && keys.includes("教育经历2-专业"), keys.join(" | "));
  assert.ok(keys.includes("实习经历1-公司"), keys.join(" | "));
  assert.equal(catalog.find((entry) => entry.key === "号码1").shape, "11 位数字");
  assert.equal(catalog.find((entry) => entry.key === "证件号码").shape, "18 位证件号");
  assert.equal(catalog.find((entry) => entry.key === "教育经历1-时间").shape, "起止日期");
  assert.equal(catalog.find((entry) => entry.key === "姓名").shape, undefined);
  assert.ok(catalog.every((entry) => !("value" in entry)));
  assert.ok(keys.includes("〔期望工作城市〕户口信息-类型") && keys.includes("〔奖项名称〕-获奖时间"), keys.join(" | "));
  assert.ok(keys.includes("在〔教育经历1-学校〕期间最有成就感的事"), keys.join(" | "));
});

test("refs become resume values: one item, a multi-select, a cascade and a span split in two", async () => {
  const resume = [
    { group: "技能", key: "编程语言1", value: "Java" }, { group: "技能", key: "编程语言2", value: "Python" },
    { group: "基本信息", key: "现居省份", value: "广东省" }, { group: "基本信息", key: "现居城市", value: "深圳市" },
    { group: "实习经历", key: "开始时间", value: "2022.07" }, { group: "实习经历", key: "结束时间", value: "至今" },
    { group: "实习经历", key: "公司", value: "虚构科技" }
  ];
  const env = worker((message, catalog) => {
    const ref = (key) => catalog.find((entry) => entry.key === key).ref;
    return [
      { fieldId: "company", ref: ref("公司") },
      { fieldId: "skills", refs: [ref("编程语言1"), ref("编程语言2")] },
      { fieldId: "city", refs: [ref("现居省份"), ref("现居城市")] },
      { fieldId: "period", refs: [ref("开始时间"), ref("结束时间")] }
    ];
  });
  const result = await env.run({
    formFields: [
      { fieldId: "company", label: "实习单位" },
      { fieldId: "skills", label: "掌握的语言", inputType: "select", multiple: true, options: [] },
      { fieldId: "city", label: "现居住地", inputType: "select", cascade: true, options: [] },
      { fieldId: "period", label: "实习起止时间", inputType: "text", options: [] }
    ],
    resumeFields: resume
  });
  assert.equal(valueOf(result, "company"), "虚构科技");
  assert.equal(valueOf(result, "skills"), "Java、Python");
  assert.equal(valueOf(result, "city"), "广东省/深圳市");
  assert.equal(valueOf(result, "period"), "2022.07-至今");
});

test("a text question answered by two items joins them with a space; a date picker takes a whole item even when a part is named", async () => {
  const resume = [{ group: "家庭主要成员", key: "父亲工作单位", value: "虚构机械厂" }, { group: "家庭主要成员", key: "父亲职务", value: "车间主任" },
    { group: "教育经历", key: "教育经历2-时间", value: "2023.09-2026.06" }];
  const env = worker((message, catalog) => [
    { fieldId: "job", refs: [catalog[0].ref, catalog[1].ref] },
    { fieldId: "grad", ref: `${catalog[2].ref}.month` },
    { fieldId: "start", ref: catalog[2].ref, part: "year" }
  ]);
  const result = await env.run({
    formFields: [
      { fieldId: "job", label: "父亲工作单位及职务", group: "家庭情况" },
      { fieldId: "grad", label: "Graduation Date", inputType: "date-picker", options: [] },
      { fieldId: "start", label: "入学时间", inputType: "date-picker", options: [] }
    ],
    resumeFields: resume
  });
  assert.equal(valueOf(result, "job"), "虚构机械厂 车间主任");
  // 一段起止按题目取一头，写成控件认的「2026-06」。
  assert.equal(valueOf(result, "grad"), "2026-06");
  assert.equal(valueOf(result, "start"), "2023-09");
});

test("a date picker gets the end the question asks for, written the way pickers read it", async () => {
  const resume = [{ group: "教育经历", key: "教育经历1-时间", value: "2019.09-2023.06" }, { group: "求职补充", key: "可到岗日期", value: "2026年7月1日" },
    { group: "实习经历", key: "实习经历1-时间", value: "2024.07-至今" }];
  const env = worker((message, catalog) => [
    { fieldId: "start", ref: catalog[0].ref }, { fieldId: "span", ref: catalog[0].ref }, { fieldId: "birth", ref: catalog[1].ref },
    { fieldId: "birthMonth", ref: catalog[1].ref }, { fieldId: "until", ref: catalog[2].ref }
  ]);
  const result = await env.run({
    formFields: [
      { fieldId: "start", label: "入学时间", placeholder: "开始时间", inputType: "date-picker", pickerInputType: "time", options: [] },
      { fieldId: "span", label: "在校时间", inputType: "date-picker", options: [] },
      { fieldId: "birth", label: "最早到岗日期", inputType: "date-picker", pickerInputType: "date", options: [] },
      { fieldId: "birthMonth", label: "到岗年月", inputType: "date-picker", pickerInputType: "month", options: [] },
      { fieldId: "until", label: "结束时间", inputType: "date-picker", options: [] }
    ],
    resumeFields: resume
  });
  assert.equal(valueOf(result, "start"), "2019-09");
  // 题目看不出取哪一头的一段起止不交给控件，记作没填上、报日期不对。
  assert.deepEqual(result.matches.find((match) => match.fieldId === "span"), { fieldId: "span", value: "", blocked: "invalid_date" });
  assert.equal(valueOf(result, "birth"), "2026-07-01");
  assert.equal(valueOf(result, "birthMonth"), "2026-07");
  assert.equal(valueOf(result, "until"), "至今");
});

test("a native date box takes only a whole day; a date picker takes a month and leaves the day to the page", async () => {
  const env = worker((message, catalog) => [{ fieldId: "native", ref: catalog[0].ref }, { fieldId: "picker", ref: catalog[0].ref },
    { fieldId: "nativeNow", ref: catalog[1].ref }, { fieldId: "pickerNow", ref: catalog[1].ref }]);
  const result = await env.run({
    formFields: [{ fieldId: "native", label: "入学日期", inputType: "date", options: [] },
      { fieldId: "picker", label: "入学日期", inputType: "date-picker", pickerInputType: "date", options: [] },
      { fieldId: "nativeNow", label: "离职日期", inputType: "date", options: [] },
      { fieldId: "pickerNow", label: "离职日期", inputType: "date-picker", pickerInputType: "date", options: [] }],
    resumeFields: [{ group: "教育经历", key: "入学时间", value: "2019.09" }, { group: "实习经历", key: "离职时间", value: "至今" }]
  });
  const byId = Object.fromEntries(JSON.parse(JSON.stringify(result.matches)).map((match) => [match.fieldId, match]));
  assert.deepEqual(byId.native, { fieldId: "native", value: "", blocked: "invalid_date" });
  assert.equal(byId.picker.value, "2019-09");
  // 原生 date 框写不进「至今」；日期控件里有「至今」的由页面去点。
  assert.deepEqual(byId.nativeNow, { fieldId: "nativeNow", value: "", blocked: "invalid_date" });
  assert.equal(byId.pickerNow.value, "至今");
});

test("native month and datetime-local boxes block a present date and a value they cannot take, like a date box", async () => {
  const env = worker((message, catalog) => [
    { fieldId: "monthNow", ref: catalog[1].ref }, { fieldId: "monthBad", ref: catalog[2].ref }, { fieldId: "month", ref: catalog[0].ref },
    { fieldId: "localNow", ref: catalog[1].ref }, { fieldId: "localMonth", ref: catalog[0].ref }, { fieldId: "local", ref: catalog[3].ref }
  ]);
  const result = await env.run({
    formFields: [{ fieldId: "monthNow", label: "离职年月", inputType: "month", options: [] },
      { fieldId: "monthBad", label: "到岗年月", inputType: "month", options: [] },
      { fieldId: "month", label: "入学年月", inputType: "month", options: [] },
      { fieldId: "localNow", label: "离职日期", inputType: "datetime-local", options: [] },
      { fieldId: "localMonth", label: "入学日期", inputType: "datetime-local", options: [] },
      { fieldId: "local", label: "面试日期", inputType: "datetime-local", options: [] }],
    resumeFields: [{ group: "教育经历", key: "入学时间", value: "2019.09" }, { group: "实习经历", key: "离职时间", value: "至今" },
      { group: "补充字段", key: "到岗时间", value: "随时" }, { group: "补充字段", key: "可面试日期", value: "2026.07.15" }]
  });
  const byId = Object.fromEntries(JSON.parse(JSON.stringify(result.matches)).map((match) => [match.fieldId, match]));
  for (const id of ["monthNow", "monthBad", "localNow", "localMonth"]) assert.deepEqual(byId[id], { fieldId: id, value: "", blocked: "invalid_date" });
  assert.equal(byId.month.value, "2019-09");
  assert.equal(byId.local.value, "2026-07-15");
});

test("a size select with an M option does not take the gender, and an AI answer to it is dropped", async () => {
  const env = worker((message, catalog) => [{ fieldId: "size", ref: catalog[0].ref }]);
  const result = await env.run({
    formFields: [{ fieldId: "size", label: "T恤尺码", inputType: "select", options: ["S", "M", "L"] }, { fieldId: "x", label: "备注" }],
    resumeFields: [{ group: "基本信息", key: "性别", value: "男" }, { group: "补充字段", key: "备注", value: "无" }]
  });
  assert.equal(fieldsOf(env.calls[0]).some((field) => field.fieldId === "size"), false, "no item fits a size");
  assert.equal(valueOf(result, "size"), undefined);
});

test("a date picker whose question names no side takes the start or end the AI names in part", async () => {
  const env = worker((message, catalog) => [{ fieldId: "from", ref: catalog[0].ref, part: "start" }, { fieldId: "to", ref: catalog[0].ref, part: "end" },
    { fieldId: "month", ref: catalog[1].ref }]);
  const result = await env.run({
    formFields: [{ fieldId: "from", label: "在校时间", inputType: "date-picker", pickerInputType: "month", options: [] },
      { fieldId: "to", label: "在校时间", inputType: "date-picker", pickerInputType: "month", options: [] },
      { fieldId: "month", label: "到岗年月", inputType: "month", options: [] }],
    resumeFields: [{ group: "教育经历", key: "教育经历1-时间", value: "2019.09-2023.06" }, { group: "求职补充", key: "可到岗日期", value: "2026-07-01" }]
  });
  assert.equal(valueOf(result, "from"), "2019-09");
  assert.equal(valueOf(result, "to"), "2023-06");
  // 原生 month 框只给年月。
  assert.equal(valueOf(result, "month"), "2026-07");
});

test("a start or end named in the answer takes that side of a span, written either way", async () => {
  const env = worker((message, catalog) => [
    { fieldId: "start", ref: catalog[0].ref, part: "start" }, { fieldId: "end", ref: `${catalog[0].ref}.end` },
    { fieldId: "text", ref: `${catalog[0].ref}.start` }, { fieldId: "single", ref: `${catalog[1].ref}.end` }
  ]);
  const result = await env.run({
    formFields: [{ fieldId: "start", label: "在校时间", placeholder: "开始", inputType: "date-picker", pickerInputType: "month", options: [] },
      { fieldId: "end", label: "在校时间", inputType: "date-picker", pickerInputType: "month", options: [] },
      { fieldId: "text", label: "入学年月" }, { fieldId: "single", label: "到岗年月" }],
    resumeFields: [{ group: "教育经历", key: "教育经历1-时间", value: "2019.09-2023.06" }, { group: "求职补充", key: "可到岗时间", value: "2026.07" }]
  });
  assert.equal(valueOf(result, "start"), "2019-09");
  assert.equal(valueOf(result, "end"), "2023-06", "the side named in the ref wins over a question that names none");
  assert.equal(valueOf(result, "text"), "2019.09");
  assert.equal(valueOf(result, "single"), "2026.07", "an item that is not a span stays as it is");
});

test("a date picker given an item that is not a date reports a bad date instead of typing it in", async () => {
  const env = worker((message, catalog) => [{ fieldId: "start", ref: catalog[0].ref }]);
  const result = await env.run({
    formFields: [{ fieldId: "start", label: "入职时间", inputType: "date-picker", options: [] }],
    resumeFields: [{ group: "实习经历", key: "实习经历1-公司", value: "虚构科技" }]
  });
  // 拦下的不带原文，不算 AI 填上的，也不算这次成功（另记 aiBlocked，网页记作没写上）。
  assert.deepEqual(result.matches, [{ fieldId: "start", value: "", blocked: "invalid_date" }]);
  assert.equal(result.diagnostics.aiMatches, 0);
  assert.equal(result.diagnostics.aiBlocked, 1);
  assert.equal(result.success, true, "nothing went wrong, nothing was filled");
  // 有警告时（另一题太长没发出去），只有拦下的不算成功。
  const warned = await worker((message, catalog) => [{ fieldId: "start", ref: catalog[0].ref }]).run({
    formFields: [{ fieldId: "start", label: "入职时间", inputType: "date-picker", options: [] }, { fieldId: "huge", label: "说明", placeholder: "甲".repeat(17_000) }],
    resumeFields: [{ group: "实习经历", key: "实习经历1-公司", value: "虚构科技" }]
  });
  assert.match(warned.warning, /内容太多/);
  assert.equal(warned.success, false);
});

test("a text box takes no year, month or day of an item; questions about them and selects with fits do", async () => {
  const env = worker((message, catalog) => ["school", "year", "salary", "monthly", "when"].map((fieldId) => ({ fieldId, ref: catalog[0].ref, part: "year" })));
  const result = await env.run({
    formFields: [{ fieldId: "school", label: "毕业院校" }, { fieldId: "year", label: "毕业年份" },
      // 「年薪」「月薪」里有年、月，单说「时间」也不是问年月日的某一部分。
      { fieldId: "salary", label: "期望年薪" }, { fieldId: "monthly", label: "Monthly salary" }, { fieldId: "when", label: "到岗时间" }],
    resumeFields: [{ group: "教育经历", key: "教育经历1-时间", value: "2019.09-2023.06" }]
  });
  assert.equal(valueOf(result, "school"), undefined);
  assert.equal(valueOf(result, "year"), "2023");
  assert.equal(valueOf(result, "salary"), undefined);
  assert.equal(valueOf(result, "monthly"), undefined);
  assert.equal(valueOf(result, "when"), undefined);
});

test("a select of years under a question about a time takes the year of a span; a select of day counts does not", async () => {
  const env = worker();
  await env.run({
    formFields: [{ fieldId: "grad", label: "毕业时间", inputType: "select", options: ["2023", "2024", "2025"] },
      { fieldId: "days", label: "每周实习天数", inputType: "select", options: ["3", "4", "5"] }],
    resumeFields: [{ group: "教育经历", key: "教育经历1-时间", value: "2019.09-2023.06" }, { group: "基本信息", key: "出生日期", value: "2000-03-17" }]
  });
  const fields = fieldsOf(env.calls[0]);
  assert.deepEqual(fields.find((field) => field.fieldId === "grad").fits, ["r1.year"]);
  assert.equal(fields.some((field) => field.fieldId === "days"), false, "no item fits a day count");
});

test("a question about motives or plans takes only an item about the same thing, saved answers included", async () => {
  const resume = [{ group: "求职补充", key: "期望工作地点", value: "虚构城" }, { group: "自我评价", key: "自我评价", value: "踏实认真" },
    { group: "补充字段", key: "为什么想加入我们", value: "认同虚构公司的产品" }, { group: "工作经历", key: "工作经历1-离职原因", value: "合同到期" },
    { group: "补充字段", key: "期望薪资", value: "面议" }, { group: "补充字段", key: "职业规划", value: "三年内成为数据分析师" }];
  const env = worker((message, catalog) => {
    const ref = (key) => catalog.find((entry) => entry.key === key).ref;
    return [
      { fieldId: "why", ref: ref("期望工作地点") }, { fieldId: "whyEn", ref: ref("自我评价") }, { fieldId: "strength", ref: ref("自我评价") },
      { fieldId: "saved", ref: ref("为什么想加入我们") }, { fieldId: "leave", ref: ref("工作经历1-离职原因") }, { fieldId: "intro", ref: ref("自我评价") },
      { fieldId: "salary", ref: ref("期望薪资") }, { fieldId: "plan", ref: ref("职业规划") }, { fieldId: "lineWhy", ref: ref("自我评价") }
    ];
  });
  const textarea = (fieldId, label) => ({ fieldId, label, tagName: "textarea", inputType: "textarea" });
  const result = await env.run({
    formFields: [textarea("why", "为什么选择我们公司"), textarea("whyEn", "Why do you want to join us?"), textarea("strength", "你的优势和不足"),
      textarea("saved", "你为什么想加入本公司"), textarea("leave", "离职原因"), textarea("intro", "个人简介"),
      // 存过的回答也要说的是同一件事；单行文本框一样。
      textarea("salary", "为什么选择本岗位"), textarea("plan", "未来三到五年的职业规划"), { fieldId: "lineWhy", label: "请简述你为什么投递", inputType: "text" }],
    resumeFields: resume
  });
  assert.deepEqual(result.matches.map((match) => match.fieldId).sort(), ["intro", "leave", "plan", "saved"]);
  assert.equal(valueOf(result, "saved"), "认同虚构公司的产品");
  // 拦下的单行动机题（lineWhy）也记作开放题没有现成回答。
  assert.equal(result.diagnostics.openUnanswered, 5);
});

test("every long answer box checks that the item is about the same thing, whatever the question says", async () => {
  const resume = [{ group: "自我评价", key: "自我评价", value: "踏实认真" }, { group: "实习经历", key: "实习经历1-内容", value: "负责虚构数据看板" },
    { group: "求职补充", key: "奖励荣誉", value: "虚构奖学金" }, { group: "户籍与地区", key: "家庭住址", value: "虚构省虚构市" }];
  const env = worker((message, catalog) => {
    const ref = (key) => catalog.find((entry) => entry.key === key).ref;
    return [
      { fieldId: "best", ref: ref("自我评价") }, { fieldId: "about", ref: ref("自我评价") }, { fieldId: "work", ref: ref("实习经历1-内容") },
      { fieldId: "awards", ref: ref("奖励荣誉") }, { fieldId: "intro", ref: ref("自我评价") }, { fieldId: "self", ref: ref("家庭住址") }
    ];
  });
  const box = (fieldId, label, group = "") => ({ fieldId, label, group, tagName: "textarea", inputType: "textarea" });
  const result = await env.run({
    formFields: [box("best", "Describe your greatest accomplishment"), box("about", "Tell us about yourself"), box("work", "工作描述", "实习经历"),
      box("awards", "获奖情况", "其他信息"), box("intro", "个人简介", "补充信息"), box("self", "自我评价", "基本信息")],
    resumeFields: resume
  });
  // 英文题和中文字段名对不上，「家庭住址」答不了「自我评价」；分组、同义词（获奖=奖励、简介=评价）对得上的照填。
  assert.deepEqual(result.matches.map((match) => match.fieldId).sort(), ["awards", "intro", "work"]);
  assert.equal(result.diagnostics.openUnanswered, 3);
});

test("a view question takes no item that shares only a common word like 工作 with it", async () => {
  const resume = [{ group: "实习经历", key: "工作描述", value: "负责虚构数据看板" }, { group: "团队活动", key: "团队合作经历", value: "带队完成虚构项目" },
    { group: "学习经历", key: "学习能力自评", value: "上手快" }];
  const env = worker((message, catalog) => {
    const ref = (key) => catalog.find((entry) => entry.key === key).ref;
    return [{ fieldId: "view", ref: ref("工作描述") }, { fieldId: "team", ref: ref("团队合作经历") }, { fieldId: "grow", ref: ref("学习能力自评") }];
  });
  const box = (fieldId, label) => ({ fieldId, label, tagName: "textarea", inputType: "textarea" });
  const result = await env.run({
    formFields: [box("view", "你对团队工作的看法"), box("team", "你在团队合作中的收获"), box("grow", "谈谈你对个人发展的看法")],
    resumeFields: resume
  });
  // 只靠「工作」「学习」「能力」「发展」这类哪道题都有的词对上的不算；「团队合作」写在资料项自己的字段名里，照填。
  assert.deepEqual(result.matches.map((match) => match.fieldId), ["team"]);
  assert.equal(result.diagnostics.openUnanswered, 2);
});

test("an item is on topic only by words of its own name, never by its group", async () => {
  const resume = [{ group: "社会实践", key: "工作描述", value: "在虚构社区做志愿者" }, { group: "社会实践", key: "实践收获", value: "学会了沟通" }];
  const env = worker((message, catalog) => {
    const ref = (key) => catalog.find((entry) => entry.key === key).ref;
    return [{ fieldId: "view", ref: ref("工作描述") }, { fieldId: "gain", ref: ref("实践收获") }];
  });
  const box = (fieldId, label) => ({ fieldId, label, tagName: "textarea", inputType: "textarea" });
  const result = await env.run({ formFields: [box("view", "社会实践中的收获和看法"), box("gain", "社会实践中的收获")], resumeFields: resume });
  // 「社会实践」只在资料项的分组里，「工作描述」不能靠它放行；「实践收获」的字段名自己就对得上。
  assert.deepEqual(result.matches.map((match) => match.fieldId), ["gain"]);
});

test("an open question whose answer is held back counts as having no ready answer, not as unwritten", async () => {
  const resume = Array.from({ length: 10 }, (_, i) => ({ group: "自我评价", key: `自我评价${i}`, value: `评价${i}` }));
  const env = worker((message, catalog) => [{ fieldId: "self", refs: catalog.map((entry) => entry.ref) }]);
  const result = await env.run({ formFields: [{ fieldId: "self", label: "自我评价", tagName: "textarea", inputType: "textarea" }], resumeFields: resume });
  assert.deepEqual(result.matches, []);
  assert.equal(result.diagnostics.aiBlocked, 0);
  assert.equal(result.diagnostics.openUnanswered, 1);
});

test("a multi-select keeps the items that fit its options and joins them; a single select drops the answer", async () => {
  const env = worker((message, catalog) => [
    { fieldId: "cities", refs: catalog.map((entry) => entry.ref) }, { fieldId: "city", ref: catalog[2].ref }
  ]);
  const result = await env.run({
    formFields: [{ fieldId: "cities", label: "期望工作城市", inputType: "select", multiple: true, options: ["北京", "上海", "深圳"] },
      { fieldId: "city", label: "工作城市", inputType: "select", options: ["北京", "上海", "深圳"] }],
    resumeFields: [{ group: "求职", key: "期望城市1", value: "深圳" }, { group: "求职", key: "期望城市2", value: "上海" }, { group: "求职", key: "备注", value: "可出差" }]
  });
  assert.equal(valueOf(result, "cities"), "深圳、上海");
  assert.equal(valueOf(result, "city"), undefined);
});

test("a saved answer to the very same question passes even when the question is all common words", async () => {
  const env = worker((message, catalog) => [{ fieldId: "both", ref: catalog[0].ref }, { fieldId: "other", ref: catalog[0].ref }]);
  const result = await env.run({
    formFields: [{ fieldId: "both", label: "你的优势和不足", tagName: "textarea", inputType: "textarea" },
      { fieldId: "other", label: "你的缺点和优点", tagName: "textarea", inputType: "textarea" }],
    resumeFields: [{ group: "补充字段", key: "你的优势和不足？", value: "认真，但有时过于追求细节" }]
  });
  assert.equal(valueOf(result, "both"), "认真，但有时过于追求细节");
  assert.equal(valueOf(result, "other"), undefined, "only the same question, not one made of the same common words");
});

test("a text question joins several items only when it asks for several things", async () => {
  const resume = [{ group: "实习经历", key: "实习经历1-公司", value: "虚构科技" }, { group: "实习经历", key: "实习经历1-职位", value: "分析实习生" }];
  const env = worker((message, catalog) => ["company", "both"].map((fieldId) => ({ fieldId, refs: [catalog[0].ref, catalog[1].ref] })));
  const result = await env.run({
    formFields: [{ fieldId: "company", label: "实习单位" }, { fieldId: "both", label: "实习单位和岗位" }],
    resumeFields: resume
  });
  assert.equal(valueOf(result, "company"), undefined);
  assert.equal(valueOf(result, "both"), "虚构科技 分析实习生");
});

test("an answer that writes its own value, names an unknown ref or another batch's field is dropped", async () => {
  const resume = [{ group: "基本信息", key: "籍贯", value: "虚构省" }, { group: "教育经历", key: "专业", value: "虚构专业" }];
  const env = worker((message, catalog) => [
    { fieldId: "major", value: "编出来的专业" },
    { fieldId: "major", ref: catalog[1].ref, value: "编出来的专业" },
    { fieldId: "hometown", ref: "r99" },
    { fieldId: "hometown", ref: "姓名" },
    { fieldId: "elsewhere", ref: catalog[0].ref },
    { fieldId: "hometown", refs: [catalog[0].ref, catalog[1].ref] }
  ]);
  const result = await env.run({
    formFields: [{ fieldId: "major", label: "所学专业" }, { fieldId: "hometown", label: "生源地址", inputType: "select", options: [] }],
    resumeFields: resume
  });
  assert.deepEqual(result.matches, []);
  assert.equal(result.diagnostics.aiMatches, 0);
});

test("a select with readable options lists the refs that fit an option, and only those count", async () => {
  const resume = [
    { group: "基本信息", key: "政治面貌", value: "共青团员" }, { group: "基本信息", key: "民族", value: "汉族" },
    { group: "基本信息", key: "出生日期", value: "2001-05-09" }, { group: "教育经历", key: "学历", value: "硕士研究生" }
  ];
  const env = worker((message, catalog) => {
    const ref = (key) => catalog.find((entry) => entry.key === key).ref;
    return [
      { fieldId: "politics", ref: ref("民族") },
      { fieldId: "politics", ref: ref("政治面貌") },
      { fieldId: "month", ref: ref("出生日期"), part: "month" },
      { fieldId: "year", ref: `${ref("出生日期")}.year` }
    ];
  });
  const result = await env.run({
    formFields: [
      { fieldId: "politics", label: "政治面貌", inputType: "select", options: ["请选择", "中共党员", "团员", "群众"] },
      { fieldId: "year", label: "出生年份", inputType: "select", options: ["1999年", "2000年", "2001年", "2002年"] },
      { fieldId: "month", label: "出生月份", inputType: "select", options: ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"] },
      { fieldId: "card", label: "银行卡类型", inputType: "radio", options: ["借记卡", "信用卡"] }
    ],
    resumeFields: resume
  });
  const fields = fieldsOf(env.calls[0]);
  const refs = catalogOf(env.calls[0].user);
  const ref = (key) => refs.find((entry) => entry.key === key).ref;
  assert.deepEqual(fields.find((field) => field.fieldId === "politics").fits, [ref("政治面貌")]);
  assert.deepEqual(fields.find((field) => field.fieldId === "year").fits, [`${ref("出生日期")}.year`]);
  assert.deepEqual(fields.find((field) => field.fieldId === "month").fits, [`${ref("出生日期")}.month`]);
  // 没有一项资料填得进的单选不发，记作没有对应的资料，不报警告。
  assert.equal(fields.some((field) => field.fieldId === "card"), false);
  assert.equal(result.diagnostics.skippedNoContext, 1);
  assert.equal(result.warning, "");
  // 挑了 fits 以外的（民族）不算；同一题后面那条照常。
  assert.equal(valueOf(result, "politics"), "共青团员");
  assert.equal(valueOf(result, "year"), "2001年");
  assert.equal(valueOf(result, "month"), "5月");
});

test("date parts follow the question for a span and the option spelling", () => {
  const months = { label: "毕业月份", options: ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"] };
  assert.equal(helpers.datePart("2019.09-2023.06", "month", months), "06");
  assert.equal(helpers.datePart("2019.09-2023.06", "year", { label: "入学年份" }), "2019");
  assert.equal(helpers.datePart("2019.09-2023.06", "year", { label: "在校年份" }), "", "a span the question does not pick a side of");
  assert.equal(helpers.datePart("2001年5月9日", "day", { label: "日", options: ["1", "2", "9", "10"] }), "9");
  assert.equal(helpers.datePart("2001", "year", { label: "出生年份" }), "2001");
  assert.equal(helpers.datePart("硕士研究生", "year", { label: "毕业年份" }), "");
});

test("an open question the resume has no answer to is counted on its own", async () => {
  const env = worker((message, catalog) => [{ fieldId: "intro", ref: catalog.find((entry) => entry.key === "自我评价").ref }]);
  const result = await env.run({
    formFields: [
      { fieldId: "intro", label: "自我评价", tagName: "textarea", inputType: "textarea" },
      { fieldId: "plan", label: "未来三年的职业规划", tagName: "textarea", inputType: "textarea" },
      { fieldId: "hobby", label: "兴趣爱好" }
    ],
    resumeFields: [{ group: "其他", key: "自我评价", value: "踏实认真" }, { group: "基本信息", key: "姓名", value: "测试用户" }]
  });
  assert.equal(valueOf(result, "intro"), "踏实认真");
  assert.equal(result.diagnostics.openUnanswered, 1);
  assert.equal(result.diagnostics.aiMatches, 1);
});

test("the old value prompt lives only in the eval script, which replaces handleAiFill after the worker", async () => {
  const resume = [{ group: "教育经历", key: "学校", value: "虚构理工学院" }];
  const env = worker(() => [{ fieldId: "school", value: "虚构理工学院" }], { legacy: true });
  const result = await env.run({ formFields: [{ fieldId: "school", label: "毕业院校" }], resumeFields: resume });
  assert.match(env.calls[0].user, /虚构理工学院/);
  assert.match(env.calls[0].system, /应该填写什么值/);
  assert.equal(valueOf(result, "school"), "虚构理工学院");
  assert.equal(refOf(env.calls[0].user, "学校"), undefined, "no catalog in the old prompt");
});

test("every script the worker imports is packed, the region data included", async () => {
  const { PLUGIN_ARCHIVE_OPERANDS } = await import(pathToFileURL(path.join(__dirname, "..", "desktop", "scripts", "pack-plugin.js")).href);
  const imported = [...source.match(/importScripts\(([^)]*)\)/)[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(imported.includes("region-data.js"));
  for (const file of imported) assert.ok(PLUGIN_ARCHIVE_OPERANDS.includes(file), `${file} is packed`);
});

test("the shipped worker has no old value prompt and no switch, and the eval script is not packed", async () => {
  assert.doesNotMatch(source, /ResumeProEvalValuePrompt|LEGACY_SYSTEM_PROMPT|buildLegacyUserPrompt|应该填写什么值/);
  assert.equal("selectResumeCandidates" in helpers, false);
  const { PLUGIN_ARCHIVE_OPERANDS } = await import(pathToFileURL(path.join(__dirname, "..", "desktop", "scripts", "pack-plugin.js")).href);
  assert.ok(PLUGIN_ARCHIVE_OPERANDS.includes("ai-worker.js"));
  assert.equal(PLUGIN_ARCHIVE_OPERANDS.some((entry) => entry === "scripts" || entry.startsWith("scripts/")), false);
  const { assertPluginOnlyArchive } = await import(pathToFileURL(path.join(__dirname, "..", "desktop", "scripts", "check-plugin-release-allowlist.js")).href);
  const packed = ["manifest.json", "background.js", "content.js", "content.css", "LICENSE", "ai-worker.js"];
  assert.doesNotThrow(() => assertPluginOnlyArchive(packed));
  assert.throws(() => assertPluginOnlyArchive([...packed, "scripts/eval-fill-legacy.js"]), /scripts\/eval-fill-legacy\.js/);
});

test("a parsed key whose school name was edited afterwards still leaves the old name out", async () => {
  const env = worker();
  await env.run({
    formFields: [{ fieldId: "school", label: "毕业院校" }],
    resumeFields: [{ group: "教育经历", key: "旧虚构学院教育经历-学校", value: "新虚构学院" }, { group: "教育经历", key: "旧虚构学院教育经历-专业", value: "虚构专业" },
      { group: "补充字段", key: "请描述你的实习经历-收获", value: "收获很多" }]
  });
  assert.ok(!env.calls[0].user.includes("旧虚构学院"));
  assert.deepEqual(catalogOf(env.calls[0].user).map((entry) => entry.key), ["教育经历1-学校", "教育经历1-专业", "请描述你的实习经历-收获"]);
});

test("an edited English school name longer than 18 characters is left out of the catalog too", async () => {
  const env = worker();
  const school = "Massachusetts Institute of Technology";
  await env.run({
    formFields: [{ fieldId: "school", label: "毕业院校" }],
    resumeFields: [{ group: "教育经历", key: `${school}教育经历-学校`, value: "MIT" }, { group: "教育经历", key: `${school}教育经历-专业`, value: "虚构专业" }]
  });
  assert.ok(!env.calls[0].user.includes("Massachusetts"));
  assert.deepEqual(catalogOf(env.calls[0].user).map((entry) => entry.key), ["教育经历1-学校", "教育经历1-专业"]);
});

test("a school name written with other punctuation or spaces in the key is still left out", async () => {
  const env = worker();
  await env.run({
    formFields: [{ fieldId: "school", label: "毕业院校" }],
    resumeFields: [{ group: "教育经历", key: "虚构理工大学（南校区） 教育经历-学校", value: "虚构理工大学(南校区)" },
      { group: "实习经历", key: "Fictional Ltd., Shenzhen实习经历-公司", value: "fictional ltd shenzhen" }]
  });
  assert.ok(!/虚构理工|南校区|Fictional/i.test(env.calls[0].user));
  assert.deepEqual(catalogOf(env.calls[0].user).map((entry) => entry.key), ["教育经历1-学校", "实习经历1-公司"]);
});

test("two entries at one school, or two schools alike in their first 18 characters, get their own numbers", async () => {
  const env = worker();
  await env.run({
    formFields: [{ fieldId: "school", label: "毕业院校" }],
    resumeFields: helpers.semanticizeParsedFields([
      { group: "教育经历", key: "教育1学校", value: "虚构理工大学" }, { group: "教育经历", key: "教育1学历", value: "本科" },
      { group: "教育经历", key: "教育2学校", value: "虚构理工大学" }, { group: "教育经历", key: "教育2学历", value: "硕士" },
      { group: "教育经历", key: "教育3学校", value: "Fictional Institute of Technology" }, { group: "教育经历", key: "教育3专业", value: "CS" },
      { group: "教育经历", key: "教育4学校", value: "Fictional Institute of Teaching" }, { group: "教育经历", key: "教育4专业", value: "Ed" }])
  });
  assert.deepEqual(catalogOf(env.calls[0].user).map((entry) => entry.key),
    ["教育经历1-学校", "教育经历1-学历", "教育经历2-学校", "教育经历2-学历", "教育经历3-学校", "教育经历3-专业", "教育经历4-学校", "教育经历4-专业"]);
});

test("two long saved questions alike in their first 60 characters stay apart in the catalog", async () => {
  const head = "请结合你过去的实习或项目经历，详细说明你在团队合作中遇到分歧时是如何沟通、协调并最终推动问题解决的，并说明你在其中承担的具体角色，";
  assert.ok(head.length > 60);
  const env = worker();
  await env.run({
    formFields: [{ fieldId: "q", label: "团队合作" }],
    resumeFields: [{ group: "本网站回答", key: `${head}请举一个具体例子说明结果`, value: "回答一" },
      { group: "本网站回答", key: `${head}以及你从中学到了什么`, value: "回答二" }, { group: "补充字段", key: "备注", value: "无" }, { group: "补充字段", key: "备注", value: "有" }]
  });
  const keys = catalogOf(env.calls[0].user).map((entry) => entry.key);
  assert.equal(new Set(keys).size, keys.length, keys.join(" | "));
  assert.ok(keys[0].endsWith("请举一个具体例子说明结果") && keys[1].endsWith("以及你从中学到了什么"), keys.join(" | "));
  assert.deepEqual(keys.slice(2), ["备注", "备注（2）"]);
});

test("outside experience groups another field's value in a key becomes a placeholder, and a parsed entry of its own is renamed", async () => {
  const env = worker();
  await env.run({
    formFields: [{ fieldId: "q", label: "户口类型" }],
    resumeFields: [{ group: "基本信息", key: "现居城市", value: "虚构城" }, { group: "基本信息", key: "虚构城户口信息-类型", value: "集体户" },
      ...helpers.semanticizeParsedFields([{ group: "获奖情况", key: "奖项1名称", value: "虚构奖学金" }, { group: "获奖情况", key: "奖项1级别", value: "校级" }])]
  });
  assert.deepEqual(catalogOf(env.calls[0].user).map((entry) => entry.key), ["现居城市", "〔现居城市〕户口信息-类型", "奖项信息1-名称", "奖项信息1-级别"]);
  assert.ok(!/虚构城|虚构奖学金/.test(env.calls[0].user));
});

test("short common words stay in the questions; a value with digits, of four or more characters or of a name, school or city is masked", () => {
  const keys = helpers.catalogKeys([
    { group: "家庭主要成员", key: "父亲关系", value: "父亲" }, { group: "家庭主要成员", key: "父亲姓名", value: "欧阳虚父" },
    { group: "基本信息", key: "健康状况", value: "健康" }, { group: "本网站回答", key: "是否愿意接受轮岗", value: "愿意" },
    { group: "本网站回答", key: "调剂意向", value: "服从" }, { group: "本网站回答", key: "是否服从分配", value: "是" },
    { group: "教育经历", key: "专业简称", value: "CS" }, { group: "补充字段", key: "physics 成绩", value: "优" },
    { group: "教育经历", key: "毕业年份", value: "2023" }, { group: "本网站回答", key: "2023届校招意向城市", value: "虚构城" },
    { group: "基本信息", key: "年龄", value: "22" }, { group: "本网站回答", key: "2022届生源地", value: "无" },
    { group: "基本信息", key: "姓名", value: "欧阳虚构" }, { group: "本网站回答", key: "欧阳虚构的推荐人（姓名）", value: "无" },
    { group: "本网站回答", key: "请写下你最想去的城市以及原因，越详细越好，至少写二十个字", value: "虚构港" },
    { group: "本网站回答", key: "虚构港附近的网点", value: "无" },
    { group: "基本信息", key: "现居城市", value: "深城" }, { group: "本网站回答", key: "深城户口", value: "否" }
  ]);
  // 短常用词（父亲、健康、愿意、服从、CS）留在题目里。
  assert.deepEqual(keys.slice(0, 8), ["父亲关系", "父亲姓名", "健康状况", "是否愿意接受轮岗", "调剂意向", "是否服从分配", "专业简称", "physics 成绩"]);
  // 带数字的要换；不到 5 位的数字不算更长一串数字里的一段。
  assert.equal(keys[9], "〔毕业年份〕届校招意向城市");
  assert.equal(keys[11], "2022届生源地");
  // 人名、城市再短也换；给出值的那项字段名太长时用「资料值」。
  assert.equal(keys[13], "〔姓名〕的推荐人（姓名）");
  assert.equal(keys[15], "〔资料值〕附近的网点", "a long owner name is not used as the placeholder");
  assert.equal(keys[17], "〔现居城市〕户口");
});

test("the catalog sent out has no identifying value in any key or group name, wherever it sits", async () => {
  const resume = [
    // 两项资料是同样的字，一项写在自己的字段名里：那一处和别处都换。
    { group: "补充字段", key: "现居城市（虚构港）", value: "虚构港" }, { group: "本网站回答", key: "期望城市", value: "虚构港" },
    { group: "本网站回答", key: "在虚构港的住处", value: "租房" },
    // 用户自己起的分组名是公司名。
    { group: "工作经历", key: "工作经历1-公司", value: "虚构星辰科技" }, { group: "虚构星辰科技", key: "职位", value: "管培岗位" },
    // 短英文值紧挨着字母、数字。
    { group: "实习经历", key: "实习经历1-公司", value: "IBM" }, { group: "本网站回答", key: "IBMer推荐码2024", value: "暂未获得" }
  ];
  const env = worker();
  await env.run({ formFields: [{ fieldId: "city", label: "期望城市" }], resumeFields: resume });
  const catalog = catalogOf(env.calls[0].user);
  assert.ok(!/虚构港|虚构星辰科技|IBM/i.test(JSON.stringify(catalog)), JSON.stringify(catalog));
  const key = (at) => catalog[at].key;
  assert.deepEqual([key(0), key(2), key(6)], ["现居城市（〔资料值〕）", "在〔期望城市〕的住处", "〔实习经历1-公司〕er推荐码2024"]);
  assert.equal(catalog[4].group, "〔工作经历1-公司〕");
});

test("a name of two characters from any name field is masked wherever it appears", async () => {
  const resume = [
    { group: "家庭主要成员", key: "母亲姓名", value: "周丽" }, { group: "基本信息", key: "曾用名", value: "林舟" },
    { group: "家庭主要成员", key: "紧急联系人", value: "林强" }, { group: "家庭主要成员", key: "紧急联系人关系", value: "父亲" },
    { group: "本网站回答", key: "周丽女士是否在本单位工作", value: "否" }, { group: "本网站回答", key: "林舟这个名字用到哪一年", value: "高中" },
    { group: "林强推荐", key: "推荐岗位", value: "管培" }
  ];
  const env = worker();
  await env.run({ formFields: [{ fieldId: "q", label: "其他说明" }], resumeFields: resume });
  const catalog = catalogOf(env.calls[0].user);
  assert.ok(!/周丽|林舟|林强/.test(JSON.stringify(catalog)), JSON.stringify(catalog));
  assert.deepEqual(catalog.slice(4).map((entry) => entry.key), ["〔母亲姓名〕女士是否在本单位工作", "〔曾用名〕这个名字用到哪一年", "推荐岗位"]);
  assert.equal(catalog[6].group, "〔紧急联系人〕推荐");
  assert.equal(catalog[3].key, "紧急联系人关系", "a relation like 父亲 stays");
});

test("a generated label holding regex characters neither throws nor leaves a value in the catalog", () => {
  const changed = fs.readFileSync(path.join(__dirname, "..", "ai-helpers.js"), "utf8").replace('label: "论文" }', 'label: "论文(+" }');
  assert.notEqual(changed, fs.readFileSync(path.join(__dirname, "..", "ai-helpers.js"), "utf8"));
  const scope = {};
  vm.runInNewContext(changed, { self: scope });
  const masked = scope.ResumeProAIHelpers.maskResumeValues(["论文(+1-发表于虚构理工学院学报"], [{ group: "教育经历", key: "学校", value: "虚构理工学院" }]);
  assert.deepEqual(masked, ["论文(+1-发表于〔资料值〕学报"]);
});

test("a gender initial counts only when the field really offers it", () => {
  assert.equal(helpers.isValueValidForField({ label: "性别", inputType: "select", options: ["M", "F"] }, "F"), true);
  // 选项写成 Male、Female 时，「M」两项都沾边、页面上选不上；「F」页面会选 Female，照样算。
  assert.equal(helpers.isValueValidForField({ label: "性别", inputType: "select", options: ["Male", "Female"] }, "M"), false);
  assert.equal(helpers.isValueValidForField({ label: "性别", inputType: "select", options: ["男", "女"] }, "F"), false);
  assert.equal(helpers.isValueValidForField({ label: "性别", inputType: "select", options: [] }, "F"), false, "options shown only when opened are left to the fill");
  assert.equal(helpers.isValueValidForField({ label: "性别", inputType: "select", options: [] }, "女"), true);
});

test("one ref given twice is used once, a text answer of more than three items says why, and an unknown level of linked selects takes the whole region", async () => {
  const env = worker((message, catalog) => [
    { fieldId: "cities", refs: [catalog[0].ref, catalog[0].ref] },
    { fieldId: "job", refs: catalog.slice(1, 5).map((entry) => entry.ref) },
    { fieldId: "home", ref: catalog[5].ref }
  ]);
  const result = await env.run({
    formFields: [{ fieldId: "cities", label: "意向城市", inputType: "select", multiple: true, options: [] },
      { fieldId: "job", label: "工作单位及职务" },
      { fieldId: "home", label: "常住地", inputType: "select", cascadeGroup: "group-0", options: ["请选择"] }],
    resumeFields: [{ group: "求职意向", key: "期望城市", value: "虚构港" },
      { group: "工作经历", key: "工作经历1-公司", value: "甲公司" }, { group: "工作经历", key: "工作经历1-职务", value: "专员" },
      { group: "工作经历", key: "工作经历1-部门", value: "市场部" }, { group: "工作经历", key: "工作经历1-地点", value: "乙城" },
      { group: "户籍与地区", key: "现居住地", value: "广东省深圳市南山区" }]
  });
  const byId = Object.fromEntries(JSON.parse(JSON.stringify(result.matches)).map((match) => [match.fieldId, match]));
  assert.equal(byId.cities.value, "虚构港");
  assert.deepEqual(byId.job, { fieldId: "job", value: "", blocked: "too_many_items" });
  assert.deepEqual(byId.home, { fieldId: "home", value: "广东省深圳市南山区", note: "region_level_unknown" });
  assert.equal(result.diagnostics.regionLevelUnknown, 1);
});

test("a value across the 60th character of a long key is masked before the key is cut, so no part of it goes out", async () => {
  const head = "请结合你在".padEnd(57, "甲");
  const school = "虚构理工大学附属实验学校";
  const env = worker();
  await env.run({ formFields: [{ fieldId: "q", label: "其他说明" }], resumeFields: [{ group: "教育经历", key: "学校", value: school },
    { group: "本网站回答", key: `${head}${school}的学习经历中最难忘的一件事是什么`, value: "暂无可说" }] });
  const sent = env.calls[0].user;
  for (let length = 2; length <= school.length; length += 1) assert.ok(!sent.includes(school.slice(0, length)), school.slice(0, length));
  assert.equal(catalogOf(sent)[1].key, `${head}…`, "the cut leaves no half placeholder");
});

test("no value of the eval resume is in its catalog but a few short common words", async () => {
  const { loadCorpus } = await import(pathToFileURL(path.join(__dirname, "..", "scripts", "eval-fill.mjs")).href);
  const corpus = loadCorpus();
  const env = worker();
  await env.run({ formFields: [{ fieldId: "intro", label: "自我评价", tagName: "textarea", inputType: "textarea" }], resumeFields: corpus.resumeFields });
  const text = JSON.stringify(catalogOf(env.calls[0].user));
  const values = [...new Set(corpus.resumeFields.map((field) => String(field.value ?? "").trim()).filter(Boolean))];
  const left = values.filter((value) => text.includes(value)).sort();
  assert.deepEqual(left, ["健康", "否", "是", "愿意", "母亲", "父亲"].sort());
});

test("an edited school name written two ways in two keys of one entry still gets one number", async () => {
  const env = worker();
  await env.run({
    formFields: [{ fieldId: "school", label: "毕业院校" }],
    resumeFields: [{ group: "教育经历", key: "旧虚构学院（南校区）教育经历-学校", value: "新虚构学院" },
      { group: "教育经历", key: "旧虚构学院(南校区) 教育经历-专业", value: "虚构专业" }]
  });
  assert.deepEqual(catalogOf(env.calls[0].user).map((entry) => entry.key), ["教育经历1-学校", "教育经历1-专业"]);
});

test("a key in an experience group that starts with a school name is renamed whatever label follows", async () => {
  const env = worker();
  await env.run({
    formFields: [{ fieldId: "role", label: "社团职务" }],
    resumeFields: [{ group: "校园经历", key: "虚构理工学院社团经历-组织", value: "虚构理工学院" }, { group: "校园经历", key: "虚构理工学院社团经历-职位", value: "社长" }]
  });
  assert.ok(!env.calls[0].user.includes("虚构理工学院"));
  assert.deepEqual(catalogOf(env.calls[0].user).map((entry) => entry.key), ["校园经历1-社团经历-组织", "校园经历1-社团经历-职位"]);
});

test("the catalog names the latest of several spans in a group and the other names of a profile field", async () => {
  const env = worker();
  await env.run({
    formFields: [{ fieldId: "company", label: "最近一段实习的公司" }],
    resumeFields: [
      { group: "实习经历", key: "实习经历1-时间", value: "2024.07-2024.08" }, { group: "实习经历", key: "实习经历1-公司", value: "甲公司" },
      { group: "实习经历", key: "实习经历2-时间", value: "2025.06-至今" }, { group: "实习经历", key: "实习经历2-公司", value: "乙公司" },
      { group: "教育经历", key: "教育经历1-时间", value: "2019.09-2023.06" },
      { group: "户籍与地区", key: "现居住地", value: "虚构省虚构市" }
    ]
  });
  const catalog = catalogOf(env.calls[0].user);
  const entry = (key) => catalog.find((item) => item.key === key);
  assert.equal(entry("实习经历2-时间").shape, "起止日期，本组最近一段");
  assert.equal(entry("实习经历1-时间").shape, "起止日期");
  assert.equal(entry("教育经历1-时间").shape, "起止日期", "a single span is not marked");
  assert.deepEqual(entry("现居住地").aka, ["现住址", "居住地址", "通讯地址"]);
  // 别的叫法按 PROFILE_SCHEMA 的内容建：换了一份、原地改了，都按新的给，不留旧的。
  env.context.ResumeProProfile = { ...env.context.ResumeProProfile, PROFILE_SCHEMA: [{ fields: [{ key: "现居住地", label: "常住地址" }] }] };
  await env.run({ formFields: [{ fieldId: "home", label: "常住地址" }], resumeFields: [{ group: "户籍与地区", key: "现居住地", value: "虚构省虚构市" }] });
  assert.deepEqual(catalogOf(env.calls[1].user).find((item) => item.key === "现居住地").aka, ["常住地址"]);
  env.context.ResumeProProfile.PROFILE_SCHEMA[0].fields[0].aliases = ["暂住地址"];
  await env.run({ formFields: [{ fieldId: "home", label: "暂住地址" }], resumeFields: [{ group: "户籍与地区", key: "现居住地", value: "虚构省虚构市" }] });
  assert.deepEqual(catalogOf(env.calls[2].user).find((item) => item.key === "现居住地").aka, ["常住地址", "暂住地址"]);
});

test("a cascade without the region data in the worker reports it instead of taking a whole address", async () => {
  const env = worker((message, catalog) => [{ fieldId: "city", ref: catalog[0].ref }], { withRegions: false });
  const result = await env.run({
    formFields: [{ fieldId: "city", label: "现居住城市", inputType: "select", cascade: true, options: [] }],
    resumeFields: [{ group: "户籍与地区", key: "现居住地", value: "广东省深圳市南山区粤海街道科苑路 8 号" }]
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result.matches)), [{ fieldId: "city", value: "", blocked: "region_unavailable" }]);
});

test("a path split by slashes keeps only the places it can read, and other paths go as they are", async () => {
  const env = worker((message, catalog) => [{ fieldId: "city", ref: catalog[0].ref }, { fieldId: "major", ref: catalog[1].ref }]);
  const result = await env.run({
    formFields: [{ fieldId: "city", label: "现居住城市", inputType: "select", cascade: true, options: [] },
      { fieldId: "major", label: "专业类别", inputType: "select", cascade: true, options: [] }],
    resumeFields: [{ group: "户籍与地区", key: "现居住地", value: "广东省/深圳市/南山区/科苑路8号" }, { group: "教育经历", key: "专业类别", value: "工学/计算机类/软件工程" }]
  });
  assert.equal(valueOf(result, "city"), "广东省/深圳市/南山区");
  assert.equal(valueOf(result, "major"), "工学/计算机类/软件工程");
});

test("a slashed address left with only its province goes to no cascade, and a level missing from it is reported", async () => {
  const env = worker((message, catalog) => ["city", "province", "town"].map((fieldId) => ({ fieldId, ref: catalog[0].ref })));
  const result = await env.run({
    formFields: [{ fieldId: "city", label: "现居住城市", inputType: "select", cascade: true, options: [] },
      { fieldId: "province", label: "现居住地", inputType: "select", cascadeGroup: "group-0", cascadeLevel: 0, options: ["请选择", "广东省", "湖南省"] },
      { fieldId: "town", label: "现居住地", inputType: "select", cascadeGroup: "group-0", cascadeLevel: 1, options: ["请选择"] }],
    resumeFields: [{ group: "户籍与地区", key: "现居住地", value: "广东省/科苑路8号" }]
  });
  const byId = Object.fromEntries(JSON.parse(JSON.stringify(result.matches)).map((match) => [match.fieldId, match]));
  assert.deepEqual(byId.city, { fieldId: "city", value: "", blocked: "region_too_coarse" });
  assert.equal(byId.province.value, "广东省", "a linked province select still takes the province");
  assert.deepEqual(byId.town, { fieldId: "town", value: "", blocked: "region_level_missing" });
});

test("an address with street, postcode or brackets after it goes to a cascade as its region part only", async () => {
  const values = ["北京市海淀区中关村大街1号", "广东省 深圳市 南山区 科苑路8号", "深圳市南山区 518000", "广东省深圳市南山区（科技园）"];
  const env = worker((message, catalog) => catalog.map((entry, at) => ({ fieldId: `c${at}`, ref: entry.ref })));
  const result = await env.run({
    formFields: values.map((_, at) => ({ fieldId: `c${at}`, label: "现居住城市", inputType: "select", cascade: true, options: [] })),
    resumeFields: values.map((value, at) => ({ group: "户籍与地区", key: `地址${at}`, value }))
  });
  assert.deepEqual(values.map((_, at) => valueOf(result, `c${at}`)), ["北京市海淀区", "广东省 深圳市 南山区", "深圳市南山区", "广东省深圳市南山区"]);
});

test("a cascade given only a province is not filled; a city or a municipality is", async () => {
  const env = worker((message, catalog) => catalog.map((entry, at) => ({ fieldId: `c${at}`, ref: entry.ref })));
  const result = await env.run({
    formFields: [0, 1, 2].map((at) => ({ fieldId: `c${at}`, label: "所在城市", inputType: "select", cascade: true, options: [] })),
    resumeFields: [{ group: "求职意向", key: "意向省份", value: "广东省" }, { group: "求职意向", key: "意向城市", value: "深圳市" },
      { group: "求职意向", key: "备选城市", value: "北京市" }]
  });
  const byId = Object.fromEntries(JSON.parse(JSON.stringify(result.matches)).map((match) => [match.fieldId, match]));
  assert.deepEqual(byId.c0, { fieldId: "c0", value: "", blocked: "region_too_coarse" });
  assert.equal(byId.c1.value, "深圳市");
  assert.equal(byId.c2.value, "北京市", "a municipality is a city itself");
});

test("answers that disagree keep the first reason one of them was stopped for", async () => {
  const env = worker((message, catalog) => [{ fieldId: "start", ref: catalog[0].ref }, { fieldId: "start", ref: catalog[1].ref }]);
  const result = await env.run({
    formFields: [{ fieldId: "start", label: "到岗日期", inputType: "date", options: [] }],
    resumeFields: [{ group: "补充字段", key: "到岗时间", value: "2026.07.01" }, { group: "补充字段", key: "最早到岗", value: "随时" }]
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result.matches)), [{ fieldId: "start", value: "", blocked: "invalid_date" }]);
});

test("more items than a field can take are not filled and the reason is kept", async () => {
  const resume = Array.from({ length: 22 }, (_, i) => ({ group: "技能", key: `技能${i}`, value: `技能项${i}` }));
  const env = worker((message, catalog) => [
    { fieldId: "skills", refs: catalog.slice(0, 21).map((entry) => entry.ref) }, { fieldId: "some", refs: catalog.slice(0, 20).map((entry) => entry.ref) },
    { fieldId: "text", refs: catalog.slice(0, 9).map((entry) => entry.ref) }
  ]);
  const result = await env.run({
    formFields: [{ fieldId: "skills", label: "掌握的技能", inputType: "select", multiple: true, options: [] },
      { fieldId: "some", label: "其他技能", inputType: "select", multiple: true, options: [] }, { fieldId: "text", label: "技能和证书" }],
    resumeFields: resume
  });
  const byId = Object.fromEntries(JSON.parse(JSON.stringify(result.matches)).map((match) => [match.fieldId, match]));
  assert.deepEqual(byId.skills, { fieldId: "skills", value: "", blocked: "too_many_items" });
  assert.equal(byId.some.value.split("、").length, 20);
  assert.deepEqual(byId.text, { fieldId: "text", value: "", blocked: "too_many_items" });
});

test("a cascade keeps the region at the head of a whole address, and a level of linked selects gets only its own place", async () => {
  const env = worker((message, catalog) => ["city", "text", "province", "town", "district"].map((fieldId) => ({ fieldId, ref: catalog[0].ref })));
  const result = await env.run({
    formFields: [{ fieldId: "city", label: "现居住城市", inputType: "select", cascade: true, options: [] }, { fieldId: "text", label: "通讯地址" },
      { fieldId: "province", label: "现居住地", inputType: "select", cascadeGroup: "group-0", cascadeLevel: 0, options: ["请选择", "广东省", "湖南省"] },
      { fieldId: "town", label: "现居住地", inputType: "select", cascadeGroup: "group-0", cascadeLevel: 1, options: ["请选择"] },
      { fieldId: "district", label: "区县", inputType: "select", cascadeGroup: "group-0", cascadeLevel: 1, options: ["请选择"] }],
    resumeFields: [{ group: "户籍与地区", key: "现居住地", value: "广东省深圳市南山区粤海街道科苑路 8 号" }]
  });
  assert.equal(valueOf(result, "city"), "广东省深圳市南山区");
  // 联动下拉每一级只给这一级的地名：没写是哪一级的按 cascadeLevel，题目写了的按题目（「区县」排在第二级也是区县）。
  assert.equal(valueOf(result, "province"), "广东省");
  assert.equal(valueOf(result, "town"), "深圳市");
  assert.equal(valueOf(result, "district"), "南山区");
  assert.equal(valueOf(result, "text"), "广东省深圳市南山区粤海街道科苑路 8 号", "a text field keeps the whole address");
});

test("a very long saved question is cut in the catalog, so it does not push its batch over the budget", async () => {
  const env = worker((message, catalog) => [{ fieldId: "school", ref: catalog.find((entry) => entry.key === "学校").ref }]);
  const result = await env.run({
    formFields: [{ fieldId: "school", label: "毕业院校" }],
    resumeFields: [{ group: "本网站回答", key: "请详细描述".repeat(8000), value: "很长的回答" }, { group: "教育经历", key: "学校", value: "虚构大学" }]
  });
  assert.equal(env.calls.length, 1);
  assert.equal(result.diagnostics.skippedOversized, 0);
  assert.equal(result.warning, "");
  assert.equal(valueOf(result, "school"), "虚构大学");
  assert.equal(catalogOf(env.calls[0].user)[0].key.length, 61);
});

test("computer levels and English yes or no are the same option in other words", () => {
  const levels = ["请选择", "全国计算机等级一级", "全国计算机等级二级", "全国计算机等级三级"];
  assert.equal(helpers.findSelectOptionIndex(levels, "全国计算机等级考试二级"), 2);
  assert.equal(helpers.findSelectOptionIndex(["Yes", "No"], "是"), 0);
  assert.equal(helpers.findSelectOptionIndex(["Yes", "No"], "否"), 1);
});

test("a select of bare numbers takes only items with the same number, not numbers hidden in an ID or a phone", async () => {
  const env = worker();
  await env.run({
    formFields: [
      { fieldId: "year", label: "出生年份", inputType: "select", options: ["请选择", "1999", "2000", "2001"] },
      { fieldId: "days", label: "每周实习天数", inputType: "select", options: ["3", "4", "5"] },
      { fieldId: "unit", label: "每周到岗天数", inputType: "select", options: ["3天", "4天", "5天"] }
    ],
    resumeFields: [{ group: "基本信息", key: "出生日期", value: "2000-03-17" }, { group: "基本信息", key: "证件号码", value: "430181200003170022" },
      { group: "补充字段", key: "微信号", value: "lin_2000" }, { group: "补充字段", key: "每周可实习天数", value: "5" }]
  });
  const fields = fieldsOf(env.calls[0]);
  const refs = catalogOf(env.calls[0].user);
  const ref = (key) => refs.find((entry) => entry.key === key).ref;
  assert.deepEqual(fields.find((field) => field.fieldId === "year").fits, [`${ref("出生日期")}.year`]);
  assert.deepEqual(fields.find((field) => field.fieldId === "days").fits, [ref("每周可实习天数")]);
  assert.deepEqual(fields.find((field) => field.fieldId === "unit").fits, [ref("每周可实习天数")], "a unit after the number does not count");
});

test("a value over 100 characters is matched against long options, and skipped only when every option is short", async () => {
  const pledge = "本人承诺所填写的全部信息真实、准确、完整，如有虚假，愿意承担由此产生的一切后果，并同意招聘单位在录用前对所填信息进行核实，核实发现不实的，招聘单位可以取消录用资格且不承担任何责任；入职以后发现的，可以解除劳动合同，本人不提出任何异议。";
  assert.ok(pledge.length > 100);
  const env = worker();
  await env.run({
    formFields: [
      { fieldId: "pledge", label: "诚信承诺", inputType: "radio", options: [pledge, "不同意"] },
      { fieldId: "short", label: "承诺", inputType: "select", options: ["同意", "不同意"] }
    ],
    resumeFields: [{ group: "本网站回答", key: "诚信承诺", value: pledge }]
  });
  const fields = fieldsOf(env.calls[0]);
  assert.deepEqual(fields.find((field) => field.fieldId === "pledge").fits, [refOf(env.calls[0].user, "诚信承诺")]);
  assert.equal(fields.some((field) => field.fieldId === "short"), false, "a long value lands on no short option");
});
