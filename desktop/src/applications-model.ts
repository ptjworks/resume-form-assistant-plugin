// 投递页（#550）的纯逻辑：分组、组内排序、第 3 列提示、行内改阶段该走哪条命令、进度链。
// 界面只负责拼 DOM；说什么、往哪走由这里决定，这样不用 DOM 就能测。

import type { ApplicationSummary, StoredEvent, Stage, TodoView } from "./api.ts";
import { findMatchRanges } from "./search-highlight.ts";
import { bucketOf, localDay, shortDue } from "./todos.ts";
import { stageLabel } from "./applications.ts";

export type GroupId = "interview" | "assessment" | "submitted" | "pending" | "offer" | "ended";

export interface GroupDef {
  id: GroupId;
  label: string;
  stages: Stage[];
  /** 进行中的组默认展开；「已结束 / 未通过」默认折叠。 */
  collapsedByDefault: boolean;
}

/** 顺序就是页面上的顺序。「待投递」单独成组，放在「已投递」后面。 */
export const GROUPS: GroupDef[] = [
  { id: "interview", label: "面试中", stages: ["interview"], collapsedByDefault: false },
  { id: "assessment", label: "待测评", stages: ["assessment"], collapsedByDefault: false },
  { id: "submitted", label: "已投递", stages: ["submitted"], collapsedByDefault: false },
  { id: "pending", label: "待投递", stages: ["saved", "filling"], collapsedByDefault: false },
  { id: "offer", label: "Offer", stages: ["offer"], collapsedByDefault: false },
  { id: "ended", label: "已结束 / 未通过", stages: ["rejected", "withdrawn", "closed"], collapsedByDefault: true },
];

export function groupOf(stage: Stage | string | undefined): GroupId {
  const found = GROUPS.find((group) => (group.stages as string[]).includes(stage ?? ""));
  // 读不出阶段的记录当「待投递」，不让它从页面上消失。
  return found?.id ?? "pending";
}

/** 每组先画这么多行，组底「再显示 20 条」。 */
export const GROUP_PAGE_SIZE = 20;
/** 后端单次列表上限。 */
export const LIST_LIMIT = 1000;

export const STAGE_OPTIONS: Stage[] = [
  "saved", "filling", "submitted", "assessment", "interview", "offer", "rejected", "withdrawn", "closed",
];

const STAGE_RANK: Record<string, number> = {
  saved: 0, filling: 1, submitted: 2, assessment: 3, interview: 4, offer: 5,
  rejected: 6, withdrawn: 6, closed: 6,
};

/** 有对应「记录」命令的目标阶段。 */
const RECORDABLE: ReadonlySet<string> = new Set([
  "submitted", "assessment", "interview", "offer", "rejected", "withdrawn", "closed",
]);

export type StageChangeKind = "none" | "record" | "correct";

/**
 * 行内改阶段该怎么落库：
 * - 往后（目标在流程里更靠后，且有对应记录命令）→ `record`，延迟提交，可撤销、可改日期；
 * - 往前、同级互换，或没有记录命令的目标（如 saved → filling）→ `correct`，立即走纠正，原因由前端填。
 */
export function stageChangeKind(from: Stage | string | undefined, to: Stage | string): StageChangeKind {
  const current = from || "saved";
  if (current === to) return "none";
  const forward = (STAGE_RANK[to] ?? -1) > (STAGE_RANK[current] ?? -1);
  return forward && RECORDABLE.has(to) ? "record" : "correct";
}

/** `correct_stage_cmd` 要求原因非空；行内改阶段不让用户打字，由这里写一句。 */
export function autoCorrectReason(from: Stage | string | undefined, to: Stage | string): string {
  return `在投递页把阶段从「${stageLabel(from || "saved")}」改为「${stageLabel(to)}」`;
}

const RECORD_LABEL: Record<string, string> = {
  assessment: "测评", interview: "面试", offer: "Offer", rejected: "未通过", withdrawn: "撤回", closed: "结束申请",
};

/** 一次「往后改」要写库的那条命令。`date` 为空表示按今天记。 */
export function recordCall(
  id: string,
  to: Stage | string,
  date: string | null,
  now: Date = new Date(),
): { command: string; args: Record<string, unknown>; supportsDate: boolean } {
  if (to === "submitted") {
    // confirm_submit_cmd 没有「发生时间」参数，后端按提交那一刻记；所以这一步不能改日期。
    return { command: "confirm_submit_cmd", args: { id }, supportsDate: false };
  }
  const label = RECORD_LABEL[to] ?? stageLabel(to);
  return {
    command: `record_${to}_cmd`,
    supportsDate: true,
    args: {
      id,
      updateProgress: true,
      occurred: { precision: "date", value: { date: date || localDay(now), time_zone: null } },
      label, name: label, note: null, reason: null, round: null,
    },
  };
}

