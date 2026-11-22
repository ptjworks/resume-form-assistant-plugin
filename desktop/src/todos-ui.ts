import type { NotesApplication } from "./notes/view.ts";
// D10 日历视图（#551）：左侧完整月历，右侧常驻选中日的详情；底部折叠「未设具体日期的
// 待办」与「提醒什么时候会响」。新建/编辑仍在弹窗里；完成、取消、重新打开直接执行并在
// 状态行反馈。
//
// 这个视图**完全不依赖系统通知**。未授权、未启用、平台不支持时它照常可用，
// 只是每条待办的详情里如实写着提醒不会响（产品需求 §5.4）。
//
// 待办表没有「类型」字段：面试 / 测评 / 笔试 / 其他由前端按标题与轮次推断（todos.ts），
// 不新增字段、不改命令。

import type {
  ApplicationSummary,
  Invoke,
  Page,
  ReminderCapability,
  TodoStatus,
  TodoView,
  TodoWriteResult,
} from "./api.ts";
import { input, maybe, must, select as selectEl, valueOf } from "./dom.ts";
import { localInputToUtc, utcToLocalInput } from "./zoned.ts";
import type { CalendarEntry, Message, MonthRef } from "./todos.ts";
import {
  DELIVERY_WINDOW_NOTE,
  EMPTY_TODOS,
  KIND_LABEL,
  LIFECYCLE_STATES,
  NEEDS_APPLICATION,
  STATUS_LABEL,
  WEEKDAY_HEADS,
  buildCalendar,
  cellLabel,
  dayHeading,
  daySummary,
  describeCapability,
  describeDigest,
  describeDue,
  describeReminder,
  describeRemindAt,
  describeSave,
  describeStatusChange,
  inferKind,
  localDay,
  monthGrid,
  monthOf,
  monthTitle,
  pillText,
  prefillForDay,
  shiftMonth,
  summarizeOverdue,
  todoDay,
} from "./todos.ts";

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function invokeError(error: unknown) {
  const detail = error as { message?: string; code?: string } | null;
  return detail?.message || detail?.code || "未知错误";
}

/** 时区得是 IANA 名字。填错了 `datetime-local` 会被悄悄按本机解释，存进去的时刻就错了。 */
function knownTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

// 线条图标，只是装饰，读屏跳过。
const ICON = {
  check: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  close: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  edit: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>',
  reopen: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
  bell: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>',
  building: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 21V5l8-2v18M12 8h8v13M8 8v.01M8 12v.01M8 16v.01M16 12v.01M16 16v.01M2 21h20"/></svg>',
  calendar: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/><path d="m9 15 2 2 4-4"/></svg>',
  more: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h.01M12 12h.01M19 12h.01"/></svg>',
};

/** 宿主注入的事：没有申请时把人领去新增申请。测试里可以不给。 */
export interface TodosHost {
  createApplication?: (() => void) | null;
  writeNote?: (application: NotesApplication, suggested: string) => void;
  /** 「查看对应投递 →」：切到投递页并展开这条申请。 */
  openApplication?: (applicationId: string) => void;
}

/** 从别的页面跳进日历时要定位到哪：优先按待办 id，其次按日期。 */
export interface TodoTarget {
  id?: string | null;
  day?: string | null;
}

/** 月历格里最多直接画几条胶囊，多出来的收进「+N」。 */
const PILLS_PER_CELL = 2;

