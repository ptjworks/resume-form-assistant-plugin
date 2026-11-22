// D09「招聘通知」（原「证据收件箱」）的文案与纯函数。界面只负责拼 DOM，说什么由这里决定（沿用 D07/D08 的
// 「文案只在一处说」）。这里的每一句都要经得起 §11 的检查：导入不等于对方回复了什么，
// 关联后未分类不叫「尚未导入」。

import type { AssociatedEvidence, EvidenceKind, EvidencePreview, EvidenceSummary, ReplyClass, SendMode } from "./api.ts";
import type { MailCandidate } from "./mailbox-ui.ts";

/** describeImport 只数数量与失败原因，不关心成功项的完整形状。 */
export interface ImportOutcome {
  imported?: unknown[];
  duplicates?: unknown[];
  failed?: Array<{ name: string; code: string }>;
}

/** 界面上要说的一句话：语气决定它显示成什么颜色。 */
export interface Message {
  tone: "info" | "success" | "warn" | "pending";
  text: string;
}

export const KIND_LABEL: Record<string, string> = {
  eml: "邮件",
  screenshot: "截图",
  pdf: "PDF",
  paste: "粘贴文本",
  unknown: "文本",
};

/** 通知业务类型（§6.3）。与发送方式各选各的，互不推断。 */
export const REPLY_CLASS_OPTIONS: Array<{ value: ReplyClass | ""; label: string }> = [
  { value: "", label: "未分类" },
  { value: "auto_ack", label: "自动回执" },
  { value: "assessment_invite", label: "测评邀请" },
  { value: "interview_invite", label: "面试邀请" },
  { value: "action_required", label: "需要我处理" },
  { value: "offer", label: "Offer" },
  { value: "reject", label: "未通过" },
  { value: "other", label: "其他" },
  { value: "unknown", label: "看不出来" },
];

/** 发送方式。判断不了就是「未知」，不因为类型是面试邀请就写成人工（走查 10.13）。 */
export const SEND_MODE_OPTIONS: Array<{ value: SendMode; label: string }> = [
  { value: "unknown", label: "未知" },
  { value: "human", label: "人工发送" },
  { value: "automated", label: "系统自动发送" },
];

/** 右栏标签里的发送方式：单独一个「未知」看不出是什么，所以写全。 */
export const SEND_MODE_TAG_LABEL: Record<SendMode, string> = {
  unknown: "发送方式未知",
  human: "人工发送",
  automated: "系统自动发送",
};

const IMPORT_ERRORS: Record<string, string> = {
  unsupported: "不支持这种文件。Outlook 的 .msg 请在邮件客户端里另存为 .eml，或者直接粘贴正文。",
  too_large: "超过 25 MiB，没有导入。",
  source_unreadable: "读不到这个文件，可能已经被移走或没有权限。",
  storage: "写入档案目录失败，什么都没有留下。",
  too_many_files: "一次最多导入 20 个文件，这个没有排上。",
};

export function kindLabel(kind: EvidenceKind | string | undefined): string {
  return (kind && KIND_LABEL[kind]) || "文件";
}

export function replyClassLabel(value: ReplyClass | null | undefined): string {
  return REPLY_CLASS_OPTIONS.find((option) => option.value === (value || ""))?.label || "未分类";
}

export function sendModeLabel(value: SendMode | null | undefined): string {
  return SEND_MODE_OPTIONS.find((option) => option.value === (value || "unknown"))?.label || "未知";
}

/** 列表里这条叫什么：主题 → 原始文件名 → 类型兜底。 */
export function evidenceTitle(item: Partial<EvidenceSummary> | null | undefined): string {
  const subject = (item?.subject || "").trim();
  if (subject) return subject;
  const filename = (item?.originalFilename || "").trim();
  if (filename) return filename;
  return kindLabel(item?.kind);
}

export function importErrorText(code: string): string {
  return IMPORT_ERRORS[code] || "这个文件没能导入。";
}

/**
 * 一次导入之后说什么。成功、重复、失败分开讲：重复不是错误，用户可能真的想把同一封信
 * 关到另一条申请上。
 */
export function describeImport(report: ImportOutcome | null | undefined): Message {
  const imported = report?.imported?.length ?? 0;
  const duplicates = report?.duplicates?.length ?? 0;
  const recycled = report?.duplicates?.filter(item => typeof item === "object" && item !== null && "recycled" in item && item.recycled === true).length ?? 0;
  const failed = report?.failed ?? [];
  if (!imported && !duplicates && !failed.length) {
    return { tone: "info", text: "没有选择任何文件。" };
  }

  const parts = [];
  if (imported) parts.push(`已导入 ${imported} 条，放在「待处理」里`);
  if (duplicates > recycled) parts.push(`${duplicates - recycled} 条内容和已有的完全相同，没有重复保存；需要的话可以把它关联到另一条投递`);
  if (recycled) parts.push(`${recycled} 条已在通知回收站中，没有重复保存；请到回收站恢复后查看或关联`);
  for (const item of failed) parts.push(`${item.name}：${importErrorText(item.code)}`);

  const tone = failed.length ? "warn" : imported ? "success" : "info";
  return { tone, text: parts.join("；") + "。" };
}

