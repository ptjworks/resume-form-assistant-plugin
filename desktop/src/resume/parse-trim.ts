import type { TemplateGroupView } from "../api.ts";
import { profileApi } from "./profile.ts";

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

// Rust 的 str::trim 和正则的 \s 认的是 Unicode White_Space；JS 的 trim 和 \s 多认 U+FEFF、
// 少认 U+0085。两边要算出同一份内容，这里按 Rust 的来。
const WHITE_SPACE = "\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000";
const EDGE_SPACE = new RegExp(`^[${WHITE_SPACE}]+|[${WHITE_SPACE}]+$`, "gu");
const trim = (text: string) => text.replace(EDGE_SPACE, "");

// 与 archive-store 的 normalize_groups 一致：组名与字段名 trim，值原样；空字段名丢弃，
// 空组丢弃，空组名记为「未分类」。键的顺序也要和 serde 的结构体一致（name、fields；key、value），
// 序列化出来才逐字节相同。
function normalized(groups: TemplateGroupView[]): TemplateGroupView[] {
  return groups
    .map((group) => ({
      name: trim(group.name) || UNGROUPED,
      fields: group.fields
        .map((field) => ({ key: trim(field.key), value: field.value }))
        .filter((field) => field.key),
    }))
    .filter((group) => group.fields.length);
}

/**
 * 插件的 SECRET_LABEL / SECRET_VALUE 换成 Rust regex 的语义：Rust 的 (?i) 按 Unicode 大小写折叠
 * （「ſ」也算 s），JS 要带 u 标志才一样；\s / \S 换成上面那组空白。源码与 resume_secrets.rs
 * 逐字相同，由 parse-trim.test.ts 核对。
 */
export function rustSemantics(pattern: RegExp): RegExp {
  const source = pattern.source.replaceAll("\\s", `[${WHITE_SPACE}]`).replaceAll("\\S", `[^${WHITE_SPACE}]`);
  return new RegExp(source, "iu");
}

const SECRET_LABEL = rustSemantics(profileApi.SECRET_LABEL);
const SECRET_VALUE = rustSemantics(profileApi.SECRET_VALUE);

const isSecret = (field: { key: string; value: string }) => SECRET_LABEL.test(field.key) || SECRET_VALUE.test(field.value);

// 与 archive-store 的 storable_groups 一致：规范化之后剔掉像密码、验证码的字段，剔空的组不留。
function storable(groups: TemplateGroupView[]): { groups: TemplateGroupView[]; secrets: number } {
  let secrets = 0;
  const kept = normalized(groups)
    .map((group) => {
      const fields = group.fields.filter((field) => !isSecret(field));
      secrets += group.fields.length - fields.length;
      return { name: group.name, fields };
    })
    .filter((group) => group.fields.length);
  return { groups: kept, secrets };
}

const encoder = new TextEncoder();

/** 这份分组存进档案时拿去和上限比的字节数，像密码的字段后端不存，也不算在内。 */
export function templateBytes(groups: TemplateGroupView[]): number {
  return encoder.encode(JSON.stringify(storable(groups).groups)).length;
}

/** 存进档案时会留下的字段数。 */
export function fieldCountOf(groups: TemplateGroupView[]): number {
  return storable(groups).groups.reduce((sum, group) => sum + group.fields.length, 0);
}

/** 存进档案时会剔掉的、像密码或验证码的字段数。 */
export function secretCountOf(groups: TemplateGroupView[]): number {
  return storable(groups).secrets;
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
