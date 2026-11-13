// #429 第 11 项：发给 AI 的只有题目、选项和资料的编号、分组、字段名；AI 回编号，值在 worker 里按编号取资料原文。
// 资料全是虚构的。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "extension", "ai-worker.js"), "utf8");
const helpers = require("../extension/ai-helpers.js");
const { catalogOf, refOf } = require("./helpers/ai-refs.js");
const { pathToFileURL } = require("node:url");
const regions = (() => {
  const scope = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "extension", "region-data.js"), "utf8"), { self: scope });
  return scope.ResumeProRegions;
})();

// respond(message, catalog) 返回 AI 的回答（数组或文字）。
function worker(respond = () => [], { withRegions = true } = {}) {
  const calls = [];
  let sequence = 0;
  const context = vm.createContext({
    importScripts() {}, ResumeProAIHelpers: helpers, ResumeProProfile: require("../extension/profile-fields.js"),
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
  return { calls, context, run: async (input) => JSON.parse(JSON.stringify(await context.handleAiFill(input))) };
}

const fieldsOf = (call) => JSON.parse(call.user.split("\n")[1]);
const valueOf = (result, fieldId) => result.matches.find((match) => match.fieldId === fieldId)?.value;

test("CET grades and scores stay paired across explicit score fields and the BOSS language row", async () => {
  const env = worker(() => { throw new Error("CET fields should be handled locally"); });
  const field = (fieldId, label, inputType, bossCet) => ({ fieldId, label, inputType, bossCet });
  const resumeFields = [{ group: "基本信息", key: "英语水平", value: "CET-6（587 分）" }];
  const pair = (selected = "") => [
    field("level", "英语等级", "select", { role: "level", selected }),
    field("score", "英语分数", "text", { role: "score", selected }),
    field("other-site", "大学英语六级成绩", "text")
  ];
  const single = await env.run({ formFields: pair(), resumeFields });
  assert.equal(valueOf(single, "level"), "CET6");
  assert.equal(valueOf(single, "other-site"), "587");
  assert.deepEqual(single.matches.find(m => m.fieldId === "score"), { fieldId: "score", value: "587", cetScoreLevel: "CET6" });
  resumeFields.push({ group: "证书", key: "英语四级成绩", value: "526" });
  const selected = await env.run({ formFields: pair("CET4"), resumeFields });
  assert.equal(valueOf(selected, "score"), "526");
  assert.equal(valueOf(selected, "other-site"), "587");
  const ambiguous = await env.run({ formFields: pair(), resumeFields });
  assert.equal(ambiguous.matches.find(m => m.fieldId === "score").blocked, "english_level_unconfirmed");
  resumeFields.push({ group: "证书", key: "六级成绩", value: "590" });
  const conflict = await env.run({ formFields: pair("CET6"), resumeFields });
  assert.equal(conflict.matches.find(m => m.fieldId === "score").blocked, "english_score_conflict");
  assert.equal(env.calls.length, 0);
});

test("an unpaired BOSS English score never uses a saved answer or an AI match", async () => {
  const env = worker(() => [{ fieldId: "score", ref: "r1" }]);
  for (const resumeField of [
    { group: "补充字段", key: "英语分数", value: "630" },
    { group: "基本信息", key: "英语自评", value: "630" }
  ]) {
    const score = { fieldId: "score", label: "英语分数", inputType: "text", bossCet: { role: "score", selected: "" } };
    const result = await env.run({ formFields: [score], resumeFields: [resumeField] });
    assert.deepEqual(result.matches, [{ fieldId: "score", value: "", blocked: "english_level_unconfirmed" }]);
  }
  assert.equal(env.calls.length, 0);
});

test("an explicit CET score on another site can still use a saved answer with a date annotation", async () => {
  const env = worker();
  const result = await env.run({
    formFields: [{ fieldId: "score", label: "英语六级成绩", inputType: "text" }],
    resumeFields: [{ group: "补充字段", key: "英语六级成绩", value: "587 分（2024 年 6 月）" }]
  });
  assert.equal(valueOf(result, "score"), "587 分（2024 年 6 月）");
  assert.equal(env.calls.length, 0);
});

test("BOSS internship fields follow the company record after one existing row is already occupied", async () => {
  const env = worker();
  const resumeFields = [
    { group: "实习经历", key: "虚构甲公司实习经历-公司", value: "虚构甲公司" },
    { group: "实习经历", key: "虚构甲公司实习经历-职位", value: "运营实习生" },
    { group: "实习经历", key: "虚构甲公司实习经历-时间", value: "2025.06—2025.09" },
    { group: "实习经历", key: "虚构甲公司实习经历-内容２", value: "复核项目记录。" },
    { group: "实习经历", key: "虚构甲公司实习经历-内容1", value: "整理调研资料。" },
    { group: "实习经历", key: "虚构乙公司实习经历-公司", value: "虚构乙公司" },
    { group: "实习经历", key: "虚构乙公司实习经历-职位", value: "研发实习生" },
    { group: "实习经历", key: "虚构乙公司实习经历-时间", value: "2024.07—2024.08" },
    { group: "实习经历", key: "虚构乙公司实习经历-工作描述", value: "维护培训资料。" }
  ];
  const row = (companies, index) => [["company", "工作单位"], ["position", "职务"], ["start", "时间段（开始）"],
    ["end", "时间段（结束）"], ["description", "工作内容"]]
    .map(([role, label]) => ({ fieldId: `${index}-${role}`, label, inputType: role === "description" ? "textarea" : "text",
      bossWork: { role, companies, index, companyReady: true, kind: "combined" } }));
  const fresh = await env.run({ formFields: [...row(["", ""], 0), ...row(["", ""], 1)], resumeFields });
  assert.equal(valueOf(fresh, "0-company"), "虚构甲公司");
  assert.equal(valueOf(fresh, "1-position"), "研发实习生");
  assert.equal(valueOf(fresh, "1-end"), "2024-08");
  assert.equal(valueOf(fresh, "1-description"), "维护培训资料。");
  const addition = await env.run({ formFields: row(["虚构乙公司", ""], 1), resumeFields });
  assert.equal(valueOf(addition, "1-company"), "虚构甲公司");
  assert.deepEqual(addition.matches.find(m => m.fieldId === "1-start"),
    { fieldId: "1-start", value: "2025-06", bossCompany: "虚构甲公司" });
  assert.deepEqual(addition.matches.find(m => m.fieldId === "1-description"),
    { fieldId: "1-description", value: "整理调研资料。\n复核项目记录。", bossCompany: "虚构甲公司" });
  const unclear = await env.run({ formFields: row(["", ""], 1), resumeFields: resumeFields.slice(0, 3) });
  assert.ok(unclear.matches.every(match => match.blocked === "work_record_unconfirmed"));
  assert.equal(env.calls.length, 0);
});

test("experience descriptions distinguish paragraph numbers from legacy record numbers", () => {
  const resume = [
    { group: "工作经历", key: "公司1", value: "虚构甲公司" },
    { group: "工作经历", key: "工作内容1", value: "整理旧系统手册。" },
    { group: "工作经历", key: "公司2", value: "虚构乙公司" },
    { group: "工作经历", key: "工作内容2", value: "编写测试脚本。" },
    { group: "工作经历", key: "工作经历2-主要工作职责2", value: "维护测试数据。" },
    { group: "实习经历 2", key: "公司", value: "虚构丙公司" },
    { group: "实习经历 2", key: "实习内容10", value: "整理交接文档。" },
    { group: "实习经历 2", key: "内容2", value: "复核项目记录。" },
    { group: "实习经历 2", key: "实习收获3", value: "认识了新同事。" }
  ];
  assert.deepEqual(helpers.workRecords(resume, "combined"), [
    { company: "虚构甲公司", description: "整理旧系统手册。" },
    { company: "虚构乙公司", description: "编写测试脚本。\n维护测试数据。" },
    { company: "虚构丙公司", description: "复核项目记录。\n整理交接文档。" }
  ]);
  const conflict = [...resume, { group: "实习经历 2", key: "实习职责2", value: "填写另一份记录。" }];
  assert.deepEqual(helpers.workRecords(conflict, "internship"), [{ company: "虚构丙公司" }]);
  const namedGroups = [
    { group: "实习经历 1", key: "虚构公司实习经历-内容1", value: "整理旧系统手册。" },
    { group: "实习经历 2", key: "虚构公司实习经历-内容2", value: "维护测试数据。" }
  ];
  assert.deepEqual(helpers.workRecords(namedGroups, "internship"), [
    { company: "虚构公司", description: "整理旧系统手册。" },
    { company: "虚构公司", description: "维护测试数据。" }
  ]);
});

test("a combined BOSS work section keeps work and internship records with the same index separate", async () => {
  const env = worker();
  const resumeFields = [
    { group: "工作经历", key: "工作1公司", value: "甲公司" },
    { group: "工作经历", key: "工作1职位", value: "工程师" },
    { group: "实习经历", key: "实习１－公司", value: "乙公司" },
    { group: "实习经历", key: "实习１：职位", value: "研发实习生" }
  ];
  const formFields = [["company", "工作单位"], ["position", "职位"]].map(([role, label]) => ({
    fieldId: role, label, inputType: "text",
    bossWork: { role, companies: ["甲公司", ""], index: 1, companyReady: true, kind: "combined" }
  }));
  const result = await env.run({ formFields, resumeFields });
  assert.equal(valueOf(result, "company"), "乙公司");
  assert.deepEqual(result.matches.find(match => match.fieldId === "position"),
    { fieldId: "position", value: "研发实习生", bossCompany: "乙公司" });
  const workOnly = formFields.map(field => ({ ...field,
    bossWork: { ...field.bossWork, kind: "work", companies: [""], index: 0 } }));
  const internshipOnly = await env.run({ formFields: workOnly, resumeFields: resumeFields.slice(2) });
  assert.deepEqual(internshipOnly.matches, []);
  assert.equal(env.calls.length, 0);
});

test("BOSS pairs reversed template entries to the site's highest-first education rows without sending the school anchor to AI", async () => {
  const resumeFields = [
    { group: "教育背景", key: "虚构师范大学教育经历-学历", value: "本科" },
    { group: "教育背景", key: "虚构师范大学教育经历-时间", value: "2016.09—2020.06" },
    { group: "教育背景", key: "虚构理工大学教育经历-学历", value: "博士研究生（全日制）" },
    { group: "教育背景", key: "虚构理工大学教育经历-时间", value: "2020.09—2025.06" },
    { group: "教育背景", key: "虚构理工大学教育经历-学位", value: "理学博士" }
  ];
  const pair = (index, school = "", highestFirst = true) => ["school", "level", "degree", "start", "end"].map(role => ({
    fieldId: `${index}-${role}`, label: role, inputType: role === "start" || role === "end" ? "date-picker" : "select",
    bossEducation: { role, index, row: String(index), school, highestFirst }
  }));
  const env = worker();
  const formFields = [...pair(0), ...pair(1), { fieldId: "other", label: "其他" }];
  const result = await env.run({ formFields, resumeFields });
  assert.deepEqual(["0-school", "0-level", "0-degree", "0-start", "0-end", "1-school", "1-level", "1-start", "1-end"]
    .map(id => valueOf(result, id)), ["虚构理工大学", "博士研究生(全日制)", "理学博士", "2020-09", "2025-06",
    "虚构师范大学", "本科", "2016-09", "2020-06"]);
  assert.equal(result.matches.find(m => m.fieldId === "1-start").bossSchool, "虚构师范大学");
  assert.equal(valueOf(result, "1-degree"), undefined);
  assert.deepEqual(fieldsOf(env.calls[0]).map(f => f.fieldId), ["other"]);

  const fixed = await env.run({ formFields: [...pair(0, "虚构师范大学"), ...pair(1, "虚构理工大学")], resumeFields });
  assert.equal(valueOf(fixed, "0-start"), "2016-09");
  assert.equal(valueOf(fixed, "1-start"), "2020-09");
  const ambiguous = await env.run({ formFields: [...pair(0, "", false), ...pair(1, "", false)], resumeFields });
  assert.equal(ambiguous.matches.length, 10);
  assert.ok(ambiguous.matches.every(match => match.blocked === "education_record_unconfirmed" && match.value === ""));
});

test("a contradictory education field leaves other school matches and valid dates intact", async () => {
  const env = worker();
  const resumeFields = [
    { group: "教育经历1", key: "教育经历1-学校", value: "示例大学" },
    { group: "教育经历1", key: "教育经历1-学历", value: "本科" },
    { group: "教育经历1", key: "教育经历1-时间", value: "2020.13—2024.06" },
    { group: "教育经历1", key: "教育经历1-入学时间", value: "2020.09" },
    { group: "教育经历1", key: "教育经历1-毕业时间", value: "2024.07" },
    { group: "教育经历2", key: "教育经历3-学历", value: "博士" }
  ];
  const row = (index, school) => ["level", "start", "end"].map(role => ({
    fieldId: `${index}-${role}`, label: role, inputType: role === "level" ? "text" : "date-picker",
    bossEducation: { role, index, row: String(index), school, highestFirst: true }
  }));
  const result = await env.run({ formFields: [...row(0, "示例大学"), ...row(1, "")], resumeFields });
  assert.deepEqual(["level", "start", "end"].map(role => valueOf(result, `0-${role}`)), ["本科", "2020-09", "2024-07"]);
  const blocked = result.matches.filter(match => match.fieldId.startsWith("1-"));
  assert.equal(blocked.length, 3);
  assert.ok(blocked.every(match => match.blocked === "education_record_unconfirmed"));
  assert.equal(env.calls.length, 0);
});

test("education rows separate degree text from levels and use a corroborated highest degree only once", async () => {
  const item = (group, key, value) => ({ group, key, value });
  const summary = [
    item("基本信息", "最高学历", "博士研究生（全日制）"),
    item("基本信息", "最高学位", "理学博士")
  ];
  const undergraduate = item("教育背景", "虚构师范大学教育经历-学历", "理学学士");
  const doctorate = item("教育背景", "虚构理工大学教育经历-学历", "博士研究生（直博）");
  const row = (index, school = "") => ["school", "level", "degree"].map(role => ({
    fieldId: `${index}-${role}`, label: { school: "学校名称", level: "学历", degree: "学位" }[role], inputType: "select",
    bossEducation: { role, index, row: String(index), school, highestFirst: true }
  }));
  const env = worker();
  const formFields = [...row(0), ...row(1)];
  const resumeFields = [...summary, undergraduate, doctorate];
  const result = await env.run({ formFields, resumeFields });
  assert.deepEqual(formFields.map(field => valueOf(result, field.fieldId)),
    ["虚构理工大学", "博士研究生(直博)", "理学博士", "虚构师范大学", "本科", "理学学士"]);
  const bySchool = [...row(0, "虚构理工大学"), ...row(1, "虚构师范大学")];
  for (const invalidSummary of [
    [summary[1]],
    [summary[0], { ...summary[1], value: "工学硕士" }],
    [...summary, { ...summary[1], value: "工学博士" }]
  ]) {
    const ambiguous = await env.run({ formFields: bySchool, resumeFields: [...invalidSummary, undergraduate, doctorate] });
    assert.equal(valueOf(ambiguous, "0-degree"), undefined);
    assert.equal(valueOf(ambiguous, "1-degree"), "理学学士");
  }
  const secondDoctorate = item("教育背景", "虚构医科大学教育经历-学历", "博士研究生");
  const tied = await env.run({ formFields: bySchool, resumeFields: [...resumeFields, secondDoctorate] });
  assert.equal(valueOf(tied, "0-degree"), undefined);
  const explicit = item("教育背景", "虚构理工大学教育经历-学位", "工学博士");
  const preferred = await env.run({ formFields, resumeFields: [...resumeFields, explicit] });
  assert.equal(valueOf(preferred, "0-degree"), "工学博士");
  const conflicting = item("教育背景", "虚构师范大学教育经历-学位", "工学学士");
  const conflict = await env.run({ formFields: bySchool, resumeFields: [...resumeFields, conflicting] });
  assert.equal(valueOf(conflict, "1-degree"), undefined);
  const conflictingLevel = { ...undergraduate, key: "虚构师范大学教育经历-学历层次", value: "硕士研究生" };
  const mixed = await env.run({ formFields: bySchool, resumeFields: [...resumeFields, conflictingLevel] });
  assert.equal(valueOf(mixed, "1-level"), "硕士研究生");
  assert.equal(valueOf(mixed, "1-degree"), undefined);
  const unfinished = await env.run({ formFields: bySchool, resumeFields: [
    ...summary, undergraduate, { ...doctorate, value: "博士研究生（在读）" }
  ] });
  assert.equal(valueOf(unfinished, "0-degree"), undefined);
  assert.equal(env.calls.length, 0);
});

test("BOSS education range uses one local education record and never asks the model to pair dates", async () => {
  const formFields = ["start", "end"].map((side, i) => ({
    fieldId: side, label: i ? "时间段（结束）" : "时间段（开始）", inputType: "date-picker", pickerType: "boss",
    pickerInputType: "month", educationRange: side, educationRangePair: "pair-1", educationRangeUnique: true
  }));
  const resumeFields = [
    { group: "教育经历", key: "教育经历1-时间", value: "2020年9月—2024年6月（全日制）" },
    { group: "教育经历", key: "教育经历1-学校", value: "虚构大学" },
    { group: "实习经历", key: "实习1时间", value: "2023.09—2024.02" }
  ];
  const env = worker();
  const result = await env.run({ formFields, resumeFields });
  assert.deepEqual(result.matches, [{ fieldId: "start", value: "2020-09" }, { fieldId: "end", value: "2024-06" }]);
  assert.equal(env.calls.length, 0);

  const withIgnoredField = await env.run({ formFields, resumeFields: [
    ...resumeFields, { group: "教育经历2", key: "教育经历3-学历", value: "博士" }
  ] });
  assert.deepEqual(withIgnoredField.matches, result.matches);

  const separate = await env.run({ formFields, resumeFields: [
    { group: "教育经历", key: "教育经历1-入学时间", value: "2020/09" },
    { group: "教育经历", key: "教育经历1-毕业时间", value: "至今" }
  ] });
  assert.deepEqual(separate.matches.map(match => match.value), ["2020-09", "至今"]);

  for (const resume of [
    [...resumeFields, { group: "教育经历", key: "教育经历2-学校", value: "另一所虚构大学" }],
    [{ group: "教育经历", key: "教育经历1-入学时间", value: "2020/09" },
      { group: "教育经历", key: "教育经历2-毕业时间", value: "2024/06" }],
    [{ group: "教育经历", key: "教育经历1-时间", value: "2024.09—2020.06" }],
    [{ group: "教育经历", key: "教育经历1-时间", value: "2020.13—2024.06" }]
  ]) {
    const invalid = await env.run({ formFields, resumeFields: resume });
    assert.deepEqual(invalid.matches, []);
  }
  const repeated = await env.run({ formFields: formFields.map(field => ({ ...field, educationRangeUnique: false })), resumeFields });
  assert.deepEqual(repeated.matches, []);
  const unmatchedPair = await env.run({ formFields: [formFields[0], { ...formFields[1], educationRangePair: "pair-2" }], resumeFields });
  assert.deepEqual(unmatchedPair.matches, []);
  assert.equal(env.calls.length, 0);
});

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

test("#481 independent education dates use the same annotated period ref and keep month precision", async () => {
  const span = "2021.09 - 2026.06 预计毕业";
  const env = worker((message, catalog) => {
    const entry = catalog.find(item => item.key === "教育经历1-时间");
    return [
      { fieldId: "start", ref: entry.ref, part: "start" },
      { fieldId: "end", ref: entry.ref, part: "end" }
    ];
  });
  const result = await env.run({
    formFields: [
      { fieldId: "start", group: "教育经历", label: "开始时间", inputType: "select", dynamicOptions: true, options: [] },
      { fieldId: "end", group: "教育经历", label: "结束时间", inputType: "select", dynamicOptions: true, options: [] }
    ],
    resumeFields: [
      { group: "教育经历", key: "教育经历1-时间", value: span },
      { group: "教育经历", key: "教育经历2-时间", value: "2017.09 - 2021.06" }
    ]
  });
  assert.equal(catalogOf(env.calls[0].user).find(entry => entry.key === "教育经历1-时间").shape, "起止日期，本组最近一段");
  assert.ok(!env.calls[0].user.includes(span));
  assert.equal(valueOf(result, "start"), "2021.09");
  assert.equal(valueOf(result, "end"), "2026.06");
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

test("a text box asking for a whole date takes no year, month or day the AI picks out", async () => {
  const env = worker((message, catalog) => [
    { fieldId: "arrive", ref: `${catalog[0].ref}.month` }, { fieldId: "birthYm", ref: catalog[0].ref, part: "month" },
    { fieldId: "birthYear", ref: `${catalog[0].ref}.year` }, { fieldId: "gradMonth", ref: catalog[0].ref, part: "month" }
  ]);
  const result = await env.run({
    formFields: [{ fieldId: "arrive", label: "到岗日期" }, { fieldId: "birthYm", label: "出生年月" },
      { fieldId: "birthYear", label: "出生年份" }, { fieldId: "gradMonth", label: "毕业月份" }],
    resumeFields: [{ group: "补充字段", key: "日期甲", value: "2026.07.15" }]
  });
  // 「到岗日期」「出生年月」要整个日期，AI 回的月份不填；明说要年份、月份的照填。
  assert.equal(valueOf(result, "arrive"), undefined);
  assert.equal(valueOf(result, "birthYm"), undefined);
  assert.equal(valueOf(result, "birthYear"), "2026");
  assert.equal(valueOf(result, "gradMonth"), "07");
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

test("#481 an internship description joins only the saved content for the matched employer", async () => {
  const employer = { group: "实习经历", key: "虚构甲单位实习经历-公司", value: "虚构甲单位" };
  const resumeFields = [employer,
    { group: "实习经历", key: "虚构甲单位实习经历-内容3", value: "整理交接文档。" },
    { group: "实习经历", key: "虚构甲单位实习经历-内容1", value: "整理调研资料。" },
    { group: "实习经历", key: "虚构甲单位实习经历-内容２", value: "复核项目记录。" },
    { group: "实习经历", key: "虚构乙单位实习经历-公司", value: "虚构乙单位" },
    { group: "实习经历", key: "虚构乙单位实习经历-内容1", value: "维护培训资料。" }
  ];
  const formFields = [
    { fieldId: "company", label: "单位名称", group: "实习经历", inputType: "text" },
    { fieldId: "description", label: "实习内容", group: "实习经历", inputType: "textarea" },
    { fieldId: "other", label: "实习内容", group: "实习经历 2", inputType: "textarea" },
    { fieldId: "takeaways", label: "实习收获", group: "实习经历", inputType: "textarea" }
  ];
  const env = worker(() => [{ fieldId: "company", ref: "r1" }]);
  const result = await env.run({ formFields, resumeFields });
  assert.equal(valueOf(result, "description"), "整理调研资料。\n复核项目记录。\n整理交接文档。");
  assert.equal(valueOf(result, "other"), undefined);
  assert.equal(valueOf(result, "takeaways"), undefined);
  assert.ok(!env.calls[0].user.includes("整理调研资料"));
  const ambiguous = await env.run({ formFields, resumeFields: [...resumeFields, { ...employer, key: employer.key + " (2)" }] });
  assert.equal(valueOf(ambiguous, "description"), undefined);
});

test("#481 experience completion leaves a description blank after conflicting AI answers", async () => {
  const group = "实习经历";
  const env = worker(() => [
    { fieldId: "company", ref: "r1" },
    { fieldId: "description", ref: "r2" },
    { fieldId: "description", ref: "r4" }
  ]);
  const result = await env.run({
    formFields: [
      { fieldId: "company", label: "单位名称", group, inputType: "text" },
      { fieldId: "description", label: "实习内容", group, inputType: "textarea" }
    ],
    resumeFields: [
      { group, key: "实习经历1-公司", value: "虚构甲单位" },
      { group, key: "实习经历1-内容1", value: "整理项目资料。" },
      { group, key: "实习经历2-公司", value: "虚构乙单位" },
      { group, key: "实习经历2-内容1", value: "复核测试记录。" }
    ]
  });
  assert.equal(valueOf(result, "company"), "虚构甲单位");
  assert.equal(valueOf(result, "description"), undefined);
  assert.equal(result.diagnostics.openUnanswered, 1);
});

test("#481 same-employer experience descriptions use the matched period to identify the right record", async () => {
  const group = "工作经历";
  const item = (key, value) => ({ group, key, value });
  const resumeFields = [
    item("工作经历1-任职公司", "虚构技术公司"),
    item("工作经历1-起止时间", "2019.01 - 2020.04"),
    item("工作经历1-岗位职责1", "撰写旧系统手册。"),
    item("工作经历2-任职公司", "虚构技术公司"),
    item("工作经历2-时间", "2022.05 - 2023.06"),
    item("工作经历2-主要工作职责1", "接手新版测试。"),
    item("工作经历2-工作内容2", "维护测试数据。")
  ];
  const formFields = [
    { fieldId: "company", label: "公司名称", group, inputType: "text" },
    { fieldId: "start", label: "开始时间", group, inputType: "text" },
    { fieldId: "description", label: "主要工作职责", group, inputType: "textarea" },
    { fieldId: "opinion", label: "这段工作的收获", group, inputType: "textarea" }
  ];
  const env = worker(() => [
    { fieldId: "company", ref: "r4" }, { fieldId: "start", ref: "r5.start" },
    { fieldId: "description", ref: "r3" }
  ]);
  const result = await env.run({ formFields, resumeFields });
  assert.equal(valueOf(result, "description"), "接手新版测试。\n维护测试数据。");
  assert.equal(valueOf(result, "opinion"), undefined);
  const noPeriod = worker(() => [{ fieldId: "company", ref: "r4" }]);
  assert.equal(valueOf(await noPeriod.run({ formFields, resumeFields }), "description"), undefined);
});

test("#481 project descriptions can use separately grouped resume fields with no numbered field names", async () => {
  const resumeFields = [
    { group: "项目经历 1", key: "项目名称", value: "虚构日报" },
    { group: "项目经历 1", key: "项目描述", value: "为团队整理日报。" },
    { group: "项目经历 2", key: "项目名称", value: "虚构月报" },
    { group: "项目经历 2", key: "项目描述", value: "为团队整理月报。" }
  ];
  const formFields = [
    { fieldId: "name", label: "项目名称", group: "项目经历", inputType: "text" },
    { fieldId: "description", label: "项目内容", group: "项目经历", inputType: "textarea" }
  ];
  const env = worker(() => [{ fieldId: "name", ref: "r3" }]);
  assert.equal(valueOf(await env.run({ formFields, resumeFields }), "description"), "为团队整理月报。");
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

test("one shared word passes only when the question says nothing else", async () => {
  const resume = [{ group: "自我评价", key: "自我评价", value: "踏实认真" }, { group: "技能", key: "专业技能", value: "虚构建模" },
    { group: "兴趣", key: "爱好特长", value: "长跑" }];
  const env = worker((message, catalog) => {
    const ref = (key) => catalog.find((entry) => entry.key === key).ref;
    return [{ fieldId: "team", ref: ref("自我评价") }, { fieldId: "self", ref: ref("自我评价") }, { fieldId: "how", ref: ref("自我评价") },
      { fieldId: "skill", ref: ref("专业技能") }, { fieldId: "hobby", ref: ref("爱好特长") }];
  });
  const box = (fieldId, label) => ({ fieldId, label, tagName: "textarea", inputType: "textarea" });
  const result = await env.run({
    formFields: [box("team", "请评价你的团队"), box("self", "介绍一下你自己"), box("how", "你如何评价自己"), box("skill", "技能特长"), box("hobby", "兴趣爱好")],
    resumeFields: resume
  });
  // 「请评价你的团队」只对上「评价」，「团队」资料项没说到，拦下；别的题除了对上的词没说别的，照填。
  assert.deepEqual(result.matches.map((match) => match.fieldId).sort(), ["hobby", "how", "self", "skill"]);
});

test("a word saying what the question asks stays: a date is no reason and a skill is no plan", async () => {
  const resume = [{ group: "工作经历", key: "工作经历1-离职时间", value: "2024.06" }, { group: "求职意向", key: "职业技能", value: "虚构建模" },
    { group: "工作经历", key: "工作经历1-离职原因", value: "合同到期" }, { group: "求职意向", key: "职业规划", value: "三年内成为数据分析师" }];
  const env = worker((message, catalog) => {
    const ref = (key) => catalog.find((entry) => entry.key === key).ref;
    return [{ fieldId: "leave", ref: ref("工作经历1-离职时间") }, { fieldId: "plan", ref: ref("职业技能") },
      { fieldId: "leave2", ref: ref("工作经历1-离职原因") }, { fieldId: "plan2", ref: ref("职业规划") }];
  });
  const box = (fieldId, label) => ({ fieldId, label, tagName: "textarea", inputType: "textarea" });
  const result = await env.run({ formFields: [box("leave", "离职原因"), box("plan", "职业规划"), box("leave2", "离职原因说明"), box("plan2", "未来三到五年的职业规划")],
    resumeFields: resume });
  assert.deepEqual(result.matches.map((match) => match.fieldId).sort(), ["leave2", "plan2"]);
});

test("a single-line narrative question takes no resume item but one saved under the very same question", async () => {
  const resume = [{ group: "教育经历", key: "教育经历1-学历", value: "硕士" }, { group: "求职意向", key: "期望工作地点", value: "虚构城" },
    { group: "自我评价", key: "自我评价", value: "踏实认真" }];
  const env = worker((message, catalog) => {
    const ref = (key) => catalog.find((entry) => entry.key === key).ref;
    return [{ fieldId: "about", ref: ref("教育经历1-学历") }, { fieldId: "fit", ref: ref("期望工作地点") },
      { fieldId: "intro", ref: ref("自我评价") }, { fieldId: "walk", ref: ref("教育经历1-学历") }];
  });
  const result = await env.run({
    formFields: [{ fieldId: "about", label: "Tell us about yourself", inputType: "text" }, { fieldId: "fit", label: "What makes you a good fit?", inputType: "text" },
      { fieldId: "intro", label: "请简单介绍一下你自己", inputType: "text" }, { fieldId: "walk", label: "Walk us through your background", inputType: "text" }],
    resumeFields: resume
  });
  // 单行的叙述题认得出、认不出问的是哪件事：学历、工作地点、自我评价都不放行，记作开放题没有现成回答。
  assert.deepEqual(result.matches, []);
  assert.equal(result.diagnostics.openUnanswered, 4);
  // 「介绍人姓名」不是叙述题。
  assert.equal(env.context.asksNarrative({ label: "介绍人姓名" }), false);
  assert.equal(env.context.isOpinionField({ label: "Tell us about yourself", inputType: "text" }), true);
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

test("a year or month select known only by a camelCase or snake_case name still lists the date parts that fit", async () => {
  const resume = [{ group: "教育经历", key: "毕业时间", value: "2023-06" }, { group: "基本信息", key: "出生日期", value: "2001-05-09" }];
  const env = worker((message, catalog) => [{ fieldId: "gradMonth", ref: `${catalog.find((entry) => entry.key === "毕业时间").ref}.month` }]);
  const months = Array.from({ length: 12 }, (_, i) => String(i + 1));
  const result = await env.run({
    formFields: [
      { fieldId: "gradMonth", label: "毕业", name: "graduationMonth", inputType: "select", options: months },
      { fieldId: "joinMonth", label: "参加工作", idAttr: "work_start_month", inputType: "select", options: months },
      // 「monthly」不是 month：月薪的下拉不当成问月份。
      { fieldId: "salary", label: "期望", name: "monthlySalary", inputType: "select", options: ["5000", "8000", "10000"] }
    ],
    resumeFields: resume
  });
  const fields = fieldsOf(env.calls[0]);
  const refs = catalogOf(env.calls[0].user);
  const ref = (key) => refs.find((entry) => entry.key === key).ref;
  assert.ok(fields.find((field) => field.fieldId === "gradMonth")?.fits.includes(`${ref("毕业时间")}.month`));
  assert.ok(fields.find((field) => field.fieldId === "joinMonth")?.fits.includes(`${ref("出生日期")}.month`));
  assert.equal(fields.some((field) => field.fieldId === "salary"), false);
  assert.equal(valueOf(result, "gradMonth"), "6");
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

test("resume values go out only when sendValues is exactly true; anything else sends keys alone", async () => {
  const resume = [{ group: "教育经历", key: "学校", value: "虚构理工学院" }, { group: "基本信息", key: "手机号码", value: "13912345678" }];
  const form = [{ fieldId: "school", label: "毕业院校" }, { fieldId: "contact", label: "备用联系电话" }];
  // 开关关着：没带、false、字符串 "true"、1、对象都按关着，发出的文字里查不到资料值，目录里没有 value。
  for (const sendValues of [undefined, false, "true", 1, {}]) {
    const off = worker((message, catalog) => [{ fieldId: "school", ref: catalog[0].ref }]);
    const result = await off.run({ formFields: form, resumeFields: resume, ...(sendValues === undefined ? {} : { sendValues }) });
    const sent = off.calls.map((call) => `${call.system}\n${call.user}`).join("\n");
    for (const field of resume) assert.ok(!sent.includes(field.value), `${JSON.stringify(sendValues)}: ${field.key}`);
    assert.ok(catalogOf(off.calls[0].user).every((entry) => !("value" in entry)));
    assert.doesNotMatch(off.calls[0].system, /和值（value）/);
    assert.equal(valueOf(result, "school"), "虚构理工学院");
  }
  // 开关打开：目录里每项带上值，AI 照旧回编号，值由插件按编号填。
  const on = worker((message, catalog) => [{ fieldId: "school", ref: catalog.find((entry) => entry.key === "学校").ref }]);
  const result = await on.run({ formFields: form, resumeFields: resume, sendValues: true });
  assert.deepEqual(catalogOf(on.calls[0].user).map((entry) => entry.value), ["虚构理工学院", "13912345678"]);
  assert.match(on.calls[0].user, /简历资料目录（编号、分组、字段名和值）/);
  assert.match(on.calls[0].system, /和值（value）/);
  assert.equal(valueOf(result, "school"), "虚构理工学院");
});

test("every script the worker imports is packed, the region data included", async () => {
  const { PLUGIN_ARCHIVE_OPERANDS } = await import(pathToFileURL(path.join(__dirname, "..", "desktop", "scripts", "pack-plugin.js")).href);
  const imported = [...source.match(/importScripts\(([^)]*)\)/)[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(imported.includes("region-data.js"));
  for (const file of imported) assert.ok(PLUGIN_ARCHIVE_OPERANDS.includes(file), `${file} is packed`);
});

test("with resume values sent, password and code fields and resume items still never go out", async () => {
  const resume = [{ group: "教育经历", key: "学校", value: "虚构理工学院" }, { group: "补充字段", key: "邮箱密码", value: "fictional-pass-123" },
    { group: "补充字段", key: "短信验证码", value: "839201" }];
  const env = worker((message, catalog) => [{ fieldId: "school", ref: catalog.find((entry) => entry.key === "学校").ref }]);
  const result = await env.run({
    formFields: [{ fieldId: "school", label: "毕业院校" }, { fieldId: "password", label: "登录密码", inputType: "password" },
      { fieldId: "captcha", label: "图形验证码", inputType: "text" }],
    resumeFields: resume, sendValues: true
  });
  // 和只发字段名时一样，开头就用 isSecretField、safeResumeField 去掉像密码、验证码的网页字段和资料：目录里没有它们。
  const sent = env.calls.map((call) => `${call.system}\n${call.user}`).join("\n");
  assert.match(sent, /虚构理工学院/, "values do go out with the switch on");
  assert.ok(!["fictional-pass-123", "839201", "邮箱密码", "短信验证码", "登录密码", "图形验证码"].some((text) => sent.includes(text)), sent);
  assert.equal(valueOf(result, "school"), "虚构理工学院");
  assert.equal(result.diagnostics.secretFormFields, 2);
});

test("with resume values sent, an open question still takes only a resume item on the same topic, never a written answer", async () => {
  const resume = [{ group: "自我评价", key: "自我评价", value: "踏实认真" }, { group: "求职意向", key: "期望工作地点", value: "虚构城" }];
  const env = worker((message, catalog) => {
    const ref = (key) => catalog.find((entry) => entry.key === key).ref;
    return [{ fieldId: "why", value: "I love your products and want to grow with your team." }, { fieldId: "self", ref: ref("自我评价") },
      { fieldId: "whyUs", ref: ref("期望工作地点") }, { fieldId: "city", ref: ref("期望工作地点") }];
  });
  const box = (fieldId, label) => ({ fieldId, label, tagName: "textarea", inputType: "textarea" });
  const result = await env.run({
    formFields: [box("why", "Why do you want to join us?"), box("self", "自我评价"), box("whyUs", "为什么选择我们公司"), { fieldId: "city", label: "意向城市" }],
    resumeFields: resume, sendValues: true
  });
  // AI 写的一段（带 value 的条目）整条不要；和题目说的不是一件事的资料不填；同一件事的照填资料原文；不是开放题的照旧。
  assert.equal(valueOf(result, "why"), undefined);
  assert.equal(valueOf(result, "whyUs"), undefined);
  assert.equal(valueOf(result, "self"), "踏实认真");
  assert.equal(valueOf(result, "city"), "虚构城");
  assert.equal(result.diagnostics.openUnanswered, 2);
});

test("#481 a model-proposed education option cannot discard the resume's unfinished status", async () => {
  const env = worker(() => [{ fieldId: "degree", ref: "r1", option: "本科" }]);
  const result = await env.run({
    formFields: [{ fieldId: "degree", label: "最高已取得学历", inputType: "select", options: ["本科"] }],
    resumeFields: [{ group: "教育经历", key: "学历", value: "本科（未毕业）" }],
    sendValues: true
  });
  assert.equal(env.calls.length, 1);
  assert.equal(valueOf(result, "degree"), undefined);
});

test("with resume values sent, a select takes the option the AI copies for a resume item; with the switch off it does not", async () => {
  const resume = [{ group: "补充字段", key: "了解渠道", value: "学校就业网" }, { group: "技能", key: "专业技能", value: "SQL、Python" }];
  const form = [
    { fieldId: "heard", label: "How did you hear about us?", inputType: "select", options: ["Please select", "School Career Website", "Friend"] },
    { fieldId: "skills", label: "擅长的工具", inputType: "select", multiple: true, options: ["SQL", "Python", "Excel"] },
    { fieldId: "loose", label: "Source", inputType: "select", options: ["Website", "Other"] },
    { fieldId: "far", label: "Referral", inputType: "radio", options: ["Yes", "No"] },
    { fieldId: "text", label: "了解渠道说明" }
  ];
  const answer = (message, catalog) => {
    const ref = (key) => catalog.find((entry) => entry.key === key)?.ref;
    return [
      { fieldId: "heard", ref: ref("了解渠道"), option: "School Career Website" },
      { fieldId: "skills", refs: [ref("专业技能")], options: ["SQL", "Python"] },
      // 不是一字不差的选项：照只有编号处理，「学校就业网」落不到选项上，不填。
      { fieldId: "loose", ref: ref("了解渠道"), option: "website" },
      // 编号不在这一批目录里：不填。
      { fieldId: "far", ref: "r99", option: "Yes" },
      // 文本框不认选项，值按编号取资料原文。
      { fieldId: "text", ref: ref("了解渠道"), option: "School Career Website" }
    ];
  };
  const on = await worker(answer).run({ formFields: form, resumeFields: resume, sendValues: true });
  assert.equal(valueOf(on, "heard"), "School Career Website");
  assert.equal(valueOf(on, "skills"), "SQL、Python");
  assert.equal(valueOf(on, "loose"), undefined);
  assert.equal(valueOf(on, "far"), undefined);
  assert.equal(valueOf(on, "text"), "学校就业网");
  // 开关关着：不认「编号 + 选项」，本地对不上的下拉照旧不发、不填。
  const offEnv = worker(answer);
  const off = await offEnv.run({ formFields: form, resumeFields: resume });
  assert.equal(valueOf(off, "heard"), undefined);
  assert.equal(valueOf(off, "loose"), undefined);
  assert.equal(fieldsOf(offEnv.calls[0]).some((field) => field.fieldId === "heard"), false, "no item fits it, so it is not sent");
  assert.equal(valueOf(off, "text"), "学校就业网");
});

test("with resume values sent, a select some resume item fits still takes only a ref in its fits; the AI's option is not used", async () => {
  const resume = [{ group: "教育经历", key: "学历", value: "硕士" }, { group: "补充字段", key: "了解渠道", value: "学校就业网" }];
  const degrees = ["本科", "硕士", "博士"];
  const form = [
    { fieldId: "outside", label: "最高学历", inputType: "select", options: degrees },
    { fieldId: "inside", label: "第一学历", inputType: "radio", options: degrees },
    { fieldId: "heard", label: "How did you hear about us?", inputType: "select", options: ["Please select", "School Career Website", "Friend"] }
  ];
  const answer = (message, catalog) => {
    const ref = (key) => catalog.find((entry) => entry.key === key)?.ref;
    return [
      // fits 以外的编号配一个选项：不填。
      { fieldId: "outside", ref: ref("了解渠道"), option: "博士" },
      // fits 里的编号配一个和这项资料对不上的选项：按编号填资料对应的那个选项。
      { fieldId: "inside", ref: ref("学历"), option: "博士" },
      // 没有 fits 的照旧认「编号 + 选项」。
      { fieldId: "heard", ref: ref("了解渠道"), option: "School Career Website" }
    ];
  };
  const onEnv = worker(answer);
  const on = await onEnv.run({ formFields: form, resumeFields: resume, sendValues: true });
  const sent = fieldsOf(onEnv.calls[0]);
  const degreeRef = catalogOf(onEnv.calls[0].user).find((entry) => entry.key === "学历").ref;
  assert.deepEqual(sent.find((field) => field.fieldId === "outside").fits, [degreeRef]);
  assert.equal(sent.find((field) => field.fieldId === "heard").fits, undefined);
  assert.equal(valueOf(on, "outside"), undefined);
  assert.equal(valueOf(on, "inside"), "硕士");
  assert.equal(valueOf(on, "heard"), "School Career Website");
  // 开关关着：带 fits 的两题和打开时一样，没有 fits 的不发、不填。
  const off = await worker(answer).run({ formFields: form, resumeFields: resume });
  assert.equal(valueOf(off, "outside"), undefined);
  assert.equal(valueOf(off, "inside"), "硕士");
  assert.equal(valueOf(off, "heard"), undefined);
});

test("the switch only adds values to the catalog and an option for choice fields; no separate value-mode code is left", async () => {
  assert.equal(fs.existsSync(path.join(__dirname, "..", "ai-worker-values.js")), false);
  assert.equal(fs.existsSync(path.join(__dirname, "..", "scripts", "eval-fill-legacy.js")), false);
  assert.doesNotMatch(source, /handleValuesFill|应该填写什么值|ai-worker-values/);
  assert.match(source, /const withValues = message\?\.sendValues === true;/);
  assert.equal("selectResumeCandidates" in helpers, false);
  // 发资料原文的提示词由只发字段名的那份改两句、加一条得来：两处改动都要真的改上了。
  const env = worker();
  const plain = vm.runInContext("AI_SYSTEM_PROMPT", env.context);
  const values = vm.runInContext("VALUES_SYSTEM_PROMPT", env.context);
  for (const [from, to] of vm.runInContext("VALUES_PROMPT_EDITS", env.context)) {
    assert.ok(plain.includes(from) && values.includes(to) && !plain.includes(to), from);
  }
  assert.notEqual(values, plain);
  const { PLUGIN_ARCHIVE_OPERANDS } = await import(pathToFileURL(path.join(__dirname, "..", "desktop", "scripts", "pack-plugin.js")).href);
  assert.ok(PLUGIN_ARCHIVE_OPERANDS.includes("ai-worker.js"));
  assert.equal(PLUGIN_ARCHIVE_OPERANDS.includes("ai-worker-values.js"), false);
  assert.equal(PLUGIN_ARCHIVE_OPERANDS.some((entry) => entry === "scripts" || entry.startsWith("scripts/")), false);
  const { assertPluginOnlyArchive } = await import(pathToFileURL(path.join(__dirname, "..", "desktop", "scripts", "check-plugin-release-allowlist.js")).href);
  const packed = ["manifest.json", "background.js", "content.js", "content.css", "LICENSE", "ai-worker.js"];
  assert.doesNotThrow(() => assertPluginOnlyArchive(packed));
  assert.throws(() => assertPluginOnlyArchive([...packed, "scripts/eval-fill.mjs"]), /scripts\/eval-fill\.mjs/);
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
  const changed = fs.readFileSync(path.join(__dirname, "..", "extension", "ai-helpers.js"), "utf8").replace('label: "论文" }', 'label: "论文(+" }');
  assert.notEqual(changed, fs.readFileSync(path.join(__dirname, "..", "extension", "ai-helpers.js"), "utf8"));
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

test("a raw key or group that starts like a generated number still has its phone or ID number masked", async () => {
  const resume = [{ group: "基本信息", key: "手机号码", value: "13912345678" }, { group: "基本信息", key: "证件号码", value: "11010519491231002X" },
    { group: "实习经历13912345678", key: "备注", value: "无" }, { group: "教育经历", key: "教育经历11010519491231002X-说明", value: "无" },
    { group: "实习经历", key: "实习经历1-公司", value: "虚构云计算有限公司" }];
  const env = worker();
  await env.run({ formFields: [{ fieldId: "q", label: "其他说明" }], resumeFields: resume });
  const catalog = catalogOf(env.calls[0].user);
  assert.ok(!/13912345678|11010519491231002X/i.test(JSON.stringify(catalog)), JSON.stringify(catalog));
  // 这次起的编号照旧留着。
  assert.ok(catalog.some((entry) => entry.key === "实习经历1-公司"));
});

test("a name written in NFD is masked like its NFC value, and the other way round", () => {
  const zoe = "Zoë Lin".normalize("NFC");
  const jose = "José Ruiz";
  const keys = helpers.catalogKeys([
    { group: "基本信息", key: "姓名", value: zoe }, { group: "本网站回答", key: `${zoe.normalize("NFD")}的推荐信`, value: "无" },
    { group: "家庭主要成员", key: "母亲姓名", value: jose.normalize("NFD") }, { group: "本网站回答", key: `${jose.normalize("NFC")}是否同意`, value: "是" }
  ]);
  assert.equal(keys[1], "〔姓名〕的推荐信");
  assert.equal(keys[3], "〔母亲姓名〕是否同意");
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

test("an address region data reads in full goes as it is, and one with a street never reads in full", async () => {
  // 整段命中的分支（regionPrefix 的 whole）只收整段都是地名的：后面带着街道、门牌、邮编、括号的，resolve 认不出，走按前缀截的分支。
  for (const value of ["北京市海淀区中关村大街1号", "广东省 深圳市 南山区 科苑路8号", "深圳市南山区 518000", "广东省深圳市南山区（科技园）"]) {
    assert.equal(regions.resolve(value), null, value);
  }
  const values = ["广东省深圳市南山区", "深圳南山", "中国广东省深圳市南山区"];
  values.forEach((value) => assert.ok(regions.resolve(value), value));
  const env = worker((message, catalog) => catalog.map((entry, at) => ({ fieldId: `c${at}`, ref: entry.ref })));
  const result = await env.run({
    formFields: values.map((_, at) => ({ fieldId: `c${at}`, label: "现居住城市", inputType: "select", cascade: true, options: [] })),
    resumeFields: values.map((value, at) => ({ group: "户籍与地区", key: `地址${at}`, value }))
  });
  assert.deepEqual(values.map((_, at) => valueOf(result, `c${at}`)), values);
});

test("a city or a municipality followed by a street is cut to the city; a province with a street and a school name are not", async () => {
  const values = ["深圳市科苑路8号", "北京市中关村大街1号", "广东省科苑路8号", "北京大学"];
  const env = worker((message, catalog) => catalog.map((entry, at) => ({ fieldId: `c${at}`, ref: entry.ref })));
  const result = await env.run({
    formFields: values.map((_, at) => ({ fieldId: `c${at}`, label: "所在地", inputType: "select", cascade: true, options: [] })),
    resumeFields: values.map((value, at) => ({ group: "补充字段", key: `地点${at}`, value }))
  });
  assert.deepEqual(values.map((_, at) => valueOf(result, `c${at}`)), ["深圳市", "北京市", "广东省科苑路8号", "北京大学"]);
});

test("a start or end the AI picks gives way to the side the question names", async () => {
  const env = worker((message, catalog) => [
    { fieldId: "grad", ref: `${catalog[0].ref}.start` }, { fieldId: "enrol", ref: catalog[0].ref, part: "end" },
    { fieldId: "span", ref: `${catalog[0].ref}.start` }, { fieldId: "gradText", ref: `${catalog[0].ref}.start` }
  ]);
  const result = await env.run({
    formFields: [{ fieldId: "grad", label: "毕业时间", inputType: "date-picker", pickerInputType: "month", options: [] },
      { fieldId: "enrol", label: "入学时间", inputType: "date-picker", pickerInputType: "month", options: [] },
      { fieldId: "span", label: "在校时间", inputType: "date-picker", pickerInputType: "month", options: [] },
      { fieldId: "gradText", label: "毕业年月" }],
    resumeFields: [{ group: "教育经历", key: "教育经历1-时间", value: "2019.09-2023.06" }]
  });
  // 题目写明了要哪一头的以题目为准；看不出的（在校时间）才用 AI 给的。
  assert.equal(valueOf(result, "grad"), "2023-06");
  assert.equal(valueOf(result, "enrol"), "2019-09");
  assert.equal(valueOf(result, "span"), "2019-09");
  assert.equal(valueOf(result, "gradText"), "2023.06");
});

test("a date-time box keeps the hours and minutes of the resume, and gets a date alone when there are none", async () => {
  const env = worker((message, catalog) => [
    { fieldId: "native", ref: catalog[0].ref }, { fieldId: "picker", ref: catalog[0].ref }, { fieldId: "dayOnly", ref: catalog[1].ref }
  ]);
  const result = await env.run({
    formFields: [{ fieldId: "native", label: "面试时间", inputType: "datetime-local", options: [] },
      { fieldId: "picker", label: "面试时间", inputType: "date-picker", pickerInputType: "datetime-local", options: [] },
      { fieldId: "dayOnly", label: "可面试日期", inputType: "datetime-local", options: [] }],
    resumeFields: [{ group: "补充字段", key: "面试安排", value: "2026.07.15 14:30" }, { group: "补充字段", key: "可面试日", value: "2026.07.16" }]
  });
  assert.equal(valueOf(result, "native"), "2026-07-15T14:30");
  assert.equal(valueOf(result, "picker"), "2026-07-15T14:30");
  assert.equal(valueOf(result, "dayOnly"), "2026-07-16", "the page adds 00:00 to a date alone");
});

test("a multi-select takes a long list of short options it can split", async () => {
  const skills = ["Python", "SQL", "Tableau", "Excel", "PowerBI", "Spark", "Hive", "Flink", "Kafka", "Docker", "Git", "Linux", "MATLAB", "SPSS", "Stata", "R语言", "机器学习建模", "数据可视化", "统计分析"];
  const value = skills.join("、");
  assert.ok(value.length > 100 && skills.every((skill) => skill.length <= 30));
  const env = worker();
  await env.run({
    formFields: [{ fieldId: "skills", label: "掌握的技能", inputType: "select", multiple: true, options: skills }],
    resumeFields: [{ group: "技能", key: "专业技能", value }]
  });
  assert.deepEqual(fieldsOf(env.calls[0]).find((field) => field.fieldId === "skills").fits, [refOf(env.calls[0].user, "专业技能")]);
});

test("a cascade not asking for a place gets its value as it is, never a city cut off its front", async () => {
  const env = worker((message, catalog) => ["major", "group", "where"].map((fieldId) => ({ fieldId, ref: catalog[0].ref })));
  const result = await env.run({
    formFields: [{ fieldId: "major", label: "专业类别", inputType: "select", cascade: true, options: [] },
      { fieldId: "group", label: "专业", inputType: "select", cascadeGroup: "group-0", cascadeLevel: 0, options: ["请选择"] },
      { fieldId: "where", label: "学校所在地", inputType: "select", cascade: true, options: [] }],
    resumeFields: [{ group: "教育经历", key: "教育经历1-校区", value: "上海交通大学闵行校区" }]
  });
  // 专业类别、专业这类不问地区的级联原样给；问「所在地」的才截到认得出的城市。
  assert.equal(valueOf(result, "major"), "上海交通大学闵行校区");
  assert.equal(valueOf(result, "group"), "上海交通大学闵行校区");
  assert.equal(valueOf(result, "where"), "上海");
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
