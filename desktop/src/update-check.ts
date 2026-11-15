// 更新检查与软件内下载校验的纯逻辑：版本怎么比、什么时候该查、下载进度与校验结果怎么说。
//
// 安装包尚未做代码签名：支持在应用内下载安装包到本地并自动核对 `.sha256` 哈希，
// 但**绝不自动/静默执行安装**——下载并校验通过后，必须经用户显式确认才打开安装程序。

export interface UpdateInfo {
  /** 最新版本号，例如 `0.2.0`。 */
  version: string;
  /** 那一版的发布页。 */
  url: string;
}

export interface UpdateDownloadProgress {
  version: string;
  fileName: string;
  downloadedBytes: number;
  totalBytes?: number | null;
  phase: "checksum" | "downloading" | "verifying" | "ready" | string;
}

export interface DownloadedUpdate {
  version: string;
  fileName: string;
  sha256: string;
  sizeBytes: number;
}

export interface UpdatePreference {
  /** 启动时自动查一次（每天最多一次）。 */
  enabled: boolean;
  /** 上次检查的时间，RFC3339。没查过就是空。 */
  lastCheckedAt?: string | null;
  /** 上次查成时比当前版本新的那一版。同一天重启不再查，靠它接着提示。 */
  available?: UpdateInfo | null;
}

/**
 * 比较 `1.2.3` 这样的版本号。只认三段数字——预发布版本怎么发还没定，
 * 发版守卫那边也拒绝这种 tag。
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10));
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** 该不该查。关了就不查；今天查过了也不查——用户不需要每次开窗都联一次网。 */
export function shouldCheck(pref: UpdatePreference, nowIso: string): boolean {
  if (!pref.enabled) return false;
  const last = pref.lastCheckedAt;
  if (!last) return true;
  const lastDay = last.slice(0, 10);
  const today = nowIso.slice(0, 10);
  return lastDay !== today;
}

/**
 * 有没有该装的新版本。自动检查关了就不算；记下的那一版已经装上了也不算。
 * 「设置」上的小圆点照它显示。
 */
export function outstandingUpdate(pref: UpdatePreference, current: string): UpdateInfo | null {
  const latest = pref.available;
  if (!pref.enabled || !latest) return null;
  // 记下的那一版可能已经装上了。
  if (compareVersions(latest.version, current) <= 0) return null;
  return latest;
}

/**
 * 主界面上要不要提示、提示哪一版。用户收起的只管这一次运行：下次打开还会提示，
 * 直到装上新版。旧版本一直在用，反馈里就一直是早修好的问题。
 * 收起的只是那一版：这次运行里查到的版本变了（更新的，或者那一版撤回了），照样提示。
 */
export function updateNotice(pref: UpdatePreference, current: string, closedThisRun?: string | null): UpdateInfo | null {
  const latest = outstandingUpdate(pref, current);
  if (!latest) return null;
  if (closedThisRun && compareVersions(latest.version, closedThisRun) === 0) return null;
  return latest;
}

export interface UpdateMessage {
  tone: "ok" | "warn" | "error";
  text: string;
  /** 有没有新版本可下载。界面照它决定要不要显示「去下载页」。 */
  available: boolean;
  /** 是否允许在软件内直接下载安装包（默认与 `available` 一致；平台不支持应用内下载时为 `false`，仅保留「去下载页」）。 */
  canDownload?: boolean;
}

/** 查完之后说什么。 */
export function describeUpdate(current: string, latest: UpdateInfo | null): UpdateMessage {
  if (!latest) {
    return { tone: "ok", text: `已经是最新版（${current}）。`, available: false };
  }
  const order = compareVersions(latest.version, current);
  if (order <= 0) {
    return { tone: "ok", text: `已经是最新版（${current}）。`, available: false };
  }
  return {
    tone: "warn",
    text: `有新版本 ${latest.version}（现在是 ${current}）。下载后手动安装，装之前不用卸载旧版。`,
    available: true,
  };
}

