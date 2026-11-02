// #429 招聘平台的已知行为和文本框的字数上限。
// - 上传简历后会重新解析、覆盖已填内容的平台：侧栏提示先上传简历再填写。
// - 字数按字节算的站点（汉字算 2）：填之前按字节量。
// 平台和它们的行为取自 Form2Offer 的 src/platform-knowledge.js（MIT，github.com/gaaiyun/Form2Offer，
// 提交 e7be145，2026-10-09；许可原文见 scripts/licenses/form2offer-e7be145.txt）：只取 parse.overwrites 记为 high 的几家
// 和记了「按字节计」的两家，以及它们的 host、路径。跑在公司自己域名上的 Moka、飞书、北森按 #429 调研记的页面特征认。
(function attachSiteKnowledge(scope) {
  const has = (doc, selector) => Boolean(doc?.querySelector?.(selector));
  // Moka 把页面配置放在内联脚本的 window._MOKA_ENV_ 里；内容脚本读不到页面的全局变量，只看脚本文字。
  const mentions = (doc, word) => Array.from(doc?.scripts || []).some(script => !script.src && String(script.textContent || "").includes(word));
  const PLATFORMS = [
    { id: "moka", name: "Moka", overwrites: true, hosts: [/(^|\.)mokahr\.com$/],
      looks: doc => (has(doc, "[class*='apply-field-']") && has(doc, "[class*='sd-Select']")) || mentions(doc, "_MOKA_ENV_") },
    { id: "feishu", name: "飞书招聘", overwrites: true, hosts: [/(^|\.)jobs\.feishu\.cn$/, /(^|\.)jobs\.larksuite\.com$/],
      looks: doc => has(doc, ".ud-formily-item") && has(doc, "[data-form-field-id]") },
    // 北森旧版门户（zhiye.com 下 Portal/、campusxq 这类路径）的解析只截短专业名，不算。旧版是 IIS 站点，路径不分大小写。
    { id: "beisen", name: "北森", overwrites: true, hosts: [/(^|\.)zhiye\.com$/, /(^|\.)italentx?\.(?:cn|com)$/, /(^|\.)beisen\.com$/],
      skip: { host: /(^|\.)zhiye\.com$/, path: /^\/(?:portal(?:\/|$)|campusxq|internxq|socialxq)/i },
      looks: doc => has(doc, ".form-item--phoenix") && has(doc, "[class*='phoenix-']") },
    { id: "dayee", name: "大易", overwrites: true, hosts: [/(^|\.)dayee\.com$/] },
    { id: "ctrip", name: "携程招聘", overwrites: true, hosts: [/^(?:careers|job)\.ctrip\.com$/] },
    { id: "51job-classic", name: "前程无忧（旧版）", bytes: true, hosts: [/(^|\.)51job\.com$/], path: /\.aspx/i },
    { id: "yingjiesheng", name: "应届生求职", bytes: true, hosts: [/^q\.yingjiesheng\.com$/, /^young\.yingjiesheng\.com$/] }
  ];

  function where(href) {
    try {
      const url = new URL(String(href || ""));
      return { host: url.hostname.toLowerCase(), path: url.pathname };
    } catch {
      return { host: "", path: "" };
    }
  }
  function skipped(platform, { host, path }) {
    return Boolean(platform.skip?.host.test(host) && platform.skip.path.test(path));
  }
  // 只看网址：host 认得出（要求路径的还要路径对上）。
  function byUrl(href) {
    const at = where(href);
    return PLATFORMS.find(platform => !skipped(platform, at) && platform.hosts.some(pattern => pattern.test(at.host))
      && (!platform.path || platform.path.test(at.path))) || null;
  }
  // 网址认不出的再看页面特征（公司自己的域名）。要读页面，调用方按页面隔一会儿认一次（见 content.js 的 siteHint）。
  function detect(doc, href) {
    const known = byUrl(href);
    if (known) return known;
    const at = where(href);
    for (const platform of PLATFORMS) {
      if (skipped(platform, at)) continue;
      try { if (platform.looks?.(doc)) return platform; } catch { /* 读不了页面就当认不出 */ }
    }
    return null;
  }
  // 字数按字节算的站点：这几家都按网址认，不读页面。
  function countsBytes(href) {
    return Boolean(byUrl(href)?.bytes);
  }
  // 侧栏里的一句提示：只给上传后会覆盖已填内容的平台。
  function uploadHint(platform) {
    if (!platform?.overwrites) return "";
    return `${platform.name}${/[A-Za-z0-9]$/.test(platform.name) ? " " : ""}上传简历后会重新解析并覆盖已填内容，请先上传简历再填写。`;
  }

  // 字数：按字符（UTF-16 码元，和浏览器的 maxlength 一样）；按字节的站点里 0～255 以外的字算 2。
  function measure(text, bytes) {
    const value = String(text ?? "");
    return bytes ? value.length + (value.match(/[^\x00-\xff]/g) || []).length : value.length;
  }
  // 浏览器只对这几类框和多行文本认 maxlength（HTML 规范），数字、日期这类框带了也不管用，不按它拦。
  const MAXLENGTH_TYPES = new Set(["text", "search", "url", "tel", "email", "password"]);
  // 组件自己的字数统计「12 / 100」「0/20」，取后面的上限。只认字数统计专用的类名：antd 的 X-show-count-suffix、X-data-count
  // 和带 X-show-count 的外层上的 data-count，Element 的 X__count（el-input__count），word-limit、word-count 一类（Arco、Vant、iView）。
  // 类名只是带 count 的（分页、步骤的「1 / 3」）不算。
  const COUNT = /^\s*\d+\s*\/\s*(\d+)\s*$/;
  const COUNTER = /(?:-show-count-suffix|-data-count|__count|[-_]word-limit|[-_]word-count)$/i;
  const COUNTER_WRAPPER = /-show-count$/i;
  const classes = node => String(node.getAttribute?.("class") || "").split(/\s+/).filter(Boolean);
  // 框的字数上限：框自己的 maxlength；没有时看组件自己显示的字数统计（antd 4 带 showCount 的多行文本把 maxlength 拿掉了，
  // 只在外层的 data-count 里；antd 5 只设 count.max 的输入框只有「0 / 10」）。只在只装着这一个框的外层里找，最多往上三层。
  function limitOf(el) {
    if (!el || !["INPUT", "TEXTAREA"].includes(el.tagName)) return 0;
    if (el.tagName === "INPUT" && !MAXLENGTH_TYPES.has(String(el.type || "text").toLowerCase())) return 0;
    const native = Number(el.maxLength);
    if (Number.isInteger(native) && native > 0) return native;
    let node = el.parentElement;
    for (let depth = 0; node && depth < 3; depth += 1, node = node.parentElement) {
      if (node.querySelectorAll("input:not([type='hidden']), textarea").length > 1) break;
      const wrapped = classes(node).some(name => COUNTER_WRAPPER.test(name)) ? COUNT.exec(node.getAttribute("data-count") || "") : null;
      if (wrapped && Number(wrapped[1]) > 0) return Number(wrapped[1]);
      for (const holder of node.querySelectorAll("[class]")) {
        if (!classes(holder).some(name => COUNTER.test(name))) continue;
        const hit = COUNT.exec(holder.textContent || "");
        if (hit && Number(hit[1]) > 0) return Number(hit[1]);
      }
    }
    return 0;
  }

  const api = { detect, countsBytes, uploadHint, measure, limitOf, platforms: PLATFORMS.map(({ id, name, overwrites = false, bytes = false }) => ({ id, name, overwrites, bytes })) };
  scope.ResumeProSiteKnowledge = api;
  try { if (typeof module === "object" && module && typeof module.exports === "object") module.exports = api; } catch { /* a page element or frame named "module" (#275) */ }
})(typeof self !== "undefined" ? self : globalThis);