export function mountTodos(
  invoke: Invoke,
  now: () => Date = () => new Date(),
  { createApplication = null, writeNote, openApplication }: TodosHost = {},
) {
  const board = must("todo-list");
  const side = must("todo-detail");
  const status = must("todo-status");
  const digest = must("todo-digest");
  const titleEl = must("cal-title");
  const undatedSummary = must("todo-undated-summary");
  const undatedList = must("todo-undated-list");
  const undatedFold = must<HTMLDetailsElement>("todo-undated");
  const reminderNote = must("todo-reminder-note");
  const lifecycle = must("todo-lifecycle");
  const form = must<HTMLFormElement>("todo-form");
  const applicationSelect = selectEl("todo-application");
  const precisionSelect = selectEl("todo-precision");
  const dateInput = input("todo-date");
  const datetimeInput = input("todo-datetime");
  const dialog = must<HTMLDialogElement>("todo-dialog");
  const formStatus = must("todo-form-status");
  const formOptions = must<HTMLDetailsElement>("todo-form-options");

  let capability: ReminderCapability = { available: false, reason: null };
  let applications: ApplicationSummary[] = [];
  let applicationsLoaded = false;
  /** 一次取回全部状态，日历上怎么画在本地决定。 */
  let todos: TodoView[] = [];
  let loaded = false;
  let listError: string | null = null;
  /** 月历正在看哪个月、右栏正在看哪一天；第一次进入时落在今天。 */
  let viewMonth: MonthRef = monthOf(localDay(now()));
  let selectedDay: string = localDay(now());
  /** 选中日里被点中的那一条（高亮用）。 */
  let selectedId: string | null = null;
  /** 在右栏单独显示的「未设具体日期」待办；有值时右栏不显示某一天。 */
  let undatedId: string | null = null;
  let started = false;
  let pendingTarget: TodoTarget | null = null;
  let editing: string | null = null;
  /// 双击提交会建出两条待办、登记两条提醒。一次只让一个请求在飞。
  let saving = false;
  let editLoading = false;
  /** 完成 / 取消 / 重新打开正在路上：同一条连点两次只发一次。 */
  let acting = false;
  let opener: HTMLElement | null = null;

  function say(message: Message | null) {
    status.textContent = message?.text ?? "";
    status.className = message ? `note ${message.tone}` : "note";
  }

  function sayInForm(message: Message | null) {
    formStatus.textContent = message?.text ?? "";
    formStatus.className = message ? `note ${message.tone}` : "note";
  }

  /** 到期精度决定哪个输入框可用。三个精度互斥，不会同时填两个。 */
  function syncPrecision() {
    const precision = precisionSelect.value;
    dateInput.hidden = precision !== "date";
    datetimeInput.hidden = precision !== "datetime";
    const dateField = maybe("todo-date-field");
    const datetimeField = maybe("todo-datetime-field");
    if (dateField) dateField.hidden = precision !== "date";
    if (datetimeField) datetimeField.hidden = precision !== "datetime";
  }

  function renderCapability() {
    const message = describeCapability(capability);
    reminderNote.textContent = `${message.text} ${DELIVERY_WINDOW_NOTE}`;
    reminderNote.className = `note ${message.tone}`;
    lifecycle.innerHTML = LIFECYCLE_STATES.map(
      (state) => `<li><strong>${escapeHtml(state.when)}</strong><span>${escapeHtml(state.what)}</span></li>`,
    ).join("");
  }

  function todayDay() {
    return localDay(now());
  }

  function selectDay(day: string, id: string | null = null) {
    selectedDay = day;
    selectedId = id;
    undatedId = null;
    viewMonth = monthOf(day);
  }

  function selectUndated(id: string) {
    undatedId = id;
    selectedId = id;
  }

  // --- 月历 ---------------------------------------------------------------------------

  function pill(entry: CalendarEntry): string {
    const todo = entry.todo;
    const id = escapeHtml(todo.id);
    const where = [todo.company, todo.position].filter(Boolean).join(" · ");
    const tail = entry.state === "done" ? "，已完成" : entry.state === "overdue" ? "，已逾期" : "";
    const label = `${entry.clock ? `${entry.clock} ` : ""}${KIND_LABEL[entry.kind]}：${todo.title}${where ? `，${where}` : ""}${tail}`;
    return `<li><button type="button" class="cal-pill" data-kind="${entry.kind}" data-state="${entry.state}"
      data-todo="${id}" data-day="${escapeHtml(entry.day)}" data-act="select"
      aria-label="${escapeHtml(label)}" title="${escapeHtml(`${todo.title}${where ? `（${where}）` : ""}`)}">${escapeHtml(pillText(entry))}</button></li>`;
  }

  function cell(day: string, inMonth: boolean, entries: CalendarEntry[], today: string): string {
    const selected = day === selectedDay && !undatedId;
    const shown = entries.slice(0, PILLS_PER_CELL);
    const rest = entries.length - shown.length;
    const num = Number(day.slice(8, 10));
    const classes = ["cal-cell", inMonth ? "" : "is-out", day === today ? "is-today" : "", selected ? "is-selected" : ""]
      .filter(Boolean)
      .join(" ");
    const more = rest > 0
      ? `<button type="button" class="cal-more" data-day="${escapeHtml(day)}" aria-label="${escapeHtml(`${cellLabel(day, entries.length)}，查看全部`)}">+${rest}</button>`
      : "";
    return `<div class="${classes}" role="gridcell" data-day="${escapeHtml(day)}">
      <div class="cal-cell-head">
        <button type="button" class="cal-day" data-day="${escapeHtml(day)}" aria-pressed="${selected}"
          ${day === today ? 'aria-current="date"' : ""} aria-label="${escapeHtml(cellLabel(day, entries.length))}">${num}</button>${more}
      </div>
      <ul class="cal-pills">${shown.map(pill).join("")}</ul>
    </div>`;
  }

  function renderBoard() {
    const model = buildCalendar(todos, now());
    const today = todayDay();
    titleEl.textContent = monthTitle(viewMonth);
    const cells = monthGrid(viewMonth);
    const grid = `<div class="cal-grid" role="grid" aria-label="${escapeHtml(monthTitle(viewMonth))}" data-rows="${cells.length / 7}">
      <div class="cal-week" role="row">${WEEKDAY_HEADS.map((head) => `<span role="columnheader">${head}</span>`).join("")}</div>
      <div class="cal-days">${cells.map((entry) => cell(entry.day, entry.inMonth, model.byDay.get(entry.day) ?? [], today)).join("")}</div>
    </div>`;
    board.innerHTML = `${listError ? readError() : ""}${grid}`;
  }

  function readError() {
    return `<div class="pane-error" role="alert"><p class="note warn">${escapeHtml(listError)}</p><button type="button" data-todo-retry>重新读取</button></div>`;
  }

  /** 月历上方：「N 条已逾期 · 跳到最早一天」。说的是到期没做，不是提醒过了。 */
  function renderDigest() {
    const summary = summarizeOverdue(todos, now());
    const message = describeDigest(summary.count, 0);
    digest.hidden = !message || !loaded;
    if (!message) return;
    digest.innerHTML = `<span>${escapeHtml(message.text)}</span>${summary.earliest ? ' · <button type="button" class="link-button" data-jump-overdue>跳到最早一天</button>' : ""}`;
  }

  /** 底部折叠条：数量一直显示，折叠着也看得见。 */
  function renderUndated() {
    const model = buildCalendar(todos, now());
    const count = model.undated.length;
    undatedSummary.innerHTML = `未设具体日期的待办 <span class="cal-count">(${loaded ? count : "…"})</span>`;
    if (!loaded) {
      undatedList.innerHTML = "";
      return;
    }
    undatedList.innerHTML = count
      ? `<ul>${model.undated
          .map((todo) => {
            const id = escapeHtml(todo.id);
            const where = [todo.company, todo.position].filter(Boolean).map(escapeHtml).join(" · ");
            const active = todo.id === undatedId;
            return `<li><button type="button" class="cal-undated-item${active ? " is-active" : ""}" data-todo="${id}" data-act="select-undated"
              data-kind="${inferKind(todo)}" data-status="${escapeHtml(todo.status)}" aria-current="${active}">
              <span class="kind-dot" aria-hidden="true"></span><strong>${escapeHtml(todo.title)}</strong>
              <span class="cal-undated-where">${where || "未关联申请信息"}</span>
              ${todo.status === "done" ? '<span class="cal-flag">已完成</span>' : ""}</button></li>`;
          })
          .join("")}</ul>`
      : '<p class="muted">没有未设具体日期的待办。</p>';
  }

  // --- 右栏 ---------------------------------------------------------------------------

  function card(entry: CalendarEntry): string {
    const todo = entry.todo;
    const id = escapeHtml(todo.id);
    const reminder = describeReminder(todo, capability);
    const reminderTime = describeRemindAt(todo);
    const reminderZone =
      todo.timeZone && (!todo.dueAtUtc || todo.duePrecision !== "datetime") && (todo.remindAtUtc || todo.reminderScheduledForUtc)
        ? todo.timeZone
        : "";
    const where = [todo.company, todo.position].filter(Boolean).map(escapeHtml).join(" · ");
    const isOpen = todo.status === "open";
    const flag =
      entry.state === "overdue"
        ? '<span class="cal-flag" data-tone="overdue">已逾期</span>'
        : todo.status !== "open"
          ? `<span class="cal-flag" data-status="${escapeHtml(todo.status)}">${STATUS_LABEL[todo.status]}</span>`
          : "";
    const menuItems = [
      writeNote && todo.status !== "cancelled"
        ? `<button type="button" data-todo="${id}" data-act="write-note">写心得</button>`
        : "",
      isOpen ? `<button type="button" class="todo-cancel-action" data-todo="${id}" data-act="cancelled">${ICON.close}取消待办</button>` : "",
    ].join("");
    return `<article class="cal-card" data-todo-card="${id}" data-kind="${entry.kind}" data-state="${entry.state}"
        aria-current="${todo.id === selectedId}" aria-label="${escapeHtml(todo.title)}">
      <div class="cal-card-top">
        <span class="kind-badge" data-kind="${entry.kind}">${KIND_LABEL[entry.kind]}</span>${flag}
        ${menuItems ? `<details class="todo-detail-menu"><summary aria-label="更多待办操作" title="更多待办操作">${ICON.more}</summary>${menuItems}</details>` : ""}
      </div>
      <h3>${escapeHtml(todo.title)}</h3>
      <p class="cal-card-where">${ICON.building}<span>${where || "未关联申请信息"}${todo.interviewRound ? ` · 第 ${todo.interviewRound} 轮` : ""}</span></p>
      <div class="cal-card-facts">
        <div class="todo-detail-row">${ICON.calendar}<div><span>到期时间</span><strong>${escapeHtml(describeDue(todo))}</strong></div></div>
        <div class="todo-detail-row todo-reminder" data-tone="${reminder.tone}">${ICON.bell}<div><span>提醒</span>
          <strong>${escapeHtml(reminder.tone === "success" ? reminder.text : reminderTime)}</strong>
          ${reminderZone ? `<p>提醒时区：${escapeHtml(reminderZone)}</p>` : ""}
          ${reminder.tone === "success" ? "" : `<p>${escapeHtml(reminder.text)}</p>`}</div></div>
      </div>
      <div class="cal-card-actions">
        ${isOpen
          ? `<button type="button" class="primary" data-todo="${id}" data-act="done">${ICON.check}标记完成</button>
             <button type="button" data-todo="${id}" data-act="edit">${ICON.edit}编辑</button>`
          : `<button type="button" class="primary" data-todo="${id}" data-act="open">${ICON.reopen}重新打开</button>`}
        ${openApplication ? `<button type="button" class="link-button" data-todo="${id}" data-act="go-application">查看对应投递 →</button>` : ""}
      </div>
    </article>`;
  }

  function sideEmpty(day: string): string {
    const blocked = applicationsLoaded && !applications.length;
    const noTodosAtAll = loaded && !todos.length;
    const text = blocked ? NEEDS_APPLICATION : noTodosAtAll ? EMPTY_TODOS : "这一天没有安排，可以在下面添加。";
    return `<div class="cal-side-empty">
      <span class="cal-side-empty-icon">${ICON.calendar}</span>
      <p class="cal-side-empty-title">${escapeHtml(dayHeading(day))} 没有日程</p>
      <p class="muted">${escapeHtml(text)}</p>
      ${blocked ? '<button type="button" data-empty-act="application">去新增申请</button>' : ""}
    </div>`;
  }

  function renderSide() {
    if (!loaded) {
      side.innerHTML = `<div class="cal-side-body"><p class="cal-side-note muted">${listError ? "待办还没读到。" : "正在读取待办…"}</p></div>`;
      return;
    }
    const model = buildCalendar(todos, now());
    const undated = undatedId ? todos.find((todo) => todo.id === undatedId && todo.status !== "cancelled") : undefined;
    if (undatedId && !undated) undatedId = null;
    if (undated) {
      const entry: CalendarEntry = {
        todo: undated,
        day: "",
        clock: null,
        kind: inferKind(undated),
        state: undated.status === "done" ? "done" : "open",
      };
      side.innerHTML = `<header class="cal-side-head"><h2>未设具体日期</h2><p>这条待办没有到期日，不在月历上显示</p></header>
        <div class="cal-side-body">${card(entry)}</div>`;
      return;
    }
    const entries = model.byDay.get(selectedDay) ?? [];
    side.innerHTML = `<header class="cal-side-head"><h2>${escapeHtml(dayHeading(selectedDay))}</h2><p>${escapeHtml(daySummary(selectedDay, todayDay(), entries.length))}</p></header>
      <div class="cal-side-body">${entries.length ? entries.map(card).join("") : sideEmpty(selectedDay)}</div>
      <button type="button" class="cal-add" data-add-day="${escapeHtml(selectedDay)}">+ 在当天添加日程</button>`;
  }

  function render() {
    renderBoard();
    renderDigest();
    renderUndated();
    renderSide();
  }

  /** 重画会换掉按钮；键盘操作的人得继续停在原来那个位置。 */
  function renderKeepingFocus() {
    const active = document.activeElement as HTMLElement | null;
    const day = active?.closest?.("#todo-list") ? (active.dataset?.day ?? null) : null;
    const pillId = day && active?.dataset?.todo ? active.dataset.todo : null;
    render();
    if (!day) return;
    const found = pillId
      ? Array.from(board.querySelectorAll<HTMLElement>(".cal-pill")).find((node) => node.dataset.todo === pillId)
      : Array.from(board.querySelectorAll<HTMLElement>(".cal-day")).find((node) => node.dataset.day === day);
    found?.focus({ preventScroll: true });
  }

  async function refresh() {
    try {
      todos = await invoke<TodoView[]>("list_todos_cmd", { applicationId: null, status: "all" });
      loaded = true;
      if (listError) say(null);
      listError = null;
    } catch (error) {
      listError = `读取待办失败：${invokeError(error)}${loaded ? "。当前显示上次读取的结果。" : ""}`;
      say({ tone: "warn", text: listError });
      render();
      return false;
    }
    if (selectedId && !todos.some((todo) => todo.id === selectedId)) selectedId = null;
    if (undatedId && !todos.some((todo) => todo.id === undatedId)) undatedId = null;
    render();
    return true;
  }

  /** 从别的页面跳来：按待办 id 找到那天并选中那条；找不到就按日期，再不行就留在原处。 */
  function applyTarget(target: TodoTarget) {
    const todo = target.id ? todos.find((entry) => entry.id === target.id) : undefined;
    const day = (todo ? todoDay(todo) : null) ?? target.day ?? null;
    if (todo && todo.status !== "cancelled" && !todoDay(todo)) {
      selectUndated(todo.id);
      undatedFold.open = true;
    } else if (day) {
      selectDay(day, todo && todo.status !== "cancelled" ? todo.id : null);
    }
    render();
  }

  async function loadApplications() {
    try {
      // 命令签名是 `args: ListApplicationsArgs`，Tauri 按参数名取值——直接传 {}
      // 在真的桌面端会失败，申请下拉是空的，于是新建待办必然报「缺 applicationId」。
      const page = await invoke<Page<ApplicationSummary>>("list_applications_cmd", {
        args: { limit: 200, offset: 0 },
      });
      applications = page?.items ?? [];
      applicationsLoaded = true;
    } catch (error) {
      applications = [];
      applicationsLoaded = false;
      say({ tone: "warn", text: `读取申请列表失败：${invokeError(error)}` });
    }
    fillApplications();
  }

  function fillApplications(keep?: string) {
    const options = applications
      .map(
        (app) =>
          `<option value="${escapeHtml(app.id)}">${escapeHtml(app.company)} · ${escapeHtml(app.title)}</option>`,
      )
      .join("");
    applicationSelect.innerHTML = `<option value="">请选择一条申请…</option>${options}`;
    if (keep !== undefined) applicationSelect.value = keep;
  }

  function argsFromForm() {
    const precision = precisionSelect.value;
    const zone = valueOf("todo-timezone").trim() || null;
    const round = valueOf("todo-round").trim();
    return {
      title: valueOf("todo-title").trim(),
      duePrecision: precision,
      dueDate: precision === "date" ? valueOf("todo-date") || null : null,
      // datetime-local 只是一串墙钟文字，没有时区。它属于**这条待办的时区**
      // （没填就按本机），不是无条件按本机解释——否则给上海的面试在纽约的机器上
      // 会存成差 12 小时的时刻。
      dueAtUtc:
        precision === "datetime" ? localInputToUtc(valueOf("todo-datetime"), zone) : null,
      // 编辑时这几项都显式发出去：命令层把「没给」当成「别动」，显式的 null 才是
      // 「清空」。否则用户删掉提醒时刻、时区或轮次会被悄悄保留。
      timeZone: zone,
      remindAtUtc: localInputToUtc(valueOf("todo-remind"), zone),
      interviewRound: round === "" ? null : Number(round),
    };
  }

  /** 提交前先在本地拦一遍，错误就近说，输入一个字都不丢。 */
  function formProblem(args: ReturnType<typeof argsFromForm>): { text: string; field: string } | null {
    if (!editing && !applicationSelect.value) {
      return { text: "请选择这条待办属于哪条申请。", field: "todo-application" };
    }
    if (!args.title) return { text: "待办要有一个标题。", field: "todo-title" };
    if (args.duePrecision === "date" && !args.dueDate) {
      return { text: "选了「只有日期」，请填上日期。", field: "todo-date" };
    }
    if (args.duePrecision === "datetime" && !args.dueAtUtc) {
      return { text: "选了「具体到几点」，请填上完整的日期和时刻。", field: "todo-datetime" };
    }
    if (args.timeZone && !knownTimeZone(args.timeZone)) {
      return { text: "认不出这个时区。请写成 IANA 名称，例如 Asia/Shanghai；留空按本机时区。", field: "todo-timezone" };
    }
    if (valueOf("todo-remind") && !args.remindAtUtc) {
      return { text: "提醒时刻不完整，请补全或清空。", field: "todo-remind" };
    }
    if (args.interviewRound !== null && !(Number.isInteger(args.interviewRound) && args.interviewRound >= 1 && args.interviewRound <= 99)) {
      return { text: "面试轮次是 1 到 99 的整数，不需要就留空。", field: "todo-round" };
    }
    return null;
  }

  function setFormBusy(busy: boolean) {
    form
      .querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input,select,button")
      .forEach((field) => {
        field.disabled = busy;
      });
    const submit = must<HTMLButtonElement>("todo-submit");
    submit.disabled = busy || (!editing && applicationsLoaded && !applications.length);
    applicationSelect.disabled = busy || editing !== null;
    submit.textContent = busy ? "正在保存…" : editing ? "保存修改" : "添加日程";
    form.setAttribute("aria-busy", String(busy));
  }

  function resetForm() {
    editing = null;
    form.reset();
    fillApplications("");
    syncPrecision();
    sayInForm(null);
    must("todo-form-heading").textContent = "新增日程";
    formOptions.open = false;
    const noApps = applicationsLoaded && !applications.length;
    must("todo-no-apps").hidden = !noApps;
    must("todo-application-hint").hidden = true;
    must("todo-edit-note").hidden = true;
    input("todo-timezone").placeholder = localTimeZone()
      ? `留空按本机时区（${localTimeZone()}）`
      : "留空按本机时区，例如 Asia/Shanghai";
    setFormBusy(false);
  }

  function openDialog() {
    const active = document.activeElement;
    opener = active && "focus" in active ? (active as HTMLElement) : null;
    if (!dialog.open) dialog.showModal();
  }

  function closeDialog() {
    dialog.close();
    resetForm();
    if (opener?.isConnected) opener.focus();
    opener = null;
  }

  /** 新增日程：日期预填为选中那天（精度默认「只有日期」），用户可以改成具体到几点。 */
  function openCreate(day: string) {
    if (saving || editLoading) return;
    resetForm();
    const prefill = prefillForDay(day);
    precisionSelect.value = prefill.duePrecision;
    dateInput.value = prefill.dueDate;
    syncPrecision();
    openDialog();
    if (applicationsLoaded && !applications.length) maybe("todo-go-applications")?.focus();
    else input("todo-title").focus();
  }

  async function openEdit(id: string) {
    editLoading = true;
    try {
      const fresh = await invoke<TodoView[]>("list_todos_cmd", { applicationId: null, status: "all" });
      const todo = fresh.find((entry) => entry.id === id);
      if (!todo) {
        say({ tone: "warn", text: "这条待办已经不在了，列表已刷新。" });
        todos = fresh;
        render();
        return;
      }
      resetForm();
      editing = id;
      // 编辑时关联申请只读：命令层不支持把待办挪到另一条申请。下拉里可能没有这条
      // 申请（已进回收站或超出前 200 条），那就临时补一个选项，免得显示成空白。
      if (!applications.some((app) => app.id === todo.applicationId)) {
        const label = [todo.company, todo.position].filter(Boolean).join(" · ") || "原关联申请";
        applicationSelect.insertAdjacentHTML(
          "beforeend",
          `<option value="${escapeHtml(todo.applicationId)}">${escapeHtml(label)}</option>`,
        );
      }
      applicationSelect.value = todo.applicationId;
      input("todo-title").value = todo.title;
      precisionSelect.value = todo.duePrecision;
      dateInput.value = todo.dueDate ?? "";
      // 存的是 UTC，控件要的是墙钟。直接把 ISO 串切前 16 位塞进去，保存时又被
      // 按本机重新解释一遍，到期时间会平移一个时区偏移。
      datetimeInput.value = todo.dueAtUtc ? utcToLocalInput(todo.dueAtUtc, todo.timeZone) : "";
      input("todo-timezone").value = todo.timeZone ?? "";
      // 提醒时刻也要回填，否则用户看不到现在设的是几点，一保存还会被当成「清空」。
      input("todo-remind").value = todo.remindAtUtc
        ? utcToLocalInput(todo.remindAtUtc, todo.timeZone)
        : "";
      input("todo-round").value = todo.interviewRound ? String(todo.interviewRound) : "";
      syncPrecision();
      must("todo-form-heading").textContent = "编辑日程";
      formOptions.open = Boolean(todo.timeZone || todo.remindAtUtc || todo.interviewRound);
      must("todo-no-apps").hidden = true;
      must("todo-application-hint").hidden = false;
      must("todo-edit-note").hidden = false;
      setFormBusy(false);
      openDialog();
      input("todo-title").focus();
    } catch (error) {
      say({ tone: "warn", text: `读取待办失败：${invokeError(error)}` });
    } finally {
      editLoading = false;
    }
  }

  async function changeStatus(id: string, next: TodoStatus) {
    if (acting) return;
    acting = true;
    side.setAttribute("aria-busy", "true");
    side.querySelectorAll<HTMLButtonElement>("button[data-act]").forEach((button) => {
      button.disabled = true;
    });
    let result: TodoWriteResult;
    try {
      result = await invoke<TodoWriteResult>("set_todo_status_cmd", { id, status: next });
    } catch (error) {
      say({ tone: "warn", text: `操作失败：${invokeError(error)}` });
      acting = false;
      side.removeAttribute("aria-busy");
      renderSide();
      return;
    }
    // 写完就放开：接下来重画出来的按钮（比如「重新打开」）必须马上能点。
    acting = false;
    side.removeAttribute("aria-busy");
    say(describeStatusChange(next, result?.reminderProblem));
    // 状态改完仍然停在这一天、这一条上：完成的那条在格子里变灰，点错了可以直接重新打开。
    // 取消的那条会从日历上消失，右栏回到这一天的其余日程。
    selectedId = next === "cancelled" ? null : id;
    await refresh();
  }

  async function onAction(event: Event) {
    const button = (event.target as HTMLElement | null)?.closest<HTMLElement>("button[data-todo]");
    if (!button) return;
    const id = button.dataset.todo ?? "";
    const act = button.dataset.act ?? "";
    if (act === "select") {
      const item = todos.find((todo) => todo.id === id);
      const day = button.dataset.day || (item ? todoDay(item) : null);
      if (day) {
        selectDay(day, id);
        renderKeepingFocus();
      }
      return;
    }
    if (act === "select-undated") {
      selectUndated(id);
      render();
      return;
    }
    if (act === "write-note") {
      const item = todos.find(todo => todo.id === id);
      if (item) writeNote?.({ id: item.applicationId, company: item.company ?? "", title: item.position ?? "" }, item.title);
      return;
    }
    if (act === "go-application") {
      const item = todos.find(todo => todo.id === id);
      if (item) openApplication?.(item.applicationId);
      return;
    }
    if (saving || editLoading) return;
    if (act === "edit") {
      await openEdit(id);
      return;
    }
    if (act === "done" || act === "cancelled" || act === "open") {
      await changeStatus(id, act);
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (saving) return;
    const args = argsFromForm();
    const problem = formProblem(args);
    if (problem) {
      sayInForm({ tone: "warn", text: problem.text });
      const field = maybe(problem.field);
      if (field?.closest?.("#todo-form-options")) formOptions.open = true;
      field?.focus();
      return;
    }
    sayInForm(null);
    saving = true;
    setFormBusy(true);
    const wasEditing = editing;
    try {
      const result = wasEditing
        ? await invoke<TodoWriteResult>("edit_todo_cmd", { args: { id: wasEditing, ...args } })
        : await invoke<TodoWriteResult>("create_todo_cmd", {
            args: { applicationId: applicationSelect.value, ...args },
          });
      say(describeSave(wasEditing ? "updated" : "created", result?.reminderProblem));
      saving = false;
      closeDialog();
      // 保存完把月历带到这条待办所在的那天并选中它；没有日期的进「未设具体日期」。
      const saved = result?.todo;
      const savedDay = saved ? todoDay(saved) : null;
      const savedId = saved?.id ?? wasEditing ?? null;
      if (savedDay) selectDay(savedDay, savedId);
      else if (savedId && saved) {
        selectUndated(savedId);
        undatedFold.open = true;
      }
      await refresh();
    } catch (error) {
      // 失败时弹窗不关、输入一个字不丢，错误就写在按钮上方。
      sayInForm({ tone: "warn", text: `保存失败：${invokeError(error)}` });
    } finally {
      saving = false;
      if (dialog.open) setFormBusy(false);
    }
  });

  function cancel(event: Event) {
    event.preventDefault();
    if (saving) return;
    closeDialog();
  }
  must("todo-cancel").addEventListener("click", cancel);
  dialog.addEventListener("cancel", cancel);
  must("todo-new").addEventListener("click", () => openCreate(selectedDay));
  maybe("todo-go-applications")?.addEventListener("click", () => {
    if (saving) return;
    closeDialog();
    createApplication?.();
  });

  function jumpToMonth(next: MonthRef) {
    viewMonth = next;
    undatedId = null;
    selectedId = null;
    // 切月后右栏跟着换：本月就回到今天，其他月看那个月的 1 号。
    const today = todayDay();
    const thisMonth = monthOf(today);
    selectedDay =
      next.year === thisMonth.year && next.month === thisMonth.month
        ? today
        : `${String(next.year).padStart(4, "0")}-${String(next.month).padStart(2, "0")}-01`;
    renderKeepingFocus();
  }

  must("cal-prev").addEventListener("click", () => jumpToMonth(shiftMonth(viewMonth, -1)));
  must("cal-next").addEventListener("click", () => jumpToMonth(shiftMonth(viewMonth, 1)));
  must("cal-today").addEventListener("click", () => {
    selectDay(todayDay());
    renderKeepingFocus();
  });
  digest.addEventListener("click", (event) => {
    if (!(event.target as HTMLElement | null)?.closest("[data-jump-overdue]")) return;
    const earliest = summarizeOverdue(todos, now()).earliest;
    if (!earliest) return;
    selectDay(earliest.day, earliest.id);
    render();
  });

  board.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest("button[data-todo-retry]")) {
      void refresh().then((ok) => { if (ok) say({ tone: "info", text: "已刷新待办。" }); });
      return;
    }
    if (target?.closest("button[data-todo]")) {
      void onAction(event);
      return;
    }
    // 日期数字、「+N」、格子里的空白处：都是选中那一天。
    const dayNode = target?.closest<HTMLElement>("[data-day]");
    if (dayNode?.dataset.day) {
      selectDay(dayNode.dataset.day);
      renderKeepingFocus();
    }
  });
  undatedList.addEventListener("click", (event) => void onAction(event));
  side.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('button[data-empty-act="application"]')) {
      createApplication?.();
      return;
    }
    const add = target?.closest<HTMLElement>("button[data-add-day]");
    if (add) {
      openCreate(add.dataset.addDay || selectedDay);
      return;
    }
    void onAction(event);
  });
  side.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    const menu = side.querySelector<HTMLDetailsElement>(".todo-detail-menu[open]");
    if (!menu) return;
    event.preventDefault();
    menu.open = false;
    menu.querySelector("summary")?.focus();
  });
  precisionSelect.addEventListener("change", syncPrecision);

  render();

  /**
   * 进入日历页。`target` 是从别处（比如投递页第 3 列的日程）带来的定位：
   * 按待办 id 切到那一天并选中它。第一次进入落在今天。
   */
  return async function show(target?: TodoTarget | null) {
    if (!started) {
      started = true;
      selectDay(todayDay());
    }
    pendingTarget = target ?? null;
    try {
      capability = await invoke<ReminderCapability>("reminder_capability_cmd", {});
    } catch {
      capability = { available: false, reason: "读不到系统通知的状态。" };
    }
    renderCapability();
    syncPrecision();
    await loadApplications();
    await refresh();
    if (pendingTarget) {
      const wanted = pendingTarget;
      pendingTarget = null;
      applyTarget(wanted);
    }
  };
}
