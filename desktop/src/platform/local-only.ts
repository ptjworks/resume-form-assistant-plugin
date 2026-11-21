import type { AuthService } from "./auth.ts";
import type { CloudSyncService } from "./cloud-sync.ts";
import type { CommunityService } from "./community.ts";
import type { OnboardingService } from "./onboarding.ts";
import type { PlatformServices } from "./registry.ts";
import { PlatformUnavailableError } from "./types.ts";
import type { AuthSession, PlatformCapabilities } from "./types.ts";

/** Phase 1：平台相关能力全部关闭。 */
const LOCAL_CAPABILITIES: PlatformCapabilities = {
  accountEnabled: false,
  requireAuthOnLaunch: false,
  cloudSyncEnabled: false,
  communityRemoteEnabled: false,
  spotlightOnboardingEnabled: false,
};

const unavailable = (what: string): Promise<never> =>
  Promise.reject(new PlatformUnavailableError(`${what}需要平台服务，当前版本暂未开放。`));

function localAuth(): AuthService {
  const guest = (): AuthSession => ({ user: null, mode: "local_guest" });
  return {
    getSession: async () => guest(),
    subscribe: () => () => {},
    loginWithEmailOtp: () => unavailable("登录"),
    logout: async () => {},
    updateCareerStatus: () => unavailable("更新职业状态"),
  };
}

function localCloudSync(): CloudSyncService {
  return {
    getPreferences: async () => ({ syncAiConfig: false, syncResumeAndApplications: false }),
    updatePreferences: () => unavailable("更新云同步偏好"),
    getStatus: async () => ({ state: "disabled_phase1" }),
    unlockVault: () => unavailable("解锁云同步"),
    triggerSyncNow: () => unavailable("立即同步"),
  };
}

function localCommunity(): CommunityService {
  return {
    listFeed: () => unavailable("社区广场"),
    createPost: () => unavailable("发布帖子"),
    castPollVote: () => unavailable("投票"),
    toggleReaction: () => unavailable("互动"),
    listComments: () => unavailable("查看评论"),
    createComment: () => unavailable("发表评论"),
    getHotTopics: () => unavailable("热门话题"),
    getDailyTeaPoll: () => unavailable("每日投票"),
    previewDesensitizedNote: () => unavailable("脱敏发布"),
    publishDesensitizedNote: () => unavailable("脱敏发布"),
  };
}

function localOnboarding(): OnboardingService {
  return {
    shouldRunSpotlightTour: async () => false,
    getSpotlightSteps: () => [],
    completeTour: async () => {},
    replayTour: async () => {},
  };
}

/** 本机实现：全部功能离线可用，需要服务器的方法统一抛 PlatformUnavailableError。 */
export function createLocalOnlyPlatform(): PlatformServices {
  return {
    capabilities: { ...LOCAL_CAPABILITIES },
    auth: localAuth(),
    cloudSync: localCloudSync(),
    community: localCommunity(),
    onboarding: localOnboarding(),
  };
}
