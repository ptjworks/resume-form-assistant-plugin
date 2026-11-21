import type { PlatformCapabilities } from "./types.ts";

export type PlatformArea = "auth" | "cloud-sync" | "community-remote" | "onboarding";

export const PLATFORM_AREA_CAPABILITY: Record<PlatformArea, keyof PlatformCapabilities> = {
  auth: "accountEnabled",
  "cloud-sync": "cloudSyncEnabled",
  "community-remote": "communityRemoteEnabled",
  onboarding: "spotlightOnboardingEnabled",
};

/**
 * 按能力开关显示/隐藏平台入口。只切 `data-platform-off` 属性，不碰 `hidden`
 * （设置面板本来就靠 `hidden` 切分类）。HTML 里这些元素默认就带 `data-platform-off`。
 */
export function applyPlatformVisibility(root: ParentNode, capabilities: PlatformCapabilities): void {
  for (const el of root.querySelectorAll<HTMLElement>("[data-platform]")) {
    const area = el.dataset.platform as PlatformArea | undefined;
    const key = area ? PLATFORM_AREA_CAPABILITY[area] : undefined;
    // 不认识的取值保持隐藏，免得写错名字的入口露出来。
    el.toggleAttribute("data-platform-off", key ? !capabilities[key] : true);
  }
}
