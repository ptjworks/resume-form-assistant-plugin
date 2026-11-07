import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareVersions,
  describeCheckFailure,
  describeUpdate,
  formatCheckedAt,
  outstandingUpdate,
  parseCheckedAt,
  shouldCheck,
  updateNotice,
} from "./update-check.ts";

test("版本号按三段数字比，不按字符串比", () => {
  assert.equal(compareVersions("0.2.0", "0.1.9"), 1);
  assert.equal(compareVersions("0.10.0", "0.9.0"), 1, "字符串比会说 0.9 更大");
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0", "1.0.1"), -1);
});

test("认不出的版本号就当一样，不乱提示升级", () => {
  assert.equal(compareVersions("nightly", "1.0.0"), 0);
});

test("关了就不查；今天查过也不查", () => {
  const now = "2026-09-17T10:00:00Z";
  assert.equal(shouldCheck({ enabled: false }, now), false);
  assert.equal(shouldCheck({ enabled: true }, now), true);
  assert.equal(shouldCheck({ enabled: true, lastCheckedAt: "2026-09-17T01:00:00Z" }, now), false);
  assert.equal(shouldCheck({ enabled: true, lastCheckedAt: "2026-09-16T23:59:00Z" }, now), true);
});

test("有新版本时说清楚新旧两个号，并说明是手动安装", () => {
  const message = describeUpdate("0.1.0", { version: "0.2.0", url: "https://example.test/r" });
  assert.equal(message.available, true);
  assert.match(message.text, /0\.2\.0/);
  assert.match(message.text, /0\.1\.0/);
  assert.match(message.text, /手动安装/);
});

test("服务器上的版本更旧或一样时，不制造「有更新」的错觉", () => {
  assert.equal(describeUpdate("0.2.0", { version: "0.2.0", url: "u" }).available, false);
  assert.equal(describeUpdate("0.3.0", { version: "0.2.0", url: "u" }).available, false);
  assert.equal(describeUpdate("0.1.0", null).available, false);
});

test("查不到是「没查成」，不是「已经最新」", () => {
  const offline = describeCheckFailure({ code: "UPDATE_OFFLINE" });
  assert.equal(offline.available, false);
  assert.match(offline.text, /连不上/);
  assert.doesNotMatch(offline.text, /最新/);

  assert.match(describeCheckFailure({ code: "UPDATE_RATE_LIMITED" }).text, /限流/);
  assert.match(describeCheckFailure({ message: "说不清" }).text, /说不清/);
});

test("上次检查时间：宿主写的两种格式都认，认不出来就不显示", () => {
  const expected = Date.UTC(2026, 9, 9, 6, 20, 0);
  assert.equal(parseCheckedAt("2026-10-09 6:20:00.123456 +00:00:00")?.getTime(), expected);
  assert.equal(parseCheckedAt("2026-10-09T06:20:00Z")?.getTime(), expected);
  assert.equal(parseCheckedAt("2026-10-09T14:20:00+08:00")?.getTime(), expected);
  assert.equal(parseCheckedAt("2026-10-09 6:20:00"), null, "没有时区就不知道是几点");
  assert.equal(parseCheckedAt(""), null);
  assert.equal(parseCheckedAt(null), null);
  assert.equal(parseCheckedAt("昨天"), null);
});

test("检查时间按本机时间显示，今天的写「今天」", () => {
  const now = new Date(2026, 9, 9, 18, 0);
  assert.equal(formatCheckedAt(new Date(2026, 9, 9, 14, 5), now), "今天 14:05");
  assert.equal(formatCheckedAt(new Date(2026, 9, 8, 9, 5), now), "2026-10-08 09:05");
});

test("主界面提示：查到新版本就提示", () => {
  const available = { version: "0.5.0", url: "https://example.test/r" };
  assert.deepEqual(updateNotice({ enabled: true, available }, "0.4.2"), available);
});

test("主界面提示：收起只管这一次运行，查到更新的版本再提示", () => {
  const pref = { enabled: true, available: { version: "0.5.0", url: "u" } };
  assert.equal(updateNotice(pref, "0.4.2", "0.5.0"), null);
  assert.equal(updateNotice(pref, "0.4.2")?.version, "0.5.0", "下次打开（没有收起记录）还提示");
  assert.equal(updateNotice({ ...pref, available: { version: "0.6.0", url: "u" } }, "0.4.2", "0.5.0")?.version, "0.6.0");
  // 收起 0.6.0 以后那一版撤回了，查到的变回 0.5.0：收起的不是这一版，照样提示。
  assert.equal(updateNotice(pref, "0.4.2", "0.6.0")?.version, "0.5.0");
});

test("主界面提示：文件里留着旧的「关掉的版本」也照样提示", () => {
  // 有一段开发版把关掉的版本写进了 update-check.json，现在不认这一项。
  const pref = { enabled: true, available: { version: "0.5.0", url: "u" }, dismissedVersion: "0.5.0" };
  assert.equal(updateNotice(pref, "0.4.2")?.version, "0.5.0");
});

test("有没有该装的新版本：收起提示不算装上", () => {
  const available = { version: "0.5.0", url: "u" };
  assert.deepEqual(outstandingUpdate({ enabled: true, available }, "0.4.2"), available);
  assert.equal(outstandingUpdate({ enabled: true, available }, "0.5.0"), null);
  assert.equal(outstandingUpdate({ enabled: false, available }, "0.4.2"), null);
});

test("主界面提示：自动检查关着、没查到、已经装上了，都不提示", () => {
  const available = { version: "0.5.0", url: "u" };
  assert.equal(updateNotice({ enabled: false, available }, "0.4.2"), null);
  assert.equal(updateNotice({ enabled: true }, "0.4.2"), null);
  assert.equal(updateNotice({ enabled: true, available: null }, "0.4.2"), null);
  assert.equal(updateNotice({ enabled: true, available }, "0.5.0"), null);
  assert.equal(updateNotice({ enabled: true, available }, "开发版"), null, "认不出当前版本就不提示");
});
