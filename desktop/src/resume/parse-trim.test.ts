import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_TEMPLATE_BYTES } from "./parse-limits.ts";
import { fieldCountOf, formatBytes, groupBytes, secretCountOf, setGroupKept, templateBytes, trimDraft, trimmedGroups, updateField } from "./parse-trim.ts";

// 用三字节的汉字把分组撑到正好 target 字节，和 archive-store tests/resume.rs 的同名做法一致。
function chineseGroupsOf(target: number) {
  const base = templateBytes([{ name: "教育经历", fields: [{ key: "在校经历", value: "" }] }]);
  const room = target - base;
  const value = "字".repeat(Math.floor(room / 3)) + "a".repeat(room % 3);
  return [{ name: "教育经历", fields: [{ key: "在校经历", value }] }];
}

test("大小按 UTF-8 字节算：中文在上限内、正好上限、超过上限", () => {
  const under = chineseGroupsOf(MAX_TEMPLATE_BYTES - 300);
  assert.equal(templateBytes(under), MAX_TEMPLATE_BYTES - 300);

  const exact = chineseGroupsOf(MAX_TEMPLATE_BYTES);
  assert.equal(templateBytes(exact), MAX_TEMPLATE_BYTES);
  // 字符串长度只有字节数的三分之一左右，拿它比上限会把超限的结果当成没超。
  assert.ok(JSON.stringify(exact).length < MAX_TEMPLATE_BYTES / 2);

  const over = chineseGroupsOf(MAX_TEMPLATE_BYTES + 1);
  assert.equal(templateBytes(over), MAX_TEMPLATE_BYTES + 1);
});

test("计算前按后端的规则规范化：去空白、丢空字段名和空组", () => {
  const raw = [
    { name: "  基本信息 ", fields: [{ key: " 姓名 ", value: " 张三 " }, { key: "  ", value: "丢掉" }] },
    { name: "空组", fields: [] },
    { name: " ", fields: [{ key: "备注", value: "x" }] },
  ];
  const expected = [
    { name: "基本信息", fields: [{ key: "姓名", value: " 张三 " }] },
    { name: "未分类", fields: [{ key: "备注", value: "x" }] },
  ];
  assert.equal(templateBytes(raw), new TextEncoder().encode(JSON.stringify(expected)).length);
});

test("像密码、验证码的字段和后端一样不存，也不算进大小和字段数", () => {
  const raw = [
    { name: "基本信息", fields: [{ key: "姓名", value: "张三" }, { key: "邮箱密码", value: "x".repeat(5000) }] },
    { name: "账号", fields: [{ key: "备注", value: "密码：abc123" }] },
  ];
  const expected = [{ name: "基本信息", fields: [{ key: "姓名", value: "张三" }] }];
  assert.equal(templateBytes(raw), new TextEncoder().encode(JSON.stringify(expected)).length);
  assert.equal(fieldCountOf(raw), 1);
  assert.equal(secretCountOf(raw), 2);
  // 「密码学」这类正常文字不算。
  assert.equal(secretCountOf([{ name: "课程", fields: [{ key: "选修", value: "密码学" }] }]), 0);
});

test("删减只改草稿：去掉整组、去掉字段、缩短内容，原结果不变", () => {
  const result = [
    { name: "基本信息", fields: [{ key: "姓名", value: "张三" }, { key: "电话", value: "13800000000" }] },
    { name: "项目经历", fields: [{ key: "项目一", value: "很长的描述".repeat(10) }] },
    { name: "自我评价", fields: [{ key: "评价", value: "认真" }] },
  ];
  const before = JSON.stringify(result);
  let draft = trimDraft(result);
  assert.deepEqual(trimmedGroups(draft), result);

  draft = setGroupKept(draft, 2, false);
  draft = updateField(draft, 0, 1, { keep: false });
  draft = updateField(draft, 1, 0, { value: "做过一个项目" });
  assert.deepEqual(trimmedGroups(draft), [
    { name: "基本信息", fields: [{ key: "姓名", value: "张三" }] },
    { name: "项目经历", fields: [{ key: "项目一", value: "做过一个项目" }] },
  ]);
  assert.equal(groupBytes(draft[2]), 0);
  assert.equal(groupBytes(draft[1]), templateBytes([{ name: "项目经历", fields: [{ key: "项目一", value: "做过一个项目" }] }]));

  // 一组里的字段都取消勾选，这组就不留。
  draft = updateField(draft, 0, 0, { keep: false });
  assert.deepEqual(trimmedGroups(draft).map((group) => group.name), ["项目经历"]);
  assert.equal(JSON.stringify(result), before);
});

test("字节数带千分位", () => {
  assert.equal(formatBytes(24576), "24,576 字节");
});
