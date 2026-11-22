import { bindDetailControls } from "./application-detail-controls.ts";
import type {
  ApplicationSummary,
  ApplicationView,
  CreateApplicationResult,
  Invoke,
  Page,
  SnapshotView,
  TodoView,
} from "./api.ts";
import { dialog as dialogEl, input, maybe, must } from "./dom.ts";
import {
  createApplicationsController,
  eventLabel,
  fillSummary,
  readableLocalDateTime,
  stageLabel,
  timelineTimeLabel,
  snapshotStateLabel,
  SNAPSHOT_DISCLAIMER,
} from "./applications.ts";
import {
  GROUP_PAGE_SIZE,
  LIST_LIMIT,
  STAGE_OPTIONS,
  autoCorrectReason,
  buildGroups,
  groupOf,
  headerSummary,
  nearestTodoByApplication,
  pendingNotice,
  progressChain,
  recordCall,
  rowHint,
  safeHttpUrl,
  stageChangeKind,
  type GroupDef,
  type GroupId,
  type GroupView,
} from "./applications-model.ts";
import { highlightHtml } from "./search-highlight.ts";
import { STATUS_LABEL, describeDue, localDay } from "./todos.ts";

/** 往后改阶段后，提示条停留多久还没人动就写库。 */
const UNDO_MS = 8000;
/** 点开「改日期」之后给用户挑日期的时间。 */
const DATE_PICK_MS = 60_000;
const EXPAND_FAILED = "读不出这条投递的详情";

// 列表和详情用的线条图标（1.75px 描边）。只是装饰，读屏跳过。
const ICON = {
  clock: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  chevron: '<svg class="icon app-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
  plus: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  arrow: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6"/></svg>',
};

// 待办的提醒登记结果，只说这条记录本身是什么状态，不推断会议、日历或结果。
const REMINDER_STATE: Record<string, string> = {
  none: "未设提醒",
  scheduled: "已登记提醒",
  fired: "已提醒",
  missed: "到点没能提醒",
  unsupported: "这台机器不能提醒",
};

