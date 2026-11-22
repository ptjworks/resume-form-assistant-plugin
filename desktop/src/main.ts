import "./attachments.css";
import "./mailbox.css";
import "./notes/notes.css";
import { mountNotes, type NotesApplication } from "./notes/view.ts";
import { countCompanyNotes, type CompanyFolder, type CompanyNote } from "./notes/company.ts";
import { installFrontendErrors } from "./feedback.ts";
import { mountFeedbackSettings } from "./react/feedback-mount.tsx";
import { mountUsageSettings } from "./react/usage-mount.tsx";
import { installUsageSignals } from "./usage-metrics.ts";
import type { Invoke, ResumeFileKind, RuntimeStatus } from "./api.ts";
import { input, must } from "./dom.ts";
import { createPairingController } from "./pairing-form.ts";
import {
  AFTER_INSTALL_HINT,
  CONFLICT_HINT,
  STORE_PENDING_HINT,
  describeLink,
  describeRegistration,
  registrationCompleted,
} from "./browser-link.ts";
import type { NativeMessagingRegistrationOutcome } from "./browser-link.ts";
import {
  describeCheckFailure,
  describeDownloadedUpdate,
  describeDownloadFailure,
  describeDownloadProgress,
  describeUpdate,
  formatBytes,
  formatCheckedAt,
  outstandingUpdate,
  parseCheckedAt,
  shouldCheck,
  supportsInAppUpdateDownload,
  updateNotice,
} from "./update-check.ts";
import type { DownloadedUpdate, UpdateDownloadProgress, UpdateInfo, UpdatePreference } from "./update-check.ts";
import { mountApplications } from "./applications-ui.ts";
import { mountInbox } from "./inbox-ui.ts";
import { followInboxChanges } from "./inbox-refresh.ts";
import { mountMailboxes } from "./mailbox-ui.ts";
import { mountTodos } from "./todos-ui.ts";
import { mountBackup } from "./backup-ui.ts";
import { BACKUP_LEAVE } from "./backup.ts";
import { mountCloudBackup } from "./cloud-backup-ui.ts";
import { mountSettingsNavigation } from "./settings-navigation.ts";
import { mountRuntimeStatus } from "./react/runtime-status-mount.tsx";
import { mountAiReview, mountAiSettings } from "./ai/mount.tsx";
import { mountResume } from "./resume/mount.tsx";
import { followRequestedViews } from "./open-view.ts";
import type { ReminderCapability } from "./api.ts";
import {
  DELIVERY_WINDOW_NOTE,
  LIFECYCLE_STATES,
  QUIT_WARNING,
  describeCapability,
} from "./todos.ts";
import { bootPlatform } from "./platform/boot.ts";
import { describeDialogError, factList, fragment, openSettingsDialog, paragraph } from "./settings-dialog.ts";

const invoke: Invoke | undefined = window.__TAURI__?.core?.invoke;
installFrontendErrors(invoke ?? null);
mountFeedbackSettings(must("desktop-feedback"), must("feedback-consent"), invoke ?? null);
const usageListen = window.__TAURI__?.event?.listen;
const usageSubscribe = usageListen
  ? (changed: () => void) => usageListen("usage-metrics-changed", changed)
  : undefined;
mountUsageSettings(must("desktop-usage"), must("usage-notice"), invoke ?? null, usageSubscribe);
installUsageSignals(invoke ?? null);
const pairing = createPairingController();
const chromeInput = input("chrome-id");
const runtimeStatusView = mountRuntimeStatus(must("facts"), invoke ?? null);
mountAiSettings(must("ai-settings"), invoke ?? null);
const edgeInput = input("edge-id");
const settingsNavigation = mountSettingsNavigation(must("view-settings"), (name) => {
  if (name === "data") void showBackup().catch(() => {});
  else leaveBackup();
});
/** 离开「数据与备份」时让备份区清掉上次的结果提示，回来时不再看到过时的「已恢复」之类。 */
function leaveBackup() {
  must("settings-data").dispatchEvent(new Event(BACKUP_LEAVE));
}

const views: Record<string, HTMLElement> = {
  applications: must("view-applications"),
  resume: must("view-resume"),
  inbox: must("view-inbox"),
  todos: must("view-todos"),
  notes: must("view-notes"),
  settings: must("view-settings"),
};
const routeButtons = document.querySelectorAll<HTMLButtonElement>(".topbar button[data-route]");

/**
 * 顶栏选中指示条：滑到当前选中的 Tab 文字下方。
 * 第一次摆放、或从「没有选中」（比如在设置页）回到某个 Tab 时直接就位不滑动，之后在 Tab 之间切换才有滑动动画。
 */
const navIndicator = document.querySelector<HTMLElement>(".nav-indicator");
function placeNavIndicator(animate: boolean) {
  if (!navIndicator) return;
  const active = document.querySelector<HTMLElement>(".nav button.active");
  if (!active) {
    navIndicator.classList.remove("is-visible");
    return;
  }
  const inset = parseFloat(getComputedStyle(active).paddingLeft) || 0;
  const wasVisible = navIndicator.classList.contains("is-visible");
  navIndicator.classList.toggle("is-animated", animate && wasVisible);
  navIndicator.style.setProperty("--nav-x", `${active.offsetLeft + inset}px`);
  navIndicator.style.width = `${Math.max(0, active.offsetWidth - inset * 2)}px`;
  navIndicator.classList.add("is-visible");
}
window.addEventListener("resize", () => placeNavIndicator(false));
void document.fonts?.ready.then(() => placeNavIndicator(false));

function showRoute(name: string | undefined) {
  views.notes.parentElement?.classList.toggle("notes-workspace-active", name === "notes");
  // 设置页要让出首次使用提示条占的高度，样式按这个标记切换（见 settings.css）。
  if (views.notes.parentElement) views.notes.parentElement.dataset.view = name ?? "";
  Object.entries(views).forEach(([key, el]) => {
    el.classList.toggle("hidden", key !== name);
  });
  routeButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.route === name);
    if (btn.dataset.route === name) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  });
  placeNavIndicator(true);
}

