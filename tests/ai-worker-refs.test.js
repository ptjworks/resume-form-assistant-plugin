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
const regions = (() => {
  const scope = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "region-data.js"), "utf8"), { self: scope });
  return scope.ResumeProRegions;
})();

// respond(message, catalog) 返回 AI 的回答（数组或文字）；legacy 打开评测脚本用的旧发值方式。
function worker(respond = () => [], { legacy = false } = {}) {
  const calls = [];
  let sequence = 0;
  const context = vm.createContext({
    importScripts() {}, ResumeProAIHelpers: helpers, ResumeProProfile: require("../profile-fields.js"),
    AbortController, TextEncoder, performance: { now: () => 0 }, crypto: { randomUUID: () => `call-${++sequence}` },
    ResumeProRegions: regions,
    ...(legacy ? { ResumeProEvalValuePrompt: true } : {})
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
  vm.runInContext(source, context);
  return { calls, run: async (input) => JSON.parse(JSON.stringify(await context.handleAiFill(input))) };
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
    { group: "本网站回答", key: "期望工作城市", value: "虚构城" }
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
  assert.equal(valueOf(result, "span"), undefined, "a span the question picks no side of is not filled");
  assert.equal(valueOf(result, "birth"), "2026-07-01");
  assert.equal(valueOf(result, "birthMonth"), "2026-07");
  assert.equal(valueOf(result, "until"), "至今");
});

test("an open question about motives or plans takes only a saved answer or an item named like it", async () => {
  const resume = [{ group: "求职补充", key: "期望工作地点", value: "虚构城" }, { group: "自我评价", key: "自我评价", value: "踏实认真" },
    { group: "补充字段", key: "为什么想加入我们", value: "认同虚构公司的产品" }, { group: "工作经历", key: "工作经历1-离职原因", value: "合同到期" }];
  const env = worker((message, catalog) => {
    const ref = (key) => catalog.find((entry) => entry.key === key).ref;
    return [
      { fieldId: "why", ref: ref("期望工作地点") }, { fieldId: "whyEn", ref: ref("自我评价") }, { fieldId: "strength", ref: ref("自我评价") },
      { fieldId: "saved", ref: ref("为什么想加入我们") }, { fieldId: "leave", ref: ref("工作经历1-离职原因") }, { fieldId: "intro", ref: ref("自我评价") }
    ];
  });
  const textarea = (fieldId, label) => ({ fieldId, label, tagName: "textarea", inputType: "textarea" });
  const result = await env.run({
    formFields: [textarea("why", "为什么选择我们公司"), textarea("whyEn", "Why do you want to join us?"), textarea("strength", "你的优势和不足"),
      textarea("saved", "你为什么想加入本公司"), textarea("leave", "离职原因"), textarea("intro", "个人简介")],
    resumeFields: resume
  });
  assert.deepEqual(result.matches.map((match) => match.fieldId).sort(), ["intro", "leave", "saved"]);
  assert.equal(valueOf(result, "saved"), "认同虚构公司的产品");
  assert.equal(result.diagnostics.openUnanswered, 3);
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

test("the old value prompt is still there for the eval script, behind a global the extension never sets", async () => {
  const resume = [{ group: "教育经历", key: "学校", value: "虚构理工学院" }];
  const env = worker(() => [{ fieldId: "school", value: "虚构理工学院" }], { legacy: true });
  const result = await env.run({ formFields: [{ fieldId: "school", label: "毕业院校" }], resumeFields: resume });
  assert.match(env.calls[0].user, /虚构理工学院/);
  assert.match(env.calls[0].system, /应该填写什么值/);
  assert.equal(valueOf(result, "school"), "虚构理工学院");
  assert.equal(refOf(env.calls[0].user, "学校"), undefined, "no catalog in the old prompt");
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8"), /ResumeProEvalValuePrompt/);
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
});

test("a cascade or a level of linked selects given a whole address keeps the region at its head", async () => {
  const env = worker((message, catalog) => ["city", "text", "province", "town"].map((fieldId) => ({ fieldId, ref: catalog[0].ref })));
  const result = await env.run({
    formFields: [{ fieldId: "city", label: "现居住城市", inputType: "select", cascade: true, options: [] }, { fieldId: "text", label: "通讯地址" },
      { fieldId: "province", label: "现居住地（省）", inputType: "select", cascadeGroup: "group-0", cascadeLevel: 0, options: ["请选择", "广东省", "湖南省"] },
      { fieldId: "town", label: "现居住地（市）", inputType: "select", cascadeGroup: "group-0", cascadeLevel: 1, options: ["请选择"] }],
    resumeFields: [{ group: "户籍与地区", key: "现居住地", value: "广东省深圳市南山区粤海街道科苑路 8 号" }]
  });
  assert.equal(valueOf(result, "city"), "广东省深圳市南山区");
  assert.equal(valueOf(result, "province"), "广东省深圳市南山区");
  assert.equal(valueOf(result, "town"), "广东省深圳市南山区");
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
  assert.equal(catalogOf(env.calls[0].user)[0].key.length, 201);
});

test("computer levels and English yes or no are the same option in other words", () => {
  const levels = ["请选择", "全国计算机等级一级", "全国计算机等级二级", "全国计算机等级三级"];
  assert.equal(helpers.findSelectOptionIndex(levels, "全国计算机等级考试二级"), 2);
  assert.equal(helpers.findSelectOptionIndex(["Yes", "No"], "是"), 0);
  assert.equal(helpers.findSelectOptionIndex(["Yes", "No"], "否"), 1);
});

test("a select of bare numbers takes only items equal to an option, not numbers hidden in an ID or a phone", async () => {
  const env = worker();
  await env.run({
    formFields: [
      { fieldId: "year", label: "出生年份", inputType: "select", options: ["请选择", "1999", "2000", "2001"] },
      { fieldId: "days", label: "每周实习天数", inputType: "select", options: ["3", "4", "5"] }
    ],
    resumeFields: [{ group: "基本信息", key: "出生日期", value: "2000-03-17" }, { group: "基本信息", key: "证件号码", value: "430181200003170022" },
      { group: "补充字段", key: "微信号", value: "lin_2000" }, { group: "补充字段", key: "每周可实习天数", value: "5" }]
  });
  const fields = fieldsOf(env.calls[0]);
  const refs = catalogOf(env.calls[0].user);
  const ref = (key) => refs.find((entry) => entry.key === key).ref;
  assert.deepEqual(fields.find((field) => field.fieldId === "year").fits, [`${ref("出生日期")}.year`]);
  assert.deepEqual(fields.find((field) => field.fieldId === "days").fits, [ref("每周可实习天数")]);
});