/** 往后改之后顶部提示条那句话。 */
export function pendingNotice(to: Stage | string, date: string | null, now: Date = new Date()): string {
  const day = date || localDay(now);
  const shown = `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日`;
  return date
    ? `已记为「${stageLabel(to)}」，日期记为 ${shown}`
    : `已记为「${stageLabel(to)}」，日期按今天记`;
}

// --- 第 3 列：日程 / 更新时间 -------------------------------------------------------

export type HintTone = "overdue" | "today" | "normal" | "quiet";

export interface RowHint {
  kind: "todo" | "updated" | "none";
  text: string;
  tone: HintTone;
  /** 只有 `todo` 才有：用于 title 提示完整内容。 */
  title?: string;
}

/** 待办的先后顺序用：精确时刻按时刻；只有日历日的按当天最后一刻，免得今天的待办一早就被排到「已过去」。 */
export function dueKey(todo: TodoView): number | null {
  if (todo.duePrecision === "datetime" && todo.dueAtUtc) {
    const at = Date.parse(todo.dueAtUtc);
    return Number.isNaN(at) ? null : at;
  }
  if (todo.duePrecision === "date" && todo.dueDate) {
    const [y, m, d] = todo.dueDate.split("-").map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d, 23, 59, 59).getTime();
  }
  return null;
}

/**
 * 每条申请取「最近一项」未完成日程：先看还没过的最早一条；都过了就取最近逾期的那条。
 * 没有到期时间的待办不进第 3 列。
 */
export function nearestTodoByApplication(todos: TodoView[], now: Date): Map<string, TodoView> {
  const byApp = new Map<string, TodoView[]>();
  for (const todo of todos) {
    if (todo.status !== "open" || dueKey(todo) === null) continue;
    const list = byApp.get(todo.applicationId) ?? [];
    list.push(todo);
    byApp.set(todo.applicationId, list);
  }
  const result = new Map<string, TodoView>();
  for (const [id, list] of byApp) {
    list.sort((a, b) => (dueKey(a) as number) - (dueKey(b) as number));
    const upcoming = list.find((todo) => bucketOf(todo, now) !== "overdue");
    result.set(id, upcoming ?? list[list.length - 1]);
  }
  return result;
}

