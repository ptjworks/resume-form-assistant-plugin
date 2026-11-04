import type { TemplateGroupView } from "../api.ts";

// AI 解析结果超过模板大小上限时的删减（#301 U1）。原结果不动，删减只改这份草稿，
// 保存时再折回分组；大小按后端同一口径算 UTF-8 字节，不用 JS 字符串长度。

export interface TrimField {
  key: string;
  value: string;
  keep: boolean;
}

export interface TrimGroup {
  name: string;
  keep: boolean;
  fields: TrimField[];
}

const UNGROUPED = "未分类";

// 与 archive-store 的 normalize_groups 一致：组名与字段名 trim，值原样；空字段名丢弃，
// 空组丢弃，空组名记为「未分类」。键的顺序也要和 serde 的结构体一致（name、fields；key、value），
// 序列化出来才逐字节相同。
function normalized(groups: TemplateGroupView[]): TemplateGroupView[] {
  return groups
    .map((group) => ({
      name: group.name.trim() || UNGROUPED,
      fields: group.fields
        .map((field) => ({ key: field.key.trim(), value: field.value }))
        .filter((field) => field.key),
    }))
    .filter((group) => group.fields.length);
}

const encoder = new TextEncoder();

/**
 * 这份分组存进档案时的字节数。后端还会剔掉像密码的字段，所以实际存的只会更小：
 * 这里不超过上限，后端的大小检查就一定通过。
 */
export function templateBytes(groups: TemplateGroupView[]): number {
  return encoder.encode(JSON.stringify(normalized(groups))).length;
}

export function fieldCountOf(groups: TemplateGroupView[]): number {
  return groups.reduce((sum, group) => sum + group.fields.length, 0);
}

export function trimDraft(groups: TemplateGroupView[]): TrimGroup[] {
  return groups.map((group) => ({
    name: group.name,
    keep: true,
    fields: group.fields.map((field) => ({ key: field.key, value: field.value, keep: true })),
  }));
}

function keptGroup(group: TrimGroup): TemplateGroupView {
  return {
    name: group.name,
    fields: group.keep ? group.fields.filter((field) => field.keep).map(({ key, value }) => ({ key, value })) : [],
  };
}

/** 删减后要保存的分组：去掉没勾的组和字段，删空的组不留。 */
export function trimmedGroups(draft: TrimGroup[]): TemplateGroupView[] {
  return draft.map(keptGroup).filter((group) => group.fields.length);
}

/** 一个分组按当前勾选留下的内容占多少字节，帮用户看出该从哪一组下手。 */
export function groupBytes(group: TrimGroup): number {
  const kept = keptGroup(group);
  return kept.fields.length ? templateBytes([kept]) : 0;
}

export function setGroupKept(draft: TrimGroup[], index: number, keep: boolean): TrimGroup[] {
  return draft.map((group, i) => (i === index ? { ...group, keep } : group));
}

export function updateField(draft: TrimGroup[], groupIndex: number, fieldIndex: number, patch: Partial<Pick<TrimField, "keep" | "value">>): TrimGroup[] {
  return draft.map((group, i) =>
    i === groupIndex
      ? { ...group, fields: group.fields.map((field, j) => (j === fieldIndex ? { ...field, ...patch } : field)) }
      : group,
  );
}

const number = new Intl.NumberFormat("zh-CN");

export function formatBytes(bytes: number): string {
  return `${number.format(bytes)} 字节`;
}
