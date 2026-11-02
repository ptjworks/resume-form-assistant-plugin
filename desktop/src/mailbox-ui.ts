import type { Invoke } from "./api.ts";
import { MAIL_GUIDES, mailboxProvider, localMailConnection, requiresEndpointConfirmation, endpointConfirmation, matchesEndpointConfirmation } from "./mailbox-providers.ts";
import type { MailConnection, MailProvider, MailEndpointConfirmation } from "./mailbox-providers.ts";
import { openSettingsDialog, paragraph } from "./settings-dialog.ts";
export { mailboxProvider } from "./mailbox-providers.ts";

interface MailHeader { fromAddr: string | null; fromName: string | null; subject: string | null; sentAt: string | null }
export interface MailCandidate { id: string; accountId: string; email: string; header: MailHeader; reasons: string[] }
export interface MailAccount { id: string; email: string; paused: boolean; failures: number; lastError: string | null; lastChecked: number | null; headerIssues: number; connection?: MailConnection | null; source?: "imap" | "microsoftGraph" | "gmailApi" | "unknown" }
export interface MailboxView { accounts: MailAccount[]; candidates: MailCandidate[]; pendingCount: number; candidateIssues?: number }
interface ConfirmReport { imported: number; duplicates: number; failed: Array<{ id: string; message: string }> }
interface IgnoreReport { ignored: number; unchanged: number }
interface CheckReport {
  checkedAccounts: number;
  succeededAccounts: number;
  failedAccounts: Array<{ accountId: string; message: string; paused: boolean }>;
  partialAccounts?: Array<{ accountId: string; message: string; paused: boolean }>;
  skippedPaused: number;
}

export interface MailboxInboxBridge {
  showPending(candidate: MailCandidate | null, actions?: { save(): void; ignore(): void }): void;
  showStored(): void | Promise<void>;
  showRecycled?(): void | Promise<void>;
}

const ERRORS: Record<string, string> = {
  Auth: "登录被拒绝：请核对登录账号，按邮箱或学校要求填写密码、授权码或客户端专用密码；授权码失效时请重新生成授权码。",
  ImapDisabled: "邮箱未开启 IMAP，请按教程开启后重试。",
  Network: "连不上邮箱，请核对服务器和网络；学校可能要求校园网或没有开放 IMAP，可改用手动导入。",
  Tls: "安全连接验证失败，请检查系统时间和网络。",
  EndpointConfirmation: "服务器与邮箱域名不同，尚未核对。请修改连接，按官方教程核对后使用此配置。",
  Credentials: "系统凭据库不可用或缺少授权码，请解锁或更新授权码。",
  Protocol: "邮箱读取请求未完成，请重试；163 / 126 请核对 IMAP 授权设置。",
  TooLarge: "邮件信头过大，请改用手动导入并检查邮箱。",
  Storage: "扫描记录未保存，请检查本机磁盘后重试。",
  UnsupportedSource: "无法识别此邮箱来源，已暂停检查。请检查是否需要升级桌面版本，或断开并移除此账号。",
  Configuration: "本机邮箱连接配置无法读取或已失效，请修改连接并重新测试保存；也可以断开并重新连接。",
};
function message(error: unknown): string { return (error as { message?: string } | null)?.message || "操作没有完成，请稍后重试。"; }
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (text) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function formattedTime(unix: number | null) { return unix ? new Date(unix * 1000).toLocaleString() : "尚未完成检查"; }