/**
 * 切页的唯一入口（#257）：从「简历」离开时，「我的信息」有没保存的修改要先确认；
 * 从别的页切进「简历」时重新读取——插件或恢复备份可能在这期间改过档案。
 * 已经在「简历」页时再切过去不刷新，免得把正在填的「我的信息」冲掉。返回是否真的切了。
 */
let routeChange: Promise<boolean> | null = null;
async function navigate(route: string | undefined, refreshApplications = true): Promise<boolean> {
  // 上一次切页还在等用户回答离开确认：这次不叠加第二个确认。
  if (routeChange) return false;
  const onResume = !views.resume.classList.contains("hidden");
  const onNotes = !views.notes.classList.contains("hidden");
  const gate = onResume && route !== "resume" ? resumeView.confirmLeave
    : onNotes && route !== "notes" ? notes.confirmLeave : null;
  if (gate) {
    routeChange = gate();
    try {
      if (!(await routeChange)) return false;
    } finally {
      routeChange = null;
    }
  }
  const enteringResume = route === "resume" && !onResume;
  const leavingApplications = route !== "applications" && !views.applications.classList.contains("hidden");
  const enteringApplications = route === "applications" && views.applications.classList.contains("hidden");
  // 投递页里「往后改阶段」的那一条在提示条里等着撤销：切走就算确认，写进库，不能丢。
  if (leavingApplications) void applications.flushPending();
  showRoute(route);
  if (route !== "settings") leaveBackup();
  if (enteringResume) resumeView.refresh();
  if (enteringApplications && refreshApplications) void applications.refreshView();
  return true;
}

must("cloud-auto-open").addEventListener("click", async () => {
  if (!(await navigate("settings"))) return;
  settingsNavigation.select("data");
  must<HTMLDetailsElement>("cloud-auto").open = true;
});

routeButtons.forEach((btn) => {
  btn.addEventListener("click", async () => {
    const enteringNotes = btn.dataset.route === "notes" && views.notes.classList.contains("hidden");
    if (!(await navigate(btn.dataset.route))) return;
    if (enteringNotes) void notes.activate();
    // 待办的逾期汇总要在进入视图时算一次，不能在启动时就把它消费掉。
    if (btn.dataset.route === "todos") void showTodos().catch(() => {});
    if (btn.dataset.route === "settings" && !must("settings-data").hidden) void showBackup().catch(() => {});
  });
});

chromeInput.addEventListener("input", () => pairing.markChromeDirty());
edgeInput.addEventListener("input", () => pairing.markEdgeDirty());

function escapeHtml(value: unknown) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function applyPairingFields(result: { applied: boolean; chrome?: string; edge?: string }) {
  if (!result.applied) {
    return;
  }
  if (result.chrome !== undefined) {
    chromeInput.value = result.chrome;
  }
  if (result.edge !== undefined) {
    edgeInput.value = result.edge;
  }
}

let statusRequest = 0;

async function refreshStatus() {
  const request = ++statusRequest;
  if (!invoke) {
    showPill({ tone: "error", text: "未连接到桌面宿主", title: "请用 Tauri 启动，不要只打开浏览器。" });
    must("settings-version").textContent = "请在桌面应用中查看版本";
    applyLinkState(null, "未连接到桌面宿主（请用 Tauri 启动，不要只打开浏览器）");
    return;
  }
  const token = pairing.beginRefresh();
  let status: RuntimeStatus;
  try {
    status = await invoke<RuntimeStatus>("get_runtime_status");
  } catch (error) {
    if (request !== statusRequest) return;
    const reason = describeDialogError(error);
    applyLinkState(null, reason);
    runtimeStatusView.fail(reason);
    throw error;
  }
  // 定时刷新与手动注册刷新可能重叠，过期的成功和失败都不能覆盖最新状态。
  if (request !== statusRequest) return;
  showPill(describeRegistration(status));
  must("settings-version").textContent = status.appVersion ? "简历模板、求职档案与浏览器扩展协作的桌面端" : "版本未知";
  const versionTag = must("settings-version-tag");
  versionTag.textContent = status.appVersion ? `v${status.appVersion}` : "";
  versionTag.hidden = !status.appVersion;
  const version = must("app-version");
  version.textContent = status.appVersion ? `v${status.appVersion}` : "";
  version.hidden = !status.appVersion;
  const banner = must("banner");
  if (status.error) {
    banner.classList.remove("hidden");
    banner.textContent = `${status.error.code}: ${status.error.message}。${status.error.hint}`;
  } else {
    banner.classList.add("hidden");
  }
  runtimeStatusView.update(status);
  applyPairingFields(pairing.applyStatus(token, status.pairing));
  applyLinkState(status);
  void maybeAutoCheck(status);
}

function showPill(state: { tone: string; text: string; title: string }) {
  const pill = must("runtime-pill");
  pill.textContent = state.text;
  pill.title = state.title;
  pill.dataset.tone = state.tone;
}

/** 顶栏状态点与安装入口共用：进「设置 → 浏览器连接」。 */
async function goToBrowserSettings(): Promise<boolean> {
  if (!(await navigate("settings"))) return false;
  settingsNavigation.select("browser");
  return true;
}

async function goToExtensionInstall() {
  if (!(await goToBrowserSettings())) return;
  const target = must("link-install-section");
  target.scrollIntoView({ block: "nearest" });
  (must("link-install") as HTMLButtonElement).focus();
}

/** 上一次画出来的问题清单。每隔几秒刷新一次，内容没变就不重画，免得把用户展开的详情和选中的文字冲掉。 */
let lastLinkProblems = "";

