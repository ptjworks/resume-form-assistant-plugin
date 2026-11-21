import type { PlatformServices } from "./registry.ts";

/**
 * 启动入口闸门，是以后「启动动效 → 登录卡片 → 等登录成功」的唯一接入点。
 * Phase 1 不要求登录，直接返回，进入投递页。
 * Phase 2 在 `requireAuthOnLaunch` 为 true 时：先播启动动效，若 `auth.getSession()` 不是
 * authenticated 就显示登录卡片，等登录成功后再 resolve。
 */
export async function runLaunchGate(platform: PlatformServices): Promise<void> {
  if (!platform.capabilities.requireAuthOnLaunch) return;
  // Phase 2：在此接启动动效与登录卡片。
}
