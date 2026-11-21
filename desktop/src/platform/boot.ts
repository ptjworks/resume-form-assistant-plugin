import { runLaunchGate } from "./launch-gate.ts";
import { getPlatformServices } from "./registry.ts";
import type { PlatformServices } from "./registry.ts";
import { applyPlatformVisibility } from "./visibility.ts";

/**
 * 启动时的平台步骤：取服务 → 应用显示开关 → 过启动闸门。
 * main.ts 的 boot() 先调它，再走原有的启动流程。
 */
export async function bootPlatform(root: ParentNode): Promise<PlatformServices> {
  const platform = getPlatformServices();
  applyPlatformVisibility(root, platform.capabilities);
  await runLaunchGate(platform);
  return platform;
}