/** 「浏览器连接」卡片：状态、原因、下一步、重试按钮显不显示。商店/下载入口始终在。 */
function applyLinkState(status: RuntimeStatus | null, readError?: string | null) {
  const state = describeLink(status, readError);
  const pill = must("link-status");
  pill.textContent = state.status;
  pill.dataset.tone = state.tone;
  const problem = must("link-problem");
  problem.hidden = state.text === "";
  problem.dataset.tone = state.tone === "warn" ? "warn" : "error";
  must("link-state").textContent = state.text;
  const details = must("link-problem-details");
  details.hidden = state.problems.length === 0;
  const signature = JSON.stringify(state.problems);
  if (signature !== lastLinkProblems) {
    lastLinkProblems = signature;
    const list = must("link-problem-list");
    list.replaceChildren(
      ...state.problems.map((item) => {
        const li = document.createElement("li");
        const label = document.createElement("strong");
        label.textContent = item.label;
        const note = document.createElement("code");
        note.className = "selectable";
        note.textContent = item.note;
        li.append(label, note);
        if (item.conflict) {
          const hint = document.createElement("p");
          hint.textContent = CONFLICT_HINT;
          li.append(hint);
        }
        return li;
      }),
    );
  }
  must("link-next").textContent = state.next;
  (must("link-install") as HTMLButtonElement).hidden = false;
  (must("link-download") as HTMLButtonElement).hidden = false;
  (must("link-retry") as HTMLButtonElement).hidden = !state.showRetry;
  must("link-after-install").textContent = AFTER_INSTALL_HINT;
}

/** 卡片里按钮动作的结果：成功、失败都写在按钮旁边，不靠别处的隐藏状态行。 */
function say(id: string, message: { tone: string; text: string } | null) {
  const line = must(id);
  line.textContent = message?.text ?? "";
  if (message) line.dataset.tone = message.tone;
  else delete line.dataset.tone;
}

must("runtime-pill").addEventListener("click", () => void goToBrowserSettings());
must("btn-empty-install").addEventListener("click", () => void goToExtensionInstall());

must("link-install").addEventListener("click", async () => {
  if (!invoke) {
    say("link-action-msg", { tone: "warn", text: "未连接到桌面宿主，打不开商店页。" });
    return;
  }
  say("link-action-msg", null);
  try {
    await invoke("open_extension_store_cmd");
  } catch (err: unknown) {
    say("link-action-msg", { tone: "error", text: `打不开商店页：${describeDialogError(err)}。${STORE_PENDING_HINT}` });
  }
});

must("link-download").addEventListener("click", async () => {
  if (!invoke) {
    say("link-action-msg", { tone: "warn", text: "未连接到桌面宿主，打不开插件下载页。" });
    return;
  }
  say("link-action-msg", null);
  try {
    await invoke("open_plugin_release_cmd");
  } catch (err: unknown) {
    say("link-action-msg", { tone: "error", text: `打不开插件下载页：${describeDialogError(err)}。${STORE_PENDING_HINT}` });
  }
});

must("link-retry").addEventListener("click", async () => {
  if (!invoke) {
    say("link-action-msg", { tone: "warn", text: "未连接到桌面宿主，请用 Tauri 启动后重新检查注册。" });
    return;
  }
  const button = must("link-retry") as HTMLButtonElement;
  // 不禁用按钮（禁用会弄丢键盘焦点），用 aria-busy 挡重复点击。
  if (button.getAttribute("aria-busy") === "true") return;
  button.setAttribute("aria-busy", "true");
  say("link-action-msg", { tone: "pending", text: "正在重新检查注册…" });
  try {
    const outcomes = await invoke<NativeMessagingRegistrationOutcome[]>("register_native_messaging_cmd");
    say(
      "link-action-msg",
      registrationCompleted(outcomes)
        ? { tone: "ok", text: "已重新检查，所有浏览器都注册好了。" }
        : { tone: "warn", text: "已重新检查，仍有浏览器没注册上，原因见上方。" },
    );
  } catch (err: unknown) {
    say("link-action-msg", { tone: "error", text: `重新检查注册失败：${describeDialogError(err)}` });
  } finally {
    button.removeAttribute("aria-busy");
  }
  await refreshStatus().catch(() => {});
});

let pairingSaving = false;
must("pairing-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (pairingSaving) return;
  pairingSaving = true;
  const fields = must("pairing-form").querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button");
  fields.forEach((field) => { field.disabled = true; });
  say("pairing-msg", { tone: "pending", text: "正在保存…" });
  if (!invoke) {
    say("pairing-msg", { tone: "warn", text: "未连接到桌面宿主，草稿没有保存。" });
    pairingSaving = false;
    fields.forEach((field) => { field.disabled = false; });
    return;
  }
  const typed = {
    chrome: chromeInput.value,
    edge: edgeInput.value,
  };
  try {
    const saved = await invoke<{ chromeExtensionId?: string | null; edgeExtensionId?: string | null }>("save_pairing_draft", {
      chromeExtensionId: typed.chrome,
      edgeExtensionId: typed.edge,
    });
    const applied = pairing.onSaveSuccess(saved);
    chromeInput.value = applied.chrome;
    edgeInput.value = applied.edge;
    // 手填的 ID 要进 host 清单才有意义，所以保存完顺手重写一次。
    let registrationOk = false;
    try {
      const outcomes = await invoke<NativeMessagingRegistrationOutcome[]>(
        "register_native_messaging_cmd",
      );
      registrationOk = registrationCompleted(outcomes);
    } catch {
      // 重写失败不影响草稿本身，状态刷新之后界面会说清楚。
    }
    say(
      "pairing-msg",
      registrationOk
        ? { tone: "ok", text: "已保存，并把这几个 ID 一起写进了 host 清单。" }
        : { tone: "warn", text: "ID 已保存，但 host 清单没有全部更新成功。原因见上方连接卡片，处理后点「重新检查注册」。" },
    );
    await refreshStatus().catch(() => {});
  } catch (err: unknown) {
    pairing.onSaveFailure();
    chromeInput.value = typed.chrome;
    edgeInput.value = typed.edge;
    say("pairing-msg", { tone: "error", text: `没有保存：${describeDialogError(err)}。输入的内容还在，可以修改后重试。` });
  } finally { pairingSaving = false; fields.forEach((field) => { field.disabled = false; }); }
});

