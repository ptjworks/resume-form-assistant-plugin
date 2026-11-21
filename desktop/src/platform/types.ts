// 平台接口层的共用类型。Phase 1 只有本机实现（local-only.ts），这里的契约让 Phase 2
// 接入账号、云同步、社区、新手引导时只换实现、不改界面。

export interface PlatformCapabilities {
  /**
   * 是否显示头像按钮与账号抽屉。
   * 相对 #545 第 4.2 节的签名多出来的一项：把「显示账号入口」与「启动时强制登录」拆开，
   * 这样以后可以先放出账号入口、再单独决定要不要强制登录。
   */
  accountEnabled: boolean;
  /** Phase 2 开启：是否在桌面启动时要求登录（未登录先播动效进入登录页，登录后进主界面） */
  requireAuthOnLaunch: boolean;
  /** Phase 2 开启：是否启用官方账号云端 E2E 同步（false 时设置页展示开关但提示“平台服务上线后可用”） */
  cloudSyncEnabled: boolean;
  /** Phase 2 开启：是否连接在线社区后端（false 时展示本机真实私密心得 + 本地只读广场示例/待接入提示） */
  communityRemoteEnabled: boolean;
  /** 启动气泡新手引导（Phase 1/2 均可本地持久化运行） */
  spotlightOnboardingEnabled: boolean;
}

export type CareerStatusId = "interviewing" | "applying" | "waiting" | "offer";

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  avatarInitial: string;
  careerStatus: CareerStatusId;
}

export interface AuthSession {
  user: AuthUser | null;
  tokenExpiresAt?: string;
  mode: "local_guest" | "authenticated";
}

export interface CloudSyncPreferences {
  /** 是否把 API Base URL / 模型配置 / Key（本机加密后）同步到账号云端 */
  syncAiConfig: boolean;
  /** 是否同步简历模板与投递记录；默认 false，姓名/手机/附件等隐私默认仅存本机 */
  syncResumeAndApplications: boolean;
}

export interface CloudSyncStatus {
  state: "disabled_phase1" | "idle" | "syncing" | "synced" | "needs_unlock" | "error";
  lastSyncedAt?: string | null;
  errorMessage?: string | null;
}

export type CommunityChannel = "all" | "hot" | "poll" | "lucky" | "interview" | "written" | "saved";

export interface CommunityPollOption {
  id: string;
  label: string;
  votes: number;
}

export interface CommunityPost {
  id: string;
  authorName: string;
  authorInitial: string;
  authorBadge?: string;
  kind: "lucky" | "poll" | "interview" | "rant" | "note_private";
  visibility: "public" | "private_local";
  companyName?: string;
  title?: string;
  content: string;
  images?: Array<{ id: string; url: string; thumbUrl: string; caption?: string }>;
  poll?: {
    id: string;
    deadlineText: string;
    totalVotes: number;
    pickedOptionId?: string | null;
    options: CommunityPollOption[];
  };
  hotComment?: { author: string; content: string } | null;
  stats: {
    likes: number;
    blesses?: number;
    comments: number;
    likedByMe?: boolean;
    blessedByMe?: boolean;
    savedByMe?: boolean;
  };
  /** 若关联了本机 #490 心得 */
  localNoteId?: string;
  createdAtLabel: string;
}

export interface CommunityComment {
  id: string;
  postId: string;
  authorName: string;
  content: string;
  createdAtLabel: string;
}

export interface HotTopicItem {
  rank: number;
  label: string;
  tag?: "沸" | "热" | "新";
  postCount: number;
  filterCompany?: string;
  filterKeyword?: string;
}

/** 需要服务器才能做的事，在没有接入平台服务时统一抛这个错误。 */
export const PLATFORM_UNAVAILABLE = "PLATFORM_UNAVAILABLE";

export class PlatformUnavailableError extends Error {
  readonly code = PLATFORM_UNAVAILABLE;
  constructor(message = "该功能需要平台服务，当前版本暂未开放。") {
    super(message);
    this.name = "PlatformUnavailableError";
  }
}
