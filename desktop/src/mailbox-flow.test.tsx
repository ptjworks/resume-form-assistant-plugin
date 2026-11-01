import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fireEvent, waitFor, within } from "@testing-library/dom";
import type { Invoke } from "./api.ts";
import { mountMailboxes } from "./mailbox-ui.ts";
import type { MailboxView } from "./mailbox-ui.ts";

let dispose = () => {};
beforeEach(() => {
  document.body.innerHTML = readFileSync("index.html", "utf8").split("<body>")[1].split("</body>")[0];
  document.getElementById("settings-mailbox")!.hidden = false;
});
afterEach(() => dispose());
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
function setup() {
  const view: MailboxView = { accounts: [], candidates: [], pendingCount: 0 };
  const handlers: Record<string, (args?: Record<string, unknown>) => unknown> = {};
  const invoke = vi.fn(async (name: string, args?: Record<string, unknown>) => {
    if (handlers[name]) return handlers[name](args);
    if (name === "mailbox_view") return structuredClone(view);
    throw new Error(`Unexpected command: ${name}`);
  });
  const openSettings = vi.fn(), openInbox = vi.fn();
  const ui = mountMailboxes(invoke as Invoke, async () => {}, openSettings, undefined, openInbox);
  dispose = ui.dispose;
  return { ui, invoke, view, handlers, openSettings, openInbox };
}
function fillKnownMailbox(address = "new@qq.com") {
  fireEvent.input(el("mailbox-email"), { target: { value: address } });
  fireEvent.click(el("mailbox-detect"));
  fireEvent.input(el("mailbox-secret"), { target: { value: "synthetic-code" } });
}

test("settings starts with an empty list; opening and canceling a wizard never writes an account", async () => {
  const { ui, invoke } = setup(); await ui.refresh();
  expect(el("mailbox-empty").hidden).toBe(false);
  expect(el("mailbox-add").hidden).toBe(true);
  expect(el<HTMLDialogElement>("mailbox-dialog").open).toBe(false);
  el("mailbox-empty-add").focus();
  fireEvent.click(el("mailbox-empty-add"));
  expect(el<HTMLDialogElement>("mailbox-dialog").open).toBe(true);
  expect(el("mailbox-credentials").hidden).toBe(true);
  fillKnownMailbox();
  fireEvent.click(el("mailbox-cancel"));
  expect(el<HTMLDialogElement>("mailbox-dialog").open).toBe(false);
  expect(el<HTMLInputElement>("mailbox-secret").value).toBe("");
  expect(invoke.mock.calls.map(([name]) => name)).toEqual(["mailbox_view"]);
  expect(document.activeElement).toBe(el("mailbox-empty-add"));
});

test("duplicate addresses lead to the existing account without testing or overwriting it", async () => {
  const { ui, view, invoke } = setup();
  view.accounts = [{ id: "existing", email: "user@qq.com", paused: false, failures: 0, lastError: null, lastChecked: null, headerIssues: 0 }];
  await ui.refresh(); ui.openSetup();
  fireEvent.input(el("mailbox-email"), { target: { value: "User@QQ.com" } });
  fireEvent.click(el("mailbox-detect"));
  expect(el("mailbox-detection").textContent).toContain("这个邮箱已经添加");
  expect(el("mailbox-view-existing").hidden).toBe(false);
  expect(el("mailbox-credentials").hidden).toBe(true);
  expect(invoke.mock.calls.some(([name]) => name === "mailbox_connect")).toBe(false);
});