must("btn-hide").addEventListener("click", async () => {
  say("hide-msg", null);
  if (!invoke) {
    say("hide-msg", { tone: "warn", text: "未连接到桌面宿主，窗口没有隐藏。" });
    return;
  }
  try {
    await invoke("hide_main_window_cmd");
  } catch (error) {
    say("hide-msg", { tone: "error", text: `没能隐藏窗口：${describeDialogError(error)}` });
  }
});
must("btn-quit").addEventListener("click", () => {
  const errorLine = must("quit-error");
  errorLine.hidden = true;
  // §5.4：退出前必须告知提醒会停。关窗不会，退出会——这两件事用户分不清，
  // 所以在这里说，而不是指望他记得设置页写过。
  void openSettingsDialog({
    title: "退出网申快填？",
    body: fragment(
      paragraph(QUIT_WARNING),
      paragraph("只想关掉窗口的话，用「隐藏窗口」：应用留在托盘或菜单栏，提醒照常。", "settings-dialog-note"),
    ),
    confirmLabel: "退出应用",
    busyLabel: "正在退出…",
    tone: "danger",
    action: async () => {
      if (!invoke) throw new Error("未连接到桌面宿主，没有退出。");
      try {
        await invoke("quit_app");
      } catch (error) {
        errorLine.textContent = `没能退出：${describeDialogError(error)}`;
        errorLine.hidden = false;
        throw error;
      }
    },
    describeError: (error) => `没能退出：${describeDialogError(error)}`,
  });
});

/** 设置页的「提醒」一段：现在能不能响、为什么、五种状态各是什么结果。 */
async function renderReminderSettings() {
  const line = must("settings-reminder");
  const window_ = must("settings-reminder-window");
  const table = must("settings-lifecycle");

  let capability: ReminderCapability = { available: false, reason: "未连接到桌面宿主。" };
  if (invoke) {
    try {
      capability = await invoke<ReminderCapability>("reminder_capability_cmd", {});
    } catch {
      capability = { available: false, reason: "读不到系统通知的状态。" };
    }
  }

  const message = describeCapability(capability);
  line.textContent = message.text;
  must("settings-reminder-callout").dataset.tone = message.tone;
  window_.textContent = DELIVERY_WINDOW_NOTE;
  table.innerHTML = `<thead><tr><th scope="col">情况</th><th scope="col">会不会提醒</th></tr></thead><tbody>${LIFECYCLE_STATES.map(
    (state) => `<tr><th scope="row">${escapeHtml(state.when)}</th><td>${escapeHtml(state.what)}</td></tr>`,
  ).join("")}</tbody>`;
}
must("btn-diag").addEventListener("click", async () => {
  const button = must("btn-diag") as HTMLButtonElement;
  if (!invoke) {
    say("diag-msg", { tone: "warn", text: "未连接到桌面宿主，没有导出。" });
    return;
  }
  if (button.getAttribute("aria-busy") === "true") return;
  button.setAttribute("aria-busy", "true");
  say("diag-msg", { tone: "pending", text: "正在导出…" });
  try {
    const result = await invoke<{ exportPath: string }>("export_diagnostics");
    say("diag-msg", { tone: "ok", text: `已导出到 ${result.exportPath}` });
  } catch (err: unknown) {
    say("diag-msg", { tone: "error", text: `导出失败：${describeDialogError(err)}` });
  } finally {
    button.removeAttribute("aria-busy");
  }
});

// 在普通浏览器里打开（`npm run dev` / `preview`）时没有宿主。界面照常挂载，只是每个命令
// 都会用同一句话失败——比整页停在半初始化状态强，也让上面那些「未连接」提示真的看得到。
const notConnected: Invoke = async () => {
  throw { code: "NO_HOST", message: "未连接到桌面宿主（请用 Tauri 启动，不要只打开浏览器）" };
};
const command: Invoke = invoke ?? notConnected;

// 文件选择与拖放是宿主能力：这里注入真实实现，测试里注入假的。拖放事件带来的是用户
// 自己刚拖进来的路径，只在这一次导入里用；档案里的存储路径永远不下发到界面。
const dialog = window.__TAURI__?.dialog;
const events = window.__TAURI__?.event;
async function openNotes(application: NotesApplication, suggested?: string) {
  if (await navigate("notes")) await notes.activate(application, suggested);
}
const notes = mountNotes(views.notes, command, (id, recycled) => {
  void navigate("applications", false).then(moved => {
    if (moved) return applications.openFromNotes(id, recycled);
  });
});
if (events?.listen) void events.listen("note-quit-requested", async () => {
  if (routeChange) return;
  routeChange = notes.confirmLeave();
  try {
    if (await routeChange) await command("quit_app");
  } catch (error) {
    notes.fail(error);
  } finally {
    routeChange = null;
  }
});
const applications = mountApplications(command, {
  openNotes: application => void openNotes(application),
  // 展开一行时才读一次心得索引；读失败就抛错，投递页不显示「该公司心得」。
  companyNoteCount: async company => countCompanyNotes(
    await command<{ folders: CompanyFolder[]; notes: CompanyNote[] }>("note_index_cmd"), company),
  openCompanyNotes: company => void navigate("notes").then(moved => { if (moved) void notes.showCompany(company); }),
  // 跨页入口只负责切到目标页。日历页带着待办 id 进去，选中那一天那一条。
  openTodos: (target) => void navigate("todos").then((moved) => { if (moved) void showTodos(target).catch(() => {}); }),
  // 通知页切到「已处理」，只显示这一条投递的邮件。
  openInbox: (applicationId, label) => void navigate("inbox").then((moved) => { if (moved) void inbox.showApplication(applicationId, label); }),
  listen: events?.listen
    ? (name, handler) => events.listen?.(name, (event) => handler({ payload: event?.payload }))
    : undefined,
});

const RESUME_FILE_FILTERS: Record<ResumeFileKind, { name: string; extensions: string[] }> = {
  resume: { name: "简历附件", extensions: ["pdf", "doc", "docx"] },
  photo: { name: "证件照", extensions: ["jpg", "jpeg", "png"] },
  transcript: { name: "成绩单", extensions: ["pdf", "jpg", "jpeg", "png"] },
  other: { name: "其他材料", extensions: ["pdf", "doc", "docx", "jpg", "jpeg", "png"] },
};