/** 查不到时的说法。查不到不是错误，不该打扰用户。 */
export function describeCheckFailure(error: unknown): UpdateMessage {
  const detail = error as { code?: string; message?: string } | null;
  switch (detail?.code) {
    case "UPDATE_OFFLINE":
      return { tone: "warn", text: "连不上更新服务器，这次没查到。", available: false };
    case "UPDATE_RATE_LIMITED":
      return { tone: "warn", text: "更新服务器暂时限流了，过一会儿再查。", available: false };
    default:
      return {
        tone: "warn",
        text: `没查成：${detail?.message ?? "原因不明"}`,
        available: false,
      };
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

export function describeDownloadProgress(progress: UpdateDownloadProgress): {
  text: string;
  percent: number | null;
} {
  switch (progress.phase) {
    case "checksum":
      return {
        text: `正在获取 v${progress.version} 的 SHA-256 校验文件…`,
        percent: null,
      };
    case "verifying":
      return {
        text: `正在校验 ${progress.fileName} 的 SHA-256 哈希…`,
        percent: 100,
      };
    case "ready":
      return {
        text: `安装包 ${progress.fileName} 已完成 SHA-256 校验，请确认后打开安装程序。`,
        percent: 100,
      };
    default: {
      const total = progress.totalBytes ?? 0;
      if (total > 0) {
        const percent = Math.max(0, Math.min(100, Math.round((progress.downloadedBytes / total) * 100)));
        return {
          text: `正在下载 v${progress.version} 安装包… ${percent}%（${formatBytes(progress.downloadedBytes)} / ${formatBytes(total)}）`,
          percent,
        };
      }
      return {
        text: `正在下载 v${progress.version} 安装包… 已下载 ${formatBytes(progress.downloadedBytes)}`,
        percent: null,
      };
    }
  }
}

export function describeDownloadedUpdate(downloaded: DownloadedUpdate): UpdateMessage {
  return {
    tone: "ok",
    text: `新版本 ${downloaded.version} 安装包已下载并与同发布页的 SHA-256 校验一致（${downloaded.sha256.slice(0, 12)}…，仅校验下载完整性，未做代码签名）。请确认后打开安装程序，装之前不用卸载旧版。`,
    available: true,
    canDownload: true,
  };
}

export function describeDownloadFailure(error: unknown): UpdateMessage {
  const detail = error as { code?: string; message?: string } | null;
  switch (detail?.code) {
    case "UPDATE_UNSUPPORTED_PLATFORM":
    case "UPDATE_BAD_URL":
      return {
        tone: "warn",
        text: detail.message || "当前系统暂不支持应用内直接下载安装包，请点「去下载页」手动下载。",
        available: true,
        canDownload: false,
      };
    case "UPDATE_VERSION_CHANGED":
      return {
        tone: "warn",
        text: detail.message || "待更新版本已变更，请先重新点击「立即检查」后再下载。",
        available: false,
        canDownload: false,
      };
    case "UPDATE_DOWNLOAD_BUSY":
      return {
        tone: "warn",
        text: detail.message || "正在下载更新安装包，请稍候。",
        available: true,
        canDownload: true,
      };
    case "UPDATE_WRITE_FAILED":
      return {
        tone: "error",
        text: detail.message || "无法将安装包写入本地缓存目录，请检查磁盘空间与权限，或点「去下载页」手动下载。",
        available: true,
        canDownload: true,
      };
    case "UPDATE_HASH_MISMATCH":
      return {
        tone: "error",
        text: detail.message || "安装包 SHA-256 校验未通过，已删除损坏文件，请重新下载。",
        available: true,
        canDownload: true,
      };
    case "UPDATE_BAD_CHECKSUM":
      return {
        tone: "error",
        text: detail.message || "更新服务器上的 SHA-256 校验文件格式异常，已停止下载。",
        available: true,
        canDownload: true,
      };
    case "UPDATE_OFFLINE":
      return {
        tone: "warn",
        text: detail.message || "连不上更新服务器，安装包下载中断，可重试或点「去下载页」手动下载。",
        available: true,
        canDownload: true,
      };
    case "UPDATE_RATE_LIMITED":
      return {
        tone: "warn",
        text: detail.message || "更新服务器暂时限流了，可稍后重试或点「去下载页」手动下载。",
        available: true,
        canDownload: true,
      };
    default:
      return {
        tone: "error",
        text: `下载失败：${detail?.message ?? "原因不明"}`,
        available: true,
        canDownload: true,
      };
  }
}

/**
 * 宿主记下的上次检查时间。它用 `time` 的默认格式写盘（`2026-10-09 6:20:00.123 +00:00:00`），
 * 不是 RFC3339；两种都认，认不出来就返回 null——宁可不显示，也不编一个时间。
 */
export function parseCheckedAt(raw: string | null | undefined): Date | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2}):(\d{2})(?:\.\d+)?\s*(Z|[+-]\d{2}(?::?\d{2})?(?::\d{2})?)?$/.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, sec, zone] = match;
  let offsetMinutes = 0;
  if (zone && zone !== "Z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    const parts = zone.slice(1).split(":");
    const hours = Number(parts[0]?.slice(0, 2) ?? 0);
    const minutes = Number(parts[1] ?? (parts[0]?.length === 4 ? parts[0].slice(2) : 0));
    offsetMinutes = sign * (hours * 60 + minutes);
  } else if (!zone) {
    return null;
  }
  const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec)) - offsetMinutes * 60000;
  const at = new Date(utc);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** 「今天 14:20」「2026-10-08 09:05」。按本机时间显示。 */
export function formatCheckedAt(at: Date, now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = (value: Date) => `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return day(at) === day(now) ? `今天 ${time}` : `${day(at)} ${time}`;
}
