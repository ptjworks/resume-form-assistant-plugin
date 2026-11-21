import type { AuthService } from "./auth.ts";
import type { CloudSyncService } from "./cloud-sync.ts";
import type { CommunityService } from "./community.ts";
import { createLocalOnlyPlatform } from "./local-only.ts";
import type { OnboardingService } from "./onboarding.ts";
import type { PlatformCapabilities } from "./types.ts";

export interface PlatformServices {
  capabilities: PlatformCapabilities;
  auth: AuthService;
  cloudSync: CloudSyncService;
  community: CommunityService;
  onboarding: OnboardingService;
}

let current: PlatformServices | null = null;

/** Phase 1 默认装本机实现；Phase 2 只需在启动前 configurePlatformServices 换成真实实现。 */
export function getPlatformServices(): PlatformServices {
  current ??= createLocalOnlyPlatform();
  return current;
}

export function configurePlatformServices(next: PlatformServices): void {
  current = next;
}