// 简历模板只收 .xlsx / .csv；导出默认用模板名。没有 Tauri 时为 null，界面会如实说明。
const resumePickers =
  dialog?.open && dialog?.save
    ? {
        open: async () => {
          const chosen = await dialog.open?.({
            multiple: false,
            filters: [{ name: "Excel / CSV", extensions: ["xlsx", "csv"] }],
          });
          return typeof chosen === "string" ? chosen : null;
        },
        save: async (suggested: string) =>
          (await dialog.save?.({ defaultPath: suggested, filters: [{ name: "Excel", extensions: ["xlsx"] }] })) ?? null,
        // #429：附件按种类限定扩展名；真正的类型由桌面按文件头核对。
        openResumeFile: async (kind: ResumeFileKind) => {
          const chosen = await dialog.open?.({ multiple: false, filters: [RESUME_FILE_FILTERS[kind]] });
          return typeof chosen === "string" ? chosen : null;
        },
      }
    : null;
const resumeView = mountResume(
  must("resume-root"),
  invoke ?? null,
  resumePickers,
  events?.listen ? (name, handler) => events.listen?.(name, (event) => handler(event)) : undefined,
);

// Wry reports Cocoa points on macOS and physical client pixels on Windows.
function dropClientPoint(position?: { x: number; y: number }) {
  if (!position) return undefined;
  const scale = navigator.platform.startsWith("Win") ? window.devicePixelRatio || 1 : 1;
  return { x: position.x / scale, y: position.y / scale };
}

if (events?.listen) {
  for (const eventName of ["tauri://drag-enter", "tauri://drag-over"]) {
    void events.listen(eventName, event => {
      if (views.notes.classList.contains("hidden")) return;
      const payload = event.payload;
      if (payload && typeof payload === "object") notes.nativeDrag(dropClientPoint(payload.position));
    });
  }
  void events.listen("tauri://drag-leave", () => notes.nativeDrag());
  void events.listen("note-image-drop", ({ payload }) => {
    if (views.notes.classList.contains("hidden") || !payload || typeof payload !== "object") return;
    notes.nativeDrop(payload.token, dropClientPoint(payload.position), payload.error);
  });
}

const inbox = mountInbox(command, {
  mountAi: (container, evidenceId, onConfirmed, options) =>
    mountAiReview(container, invoke ?? null, evidenceId, onConfirmed, options),
  pickFiles: dialog?.open
    ? async () => {
        const chosen = await dialog.open?.({
          multiple: true,
          filters: [{ name: "招聘通知", extensions: ["eml", "txt", "png", "jpg", "jpeg", "pdf"] }],
        });
        if (!chosen) return [];
        return Array.isArray(chosen) ? chosen : [chosen];
      }
    : null,
  listenDrop: events?.listen
    ? (handle: (paths: string[]) => void) => {
        void events.listen?.("tauri://drag-drop", (event) => {
          const payload = event?.payload;
          if (typeof payload !== "object" || payload === null) return;
          const paths = payload.paths ?? [];
          if (views.notes.classList.contains("hidden")) handle(paths);
          else if (paths.length) notes.nativeDrop();
        });
      }
    : null,
});

const mailboxes = mountMailboxes(command, () => inbox.refresh(), () => {
  void navigate("settings").then((moved) => { if (moved) settingsNavigation.select("mailbox"); });
}, inbox, () => { void navigate("inbox"); });
void mailboxes.refresh();
followInboxChanges(() => inbox.refresh(), events?.listen
  ? (name, handler) => events.listen!(name, handler)
  : undefined);
if (events?.listen) void events.listen("mailbox-changed", () => { void mailboxes.refresh(); });
document.getElementById("view-inbox")?.addEventListener("click", (event) => {
  if ((event.target as HTMLElement).closest('[data-empty-act="connect"]')) {
    mailboxes.openSetup(undefined, (event.target as HTMLElement).closest<HTMLElement>('[data-empty-act="connect"]')!);
  }
});
document.getElementById("inbox-add-menu")?.addEventListener("click", event => {
  if ((event.target as HTMLElement).closest("button")) (document.getElementById("inbox-add-menu") as HTMLDetailsElement).open = false;
});
document.addEventListener("click", event => {
  const menu = document.getElementById("inbox-add-menu") as HTMLDetailsElement;
  if (menu.open && !menu.contains(event.target as Node)) menu.open = false;
});
document.addEventListener("keydown", event => {
  const menu = document.getElementById("inbox-add-menu") as HTMLDetailsElement;
  if (event.key === "Escape" && menu.open) {
    event.preventDefault(); menu.open = false; menu.querySelector("summary")?.focus();
  }
});

// 待办只能挂在申请下面：一条申请都没有时，「去新增申请」切到申请页并打开新增表单。
const showTodos = mountTodos(command, undefined, {
  writeNote: (application, suggested) => void openNotes(application, suggested),
  // 日历详情里的「查看对应投递 →」：切到投递页并展开那一条申请。
  openApplication: (id) => {
    void navigate("applications", false).then((moved) => {
      if (moved) void applications.openApplication(id);
    });
  },
  createApplication: () => {
    void navigate("applications").then((moved) => {
      if (moved) applications.openNewBar();
    });
  },
});

