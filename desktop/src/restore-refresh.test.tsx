import { beforeEach, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { Invoke } from "./api.ts";

// #314：恢复、回滚换回、云端恢复都会把档案整个换掉。这里跑 main.ts 真实的接线，
// 证明这三条路都会让「申请」「招聘通知」「简历」重新读取，而不是只刷新备份区。
const views = vi.hoisted(() => ({
  reloadArchive: vi.fn(async () => {}),
  refreshList: vi.fn(async () => {}),
  refreshView: vi.fn(async () => {}),
  inboxRefresh: vi.fn(async () => true),
  resumeRefresh: vi.fn(),
  localBackup: vi.fn(async () => {}),
  invoke: vi.fn<Invoke>(),
  localBackupInvoke: null as Invoke | null,
  cloudBackupInvoke: null as Invoke | null,
  cloudBackup: vi.fn(async () => {}),
  onLocalRestored: null as null | (() => void),
  onCloudRestored: null as null | (() => void | Promise<void>),
}));

vi.mock("./feedback.ts", () => ({ installFrontendErrors: vi.fn() }));
vi.mock("./react/feedback-mount.tsx", () => ({ mountFeedbackSettings: vi.fn() }));
vi.mock("./react/usage-mount.tsx", () => ({ mountUsageSettings: vi.fn() }));
vi.mock("./usage-metrics.ts", () => ({ installUsageSignals: vi.fn() }));
vi.mock("./react/runtime-status-mount.tsx", () => ({ mountRuntimeStatus: () => ({ update: vi.fn(), fail: vi.fn() }) }));
vi.mock("./ai/mount.tsx", () => ({ mountAiSettings: vi.fn(), mountAiReview: vi.fn() }));
vi.mock("./applications-ui.ts", () => ({
  mountApplications: () => ({ refreshList: views.refreshList, refreshView: views.refreshView, reloadArchive: views.reloadArchive }),
}));
vi.mock("./inbox-ui.ts", () => ({ mountInbox: () => ({ refresh: views.inboxRefresh }) }));
vi.mock("./todos-ui.ts", () => ({ mountTodos: () => async () => {} }));
vi.mock("./resume/mount.tsx", () => ({
  mountResume: () => ({ refresh: views.resumeRefresh, confirmLeave: async () => true }),
}));
vi.mock("./backup-ui.ts", () => ({
  mountBackup: (invoke: Invoke, _pickers: unknown, _now: unknown, onRestored: () => void) => {
    views.localBackupInvoke = invoke;
    views.onLocalRestored = onRestored;
    return views.localBackup;
  },
}));
vi.mock("./cloud-backup-ui.ts", () => ({
  mountCloudBackup: (invoke: Invoke, onRestored: () => void | Promise<void>) => {
    views.cloudBackupInvoke = invoke;
    views.onCloudRestored = onRestored;
    return views.cloudBackup;
  },
}));

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  document.body.innerHTML = readFileSync("index.html", "utf8").split("<body>")[1].split("</body>")[0];
  views.invoke.mockReset();
  views.invoke.mockRejectedValue(new Error("未模拟的命令"));
  window.__TAURI__ = { core: { invoke: views.invoke as Invoke } };
  await import("./main.ts");
  for (let i = 0; i < 12; i++) await Promise.resolve();
  // 启动时那一轮读取不算，只看恢复之后。
  vi.clearAllMocks();
});

function expectEveryViewReloaded() {
  expect(views.reloadArchive).toHaveBeenCalledTimes(1);
  expect(views.inboxRefresh).toHaveBeenCalledTimes(1);
  expect(views.resumeRefresh).toHaveBeenCalledTimes(1);
}

test("returning from notifications reloads the applications list and selected detail without clearing archive notices", async () => {
  document.querySelector<HTMLButtonElement>('.nav button[data-route="inbox"]')!.click();
  await Promise.resolve();
  document.querySelector<HTMLButtonElement>('.nav button[data-route="applications"]')!.click();
  await Promise.resolve();
  expect(views.refreshView).toHaveBeenCalledTimes(1);
  expect(views.reloadArchive).not.toHaveBeenCalled();
  document.querySelector<HTMLButtonElement>('.nav button[data-route="applications"]')!.click();
  await Promise.resolve();
  expect(views.refreshView).toHaveBeenCalledTimes(1);
});