export function mountMailboxes(
  invoke: Invoke,
  onImported: () => Promise<unknown>,
  openSettings: () => void,
  inboxBridge?: MailboxInboxBridge,
  openInbox?: () => void,
) {
  const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
  const form = get<HTMLFormElement>("mailbox-form");
  const email = get<HTMLInputElement>("mailbox-email");
  const secret = get<HTMLInputElement>("mailbox-secret");
  const guide = get<HTMLSelectElement>("mailbox-guide-provider");
  const host = get<HTMLInputElement>("mailbox-host"), port = get<HTMLInputElement>("mailbox-port");
  const encryption = get<HTMLSelectElement>("mailbox-encryption"), username = get<HTMLInputElement>("mailbox-username");
  const sendId = get<HTMLInputElement>("mailbox-send-id");
  const configuration = get<HTMLDetailsElement>("mailbox-configuration");
  const detection = get("mailbox-detection");
  const dialog = get<HTMLDialogElement>("mailbox-dialog");
  // A modal opened from the notification page must not inherit a hidden settings panel.
  document.body.append(dialog);
  let setupStep: "email" | "configuration" | "credentials" = "email";
  let configurationStep = false;
  let editingAccount: MailAccount | null = null;
  let returnFocus: HTMLElement | null = null;
  let disposed = false;
  let discoveryToken = 0, discoveryRequested = "";
  const normalizedAddress = () => email.value.trim().toLowerCase();
  const addressDomain = () => normalizedAddress().split("@")[1] ?? "";
  let previousAddress = "", connectionDomain = "";
  let retainConfiguration = false, credentialsCleared = false;
  let secretHint = "";
  let acceptedEndpoint: MailEndpointConfirmation | null = null;
  function updateSecretHint() {
    get("mailbox-secret-hint").textContent = secretHint + (credentialsCleared ? " 连接信息已变化，密码已清除，请重新填写。" : "");
  }
  function setSetupStep(step: typeof setupStep) {
    setupStep = step;
    get("mailbox-address-panel").hidden = step !== "email";
    get("mailbox-credentials").hidden = step !== "credentials";
    configuration.hidden = step === "email";
    if (step === "configuration") { configurationStep = true; configuration.open = true; }
    get("mailbox-back").hidden = step === "email";
    get("mailbox-detect").hidden = step !== "email";
    get("mailbox-config-next").hidden = step !== "configuration" || needsEndpointReview();
    get("mailbox-confirm-endpoint").hidden = step !== "configuration" || !needsEndpointReview();
    get("mailbox-save").hidden = step !== "credentials";
    get("mailbox-step-3").hidden = !configurationStep;
    get("mailbox-step-2-label").textContent = configurationStep ? "确认设置" : "连接邮箱";
    const active = step === "email" ? 1 : step === "configuration" ? 2 : configurationStep ? 3 : 2;
    for (let index = 1; index <= 3; index++) {
      const item = get(`mailbox-step-${index}`);
      if (index === active) item.setAttribute("aria-current", "step"); else item.removeAttribute("aria-current");
      item.dataset.complete = String(index < active);
    }
    get("mailbox-address-summary").textContent = email.value.trim();
    get("mailbox-provider-name").textContent = MAIL_GUIDES[mailboxProvider(email.value) ?? "school"].label;
    if (step === "credentials") {
      const help = MAIL_GUIDES[mailboxProvider(email.value) ?? "school"];
      get("mailbox-config-status").textContent = `${editingAccount ? "已载入保存的收信设置" : configurationStep ? "收信设置已核对" : "已识别邮箱配置"}，尚未连接。请填写${help.secret}。`;
    }
    get("mailbox-change-email").hidden = !!editingAccount;
  }
  function closeSetup(force = false) {
    if (busy && !force) return;
    ++discoveryToken;
    secret.value = ""; secret.type = "password";
    get("mailbox-toggle-secret").textContent = "显示";
    get("mailbox-toggle-secret").setAttribute("aria-label", "显示密码");
    get("mailbox-toggle-secret").setAttribute("aria-pressed", "false");
    if (typeof dialog.close === "function") dialog.close();
    dialog.removeAttribute("open");
    dialog.classList.remove("settings-dialog");
    if (returnFocus?.isConnected) returnFocus.focus();
  }
  function openSetup(account?: MailAccount, trigger?: HTMLElement) {
    if (busy || disposed) return;
    returnFocus = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const closedMenu = returnFocus?.closest<HTMLDetailsElement>("details:not([open])");
    if (closedMenu) returnFocus = closedMenu.querySelector("summary");
    editingAccount = account ?? null;
    configurationStep = false;
    retainConfiguration = false; credentialsCleared = false;
    email.value = account?.email ?? ""; secret.value = "";
    [email, secret, host, port, username].forEach(field => field.removeAttribute("aria-invalid"));
    get("mailbox-dialog-title").textContent = account ? "修改邮箱连接" : "添加邮箱";
    get("mailbox-save").textContent = account ? "连接并更新" : "连接并添加";
    get("mailbox-view-existing").hidden = true;
    get<HTMLDetailsElement>("mailbox-guide-details").open = false;
    updateProvider(false, !!account && !account.connection);
    if (account?.connection) {
      fillConnection(account.connection, true); retainConfiguration = true;
      updateServerLabel();
    }
    setSetupStep(account ? account.connection ? "credentials" : "configuration" : "email");
    if (account) {
      showProgress("edited", "请核对连接并填写新的密码或授权码", "测试并保存成功后才更新原连接。", 2);
      showEndpointReview();
    }
    dialog.classList.add("settings-dialog");
    if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
    (setupStep === "email" ? email : setupStep === "configuration" ? host : secret).focus();
    syncButtons();
  }
  type ProgressState = "empty" | "typing" | "searching" | "found" | "manual" | "edited" | "unsupported" | "connecting" | "checking" | "connected" | "error";
  function showProgress(state: ProgressState, title: string, detail: string, step = 1) {
    detection.dataset.state = state;
    detection.setAttribute("aria-busy", String(["searching", "connecting", "checking"].includes(state)));
    get("mailbox-progress-title").textContent = title;
    get("mailbox-progress-detail").textContent = detail;
    get("mailbox-progress-icon").textContent = ["found", "connected"].includes(state) ? "✓" : ["manual", "error", "unsupported"].includes(state) ? "!" : String(step);
    detection.hidden = ["empty", "typing", "found"].includes(state);
  }
  let schoolHelpUrl: string | null = null;
  const selected = new Set<string>();
  const failures = new Map<string, string>();
  let current: MailboxView = { accounts: [], candidates: [], pendingCount: 0 };
  let busy = false;
  let checking = false;
  let checkAgain = false;
  let recentlyAdded = "";
  let limit = 100;
  let refreshToken = 0;
  let signature = "";
  let inboxState: "pending" | "stored" | "recycled" = "stored";
  let activeCandidateId: string | null = null;
  const existingAccountForAddress = () => current.accounts.find(account =>
    account.email.trim().toLowerCase() === normalizedAddress() && account.id !== editingAccount?.id,
  );
  const actionIds = ["mailbox-save", "mailbox-settings-check", "mailbox-inbox-check", "mailbox-save-selected", "mailbox-ignore-selected", "mailbox-load-more", "mailbox-detect"];
  function say(where: "settings" | "inbox", text: string, error = false) {
    const el = get(`mailbox-${where}-status`);
    el.textContent = text;
    el.dataset.tone = error ? "error" : "info";
  }
  function syncButtons() {
    actionIds.forEach((id) => { get<HTMLButtonElement>(id).disabled = busy || ((id === "mailbox-save-selected" || id === "mailbox-ignore-selected") && !selected.size); });
    const awaitingReview = needsEndpointReview();
    get<HTMLButtonElement>("mailbox-save").disabled = busy || awaitingReview;
    get("mailbox-save").textContent = busy && detection.dataset.state === "connecting" ? "正在连接…" : editingAccount ? "连接并更新" : "连接并添加";
    ["mailbox-settings-check", "mailbox-inbox-check"].forEach(id => { get<HTMLButtonElement>(id).disabled = busy || checking; });
    ["mailbox-add", "mailbox-empty-add", "mailbox-cancel", "mailbox-close", "mailbox-back", "mailbox-config-next", "mailbox-change-email", "mailbox-view-existing"].forEach(id => { get<HTMLButtonElement>(id).disabled = busy; });
    get<HTMLButtonElement>("mailbox-detect").disabled = busy || detection.dataset.state === "searching";
    get("mailbox-detect").textContent = detection.dataset.state === "searching" ? "正在识别…" : "下一步";
    secret.disabled = awaitingReview;
    get<HTMLButtonElement>("mailbox-confirm-endpoint").disabled = busy || !awaitingReview;
    email.readOnly = busy || !!editingAccount; secret.readOnly = busy;
    get<HTMLButtonElement>("mailbox-toggle-secret").disabled = busy;
    host.readOnly = busy; port.readOnly = busy; username.readOnly = busy;
    encryption.disabled = busy; sendId.disabled = busy;
    document.querySelectorAll<HTMLInputElement | HTMLButtonElement>("#mailbox-accounts button, #mailbox-candidates input, #mailbox-candidates button, #mailbox-select-all, #inbox-preview [data-pending-action]").forEach((el) => { el.disabled = busy; });
    document.querySelectorAll<HTMLInputElement>("#mailbox-candidates input[type=checkbox]").forEach((el) => { el.checked = selected.has(el.dataset.mailboxCandidateId!); });
    const all = get<HTMLInputElement>("mailbox-select-all");
    all.checked = current.candidates.length > 0 && current.candidates.every((item) => selected.has(item.id));
    all.indeterminate = selected.size > 0 && !all.checked;
  }
  async function action(where: "settings" | "inbox", progress: string, run: () => Promise<void>) {
    if (busy || disposed) return;
    busy = true; ++refreshToken; syncButtons(); say(where, progress);
    try { await run(); }
    catch (error) { if (!disposed) say(where, message(error), true); }
    finally { busy = false; signature = ""; if (!disposed) { syncButtons(); await refresh(); } }
  }
  function button(text: string, click: () => void) {
    const el = node("button", text); el.type = "button"; el.addEventListener("click", () => { el.focus(); click(); }); return el;
  }
  function selectInboxState(state: "pending" | "stored" | "recycled") {
    inboxState = state;
    const pending = state === "pending";
    const pendingTab = get<HTMLButtonElement>("mailbox-tab-pending");
    const storedTab = get<HTMLButtonElement>("mailbox-tab-stored");
    pendingTab.setAttribute("aria-selected", String(pending));
    storedTab.setAttribute("aria-selected", String(state === "stored"));
    document.getElementById("mailbox-tab-recycled")?.setAttribute("aria-selected", String(state === "recycled"));
    for (const [id, active] of [["mailbox-tab-pending", pending], ["mailbox-tab-stored", state === "stored"], ["mailbox-tab-recycled", state === "recycled"]] as const) {
      const tab = document.getElementById(id); if (tab) tab.tabIndex = active ? 0 : -1;
    }
    get("mailbox-discovery").hidden = !pending;
    get("inbox-stored-panel").hidden = state !== "stored";
    const recycledPanel = document.getElementById("inbox-recycled-panel");
    if (recycledPanel) recycledPanel.hidden = state !== "recycled";
    if (pending) showActiveCandidate();
    else if (state === "recycled") void inboxBridge?.showRecycled?.();
    else if (typeof inboxBridge?.showStored === "function") void inboxBridge.showStored();
  }
  function showActiveCandidate() {
    const candidate = current.candidates.find((item) => item.id === activeCandidateId) ?? current.candidates[0] ?? null;
    activeCandidateId = candidate?.id ?? null;
    get("mailbox-candidates").querySelectorAll<HTMLElement>("li[data-candidate]").forEach((item) => {
      const active = item.dataset.candidate === activeCandidateId;
      item.classList.toggle("active", active);
      item.querySelector("button[data-candidate-open]")?.setAttribute("aria-current", String(active));
    });
    if (typeof inboxBridge?.showPending === "function") {
      inboxBridge.showPending(candidate, candidate ? {
        save: () => void saveCandidates([candidate.id]),
        ignore: () => void ignore([candidate.id]),
      } : undefined);
    }
    syncButtons();
  }
  function selectCandidate(candidate: MailCandidate) {
    activeCandidateId = candidate.id;
    showActiveCandidate();
  }
  async function checkNow(where: "settings" | "inbox", prefix = "") {
    const report = await invoke<CheckReport>("mailbox_check");
    if (!report || !Array.isArray(report.failedAccounts)) {
      throw { message: `${prefix}没有取得检查结果，请等待桌面更新完成后重试。` };
    }
    if (disposed) return report;
    const paused = report.skippedPaused + report.failedAccounts.filter((account) => account.paused).length;
    const partial = report.partialAccounts ?? [];
    const recovery = paused ? ` ${paused} 个邮箱已暂停，请到「设置 → 邮箱」处理后点「恢复检查」。` : "";
    if (!report.checkedAccounts) {
      say(where, prefix + (paused ? `本次未检查邮箱。${recovery}` : "还没有连接邮箱，请先到「设置 → 邮箱」连接。"), true);
    } else if (report.failedAccounts.length || partial.length) {
      const reasons = [...new Set([...report.failedAccounts, ...partial].map((account) => account.message))].join("；");
      const result = [`${report.succeededAccounts} 个完成`];
      if (partial.length) result.push(`${partial.length} 个部分完成`);
      if (report.failedAccounts.length) result.push(`${report.failedAccounts.length} 个失败`);
      say(where, `${prefix}已检查 ${report.checkedAccounts} 个邮箱：${result.join("，")}。${reasons}${recovery}`, true);
    } else {
      say(where, `${prefix}已成功检查 ${report.succeededAccounts} 个邮箱，请查看待确认邮件。${recovery}`, paused > 0);
    }
    return report;
  }
  async function runCheck(where: "settings" | "inbox", prefix = "", queue = false) {
    if (disposed) return;
    if (checking) { if (queue) checkAgain = true; return; }
    checking = true; syncButtons(); say(where, prefix + "正在检查邮箱…");
    let report: CheckReport | undefined;
    try { report = await checkNow(where, prefix); }
    catch (error) { if (!disposed) say(where, prefix + `本次来信检查未完成：${message(error)}`, true); }
    finally {
      checking = false;
      if (!disposed) {
        syncButtons();
        const loaded = await refresh();
        if (loaded && report?.checkedAccounts && !report.failedAccounts.length && !report.partialAccounts?.length && !report.skippedPaused) {
          say(where, prefix + `已成功检查 ${report.succeededAccounts} 个邮箱。` + (current.pendingCount
            ? `当前有 ${current.pendingCount} 封待确认来信，可按需查看。` : "暂未发现招聘相关来信。"));
        }
        if (checkAgain) { checkAgain = false; void runCheck("settings"); }
      }
    }
  }
  function render() {
    const valid = new Set(current.candidates.map((item) => item.id));
    for (const id of selected) if (!valid.has(id)) selected.delete(id);
    if (activeCandidateId && !valid.has(activeCandidateId)) activeCandidateId = null;
    const accounts = get("mailbox-accounts"); accounts.replaceChildren();
    get("mailbox-empty").hidden = current.accounts.length > 0;
    get("mailbox-account-card").hidden = !current.accounts.length;
    get("mailbox-add").hidden = !current.accounts.length;
    get("mailbox-inbox-check").hidden = !current.accounts.length;
    get("mailbox-manage-link").hidden = !current.accounts.length;
    get("mailbox-inbox-overview").textContent = current.accounts.length
      ? `${current.accounts.length} 个邮箱已连接${checking ? " · 正在检查来信…" : ""}` : "";
    get("mailbox-result-actions").hidden = !current.pendingCount;
    document.getElementById("inbox-shell")?.classList.toggle("has-mailboxes", current.accounts.length > 0 || current.pendingCount > 0);
    current.accounts.forEach((account) => {
      const card = node("article", undefined, "mailbox-account");
      card.dataset.accountId = account.id; card.tabIndex = -1;
      card.classList.toggle("is-recent", account.email.toLowerCase() === recentlyAdded);
      const details = node("div", undefined, "mailbox-account-details");
      const heading = node("div", undefined, "mailbox-account-heading");
      heading.append(node("h3", account.email), node("span", account.lastError ? "连接异常" : account.paused ? "已暂停" : "正常", "mailbox-account-state"));
      card.dataset.tone = account.lastError ? "error" : account.paused ? "paused" : "ok";
      details.append(heading, node("p", `最近成功检查：${formattedTime(account.lastChecked)}`, "settings-caption"));
      const needsConnectionRepair = (account.source === undefined || account.source === "imap")
        && account.lastError === "Configuration" && !account.connection;
      if (account.lastError) {
        const detail = needsConnectionRepair
          ? "本机邮箱连接配置无法读取或已失效，请修改连接，重新测试并保存成功后再检查；也可以断开后重新添加。"
          : account.failures === 0 && !account.paused
          ? "部分文件夹或邮件未完成，其他邮件已继续扫描；程序会稍后重试。"
          : `${ERRORS[account.lastError] || "检查失败，请重新测试连接。"}${account.paused
            ? account.failures > 0 ? " 连续失败已自动暂停，处理后恢复检查。" : " 已暂停检查，处理后可恢复检查。"
            : ` 已连续失败 ${account.failures} 次。`}`;
        details.append(node("p", detail, "mailbox-error"));
      }
      if (account.headerIssues) details.append(node("p", `${account.headerIssues} 封邮件连续三次读不到信头，已停止自动重试；需要时请从邮箱下载后手动导入。`, "mailbox-error"));
      const controls = node("div", undefined, "settings-actions");
      if (account.source !== "unknown") {
        controls.append(button(account.lastError === "Auth" || account.lastError === "Credentials" ? "更新密码或授权码" : "修改连接", () => openSetup(account)));
        if (!needsConnectionRepair) controls.append(button(account.paused ? "恢复检查" : "暂停检查", () => void action("settings", "正在更新检查状态…", async () => {
          await invoke("mailbox_pause", { id: account.id, paused: !account.paused });
          if (account.paused) void runCheck("settings");
          else say("settings", "已暂停此邮箱。");
        })));
      }
      controls.append(button("断开邮箱", () => { void openSettingsDialog({
        title: "断开这个邮箱？", intro: account.email,
        body: paragraph("将清除本机的连接、待确认来信、扫描和忽略记录。已经存进档案的通知、原文和附件保留。"),
        confirmLabel: "断开邮箱", action: async () => {
          if (busy) throw new Error("另一项操作尚未完成，请稍后重试。");
          busy = true; ++refreshToken; syncButtons();
          try {
            await invoke("mailbox_delete", { id: account.id });
            say("settings", "已断开邮箱，已经存进档案的邮件保留。");
          } finally { busy = false; signature = ""; if (!disposed) { syncButtons(); await refresh(); } }
        },
      }); }));
      card.append(details, controls); accounts.append(card);
    });
    get("mailbox-pending-count").textContent = String(current.pendingCount);
    const broken = current.accounts.filter((account) => account.lastError).length;
    get("mailbox-discovery-note").textContent = broken
      ? `${broken} 个邮箱检查异常，请到邮箱设置查看原因。已发现的邮件仍可确认或忽略。`
      : current.accounts.length ? "只显示信头和入选原因，存进档案时才下载原文。筛选可能漏信，仍可手动导入。" : "连接邮箱后，招聘相关来信会先出现在这里，确认才下载原文并存进档案。";
    const issues = current.candidateIssues ?? 0;
    if (issues) get("mailbox-discovery-note").textContent += ` 另有 ${issues} 条候选记录异常，暂时无法显示，未删除；其他邮件可正常处理。可从邮箱下载原件后手动导入。`;
    get("mailbox-connect-link").textContent = current.accounts.length ? "邮箱设置" : "连接邮箱";
    get("mailbox-pending-actions").hidden = !current.candidates.length;
    get("mailbox-load-more").hidden = current.candidates.length >= current.pendingCount || limit >= 2000;
    const list = get("mailbox-candidates"); list.replaceChildren();
    current.candidates.forEach((item) => {
      const li = node("li");
      li.dataset.candidate = item.id;
      li.classList.toggle("active", item.id === activeCandidateId);
      const label = node("label", undefined, "mailbox-candidate-title");
      const check = node("input"); check.type = "checkbox"; check.checked = selected.has(item.id);
      check.dataset.mailboxCandidateId = item.id;
      check.setAttribute("aria-label", `选择 ${item.header.subject || "无主题邮件"}`);
      check.addEventListener("change", () => { if (check.checked) selected.add(item.id); else selected.delete(item.id); syncButtons(); });
      label.append(check, node("strong", item.header.subject || "无主题邮件")); li.append(label);
      li.append(node("p", `${item.header.fromName || ""} ${item.header.fromAddr || "未知发件人"} · ${item.header.sentAt ? new Date(item.header.sentAt).toLocaleString() : "发送时间未知"}`, "settings-caption"));
      li.append(node("p", `发现于 ${item.email}`, "settings-caption"));
      li.append(node("p", `入选原因：${item.reasons.join("；")}`, "mailbox-reasons"));
      if (failures.has(item.id)) li.append(node("p", failures.get(item.id), "mailbox-error"));
      const controls = node("div", undefined, "settings-actions");
      const inspect = button("查看", () => selectCandidate(item));
      inspect.dataset.candidateOpen = item.id;
      inspect.setAttribute("aria-current", String(item.id === activeCandidateId));
      controls.append(inspect);
      controls.append(button("存进档案", () => void saveCandidates([item.id])));
      controls.append(button("忽略", () => void ignore([item.id])));
      li.append(controls); list.append(li);
    });
    if (limit >= 2000 && current.pendingCount > current.candidates.length) list.append(node("li", "先处理当前显示的邮件，后续候选会继续补入。"));
    if (inboxState === "pending") showActiveCandidate();
    syncButtons();
  }
  async function refresh() {
    if (busy || disposed) return false;
    const token = ++refreshToken;
    try {
      const view = await invoke<MailboxView>("mailbox_view", { limit });
      if (token !== refreshToken || busy || disposed) return false;
      const next = JSON.stringify(view);
      current = view;
      get("mailbox-retry-read").hidden = true;
      if (next !== signature) { signature = next; render(); }
      return true;
    } catch (error) {
      if (token !== refreshToken || disposed) return false;
      say("settings", `读不到邮箱状态：${message(error)}`, true);
      get("mailbox-retry-read").hidden = false;
      say("inbox", `读不到邮箱候选：${message(error)}`, true);
      return false;
    }
  }
  async function saveCandidates(ids: string[]) {
    await action("inbox", "正在下载并存进档案…", async () => {
      let imported = 0, duplicates = 0, failed = 0;
      let completed = false;
      // Host bounds each batch; partial failures keep their candidates and reasons.
      try {
        for (let start = 0; start < ids.length; start += 100) {
          const report = await invoke<ConfirmReport>("mailbox_confirm", { ids: ids.slice(start, start + 100) });
          imported += report.imported; duplicates += report.duplicates; failed += report.failed.length;
          const bad = new Set(report.failed.map((item) => item.id));
          report.failed.forEach((item) => failures.set(item.id, item.message));
          ids.slice(start, start + 100).filter((id) => !bad.has(id)).forEach((id) => { selected.delete(id); failures.delete(id); });
        }
        completed = true;
        say("inbox", `已存进档案 ${imported} 封，已有 ${duplicates} 封${failed ? `，失败 ${failed} 封，请查看对应原因后重试` : ""}。`, failed > 0);
      } finally {
        // Refresh committed chunks even if a later chunk's IPC request fails.
        if (imported + duplicates > 0) {
          try { await onImported(); } catch { say("inbox", "邮件已处理，档案列表刷新失败，请刷新列表查看，无需重复导入。", true); }
          selectInboxState(completed && failed === 0 ? "stored" : "pending");
        }
      }
    });
  }
  async function ignore(ids: string[]) {
    await action("inbox", "正在忽略…", async () => {
      const report = await invoke<IgnoreReport>("mailbox_ignore", { ids });
      ids.forEach((id) => { selected.delete(id); failures.delete(id); });
      const changed = report?.ignored ?? 0;
      const unchanged = report?.unchanged ?? ids.length - changed;
      say("inbox", changed
        ? `已忽略 ${changed} 封，不会再提示；邮箱原件保持原样。${unchanged ? ` 另外 ${unchanged} 封已被其他操作处理。` : ""}`
        : "这些邮件已被其他操作处理，列表已刷新。", unchanged > 0);
    });
  }
  function updateGuide() {
    const provider: MailProvider = Object.hasOwn(MAIL_GUIDES, guide.value) ? guide.value as MailProvider : "school";
    const help = MAIL_GUIDES[provider];
    get("mailbox-guide-title").textContent = provider === "school" ? "密码和设置从哪里获取？" : `${help.secret}从哪里获取？`;
    const image = get<HTMLImageElement>("mailbox-guide-image");
    image.src = `/mailbox-guide-${provider}.svg`; image.alt = `${help.label}：${help.steps.join(" ")}`;
    get("mailbox-guide-steps").replaceChildren(...help.steps.map((step) => node("li", step)));
    const link = get<HTMLAnchorElement>("mailbox-guide-link");
    const url = provider === "school" ? schoolHelpUrl : help.url;
    link.hidden = !url; link.href = url ?? "#";
  }
  function fillConnection(config: MailConnection, restoreConfirmation = false) {
    acceptedEndpoint = restoreConfirmation && matchesEndpointConfirmation(email.value, config, config.endpointConfirmation) ? config.endpointConfirmation! : null;
    host.value = config.host; port.value = String(config.port); encryption.value = config.encryption;
    username.value = config.username; sendId.checked = config.sendId;
  }
  function readConnection(): MailConnection {
    const provider = mailboxProvider(email.value);
    const config: MailConnection = { host: host.value.trim().toLowerCase(), port: Number(port.value), encryption: encryption.value as "tls" | "starttls", username: username.value.trim(), sendId: sendId.checked || provider === "163" || provider === "126" };
    if (matchesEndpointConfirmation(email.value, config, acceptedEndpoint)) config.endpointConfirmation = acceptedEndpoint!;
    return config;
  }
  function needsEndpointReview() {
    const config = readConnection();
    return requiresEndpointConfirmation(email.value, config) && !matchesEndpointConfirmation(email.value, config, acceptedEndpoint);
  }
  function showEndpointReview() {
    const pending = needsEndpointReview();
    get("mailbox-endpoint-review").hidden = !pending;
    if (pending) {
      secret.value = "";
      const config = readConnection();
      get("mailbox-endpoint-detail").textContent = `邮箱域名：${addressDomain()}；目标服务器：${config.host}，端口 ${config.port}，${config.encryption === "tls" ? "TLS" : "STARTTLS"}。它与邮箱域名不同，尚未确认是学校或邮箱服务商使用的服务器。`;
      configuration.open = true;
      setSetupStep("configuration");
      showProgress("manual", "发现跨域服务器，待核对", "请先按官方教程核对下方服务器。确认使用此配置后，才能填写密码并测试连接。");
    }
    syncButtons();
    return pending;
  }
  function updateServerLabel() {
    get("mailbox-server").textContent = host.value.trim()
      ? `IMAP：${host.value.trim()} · ${port.value} · ${encryption.value === "tls" ? "TLS" : "STARTTLS"}`
      : "点击下一步识别邮箱，或按官方说明填写收信设置。";
  }
  function updateProvider(preserveForDomain = false, usePreset = false, advance = false) {
    ++discoveryToken; discoveryRequested = ""; schoolHelpUrl = null;
    const provider = mailboxProvider(email.value), config = usePreset ? localMailConnection(email.value) : null;
    const keep = preserveForDomain && retainConfiguration && !!addressDomain() && addressDomain() === connectionDomain;
    if (keep) {
      // Follow the email only while the login is still the previous default.
      if (username.value.trim().toLowerCase() === previousAddress) username.value = email.value.trim();
    } else {
      fillConnection(config ?? { host: "", port: 993, encryption: "tls", username: email.value.trim(), sendId: false });
      retainConfiguration = false;
    }
    connectionDomain = addressDomain();
    previousAddress = normalizedAddress();
    if (provider === "school") schoolHelpUrl = "https://mails.tsinghua.edu.cn/coremail/help/notice.html";
    guide.value = provider ?? "school"; updateGuide();
    const help = MAIL_GUIDES[provider ?? "school"];
    get("mailbox-secret-label").textContent = help.secret;
    secretHint = `${provider === "school" ? "清华邮箱请生成客户端专用密码。" : ""}${help.hint} 只存系统凭据库，保存后不回显。`;
    updateSecretHint();
    configuration.open = keep;
    const microsoft = /@(outlook\.com|hotmail\.com|live\.com|msn\.com)$/i.test(email.value.trim());
    if (microsoft && usePreset) showProgress("unsupported", "此邮箱暂不支持直接连接", "需要微软登录授权，目前尚未接入。可取消连接，到招聘通知页导入从邮箱下载的 .eml 文件。");
    else if (keep) showProgress("edited", "邮箱地址已更新，服务器配置已保留", "下一步：核对登录账号，重新填写所需密码，再点击“连接并添加”。", 2);
    else if (config) showProgress("found", `已找到配置 · ${help.label}`, `服务器：${config.host}。配置已填好，尚未连接。下一步：填写${help.secret}，点击“连接并添加”。${provider === "school" ? "清华邮箱需要客户端专用密码。" : ""}`, 2);
    else if (email.value.trim()) showProgress("typing", "邮箱地址待确认", "输入完成后按回车，或点击“确认并识别”，再查找邮箱配置。");
    else showProgress("empty", "先填写邮箱地址", "第 1 步：输入完整邮箱地址，按回车或点击“确认并识别”。");
    updateServerLabel();
    if (advance && config) setSetupStep("credentials");
    else setSetupStep("email");
    showEndpointReview();
  }
  async function discover() {
    const address = normalizedAddress();
    if (busy || (detection.dataset.state === "searching" && discoveryRequested === address)) return;
    if (!email.validity.valid || !address || !addressDomain().includes(".")) {
      showProgress("error", "请填写完整邮箱地址", "例如 name@qq.com。填写完成后点击下一步。");
      email.setAttribute("aria-invalid", "true"); email.focus();
      return;
    }
    email.removeAttribute("aria-invalid");
    const existing = existingAccountForAddress();
    get("mailbox-view-existing").hidden = !existing;
    if (existing) { showProgress("error", "这个邮箱已经添加", "可查看已添加的邮箱，或修改它的连接设置。"); return; }
    if (localMailConnection(address) || /@(outlook\.com|hotmail\.com|live\.com|msn\.com)$/i.test(address)) {
      updateProvider(false, true, true);
      return;
    }
    if (retainConfiguration && !!host.value.trim() && addressDomain() === connectionDomain) {
      showProgress("edited", "邮箱地址已更新，收信设置已保留", "请核对登录用户名，再填写密码或授权码。", 2);
      if (!showEndpointReview()) {
        setSetupStep("credentials"); configuration.open = false; secret.focus();
      }
      return;
    }
    const token = ++discoveryToken; discoveryRequested = address;
    showProgress("searching", "正在识别邮箱配置…", "最多等待 3 秒。查到后会自动填写；也可以直接填写下方配置。");
    syncButtons();
    try {
      const result = await invoke<{ config: MailConnection | null; source: string; note: string; helpUrl: string | null }>("mailbox_discover", { email: address });
      if (token !== discoveryToken || normalizedAddress() !== address || disposed) return;
      if (result.config) { fillConnection(result.config); retainConfiguration = true; connectionDomain = addressDomain(); }
      configuration.open = !result.config;
      if (result.config) showProgress("found", "已找到邮箱配置", `${result.note} 配置已填好，尚未连接。下一步：按学校要求填写密码，点击“连接并添加”。`, 2);
      else showProgress("manual", "未找到配置，需要手动填写", `${result.note} 请按学校或邮箱官方说明填写以下收信设置。`);
      setSetupStep(result.config ? "credentials" : "configuration");
      schoolHelpUrl = result.helpUrl; updateGuide(); updateServerLabel(); showEndpointReview();
    } catch (error) {
      if (token !== discoveryToken || disposed) return;
      configuration.open = true;
      setSetupStep("configuration");
      showProgress("manual", "识别未完成，需要手动填写", `未能自动识别，请按学校或邮箱官方教程手动填写。${message(error)}`);
    } finally {
      if (token === discoveryToken && !disposed) syncButtons();
    }
  }
  function manualConfigurationChanged() {
    if (secret.value) { secret.value = ""; credentialsCleared = true; updateSecretHint(); }
    if (["163", "126"].includes(mailboxProvider(email.value) ?? "")) sendId.checked = true;
    retainConfiguration = true; connectionDomain = addressDomain();
    ++discoveryToken; updateServerLabel(); showProgress("edited", "已切换为手动配置，等待测试", "下一步：核对服务器、端口和账号，填写所需密码，再点击“连接并添加”。", 2);
    setSetupStep("configuration");
    showEndpointReview();
  }
  function validConnection() {
    const config = readConnection();
    const invalid = !config.host || /[\s/?#]/.test(config.host) || config.host.includes("://") ? host
      : !config.username ? username : !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 ? port : null;
    [host, username, port].forEach(field => field.removeAttribute("aria-invalid"));
    if (invalid) {
      setSetupStep("configuration");
      invalid.setAttribute("aria-invalid", "true"); invalid.focus();
      showProgress("error", "收信设置还没填完整", "请填写官方提供的收信服务器、有效端口和登录用户名；服务器不是网页登录地址。", 2);
      return false;
    }
    return true;
  }
  [host, port, username, encryption, sendId].forEach((input) => {
    input.addEventListener("input", manualConfigurationChanged);
    input.addEventListener("change", manualConfigurationChanged);
  });
  get("mailbox-confirm-endpoint").addEventListener("click", () => {
    if (busy || !needsEndpointReview() || !validConnection()) return;
    acceptedEndpoint = endpointConfirmation(email.value, readConnection());
    showEndpointReview();
    showProgress("edited", "已确认使用此服务器，等待测试", "下一步：填写所需密码，点击“连接并添加”。确认配置不代表已经连接成功。", 2);
    setSetupStep("credentials"); configuration.open = false;
    secret.focus();
  });
  get("mailbox-config-next").addEventListener("click", () => {
    if (busy || !validConnection() || showEndpointReview()) return;
    setSetupStep("credentials"); configuration.open = false;
    detection.hidden = true; secret.focus();
  });
  get("mailbox-detect").addEventListener("click", () => { void discover(); });
  email.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    if (!event.repeat) void discover();
  });
  get("mailbox-guide-link").addEventListener("click", (event) => {
    event.preventDefault();
    const url = get<HTMLAnchorElement>("mailbox-guide-link").getAttribute("href");
    if (url && url !== "#") void invoke("mailbox_open_help", { url }).catch((error) => {
      if (!disposed) showProgress("error", "帮助页面未能打开", message(error));
    });
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (setupStep === "email") { void discover(); return; }
    if (busy || showEndpointReview()) return;
    if (setupStep === "configuration") { get("mailbox-config-next").click(); return; }
    const config = readConnection();
    if (!email.validity.valid || !email.value.trim()) { setSetupStep("email"); email.focus(); return; }
    const existing = existingAccountForAddress();
    if (existing) {
      setSetupStep("email");
      get("mailbox-view-existing").hidden = false;
      showProgress("error", "这个邮箱已经添加", "请查看或修改已有邮箱，不会覆盖它的连接和待确认来信。");
      email.focus();
      return;
    }
    if (!validConnection()) return;
    if (!secret.value.trim()) { secret.setAttribute("aria-invalid", "true"); showProgress("error", "请填写密码或授权码", "按当前邮箱的教程获取后，填写到下方输入框。", 2); secret.focus(); return; }
    const destinationChanged = editingAccount && (!editingAccount.connection ||
      JSON.stringify(endpointConfirmation(email.value, editingAccount.connection)) !== JSON.stringify(endpointConfirmation(email.value, config)));
    const connect = async () => {
      let saved = false;
      ++discoveryToken;
      showProgress("connecting", "正在连接邮箱…", "正在测试并安全保存连接，请稍候。", 2);
      await action("settings", "正在测试连接，通过后才保存…", async () => {
        try {
          await invoke("mailbox_connect", { email: email.value.trim(), secret: secret.value, config });
          saved = true;
          if (disposed) return;
          recentlyAdded = email.value.trim().toLowerCase();
          showProgress("connected", "邮箱已连接", "连接已保存，正在检查来信。");
          closeSetup(true); openSettings();
          say("settings", "邮箱连接已保存，正在检查最近 30 天的来信…");
        } catch (error) {
          if (!disposed) showProgress("error", "连接失败，配置尚未保存", message(error), 2);
          throw error;
        }
      });
      if (saved && !disposed) void runCheck("settings", "邮箱连接已保存。", true);
    };
    if (destinationChanged) {
      const impact = editingAccount?.connection
        ? "修改收信服务器或登录账号会清除该连接的待确认来信与扫描记录，已存进档案的邮件保留。"
        : "原连接配置无法读取，无法比较收信设置。重新设置会清除该连接的待确认来信与扫描记录，已存进档案的邮件保留。";
      void openSettingsDialog({ title: "更新收信设置？", body: paragraph(impact), confirmLabel: "确认更新", action: connect });
    } else void connect();
  });
  email.addEventListener("input", () => {
    if (normalizedAddress() === previousAddress) return;
    if (secret.value) { secret.value = ""; credentialsCleared = true; }
    updateProvider(true);
  });
  secret.addEventListener("input", () => { credentialsCleared = false; secret.removeAttribute("aria-invalid"); updateSecretHint(); });
  guide.addEventListener("change", updateGuide);
  ["mailbox-settings-check", "mailbox-inbox-check"].forEach((id) => get(id).addEventListener("click", () => {
    const where = id.includes("settings") ? "settings" : "inbox";
    void runCheck(where);
  }));
  get("mailbox-connect-link").addEventListener("click", () => { if (current.accounts.length) openSettings(); else openSetup(); });
  get("mailbox-manage-link").addEventListener("click", openSettings);
  ["mailbox-add", "mailbox-empty-add", "inbox-add-mailbox"].forEach(id => get(id).addEventListener("click", event => {
    get<HTMLDetailsElement>("inbox-add-menu").open = false; openSetup(undefined, event.currentTarget as HTMLElement);
  }));
  get("mailbox-retry-read").addEventListener("click", () => { void refresh(); });
  get("mailbox-view-existing").addEventListener("click", () => {
    if (busy) return;
    recentlyAdded = normalizedAddress(); closeSetup(); openSettings(); signature = ""; void refresh();
  });
  ["mailbox-close", "mailbox-cancel"].forEach(id => get(id).addEventListener("click", () => closeSetup()));
  dialog.addEventListener("cancel", event => { event.preventDefault(); closeSetup(); });
  dialog.addEventListener("keydown", event => { if (event.key === "Escape" && !event.isComposing) { event.preventDefault(); closeSetup(); } });
  get("mailbox-back").addEventListener("click", () => {
    if (busy) return;
    setSetupStep(setupStep === "credentials" && (configurationStep || editingAccount) ? "configuration" : "email");
    detection.hidden = true; (setupStep === "email" ? email : host).focus();
  });
  get("mailbox-change-email").addEventListener("click", () => { if (busy) return; setSetupStep("email"); detection.hidden = true; email.focus(); });
  get("mailbox-toggle-secret").addEventListener("click", () => {
    const visible = secret.type === "password"; secret.type = visible ? "text" : "password";
    get("mailbox-toggle-secret").textContent = visible ? "隐藏" : "显示";
    get("mailbox-toggle-secret").setAttribute("aria-label", visible ? "隐藏密码" : "显示密码");
    get("mailbox-toggle-secret").setAttribute("aria-pressed", String(visible));
  });
  get("mailbox-view-pending").addEventListener("click", () => { openInbox?.(); selectInboxState("pending"); });
  get("mailbox-tab-pending").addEventListener("click", () => selectInboxState("pending"));
  get("mailbox-tab-stored").addEventListener("click", () => selectInboxState("stored"));
  document.getElementById("mailbox-tab-recycled")?.addEventListener("click", () => selectInboxState("recycled"));
  const stateTabs = ["mailbox-tab-pending", "mailbox-tab-stored", "mailbox-tab-recycled"].map(id => document.getElementById(id)).filter((tab): tab is HTMLElement => Boolean(tab));
  stateTabs.forEach((tab, index) => tab.addEventListener("keydown", event => {
    const next = ({ ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: stateTabs.length - 1 } as Record<string, number>)[event.key];
    if (next === undefined) return;
    event.preventDefault(); const target = stateTabs[(next + stateTabs.length) % stateTabs.length]; target.click(); target.focus();
  }));
  get<HTMLInputElement>("mailbox-select-all").addEventListener("change", (event) => {
    current.candidates.forEach((item) => { if ((event.target as HTMLInputElement).checked) selected.add(item.id); else selected.delete(item.id); }); syncButtons();
  });
  get("mailbox-save-selected").addEventListener("click", () => void saveCandidates([...selected]));
  get("mailbox-ignore-selected").addEventListener("click", () => void ignore([...selected]));
  get("mailbox-load-more").addEventListener("click", () => { limit += 100; void refresh(); });
  updateGuide(); updateProvider(); selectInboxState("stored");
  return { refresh, openSetup, dispose: () => { disposed = true; ++discoveryToken; ++refreshToken; closeSetup(true); dialog.remove(); } };
}
