// 侧栏顶部的更新提醒：插件新版本已经下载好、插件是解压安装的、桌面程序太旧。
// 一次只提示一件，先说最快能解决的。这条提示不能关：旧版本一直在用，反馈里就一直是早修好的问题。
(function attachUpdateReminder(root) {
  const STORE_URL = 'https://chromewebstore.google.com/detail/diagjmploldedipjdenmecmjokckelkl';

  function parse(version) {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version ?? '').trim());
    return match ? match.slice(1).map(Number) : null;
  }

  function compare(a, b) {
    const left = parse(a);
    const right = parse(b);
    if (!left || !right) return 0;
    for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
    return 0;
  }

  // 桌面和插件一起发版，次版本号对齐（0.4.x 配 0.4.x，0.5.x 配 0.5.x）。桌面落后一个次版本就提示。
  // 0.4.4 及更早的桌面自己查不到新版本（仓库换了地址，旧版不认新的下载页），只能由插件来说。
  function desktopBehind(desktopVersion, extensionVersion) {
    const desktop = parse(desktopVersion);
    const extension = parse(extensionVersion);
    if (!desktop || !extension) return false;
    return desktop[0] < extension[0] || (desktop[0] === extension[0] && desktop[1] < extension[1]);
  }

  function reminder({ extensionVersion, installType, desktopVersion, readyVersion } = {}) {
    if (readyVersion && compare(readyVersion, extensionVersion) > 0) {
      return { kind: 'reload', message: `插件新版本 ${readyVersion} 已下载，重新加载后生效。`, action: '重新加载' };
    }
    if (installType === 'development') {
      return { kind: 'store', message: '这份插件是解压安装的，不会自动更新。请移除后从 Chrome 应用商店安装，桌面里的资料不受影响。', action: '去商店' };
    }
    if (desktopBehind(desktopVersion, extensionVersion)) {
      return { kind: 'download', message: `桌面程序版本较旧（${desktopVersion}），请更新到最新版。`, action: '去下载' };
    }
    return null;
  }

  const api = { STORE_URL, compare, desktopBehind, reminder };
  root.ResumeProUpdateReminder = api;
  try { if (typeof module === 'object' && module && typeof module.exports === 'object') module.exports = api; } catch { /* a page element or frame named "module" (#275) */ }
})(typeof self !== 'undefined' ? self : globalThis);