// 备份与恢复要用原生文件对话框。浏览器里跑（没有 Tauri）时两个都是 null，
// 界面会如实说「请在桌面程序里导出」，而不是给一个点了没反应的按钮。
const backupPickers = {
  save: dialog?.save
    ? async (suggested: string) => (await dialog.save?.({ defaultPath: suggested })) ?? null
    : null,
  open: dialog?.open
    ? async () => {
        const chosen = await dialog.open?.({
          multiple: false,
          filters: [{ name: "网申快填备份", extensions: ["zip"] }],
        });
        if (!chosen) return null;
        return Array.isArray(chosen) ? (chosen[0] ?? null) : chosen;
      }
    : null,
};
// 本地恢复、回滚换回、云端恢复都会把档案整个换掉（#314）。「申请」「招聘通知」切页不重读，
// 「简历」页手里的模板列表和「我的信息」版本号也过时了，三处一起刷新。「待办」进页面时自己会重读。
async function refreshAfterArchiveReplaced() {
  resumeView.refresh();
  notes.archiveReplaced();
  await Promise.all([
    applications.reloadArchive().catch((err: unknown) => {
      must("apps-msg").textContent = String(err);
    }),
    inbox.refresh().catch(() => {}),
    mailboxes.refresh().catch(() => {}),
  ]);
}
const backupCommand: Invoke = (name, args) => {
  if (name === "restore_archive_cmd" || name === "rollback_to_cmd" || name === "cloud_backup_restore") {
    return notes.runArchiveReplacement(() => command(name, args));
  }
  return command(name, args);
};
const refreshLocalBackup = mountBackup(backupCommand, backupPickers, undefined, () => {
  void refreshAfterArchiveReplaced();
  void refreshCloudBackup(true).catch(() => {});
});
const refreshCloudBackup = mountCloudBackup(backupCommand, async () => {
  await refreshAfterArchiveReplaced();
  await refreshLocalBackup();
});
const showBackup = async () => { await Promise.all([refreshLocalBackup(), refreshCloudBackup()]); };
void renderReminderSettings().catch(() => {});

/** 启动：先过平台步骤（显示开关、启动闸门），再走原有的启动流程。不用顶层 await。 */
async function boot() {
  await bootPlatform(document);
  showRoute("applications");
  // 插件要打开的页面由桌面记着，这里取。冷启动时请求比页面先到，光靠事件会丢（#183）。
  // 放在默认页之后，免得取到的页面又被切回首页。
  const listenForViews = events?.listen;
  if (invoke && listenForViews) {
    void followRequestedViews({
      listen: (name, handler) => listenForViews(name, () => handler()),
      take: () => invoke<string | null>("take_requested_view_cmd"),
      show: async (target) => {
        if (!(await navigate(target.route))) return;
        if (target.settingsTab) settingsNavigation.select(target.settingsTab);
      },
    }).catch(() => {});
  }
  refreshStatus().catch((err: unknown) => {
    showPill({ tone: "error", text: "读不到运行状态", title: String(err) });
  });
  applications.refreshList().catch((err: unknown) => {
    must("apps-msg").textContent = String(err);
  });
  setInterval(() => {
    refreshStatus().catch(() => {});
  }, 4000);
}
void boot();

// --- 版本与更新 ---------------------------------------------------------------------------

let pendingUpdate: UpdateInfo | null = null;
let downloadedUpdate: DownloadedUpdate | null = null;
let isDownloadingUpdate = false;
let canDownloadInApp = true;

function syncDownloadButtons() {
  const targetVersion = (pendingUpdate ?? shownNotice)?.version ?? null;
  const ready = Boolean(downloadedUpdate && targetVersion && downloadedUpdate.version === targetVersion);
  const label = isDownloadingUpdate ? "正在下载…" : ready ? "打开安装程序" : "下载更新";
  for (const id of ["update-download", "update-notice-download"]) {
    const btn = document.getElementById(id) as HTMLButtonElement | null;
    if (!btn) continue;
    btn.textContent = label;
    btn.disabled = isDownloadingUpdate;
    if (isDownloadingUpdate) btn.setAttribute("aria-busy", "true");
    else btn.removeAttribute("aria-busy");
  }
}

function setUpdateProgress(percent: number | null | undefined, visible: boolean) {
  for (const id of ["update-progress", "update-notice-progress"]) {
    const bar = document.getElementById(id) as HTMLProgressElement | null;
    if (!bar) continue;
    bar.hidden = !visible;
    if (!visible || percent === null || percent === undefined) {
      bar.removeAttribute("value");
    } else {
      bar.value = percent;
    }
  }
}

function showUpdate(message: { tone: string; text: string; available: boolean; canDownload?: boolean }) {
  const box = must("update-msg");
  must("update-msg-text").textContent = message.text;
  box.dataset.tone = message.tone;
  box.hidden = false;
  (must("update-open") as HTMLButtonElement).hidden = !message.available;
  const allowDownload = message.available && canDownloadInApp && message.canDownload !== false;
  const downloadBtn = document.getElementById("update-download") as HTMLButtonElement | null;
  if (downloadBtn) downloadBtn.hidden = !allowDownload;
  const noticeDownloadBtn = document.getElementById("update-notice-download") as HTMLButtonElement | null;
  if (noticeDownloadBtn) {
    noticeDownloadBtn.hidden = !allowDownload || !shownNotice;
  }
  syncDownloadButtons();
}

/** 主界面顶栏下的提示条，以及「设置」「关于与诊断」上的小圆点。 */
let shownNotice: UpdateInfo | null = null;
let lastPref: UpdatePreference | null = null;
// 这次运行里查成的结果（undefined 是还没查成过）。偏好文件写不进去时，
// 不能让读回来的旧文件把它盖掉；文件只管跨启动接着提示。
let checkedThisRun: UpdateInfo | null | undefined;
// 这次运行里收起的那一版。不写盘：下次打开还会提示，直到装上新版。
let closedThisRun: string | null = null;

function withThisRun(pref: UpdatePreference): UpdatePreference {
  return { ...pref, available: checkedThisRun === undefined ? pref.available : checkedThisRun };
}

function showNotice(pref: UpdatePreference | null) {
  lastPref = pref;
  const known = pref && currentAppVersion ? withThisRun(pref) : null;
  const notice = known ? updateNotice(known, currentAppVersion, closedThisRun) : null;
  shownNotice = notice;
  must("update-notice").hidden = !notice;
  const noticeDownloadBtn = document.getElementById("update-notice-download") as HTMLButtonElement | null;
  if (noticeDownloadBtn) {
    noticeDownloadBtn.hidden = !notice || !canDownloadInApp;
  }
  if (notice) {
    const ready = downloadedUpdate && downloadedUpdate.version === notice.version ? downloadedUpdate : null;
    must("update-notice-text").textContent = ready
      ? describeDownloadedUpdate(ready).text
      : describeUpdate(currentAppVersion, notice, canDownloadInApp).text;
  } else {
    must("update-notice-text").textContent = "";
  }
  syncDownloadButtons();
  // 收起提示条以后，小圆点还在，直到装上新版。
  const outstanding = known ? outstandingUpdate(known, currentAppVersion) : null;
  document.querySelectorAll<HTMLElement>("[data-update-dot]").forEach((dot) => { dot.hidden = !outstanding; });
}