/** 这条证据和别的证据字节相同时的提示。 */
export function duplicateNote(item: Partial<EvidenceSummary> | null | undefined): string {
  const count = item?.sameBytesAs?.length ?? 0;
  if (!count) return "";
  return `内容和另外 ${count} 条完全相同（同一份字节只存了一次）。`;
}

/** 预览面板顶部那行元数据。 */
export function describeEvidenceMeta(item: Partial<EvidencePreview> | null | undefined): string {
  const parts = [kindLabel(item?.kind)];
  if (item?.fromAddr) parts.push(`来自 ${item.fromAddr}`);
  if (item?.sentAt) parts.push(`发送于 ${importedAtLabel(item.sentAt)}`);
  parts.push(`导入于 ${item?.importedAt ? importedAtLabel(item.importedAt) : "未知时间"}`);
  if (Number.isInteger(item?.sizeBytes)) parts.push(sizeLabel(item?.sizeBytes));
  return parts.join(" · ");
}

export function sizeLabel(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/** 关联结果的说法。关联本身不代表这封信说了什么。 */
export function describeAssociation(result: unknown, company: string | undefined): Message {
  if (!result) return { tone: "warn", text: "没能关联，请再试一次。" };
  const where = company ? `「${company}」` : "所选投递";
  return {
    tone: "success",
    text: `已关联到${where}，这封已移到「已处理」。关联不会改变投递的阶段。`,
  };
}

export function describeUnassociation(): Message {
  return { tone: "info", text: "已取消关联，这封回到了「待处理」。" };
}

export function describeClassification(item: Partial<EvidenceSummary> | null | undefined): Message {
  return {
    tone: "success",
    text: `已记为「${replyClassLabel(item?.replyClass)}」，${SEND_MODE_TAG_LABEL[(item?.sendMode as SendMode) || "unknown"] ?? "发送方式未知"}。这只是给这封信分类，不改变投递阶段。`,
  };
}

/** 没有待整理的通知：说清楚这里为什么空，不暗示对方没回复。 */
export const EMPTY_INBOX =
  "连接邮箱，自动发现招聘来信。短信或 App 通知、截图、连不上的邮箱，以及自动检查漏掉的邮件，仍可拖入文件或粘贴文字导入。关联到投递的在「已处理」里。";

/** 隐私说明：材料存在哪、AI 发什么、导入会不会动申请。邮箱连接的读取范围由用户明确开启。 */
export const PRIVACY_NOTE =
  "材料默认保存在本机。使用 AI 整理时，会先展示将发送给所配置服务商的内容，由你确认后才发送。导入和手动分类本身不会改变投递阶段，连接邮箱后会只读检查信头，确认才下载原文。";

/** 列表里的导入时间：本机时区的「年-月-日 时:分」，读不出来就原样给。 */
export function importedAtLabel(value: string | null | undefined): string {
  if (!value) return "";
  const at = new Date(value);
  if (Number.isNaN(at.getTime()) || !/T|\d:\d/.test(value)) return value.slice(0, 16);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** 候选申请列表的提示：同公司多个岗位不合并，必须自己选（§7、走查 10.1）。 */
export const CHOOSE_APPLICATION_HINT =
  "同一家公司可能有多条投递，这里不会替你猜——请选中具体那一条。";

// ---- 通知页三态：待处理 / 已处理 / 回收站 ------------------------------------------------
//
// 一封邮件从进 app 到定下位置，按顺序只有三站：
//   待处理 —— 邮箱发现的「新邮件」（只读了信头）+ 已存进本机但还没挂到投递的「待归档」；
//   已处理 —— 已经关联到某条投递；
//   回收站 —— 删掉了，可恢复。

export type InboxTab = "todo" | "done" | "bin";

export const INBOX_TABS: Array<{ id: InboxTab; label: string }> = [
  { id: "todo", label: "待处理" },
  { id: "done", label: "已处理" },
  { id: "bin", label: "回收站" },
];

/** 待处理里每一条在哪一步：新邮件（还没下载正文）/ 待归档（已存本机，等关联）。 */
export type RowStep = "new" | "archive" | "done" | "bin";

export const STEP_LABEL: Record<RowStep, string> = {
  new: "新邮件",
  archive: "待归档",
  done: "已处理",
  bin: "已删除",
};

export interface InboxRow {
  /** 候选和证据的 id 空间互不相干，所以用「种类:id」做列表里的唯一键。 */
  key: string;
  kind: "candidate" | "evidence";
  id: string;
  step: RowStep;
  sender: string;
  title: string;
  /** 排序和显示用的时间：优先发送时间，没有就用导入时间。 */
  time: string | null;
  /** 已处理里显示「公司 · 岗位」。 */
  sub: string;
  duplicate: boolean;
}

/** 邮箱「新邮件」候选区需要的一切。由 mailbox-ui 整理好交给通知页，通知页不再自己读邮箱。 */
export interface MailboxInboxState {
  candidates: MailCandidate[];
  /** 后端数到的总数；比 candidates 多说明还有没显示的。 */
  pendingCount: number;
  /** 邮箱整体的提示（检查异常、候选记录损坏等），没有就是 null。 */
  note: string | null;
  /** 这批候选上一次保存失败的原因，按候选 id。 */
  failures: Record<string, string>;
  canLoadMore: boolean;
  actions: {
    save(ids: string[]): Promise<void> | void;
    ignore(ids: string[]): Promise<void> | void;
    loadMore(): void;
  };
}

export function mailTime(item: { sentAt?: string | null; importedAt?: string | null } | null | undefined): string | null {
  return item?.sentAt || item?.importedAt || null;
}

function timestamp(value: string | null): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const at = date ? new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3])) : new Date(value);
  const ms = at.getTime();
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

