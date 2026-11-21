import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fireEvent } from "@testing-library/dom";
import type { Invoke, RuntimeStatus } from "./api.ts";
import { formatCheckedAt, parseCheckedAt } from "./update-check.ts";
import type { UpdateInfo, UpdatePreference } from "./update-check.ts";

const runtime = vi.hoisted(() => ({ update: vi.fn(), fail: vi.fn() }));

// Exercise main.ts's actual event handlers, polling and DOM writes without mounting unrelated views.
vi.mock("./feedback.ts", () => ({ installFrontendErrors: vi.fn() }));
vi.mock("./react/feedback-mount.tsx", () => ({ mountFeedbackSettings: vi.fn() }));
vi.mock("./react/usage-mount.tsx", () => ({ mountUsageSettings: vi.fn() }));
vi.mock("./usage-metrics.ts", () => ({ installUsageSignals: vi.fn() }));
vi.mock("./react/runtime-status-mount.tsx", () => ({ mountRuntimeStatus: () => runtime }));
vi.mock("./ai/mount.tsx", () => ({ mountAiSettings: vi.fn(), mountAiReview: vi.fn() }));
vi.mock("./applications-ui.ts", () => ({
  mountApplications: () => ({ refreshList: async () => {}, refreshView: async () => {}, flushPending: async () => {} }),
}));
vi.mock("./inbox-ui.ts", () => ({ mountInbox: () => ({ refresh: async () => {} }) }));
vi.mock("./todos-ui.ts", () => ({ mountTodos: () => async () => {} }));
vi.mock("./backup-ui.ts", () => ({ mountBackup: () => async () => {} }));
vi.mock("./resume/mount.tsx", () => ({ mountResume: () => ({ refresh: vi.fn(), confirmLeave: async () => true }) }));
vi.mock("./notes/view.ts", () => ({ mountNotes: () => ({ openForApplication: vi.fn() }) }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-09T15:00:00Z"));
  document.body.innerHTML = readFileSync("index.html", "utf8").split("<body>")[1].split("</body>")[0];
  delete window.__TAURI__;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  delete window.__TAURI__;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function status(version = "0.4.2"): RuntimeStatus {
  return { appVersion: version, nativeMessaging: [{ label: "Chrome", registered: true }] } as RuntimeStatus;
}

async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

async function start(handler?: (command: string) => Promise<unknown>) {
  if (handler) window.__TAURI__ = { core: { invoke: handler as Invoke } };
  await import("./main.ts");
  await settle();
}

function pollHost(requests: ReturnType<typeof deferred<RuntimeStatus>>[]) {
  return async (command: string) => {
    if (command === "get_runtime_status") return requests.shift()!.promise;
    if (command === "get_update_preference_cmd") return { enabled: false };
    return {};
  };
}

test("a late startup failure cannot replace a newer poll's successful status or topbar", async () => {
  const old = deferred<RuntimeStatus>();
  const latest = deferred<RuntimeStatus>();
  await start(pollHost([old, latest]));
  await vi.advanceTimersByTimeAsync(4000);
  latest.resolve(status());
  await settle();
  old.reject(new Error("obsolete read failure"));
  await settle();
  expect(runtime.update).toHaveBeenCalledExactlyOnceWith(status());
  expect(runtime.fail).not.toHaveBeenCalled();
  expect(document.getElementById("runtime-pill")!.textContent).toBe("已注册 Chrome");
  expect(document.getElementById("link-state")!.textContent).not.toContain("obsolete");
});

test("an older success cannot clear the latest failure", async () => {
  const old = deferred<RuntimeStatus>();
  const latest = deferred<RuntimeStatus>();
  await start(pollHost([old, latest]));
  await vi.advanceTimersByTimeAsync(4000);
  latest.reject(new Error("latest read failure"));
  await settle();
  old.resolve(status("0.3.0"));
  await settle();
  expect(runtime.update).not.toHaveBeenCalled();
  expect(runtime.fail).toHaveBeenCalledExactlyOnceWith("latest read failure");
  expect(document.getElementById("link-state")!.textContent).toContain("latest read failure");
});

test("an older success cannot roll back the version and registration shown by a newer success", async () => {
  const old = deferred<RuntimeStatus>();
  const latest = deferred<RuntimeStatus>();
  await start(pollHost([old, latest]));
  await vi.advanceTimersByTimeAsync(4000);
  latest.resolve(status());
  await settle();
  old.resolve({ ...status("0.3.0"), nativeMessaging: [] });
  await settle();
  expect(runtime.update).toHaveBeenCalledExactlyOnceWith(status());
  expect(document.getElementById("app-version")!.textContent).toBe("v0.4.2");
  expect(document.getElementById("runtime-pill")!.textContent).toBe("已注册 Chrome");
});

test("registration retry without a desktop host explains why it cannot run", async () => {
  await start();
  const retry = document.getElementById("link-retry")!;
  expect(retry.hidden).toBe(false);
  fireEvent.click(retry);
  expect(document.getElementById("link-action-msg")!.textContent).toMatch(/未连接到桌面宿主.*Tauri/);
});

test.each([false, true])("update check uses the persisted timestamp even when the check fails: %s", async (fails) => {
  const saved = "2026-10-09T06:20:00Z";
  const calls: string[] = [];
  await start(async (command) => {
    calls.push(command);
    if (command === "get_runtime_status") return status();
    if (command === "get_update_preference_cmd") return { enabled: false, lastCheckedAt: saved };
    if (command === "check_update_cmd" && fails) throw { code: "UPDATE_OFFLINE" };
    return null;
  });
  fireEvent.click(document.getElementById("update-check")!);
  await settle();
  expect(calls.slice(-2)).toEqual(["check_update_cmd", "get_update_preference_cmd"]);
  expect(document.getElementById("update-checked-at")!.textContent)
    .toBe(`上次检查：${formatCheckedAt(parseCheckedAt(saved)!, new Date())}`);
  expect(document.getElementById("update-msg-text")!.textContent).toMatch(fails ? /连不上/ : /最新版/);
  expect(document.getElementById("update-check")!.getAttribute("aria-busy")).toBeNull();
});

test.each(["read error", "missing", "invalid"])("a timestamp that cannot be read is hidden without losing the update result: %s", async (reason) => {
  let reads = 0;
  await start(async (command) => {
    if (command === "get_runtime_status") return status();
    if (command === "get_update_preference_cmd") {
      if (++reads === 1) return { enabled: false, lastCheckedAt: "2026-10-09T06:20:00Z" };
      if (reason === "read error") throw new Error("cannot read preferences");
      return { enabled: false, lastCheckedAt: reason === "invalid" ? "not a date" : null };
    }
    return null;
  });
  expect(document.getElementById("update-checked-at")!.hidden).toBe(false);
  fireEvent.click(document.getElementById("update-check")!);
  await settle();
  expect(document.getElementById("update-checked-at")!.hidden).toBe(true);
  expect(document.getElementById("update-msg-text")!.textContent).toContain("最新版");
  expect(document.getElementById("update-check")!.getAttribute("aria-busy")).toBeNull();
});

/** 带一份 update-check.json 的假宿主：命令照真宿主的规则改这份偏好。 */
function updateHost(initial: UpdatePreference, check: () => UpdateInfo | null | Promise<never>) {
  let pref: UpdatePreference = { ...initial };
  const calls: string[] = [];
  const handler = async (command: string, args?: Record<string, unknown>) => {
    calls.push(command);
    if (command === "get_runtime_status") return status("0.4.2");
    if (command === "get_update_preference_cmd") return { ...pref };
    if (command === "check_update_cmd") {
      pref.lastCheckedAt = "2026-10-09T15:00:00Z";
      const found = await check();
      pref.available = found;
      return found;
    }
    if (command === "set_update_preference_cmd") {
      pref.enabled = Boolean(args?.enabled);
      return { ...pref };
    }
    return null;
  };
  return { handler, calls, pref: () => pref };
}

const notice = () => document.getElementById("update-notice")!;
const dots = () => [...document.querySelectorAll<HTMLElement>("[data-update-dot]")];
const release = (version: string) => ({ version, url: `https://github.com/ptjworks/resume-form-assistant-plugin/releases/tag/desktop-v${version}` });

test("a newer version found at startup shows the strip on the main screen and marks settings", async () => {
  const host = updateHost({ enabled: true }, () => release("0.5.0"));
  await start(host.handler);
  expect(host.calls).toContain("check_update_cmd");
  expect(notice().hidden).toBe(false);
  expect(document.getElementById("update-notice-text")!.textContent).toBe("有新版本 0.5.0（现在是 0.4.2）。下载后手动安装，装之前不用卸载旧版。");
  expect(dots()).toHaveLength(2);
  expect(dots().every((dot) => !dot.hidden)).toBe(true);
  fireEvent.click(document.getElementById("update-notice-open")!);
  await settle();
  expect(host.calls).toContain("open_update_page_cmd");
});

test("closing the strip hides it for this run only, writes nothing, and keeps the marks", async () => {
  const host = updateHost({ enabled: true }, () => release("0.5.0"));
  await start(host.handler);
  const before = { ...host.pref() };
  const commandsBefore = host.calls.length;
  fireEvent.click(document.getElementById("update-notice-close")!);
  expect(notice().hidden).toBe(true);
  await settle();
  expect(host.calls.slice(commandsBefore)).toEqual([]);
  expect(host.pref()).toEqual(before);
  // 还没装上新版：「设置」上的小圆点留着。
  expect(dots().every((dot) => !dot.hidden)).toBe(true);
});

test("after a restart on the same day the strip is back without checking again", async () => {
  // 文件里留着一段开发版写的「关掉的版本」：不认，照样提示。
  const host = updateHost(
    { enabled: true, lastCheckedAt: "2026-10-09T06:20:00Z", available: release("0.5.0"), dismissedVersion: "0.5.0" } as UpdatePreference,
    () => { throw new Error("should not check twice a day"); },
  );
  await start(host.handler);
  expect(host.calls).not.toContain("check_update_cmd");
  expect(notice().hidden).toBe(false);
  expect(dots().every((dot) => !dot.hidden)).toBe(true);
});

test("with automatic checks off, nothing is shown even if an update was recorded", async () => {
  const host = updateHost({ enabled: false, lastCheckedAt: "2026-10-09T06:20:00Z", available: release("0.5.0") }, () => release("0.5.0"));
  await start(host.handler);
  expect(notice().hidden).toBe(true);
  // 手动检查查到了，也只在「关于与诊断」里说。
  fireEvent.click(document.getElementById("update-check")!);
  await settle();
  expect(document.getElementById("update-msg-text")!.textContent).toContain("有新版本 0.5.0");
  expect(notice().hidden).toBe(true);
});

test("turning automatic checks off hides the strip", async () => {
  const host = updateHost({ enabled: true }, () => release("0.5.0"));
  await start(host.handler);
  expect(notice().hidden).toBe(false);
  const toggle = document.getElementById("update-auto") as HTMLInputElement;
  toggle.checked = false;
  fireEvent.change(toggle);
  await settle();
  expect(notice().hidden).toBe(true);
  expect(dots().every((dot) => dot.hidden)).toBe(true);
});

test("a failed check shows nothing on the main screen", async () => {
  const host = updateHost({ enabled: true }, () => Promise.reject({ code: "UPDATE_OFFLINE" }));
  await start(host.handler);
  expect(host.calls).toContain("check_update_cmd");
  expect(notice().hidden).toBe(true);
  expect(dots().every((dot) => dot.hidden)).toBe(true);
});

test("when the preference file cannot be written, this run still shows what was found and keeps a closed version closed", async () => {
  // 宿主照常返回结果，但 update-check.json 一直写不进去：读回来的永远是旧文件。
  const stale: UpdatePreference = { enabled: true };
  const calls: string[] = [];
  let found = release("0.5.0");
  await start(async (command) => {
    calls.push(command);
    if (command === "get_runtime_status") return status("0.4.2");
    if (command === "get_update_preference_cmd") return { ...stale };
    if (command === "check_update_cmd") return found;
    return null;
  });
  expect(notice().hidden).toBe(false);
  fireEvent.click(document.getElementById("update-notice-close")!);
  await settle();
  expect(notice().hidden).toBe(true);
  // 再手动查一次，查到的还是同一版：这次运行里已经收起了，不再冒出来。
  fireEvent.click(document.getElementById("update-check")!);
  await settle();
  expect(calls.filter((call) => call === "check_update_cmd")).toHaveLength(2);
  expect(notice().hidden).toBe(true);
  expect(dots().every((dot) => !dot.hidden)).toBe(true);
  // 同一次运行里又出了更新的版本：再提示一次。
  found = release("0.6.0");
  fireEvent.click(document.getElementById("update-check")!);
  await settle();
  expect(notice().hidden).toBe(false);
  expect(document.getElementById("update-notice-text")!.textContent).toContain("0.6.0");
});

test("in-app download streams progress, verifies SHA-256, and requires user confirmation before opening the installer", async () => {
  const downloadDeferred = deferred<unknown>();
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  let progressListener = null as ((event: { payload: unknown }) => void) | null;
  const sha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  window.__TAURI__ = {
    core: {
      invoke: (async (command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        if (command === "get_runtime_status") return status("0.4.2");
        if (command === "get_update_preference_cmd") return { enabled: true };
        if (command === "check_update_cmd") return release("0.5.0");
        if (command === "download_update_cmd") return downloadDeferred.promise;
        if (command === "open_downloaded_update_cmd") return null;
        return null;
      }) as Invoke,
    },
    event: {
      listen: async (name, fn) => {
        if (name === "update-download-progress") {
          progressListener = fn as (event: { payload: unknown }) => void;
        }
        return () => { progressListener = null; };
      },
    },
  };
  await import("./main.ts");
  await settle();

  const downloadBtn = document.getElementById("update-notice-download") as HTMLButtonElement;
  expect(downloadBtn.textContent).toBe("下载更新");
  fireEvent.click(downloadBtn);
  await settle();

  expect(calls.some((c) => c.command === "download_update_cmd")).toBe(true);
  expect(downloadBtn.disabled).toBe(true);
  expect(downloadBtn.textContent).toBe("正在下载…");

  progressListener?.({
    payload: {
      version: "0.5.0",
      fileName: "wangshen-kuaitian_0.5.0_x64-setup.exe",
      downloadedBytes: 5 * 1024 * 1024,
      totalBytes: 10 * 1024 * 1024,
      phase: "downloading",
    },
  });
  const noticeBar = document.getElementById("update-notice-progress") as HTMLProgressElement;
  expect(noticeBar.hidden).toBe(false);
  expect(noticeBar.value).toBe(50);
  expect(document.getElementById("update-notice-text")!.textContent).toContain("50%");

  downloadDeferred.resolve({
    version: "0.5.0",
    fileName: "wangshen-kuaitian_0.5.0_x64-setup.exe",
    sha256: sha,
    sizeBytes: 10 * 1024 * 1024,
  });
  await settle();

  // 下载完成后绝不能自动调用 open_downloaded_update_cmd，必须等待用户确认。
  expect(calls.some((c) => c.command === "open_downloaded_update_cmd")).toBe(false);
  const dialog = document.querySelector("dialog.settings-dialog") as HTMLDialogElement | null;
  expect(dialog).not.toBeNull();
  expect(dialog!.textContent).toContain("确认打开 v0.5.0 安装程序？");
  expect(dialog!.textContent).toContain(sha);

  // 用户点「稍后安装」取消：不启动安装程序，按钮变为「打开安装程序」。
  const buttons = [...dialog!.querySelectorAll("button")];
  const cancelBtn = buttons.find((b) => b.textContent === "稍后安装")!;
  fireEvent.click(cancelBtn);
  await settle();
  expect(calls.some((c) => c.command === "open_downloaded_update_cmd")).toBe(false);
  expect(downloadBtn.textContent).toBe("打开安装程序");

  // 再次点击「打开安装程序」无需重下，直接弹确认窗；点「确认并打开安装程序」后才真正打开。
  const downloadCallsBefore = calls.filter((c) => c.command === "download_update_cmd").length;
  fireEvent.click(downloadBtn);
  await settle();
  expect(calls.filter((c) => c.command === "download_update_cmd")).toHaveLength(downloadCallsBefore);

  const dialog2 = document.querySelector("dialog.settings-dialog") as HTMLDialogElement;
  const confirmBtn = [...dialog2.querySelectorAll("button")].find((b) => b.textContent === "确认并打开安装程序")!;
  fireEvent.click(confirmBtn);
  await settle();
  expect(calls).toContainEqual({
    command: "open_downloaded_update_cmd",
    args: { version: "0.5.0", sha256: sha },
  });
});

test("opening settings marks <main> so the page takes only the height left under the first-run notices", async () => {
  await start();
  const main = document.querySelector("main")!;
  expect(main.dataset.view).toBe("applications");
  fireEvent.click(document.querySelector<HTMLElement>('.topbar [data-route="settings"]')!);
  await settle();
  expect(main.dataset.view).toBe("settings");
  fireEvent.click(document.querySelector<HTMLElement>('.topbar [data-route="todos"]')!);
  await settle();
  expect(main.dataset.view).toBe("todos");
});