/** 只有拿到真实的检查时间才显示「上次检查」，读不出来就不显示，不编一个。 */
function showCheckedAt(at: Date | null) {
  const line = must("update-checked-at");
  const text = at ? formatCheckedAt(at, new Date()) : "";
  line.textContent = text ? `上次检查：${text}` : "";
  line.hidden = !text;
}

async function checkUpdate(currentVersion: string) {
  if (!invoke) return;
  if (isDownloadingUpdate) {
    showUpdate({
      tone: "warn",
      text: "正在下载更新安装包，请等待下载完成后再检查。",
      available: Boolean(pendingUpdate ?? shownNotice),
      canDownload: canDownloadInApp,
    });
    return;
  }
  const button = must("update-check") as HTMLButtonElement;
  if (button.getAttribute("aria-busy") === "true") return;
  button.setAttribute("aria-busy", "true");
  setUpdateProgress(null, false);
  showUpdate({ tone: "pending", text: "正在检查更新…", available: false });
  try {
    pendingUpdate = (await invoke<UpdateInfo | null>("check_update_cmd")) ?? null;
    checkedThisRun = pendingUpdate;
    if (downloadedUpdate && pendingUpdate && downloadedUpdate.version === pendingUpdate.version) {
      showUpdate(describeDownloadedUpdate(downloadedUpdate));
    } else {
      if (downloadedUpdate && (!pendingUpdate || downloadedUpdate.version !== pendingUpdate.version)) {
        downloadedUpdate = null;
      }
      showUpdate(describeUpdate(currentVersion, pendingUpdate, canDownloadInApp));
    }
  } catch (error) {
    pendingUpdate = null;
    showUpdate(describeCheckFailure(error));
  } finally {
    // 检查失败也可能记录尝试时间，但只有宿主实际保存的记录才是显示依据。
    // 主界面的提示也照宿主记下的结果来：查到的版本、关掉过哪一版都在里面。
    try {
      const pref = await invoke<UpdatePreference>("get_update_preference_cmd");
      showCheckedAt(parseCheckedAt(pref.lastCheckedAt));
      showNotice(pref);
    } catch {
      showCheckedAt(null);
    }
    button.removeAttribute("aria-busy");
    button.disabled = currentAppVersion.length === 0;
  }
}

/**
 * 弹出安装确认弹窗。
 *
 * **下载并校验完成后绝不自动启动安装程序**：必须等用户在弹窗里点「确认并打开安装程序」，
 * 才调用 `open_downloaded_update_cmd` 打开本地安装包。
 */
async function confirmAndOpenInstaller(downloaded: DownloadedUpdate) {
  if (!invoke) return;
  await openSettingsDialog({
    title: `确认打开 v${downloaded.version} 安装程序？`,
    intro: "安装包已下载到本地，且与同发布页的 .sha256 文件比对一致（仅校验下载完整性，不代表代码签名或来源认证）。确认后将打开安装程序，安装前无需卸载旧版。",
    body: fragment(
      factList([
        ["新版本", `v${downloaded.version}`],
        ["安装包文件", downloaded.fileName],
        ["文件大小", formatBytes(downloaded.sizeBytes)],
        ["完整性校验 (SHA-256)", `${downloaded.sha256}（仅校验下载完整性）`],
      ]),
      paragraph("安装包尚未做代码签名，系统若弹出安全提示，请核对上方文件名后再继续。", "muted"),
    ),
    confirmLabel: "确认并打开安装程序",
    cancelLabel: "稍后安装",
    busyLabel: "正在打开安装程序…",
    size: "md",
    action: async () => {
      try {
        await invoke("open_downloaded_update_cmd", {
          version: downloaded.version,
          sha256: downloaded.sha256,
        });
      } catch (error) {
        const detail = error as { code?: string } | null;
        if (detail?.code === "UPDATE_HASH_MISMATCH" || detail?.code === "UPDATE_NOT_DOWNLOADED") {
          downloadedUpdate = null;
          syncDownloadButtons();
        }
        throw error;
      }
    },
  });
}