function daysBetween(fromDay: string, toDay: string): number {
  const [fy, fm, fd] = fromDay.split("-").map(Number);
  const [ty, tm, td] = toDay.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

/** 「N 天前更新」。用 `updated_at`，不是「投递」时间，所以不写成「投递」。 */
export function updatedLabel(updatedAt: string | null | undefined, now: Date = new Date()): string {
  if (!updatedAt) return "";
  const at = new Date(updatedAt);
  if (Number.isNaN(at.getTime())) return "";
  const days = daysBetween(localDay(at), localDay(now));
  if (days <= 0) return "今天更新";
  if (days === 1) return "昨天更新";
  return `${days} 天前更新`;
}

/**
 * 第 3 列写什么。有日程就写日程（「明天 14:30 二面」），**仅日期的待办绝不带 00:00**——
 * 这由 `shortDue` 守着；没有日程就写「N 天前更新」。
 */
export function rowHint(app: ApplicationSummary, todo: TodoView | undefined, now: Date = new Date()): RowHint {
  if (todo) {
    const due = shortDue(todo, now);
    const text = todo.title ? `${due.text} ${todo.title}` : due.text;
    const tone: HintTone = due.tone === "overdue" ? "overdue" : due.tone === "today" ? "today" : "normal";
    return { kind: "todo", text, tone, title: text };
  }
  const text = updatedLabel(app.updated_at, now);
  return text ? { kind: "updated", text, tone: "quiet" } : { kind: "none", text: "", tone: "quiet" };
}

// --- 搜索与排序 ---------------------------------------------------------------------

/** 搜索命中规则与高亮完全一致（照搬后端的规范化），命中了就一定有高亮，反之亦然。 */
export function matchesQuery(app: ApplicationSummary, query: string | null | undefined): boolean {
  if (!query) return true;
  return (["company", "title", "location"] as const).some(
    (field) => findMatchRanges(field, app[field], query).length > 0,
  );
}

function updatedKey(app: ApplicationSummary): number {
  const at = Date.parse(app.updated_at ?? "");
  return Number.isNaN(at) ? 0 : at;
}

/** 组内排序：有未完成日程的按日程先后排前面，其余按最近更新。 */
export function sortInGroup(
  apps: ApplicationSummary[],
  nearest: Map<string, TodoView>,
): ApplicationSummary[] {
  return apps.slice().sort((a, b) => {
    const ka = nearest.has(a.id) ? dueKey(nearest.get(a.id) as TodoView) : null;
    const kb = nearest.has(b.id) ? dueKey(nearest.get(b.id) as TodoView) : null;
    if (ka !== null && kb !== null && ka !== kb) return ka - kb;
    if (ka !== null && kb === null) return -1;
    if (ka === null && kb !== null) return 1;
    return updatedKey(b) - updatedKey(a);
  });
}

export interface GroupView {
  def: GroupDef;
  /** 搜索后落在这一组里的记录（已排序）。 */
  items: ApplicationSummary[];
  /** 这一组的全部记录数（不受搜索影响，用于页头汇总）。 */
  total: number;
}

export function buildGroups(
  apps: ApplicationSummary[],
  query: string | null,
  nearest: Map<string, TodoView>,
  stageOf: (app: ApplicationSummary) => Stage | string | undefined = (app) => app.current_stage,
): GroupView[] {
  const buckets = new Map<GroupId, ApplicationSummary[]>();
  const totals = new Map<GroupId, number>();
  for (const app of apps) {
    const id = groupOf(stageOf(app));
    totals.set(id, (totals.get(id) ?? 0) + 1);
    if (!matchesQuery(app, query)) continue;
    const list = buckets.get(id) ?? [];
    list.push(app);
    buckets.set(id, list);
  }
  return GROUPS.map((def) => ({
    def,
    items: sortInGroup(buckets.get(def.id) ?? [], nearest),
    total: totals.get(def.id) ?? 0,
  }));
}

/** 页头「N 家进行中 · M 家已结束」。 */
export function headerSummary(apps: ApplicationSummary[], stageOf: (app: ApplicationSummary) => Stage | string | undefined = (app) => app.current_stage): string {
  let ended = 0;
  for (const app of apps) if (groupOf(stageOf(app)) === "ended") ended += 1;
  return `${apps.length - ended} 家进行中 · ${ended} 家已结束`;
}

// --- 进度链 ---------------------------------------------------------------------------

const ROUND_CN = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

export interface ChainItem { date: string; label: string }

function eventDay(event: StoredEvent): string {
  const occurred = event.occurred;
  if (occurred?.precision === "date" && occurred.value?.date) {
    const m = occurred.value.date.match(/^\d{4}-(\d{2})-(\d{2})$/);
    return m ? `${Number(m[1])}/${Number(m[2])}` : "";
  }
  if (occurred?.precision === "date_time" && occurred.value?.rfc3339) {
    const at = new Date(occurred.value.rfc3339);
    return Number.isNaN(at.getTime()) ? "" : `${at.getMonth() + 1}/${at.getDate()}`;
  }
  // 发生日期未知就是未知：不拿「记录于」的日期顶替。
  return "";
}

function chainLabel(event: StoredEvent): string | null {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.event_type) {
    case "submit_confirmed": return "投递";
    case "assessment_recorded": return "测评";
    case "interview_recorded": {
      const round = Number(payload.round);
      if (Number.isInteger(round) && round >= 1) return round < 10 ? `${ROUND_CN[round]}面` : `${round}面`;
      return "面试";
    }
    case "offer_recorded": return "Offer";
    case "rejected": return "未通过";
    case "withdrawn": return "撤回";
    case "closed": return "结束";
    case "stage_corrected": {
      const to = typeof payload.to === "string" ? payload.to : "";
      return to ? `改为${stageLabel(to)}` : "纠正阶段";
    }
    default: return null;
  }
}

/** 只浓缩阶段变化事件；没有任何阶段变化时，用「创建」兜底，免得进度链是空的。 */
export function progressChain(events: StoredEvent[] | undefined): ChainItem[] {
  const list = events ?? [];
  const items: ChainItem[] = [];
  for (const event of list) {
    const label = chainLabel(event);
    if (label) items.push({ date: eventDay(event), label });
  }
  if (!items.length) {
    const created = list.find((event) => event.event_type === "application_created");
    if (created) items.push({ date: eventDay(created), label: "创建" });
  }
  return items;
}

/** 「打开官网」只放行 http(s)：`javascript:`、`file:` 之类一律不开。 */
export function safeHttpUrl(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}
