// #301 U2 U5：没填上的字段只列前 10 个，其余以前只有一个总数。现在 [未填字段] 开头另有一行 reasons，
// 按原因代码数全部没填上的字段；认不出的代码算 other。这一行只有固定代码和数字。
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../feedback-core.js");

const BASE = { path: "/campus/apply", pageType: { type: "application_form", reason: "url" }, fieldCount: 40, matched: 40, filledCount: 9,
  unfilledCount: 31, unconfirmedCount: 0, requested: true, diagnostics: { ruleMatches: 40, aiFields: 0, aiMatches: 0, promptBytes: 0, errorCode: "none" } };
const control = { tag: "input", type: "text", role: "combobox", readOnly: true, library: "antd" };
const field = (label, reasonCode) => ({ label, reasonCode, control, observed: { opened: "listbox", hasOptions: true } });
const tally = line => Object.fromEntries(line.split(",").map(pair => pair.split("=")).map(([key, value]) => [key, Number(value)]));

test("more than ten unfilled fields: every one is counted under its reason, and the counts add up to the total", () => {
  const unfilled = [
    ...Array.from({ length: 12 }, () => field("学历", "selection_not_committed")),
    ...Array.from({ length: 3 }, () => field("政治面貌", "control_disabled")),
    ...Array.from({ length: 9 }, () => field("毕业时间", "no_option_match")),
    // Codes the report does not know, or none at all, count as one kind.
    field("籍贯", "made_up_code"), field("民族", undefined), field("性别", ""), field("现居住地", null),
    field("身高", "constructor"), field("体重", "__proto__"), field("血型", "toString")
  ];
  const report = core.fillReport({ ...BASE, unfilledControls: unfilled });
  const line = /^reasons: (.*)$/m.exec(report)?.[1];
  assert.equal(line, "no_option_match=9,selection_not_committed=12,control_disabled=3,other=7");
  assert.equal(Object.values(tally(line)).reduce((sum, value) => sum + value, 0), unfilled.length);
  // The ten listed fields and the unlisted count are as before, after the reasons line.
  const section = report.slice(report.indexOf("[未填字段]")).split("\n");
  assert.equal(section[1], `reasons: ${line}`);
  assert.equal(section.filter(entry => entry.startsWith("- ")).length, 10);
  assert.equal(section.at(-1), `unlisted: ${unfilled.length - 10}`);
  assert.equal(core.diagnostics(report), report);
});

test("ten or fewer unfilled fields get the reasons line too, and no unlisted line", () => {
  const report = core.fillReport({ ...BASE, unfilledControls: [field("学历", "no_option_match"), field("学校", "no_option_match")] });
  assert.match(report, /^reasons: no_option_match=2$/m);
  assert.doesNotMatch(report, /^unlisted: /m);
  assert.doesNotMatch(core.fillReport({ ...BASE, unfilledControls: [] }), /^reasons: /m);
});

test("the reasons line carries no field name, value or address, whatever the page put in", () => {
  const secrets = ["张三", "13800138000", "zhangsan@example.com", "https://jobs.example.test/apply?id=42", "北京大学"];
  const unfilled = Array.from({ length: 15 }, (_, index) => ({
    label: `${secrets[index % secrets.length]}的姓名`, reason: secrets[index % secrets.length],
    reasonCode: index % 3 ? `reason=${secrets[index % secrets.length]}` : "too_long", value: secrets[index % secrets.length],
    control: { tag: "input", type: "text" }
  }));
  const report = core.fillReport({ ...BASE, unfilledControls: unfilled });
  assert.match(report, /^reasons: too_long=5,other=10$/m);
  for (const secret of [...secrets, "example", "http", "jobs."]) assert.ok(!report.includes(secret), secret);
  // A forged reasons line from a page is dropped by the worker's allowlist.
  for (const forged of ["reasons: 张三=1", "reasons: other=1,https://x.test=2", "reasons: too_long=1234567", "reasons: no_option_match"]) {
    assert.equal(core.diagnostics(`[未填字段]\n${forged}`), "[未填字段]", forged);
  }
});

test("a reasons line with every code at six digits still passes the allowlist", () => {
  // Read from the source, so a code added later is covered too.
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "feedback-core.js"), "utf8");
  const codes = [...JSON.parse(source.match(/const FILL_REASONS = (\[[^\]]*\]);/)[1]), "other"];
  assert.ok(codes.length > 30, codes.join());
  const line = `reasons: ${codes.map(code => `${code}=999999`).join(",")}`;
  assert.equal(core.diagnostics(`[未填字段]\n${line}`), `[未填字段]\n${line}`);
});