async function downloadOrConfirmUpdate() {
  if (!invoke || isDownloadingUpdate) return;
  const target = pendingUpdate ?? shownNotice;
  if (!target) return;
  if (downloadedUpdate && downloadedUpdate.version === target.version) {
    await confirmAndOpenInstaller(downloadedUpdate);
    return;
  }

  isDownloadingUpdate = true;
  const checkBtn = must("update-check") as HTMLButtonElement;
  checkBtn.disabled = true;
  syncDownloadButtons();
  setUpdateProgress(null, true);
  const initialText = `正在获取 v${target.version} 的 SHA-256 校验文件并准备下载…`;
  showUpdate({ tone: "pending", text: initialText, available: true });
  if (shownNotice) must("update-notice-text").textContent = initialText;

  let unlisten: (() => void) | undefined;
  const listen = window.__TAURI__?.event?.listen;
  if (listen) {
    try {
      unlisten = await listen("update-download-progress", (event) => {
        const payload = event.payload as UpdateDownloadProgress | undefined;
        if (!payload || payload.version !== target.version) return;
        const progress = describeDownloadProgress(payload);
        setUpdateProgress(progress.percent, true);
        must("update-msg-text").textContent = progress.text;
        if (shownNotice) must("update-notice-text").textContent = progress.text;
      });
    } catch {
      // 监听失败不阻断下载本身。
    }
  }

  let verifiedToConfirm: DownloadedUpdate | null = null;
  try {
    const verified = await invoke<DownloadedUpdate>("download_update_cmd", {
      expectedVersion: target.version,
    });
    if (verified.version !== target.version) {
      throw {
        code: "UPDATE_VERSION_CHANGED",
        message: `下载返回的版本（v${verified.version}）与当前请求的版本（v${target.version}）不一致，请重新检查更新。`,
      };
    }
    downloadedUpdate = verified;
    verifiedToConfirm = verified;
    isDownloadingUpdate = false;
    setUpdateProgress(100, false);
    const readyMsg = describeDownloadedUpdate(verified);
    showUpdate(readyMsg);
    if (shownNotice) must("update-notice-text").textContent = readyMsg.text;
  } catch (error) {
    const detail = error as { code?: string } | null;
    if (detail?.code === "UPDATE_UNSUPPORTED_PLATFORM") {
      canDownloadInApp = false;
    }
    if (
      detail?.code === "UPDATE_HASH_MISMATCH" ||
      detail?.code === "UPDATE_NOT_DOWNLOADED" ||
      detail?.code === "UPDATE_BAD_CHECKSUM" ||
      detail?.code === "UPDATE_BAD_URL" ||
      detail?.code === "UPDATE_UNSUPPORTED_PLATFORM" ||
      detail?.code === "UPDATE_VERSION_CHANGED" ||
      (downloadedUpdate && downloadedUpdate.version !== target.version)
    ) {
      downloadedUpdate = null;
    }
    isDownloadingUpdate = false;
    setUpdateProgress(null, false);
    const failure = describeDownloadFailure(error);
    showUpdate(failure);
    if (shownNotice) must("update-notice-text").textContent = failure.text;
  } finally {
    unlisten?.();
    isDownloadingUpdate = false;
    checkBtn.disabled = currentAppVersion.length === 0;
    syncDownloadButtons();
  }

  // 下载与哈希校验完成后，在下载 try/catch 之外弹窗请用户确认，绝不自动安装。
  if (verifiedToConfirm) {
    await confirmAndOpenInstaller(verifiedToConfirm);
  }
}

must("update-check").addEventListener("click", () => {
  if (!currentAppVersion) {
    showUpdate({ tone: "warn", text: "正在读取应用版本，请稍后再查。", available: false });
    return;
  }
  void checkUpdate(currentAppVersion);
});

document.getElementById("update-download")?.addEventListener("click", () => {
  void downloadOrConfirmUpdate();
});

document.getElementById("update-notice-download")?.addEventListener("click", () => {
  void downloadOrConfirmUpdate();
});

must("update-open").addEventListener("click", async () => {
  if (!invoke || !pendingUpdate) return;
  try {
    await invoke("open_update_page_cmd");
  } catch {
    showUpdate({
      tone: "warn",
      text: `打不开下载页，请手动访问：${pendingUpdate.url}`,
      available: true,
      canDownload: canDownloadInApp,
    });
  }
});

must("update-notice-open").addEventListener("click", async () => {
  const notice = shownNotice;
  if (!invoke || !notice) return;
  try {
    await invoke("open_update_page_cmd");
  } catch {
    must("update-notice-text").textContent = `打不开下载页，请手动访问：${notice.url}`;
  }
});

must("update-notice-close").addEventListener("click", () => {
  const version = shownNotice?.version;
  if (!version) return;
  closedThisRun = version;
  showNotice(lastPref);
});

must("update-auto").addEventListener("change", async (event) => {
  const toggle = event.target as HTMLInputElement;
  const enabled = toggle.checked;
  if (!invoke) {
    toggle.checked = !enabled;
    say("update-auto-msg", { tone: "warn", text: "未连接到桌面宿主，偏好没有保存。" });
    return;
  }
  // 上一次还没存完：这次的改动先不算，界面保持和正在保存的那个值一致。
  if (toggle.getAttribute("aria-busy") === "true") {
    toggle.checked = !enabled;
    return;
  }
  toggle.setAttribute("aria-busy", "true");
  say("update-auto-msg", { tone: "pending", text: "正在保存…" });
  try {
    const saved = await invoke<UpdatePreference>("set_update_preference_cmd", { enabled });
    toggle.checked = saved?.enabled ?? enabled;
    // 关掉自动检查，主界面的提示一起收起；再打开时照记下的结果恢复。
    showNotice(saved ?? null);
  } catch (error) {
    // 存不上就把勾选还原，免得界面说的和实际不一样。
    toggle.checked = !enabled;
    say("update-auto-msg", { tone: "error", text: `没能保存：${describeDialogError(error)}。开关已恢复为原来的状态。` });
  } finally {
    toggle.removeAttribute("aria-busy");
    if (must("update-auto-msg").dataset.tone === "pending") say("update-auto-msg", null);
  }
});

let currentAppVersion = "";
/** 状态每隔几秒刷一次；自动检查每次启动只做一次。 */
let autoCheckDone = false;

/** 启动时按偏好查一次。查不到就安静退回，不打扰。 */
async function maybeAutoCheck(status: { appVersion: string; platform?: string; arch?: string }) {
  currentAppVersion = status.appVersion;
  canDownloadInApp = supportsInAppUpdateDownload(status.platform, status.arch);
  (must("update-check") as HTMLButtonElement).disabled = currentAppVersion.length === 0;
  if (!invoke || autoCheckDone) return;
  autoCheckDone = true;
  let pref: UpdatePreference;
  try {
    pref = await invoke<UpdatePreference>("get_update_preference_cmd");
  } catch (error) {
    say("update-auto-msg", { tone: "error", text: `读不到更新偏好：${describeDialogError(error)}` });
    return;
  }
  const toggle = must("update-auto") as HTMLInputElement;
  toggle.checked = pref.enabled;
  toggle.disabled = false;
  showCheckedAt(parseCheckedAt(pref.lastCheckedAt));
  // 今天已经查过、不再查的时候，靠上次记下的结果接着提示。
  showNotice(pref);
  const cached = pref.available ?? null;
  if (cached && describeUpdate(currentAppVersion, cached, canDownloadInApp).available) {
    pendingUpdate = cached;
    showUpdate(describeUpdate(currentAppVersion, cached, canDownloadInApp));
  }
  if (!shouldCheck(pref, new Date().toISOString())) return;
  await checkUpdate(status.appVersion);
}