test("successful setup closes before a slow scan; the list and new mailbox action remain usable", async () => {
  const { ui, view, handlers, invoke, openSettings } = setup(); await ui.refresh(); ui.openSetup();
  handlers.mailbox_connect = async () => { view.accounts.push({ id: "new", email: "new@qq.com", paused: false, failures: 0, lastError: null, lastChecked: null, headerIssues: 0 }); };
  let finish!: (value: unknown) => void;
  handlers.mailbox_check = () => new Promise(resolve => { finish = resolve; });
  fillKnownMailbox(); fireEvent.submit(el("mailbox-form"));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("mailbox_check"));
  expect(el<HTMLDialogElement>("mailbox-dialog").open).toBe(false);
  expect(openSettings).toHaveBeenCalledOnce();
  expect(el("mailbox-empty").hidden).toBe(true);
  expect(el("mailbox-accounts").textContent).toContain("new@qq.com");
  expect(el<HTMLButtonElement>("mailbox-add").disabled).toBe(false);
  expect(el("mailbox-tab-stored").getAttribute("aria-selected")).toBe("true");
  fireEvent.click(el("mailbox-add"));
  expect(el<HTMLDialogElement>("mailbox-dialog").open).toBe(true);
  expect(el<HTMLInputElement>("mailbox-email").value).toBe("");
  finish({ checkedAccounts: 1, succeededAccounts: 0, failedAccounts: [{ accountId: "new", message: "网络不可用", paused: false }], skippedPaused: 0 });
  await waitFor(() => expect(el("mailbox-settings-status").textContent).toContain("网络不可用"));
  expect(el("mailbox-settings-status").textContent).toContain("网络不可用");
  expect(el<HTMLInputElement>("mailbox-email").value).toBe("");
});

test("failed login remains in the credentials step, allows retry, and clears secrets on close", async () => {
  const { ui, handlers, invoke } = setup(); ui.openSetup();
  handlers.mailbox_connect = async () => { throw { message: "登录被拒绝，请核对授权码。" }; };
  fillKnownMailbox(); fireEvent.submit(el("mailbox-form"));
  await waitFor(() => expect(el("mailbox-detection").dataset.state).toBe("error"));
  expect(el<HTMLDialogElement>("mailbox-dialog").open).toBe(true);
  expect(el("mailbox-credentials").hidden).toBe(false);
  expect(el<HTMLInputElement>("mailbox-email").value).toBe("new@qq.com");
  expect(el<HTMLInputElement>("mailbox-secret").value).toBe("synthetic-code");
  expect(invoke.mock.calls.some(([name]) => name === "mailbox_check")).toBe(false);
  fireEvent.keyDown(el("mailbox-dialog"), { key: "Escape" });
  expect(el<HTMLInputElement>("mailbox-secret").value).toBe("");
});

test("an in-flight connection cannot be closed or submitted twice", async () => {
  const { ui, handlers, invoke } = setup(); ui.openSetup();
  let finish!: () => void;
  handlers.mailbox_connect = () => new Promise<void>(resolve => { finish = resolve; });
  handlers.mailbox_check = async () => ({ checkedAccounts: 1, succeededAccounts: 1, failedAccounts: [], skippedPaused: 0 });
  fillKnownMailbox(); fireEvent.submit(el("mailbox-form"));
  fireEvent.submit(el("mailbox-form"));
  fireEvent.click(el("mailbox-cancel"));
  fireEvent.keyDown(el("mailbox-dialog"), { key: "Escape" });
  expect(el<HTMLDialogElement>("mailbox-dialog").open).toBe(true);
  expect(el<HTMLButtonElement>("mailbox-close").disabled).toBe(true);
  expect(invoke.mock.calls.filter(([name]) => name === "mailbox_connect")).toHaveLength(1);
  finish();
  await waitFor(() => expect(el<HTMLDialogElement>("mailbox-dialog").open).toBe(false));
  expect(el<HTMLInputElement>("mailbox-secret").value).toBe("");
});

test("manual school settings and unrelated server acceptance precede credentials", async () => {
  const { ui, handlers, invoke } = setup(); ui.openSetup();
  handlers.mailbox_discover = async () => ({ config: null, note: "未找到预设", helpUrl: null });
  fireEvent.input(el("mailbox-email"), { target: { value: "student@school.example" } });
  fireEvent.click(el("mailbox-detect"));
  await waitFor(() => expect(el("mailbox-configuration").hidden).toBe(false));
  expect(el("mailbox-credentials").hidden).toBe(true);
  fireEvent.input(el("mailbox-host"), { target: { value: "mail.other-provider.example" } });
  fireEvent.click(el("mailbox-confirm-endpoint"));
  expect(el("mailbox-credentials").hidden).toBe(false);
  fireEvent.input(el("mailbox-secret"), { target: { value: "school-code" } });
  fireEvent.input(el("mailbox-port"), { target: { value: "143" } });
  expect(el<HTMLInputElement>("mailbox-secret").value).toBe("");
  expect(el("mailbox-credentials").hidden).toBe(true);
  expect(invoke.mock.calls.some(([name]) => name === "mailbox_connect")).toBe(false);
});