test("a local restore or rollback reloads applications, inbox and resume, then the cloud backup panel", async () => {
  views.onLocalRestored!();
  await Promise.resolve();
  expectEveryViewReloaded();
  expect(views.cloudBackup).toHaveBeenCalledWith(true);
});

test("a cloud restore reloads applications, inbox and resume, then the local backup panel", async () => {
  await views.onCloudRestored!();
  expectEveryViewReloaded();
  expect(views.localBackup).toHaveBeenCalledTimes(1);
});

test("a failed applications reload is shown on the applications page instead of failing the cloud restore", async () => {
  views.reloadArchive.mockRejectedValueOnce(new Error("读不到申请"));
  await expect(views.onCloudRestored!()).resolves.toBeUndefined();
  expect(document.getElementById("apps-msg")!.textContent).toContain("读不到申请");
  expect(views.inboxRefresh).toHaveBeenCalledTimes(1);
});

test("leaving the data panel, by another settings category or another page, tells the backup areas to drop their notices", async () => {
  const left = vi.fn();
  document.getElementById("settings-data")!.addEventListener("backup-leave", left);
  const click = (selector: string) => document.querySelector<HTMLButtonElement>(selector)!.click();
  click('.nav button[data-route="settings"]');
  await Promise.resolve();
  click('[data-settings-tab="data"]');
  expect(left).not.toHaveBeenCalled();
  click('[data-settings-tab="general"]');
  expect(left).toHaveBeenCalledTimes(1);
  click('[data-settings-tab="data"]');
  click('.nav button[data-route="applications"]');
  for (let i = 0; i < 4; i++) await Promise.resolve();
  expect(left).toHaveBeenCalledTimes(2);
});


test("an unsaved note keeps the draft in the editor when the user tries to open backup settings", async () => {
  views.invoke.mockImplementation((async (command: string) => {
    if (command === "note_index_cmd") return {
      epoch: "note-archive",
      folders: [{ id: "folder", name: "复盘", recycled: false }],
      notes: [],
    };
    if (command === "set_note_editing_cmd") return;
    if (command === "save_note_cmd") throw new Error("磁盘写入失败");
    throw new Error("未模拟的命令");
  }) as Invoke);

  document.querySelector<HTMLButtonElement>('.nav button[data-route="notes"]')!.click();
  await vi.waitFor(() => expect(document.querySelector(".notes-folder-header > button")).not.toBeNull());
  document.querySelector<HTMLButtonElement>(".notes-folder-header > button")!.click();
  const notes = document.getElementById("view-notes")!;
  Array.from(notes.querySelectorAll("button")).find(button => button.textContent === "写心得")!.click();
  const title = await vi.waitFor(() => {
    const input = notes.querySelector<HTMLInputElement>('.notes-title-input');
    expect(input).not.toBeNull();
    return input!;
  });
  title.value = "尚未保存的复盘";
  title.dispatchEvent(new Event("input", { bubbles: true }));

  document.querySelector<HTMLButtonElement>('.nav button[data-route="settings"]')!.click();
  const cancel = await vi.waitFor(() => {
    const button = Array.from(document.querySelectorAll("dialog button"))
      .find(button => button.textContent === "继续编辑");
    expect(button).toBeDefined();
    return button as HTMLButtonElement;
  });
  cancel.click();
  for (let i = 0; i < 6; i++) await Promise.resolve();

  expect(document.getElementById("view-settings")!.classList.contains("hidden")).toBe(true);
  expect(notes.classList.contains("hidden")).toBe(false);
  expect(title.value).toBe("尚未保存的复盘");
  expect(views.invoke).toHaveBeenCalledWith("save_note_cmd", expect.anything());

  const replacements = [
    [views.localBackupInvoke!, "restore_archive_cmd", { package: "backup.zip" }],
    [views.localBackupInvoke!, "rollback_to_cmd", { id: "rollback" }],
    [views.cloudBackupInvoke!, "cloud_backup_restore", { token: "preview" }],
  ] as const;
  for (const [invoke, name, args] of replacements) {
    await expect(invoke(name, args)).rejects.toThrow("请先结束心得编辑或操作");
    expect(views.invoke).not.toHaveBeenCalledWith(name, args);
  }
  expect(notes.contains(title)).toBe(true);
  expect(title.value).toBe("尚未保存的复盘");
});
