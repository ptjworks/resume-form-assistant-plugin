// #429 招聘平台的已知行为和文本框的字数上限。
// - 上传简历后会重新解析、覆盖已填内容的平台：侧栏提示先上传简历再填写。
// - 字数按字节算的站点（汉字算 2）：填之前按字节量。
// 平台和它们的行为取自 Form2Offer 的 src/platform-knowledge.js（github.com/gaaiyun/Form2Offer，提交 e7be145，2026-10-09）：
// 只取 parse.overwrites 记为 high 的几家和记了「按字节计」的两家，以及它们的 host、路径。跑在公司自己域名上的 Moka、飞书、北森
// 按 #429 调研记的页面特征认。Form2Offer 的许可随这个文件一起分发，原文如下（仓库里另有一份 scripts/licenses/form2offer-e7be145.txt）：
//
// MIT License
//
// Copyright (c) 2026 Br1an67
// Copyright (c) 2026 Gaaiyun and Form2Offer contributors
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
(function attachSiteKnowledge(scope) {
  const has = (doc, selector) => Boolean(doc?.querySelector?.(selector));
  // Moka 把页面配置放在内联脚本的 window._MOKA_ENV_ 里；内容脚本读不到页面的全局变量，只看脚本文字。
  const mentions = (doc, word) => Array.from(doc?.scripts || []).some(script => !script.src && String(script.textContent || "").includes(word));
  const PLATFORMS = [
    // parseMs：传完简历后至少等多久再填（第 4 项）。Form2Offer 记的解析时长往上取：Moka 8～10 秒、北森 10～20 秒；
    // 飞书、大易、携程没有记时长，按 15 秒。网站解析时不一定显示忙碌，等得太短，解析结果会在填完之后才到。
    { id: "moka", name: "Moka", overwrites: true, parseMs: 12000, hosts: [/(^|\.)mokahr\.com$/],
      looks: doc => (has(doc, "[class*='apply-field-']") && has(doc, "[class*='sd-Select']")) || mentions(doc, "_MOKA_ENV_") },
    { id: "feishu", name: "飞书招聘", overwrites: true, parseMs: 15000, hosts: [/(^|\.)jobs\.feishu\.cn$/, /(^|\.)jobs\.larksuite\.com$/],
      looks: doc => has(doc, ".ud-formily-item") && has(doc, "[data-form-field-id]") },
    // 北森旧版门户（zhiye.com 下 Portal/、campusxq 这类路径）的解析只截短专业名，不算。旧版是 IIS 站点，路径不分大小写。
    { id: "beisen", name: "北森", overwrites: true, parseMs: 25000, hosts: [/(^|\.)zhiye\.com$/, /(^|\.)italentx?\.(?:cn|com)$/, /(^|\.)beisen\.com$/],
      skip: { host: /(^|\.)zhiye\.com$/, path: /^\/(?:portal(?:\/|$)|campusxq|internxq|socialxq)/i },
      looks: doc => has(doc, ".form-item--phoenix") && has(doc, "[class*='phoenix-']") },
    { id: "dayee", name: "大易", overwrites: true, parseMs: 15000, hosts: [/(^|\.)dayee\.com$/] },
    { id: "ctrip", name: "携程招聘", overwrites: true, parseMs: 15000, hosts: [/^(?:careers|job)\.ctrip\.com$/] },
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
  // 文档所在网站的网址。about:blank、srcdoc 这类框架没有自己的网址，往外一层层看框架所在的文档，到顶还没有就用 fallback。
  function addressOf(doc, fallback) {
    for (let current = doc; current;) {
      const url = String(current.URL || "");
      if (/^https?:/i.test(url)) return url;
      let frame = null;
      try { frame = current.defaultView?.frameElement || null; } catch { frame = null; }
      current = frame?.ownerDocument || null;
    }
    return String(fallback || "");
  }
  // 侧栏里的一句提示：只给上传后会覆盖已填内容的平台。一键填写能替用户传简历时（桌面里有简历附件、页面上有空着的简历框）
  // 说一键填写会怎么做，不能传时（桌面旧、没有文件）请用户先自己传。
  function uploadHint(platform, { canUpload = false } = {}) {
    if (!platform?.overwrites) return "";
    const name = `${platform.name}${/[A-Za-z0-9]$/.test(platform.name) ? " " : ""}`;
    return canUpload
      ? `${name}上传简历后会重新解析并覆盖已填内容。一键填写会先上传简历，等解析完再填写。`
      : `${name}上传简历后会重新解析并覆盖已填内容，请先上传简历再填写。`;
  }
  // 传完简历后怎么等网站解析（见 upload-slots.js 的 waitForParse）。会覆盖的平台至少等 parseMs，最多 60 秒，表单安静 2 秒；
  // 只有看到网页忙过又不忙了才提前结束。别的网站至少 1 秒，表单安静 1.5 秒，最多 10 秒；这段时间里表单的值变了，
  // 当它也会解析覆盖：值变过就可以提前结束，上限放宽到 15 秒。
  function parseTiming(platform) {
    if (platform?.overwrites && Number.isInteger(platform.parseMs)) {
      return { known: true, minMs: platform.parseMs, quietMs: 2000, maxMs: 60000, extendMs: 60000, earlyOnChange: false };
    }
    return { known: false, minMs: 1000, quietMs: 1500, maxMs: 10000, extendMs: 15000, earlyOnChange: true };
  }

  // 字数：按字符（UTF-16 码元，和浏览器的 maxlength 一样）；按字节的站点一个字一个字量，0～255 以外的字算 2（emoji 也算 2）。
  function measure(text, bytes) {
    const value = String(text ?? "");
    if (!bytes) return value.length;
    let total = 0;
    for (const char of value) total += char.codePointAt(0) > 0xff ? 2 : 1;
    return total;
  }
  // 浏览器只对这几类框和多行文本认 maxlength（HTML 规范），数字、日期这类框带了也不管用，不按它拦。
  const MAXLENGTH_TYPES = new Set(["text", "search", "url", "tel", "email", "password"]);
  // 组件自己的字数统计「12 / 100」「0/20」，取后面的上限。只认字数统计专用的类名：antd 的 X-show-count-suffix、X-data-count
  // 和带 X-show-count 的外层上的 data-count，输入框组件的 input__count、textarea__count（Element 的 el-input__count），
  // word-limit、word-count 一类（Arco、Vant、iView）。类名只是带 count 的（分页、步骤的「1 / 3」，list__count 这类）不算。
  const COUNT = /^\s*\d+\s*\/\s*(\d+)\s*$/;
  const COUNTER = /(?:-show-count-suffix|-data-count|(?:input|textarea)__count|[-_]word-limit|[-_]word-count)$/i;
  const COUNTER_WRAPPER = /-show-count$/i;
  const classes = node => String(node.getAttribute?.("class") || "").split(/\s+/).filter(Boolean);
  // 框的字数上限：框自己的 maxlength；没有时看组件自己显示的字数统计（antd 4 带 showCount 的多行文本把 maxlength 拿掉了，
  // 只在外层的 data-count 里；antd 5 只设 count.max 的输入框只有「0 / 10」）。只在只装着这一个框的外层里找，最多往上三层。
  // 没有上限返回 null。上限是 0 的（maxlength="0"、字数统计「0 / 0」）也当没有上限：改前这类框能填上，真站上 0 也基本不是真的上限。
  function limitOf(el) {
    if (!el || !["INPUT", "TEXTAREA"].includes(el.tagName)) return null;
    if (el.tagName === "INPUT" && !MAXLENGTH_TYPES.has(String(el.type || "text").toLowerCase())) return null;
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
    return null;
  }

  const api = { detect, countsBytes, addressOf, uploadHint, parseTiming, measure, limitOf, platforms: PLATFORMS.map(({ id, name, overwrites = false, bytes = false }) => ({ id, name, overwrites, bytes })) };
  scope.ResumeProSiteKnowledge = api;
  try { if (typeof module === "object" && module && typeof module.exports === "object") module.exports = api; } catch { /* a page element or frame named "module" (#275) */ }
})(typeof self !== "undefined" ? self : globalThis);
