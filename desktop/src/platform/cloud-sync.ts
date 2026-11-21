import type { CloudSyncPreferences, CloudSyncStatus } from "./types.ts";

export interface CloudSyncService {
  getPreferences(): Promise<CloudSyncPreferences>;
  updatePreferences(next: Partial<CloudSyncPreferences>): Promise<CloudSyncPreferences>;
  getStatus(): Promise<CloudSyncStatus>;
  /** 输入账号/恢复口令派生的本机密钥解锁 E2E 信封（密钥明文绝不出端） */
  unlockVault(passphrase: string): Promise<void>;
  triggerSyncNow(): Promise<CloudSyncStatus>;
}
