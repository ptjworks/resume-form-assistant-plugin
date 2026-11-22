// D10 待办的文案与纯函数。界面只负责拼 DOM，说什么由这里决定。
//
// 两件事在这里守着：
//
// 1. **只有日历日的待办不许显示成 00:00。**「9 月 20 日截止」和「9 月 20 日
//    00:00 截止」是两句不同的话，后者是我们编的。
// 2. **提醒会不会响，界面必须说得出。** 产品需求 §5.4 列了五种状态，五种都要
//    有一句自己的话，不能用一句「已设置提醒」糊过去。

import type { ReminderCapability, TodoKind, TodoStatus, TodoView } from "./api.ts";

export type { TodoKind };
import { formatInZone, localInputToUtc, utcToLocalInput } from "./zoned.ts";

export interface Message {
  tone: "info" | "success" | "warn" | "pending";
  text: string;
}

export const EMPTY_TODOS =
  "添加面试、测评或跟进事项，安排求职下一步。每条待办都关联一条申请。";

/** 待办只能挂在申请下面：一条申请都没有时，新建入口要先把人领去建申请。 */
export const NEEDS_APPLICATION =
  "待办需要关联一条申请。还没有申请记录，请先新增申请，或在浏览器扩展里保存岗位。";

export const PRECISION_LABEL: Record<TodoView["duePrecision"], string> = {
  none: "没有到期",
  date: "只有日期",
  datetime: "具体到几点",
};

/** 这条待办此刻算哪一类。 */
export type Bucket = "overdue" | "today" | "week" | "later" | "someday" | "closed";

export const BUCKET_LABEL: Record<Bucket, string> = {
  overdue: "已逾期",
  today: "今天",
  week: "七天内",
  later: "以后",
  someday: "没有到期",
  closed: "已完成 / 已取消",
};

export const STATUS_LABEL: Record<TodoStatus, string> = {
  open: "待办",
  done: "已完成",
  cancelled: "已取消",
};