test("repairing an unreadable saved configuration requires reset confirmation before connecting", async () => {
  const { ui, view, handlers, invoke } = setup();
  view.accounts = [{ id: "broken", email: "student@school.example", paused: true, failures: 0, lastError: "Configuration", lastChecked: null, headerIssues: 0, connection: null }];
  handlers.mailbox_connect = async () => {};
  handlers.mailbox_check = async () => ({ checkedAccounts: 1, succeededAccounts: 1, failedAccounts: [], skippedPaused: 0 });
  await ui.refresh();
  fireEvent.click(within(el("mailbox-accounts")).getByRole("button", { name: "修改连接" }));
  fireEvent.input(el("mailbox-host"), { target: { value: "mail.school.example" } });
  fireEvent.click(el("mailbox-config-next"));
  fireEvent.input(el("mailbox-secret"), { target: { value: "school-code" } });
  const confirmation = () => [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].find(d => d.id !== "mailbox-dialog")!;
  fireEvent.submit(el("mailbox-form"));
  expect(confirmation().textContent).toContain("原连接配置无法读取");
  expect(confirmation().textContent).toContain("待确认来信与扫描记录");
  expect(invoke.mock.calls.some(([name]) => name === "mailbox_connect")).toBe(false);
  fireEvent.click(within(confirmation()).getByRole("button", { name: "取消" }));
  expect(invoke.mock.calls.some(([name]) => name === "mailbox_connect")).toBe(false);
  fireEvent.submit(el("mailbox-form"));
  fireEvent.click(within(confirmation()).getByRole("button", { name: "确认更新" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === "mailbox_connect")).toHaveLength(1));
  await waitFor(() => expect(el<HTMLDialogElement>("mailbox-dialog").open).toBe(false));
});

test("unsaved cross-domain acceptance is not reused after cancelling and reopening setup", async () => {
  const { ui, handlers } = setup();
  handlers.mailbox_discover = async () => ({ config: { host: "mail.other-provider.example", port: 993, encryption: "tls", username: "student@school.example", sendId: false }, note: "需要核对", helpUrl: null });
  const discover = async () => {
    ui.openSetup();
    fireEvent.input(el("mailbox-email"), { target: { value: "student@school.example" } });
    fireEvent.click(el("mailbox-detect"));
    await waitFor(() => expect(el("mailbox-confirm-endpoint").hidden).toBe(false));
  };
  await discover();
  fireEvent.click(el("mailbox-confirm-endpoint"));
  expect(el("mailbox-credentials").hidden).toBe(false);
  fireEvent.click(el("mailbox-cancel"));
  await discover();
  expect(el("mailbox-credentials").hidden).toBe(true);
  expect(el<HTMLInputElement>("mailbox-secret").disabled).toBe(true);
});

test("viewing pending mail navigates to the inbox without requesting any import", async () => {
  const { ui, view, invoke, openInbox } = setup();
  view.pendingCount = 1;
  await ui.refresh();
  fireEvent.click(el("mailbox-view-pending"));
  expect(openInbox).toHaveBeenCalledOnce();
  expect(el("mailbox-tab-pending").getAttribute("aria-selected")).toBe("true");
  expect(el("mailbox-discovery").hidden).toBe(false);
  expect(invoke.mock.calls.map(([name]) => name)).toEqual(["mailbox_view"]);
});

test("disconnect failure keeps its confirmation and preserves the account", async () => {
  const { ui, view, handlers } = setup();
  view.accounts = [{ id: "existing", email: "user@qq.com", paused: false, failures: 0, lastError: null, lastChecked: null, headerIssues: 0 }];
  handlers.mailbox_delete = async () => { throw { message: "本机存储暂时不可用" }; };
  await ui.refresh();
  fireEvent.click(within(el("mailbox-accounts")).getByRole("button", { name: "断开邮箱" }));
  const confirmation = document.querySelector<HTMLDialogElement>("dialog[open]")!;
  fireEvent.click(within(confirmation).getByRole("button", { name: "断开邮箱" }));
  await waitFor(() => expect(confirmation.textContent).toContain("本机存储暂时不可用"));
  expect(confirmation.open).toBe(true);
  expect(el("mailbox-accounts").textContent).toContain("user@qq.com");
  fireEvent.click(within(confirmation).getByRole("button", { name: "取消" }));
});