/** 放进属性选择器的值：只转义引号和反斜杠（id 是 UUID，别处不会有特殊字符）。 */
function attrValue(value: string) {
  return value.replace(/["\\]/g, "\\$&");
}

/** 装饰用的首字：公司名的第一个字符（按码点取，不拆开代理对）。 */
function initialOf(name: string | null | undefined) {
  const first = Array.from(String(name ?? "").trim())[0];
  return first ? first.toUpperCase() : "?";
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatTime(value: string | null | undefined) {
  if (!value) return "—";
  return String(value).replace("T", " ").replace(/\.\d+(?=Z$)/, "").replace("Z", " UTC");
}

function invokeError(err: unknown) {
  const detail = err as { code?: string; message?: string } | null;
  if (detail && typeof detail === "object" && detail.message) {
    return `${detail.code || "ERROR"}: ${detail.message}`;
  }
  return String(err);
}

type Listen = (
  event: string,
  handler: (event: { payload?: unknown }) => void,
) => void | Promise<unknown>;

export interface ApplicationsOptions {
  listen?: Listen;
  coalesceMs?: number;
  /** 往后改阶段后的撤销窗口；测试里缩短。 */
  undoMs?: number;
  now?: () => Date;
  openNotes?: (application: ApplicationSummary) => void;
  /** 点第 3 列的日程：只负责切到日历页（定位到当天留给 #551）。 */
  openTodos?: () => void;
  /** 点「N 封相关邮件」：切到通知页的「已处理」，只看这一条投递的邮件。 */
  openInbox?: (applicationId: string, label: string) => void;
  /** 用系统浏览器打开官网。没传就走链接自己的 `target="_blank"`，由桌面的 opener 插件接手（只放行 http/https，见 capabilities）。 */
  openUrl?: (url: string) => void;
}

export function mountApplications(invoke: Invoke, options: ApplicationsOptions = {}) {
  const ctl = createApplicationsController();
  const now = options.now ?? (() => new Date());
  const undoMs = options.undoMs ?? UNDO_MS;
  const msg = must("apps-msg");
  const empty = must("apps-empty");
  const noResults = must("apps-no-results");
  const layout = must("apps-layout");
  const list = must("apps-list");
  const shell = maybe("apps-shell");
  const dialog = dialogEl("app-form-dialog");
  const form = must<HTMLFormElement>("app-form");
  const formMsg = must("app-form-msg");
  const progressDialog = dialogEl("progress-dialog");
  const progressForm = must<HTMLFormElement>("progress-form");
  const newBar = must<HTMLFormElement>("new-job-bar");
  const newBarButton = must("btn-new-app");
  const toast = must("apps-undo");
  const progressKinds: Record<string, string> = { interview: "面试", assessment: "测评", offer: "Offer", rejected: "未通过", withdrawn: "撤回", closed: "结束申请" };

  /** 操作成功的提示：几秒后自己消失，免得一直挂在页头。错误提示不走这里，会一直留着直到下一次成功读取。 */
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  function notice(text: string) {
    if (noticeTimer) clearTimeout(noticeTimer);
    msg.textContent = text;
    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      if (msg.textContent === text) msg.textContent = "";
    }, 6000);
  }

  let progressContext: { act: string; id: string } | null = null;
  let progressSaving = false;
  let actionBusy = false;
  let newSaving = false;
  let listLoaded = false;
  /** 列表自己写进 #apps-msg 的那句（读取中 / 读取失败）。成功后只清这一句，不动别处写的提示。 */
  let listMsg = "";

  /** 一次读进来的全部进行中投递（后端上限 1000），分组和搜索都在前端做。 */
  let all: ApplicationSummary[] = [];
  let totalOnServer = 0;
  let nearest = new Map<string, TodoView>();
  let query = "";
  let composing = false;
  const groupOpen = new Map<GroupId, boolean>();
  const shownCount = new Map<GroupId, number>();
  let committedNotices: Array<Record<string, unknown>> = [];
  let coalesceTimer: ReturnType<typeof setTimeout> | null = null;

  // 展开那一行的详情和它的几个小开关。
  let expandedView: ApplicationView | null = null;
  let detailToken = 0;
  let timelineOpen = false;
  let snapshotsOpen = false;
  const snapshotFieldCounts = new Map<string, number | null>();

  // 行内改阶段。overlay 是「界面上应该显示的阶段」，pending 是「还没写库的那一条」。
  const overlay = new Map<string, string>();
  const stageBusy = new Set<string>();
  let pending: { id: string; from: string; to: string; date: string | null; timer: ReturnType<typeof setTimeout> | null } | null = null;
  let committing: Promise<void> = Promise.resolve();

  const stageOf = (app: ApplicationSummary) => overlay.get(app.id) ?? app.current_stage;
  const appById = (id: string) => all.find((app) => app.id === id);

  // --- 表单与对话框 ---------------------------------------------------------------

  function setFormBusy(busy: boolean) {
    form
      .querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>("input,textarea,button")
      .forEach((field) => { field.disabled = busy; });
  }
  function cancelForm(event?: Event) {
    event?.preventDefault();
    if (ctl.saving) return;
    if (ctl.formDirty && !window.confirm("有未保存的修改，确定关闭？")) return;
    dialog.close();
    ctl.clearFormDirty();
  }
  function cancelProgress(event?: Event) {
    event?.preventDefault();
    if (progressSaving) return;
    progressContext = null;
    progressDialog.close();
  }
  must("progress-cancel").addEventListener("click", cancelProgress);
  progressDialog.addEventListener("cancel", cancelProgress);
  dialog.addEventListener("cancel", cancelForm);

  progressForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!progressContext || progressSaving) return;
    const { act, id } = progressContext;
    const description = input("progress-description").value.trim();
    const date = input("progress-date").value;
    const round = input("progress-round").value;
    const args = { id, updateProgress: input("progress-update").checked,
      occurred: date ? { precision: "date", value: { date, time_zone: null } } : { precision: "unknown" },
      label: description || progressKinds[act], name: description || progressKinds[act], note: description || null, reason: description || null,
      round: act === "interview" && round ? Number(round) : null };
    progressSaving = true;
    progressForm.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button").forEach((field) => { field.disabled = true; });
    const status = must("progress-msg");
    status.textContent = "保存中…";
    try {
      await invoke(`record_${act}_cmd`, { args });
      progressDialog.close();
      progressContext = null;
      await refreshView();
      notice("已保存记录。");
    } catch (error) { status.textContent = invokeError(error); }
    finally { progressSaving = false; progressForm.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button").forEach((field) => { field.disabled = false; }); }
  });

  function openForm(values: Partial<ApplicationSummary>) {
    if (ctl.saving || actionBusy || progressSaving) return;
    must("app-form-title").textContent = "编辑资料";
    input("f-company").value = values.company || "";
    input("f-title").value = values.title || "";
    input("f-url").value = values.source_url || "";
    input("f-location").value = values.location || "";
    input("f-notes").value = values.notes || "";
    formMsg.textContent = "";
    ctl.clearFormDirty();
    dialog.showModal();
    input("f-company").focus();
  }

  // --- 读取与渲染 -----------------------------------------------------------------

  async function refreshList() {
    if (!invoke) {
      msg.textContent = "未连接到桌面宿主，请用 Tauri 启动。";
      return;
    }
    const token = ctl.beginList();
    let todosFailed = false;
    if (!listLoaded) { listMsg = "正在读取投递…"; msg.textContent = listMsg; }
    try {
      // 一次读全（后端单次上限 1000），分组、搜索、计数都在前端；日程另读一次，按申请取最近一项。
      const [page, todos] = await Promise.all([
        invoke<Page<ApplicationSummary>>("list_applications_cmd", {
          args: { query: null, stage: "all", recycle: "active", sort: "updatedAt", desc: true, limit: LIST_LIMIT, offset: 0 },
        }),
        Promise.resolve(invoke<TodoView[]>("list_todos_cmd", { applicationId: null, status: "open" }))
          .then((rows) => (Array.isArray(rows) ? rows : []))
          .catch(() => { todosFailed = true; return [] as TodoView[]; }),
      ]);
      if (!ctl.isCurrent(token)) return;
      all = Array.isArray(page.items) ? page.items : [];
      totalOnServer = typeof page.total === "number" ? page.total : all.length;
      nearest = nearestTodoByApplication(todos, now());
      if (msg.textContent === listMsg) msg.textContent = "";
      listMsg = "";
      // 日程读失败不拦住列表，但要说一声：不然第 3 列全是「N 天前更新」，会让人以为没有日程。
      if (todosFailed) { listMsg = "日程没读到，第 3 列暂按更新时间显示。"; msg.textContent = listMsg; }
      listLoaded = true;
      if (ctl.selectedId && !appById(ctl.selectedId)) collapseRow();
      render();
    } catch (err) {
      if (!ctl.isCurrent(token)) return;
      listMsg = invokeError(err);
      msg.textContent = listMsg;
    }
  }

  function groupIsOpen(def: GroupDef, hits: number) {
    const chosen = groupOpen.get(def.id);
    if (chosen !== undefined) return chosen;
    // 「已结束」默认折叠；搜索命中其中记录时临时展开。
    return def.collapsedByDefault ? Boolean(query) && hits > 0 : true;
  }

  function rowHtml(app: ApplicationSummary) {
    const stage = stageOf(app) ?? "saved";
    const expanded = ctl.selectedId === app.id;
    const location = app.location ? highlightHtml("location", app.location, query) : "";
    const hint = rowHint(app, nearest.get(app.id), now());
    const hintHtml = hint.kind === "todo"
      ? `<button type="button" class="app-hint app-hint-${hint.tone}" data-go="todos" title="${escapeHtml(hint.title)}">${escapeHtml(hint.text)}</button>`
      : hint.kind === "updated"
        ? `<span class="app-hint app-hint-quiet" title="${escapeHtml(formatTime(app.updated_at))}">${escapeHtml(hint.text)}</span>`
        : "";
    const busy = stageBusy.has(app.id) ? " disabled" : "";
    return `<li class="app-item${expanded ? " is-expanded" : ""}" data-id="${escapeHtml(app.id)}" data-stage="${escapeHtml(stage)}">
      <div class="app-row">
        <button type="button" class="app-select" aria-expanded="${expanded}" aria-controls="app-expand-${escapeHtml(app.id)}" aria-label="${escapeHtml(app.company)} ${escapeHtml(app.title)}"></button>
        <span class="app-cell app-cell-company">
          <span class="app-avatar" aria-hidden="true">${escapeHtml(initialOf(app.company))}</span>
          <span class="app-name" title="${escapeHtml(app.company)}${app.location ? ` · ${escapeHtml(app.location)}` : ""}"><strong>${highlightHtml("company", app.company, query)}</strong>${location ? `<span class="app-city"> · ${location}</span>` : ""}</span>
        </span>
        <span class="app-cell app-cell-title" title="${escapeHtml(app.title)}">${highlightHtml("title", app.title, query)}</span>
        <span class="app-cell app-cell-hint">${hintHtml}</span>
        <span class="app-cell app-cell-stage">
          <select class="app-stage-select" data-stage-select aria-label="${escapeHtml(app.company)} 的阶段"${busy}>${STAGE_OPTIONS.map((value) => `<option value="${value}"${value === stage ? " selected" : ""}>${escapeHtml(stageLabel(value))}</option>`).join("")}</select>
          ${ICON.chevron}
        </span>
      </div>
      <div class="app-expand" id="app-expand-${escapeHtml(app.id)}" data-expand-for="${escapeHtml(app.id)}"${expanded ? "" : " hidden"}></div>
    </li>`;
  }

  function groupHtml(view: GroupView) {
    const { def, items } = view;
    if (!items.length) return "";
    const open = groupIsOpen(def, items.length);
    const expandedIndex = ctl.selectedId ? items.findIndex((app) => app.id === ctl.selectedId) : -1;
    // 记下的是「想看多少」，不是「这次画了多少」：组里行数暂时变少（有一行被挪走）再变回来时，不能少画。
    const wanted = Math.max(shownCount.get(def.id) ?? GROUP_PAGE_SIZE, expandedIndex + 1);
    shownCount.set(def.id, wanted);
    const shown = Math.min(items.length, wanted);
    const rest = items.length - shown;
    return `<section class="app-group" data-group="${def.id}">
      <h2 class="app-group-head"><button type="button" class="app-group-toggle" data-group-toggle="${def.id}" aria-expanded="${open}" aria-controls="app-group-body-${def.id}">${ICON.chevron}<span class="app-group-dot" aria-hidden="true"></span><span class="app-group-name">${escapeHtml(def.label)}</span><span class="app-group-count">${items.length}</span></button></h2>
      <div class="app-group-body" id="app-group-body-${def.id}"${open ? "" : " hidden"}>
        ${open ? `<ul class="app-rows">${items.slice(0, shown).map(rowHtml).join("")}</ul>` : ""}
        ${open && rest > 0 ? `<button type="button" class="app-more" data-more="${def.id}">再显示 ${Math.min(GROUP_PAGE_SIZE, rest)} 条<span>（还有 ${rest} 条）</span></button>` : ""}
      </div>
    </section>`;
  }

  function render() {
    // 重画会把行里正在输入的备注冲掉，先记下来再还原。
    const noteInput = list.querySelector<HTMLInputElement>(".app-note-input");
    const draft = noteInput && document.activeElement === noteInput
      ? { id: noteInput.dataset.noteFor ?? "", value: noteInput.value }
      : null;
    const scrollTop = list.scrollTop;
    // 展开区里「记一条备注」写了一半的内容也一样：列表整体重画会把整个展开区换掉。
    const noteForm = list.querySelector<HTMLFormElement>("[data-note-add]");
    const noteDraft = noteForm && !noteForm.hidden
      ? { id: noteForm.closest<HTMLElement>("li[data-id]")?.dataset.id ?? "", text: noteForm.querySelector("input")?.value ?? "", focused: document.activeElement === noteForm.querySelector("input") }
      : null;

    const groups = buildGroups(all, query || null, nearest, stageOf);
    const hits = groups.reduce((sum, group) => sum + group.items.length, 0);
    const showEmpty = all.length === 0;
    const showNoResults = !showEmpty && hits === 0;
    empty.classList.toggle("hidden", !showEmpty);
    noResults.classList.toggle("hidden", !showNoResults);
    layout.classList.toggle("hidden", showEmpty || showNoResults);
    shell?.classList.toggle("is-empty", showEmpty);
    must("apps-count").textContent = all.length ? headerSummary(all, stageOf) : "";
    const limitNote = must("apps-limit-note");
    limitNote.hidden = !(totalOnServer > all.length);
    limitNote.textContent = totalOnServer > all.length
      ? `这里只显示最近更新的 ${all.length} 条（共 ${totalOnServer} 条），搜索也只在这些里查找。`
      : "";

    // 选中的行被搜索筛掉、或它所在的组被折叠：收起，不替用户改选别的。
    if (ctl.selectedId) {
      const group = groups.find((entry) => entry.items.some((app) => app.id === ctl.selectedId));
      if (!group || !groupIsOpen(group.def, group.items.length)) collapseRow(false);
    }
    list.innerHTML = groups.map(groupHtml).join("");
    list.scrollTop = scrollTop;
    if (ctl.selectedId && expandedView && expandedView.application.id === ctl.selectedId) renderPanel();
    else if (ctl.selectedId) {
      const panel = panelFor(ctl.selectedId);
      if (panel) panel.innerHTML = '<p class="app-expand-loading muted">加载中…</p>';
    }
    if (noteDraft && noteDraft.id === ctl.selectedId) {
      const restoredForm = list.querySelector<HTMLFormElement>(`li[data-id="${attrValue(noteDraft.id)}"] [data-note-add]`);
      const field = restoredForm?.querySelector("input");
      if (restoredForm && field) {
        restoredForm.hidden = false;
        field.value = noteDraft.text;
        if (noteDraft.focused) field.focus();
      }
    }
    if (draft) {
      const restored = list.querySelector<HTMLInputElement>(`.app-note-input[data-note-for="${attrValue(draft.id)}"]`);
      if (restored) { restored.value = draft.value; restored.focus(); }
    }
    showFreshHint();
  }

  function panelFor(id: string) {
    return list.querySelector<HTMLElement>(`[data-expand-for="${attrValue(id)}"]`);
  }

  function showFreshHint() {
    const fresh = must("apps-fresh");
    // 新申请只可能被搜索词挡住：在全部记录里、但这次不在搜索结果里，才提示。
    const visible = new Set(
      buildGroups(all, query || null, nearest, stageOf).flatMap((group) => group.items.map((app) => app.id)),
    );
    const hidden = committedNotices.filter((notice) => {
      const id = String(notice.applicationId || "");
      return Boolean(id) && Boolean(query) && Boolean(appById(id)) && !visible.has(id);
    });
    committedNotices = committedNotices.filter((notice) => !visible.has(String(notice.applicationId || ""))).slice(-10);
    fresh.hidden = hidden.length === 0;
  }

  function noteCommitted(payload: unknown) {
    const notice = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
    if (!notice || notice.reason !== "committed") return;
    // Filling or confirming an existing application still refreshes the list, but it is
    // not a newly created application and must not show the new-application hint.
    if (notice.messageType === "job.save" && notice.stage === "saved") {
      committedNotices.push(notice);
    }
    if (coalesceTimer) clearTimeout(coalesceTimer);
    coalesceTimer = setTimeout(() => {
      coalesceTimer = null;
      void refreshView();
    }, options.coalesceMs ?? 80);
  }

  /**
   * 档案被整个换掉之后（恢复备份、回滚换回）调（#314）：列表和正在看的那条详情都是从旧档案
   * 读的，切页也不会重读。旧档案里攒下的「新增申请」提示也不再作数。
   */
  async function reloadArchive() {
    committedNotices = [];
    must("apps-fresh").hidden = true;
    await refreshView();
  }

  /** 通知关联、AI 确认等操作可能发生在其他页面；列表和展开行的详情一起重读。 */
  async function refreshView() {
    await refreshList();
    if (ctl.selectedId) await loadDetail(ctl.selectedId, true);
  }

  // --- 展开一行 -------------------------------------------------------------------

  function collapseRow(redraw = true) {
    detailToken += 1;
    ctl.setSelected(null);
    expandedView = null;
    snapshotsOpen = false;
    timelineOpen = false;
    if (redraw) render();
  }

  function expandRow(id: string) {
    if (ctl.selectedId !== id) {
      timelineOpen = false;
      snapshotsOpen = false;
      expandedView = null;
    }
    ctl.setSelected(id);
    // 程序化展开（从心得页跳来、刚新建的那条）时，它所在的组要先展开：已结束组默认折叠，
    // 用户手动折叠过的组也一样，否则 render 会把这一行当成「藏在折叠组里」立刻收起。
    const target = appById(id);
    if (target) groupOpen.set(groupOf(stageOf(target)), true);
    render();
    list.querySelector<HTMLElement>(`li[data-id="${attrValue(id)}"] .app-select`)?.focus();
    return loadDetail(id, false);
  }

  async function loadDetail(id: string, keep: boolean) {
    const token = ++detailToken;
    if (!keep) expandedView = null;
    const panel = panelFor(id);
    if (panel && !keep) panel.innerHTML = '<p class="app-expand-loading muted">加载中…</p>';
    try {
      const view = await invoke<ApplicationView>("get_application_cmd", { id });
      if (token !== detailToken || ctl.selectedId !== id) return;
      expandedView = view;
      renderPanel();
    } catch (err) {
      if (token !== detailToken || ctl.selectedId !== id) return;
      const target = panelFor(id);
      if (target) target.innerHTML = `<p class="banner detail-error">${escapeHtml(`${EXPAND_FAILED}（${invokeError(err)}）`)}</p>`;
    }
  }

  function timelineHtml(view: ApplicationView) {
    // 分类是通知的元数据，AI 确认时与关联一并保存；不将它再画成一步进度。
    const events = (view.events || []).filter((event) => event.event_type !== "evidence_classified");
    const snapshotStates = view.snapshotStates || {};
    const evidenceById = new Map((view.evidence || []).map((item) => [item.id, item]));
    const todos = view.todos || [];
    return `
      ${todos.length ? `
      <section class="detail-todos" aria-label="关联待办">
        <h4>关联待办 <span>待办是接下来的安排，不是进度历史</span></h4>
        <ul>
          ${todos.map((todo) => `<li data-status="${escapeHtml(todo.status)}">
            <strong>${escapeHtml(todo.title)}</strong>
            <span>${escapeHtml(describeDue(todo))} · ${escapeHtml(STATUS_LABEL[todo.status] ?? todo.status)} · ${escapeHtml(REMINDER_STATE[todo.reminderState] ?? todo.reminderState)}</span>
          </li>`).join("")}
        </ul>
      </section>` : ""}
      <p class="panel-note">填写事件不等于投递成功。</p>
      ${events.length ? "" : `<p class="panel-empty">还没有进度记录。</p>`}
      <ol class="timeline">
        ${events.slice().reverse().map((ev) => {
          const payload = ev.payload || {};
          const extra = payload.text || payload.note || payload.reason || payload.label || payload.name || "";
          const evidenceId = String(payload.evidence_id || payload.evidenceId || "");
          const relatedEvidence = evidenceId ? evidenceById.get(evidenceId) : undefined;
          const eventDetail = relatedEvidence?.subject || relatedEvidence?.originalFilename || extra;
          const mode = payload.stage_update_mode || payload.stageUpdateMode;
          const modeText = mode === "update_progress" ? "更新当前进度" : mode === "history_only" ? "仅历史补录" : "";
          const fill = fillSummary(payload);
          const snapshotId = payload.snapshot_id;
          const snapshotNote = typeof snapshotId === "string" ? snapshotStateLabel(snapshotStates[snapshotId]) : null;
          const round = payload.round ? ` · 第 ${escapeHtml(payload.round)} 轮` : "";
          return `<li class="timeline-item">
            <div class="event-card">
              <div class="event-head">
                <strong>${escapeHtml(eventLabel(ev.event_type))}${round}</strong>
                ${modeText && !fill ? `<span class="event-tag">${escapeHtml(modeText)}</span>` : ""}
              </div>
              <p class="event-time">${ICON.clock}<span>${escapeHtml(timelineTimeLabel(ev.occurred, ev.recorded_at))}</span></p>
              ${eventDetail ? `<div class="event-body break">${escapeHtml(eventDetail)}</div>` : ""}
              ${fill ? `<div class="event-body">${escapeHtml(fill)}</div>` : ""}
              ${snapshotId && !snapshotNote ? `<div class="event-links"><button type="button" data-act="snapshot" data-snapshot="${escapeHtml(snapshotId)}">查看当时交的简历</button></div>` : ""}
              ${snapshotNote ? `<p class="event-note">${escapeHtml(snapshotNote)}</p>` : ""}
            </div>
          </li>`;
        }).join("")}
      </ol>`;
  }

  function chainHtml(view: ApplicationView) {
    const chain = progressChain(view.events);
    if (!chain.length) return '<p class="app-chain app-chain-empty">还没有进度记录</p>';
    const limit = 8;
    const shown = chain.slice(-limit);
    const parts = shown.map((item, index) => {
      const text = `${item.date ? `${escapeHtml(item.date)} ` : ""}${escapeHtml(item.label)}`;
      return index === shown.length - 1 ? `<strong class="chain-item">${text}</strong>` : `<span class="chain-item">${text}</span>`;
    });
    const arrow = ' <span class="chain-arrow" aria-hidden="true">→</span> ';
    return `<p class="app-chain" aria-label="进度">${chain.length > limit ? `<span class="chain-more" aria-hidden="true">…</span>${arrow}` : ""}${parts.join(arrow)}</p>`;
  }

  function snapshotsHtml(view: ApplicationView) {
    const snapshots = view.snapshots || [];
    const states = view.snapshotStates || {};
    if (!snapshots.length) {
      return `<p class="app-snapshot-empty">还没有当时交的简历。使用浏览器扩展填写并留档后，可以在这里回看当时的资料。</p>`;
    }
    return `<ul class="app-snapshot-list">${snapshots.map((snap) => {
      const unavailable = snapshotStateLabel(states[snap.snapshot_id]);
      const count = snapshotFieldCounts.get(snap.snapshot_id);
      const version = snap.template_version ? `（${escapeHtml(snap.template_version)}）` : "";
      const meta = [
        count === undefined || count === null ? "" : `${count} 个字段`,
        `留档于 ${escapeHtml(readableLocalDateTime(snap.created_at) || formatTime(snap.created_at))}`,
      ].filter(Boolean).join(" · ");
      return `<li>
        <span class="app-snapshot-name">${escapeHtml(snap.template_name)}${version}</span>
        <span class="app-snapshot-meta">${unavailable ? escapeHtml(unavailable) : meta}</span>
        ${unavailable ? "" : `<button type="button" class="link-button" data-act="snapshot" data-snapshot="${escapeHtml(snap.snapshot_id)}">查看全部字段</button>`}
      </li>`;
    }).join("")}</ul><p class="app-snapshot-note">${escapeHtml(SNAPSHOT_DISCLAIMER)}</p>`;
  }

  function panelHtml(view: ApplicationView) {
    const app = (view.application.summary || view.application) as ApplicationSummary;
    const notes = view.application.notes ?? "";
    const evidenceCount = (view.evidence || []).length;
    const siteUrl = app.source_url ? safeHttpUrl(app.source_url) : null;
    const hint = rowHint(app, nearest.get(app.id), now());
    return `
      <p class="app-expand-meta">${escapeHtml(app.title)}${hint.text ? ` · ${escapeHtml(hint.text)}` : ""}</p>
      <div class="app-expand-main">
        <div class="app-chain-row">
          ${chainHtml(view)}
          <details class="action-menu app-progress-menu">
            <summary>${ICON.plus}记进度</summary>
            <div class="action-menu-items">
              <button type="button" data-act="interview">面试</button>
              <button type="button" data-act="assessment">测评</button>
              <button type="button" data-act="offer">Offer</button>
              <button type="button" data-act="rejected">未通过</button>
              <button type="button" data-act="withdrawn">撤回</button>
              <button type="button" data-act="closed">结束申请</button>
              <button type="button" class="menu-divider" data-act="note">记一条备注</button>
            </div>
          </details>
        </div>
        <form class="app-note-add" data-note-add hidden>
          <input class="app-note-add-input" maxlength="2000" placeholder="写一条备注，会记到时间线里" aria-label="时间线备注" />
          <button type="submit" class="primary">保存</button>
          <button type="button" data-act="note-cancel">取消</button>
        </form>
        <details class="app-timeline-fold" data-timeline-fold${timelineOpen ? " open" : ""}>
          <summary><span class="fold-closed">展开完整时间线</span><span class="fold-open">收起完整时间线</span></summary>
          <div class="app-timeline-body">${timelineHtml(view)}</div>
        </details>
        <label class="app-note-field">
          <span class="sr-only">备注</span>
          <input class="app-note-input" data-note-for="${escapeHtml(app.id)}" maxlength="4000" placeholder="添加备注…" value="${escapeHtml(notes)}" />
          <span class="app-note-status" role="status"></span>
        </label>
      </div>
      <aside class="app-expand-side" aria-label="相关与操作">
        <div class="app-side-row">
          ${evidenceCount
            ? `<button type="button" class="app-link" data-go="inbox">${evidenceCount} 封相关邮件${ICON.arrow}</button>`
            : `<span class="app-side-none">暂无相关邮件</span>`}
          <button type="button" class="app-link" data-platform="community-remote" data-platform-off data-go="community">该公司面经${ICON.arrow}</button>
        </div>
        <div class="app-side-row app-side-actions">
          <button type="button" class="app-quiet" data-act="snapshots" aria-expanded="${snapshotsOpen}">当时交的简历</button>
          ${siteUrl
            ? `<a class="app-quiet" href="${escapeHtml(siteUrl)}" target="_blank" rel="noopener noreferrer" data-act="site">打开官网 ↗</a>`
            : app.source_url ? `<span class="app-quiet is-disabled" title="这条链接不是 http(s) 网址，不会打开">打开官网 ↗</span>` : ""}
          <button type="button" class="app-quiet" data-act="edit">编辑资料</button>
          ${options.openNotes ? `<button type="button" class="app-quiet" data-act="open-notes">写心得</button>` : ""}
          <button type="button" class="app-quiet app-danger" data-act="recycle">移入回收站</button>
        </div>
        <div class="app-snapshots" data-snapshots${snapshotsOpen ? "" : " hidden"}>${snapshotsOpen ? snapshotsHtml(view) : ""}</div>
      </aside>`;
  }

  function renderPanel() {
    const id = ctl.selectedId;
    if (!id || !expandedView) return;
    const panel = panelFor(id);
    if (!panel) return;
    // 重画（比如插件那边提交了新内容）不该把正在写的时间线备注冲掉。
    const draft = panel.querySelector<HTMLFormElement>("[data-note-add]");
    const draftOpen = Boolean(draft && !draft.hidden);
    const draftText = draft?.querySelector("input")?.value ?? "";
    // 行下面那个无框备注框同理：改了还没保存（value 和上次画出来的不一样）就别被服务端的旧值盖掉。
    const noteField = panel.querySelector<HTMLInputElement>(".app-note-input");
    const noteDraft = noteField && noteField.value !== noteField.defaultValue
      ? { value: noteField.value, focused: document.activeElement === noteField, start: noteField.selectionStart, end: noteField.selectionEnd }
      : null;
    panel.innerHTML = `<div class="app-expand-body">${panelHtml(expandedView)}</div>`;
    bindDetailControls(panel);
    if (noteDraft) {
      const restoredNote = panel.querySelector<HTMLInputElement>(".app-note-input");
      if (restoredNote) {
        restoredNote.value = noteDraft.value;
        if (noteDraft.focused) {
          restoredNote.focus();
          if (noteDraft.start !== null && noteDraft.end !== null) restoredNote.setSelectionRange(noteDraft.start, noteDraft.end);
        }
      }
    }
    if (draftOpen) {
      const restored = panel.querySelector<HTMLFormElement>("[data-note-add]");
      if (restored) {
        restored.hidden = false;
        const field = restored.querySelector("input");
        if (field) field.value = draftText;
      }
    }
  }

  /** 展开「当时交的简历」时补上每份的字段数；读不出来就只留名称和时间。 */
  async function fillSnapshotCounts(view: ApplicationView) {
    const missing = (view.snapshots || []).filter((snap) => !snapshotFieldCounts.has(snap.snapshot_id)
      && !snapshotStateLabel(view.snapshotStates?.[snap.snapshot_id]));
    if (!missing.length) return;
    for (const snap of missing) {
      try {
        const detail = await invoke<SnapshotView>("get_snapshot_cmd", { snapshotId: snap.snapshot_id });
        snapshotFieldCounts.set(snap.snapshot_id, (detail.groups || []).reduce((sum, group) => sum + (group.fields || []).length, 0));
      } catch {
        snapshotFieldCounts.set(snap.snapshot_id, null);
      }
    }
    if (snapshotsOpen && expandedView === view) {
      const target = list.querySelector<HTMLElement>("[data-snapshots]");
      if (target) target.innerHTML = snapshotsHtml(view);
    }
  }

  // Read-only. The disclaimer is always shown first, and a copy that fails its digest
  // check is reported as unreadable rather than shown in part.
  let snapshotToken = 0;
  async function openSnapshot(snapshotId: string) {
    // Only the one opened last may fill the dialog; an earlier one answering late is dropped.
    const token = ++snapshotToken;
    const snapshotDialog = dialogEl("snapshot-dialog");
    const body = must("snapshot-body");
    body.innerHTML = `<p class="banner">${escapeHtml(SNAPSHOT_DISCLAIMER)}</p><p class="muted">加载中…</p>`;
    if (!snapshotDialog.open) snapshotDialog.showModal();
    try {
      const snap = await invoke<SnapshotView>("get_snapshot_cmd", { snapshotId });
      if (token !== snapshotToken) return;
      const omitted = snap.omittedFieldCount
        ? `<p class="muted">${escapeHtml(snap.omittedFieldCount)} 个疑似密码、验证码类的字段没有保存。</p>`
        : "";
      body.innerHTML = `
        <p class="banner">${escapeHtml(SNAPSHOT_DISCLAIMER)}</p>
        <p class="muted">模板：${escapeHtml(snap.templateName)}${snap.templateVersion ? `（${escapeHtml(snap.templateVersion)}）` : ""} · 留档于 ${escapeHtml(readableLocalDateTime(snap.capturedAt || snap.createdAt) || formatTime(snap.capturedAt || snap.createdAt))}</p>
        ${omitted}
        ${(snap.groups || []).map((group) => `
          <h4>${escapeHtml(group.name)}</h4>
          <dl class="facts compact">
            ${(group.fields || []).map((field) => `<dt>${escapeHtml(field.key)}</dt><dd class="break">${escapeHtml(field.value)}</dd>`).join("")}
          </dl>`).join("")}
      `;
    } catch (err) {
      if (token !== snapshotToken) return;
      body.innerHTML = `<p class="banner">${escapeHtml(SNAPSHOT_DISCLAIMER)}</p><p class="banner">无法读取这份当时交的简历（${escapeHtml(invokeError(err))}）。桌面不会展示部分内容。</p>`;
    }
  }

  maybe("snapshot-close")?.addEventListener("click", () => {
    dialogEl("snapshot-dialog").close();
  });

  // --- 行内改阶段 -------------------------------------------------------------------

  function showToast() {
    if (!pending) return;
    must("apps-undo-text").textContent = pendingNotice(pending.to, pending.date, now());
    must("apps-undo-date").hidden = pending.to === "submitted";
    must("apps-undo-dateform").hidden = true;
    toast.hidden = false;
  }
  function hideToast() {
    toast.hidden = true;
    must("apps-undo-dateform").hidden = true;
  }
  function armTimer(ms: number) {
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => { void flushPending(); }, ms);
  }

  async function commitPending(entry: NonNullable<typeof pending>) {
    const call = recordCall(entry.id, entry.to, entry.date, now());
    try {
      await invoke(call.command, { args: call.args });
      notice(`已记录「${stageLabel(entry.to)}」。`);
    } catch (err) {
      msg.textContent = `没能记录「${stageLabel(entry.to)}」：${invokeError(err)}`;
    }
    overlay.delete(entry.id);
    await refreshView();
  }

  /**
   * 把待提交的那条写进库。提示条超时、点别处、切页、窗口隐藏都走这里，不能丢。
   * 没有待提交的就只等上一次写完。
   */
  function flushPending(): Promise<void> {
    const entry = pending;
    if (!entry) return committing;
    pending = null;
    if (entry.timer) clearTimeout(entry.timer);
    hideToast();
    committing = committing.then(() => commitPending(entry));
    return committing;
  }

  function undoPending() {
    const entry = pending;
    if (!entry) return;
    pending = null;
    if (entry.timer) clearTimeout(entry.timer);
    overlay.delete(entry.id);
    hideToast();
    notice("已撤销，没有写入任何记录。");
    render();
  }

  async function changeStage(id: string, to: string) {
    if (stageBusy.has(id)) return;
    // 已经有一条在等着写的：先写掉，再处理这一条。
    await flushPending();
    const app = appById(id);
    if (!app) return;
    const from = app.current_stage ?? "saved";
    const kind = stageChangeKind(from, to);
    if (kind === "none") { render(); return; }
    if (kind === "record") {
      overlay.set(id, to);
      pending = { id, from, to, date: null, timer: null };
      armTimer(undoMs);
      showToast();
      render();
      return;
    }
    // 往前改、或没有对应记录命令：立即生效，走纠正，原因由这里填，用户不用写。
    stageBusy.add(id);
    overlay.set(id, to);
    render();
    try {
      await invoke("correct_stage_cmd", { args: { id, from, to, reason: autoCorrectReason(from, to) } });
      notice(`已把阶段改为「${stageLabel(to)}」，时间线上留有纠正记录。`);
    } catch (err) {
      msg.textContent = invokeError(err);
    } finally {
      stageBusy.delete(id);
      overlay.delete(id);
    }
    await refreshView();
  }

  must("apps-undo-cancel").addEventListener("click", undoPending);
  must("apps-undo-date").addEventListener("click", () => {
    if (!pending) return;
    const picker = input("apps-undo-date-input");
    picker.max = localDay(now());
    picker.value = localDay(now());
    must("apps-undo-text").textContent = `已记为「${stageLabel(pending.to)}」，发生在`;
    must("apps-undo-dateform").hidden = false;
    must("apps-undo-date").hidden = true;
    armTimer(DATE_PICK_MS);
    picker.focus();
  });
  must("apps-undo-date-ok").addEventListener("click", () => {
    if (!pending) return;
    const picked = input("apps-undo-date-input").value;
    pending.date = picked || null;
    msg.textContent = "";
    void flushPending();
  });
  // 点别处就算确认：写进库。点提示条本身、点正在改阶段的那一行都不算「别处」。
  document.addEventListener("click", (event) => {
    if (!pending) return;
    const target = event.target as HTMLElement | null;
    if (target && toast.contains(target)) return;
    if (target?.closest?.(`li[data-id="${attrValue(pending.id)}"] .app-cell-stage`)) return;
    void flushPending();
  }, true);
  /** 备注框里还有没保存的改动（光标还在里面）就一起写掉：窗口隐藏、切页时不会触发失焦。 */
  function flushNoteDraft() {
    const field = document.activeElement as HTMLInputElement | null;
    if (field?.classList?.contains("app-note-input") && field.dataset.noteFor) void saveNote(field.dataset.noteFor, field);
  }
  function flushEverything() { flushNoteDraft(); void flushPending(); }
  window.addEventListener("pagehide", flushEverything);
  window.addEventListener("beforeunload", flushEverything);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushEverything();
  });

  // --- 展开区里的动作 -----------------------------------------------------------

  async function handleAction(act: string, id: string) {
    const view = expandedView;
    const app = (view ? (view.application.summary || view.application) : appById(id)) as ApplicationSummary | undefined;
    if (!app || ctl.selectedId !== id || ctl.saving || actionBusy || progressSaving) return;
    if (progressKinds[act]) {
      progressContext = { act, id };
      must("progress-title").textContent = `记录${progressKinds[act]} · ${app.company} / ${app.title}`;
      input("progress-description").value = "";
      input("progress-date").value = "";
      input("progress-round").value = "";
      must("progress-round-label").hidden = act !== "interview";
      input("progress-update").checked = false;
      must("progress-msg").textContent = "取消或 Escape 不会保存任何记录。";
      progressDialog.showModal();
      return;
    }
    if (act === "note") {
      const noteForm = list.querySelector<HTMLFormElement>("[data-note-add]");
      if (noteForm) {
        noteForm.hidden = false;
        noteForm.querySelector<HTMLInputElement>(".app-note-add-input")?.focus();
      }
      return;
    }
    if (act === "note-cancel") {
      const noteForm = list.querySelector<HTMLFormElement>("[data-note-add]");
      if (noteForm) { noteForm.hidden = true; noteForm.reset(); }
      return;
    }
    if (act === "edit") {
      ctl.setEditing(id);
      openForm({
        company: app.company,
        title: app.title,
        source_url: app.source_url,
        location: app.location,
        notes: view?.application.notes,
      });
      return;
    }
    if (act === "recycle") {
      const ok = window.confirm("移入回收站后，这条投递离开列表，历史记录仍保留，可以在「设置 → 数据与备份 → 回收站」恢复。本次不提供永久删除。");
      if (!ok) return;
      actionBusy = true;
      try {
        await invoke("set_recycle_cmd", { id, recycled: true });
        collapseRow(false);
        await refreshList();
        notice("已移入回收站。可在「设置 → 数据与备份 → 回收站」恢复。");
      } catch (err) {
        msg.textContent = invokeError(err);
      } finally { actionBusy = false; }
    }
  }

  /** 失焦时保存备注：只传 notes，别的字段不动；没改就不写。 */
  async function saveNote(id: string, field: HTMLInputElement) {
    const view = expandedView;
    // 详情里的申请和渲染时一样，兼容 `summary` 包一层的写法。
    if (!view || ((view.application.summary || view.application) as ApplicationSummary).id !== id) return;
    const before = (view.application.notes ?? "").trim();
    const next = field.value.trim();
    if (next === before) return;
    const status = field.parentElement?.querySelector<HTMLElement>(".app-note-status");
    if (status) status.textContent = "保存中…";
    try {
      await invoke("update_application_cmd", { args: { id, notes: field.value } });
      view.application.notes = next || null;
      field.defaultValue = field.value;
      if (status) status.textContent = "已保存";
    } catch (err) {
      if (status) status.textContent = "没保存上";
      msg.textContent = invokeError(err);
    }
  }

  list.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const go = target.closest<HTMLElement>("[data-go]");
    if (go) {
      if (go.dataset.go === "todos") options.openTodos?.();
      else if (go.dataset.go === "inbox") {
        const owner = go.closest<HTMLElement>("li[data-id]");
        const id = owner?.dataset.id;
        // 这个按钮就在展开的那一行里：公司和岗位直接取展开着的这条。
        const open = expandedView?.application;
        const summary = (open?.summary || open) as ApplicationSummary | undefined;
        if (id) options.openInbox?.(id, summary && open?.id === id ? [summary.company, summary.title].filter(Boolean).join(" · ") : "");
      }
      return;
    }
    const actButton = target.closest<HTMLElement>("[data-act]");
    const item = target.closest<HTMLElement>("li[data-id]");
    if (actButton && item) {
      const act = actButton.dataset.act ?? "";
      const id = item.dataset.id ?? "";
      if (act === "snapshot" && actButton.dataset.snapshot) return void openSnapshot(actButton.dataset.snapshot);
      if (act === "snapshots") {
        snapshotsOpen = !snapshotsOpen;
        if (expandedView) {
          renderPanel();
          if (snapshotsOpen) void fillSnapshotCounts(expandedView);
        }
        return;
      }
      if (act === "site") {
        const url = (actButton as HTMLAnchorElement).href;
        if (options.openUrl) { event.preventDefault(); options.openUrl(url); }
        return;
      }
      if (act === "open-notes") {
        const app = appById(id);
        if (app) options.openNotes?.(app);
        return;
      }
      return void handleAction(act, id);
    }
    const toggle = target.closest<HTMLElement>("[data-group-toggle]");
    if (toggle) {
      const id = toggle.dataset.groupToggle as GroupId;
      groupOpen.set(id, toggle.getAttribute("aria-expanded") !== "true");
      render();
      list.querySelector<HTMLElement>(`[data-group-toggle="${id}"]`)?.focus();
      return;
    }
    const more = target.closest<HTMLElement>("[data-more]");
    if (more) {
      const id = more.dataset.more as GroupId;
      shownCount.set(id, (shownCount.get(id) ?? GROUP_PAGE_SIZE) + GROUP_PAGE_SIZE);
      render();
      return;
    }
    const select = target.closest<HTMLElement>(".app-select");
    if (select && item) {
      const id = item.dataset.id ?? "";
      if (ctl.selectedId === id) { collapseRow(); list.querySelector<HTMLElement>(`li[data-id="${attrValue(id)}"] .app-select`)?.focus(); }
      else void expandRow(id);
    }
  });
  list.addEventListener("change", (event) => {
    const select = (event.target as HTMLElement | null)?.closest<HTMLSelectElement>("select[data-stage-select]");
    const id = select?.closest<HTMLElement>("li[data-id]")?.dataset.id;
    if (select && id) void changeStage(id, select.value);
  });
  list.addEventListener("focusout", (event) => {
    const field = (event.target as HTMLElement | null)?.closest<HTMLInputElement>(".app-note-input");
    if (field?.dataset.noteFor) void saveNote(field.dataset.noteFor, field);
  });
  list.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement | null;
    if (event.key === "Enter" && target?.matches?.(".app-note-input") && !event.isComposing) {
      event.preventDefault();
      (target as HTMLInputElement).blur();
    }
  });
  list.addEventListener("submit", async (event) => {
    const noteForm = (event.target as HTMLElement | null)?.closest<HTMLFormElement>("[data-note-add]");
    if (!noteForm) return;
    event.preventDefault();
    const id = ctl.selectedId;
    const field = noteForm.querySelector<HTMLInputElement>(".app-note-add-input");
    const text = field?.value.trim() ?? "";
    if (!id || !text || actionBusy) return;
    actionBusy = true;
    try {
      await invoke("add_note_cmd", { args: { id, text } });
      noteForm.reset();
      noteForm.hidden = true;
      notice("已记一条备注。");
      await loadDetail(id, true);
    } catch (err) {
      msg.textContent = invokeError(err);
    } finally { actionBusy = false; }
  });
  list.addEventListener("toggle", (event) => {
    const fold = event.target as HTMLElement | null;
    if (fold?.matches?.("[data-timeline-fold]")) timelineOpen = (fold as HTMLDetailsElement).open;
  }, true);

  // --- 编辑资料 ---------------------------------------------------------------------

  form.addEventListener("input", () => ctl.markFormDirty());
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const editingId = ctl.editingId;
    if (ctl.saving || !editingId) return;
    const payload = {
      company: input("f-company").value,
      title: input("f-title").value,
      sourceUrl: input("f-url").value || null,
      location: input("f-location").value || null,
      notes: input("f-notes").value || null,
    };
    ctl.setSaving(true);
    setFormBusy(true);
    input("btn-save-app").disabled = true;
    formMsg.textContent = "保存中…";
    try {
      await invoke("update_application_cmd", {
        args: {
          id: editingId,
          company: payload.company,
          title: payload.title,
          sourceUrl: payload.sourceUrl ?? "",
          location: payload.location ?? "",
          notes: payload.notes ?? "",
        },
      });
      formMsg.textContent = "已保存。";
      ctl.clearFormDirty();
      dialog.close();
      await refreshView();
    } catch (err) {
      formMsg.textContent = invokeError(err);
      input("f-company").value = payload.company;
      input("f-title").value = payload.title;
      input("f-url").value = payload.sourceUrl || "";
      input("f-location").value = payload.location || "";
      input("f-notes").value = payload.notes || "";
    } finally {
      ctl.setSaving(false);
      setFormBusy(false);
      input("btn-save-app").disabled = false;
    }
  });
  must("btn-cancel-app").addEventListener("click", cancelForm);

  // --- 行内新增条 -------------------------------------------------------------------

  function setNewBar(open: boolean) {
    newBar.hidden = !open;
    newBarButton.setAttribute("aria-expanded", String(open));
    if (open) input("nb-company").focus();
  }
  function openNewBar() {
    if (newBar.hidden) setNewBar(true);
    else input("nb-company").focus();
  }
  function resetNewBar() {
    for (const id of ["nb-company", "nb-title", "nb-location", "nb-url"]) input(id).value = "";
    must("nb-msg").textContent = "";
  }
  newBarButton.addEventListener("click", () => {
    if (newSaving) return;
    setNewBar(newBar.hidden);
  });
  must("nb-cancel").addEventListener("click", () => {
    if (newSaving) return;
    setNewBar(false);
    resetNewBar();
  });
  newBar.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || newSaving) return;
    event.preventDefault();
    setNewBar(false);
    newBarButton.focus();
  });
  must("btn-empty-new").addEventListener("click", openNewBar);
  newBar.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (newSaving) return;
    const payload = {
      company: input("nb-company").value,
      title: input("nb-title").value,
      sourceUrl: input("nb-url").value || null,
      location: input("nb-location").value || null,
      notes: null,
    };
    const status = must("nb-msg");
    newSaving = true;
    newBar.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button").forEach((field) => { field.disabled = true; });
    status.textContent = "保存中…";
    try {
      let created = await invoke<CreateApplicationResult>("create_application_cmd", {
        args: { ...payload, confirmDuplicate: false },
      });
      if (!created.created && created.candidates) {
        const names = [...(created.candidates.exact || []), ...(created.candidates.sameCompany || created.candidates.same_company || [])]
          .map((c) => `${c.company} / ${c.title}`)
          .join("；");
        const ok = window.confirm(`可能已有相似申请：${names || "同公司记录"}。确定仍要新建吗？系统不会自动合并。`);
        if (!ok) {
          status.textContent = "已取消。输入仍保留。";
          return;
        }
        created = await invoke<CreateApplicationResult>("create_application_cmd", {
          args: { ...payload, confirmDuplicate: true },
        });
      }
      resetNewBar();
      setNewBar(false);
      if (query) {
        // 新记录不一定匹配当前搜索词：清掉搜索，才看得到它。
        input("app-search").value = "";
        applyQuery("");
      }
      await refreshList();
      if (created.application) await expandRow(created.application.id);
    } catch (err) {
      status.textContent = invokeError(err);
    } finally {
      newSaving = false;
      newBar.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button").forEach((field) => { field.disabled = false; });
    }
  });

  // --- 搜索 -------------------------------------------------------------------------

  function applyQuery(next: string) {
    if (next === query) return;
    query = next;
    // 搜索词变了：折叠状态和「再显示」回到默认，已结束组才会按命中情况临时展开。
    groupOpen.clear();
    shownCount.clear();
    render();
  }
  const search = must("app-search");
  search.addEventListener("compositionstart", () => { composing = true; });
  search.addEventListener("compositionend", () => {
    composing = false;
    applyQuery(input("app-search").value.trim());
  });
  search.addEventListener("input", () => {
    if (composing) return;
    applyQuery(input("app-search").value.trim());
  });
  search.addEventListener("search", () => {
    if (composing) return;
    applyQuery(input("app-search").value.trim());
  });
  must("apps-fresh-clear").addEventListener("click", () => {
    input("app-search").value = "";
    committedNotices = [];
    must("apps-fresh").hidden = true;
    applyQuery("");
  });
  if (options.listen) {
    void Promise.resolve(options.listen("applications-changed", (event) => noteCommitted(event?.payload))).catch(() => {});
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "n" && event.target === document.body && !ctl.saving && !progressDialog.open) {
      openNewBar();
    }
  });

  /** 从心得页跳来：清掉搜索，展开这一条；回收站里的没法在这里展开，只说明去哪里恢复。 */
  async function openFromNotes(id: string, recycled: boolean) {
    input("app-search").value = "";
    applyQuery("");
    await refreshList();
    if (!appById(id)) {
      msg.textContent = recycled
        ? "这条投递在回收站里，可在「设置 → 数据与备份 → 回收站」恢复。"
        : "没有找到这条投递。";
      return;
    }
    await expandRow(id);
    list.querySelector<HTMLElement>(`li[data-id="${attrValue(id)}"]`)?.scrollIntoView?.({ block: "nearest" });
  }

  return { refreshList, refreshView, reloadArchive, openFromNotes, flushPending: () => { flushNoteDraft(); return flushPending(); }, openNewBar, ctl };
}