function senderOf(item: Pick<EvidenceSummary, "fromAddr" | "kind">): string {
  return (item.fromAddr || "").trim() || kindLabel(item.kind);
}

export function candidateSender(candidate: MailCandidate): string {
  return (candidate.header.fromName || "").trim() || (candidate.header.fromAddr || "").trim() || "未知发件人";
}

export function candidateTitle(candidate: MailCandidate): string {
  return (candidate.header.subject || "").trim() || "无主题邮件";
}

export function applicationLabel(item: { company?: string; title?: string } | null | undefined): string {
  return [item?.company, item?.title].filter((part) => part && part.trim()).join(" · ");
}

/**
 * 当前这一页要列的行。待处理把新邮件和待归档合成一个列表，按时间倒序；
 * 已处理按时间倒序；回收站保持后端给的顺序（最近删的在前）。
 */
export function buildInboxRows(input: {
  tab: InboxTab;
  candidates: MailCandidate[];
  stored: EvidenceSummary[];
  done: AssociatedEvidence[];
  bin: EvidenceSummary[];
}): InboxRow[] {
  const evidenceRow = (item: EvidenceSummary, step: RowStep, sub = ""): InboxRow => ({
    key: `e:${item.id}`,
    kind: "evidence",
    id: item.id,
    step,
    sender: senderOf(item),
    title: evidenceTitle(item),
    time: mailTime(item),
    sub,
    duplicate: (item.sameBytesAs?.length ?? 0) > 0,
  });
  if (input.tab === "bin") return input.bin.map((item) => evidenceRow(item, "bin"));
  const rows: InboxRow[] =
    input.tab === "done"
      ? input.done.map((item) => evidenceRow(item, "done", applicationLabel(item) || "所属投递读取失败"))
      : [
          ...input.candidates.map((candidate): InboxRow => ({
            key: `c:${candidate.id}`,
            kind: "candidate",
            id: candidate.id,
            step: "new",
            sender: candidateSender(candidate),
            title: candidateTitle(candidate),
            time: candidate.header.sentAt || null,
            sub: "",
            duplicate: false,
          })),
          ...input.stored.map((item) => evidenceRow(item, "archive")),
        ];
  // sort 是稳定的：时间相同（或都没有时间）时保持上面的顺序，新邮件在前。
  return rows
    .map((row, index) => ({ row, index, at: timestamp(row.time) }))
    .sort((a, b) => (b.at === a.at ? a.index - b.index : b.at > a.at ? 1 : -1))
    .map((entry) => entry.row);
}

/** 列表右上角的时间：今天只显示几点几分，今年显示月日，更早显示完整日期。 */
export function listTimeLabel(value: string | null | undefined, now: Date = new Date()): string {
  if (!value) return "";
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const at = dateOnly ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])) : new Date(value);
  if (Number.isNaN(at.getTime())) return value.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, "0");
  const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  if (sameDay) return dateOnly ? "今天" : `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  if (at.getFullYear() === now.getFullYear()) return `${at.getMonth() + 1}月${at.getDate()}日`;
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** 左栏顶部「待处理」旁的数字：新邮件 + 待归档。待归档没读到时不报数，免得显示一个假的 0。 */
export function todoCount(storedCount: number | null, candidateCount: number): string {
  return storedCount === null ? "" : String(storedCount + candidateCount);
}
