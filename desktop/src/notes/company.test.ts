import assert from "node:assert/strict";
import { test } from "node:test";
import { countCompanyNotes, folderBelongsToCompany, normalizeCompany } from "./company.ts";

const folders = [
  { id: "f1", applicationId: "a1", company: "星河科技", recycled: false },
  { id: "f2", applicationId: "a2", company: "  星河科技 ", recycled: false },
  { id: "f3", applicationId: "a3", company: "云杉数据", recycled: false },
  { id: "f4", applicationId: null, company: "星河科技", recycled: false },
  { id: "f5", applicationId: "a5", company: "星河科技", recycled: true },
];

test("公司名比较前去掉首尾空格", () => {
  assert.equal(normalizeCompany("  星河科技 "), "星河科技");
  assert.equal(normalizeCompany(null), "");
});

test("同一公司多个岗位的文件夹一起算", () => {
  const notes = [
    { folderId: "f1", recycled: false },
    { folderId: "f1", recycled: false },
    { folderId: "f2", recycled: false },
    { folderId: "f3", recycled: false },
  ];
  assert.equal(countCompanyNotes({ folders, notes }, "星河科技"), 3);
  assert.equal(countCompanyNotes({ folders, notes }, " 星河科技 "), 3, "传进来的公司名也去空格");
  assert.equal(countCompanyNotes({ folders, notes }, "云杉数据"), 1);
});

test("回收的心得、回收的文件夹、没关联申请的文件夹都不算", () => {
  const notes = [
    { folderId: "f1", recycled: false },
    { folderId: "f1", recycled: true },
    { folderId: "f4", recycled: false },
    { folderId: "f5", recycled: false },
    { folderId: "missing", recycled: false },
  ];
  assert.equal(countCompanyNotes({ folders, notes }, "星河科技"), 1);
});

test("没有心得、公司名为空或不认识时是 0", () => {
  assert.equal(countCompanyNotes({ folders, notes: [] }, "星河科技"), 0);
  assert.equal(countCompanyNotes({ folders, notes: [{ folderId: "f1", recycled: false }] }, "   "), 0);
  assert.equal(countCompanyNotes({ folders, notes: [{ folderId: "f1", recycled: false }] }, "别家"), 0);
});

test("folderBelongsToCompany 只认已关联申请且公司名一致的文件夹", () => {
  assert.equal(folderBelongsToCompany(folders[0], "星河科技"), true);
  assert.equal(folderBelongsToCompany(folders[1], "星河科技"), true);
  assert.equal(folderBelongsToCompany(folders[3], "星河科技"), false);
  assert.equal(folderBelongsToCompany(folders[2], "星河科技"), false);
  assert.equal(folderBelongsToCompany(undefined, "星河科技"), false);
});
