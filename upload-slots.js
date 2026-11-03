// #429 第 4 项：网页上的上传框。认框、判断要什么文件、给框选桌面里的文件、把文件交给框、看网站的反应，
// 以及传完简历后等网站解析。只读写这个框和它所在的表单项，不点上传按钮、不打开选文件窗口、不替网站点对话框。
// 文件内容只在调用方的内存里经过这里，这里不存、不记日志。
// 参考了 kareer（MIT）fillFileInput、waitForResumeParsing 的思路（DataTransfer 写 input.files 再发事件；
// 轮询表单值和忙碌标志判断解析完），代码按这里的结构自己写。
(function attachUploadSlots(scope) {
  // 单个文件的上限，和桌面一样（rules.json 的 maxResumeFileBytes）。网站写明更小的按网站的。
  const MAX_FILE_BYTES = 10 * 1024 * 1024;
  const KB = 1024;
  const MB = 1024 * 1024;

  // --- 要什么文件 -------------------------------------------------------------

  // 明确不传的材料：证书、证件扫描件这类不是简历附件、也不是证件照。和别的词同时出现时以它为准
  // （「身份证照片」是身份证，不是证件照）。
  const OTHER_WORDS = /作品集|作品|证书|获奖|身份证|学生证|学位证|毕业证|在读证明|学信|推荐表|三方|推荐信|求职信|体检|portfolio|certificat|cover\s*letter|reference\s*letter/i;
  const KIND_WORDS = {
    resume: /简历|履历|\bcv\b|r[eé]sum[eé]|curriculum\s*vitae/i,
    photo: /证件照|一寸|二寸|免冠|个人照片|近照|照片|头像|\bphoto\b|avatar|headshot/i,
    transcript: /成绩单|成绩证明|transcript/i
  };
  // 照片里不是证件照的。
  const NOT_ID_PHOTO = /生活照|艺术照|全身照|作品照/;
  const LANGUAGE_WORDS = { zh: /中文|汉语|chinese|\bcn\b/i, en: /英文|英语|english|\ben\b/i };

  const MIME_EXTS = {
    "application/pdf": [".pdf"],
    "application/msword": [".doc"],
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
    "image/jpeg": [".jpg", ".jpeg"],
    "image/png": [".png"]
  };
  const KIND_MIMES = {
    resume: ["application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    photo: ["image/jpeg", "image/png"],
    transcript: ["application/pdf", "image/jpeg", "image/png"]
  };
  const KIND_NAMES = { resume: "简历附件", photo: "证件照", transcript: "成绩单", other: "其他材料" };

  const squash = text => String(text ?? "").replace(/\s+/g, " ").trim();
  const classText = el => String(el?.getAttribute?.("class") || "");
  const classTokens = el => classText(el).split(/\s+/).filter(Boolean);
  // 组件库的上传组件都带 upload 这个词（ant-upload、el-upload、换了前缀的 atsx-upload、uploader）。
  const UPLOAD_TOKEN = /(?:^|[-_])upload(?:er)?(?:$|[-_])/i;
  const isUploadPart = el => classTokens(el).some(token => UPLOAD_TOKEN.test(token));

  // 框收不收这个文件。accept 为空什么都收；写了扩展名、MIME 或 image/* 的按它。
  function accepts(accept, mime, name = "") {
    const tokens = String(accept || "").toLowerCase().split(",").map(token => token.trim()).filter(Boolean);
    if (!tokens.length) return true;
    const type = String(mime || "").toLowerCase();
    const lower = String(name || "").toLowerCase();
    const exts = MIME_EXTS[type] || [];
    return tokens.some(token => {
      if (token.endsWith("/*")) return type.startsWith(token.slice(0, -1));
      if (token.includes("/")) return token === type;
      const ext = token.startsWith(".") ? token : `.${token}`;
      return exts.includes(ext) || (Boolean(lower) && lower.endsWith(ext));
    });
  }
  // 这一类文件里至少有一种框收得下。
  function acceptsKind(accept, kind) {
    return (KIND_MIMES[kind] || []).some(mime => accepts(accept, mime));
  }

  // 一段文字说的是哪一类：明确不传的优先；只说中一类的就是它；说中几类的认不准。
  function kindOfText(text) {
    const value = squash(text);
    if (!value) return { kind: "", ambiguous: false };
    if (OTHER_WORDS.test(value)) return { kind: "other", ambiguous: false };
    const hits = Object.keys(KIND_WORDS).filter(kind => KIND_WORDS[kind].test(value)
      && !(kind === "photo" && NOT_ID_PHOTO.test(value)));
    if (NOT_ID_PHOTO.test(value) && !hits.length) return { kind: "other", ambiguous: false };
    if (hits.length === 1) return { kind: hits[0], ambiguous: false };
    return { kind: "", ambiguous: hits.length > 1 };
  }

  // 框要什么：先看表单项的题目，题目说不清再看上传区的按钮和提示。name、id 不单独决定。
  // 定下的类和 accept 收的文件类型对不上（只收图片的框不传简历），或照片墙、头像样式的框要的是简历，都算认不准。
  // 返回 { kind: resume | photo | transcript | other | unknown, reason }。
  function classify({ title = "", texts = [], accept = "", picture = false } = {}) {
    let found = kindOfText(title);
    if (!found.kind && !found.ambiguous) {
      for (const text of texts) {
        const next = kindOfText(text);
        if (next.ambiguous) { found = next; break; }
        if (!next.kind) continue;
        if (found.kind && found.kind !== next.kind) { found = { kind: "", ambiguous: true }; break; }
        found = next;
      }
    }
    if (found.ambiguous) return { kind: "unknown", reason: "ambiguous_kind" };
    if (!found.kind) return { kind: "unknown", reason: "unknown_kind" };
    if (found.kind === "other") return { kind: "other", reason: "other_kind" };
    if (!acceptsKind(accept, found.kind)) return { kind: "unknown", reason: "accept_mismatch" };
    if (picture && found.kind === "resume") return { kind: "unknown", reason: "style_mismatch" };
    return { kind: found.kind, reason: "" };
  }

  // 网站写的大小限制（「不超过 200KB」「小于2M」「10MB 以内」「max 2MB」），取最小的一个，单位字节；没写返回 null。
  // K、M 按 1024 算（组件库示例和多数网站的校验都这样写）。
  const SIZE = /(\d+(?:\.\d+)?)\s*(kb|k|mb|m|兆|gb|g)(?![a-z])/gi;
  const LIMIT_BEFORE = /(?:不超过|不大于|不得超过|不能超过|不可超过|小于|低于|最大|最多|上限|限制|限|大小|max(?:imum)?|less\s+than|up\s+to|≤|<=?)\s*[:：为是]?\s*$/i;
  const LIMIT_AFTER = /^\s*(?:以内|以下|之内|内|及以下|max)/i;
  function limitBytes(texts) {
    let best = null;
    for (const text of texts) {
      const value = String(text ?? "");
      for (const hit of value.matchAll(SIZE)) {
        const before = value.slice(Math.max(0, hit.index - 12), hit.index);
        const after = value.slice(hit.index + hit[0].length, hit.index + hit[0].length + 6);
        if (!LIMIT_BEFORE.test(before) && !LIMIT_AFTER.test(after)) continue;
        const unit = hit[2].toLowerCase();
        const bytes = Math.floor(Number(hit[1]) * (unit.startsWith("k") ? KB : unit.startsWith("g") ? 1024 * MB : MB));
        if (bytes > 0 && (best === null || bytes < best)) best = bytes;
      }
    }
    return best;
  }

  // --- 页面上的框 -------------------------------------------------------------

  const LIST_ITEM = "[class*='upload-list-item'], .el-upload-list__item, [class*='upload-list'] > li, [class*='file-item'], [class*='fileItem'], [class*='file-list'] > li, [class*='attachment-item']";
  const PICTURE = /picture-card|picture-circle|avatar|photo-wall|image-upload/i;
  const HINT_TOKEN = /(?:^|[-_])(?:tip|tips|hint|desc|description|extra|help|note|notice|explain)(?:$|[-_])/i;
  const FILE_NAME = /^[^\s:：，,、;；]{1,96}\.(?:pdf|docx?|jpe?g|png|zip|rar)$/i;

  // 上传组件的根：从 file 框往上，取最外一层带 upload 字样、只装着这一个 file 框、没有别的可见输入框的元素。
  // 认不出组件、框本身又看不见（自己写的「上传」按钮包着藏起来的 file 框）时，取往上最近一层看得见、只装着它的元素。
  function uploadRoot(input, isVisible) {
    let top = null;
    let node = input.parentElement;
    for (let depth = 0; node && depth < 6 && node.tagName !== "BODY" && node.tagName !== "FORM"; depth += 1, node = node.parentElement) {
      if (node.querySelectorAll("input[type='file' i]").length > 1) break;
      if (Array.from(node.querySelectorAll("input:not([type='file' i]):not([type='hidden' i]), select, textarea")).some(el => isVisible(el))) break;
      if (isUploadPart(node)) top = node;
    }
    if (top) return top;
    if (isVisible(input)) return input;
    node = input.parentElement;
    for (let depth = 0; node && depth < 3 && node.tagName !== "BODY" && node.tagName !== "FORM"; depth += 1, node = node.parentElement) {
      if (node.querySelectorAll("input[type='file' i]").length > 1) break;
      if (Array.from(node.querySelectorAll("input:not([type='file' i]):not([type='hidden' i]), select, textarea")).some(el => isVisible(el))) break;
      if (isVisible(node)) return node;
    }
    return null;
  }

  function visibleText(root, isVisible, skip = () => false) {
    const out = [];
    const walk = node => {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3) {
          const text = squash(child.data);
          if (text) out.push(text);
        } else if (child.nodeType === 1 && !["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "INPUT", "SELECT", "TEXTAREA"].includes(child.tagName)
          && !skip(child) && isVisible(child)) {
          walk(child);
        }
      }
    };
    if (root?.nodeType === 1) walk(root);
    return out;
  }

  // 表单项里的文件项：只取最外层的那个（ant-upload-list-item-name 这类在文件项里面的不算）。
  function listItems(scopeEl) {
    if (!scopeEl?.querySelectorAll) return [];
    const all = Array.from(scopeEl.querySelectorAll(LIST_ITEM));
    return all.filter(el => !all.some(other => other !== el && other.contains(el)));
  }
  function thumbnails(scopeEl) {
    if (!scopeEl?.querySelectorAll) return [];
    return Array.from(scopeEl.querySelectorAll("img")).filter(img => /^(?:blob:|data:image\/)/i.test(img.getAttribute("src") || ""));
  }

  // 页面上（顶层和同源框架各自调一次）的上传框。跳过：插件自己的侧栏（exclude）、禁用的、选目录的、看不见的。
  // describe(input, root, uploads) 由内容脚本给出题目和表单项（field-scan.js 的 uploadItem），没有就只有组件里的文字。
  function find(doc, { isVisible = () => true, exclude = () => false, describe = null } = {}) {
    let inputs = [];
    try {
      inputs = Array.from(doc.querySelectorAll("input[type='file' i]"));
    } catch {
      return [];
    }
    const uploads = inputs.filter(input => !exclude(input));
    const slots = [];
    for (const input of uploads) {
      if (input.disabled || input.hasAttribute("webkitdirectory") || input.hasAttribute("directory")) continue;
      const root = uploadRoot(input, isVisible);
      // 整个上传组件都看不见（折起来的分组、没切到的页签）：用户看不到，不传。
      if (!root || !isVisible(root)) continue;
      let described = null;
      try {
        described = describe ? describe(input, root, uploads) : null;
      } catch {
        described = null;
      }
      const item = described?.item && described.item.contains(root) ? described.item : root;
      // 表单项太大（整页只有这一个控件，表单项一直扩到 body）：只看组件附近。
      const scopeEl = item.tagName === "BODY" || squash(item.textContent).length > 3000 ? (root.parentElement || root) : item;
      const title = squash(described?.title || "");
      const inList = el => Boolean(el.matches?.(LIST_ITEM)) || Boolean(el.closest?.(LIST_ITEM));
      const rootTexts = root === input ? [] : visibleText(root, isVisible, inList);
      const hintTexts = Array.from(scopeEl.querySelectorAll?.("[class]") || [])
        .filter(el => !root.contains(el) && classTokens(el).some(token => HINT_TOKEN.test(token)) && isVisible(el))
        .map(el => squash(el.textContent)).filter(Boolean);
      const accept = String(input.getAttribute("accept") || "");
      const picture = [root, ...root.querySelectorAll?.("[class]") || []].some(el => PICTURE.test(classText(el)));
      const decided = classify({ title, texts: [...rootTexts, ...hintTexts], accept, picture });
      const siteLimit = limitBytes([title, ...rootTexts, ...hintTexts]);
      slots.push({
        input, root, scope: scopeEl, title, accept, picture,
        kind: decided.kind, reason: decided.reason,
        siteLimit, limit: siteLimit === null ? MAX_FILE_BYTES : Math.min(siteLimit, MAX_FILE_BYTES),
        language: Object.keys(LANGUAGE_WORDS).filter(key => LANGUAGE_WORDS[key].test(title)),
        hasFile: hasFile({ input, root, scope: scopeEl }, isVisible)
      });
    }
    return slots;
  }

  // 框里已经有文件：file 框自己带着文件，表单项里有文件项、网页传上去的缩略图，或单独一段文字就是文件名。
  function hasFile(slot, isVisible = () => true) {
    try {
      if (slot.input?.files?.length) return true;
    } catch { /* 读不到就看页面 */ }
    const scopeEl = slot.scope || slot.root;
    if (listItems(scopeEl).some(el => isVisible(el))) return true;
    if (thumbnails(scopeEl).some(el => isVisible(el))) return true;
    return visibleText(scopeEl, isVisible).some(text => FILE_NAME.test(text));
  }

  // 还是原来那个框：file 框还在、上传区还在，题目没变。
  function current(slot, describe = null, isVisible = () => true) {
    if (!slot?.input?.isConnected || !slot.root?.isConnected) return false;
    if (!describe) return true;
    try {
      const doc = slot.input.ownerDocument;
      const uploads = Array.from(doc.querySelectorAll("input[type='file' i]"));
      return squash(describe(slot.input, slot.root, uploads)?.title || "") === slot.title && isVisible(slot.root);
    } catch {
      return false;
    }
  }

  // --- 选文件 -----------------------------------------------------------------

  const language = file => Object.keys(LANGUAGE_WORDS).filter(key => LANGUAGE_WORDS[key].test(`${file.label || ""} ${file.name || ""}`));

  // 给一个框选桌面里的文件。files 是 resumeFiles.list 的行。只在这一类里选，框收得下、不超过上限；
  // 绑了模板的只给这些模板用。先用当前模板绑定的，没有用这一类的默认文件，这一类只有一个就用它；
  // 题目写了中文、英文的按文件说明和文件名对。都定不下来就不选（null），由用户在侧栏选，不替用户猜。
  // 返回 { fileId, reason }，reason 是没选的原因：no_file、too_large、not_accepted、choose。
  function chooseFile(slot, files, { templateId = "" } = {}) {
    if (!["resume", "photo", "transcript"].includes(slot.kind)) return { fileId: null, reason: slot.reason || "unknown_kind" };
    const usable = file => !Array.isArray(file.templateIds) || !file.templateIds.length || (templateId && file.templateIds.includes(templateId));
    const sameKind = (Array.isArray(files) ? files : []).filter(file => file?.kind === slot.kind && usable(file));
    if (!sameKind.length) return { fileId: null, reason: "no_file" };
    const fitting = sameKind.filter(file => accepts(slot.accept, file.mime, file.name));
    if (!fitting.length) return { fileId: null, reason: "not_accepted" };
    const small = fitting.filter(file => Number(file.byteSize) <= slot.limit);
    if (!small.length) return { fileId: null, reason: "too_large", byteSize: Math.min(...fitting.map(file => Number(file.byteSize))) };
    let pool = small;
    if (slot.language?.length === 1) {
      const spoken = pool.filter(file => language(file).includes(slot.language[0]));
      if (spoken.length) pool = spoken;
      else if (pool.some(file => language(file).length)) {
        // 题目要英文，手上的文件都标了别的语言：不传。
        const unmarked = pool.filter(file => !language(file).length);
        if (!unmarked.length) return { fileId: null, reason: "choose" };
        pool = unmarked;
      }
    }
    const bound = pool.filter(file => templateId && file.templateIds?.includes(templateId));
    if (bound.length === 1) return { fileId: bound[0].fileId, reason: "" };
    if (bound.length > 1) return { fileId: null, reason: "choose" };
    const defaults = pool.filter(file => file.isDefault);
    if (defaults.length === 1) return { fileId: defaults[0].fileId, reason: "" };
    if (pool.length === 1) return { fileId: pool[0].fileId, reason: "" };
    return { fileId: null, reason: "choose" };
  }

  // 这个文件能不能放进这个框：类型框收得下、不超过上限。用户手动给认不出的框选的文件也要过这一关。
  function fits(slot, file) {
    if (!file) return false;
    return accepts(slot.accept, file.mime, file.name) && Number(file.byteSize) > 0 && Number(file.byteSize) <= slot.limit;
  }

  // --- 交给框 ------------------------------------------------------------------

  // 把文件放进 file 框，再发 input、change：和用户在选文件窗口里选了它一样。不点按钮、不打开窗口。
  function put(slot, file) {
    const input = slot?.input;
    if (!input?.isConnected) return { ok: false, reason: "slot_gone" };
    const view = input.ownerDocument?.defaultView || scope;
    const Transfer = view.DataTransfer || scope.DataTransfer;
    if (typeof Transfer !== "function") return { ok: false, reason: "unsupported" };
    try {
      const transfer = new Transfer();
      transfer.items.add(file);
      input.files = transfer.files;
    } catch {
      return { ok: false, reason: "rejected" };
    }
    const EventType = view.Event || scope.Event;
    for (const type of ["input", "change"]) input.dispatchEvent(new EventType(type, { bubbles: true }));
    return { ok: true };
  }

  // --- 网站的反应 --------------------------------------------------------------

  const MESSAGE = ".ant-message-notice, [class*='message-notice'], .el-message, [class*='el-message'], .el-notification, [class*='notification-notice'], [role='alert'], [class*='toast']";
  const INLINE_ERROR = "[class*='error'], [class*='explain'], [class*='invalid']";
  const ERROR_WORDS = /失败|错误|出错|不支持|超过|超出|过大|太大|格式|不能|仅支持|只支持|只能|不符合|不正确|failed|error|too large|not supported|invalid/i;
  const DIALOG = "[role='dialog'], [role='alertdialog'], [aria-modal='true'], .ant-modal, .el-message-box, .el-dialog, [class*='modal-content'], [class*='dialog-content']";
  const BUTTON = "button, [role='button'], .ant-btn, .el-button";
  const BUSY = ".ant-spin-spinning, [class*='spin-spinning'], .el-loading-mask, [class*='loading-mask'], [aria-busy='true'], [role='progressbar'], [class*='upload-list-item-uploading'], .el-upload-list__item.is-uploading";
  const BUSY_WORDS = /(?:解析|识别|上传|处理|导入)中|正在(?:解析|识别|上传|处理|导入)|parsing|uploading/i;

  const outermost = list => list.filter(el => !list.some(other => other !== el && other.contains(el)));
  function visibleAll(docs, selector, isVisible) {
    const found = [];
    for (const doc of docs) {
      try {
        found.push(...Array.from(doc.querySelectorAll(selector)).filter(el => isVisible(el)));
      } catch { /* 读不了的文档跳过 */ }
    }
    return found;
  }
  // 网站弹出的对话框：只算里面有按钮的（解析中的遮罩没有按钮）。
  function dialogs(docs, isVisible) {
    return outermost(visibleAll(docs, DIALOG, isVisible))
      .filter(el => Array.from(el.querySelectorAll(BUTTON)).some(button => isVisible(button)));
  }

  // 传之前记下的样子：之后只看新冒出来的文件项、提示和对话框。
  function before(slot, docs, isVisible = () => true) {
    const scopeEl = slot.scope || slot.root;
    return {
      items: new Set(listItems(scopeEl)),
      thumbs: new Set(thumbnails(scopeEl)),
      messages: new Set(visibleAll(docs, MESSAGE, isVisible)),
      errors: new Set(Array.from(scopeEl?.querySelectorAll?.(INLINE_ERROR) || []).filter(el => isVisible(el) && squash(el.textContent))),
      dialogs: new Set(dialogs(docs, isVisible)),
      text: visibleText(scopeEl, isVisible).join(" ")
    };
  }

  // 对话框里的话：不带按钮上的字（antd 给两个字的按钮加了空格，「取 消」）。
  function dialogText(el, isVisible) {
    return squash(visibleText(el, isVisible, node => Boolean(node.matches?.(BUTTON))).join(" ")).slice(0, 120);
  }

  // 这个框这一刻的样子：done 网站显示传好了，error 网站报错（带网站原话），uploading 还在传，dialog 网站弹了对话框，none 还没看到。
  // withDialogs 为 false 时不看对话框，只看这个框自己（网站弹对话框时，简历本身传没传上）。
  function state(slot, name, seen, docs, isVisible = () => true, { withDialogs = true } = {}) {
    const scopeEl = slot.scope || slot.root;
    const text = el => squash(el.textContent).slice(0, 120);
    const fresh = listItems(scopeEl).filter(el => !seen.items.has(el) && isVisible(el));
    const named = listItems(scopeEl).filter(el => isVisible(el) && (squash(el.textContent).includes(name)
      || Array.from(el.querySelectorAll("[title], img[alt]")).some(node => (node.getAttribute("title") || node.getAttribute("alt")) === name)));
    const items = [...new Set([...named, ...fresh])];
    const status = el => {
      const classes = [el, ...el.querySelectorAll("[class]")].map(classText).join(" ").toLowerCase();
      if (/(?:^|[-_\s])(?:error|fail|failed)(?:$|[-_\s])|is-error/.test(classes)) return "error";
      if (/uploading|is-uploading/.test(classes) || Array.from(el.querySelectorAll("[role='progressbar'], [class*='progress']")).some(node => isVisible(node))) return "uploading";
      return "done";
    };
    const newDialog = withDialogs ? dialogs(docs, isVisible).find(el => !seen.dialogs.has(el)) : null;
    if (newDialog) return { state: "dialog", message: dialogText(newDialog, isVisible) };
    const alert = visibleAll(docs, MESSAGE, isVisible).find(el => !seen.messages.has(el) && ERROR_WORDS.test(el.textContent || ""));
    const inline = Array.from(scopeEl?.querySelectorAll?.(INLINE_ERROR) || [])
      .find(el => !seen.errors.has(el) && isVisible(el) && ERROR_WORDS.test(el.textContent || "") && !listItems(scopeEl).some(item => item.contains(el)));
    const failed = items.find(el => status(el) === "error");
    if (failed) return { state: "error", message: alert ? text(alert) : inline ? text(inline) : "" };
    if (alert) return { state: "error", message: text(alert) };
    if (inline) return { state: "error", message: text(inline) };
    if (items.some(el => status(el) === "uploading")) return { state: "uploading", message: "" };
    if (items.length) return { state: "done", message: "" };
    if (thumbnails(scopeEl).some(img => !seen.thumbs.has(img) && isVisible(img))) return { state: "done", message: "" };
    // 原生的 file 框（没有组件，框自己就是上传区）：框里就是这个文件，提交表单时才传，这就是它的全部状态。
    try {
      if (slot.root === slot.input && name && slot.input.files?.[0]?.name === name) return { state: "done", message: "" };
    } catch { /* 读不到就看页面 */ }
    // 别的写法：表单项里冒出了这个文件名。
    const now = visibleText(scopeEl, isVisible).join(" ");
    if (name && now.includes(name) && !seen.text.includes(name)) return { state: "done", message: "" };
    return { state: "none", message: "" };
  }

  // 网页在忙：转圈、加载遮罩、进度条、还在传的文件项，或看得见的「解析中」「正在上传」这类短句。
  function busy(docs, isVisible = () => true, exclude = () => false) {
    if (visibleAll(docs, BUSY, isVisible).some(el => !exclude(el))) return true;
    for (const doc of docs) {
      const root = doc.body;
      if (!root) continue;
      let walker;
      try {
        walker = doc.createTreeWalker(root, 4);
      } catch {
        continue;
      }
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const value = squash(node.data);
        if (!value || value.length > 30 || !BUSY_WORDS.test(value)) continue;
        const parent = node.parentElement;
        if (parent && !exclude(parent) && isVisible(parent)) return true;
      }
    }
    return false;
  }

  // 传之后等网站的反应，最多 timeoutMs。sleep、now 由调用方给（测试用假时钟）。stopped() 为真时立刻停。
  async function watch(slot, name, seen, docs, { isVisible = () => true, sleep, now, timeoutMs = 30000, stopped = () => false } = {}) {
    const start = now();
    let last = { state: "none", message: "" };
    for (;;) {
      last = state(slot, name, seen, docs, isVisible);
      if (["done", "error", "dialog"].includes(last.state)) return last;
      if (stopped()) return { state: "stopped", message: "" };
      if (now() - start >= timeoutMs) return { state: last.state === "uploading" ? "uploading" : "unconfirmed", message: "" };
      await sleep(200);
    }
  }

  // 传完简历后等网站解析完。read() 每 200ms 读一次：{ signature 表单的值, busy 网页在忙, dialog, upload 简历框的状态 }。
  // 三个条件都满足才算解析完：网页不忙、简历框不在传；表单值连续 quietMs 没变；至少等了 minMs。最短时间是保底，不提前结束：
  // 网站解析时不一定显示忙碌，忙碌标志消失以后解析结果也可能才写回来，等得不够就会把填好的又盖掉，那时填后核对已经做完了，发现不了。
  // 网站弹出对话框（「是否覆盖」这类）、简历没传上、到了上限都停下，由调用方说明情况；表单值变过时上限放宽到 extendMs。
  async function waitForParse(read, { sleep, now, minMs = 1000, quietMs = 1500, maxMs = 10000, extendMs = maxMs,
    stopped = () => false, onTick = () => {} } = {}) {
    const start = now();
    let signature = read().signature;
    let lastChange = start;
    let changed = false;
    for (;;) {
      await sleep(200);
      const at = now();
      const elapsed = at - start;
      onTick(elapsed);
      if (stopped()) return { status: "stopped", elapsed, changed };
      const seen = read();
      if (seen.dialog) return { status: "dialog", text: seen.dialog, elapsed, changed };
      if (seen.upload === "error") return { status: "upload_failed", elapsed, changed };
      if (seen.signature !== signature) {
        signature = seen.signature;
        lastChange = at;
        changed = true;
      }
      const busy = Boolean(seen.busy) || seen.upload === "uploading";
      if (busy) lastChange = at;
      if (!busy && at - lastChange >= quietMs && elapsed >= minMs) return { status: "done", elapsed, changed };
      if (elapsed >= (changed ? Math.max(maxMs, extendMs) : maxMs)) return { status: "timeout", elapsed, changed, busy };
    }
  }

  const api = {
    MAX_FILE_BYTES, KIND_NAMES, KIND_MIMES,
    accepts, acceptsKind, classify, limitBytes, find, hasFile, current, chooseFile, fits, put,
    before, state, busy, watch, waitForParse, dialogs
  };
  scope.ResumeProUploadSlots = api;
  try { if (typeof module === "object" && module && typeof module.exports === "object") module.exports = api; } catch { /* a page element or frame named "module" (#275) */ }
})(typeof self !== "undefined" ? self : globalThis);
