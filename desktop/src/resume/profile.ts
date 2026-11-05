// 插件的 profile-fields.js 是 IIFE：没有 CommonJS 时把 API 挂到 globalThis.ResumeProProfile。
// 这里只做一次副作用导入，再给 TS 一个有类型的入口。
import "./profile-fields.js";
import "./ai-helpers.js";

export interface ProfileFieldDef {
  id: string;
  key: string;
  label?: string;
  type?: "select" | "month" | "textarea";
  options?: string[];
  placeholder?: string;
  aliases?: string[];
}

export interface ProfileGroupDef {
  name: string;
  fields: ProfileFieldDef[];
}

export interface FamilyMember {
  relation: string;
  [field: string]: string;
}

export interface CustomField {
  key: string;
  value: string;
}

export interface Profile {
  values: Record<string, string>;
  family: FamilyMember[];
  custom: CustomField[];
}

interface ProfileApi {
  PROFILE_SCHEMA: ProfileGroupDef[];
  /** 像密码、验证码的字段名 / 内容；与 archive-store 的 resume_secrets 同一口径。 */
  SECRET_LABEL: RegExp;
  SECRET_VALUE: RegExp;
  FAMILY_FIELDS: ProfileFieldDef[];
  FAMILY_RELATIONS: string[];
  FAMILY_GROUP: string;
  CUSTOM_GROUP: string;
  normalizeProfile(raw: unknown): Profile;
  normalizeKey(value: string): string;
  /** 「我的信息」展开成填写候选（已滤掉空值与密码类），与插件一键填写同一套。 */
  profileToResumeFields(profile: unknown): Array<{ group: string; key: string; value: string }>;
  emptyProfile(): Profile;
  countPendingFields(profile: Profile): number;
  countProfileValues(profile: Profile): number;
}

export const profileApi = (globalThis as unknown as { ResumeProProfile: ProfileApi }).ResumeProProfile;

/** 18 位证件号的校验结果（ai-helpers.js，#429），不是 18 位的返回 null。拿不到 ai-helpers 时也返回 null，只是不提示。 */
export const idNumberInfo = (value: string): { valid: boolean; kind: string } | null =>
  (globalThis as unknown as { ResumeProAIHelpers?: { idNumberInfo?(value: string): { valid: boolean; kind: string } | null } })
    .ResumeProAIHelpers?.idNumberInfo?.(value) ?? null;