/** 当地日历日，`YYYY-MM-DD`。用来判断「今天」，不引入任何时刻。 */
export function localDay(at: Date): string {
  const year = at.getFullYear();
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(day: string, count: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const shifted = new Date(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + count);
  return localDay(shifted);
}

/**
 * 这条待办归到哪一组。
 *
 * 精确时刻按时刻比；只有日历日的按日历日比——**不**把它当成当天零点，否则
 * 「今天截止」的待办在今天一早就被算成逾期。
 */
export function bucketOf(todo: TodoView, now: Date): Bucket {
  if (todo.status !== "open") return "closed";

  const today = localDay(now);

  if (todo.duePrecision === "datetime" && todo.dueAtUtc) {
    const at = new Date(todo.dueAtUtc);
    if (Number.isNaN(at.getTime())) return "someday";
    if (at.getTime() < now.getTime()) return "overdue";
    const day = localDay(at);
    if (day === today) return "today";
    return day <= addDays(today, 7) ? "week" : "later";
  }

  if (todo.duePrecision === "date" && todo.dueDate) {
    if (todo.dueDate < today) return "overdue";
    if (todo.dueDate === today) return "today";
    return todo.dueDate <= addDays(today, 7) ? "week" : "later";
  }

  return "someday";
}

/**
 * 到期怎么写。三种精度三种写法，**只有日历日的绝不带时刻**。
 */
export function describeDue(todo: TodoView): string {
  if (todo.duePrecision === "datetime" && todo.dueAtUtc) {
    // 按**待办自己的**时区显示。拿本机时区格式化再把时区名拼在后面，机器在纽约、
    // 待办标着上海时显示的是纽约的钟点却写着 Asia/Shanghai——那不是不准，是说谎。
    const shown = formatInZone(todo.dueAtUtc, todo.timeZone);
    if (!shown) return "到期时间读不出来";
    return todo.timeZone ? `${shown}（${todo.timeZone}）` : shown;
  }
  if (todo.duePrecision === "date" && todo.dueDate) {
    // 没有时刻就是没有时刻。
    return `${todo.dueDate}（未定时间）`;
  }
  return "未设到期";
}

/**
 * 这条待办的提醒会不会响，为什么。
 *
 * `capability` 是整台机器的能力，`todo.reminderState` 是这一条的登记结果。
 * 两者都要看：机器能弹但这一条没登记上（时区不认识之类），也得说出来。
 */
export function describeReminder(todo: TodoView, capability: ReminderCapability): Message {
  if (todo.status !== "open") {
    return { tone: "info", text: "已结束，不会再提醒" };
  }
  if (todo.reminderState === "scheduled" && todo.reminderScheduledForUtc) {
    const shown =
      formatInZone(todo.reminderScheduledForUtc, todo.timeZone) ?? todo.reminderScheduledForUtc;
    return { tone: "success", text: `将在 ${shown} 提醒` };
  }
  if (todo.reminderState === "fired") {
    return { tone: "info", text: "已经提醒过" };
  }
  if (todo.reminderState === "missed") {
    return { tone: "warn", text: "到点时没能提醒，已列进逾期" };
  }
  if (todo.reminderState === "unsupported") {
    return { tone: "warn", text: capability.reason ?? "这条没能登记提醒" };
  }
  if (todo.duePrecision === "none" && !todo.remindAtUtc) {
    return { tone: "info", text: "没有到期，不提醒" };
  }
  if (!capability.available) {
    return { tone: "warn", text: capability.reason ?? "提醒不会响" };
  }
  return { tone: "info", text: "到期已过，不再提醒" };
}

/** 列表右侧那枚小标签的语气：逾期标红、今天强调，其他照常。 */
export type DueTone = "overdue" | "today" | "normal" | "none" | "closed";

function dayDistance(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round(
    (Date.UTC(ty ?? 1970, (tm ?? 1) - 1, td ?? 1) - Date.UTC(fy ?? 1970, (fm ?? 1) - 1, fd ?? 1)) / 86_400_000,
  );
}

function relativeDay(day: string, today: string): string {
  const distance = dayDistance(today, day);
  if (distance === 0) return "今天";
  if (distance === 1) return "明天";
  if (distance === -1) return "昨天";
  const [y, m, d] = day.split("-").map(Number);
  return day.slice(0, 4) === today.slice(0, 4) ? `${m}月${d}日` : `${y}年${m}月${d}日`;
}

/**
 * 列表里那枚到期标签：「今天 18:00」「明天」「已逾期 · 昨天 23:59」。
 *
 * 和 describeDue 守同一条规矩：只有日历日的**不带时刻**；精确时刻按待办自己的
 * 时区写钟点，「今天/明天」也按那个时区的日历算。完整的时刻与时区在详情里。
 */
export function shortDue(todo: TodoView, now: Date): { text: string; tone: DueTone } {
  const bucket = bucketOf(todo, now);
  let text: string;
  if (todo.duePrecision === "datetime" && todo.dueAtUtc) {
    const wall = utcToLocalInput(todo.dueAtUtc, todo.timeZone);
    if (!wall) return { text: "时间读不出来", tone: "normal" };
    const today = utcToLocalInput(now.toISOString(), todo.timeZone).slice(0, 10) || localDay(now);
    text = `${relativeDay(wall.slice(0, 10), today)} ${wall.slice(11, 16)}`;
  } else if (todo.duePrecision === "date" && todo.dueDate) {
    text = relativeDay(todo.dueDate, localDay(now));
  } else {
    return { text: "无到期", tone: todo.status === "open" ? "none" : "closed" };
  }
  if (todo.status !== "open") return { text, tone: "closed" };
  if (bucket === "overdue") return { text: `已逾期 · ${text}`, tone: "overdue" };
  if (bucket === "today") return { text, tone: "today" };
  return { text, tone: "normal" };
}

/** 详情里「提醒时刻」一栏：自己设过就写那个时刻，没设就说按到期提醒。 */
export function describeRemindAt(todo: TodoView): string {
  if (todo.remindAtUtc) {
    const shown = formatInZone(todo.remindAtUtc, todo.timeZone);
    return shown ?? "提醒时刻读不出来";
  }
  return todo.duePrecision === "none" ? "未设" : "未单独设置（按到期时间提醒）";
}

/** 保存之后说什么。保存成功和提醒失败是两件事，都要说。 */
export function describeSave(action: "created" | "updated", problem?: string | null): Message {
  const saved = action === "created" ? "已添加。" : "已保存。";
  if (!problem) return { tone: "success", text: saved };
  return { tone: "warn", text: `${saved}提醒没有登记上：${problem}` };
}

export function describeStatusChange(status: TodoStatus, problem?: string | null): Message {
  const base =
    status === "done" ? "已标记完成。" : status === "cancelled" ? "已取消。" : "已重新打开。";
  if (!problem) return { tone: "success", text: base };
  return { tone: "warn", text: `${base}提醒没有登记上：${problem}` };
}

/**
 * 逾期汇总那一条横幅。
 *
 * 说的是「这些到期了还没做」，**不是**「这些提醒过了」——很可能一次都没弹过
 * （电脑关着、未授权），把两件事混在一起说就是在替系统吹牛。
 */
export function describeDigest(count: number, more: number): Message | null {
  if (count <= 0) return null;
  const tail = more > 0 ? "，还有更多" : "";
  return {
    tone: "warn",
    text: `${count} 条已逾期${tail}`,
  };
}

/**
 * 设置页上「后台提醒」现在是什么状态。
 *
 * 五种状态的措辞对照产品需求 §5.4 与走查 10.11：关窗会响、退出不会响、
 * 未授权不会响但待办还在、系统调度有投递窗口。
 */
export function describeCapability(capability: ReminderCapability): Message {
  if (capability.available) {
    return {
      tone: "success",
      text: "提醒由系统发送，窗口关着也会响。点「退出应用」之后不会响。",
    };
  }
  return {
    tone: "warn",
    text: `${capability.reason ?? "这台机器上弹不出定时提醒。"}待办列表和逾期汇总照常可用。`,
  };
}

/** Windows 计划通知的投递窗口。不写清楚就等于承诺「一定送到」。 */
export const DELIVERY_WINDOW_NOTE =
  "系统的定时通知有几分钟的投递窗口；关机时间较长时这条提醒可能不会送达，下次打开应用会补一次汇总。";

/**
 * 产品需求 §5.4 列的五种状态，一处说清楚。
 *
 * 这张表是设置页照着渲染的。之所以要五条而不是一句「已开启提醒」，是因为
 * 「关窗」和「退出」在用户眼里差不多，实际结果完全相反 —— 前者照响，后者不响。
 */
export const LIFECYCLE_STATES: Array<{ when: string; what: string }> = [
  { when: "关闭窗口", what: "照常提醒。窗口只是隐藏到托盘，计划已经交给系统了。" },
  { when: "点「退出应用」", what: "不再提醒。退出时会撤销所有还没到点的提醒。" },
  { when: "没给系统通知权限", what: "不弹提醒。待办列表和逾期汇总照常可用。" },
  { when: "休眠 / 重启 / 关机", what: "由系统决定。错过的会在下次打开应用时汇总一次，不会连着补弹。" },
  { when: "电脑一直开着", what: "到点由系统发出，应用没在跑也不影响。" },
];

/** 退出前必须说的那句话。托盘和设置页两个入口都用它。 */
export const QUIT_WARNING =
  "退出后不会弹出提醒 —— 还没到点的提醒会被撤销，待办本身都还在。确定退出？";

// ---------------------------------------------------------------------------------
// 日历页（#551）。月历和按日分组都是前端推出来的；类型是待办表上一个可空的 `kind` 列
// （数据库 v11）：用户选过就用它，没选过（旧待办、AI 建的）才按标题与轮次推断。
// ---------------------------------------------------------------------------------

export const KIND_LABEL: Record<TodoKind, string> = {
  assessment: "测评",
  written: "笔试",
  interview: "面试",
  other: "其他",
};

/** 类型按钮的顺序：按求职里通常发生的先后——先测评，再笔试，再面试，「其他」放最后。 */
export const KIND_ORDER: TodoKind[] = ["assessment", "written", "interview", "other"];

/** 标题里算「面试」的完整说法：面试、面谈、复试、终面、初面、群面、「几面」（一面、二面）、「技术 / HR 面」等。
 *  不认单独一个「面」字：「简历方面整理」「整理面经」「见面确认」都不是面试。 */
const INTERVIEW_WORDS =
  /面试|面谈|复试|终面|初面|群面|[一二三四五六七八九十\d]\s*面|(?:hr|技术|主管|总监|交叉|电话|视频|业务|部门)\s*面/i;

/**
 * 这条待办算哪一类。用户选过类型就用他选的；没选过的（旧待办、AI 从邮件里建的）按轮次与
 * 标题关键词推断：有面试轮次或标题里有完整的面试说法 → 面试；含「测评」→ 测评；含「笔试」→ 笔试；
 * 其余 →「其他」。判断顺序就是这个顺序。
 */
export function inferKind(todo: Pick<TodoView, "title" | "interviewRound" | "kind">): TodoKind {
  if (todo.kind) return todo.kind;
  const title = todo.title ?? "";
  if (todo.interviewRound || INTERVIEW_WORDS.test(title)) return "interview";
  if (title.includes("测评")) return "assessment";
  if (title.includes("笔试")) return "written";
  return "other";
}

const DAY_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

function parseDay(day: string): { y: number; m: number; d: number } {
  const [y, m, d] = day.split("-").map(Number);
  return { y: y ?? 1970, m: m ?? 1, d: d ?? 1 };
}

function formatDay(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** 日历日加减天数。用 UTC 日历算，不受夏令时影响。 */
export function shiftDay(day: string, count: number): string {
  const { y, m, d } = parseDay(day);
  const shifted = new Date(Date.UTC(y, m - 1, d + count));
  return formatDay(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

/** 0 = 周日 … 6 = 周六。 */
export function weekdayOf(day: string): number {
  const { y, m, d } = parseDay(day);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

const WEEKDAY_NAME = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 星期头：周一起。 */
export const WEEKDAY_HEADS = ["一", "二", "三", "四", "五", "六", "日"];

export interface MonthRef {
  year: number;
  /** 1–12 */
  month: number;
}

export function monthOf(day: string): MonthRef {
  const { y, m } = parseDay(day);
  return { year: y, month: m };
}

export function shiftMonth(ref: MonthRef, delta: number): MonthRef {
  const index = ref.year * 12 + (ref.month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

export function monthTitle(ref: MonthRef): string {
  return `${ref.year}年${ref.month}月`;
}

export interface GridCell {
  day: string;
  inMonth: boolean;
}

/**
 * 一个月的格子，周一起。本月只要 5 行放得下就是 35 格，否则 42 格（6 行）。
 * 前后补的是相邻月份的日期，`inMonth` 为 false，界面上淡色显示。
 */
export function monthGrid(ref: MonthRef): GridCell[] {
  const first = formatDay(ref.year, ref.month, 1);
  const lead = (weekdayOf(first) + 6) % 7;
  const length = new Date(Date.UTC(ref.year, ref.month, 0)).getUTCDate();
  const total = lead + length > 35 ? 42 : 35;
  const start = shiftDay(first, -lead);
  const prefix = `${String(ref.year).padStart(4, "0")}-${String(ref.month).padStart(2, "0")}-`;
  return Array.from({ length: total }, (_, index) => {
    const day = shiftDay(start, index);
    return { day, inMonth: day.startsWith(prefix) };
  });
}

/**
 * 这条待办落在哪一天（`YYYY-MM-DD`）；没有日期返回 null。
 *
 * 精确时刻按**待办自己的时区**落在哪一天（和 `shortDue` 一样），不是按本机：
 * 上海晚上 23:00 的面试，机器在纽约时也属于上海的那一天。
 */
export function todoDay(todo: TodoView): string | null {
  if (todo.duePrecision === "datetime" && todo.dueAtUtc) {
    const wall = utcToLocalInput(todo.dueAtUtc, todo.timeZone);
    return wall ? wall.slice(0, 10) : null;
  }
  if (todo.duePrecision === "date" && todo.dueDate && DAY_FORMAT.test(todo.dueDate)) {
    return todo.dueDate;
  }
  return null;
}

/**
 * 日历格里的时刻，`HH:MM`。**只有精确时刻才有**；仅日历日（`duePrecision: "date"`）
 * 返回 null，界面上就不写时刻，更不会写成 `00:00`。
 */
export function todoClock(todo: TodoView): string | null {
  if (todo.duePrecision !== "datetime" || !todo.dueAtUtc) return null;
  const wall = utcToLocalInput(todo.dueAtUtc, todo.timeZone);
  return wall ? wall.slice(11, 16) : null;
}

/** 格子里这条待办怎么画：已完成灰色删除线，逾期标红，其余照常。 */
export type EntryState = "open" | "done" | "overdue";

export interface CalendarEntry {
  todo: TodoView;
  day: string;
  clock: string | null;
  kind: TodoKind;
  state: EntryState;
}

export function entryState(todo: TodoView, now: Date): EntryState {
  if (todo.status === "done") return "done";
  return bucketOf(todo, now) === "overdue" ? "overdue" : "open";
}

function compareEntries(a: CalendarEntry, b: CalendarEntry): number {
  // 只有日期的排在前面（全天事项），再按时刻，最后按标题，顺序稳定。
  if (a.clock !== b.clock) {
    if (a.clock === null) return -1;
    if (b.clock === null) return 1;
    return a.clock < b.clock ? -1 : 1;
  }
  return a.todo.title.localeCompare(b.todo.title, "zh-CN");
}

export interface CalendarModel {
  byDay: Map<string, CalendarEntry[]>;
  /** 没有具体日期的待办。已取消的不算。 */
  undated: TodoView[];
}

/**
 * 把全部待办整理成日历要用的样子。**已取消的一律不显示**；已完成的照样显示。
 * 没有日期、或日期读不出来的，进「未设具体日期」，不丢。
 */
export function buildCalendar(todos: TodoView[], now: Date): CalendarModel {
  const byDay = new Map<string, CalendarEntry[]>();
  const undated: TodoView[] = [];
  for (const todo of todos) {
    if (todo.status === "cancelled") continue;
    const day = todoDay(todo);
    if (!day) {
      undated.push(todo);
      continue;
    }
    const list = byDay.get(day) ?? [];
    list.push({ todo, day, clock: todoClock(todo), kind: inferKind(todo), state: entryState(todo, now) });
    byDay.set(day, list);
  }
  for (const list of byDay.values()) list.sort(compareEntries);
  return { byDay, undated };
}

/** 去掉「有限公司」之类的后缀和括号，格子里放不下全名。 */
export function companyShort(company: string | null | undefined, max = 6): string {
  let name = (company ?? "").replace(/[（(][^）)]*[）)]/g, "").trim();
  name = name.replace(/(股份有限公司|有限责任公司|有限公司|集团|公司)$/u, "").trim();
  if (!name) name = (company ?? "").trim();
  const chars = Array.from(name);
  return chars.length > max ? chars.slice(0, max).join("") : name;
}

/** 格内胶囊：`14:30 面试 · 星河`。仅日期的不写时刻。 */
export function pillText(entry: CalendarEntry): string {
  const short = companyShort(entry.todo.company);
  const head = `${entry.clock ? `${entry.clock} ` : ""}${KIND_LABEL[entry.kind]}`;
  return short ? `${head} · ${short}` : head;
}

export interface OverdueSummary {
  count: number;
  /** 最早一条逾期待办所在的那一天，以及它的 id；一条都没有时为 null。 */
  earliest: { day: string; id: string } | null;
}

/**
 * 月历上方那一行用。逾期 = 还没完成、到点了的待办（和列表分组同一个 `bucketOf`）。
 * 说的是「到期了还没做」，不是「提醒过了」。
 */
export function summarizeOverdue(todos: TodoView[], now: Date): OverdueSummary {
  let count = 0;
  let earliest: { day: string; id: string; clock: string } | null = null;
  for (const todo of todos) {
    if (bucketOf(todo, now) !== "overdue") continue;
    // 数量只算有日期、跳得过去的，标签上的数字和点了能到的地方永远一致。
    const day = todoDay(todo);
    if (!day) continue;
    count += 1;
    const clock = todoClock(todo) ?? "";
    if (!earliest || day < earliest.day || (day === earliest.day && clock < earliest.clock)) {
      earliest = { day, id: todo.id, clock };
    }
  }
  return { count, earliest: earliest ? { day: earliest.day, id: earliest.id } : null };
}

/** 右栏标题：`11月19日 · 周四`。 */
export function dayHeading(day: string): string {
  const { m, d } = parseDay(day);
  return `${m}月${d}日 · ${WEEKDAY_NAME[weekdayOf(day)]}`;
}

function distanceDays(from: string, to: string): number {
  const a = parseDay(from);
  const b = parseDay(to);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);
}

/** 右栏副标题：`明天 · 共 2 项`。离今天远的日子不写「今天/明天」。 */
export function daySummary(day: string, today: string, count: number): string {
  const distance = distanceDays(today, day);
  const relative = distance === 0 ? "今天" : distance === 1 ? "明天" : distance === -1 ? "昨天" : "";
  const total = count > 0 ? `共 ${count} 项` : "没有日程";
  return relative ? `${relative} · ${total}` : total;
}

/** 日历格子的读屏文字。 */
export function cellLabel(day: string, count: number): string {
  const { m, d } = parseDay(day);
  return `${m}月${d}日 ${WEEKDAY_NAME[weekdayOf(day)]}，${count > 0 ? `${count} 项日程` : "没有日程"}`;
}

/** 点「新增日程」时弹窗里预填什么：选中那天，精度默认「只有日期」。 */
export function prefillForDay(day: string): { duePrecision: "date"; dueDate: string } {
  return { duePrecision: "date", dueDate: day };
}

/** 提醒下拉的几个预设。`minutes` 是比到期时刻提前多少分钟；`default` 交给系统按默认规则提醒。 */
export type RemindPreset = "default" | "15" | "60" | "1440" | "custom";

export const REMIND_PRESET_MINUTES: Record<"15" | "60" | "1440", number> = { "15": 15, "60": 60, "1440": 1440 };

/** 只有日期的待办默认在当天这个钟点提醒（和后台 `DEFAULT_REMIND_LOCAL_TIME` 一致）。 */
export const DATE_ONLY_REMIND_TIME = "09:00";

/** 「提前多久」从哪个时刻算起：有具体时间就是它，只有日期就是当天早上 9 点。没有日期时算不了。 */
function remindBaseUtc(date: string, time: string, timeZone: string | null): string | null {
  if (!date) return null;
  return localInputToUtc(`${date}T${time || DATE_ONLY_REMIND_TIME}`, timeZone);
}

/**
 * 提醒预设 → 要存的提醒时刻（UTC）。`default` 返回 null：不单独设，后台按默认规则提醒。
 * 没有日期时「提前多久」没有起点，同样返回 null。
 */
export function remindFromPreset(
  preset: Exclude<RemindPreset, "custom">,
  date: string,
  time: string,
  timeZone: string | null,
): string | null {
  if (preset === "default") return null;
  const base = remindBaseUtc(date, time, timeZone);
  if (!base) return null;
  return new Date(Date.parse(base) - REMIND_PRESET_MINUTES[preset] * 60_000).toISOString();
}

/** 编辑时把已有的提醒时刻还原成下拉里的哪一项；对不上任何预设就是「自己选时间」。 */
export function presetFromRemind(
  remindAtUtc: string | null | undefined,
  date: string,
  time: string,
  timeZone: string | null,
): RemindPreset {
  if (!remindAtUtc) return "default";
  for (const key of ["15", "60", "1440"] as const) {
    if (remindFromPreset(key, date, time, timeZone) === new Date(remindAtUtc).toISOString()) return key;
  }
  return "custom";
}

export interface WhenNoteInput {
  hasDate: boolean;
  hasTime: boolean;
  /** 现成的短语，如「本机时区（Asia/Taipei）」。 */
  zoneLabel: string;
  capability: ReminderCapability;
  /** 这次要单独设的提醒时刻；不设就是 null。 */
  remindAtUtc: string | null;
  timeZone: string | null;
}

/**
 * 表单里提醒下面那一行小字：按哪个时区、提醒会在什么时候响（或为什么不会响）。
 * 提醒能不能响如实说：这台机器弹不出来就写原因，没有日期也没单独设提醒就说不提醒。
 */
export function describeWhenNote(input: WhenNoteInput): string {
  const { hasDate, hasTime, zoneLabel, capability, remindAtUtc, timeZone } = input;
  if (!hasDate && !remindAtUtc) return "没有日期的待办会放进「未设具体日期」，不会提醒。";
  const zone = zoneLabel ? `按${zoneLabel}。` : "";
  if (!capability.available) {
    return `${zone}${capability.reason ?? "这台机器上弹不出定时提醒"}，到点时不会弹提醒。`.replace(/。，/g, "，");
  }
  if (remindAtUtc) {
    const shown = formatInZone(remindAtUtc, timeZone);
    return `${zone}${shown ? `将在 ${shown} 提醒。` : "提醒时间读不出来。"}`;
  }
  return `${zone}${hasTime ? "到点时按系统通知提醒。" : "当天早上 9 点按系统通知提醒。"}`;
}
