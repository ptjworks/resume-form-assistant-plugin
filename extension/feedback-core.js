// Classic script shared by content scripts/pages/worker and imported for side effects.
// Do not add ESM exports: content scripts and importScripts require classic syntax.
// Automatic reports never carry arbitrary exception messages or object serialization.
(function (root) {
  const TYPES = new Set(["Error", "TypeError", "ReferenceError", "SyntaxError", "RangeError", "URIError", "EvalError", "AggregateError"]);
  const FILES = /^(?:[a-z][a-z0-9-]*\.js|link\/(?:[a-z][a-z0-9-]*\/)*[a-z][a-z0-9-]*\.mjs)$/;
  // The field names the reports showed before #497. A manual report from someone who has not agreed to
  // notice 3 shows only these, as before (diagnostics({ legacy: true })).
  const LEGACY_LABELS = new Set(["姓名", "性别", "出生年月", "手机", "手机号", "邮箱", "学历", "学位", "学校", "专业", "毕业时间", "参加工作时间", "现居住地", "当前城市", "求职状态", "工作经历", "教育经历"]);
  // #497 What kind of field a report talks about, from its title: a fixed word, or `unknown`. This table is
  // for reports only. Local matching keeps its own (FIELD_SEMANTICS in ai-helpers.js); changing that one
  // changes what gets filled. The first entry whose keyword appears in the title wins, so the narrow ones
  // come first (紧急联系人电话 before 电话, 出生地 before 出生, 专业排名 before 专业). Keywords are compared
  // after foldKind(): NFKC, lower case, no spaces or punctuation.
  const FIELD_KINDS = [
    ["紧急联系人", ["紧急联系"]],
    ["家庭成员", ["家庭成员", "家庭主要成员", "父亲", "母亲", "配偶", "亲属", "家属", "监护人"]],
    ["拼音", ["拼音", "pinyin"]],
    ["邮箱", ["邮箱", "电子邮件", "email", "mail"]],
    ["其他联系方式", ["微信", "wechat", "qq"]],
    ["证件类型", ["证件类型", "证件种类", "idtype", "idcardtype"]],
    ["证件号码", ["身份证", "证件号", "护照号", "idnumber", "idcard", "idno"]],
    ["手机", ["手机", "电话", "联系方式", "mobile", "phone"]],
    ["性别", ["性别", "gender", "sex"]],
    ["籍贯户口", ["籍贯", "生源地", "户口", "户籍", "出生地", "hometown", "nativeplace", "hukou"]],
    ["出生日期", ["出生", "生日", "birth"]],
    ["民族", ["民族", "ethnic"]],
    ["政治面貌", ["政治面貌", "党派", "党员", "团员", "political"]],
    ["婚姻状况", ["婚姻", "婚否", "marital"]],
    ["身高体重", ["身高", "体重", "height", "weight"]],
    ["健康状况", ["健康", "疾病", "病史", "health"]],
    ["参加工作时间", ["参加工作", "首次工作", "工作年限", "工龄"]],
    ["毕业时间", ["毕业时间", "毕业日期", "毕业年份", "毕业年月", "预计毕业", "届别", "graduation"]],
    ["求职状态", ["求职状态", "在职状态", "工作状态", "目前状态", "当前状态"]],
    ["到岗时间", ["到岗", "入职时间", "可入职", "报到"]],
    ["期望", ["期望", "意向", "意愿", "expect"]],
    ["薪资", ["薪资", "薪酬", "工资", "年薪", "月薪", "salary"]],
    ["现居住地", ["现居", "居住地", "居住城市", "当前城市", "所在城市", "所在地", "现住址", "currentcity", "location"]],
    ["地址", ["地址", "住址", "address"]],
    ["国家地区", ["国籍", "国家", "地区", "country", "region"]],
    ["工作经历", ["工作经历", "工作经验", "任职经历", "workexperience"]],
    ["教育经历", ["教育经历", "教育背景", "学习经历", "educationbackground", "educationexperience"]],
    ["实习经历", ["实习", "internship"]],
    ["项目经历", ["项目", "project"]],
    ["外语", ["外语", "英语", "语种", "语言", "四六级", "cet", "toefl", "ielts", "雅思", "托福", "language"]],
    ["成绩排名", ["排名", "绩点", "gpa", "成绩"]],
    ["计算机", ["计算机", "computer"]],
    ["技能特长", ["技能", "特长", "skill"]],
    ["获奖", ["获奖", "奖项", "奖励", "荣誉", "award"]],
    ["证书", ["证书", "资格", "certificate"]],
    ["学校", ["学校", "院校", "大学", "学院", "高中", "school", "university", "college"]],
    ["专业", ["专业", "major"]],
    ["学历", ["学历", "培养层次", "教育程度", "degree"]],
    ["学位", ["学位"]],
    ["学习形式", ["学习形式", "学习方式", "培养方式", "全日制", "studymode"]],
    ["公司", ["公司", "单位", "雇主", "company", "employer"]],
    ["职位", ["职位", "职务", "岗位", "职称", "position"]],
    ["起止时间", ["开始时间", "结束时间", "起止", "起始", "入学时间", "在校时间", "时间", "日期", "date"]],
    ["描述", ["描述", "介绍", "评价", "说明", "内容", "职责", "业绩", "description"]],
    ["姓名", ["姓名", "名字", "曾用名", "realname", "name"]]
  ].map(([name, words]) => [name, words.map(word => foldKind(word))]);
  const KIND_NAMES = [...FIELD_KINDS.map(([name]) => name), "unknown"];
  function foldKind(text) {
    return String(text ?? "").normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
  }
  function fieldKind(label) {
    const text = foldKind(String(label ?? "").slice(0, 200));
    if (!text) return "unknown";
    return FIELD_KINDS.find(([, words]) => words.some(word => text.includes(word)))?.[0] || "unknown";
  }
  // Which kinds the resume has a value for: each field's name and its group's name (教育经历, 工作经历).
  function resumeKinds(fields) {
    const kinds = new Set();
    for (const field of Array.isArray(fields) ? fields : []) {
      if (!String(field?.value ?? "").trim()) continue;
      for (const text of [field.key, field.group]) {
        const kind = fieldKind(text);
        if (kind !== "unknown") kinds.add(kind);
      }
    }
    return kinds;
  }
  // #497 A report goes out when at least this many fields the AI saw and did not match are of a kind the
  // resume has (error_category ai_missed), even when everything else got filled.
  const AI_MISSED_MIN = 3;
  function redact(value, limit = 5000) {
    return String(value ?? "").slice(0, 40000).normalize("NFKC")
      .replace(/(?:[A-Za-z]:[\\/]Users[\\/]|\/(?:Users|home)\/)[^\s\\/]+/gi, "[用户目录]")
      .replace(/(?:(?:Bearer|Basic)\s+\S+|(?:sk|oc_sk|key|token)[-_][A-Za-z0-9_-]{8,})/gi, "[凭据]")
      .replace(/(?:^|\n)\s*(?:cookie|set-cookie|authorization)\s*:\s*[^\n]*/gi, "\n[敏感请求头]")
      .replace(/(?:eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{10,})/g, "[凭据]")
      .replace(/["']?(?:api[-_ ]?key|authorization|cookie|password|secret|(?:auth|access|refresh|id)[-_ ]?token|token|密码|姓名|联系人)["']?\s*[:=：]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\n;；,}]+)/gi, "[敏感信息]")
      .replace(/https?:\/\/[^\s<>"'）)]+/gi, "[网址]")
      .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[邮箱]")
      .replace(/\d(?:[\s().+_-]*\d){4,}[xX]?/g, "[数字]")
      .slice(0, limit);
  }
  function hostname(value) {
    try { const u = new URL(value); return /^https?:$/.test(u.protocol) ? u.hostname : ""; } catch { return ""; }
  }
  function os(ua = "") {
    const system = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "未知系统";
    const browser = /Edg\/(\d{1,3})/.exec(ua) || /Chrome\/(\d{1,3})/.exec(ua);
    return `${system}${browser ? ` / ${browser[0].startsWith("Edg") ? "Edge" : "Chrome"} ${browser[1]}` : ""}`;
  }
  function frames(stack, origin) {
    const found = [];
    for (const line of String(stack ?? "").slice(0, 40000).split("\n")) {
      const frame = /^\s*at (?:[^()\n]+ \()?([^\s()]+)\)?\s*$/.exec(line);
      if (!frame || !frame[1].startsWith(origin)) continue;
      const match = /^([^\s?#():]+):(\d{1,6}):(\d{1,6})$/.exec(frame[1].slice(origin.length));
      if (match && FILES.test(match[1])) found.push(`${match[1]}:${match[2]}:${match[3]}`);
      if (found.length === 20) break;
    }
    return found.join("\n");
  }
  // #497 A TypeError's message names the property it failed on in a fixed form: only that identifier is
  // kept for the public report (`reading 'style'` gives `style`), never the rest of the message.
  const PROPERTY = /^(?:[A-Za-z_$][A-Za-z0-9_$]{0,39}|\d{1,3})$/;
  function failedProperty(name, message) {
    if (name !== "TypeError" || typeof message !== "string") return "";
    const text = message.slice(0, 2000);
    const found = /\((?:reading|setting) '([^'\n]{1,40})'\)/.exec(text) || /^Cannot (?:read|set) property '([^'\n]{1,40})' of /.exec(text);
    return found && PROPERTY.test(found[1]) ? found[1] : "";
  }
  function exception(error, origin, source = "error", filename = "", line = 0, column = 0) {
    const name = TYPES.has(error?.name) ? error.name : "Error";
    let raw = typeof error?.stack === "string" ? error.stack : "";
    const header = typeof error?.message === "string" ? `${error.name || "Error"}: ${error.message}` : "";
    if (header && raw.startsWith(header)) raw = raw.slice(header.length);
    const stack = frames(raw || (filename ? `at ${filename}:${Number(line) || 0}:${Number(column) || 0}` : ""), origin);
    const property = failedProperty(name, error?.message);
    // The message itself goes only into the private layer (#497), as codeMessage() leaves it.
    const message = typeof error?.message === "string" && error.message ? codeMessage(error.message) : "";
    return { kind: "exception", name, source: source === "unhandledrejection" ? source : "error", stack,
      ...(property ? { property } : {}), ...(message ? { message } : {}) };
  }
  // #497 An exception's message for the private layer. Most exceptions happen where nothing knows the resume, so it
  // cannot be redacted against it: only the English wording the code produced is kept. Anything quoted that is not an
  // identifier, every run of non-ASCII text, and the numbers, addresses and credentials redact() catches are replaced.
  // A scan error inside a fill is redacted against the resume as well (content.js buildPrivateReport).
  const CONTENT = "〔内容〕";
  function codeMessage(text) {
    // Markers redact() or an earlier pass put in stay as they are, so the worker can run it again on what a page sent.
    const kept = String(text ?? "").slice(0, 2000).normalize("NFKC")
      .replace(/(['"`])([^\n]{0,200}?)\1/g, (match, quote, inner) => (PROPERTY.test(inner) ? match : `${quote}${CONTENT}${quote}`))
      .replace(/\[(?:用户目录|凭据|敏感请求头|敏感信息|网址|邮箱|数字)\]|〔内容〕|[^\x00-\x7f]+/g, part => (part.startsWith("[") || part === CONTENT ? part : CONTENT));
    return redact(kept, 500);
  }
  // --- fill_failed diagnostics v1 ----------------------------------------------------------
  // The content script builds the block with fillReport(); the worker re-parses it with
  // diagnostics() before sending. Every key has a closed value pattern, so field values,
  // page text, titles, full URLs and provider messages never cross the network boundary.
  // The worker writes the [来源] section (version, OS, install type, host) itself; a page cannot supply it.
  // [岗位] (#301) goes only into manual feedback, which the user previews; automatic reports drop it.
  // [AI未匹配] (#497): fields the AI saw and did not match, by kind, and which kinds the resume has.
  const SECTIONS = new Set(["页面", "填写", "字段漏斗", "页面结构", "错误", "匹配", "性能", "AI未匹配", "未填字段", "岗位"]);
  const LEGACY_CATEGORIES = ["no_fields_found", "page_not_supported", "iframe_same_origin", "iframe_cross_origin", "match_failed", "fill_rejected",
    "timeout", "service_error", "unknown", "none"];
  const CATEGORIES = [...LEGACY_CATEGORIES, "ai_missed"];
  const ERROR_CODES = ["none", "cancelled", "network", "format", "input_too_large", "no_context", "bad_response",
    "not_configured", "credential_unavailable", "auth", "rate_limited", "timeout", "http", "response_too_large",
    "secret_in_prompt", "not_installed", "not_paired", "never_paired", "incompatible", "unavailable",
    "secret_only", "no_resume_fields", "scan_exception"];
  // A failure of the AI service or the desktop link, not of matching this page.
  const SERVICE_CODES = new Set(["network", "format", "bad_response", "not_configured", "credential_unavailable", "auth",
    "rate_limited", "http", "response_too_large", "not_installed", "not_paired", "never_paired", "incompatible", "unavailable"]);
  // Setup states (#301): no desktop app, not paired, no AI model. Nothing was sent to an AI service and
  // the user is shown the fix at once, so they are not a failed request and never reported on their own.
  const SETUP_CODES = new Set(["not_installed", "not_paired", "never_paired", "not_configured"]);
  // Scan drops (#228) sit between `invisible` and `out_of_scope`: what field-scan.js skipped among visible inputs.
  // `scan_error` (#408): controls whose title or section could not be read, skipped one by one.
  const DROPS = ["type_hidden", "non_fillable", "disabled", "invisible", "popup_internal", "grouped", "page_chrome",
    "site_search", "outside_form", "no_label", "scan_error", "out_of_scope", "secret",
    "no_resume_mapping", "ai_unmatched", "open_question", "no_result", "not_sent", "changed_while_waiting", "not_written", "unconfirmed", "unsynced"];
  // Where each scanned field's title came from, and why a field was not offered for 我的信息 (#228).
  const LABEL_SOURCES = ["explicit", "item", "table", "sibling", "placeholder"];
  const OFFER_SKIPS = ["ambiguous", "entry"];
  // URL path segments are kept only when every word in them is a common route word, so
  // user names and slugs (/u/zhangsan, /people/john-doe) never leave as written.
  const ROUTE_WORDS = new Set(("apply applies application applications applicant resume resumes cv jianli toudi delivery deliver "
    + "job jobs position positions post posts campus social career careers recruit recruitment recruiting hire hiring zhaopin "
    + "xiaozhao shezhao intern interns internship graduate school candidate candidates talent talents portal user users account "
    + "accounts profile profiles personal info information basic base detail details education experience work project projects "
    + "skill skills family contact attachment attachments upload step steps form forms edit editor preview submit confirm success "
    + "result view list index home main center centre my me mine new create add update manage management page pages wizard "
    + "interview interviews assessment exam test online register signup sign up in login logout auth oauth sso enroll enrollment "
    + "baoming onboard onboarding entry m h5 mobile pc web wap app wx wechat mp en zh cn us api s p c u hr ats cms open public "
    + "static html htm shtml php jsp aspx asp do action").split(" "));
  // `generic`: custom selects the fill handled on its generic path (北森), which carry no library class.
  const LIBRARY_NAMES = ["antd", "element", "arco", "iview", "semi", "vant", "layui", "mui", "yui", "ui5", "generic", "other"];
  // How a fill was started (#301): the side panel's 一键填写, 深度分析本页, a 本站配方 run, AI 辅助新增条目.
  const ENTRIES = ["panel", "deep", "recipe", "assist", "other"];
  // What an unfilled select's popup showed: a list (by role) and whether it had any option, a calendar, or nothing opened at all.
  const LISTS = ["listbox", "tree", "menu", "component"];
  const OPENED = [...LISTS, "calendar", "none"];
  // The job-saving flow (#301, manual feedback only): where company and title came from, how it ended,
  // and the AI assist's codes beyond the fill's own.
  const JOB_SOURCES = ["structured", "site_rule", "page_title", "ai", "none"];
  const JOB_ENDS = ["open", "saved", "queued", "failed", "unknown", "cancelled", "navigated"];
  const JOB_CODES = ["ok", "no_fragments", "no_evidence", "location_no_evidence", "missing_title", "missing_company", "missing_both",
    "in_flight", "internal", "other"];
  // Where the desktop's AI request timed out (#299): connecting, waiting for the headers, or reading the body.
  const TIMEOUT_STAGES = ["connect", "first_byte", "body"];
  const FILL_REASONS = ["value_not_committed", "value_reverted", "element_disconnected", "validation_not_cleared", "framework_state_unsynced", "value_changed", "verification_timeout", "unsupported_control", "no_option_match", "options_not_rendered", "options_timeout", "ambiguous_option", "ambiguous_popup", "cascade_timeout", "cascade_parent_failed", "cascade_unsupported", "selection_not_committed", "control_disabled", "invalid_date", "range_incomplete", "too_long", "format_mismatch", "readonly_picker", "operation_failed", "cancelled", "id_type_mismatch", "ai_conflict", "too_many_items", "region_unavailable", "region_too_coarse", "region_level_missing"];
  // A text the page did not keep (#399 #405): what the box held after it lost focus (empty, what it held before
  // the fill, or something else; never the text itself), and whether a suggestion list or another popup came
  // up within a second of writing. The box's inputmode is part of its structure.
  const AFTER = ["empty", "previous", "other"];
  const OVERLAYS = ["list", "other", "none"];
  const INPUT_MODES = ["numeric", "decimal", "tel", "email", "url", "search", "text", "none"];
  // Every unfilled field counts under its reason code (#301), not only the ten listed; a code outside FILL_REASONS is `other`.
  const UNFILLED_REASONS = [...FILL_REASONS, "other"];
  const MAX_UNFILLED = 10;
  // The whole block. With [来源] an automatic report stays within the relay's 5000 characters; a manual report's description
  // can take room, and the worker then cuts the block at a line (link/feedback.mjs build()).
  const DIAGNOSTICS_CAP = 4300;
  const INT = /^(?:\d{1,9}|-)$/;
  const tally = names => new RegExp(`^(?:-|(?:${names.join("|")})=\\d{1,6}(?:,(?:${names.join("|")})=\\d{1,6})*)$`);
  const oneOf = (names, extra = "") => new RegExp(`^(?:${names.join("|")}${extra})$`);
  const VALUES = {
    url_path: /^\/(?:(?:[A-Za-z][A-Za-z0-9._-]{0,19}|:id)(?:\/(?:[A-Za-z][A-Za-z0-9._-]{0,19}|:id)){0,7}(?:\/:more)?)?$/,  // + safePath()
    page_type: /^(?:application_form|unknown|-)$/, page_type_reason: /^(?:url|title|edit_button|structure|none|-)$/,
    dom_ready_at_scan: /^(?:true|false|-)$/, scan_duration_ms: INT,
    entry: oneOf(ENTRIES, "|-"), page_focused: /^(?:true|false|-)$/,
    dom_inputs: INT, visible_fields: INT, candidates: INT, matched: INT, filled: INT, drop_reasons: tally(DROPS),
    label_sources: tally(LABEL_SOURCES), offer_skipped: tally(OFFER_SKIPS),
    dom_elements: INT, iframes_total: INT, iframes_cross_origin: INT, same_origin_iframe_inputs: INT,
    shadow_roots_with_inputs: INT, custom_controls: INT, custom_libraries: tally(LIBRARY_NAMES),
    readonly_or_disabled: INT, edit_buttons: INT,
    error_category: oneOf(CATEGORIES), first_failing_stage: /^(?:scan|match|fill|none)$/,
    error_code: oneOf(ERROR_CODES, "|http_\\d{3}|-"),
    local_matches: INT, ai_fields: INT, ai_called: /^(?:true|false|-)$/, ai_tier: /^(?:default|strong|-)$/, ai_matches: INT, ai_latency_ms: INT,
    ai_first_byte_ms: INT, ai_timeout_stage: oneOf(TIMEOUT_STAGES, "|-"),
    resume_fields: INT, resume_candidates: INT, prompt_bytes: INT,
    timings_ms: /^scan=(?:\d{1,9}|-),match=(?:\d{1,9}|-),fill=(?:\d{1,9}|-),total=(?:\d{1,9}|-)$/,
    reasons: tally(UNFILLED_REASONS), unlisted: INT,
    // #497 The AI's misses by field kind, the kinds among them the resume has, and how many fields that is.
    ai_missed: tally(KIND_NAMES), ai_missed_in_resume: new RegExp(`^(?:-|(?:${KIND_NAMES.join("|")})(?:,(?:${KIND_NAMES.join("|")}))*)$`),
    ai_missed_with_data: INT,
    // #497 A code error: its type, and for a TypeError the property it failed on (failedProperty).
    exception_type: oneOf([...TYPES]), error_property: PROPERTY,
    job_company_source: oneOf(JOB_SOURCES), job_title_source: oneOf(JOB_SOURCES),
    job_missing: /^(?:none|company|title|company,title)$/, job_ai_called: /^(?:true|false)$/,
    job_ai_code: oneOf([...ERROR_CODES, ...JOB_CODES], "|http_\\d{3}|-"), job_end: oneOf(JOB_ENDS)
  };
  const JOB_KEYS = /^job_/;
  // #497 What a control is and how its popup behaved. Kinds of control: native select, custom dropdown, cascader,
  // date, autocomplete, text, number, textarea, radio, checkbox. The component library's major version, as told
  // by its class names.
  const FORMS = ["select", "dropdown", "cascader", "date", "autocomplete", "text", "number", "textarea", "radio", "checkbox", "other"];
  const VERSIONS = ["antd3", "antd4", "antd5", "antd6", "element-ui", "element-plus"];
  const CONTROL_TOKEN = new RegExp("^(?:(?:input|textarea|select|button|div|span)(?:\\[(?:text|date|month|number|radio|checkbox|email|tel|search)\\])?"
    + "|role=(?:textbox|combobox|listbox|button|radio|checkbox)|popup=(?:listbox|dialog|true)|readonly"
    + `|(?:picker|lib)=(?:antd|element|arco|iview|semi|vant|layui|generic|mui|jiandaoyun|yui|ui5)|opened=(?:${OPENED.join("|")})|options=(?:0|1\\+)`
    + `|inputmode=(?:${INPUT_MODES.join("|")})|after=(?:${AFTER.join("|")})|overlay=(?:${OVERLAYS.join("|")})`
    + `|form=(?:${FORMS.join("|")})|(?:search|remote|multi|spinner)=(?:yes|no)|ver=(?:${VERSIONS.join("|")})|(?:open_ms|wait_ms)=\\d{1,6}`
    + `|reason=(?:${FILL_REASONS.join("|")}))$`);
  // What a manual report from someone who has not agreed to notice 3 leaves out (#497): everything added since.
  const NEW_SECTIONS = new Set(["AI未匹配"]);
  const NEW_KEYS = new Set(["ai_missed", "ai_missed_in_resume", "ai_missed_with_data", "exception_type", "error_property"]);
  const NEW_TOKEN = /^(?:form|search|remote|multi|spinner|ver|open_ms|wait_ms)=/;

  // A version word is kept only as a whole segment (/api/v2), and only once per path: several of
  // them, as in /apply/v13.v91.v23 or /apply/v13/v91/v23, could spell out any number.
  const VERSION = /^v\d{1,2}$/i;
  function routeSegment(text) {
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,19}$/.test(text)) return false;
    if (VERSION.test(text)) return true;
    return text.replace(/([a-z])([A-Z])/g, "$1 $2").split(/[\s._-]+/).filter(Boolean)
      .every(word => ROUTE_WORDS.has(word.toLowerCase()));
  }

  // Common route words survive; every other segment (names, ids, tokens, non-ASCII) becomes :id.
  function pathTemplate(pathname) {
    const segments = String(pathname ?? "").split("/").filter(Boolean);
    let version = false;
    const kept = segments.slice(0, 8).map(segment => {
      let text;
      try { text = decodeURIComponent(segment); } catch { return ":id"; }
      if (!routeSegment(text) || (VERSION.test(text) && version)) return ":id";
      if (VERSION.test(text)) version = true;
      return text;
    });
    return `/${kept.join("/")}${segments.length > 8 ? "/:more" : ""}`;
  }

  // The worker re-checks the vocabulary, not just the shape, of a path it is handed.
  function safePath(value) {
    const parts = value.split("/").filter(Boolean);
    return VALUES.url_path.test(value) && parts.every(part => part === ":id" || part === ":more" || routeSegment(part))
      && parts.filter(part => VERSION.test(part)).length <= 1;
  }

  // First-round codes that are not a failure: nothing to say, or fields skipped before any request.
  // A failed request replaces them, as ai-worker.js does between batches (SKIP_CODES there).
  const SKIP_CODES = new Set(["none", "no_context", "input_too_large"]);
  // The error code a report shows: the first round's, or a catch-up's (#301) when the first round had
  // none or the catch-up's request failed after a first round that did not.
  const shownCode = (first, later) => (later && (!first || first === "none" || (SKIP_CODES.has(first) && requestFailed(later))) ? later : first);

  // Why the fill failed and the first stage that failed. `none` means nothing failed.
  function fillCategory({ scanned, fieldCount, pageType, frames, failedStage, responded, errorCode, catchUpCode, matched, filledCount, unfilledCount, unconfirmedCount,
    aiMissedWithData }) {
    // #497 Enough fields the AI saw and left alone although the resume has their kind.
    const missed = positive(aiMissedWithData) >= AI_MISSED_MIN;
    if (!scanned) return { category: "unknown", stage: "scan" };
    if (fieldCount === 0) {
      // A form may sit in a frame even when nothing else on the page looks like one. Same-origin frames are
      // scanned (#400), so inputs found there yet no field mean the scan missed them; a cross-origin frame
      // stays out of reach. Inputs in a same-origin frame are the more specific clue.
      if (frames?.frameInputs > 0) return { category: "iframe_same_origin", stage: "scan" };
      if (frames?.crossOrigin > 0) return { category: "iframe_cross_origin", stage: "scan" };
      // A page that is not an application form has nothing to fix. When the probe is
      // missing we cannot tell, so the page is treated as a form that yielded no fields.
      return { category: pageType === "unknown" ? "page_not_supported" : "no_fields_found", stage: "scan" };
    }
    if (failedStage === "match") {
      if (!responded) return { category: "unknown", stage: "match" };
      if (errorCode === "timeout") return { category: "timeout", stage: "match" };
      if (SERVICE_CODES.has(errorCode) || /^http_\d{3}$/.test(errorCode ?? "")) return { category: "service_error", stage: "match" };
      return { category: "match_failed", stage: "match" };
    }
    // The AI request failed, for the first round or for a catch-up after a choice (#301 U1), and the
    // fill went on with what was matched locally: the request is the first failure, whatever followed.
    const code = shownCode(errorCode, catchUpCode);
    if (requestFailed(code) && !SETUP_CODES.has(code)) return { category: code === "timeout" ? "timeout" : "service_error", stage: "match" };
    if (failedStage) return { category: "unknown", stage: failedStage };
    if (!matched) return { category: missed ? "ai_missed" : "match_failed", stage: "match" };
    if (filledCount === 0 || unfilledCount > 0 || unconfirmedCount > 0) return { category: "fill_rejected", stage: "fill" };
    return missed ? { category: "ai_missed", stage: "match" } : { category: "none", stage: "none" };
  }

  function positive(value) { return Number.isInteger(value) && value > 0 ? value : 0; }
  // The worker's diagnostics when the AI request got an answer; content.js keeps {} otherwise.
  const answer = input => (input.diagnostics && Object.keys(input.diagnostics).length ? input.diagnostics : null);

  // The AI request itself failed (provider timeout, AI service or desktop link), as opposed to
  // a request that was answered and matched nothing.
  function requestFailed(code) {
    return code === "timeout" || SERVICE_CODES.has(code) || /^http_\d{3}$/.test(code ?? "");
  }

  // Fields lost at each step of scan → match → fill, in funnel order; only non-zero reasons.
  function fillDrops(input) {
    const s = input.stats || null;
    const d = answer(input);
    const n = positive;
    const secret = n(d?.secretFormFields);
    const noMapping = n(d?.skippedNoContext);
    // Fields that appeared after a choice (#269) bring their own drops, worked out with these
    // same rules for each catch-up request; the first-round arithmetic leaves them out.
    const g = input.grown || {};
    const firstRound = Math.max(0, n(input.fieldCount) - n(g.found));
    // Fields neither matched nor skipped. Those handed to the AI (at most aiFields, less the
    // ones skipped for lack of resume data) are AI misses, or got no result when the AI service
    // or desktop link failed; with an empty template the rest had no resume data at all;
    // otherwise they were never sent (e.g. too large). A request with no answer at all leaves
    // every field without a result.
    const failed = Boolean(d) && requestFailed(d.errorCode);
    // AI answers held back with a reason (aiBlocked, #429: a bad date, batches that disagree) are matches the page
    // reports as not written, like the local ones; they are not AI misses.
    const answered = n(d?.aiMatches) + n(d?.aiBlocked);
    const rest = d ? Math.max(0, firstRound - secret - n(d.ruleMatches) - noMapping - answered)
      : input.requested ? firstRound : 0;
    const sent = d && aiCalled(input) ? Math.min(rest, Math.max(0, n(d.aiFields) - noMapping - answered)) : 0;
    // Of those, open questions with no ready answer in the resume (#429): the AI no longer writes one, so they get their own reason.
    const open = Math.min(sent, n(d?.openUnanswered));
    const counts = {
      type_hidden: n(s?.typeHidden), non_fillable: n(s?.nonFillable), disabled: n(s?.disabled), invisible: n(s?.invisible),
      popup_internal: n(s?.popup), grouped: n(s?.grouped), page_chrome: n(s?.pageChrome), site_search: n(s?.siteSearch),
      outside_form: n(s?.outsideForm), no_label: n(s?.noLabel), scan_error: n(s?.scanError), out_of_scope: n(s?.outOfScope),
      secret, no_resume_mapping: noMapping,
      ai_unmatched: failed ? 0 : sent - open, open_question: failed ? 0 : open, no_result: d ? (failed ? sent : 0) : rest, not_sent: 0,
      // Matches left alone because the user or the page changed the field while the AI worked (#402).
      changed_while_waiting: n(input.keptCount),
      not_written: n(input.unfilledCount), unconfirmed: n(input.unconfirmedCount), unsynced: n(input.unsyncedCount)
    };
    if (d) counts[d.errorCode === "no_resume_fields" ? "no_resume_mapping" : "not_sent"] += rest - sent;
    for (const key of DROPS) counts[key] += n(g.drops?.[key]);
    return DROPS.filter(key => counts[key] > 0).map(key => [key, counts[key]]);
  }

  // Scanned fields by where their title came from (field-scan.js sources, folded into LABEL_SOURCES).
  function labelSources(stats) {
    const sources = stats?.sources || {};
    const n = key => positive(sources[key]);
    const counts = { explicit: n("explicit"), item: n("item") + n("item-text") + n("item-part"), table: n("table") + n("table-header"),
      sibling: n("sibling"), placeholder: n("placeholder") };
    return LABEL_SOURCES.filter(key => counts[key] > 0).map(key => [key, counts[key]]);
  }

  // Whether the AI was actually called: true / false, or null when the request got no answer.
  function aiCalled(input) {
    const d = answer(input);
    if (d) return positive(d.promptBytes) > 0;
    return input.requested ? null : false;
  }

  function fillReport(input) {
    const count = value => Number.isInteger(value) && value >= 0 ? String(value) : "-";
    const ms = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? String(Math.round(value)) : "-";
    const flag = value => typeof value === "boolean" ? String(value) : "-";
    const s = input.stats || null;
    const p = input.probe || null;
    const d = answer(input);
    const n = positive;
    const libraries = {};
    for (const [name, value] of Object.entries(p?.custom?.byLibrary || {})) {
      const key = LIBRARY_NAMES.includes(name) ? name : "other";
      libraries[key] = (libraries[key] || 0) + n(value);
    }
    // Custom selects the fill handled on its generic path that the page probe did not count (#301 北森).
    const generic = p?.custom ? n(input.genericCustom) : 0;
    // Their read-only inputs belong to the select, as for library controls in the probe.
    const locked = Number.isInteger(p?.locked) ? Math.max(0, p.locked - (p.custom ? n(input.genericLocked) : 0)) : null;
    if (generic) libraries.generic = (libraries.generic || 0) + generic;
    const listed = (entries, order) => order.filter(key => entries[key] > 0).map(key => `${key}=${entries[key]}`).join(",") || "-";
    // Fields that appeared after a choice (#269) add to the first round's match counts; their
    // error code shows as shownCode() says. A catch-up that called the AI counts
    // as a call even when the first round did not need one.
    const g = input.grown || {};
    const called = g.aiCalled === true ? true : aiCalled(input);
    const plus = (value, extra) => Number.isInteger(value) ? value + n(extra) : value;
    const code = shownCode(d?.errorCode, g.errorCode);
    // The tier the AI request actually ran on (#223): asked for and confirmed, asked for, or the
    // daily tier a request without one always uses. Catch-ups never ask for one.
    const tiers = ["default", "strong"];
    const tier = tiers.includes(d?.tierUsed) ? d.tierUsed : tiers.includes(d?.tierRequested) ? d.tierRequested : "default";
    const lines = [
      "[页面]",
      `url_path: ${pathTemplate(input.path)}`,
      `page_type: ${input.pageType?.type || "-"}`,
      `page_type_reason: ${input.pageType?.reason || "-"}`,
      `dom_ready_at_scan: ${flag(input.readyAtScan)}`,
      `scan_duration_ms: ${ms(input.scanMs)}`,
      "",
      // How this fill was started and whether the page had focus then (#301): some components
      // only open their popup for a page in front.
      "[填写]",
      `entry: ${ENTRIES.includes(input.entry) ? input.entry : "-"}`,
      `page_focused: ${flag(input.pageFocused)}`,
      "",
      "[字段漏斗]",
      `dom_inputs: ${count(s?.domInputs)}`,
      `visible_fields: ${count(s?.visible)}`,
      `candidates: ${count(input.fieldCount)}`,
      `matched: ${count(input.matched)}`,
      `filled: ${count(input.filledCount)}`,
      `drop_reasons: ${fillDrops(input).map(([key, value]) => `${key}=${value}`).join(",") || "-"}`,
      `label_sources: ${labelSources(s).map(([key, value]) => `${key}=${value}`).join(",") || "-"}`,
      `offer_skipped: ${listed(s?.offerSkipped || {}, OFFER_SKIPS)}`,
      "",
      "[页面结构]",
      `dom_elements: ${count(p?.elements)}`,
      `iframes_total: ${count(p?.frames?.total)}`,
      `iframes_cross_origin: ${count(p?.frames?.crossOrigin)}`,
      `same_origin_iframe_inputs: ${count(p?.frames?.frameInputs)}`,
      `shadow_roots_with_inputs: ${count(p?.shadowHosts)}`,
      `custom_controls: ${count(Number.isInteger(p?.custom?.total) ? p.custom.total + generic : null)}`,
      `custom_libraries: ${listed(libraries, LIBRARY_NAMES)}`,
      `readonly_or_disabled: ${count(locked)}`,
      `edit_buttons: ${count(p?.editButtons)}`,
      "",
      "[错误]",
      `error_category: ${input.category || "unknown"}`,
      `first_failing_stage: ${input.stage || "none"}`,
      `error_code: ${typeof code === "string" && VALUES.error_code.test(code) ? code : "-"}`,
      // #497 The scan's own error (#408): its type, and for a TypeError the property it failed on.
      ...(input.scanFault && TYPES.has(input.scanFault.name) ? [`exception_type: ${input.scanFault.name}`] : []),
      ...(PROPERTY.test(input.scanFault?.property ?? "") ? [`error_property: ${input.scanFault.property}`] : []),
      "",
      "[匹配]",
      `local_matches: ${count(plus(d?.ruleMatches, g.local))}`,
      `ai_fields: ${count(plus(d?.aiFields, g.aiFields))}`,
      `ai_called: ${flag(called)}`,
      `ai_tier: ${called ? tier : "-"}`,
      `ai_matches: ${count(plus(d?.aiMatches, g.aiMatches))}`,
      `ai_latency_ms: ${called ? ms(d.apiMs) : "-"}`,
      // From the desktop (#299): how long the provider took to send its headers, and where a timeout stopped.
      `ai_first_byte_ms: ${called ? count(d?.firstByteMs) : "-"}`,
      `ai_timeout_stage: ${called && TIMEOUT_STAGES.includes(d?.timeoutStage) ? d.timeoutStage : "-"}`,
      `resume_fields: ${count(d?.resumeFields)}`,
      `resume_candidates: ${count(d?.candidateFields)}`,
      `prompt_bytes: ${count(d?.promptBytes)}`,
      "",
      "[性能]",
      `timings_ms: scan=${ms(input.scanMs)},match=${ms(input.roundTripMs)},fill=${ms(input.fillMs)},total=${ms(input.totalMs)}`
    ];
    // #497 Fields the AI saw and did not match: how many of each kind, and which of those kinds the resume has.
    const missedFields = Array.isArray(input.aiMissed) ? input.aiMissed : [];
    if (missedFields.length) {
      const byKind = {};
      const inResume = new Set();
      let withData = 0;
      for (const item of missedFields) {
        const kind = KIND_NAMES.includes(item?.kind) ? item.kind : "unknown";
        byKind[kind] = (byKind[kind] || 0) + 1;
        if (item?.inResume === true && kind !== "unknown") { inResume.add(kind); withData += 1; }
      }
      lines.push("", "[AI未匹配]", `ai_missed: ${listed(byKind, KIND_NAMES)}`,
        `ai_missed_in_resume: ${KIND_NAMES.filter(kind => inResume.has(kind)).join(",") || "-"}`, `ai_missed_with_data: ${withData}`);
    }
    const unfilled = Array.isArray(input.unfilledControls) ? input.unfilledControls : [];
    if (unfilled.length) {
      const reasons = {};
      for (const item of unfilled) {
        const key = FILL_REASONS.includes(item?.reasonCode) ? item.reasonCode : "other";
        reasons[key] = (reasons[key] || 0) + 1;
      }
      // First in the section, so the 3500-character cap on the block cuts listed fields before it.
      lines.push("", "[未填字段]", `reasons: ${listed(reasons, UNFILLED_REASONS)}`);
      for (const item of unfilled.slice(0, MAX_UNFILLED)) {
        const c = item?.control || {};
        const tokens = [`${c.tag || "?"}${c.type ? `[${c.type}]` : ""}`];
        if (c.role) tokens.push(`role=${c.role}`);
        if (c.popup) tokens.push(`popup=${c.popup}`);
        if (c.readOnly) tokens.push("readonly");
        if (c.picker) tokens.push(`picker=${c.picker}`);
        if (c.library) tokens.push(`lib=${c.library}`);
        if (INPUT_MODES.includes(c.inputMode)) tokens.push(`inputmode=${c.inputMode}`);
        // The select's popup (#301): never opened, or opened, and whether its list had any option. Never how
        // many: a lower select's list is the one the page loaded for the upper choice made from the resume.
        const o = item?.observed || {};
        if (OPENED.includes(o.opened)) tokens.push(`opened=${o.opened}`);
        if (LISTS.includes(o.opened) && typeof o.hasOptions === "boolean") tokens.push(`options=${o.hasOptions ? "1+" : "0"}`);
        if (AFTER.includes(o.after)) tokens.push(`after=${o.after}`);
        if (OVERLAYS.includes(o.overlay)) tokens.push(`overlay=${o.overlay}`);
        // #497 What the control is, and how long its popup took: from opening it to the popup, and in all;
        // whether a loading icon was still showing when the plugin gave up.
        const f = item?.form || {};
        const yes = value => (value ? "yes" : "no");
        const wait = value => (Number.isInteger(value) && value >= 0 ? Math.min(value, 999999) : null);
        if (FORMS.includes(f.form)) tokens.push(`form=${f.form}`);
        for (const key of ["search", "remote", "multi"]) if (typeof f[key] === "boolean") tokens.push(`${key}=${yes(f[key])}`);
        if (VERSIONS.includes(f.version)) tokens.push(`ver=${f.version}`);
        if (wait(f.openMs) !== null) tokens.push(`open_ms=${wait(f.openMs)}`);
        if (wait(f.waitMs) !== null) tokens.push(`wait_ms=${wait(f.waitMs)}`);
        if (typeof f.spinner === "boolean") tokens.push(`spinner=${yes(f.spinner)}`);
        if (item?.reasonCode) tokens.push(`reason=${item.reasonCode}`);
        // The field's kind, never its title (#497): the title can be anything the page wrote.
        lines.push(`- ${KIND_NAMES.includes(item?.kind) ? item.kind : fieldKind(item?.label)}: ${tokens.join(" ")}`);
      }
      if (unfilled.length > MAX_UNFILLED) lines.push(`unlisted: ${unfilled.length - MAX_UNFILLED}`);
    }
    return diagnostics(lines.join("\n"));
  }

  // Keep only v1 lines whose key and value are both in the closed vocabulary. The job flow's
  // [岗位] (#301) stays only in manual feedback, which the user previews before sending.
  // `legacy` (#497): a manual report from someone who has not agreed to notice 3 keeps to what reports carried
  // before it: none of the sections, keys and control words added since, and only the old field names.
  function diagnostics(value, { manual = false, legacy = false } = {}) {
    const safe = [];
    let skipping = false;
    for (const line of String(value ?? "").slice(0, 20000).split("\n").slice(0, 120)) {
      const section = /^\[(.{1,8})\]$/.exec(line);
      if (section) {
        skipping = !SECTIONS.has(section[1]) || (!manual && section[1] === "岗位") || (legacy && NEW_SECTIONS.has(section[1]));
        if (!skipping) safe.push(...(safe.length ? ["", line] : [line]));
        continue;
      }
      if (skipping) continue;
      // Every value has its own closed pattern; the length cap only bounds the regex work.
      // The longest reachable value is reasons with every code at six digits (773 chars).
      const entry = /^([a-z_]{1,32}): (.{1,800})$/.exec(line);
      if (entry) {
        const known = Object.prototype.hasOwnProperty.call(VALUES, entry[1]) && VALUES[entry[1]].test(entry[2])
          && (manual || !JOB_KEYS.test(entry[1])) && !(legacy && NEW_KEYS.has(entry[1]));
        // A category added since (ai_missed) reads as `unknown` in the old vocabulary, so [错误] keeps its category.
        if (known && legacy && entry[1] === "error_category" && !LEGACY_CATEGORIES.includes(entry[2])) safe.push("error_category: unknown");
        else if (known && (entry[1] !== "url_path" || safePath(entry[2]))) safe.push(line);
        continue;
      }
      const control = /^- (.{1,40}): (.{1,400})$/.exec(line);
      if (!control) continue;
      const tokens = control[2].split(" ").filter(token => CONTROL_TOKEN.test(token) && !(legacy && NEW_TOKEN.test(token)));
      const label = legacy ? (LEGACY_LABELS.has(control[1]) ? control[1] : "（字段名已隐藏）")
        : KIND_NAMES.includes(control[1]) ? control[1] : "unknown";
      safe.push(`- ${label}: ${tokens.join(" ") || "?"}`);
    }
    return safe.join("\n").slice(0, DIAGNOSTICS_CAP);
  }

  function fillFailure({ assisted, cancelled, overwriteDeclined, fieldCount, filledCount, unfilledCount, unconfirmedCount, editHint, category,
    errorCode, catchUpCode }) {
    if (assisted || cancelled || overwriteDeclined) return null;
    // A page that is not an application form has nothing to fix; reporting it is noise.
    if (category === "page_not_supported") return null;
    // The AI request failed (#301 U1; fillCategory): reported even when every local match got written.
    // A setup state is not a failed request.
    const aiFailed = (category === "timeout" || category === "service_error") && !SETUP_CODES.has(shownCode(errorCode, catchUpCode));
    // #497 Fields of kinds the resume has that the AI left alone (fillCategory): reported even when the rest got filled.
    const aiMissed = category === "ai_missed";
    if (fieldCount === 0 || unfilledCount > 0 || unconfirmedCount > 0 || editHint || aiFailed || aiMissed) return filledCount > 0 ? "fill_partial" : "fill_failed";
    return null;
  }

  // --- private layer (#497) ----------------------------------------------------------------
  // Kept only in our relay, never in a GitHub issue. Titles, group titles, option lists and the page outline
  // near the failing fields, all redacted in the page before they get here (page-outline.js createRedactor);
  // never a value, never which option the plugin wanted. Same layout as the public block: [section], key: value.
  const PRIVATE_HEADER = "--- 私有诊断 v1 ---";
  const PRIVATE_BYTES = 16384;
  const MAX_PRIVATE_FIELDS = 15;
  const MAX_PRIVATE_OPTIONS = 20;
  const MAX_OUTLINE_CHARS = 2500;
  const oneLine = (text, max) => {
    const chars = Array.from(String(text ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim());
    return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
  };
  // UTF-8 sizes counted by code point (a lone surrogate is written as U+FFFD, 3 bytes); no TextEncoder needed.
  const charBytes = char => { const code = char.codePointAt(0); return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4; };
  function utf8Length(text) {
    let size = 0;
    for (const char of String(text)) size += charBytes(char);
    return size;
  }
  // Cut at a character boundary so the UTF-8 form stays within `bytes`.
  function utf8Cut(text, bytes) {
    if (utf8Length(text) <= bytes) return text;
    let out = "";
    let used = 0;
    for (const char of text) {
      const size = charBytes(char);
      if (used + size > bytes) break;
      out += char; used += size;
    }
    return out;
  }
  function privateField(title, item) {
    const lines = [`[${title}]`, `label: ${oneLine(item?.label, 80) || "-"}`, `section: ${oneLine(item?.section, 40) || "-"}`,
      `kind: ${KIND_NAMES.includes(item?.kind) ? item.kind : "unknown"}`];
    if (typeof item?.reasonCode === "string" && FILL_REASONS.includes(item.reasonCode)) lines.push(`reason: ${item.reasonCode}`);
    if (typeof item?.inResume === "boolean") lines.push(`in_resume: ${item.inResume ? "yes" : "no"}`);
    // In page order, cut after MAX_PRIVATE_OPTIONS; never which one the plugin wanted, and not how many there were
    // (a lower select's list is the one loaded for the upper choice).
    const options = Array.isArray(item?.options) ? item.options.map(text => oneLine(text, 20)).filter(Boolean) : [];
    if (options.length) {
      const cut = options.length > MAX_PRIVATE_OPTIONS || (Number.isInteger(item.optionTotal) && item.optionTotal > MAX_PRIVATE_OPTIONS);
      lines.push(`options: ${options.slice(0, MAX_PRIVATE_OPTIONS).join(" | ")}${cut ? " | …" : ""}`);
    }
    return lines.join("\n");
  }
  // { unfilled: [...], missed: [...], outline: "", exception: { name, message } } → the private layer, or "".
  // Room for the field blocks; the outline gets what they leave, the error message goes first.
  const PRIVATE_FIELD_BYTES = 10000;
  function privateReport({ unfilled = [], missed = [], outline = "", exception: fault = null } = {}) {
    const bytes = utf8Length;
    const blocks = [];
    if (fault && typeof fault.message === "string" && fault.message) {
      blocks.push(["[异常]", `type: ${TYPES.has(fault.name) ? fault.name : "Error"}`, `message: ${oneLine(fault.message, 500)}`].join("\n"));
    }
    let room = PRIVATE_FIELD_BYTES;
    const fields = [
      ...(Array.isArray(unfilled) ? unfilled : []).slice(0, MAX_PRIVATE_FIELDS).map((item, at) => privateField(`未填字段 ${at + 1}`, item)),
      ...(Array.isArray(missed) ? missed : []).slice(0, MAX_PRIVATE_FIELDS).map((item, at) => privateField(`AI未匹配 ${at + 1}`, item))
    ];
    for (const block of fields) {
      const size = bytes(block) + 2;
      if (size > room) break;
      blocks.push(block); room -= size;
    }
    const page = String(outline ?? "").split("\n").map(line => line.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, 200))
      .join("\n").slice(0, MAX_OUTLINE_CHARS).trim();
    if (page) {
      const used = bytes(`${PRIVATE_HEADER}\n${blocks.join("\n\n")}\n\n[页面大纲]\n`);
      const kept = utf8Cut(page, Math.max(0, PRIVATE_BYTES - used));
      // Whole lines only.
      const whole = kept.length < page.length ? kept.slice(0, Math.max(0, kept.lastIndexOf("\n"))).trim() : kept;
      if (whole) blocks.push(`[页面大纲]\n${whole}`);
    }
    return blocks.length ? utf8Cut(`${PRIVATE_HEADER}\n${blocks.join("\n\n")}`, PRIVATE_BYTES) : "";
  }
  // The worker's check before sending: one string, redacted again with the description's rules, its own
  // header first, within 16384 bytes of UTF-8. Anything else is dropped.
  function privateLayer(value) {
    if (typeof value !== "string") return "";
    let body = value.slice(0, 40000).replace(/\r\n?/g, "\n");
    // Whatever header a page put first (any version) goes; the worker writes its own.
    body = body.replace(/^--- 私有诊断 v[^\n]{0,20} ---(?:\n|$)/, "");
    body = redact(body, 30000).trim();
    return body ? utf8Cut(`${PRIVATE_HEADER}\n${body}`, PRIVATE_BYTES) : "";
  }

  // The [岗位] block for manual feedback (#301): closed words only, never the company, the title,
  // page text or an address. `trace` is what content.js kept about the last 保存岗位到桌面端 in this tab.
  function jobReport(trace) {
    if (!trace || typeof trace !== "object") return "";
    const word = (value, list, fallback) => (list.includes(value) ? value : fallback);
    const code = typeof trace.aiCode === "string" && trace.aiCode !== "-" && VALUES.job_ai_code.test(trace.aiCode) ? trace.aiCode : "other";
    const lines = [
      "[岗位]",
      `job_company_source: ${word(trace.companySource, JOB_SOURCES, "none")}`,
      `job_title_source: ${word(trace.titleSource, JOB_SOURCES, "none")}`,
      `job_missing: ${[trace.missingCompany === true && "company", trace.missingTitle === true && "title"].filter(Boolean).join(",") || "none"}`,
      `job_ai_called: ${trace.aiCalled === true}`,
      `job_ai_code: ${trace.aiCalled === true ? code : "-"}`,
      `job_end: ${word(trace.end, JOB_ENDS, "open")}`
    ];
    return diagnostics(lines.join("\n"), { manual: true });
  }
  function install(send, { origin, requireOwn = false, captureErrors = true } = {}) {
    if (!root.addEventListener) return;
    const forward = data => {
      if (requireOwn && !data.stack) return;
      try { Promise.resolve(send(data)).catch(() => {}); } catch { /* no recursive reporting */ }
    };
    if (captureErrors) root.addEventListener("error", e => {
      if (requireOwn && (e.isTrusted !== true || !(e.error instanceof Error) || typeof e.error.stack !== "string" || !String(e.filename || "").startsWith(origin))) return;
      forward(exception(e.error, origin, "error", requireOwn ? "" : e.filename, e.lineno, e.colno));
    });
    root.addEventListener("unhandledrejection", e => {
      if (requireOwn && (e.isTrusted !== true || !(e.reason instanceof Error) || typeof e.reason.stack !== "string")) return;
      forward(exception(e.reason, origin, "unhandledrejection"));
    });
  }
  const api = { redact, hostname, os, frames, exception, pathTemplate, fillCategory, requestFailed, shownCode, fillDrops, labelSources, aiCalled,
    fillReport, diagnostics, fillFailure, jobReport, install, fieldKind, resumeKinds, privateReport, privateLayer, utf8Cut, utf8Length, codeMessage,
    AI_MISSED_MIN, PRIVATE_HEADER, PRIVATE_BYTES,
    // Names only, for the privacy-policy check; the allowlists themselves stay private.
    SECTION_NAMES: Object.freeze([...SECTIONS]), VALUE_KEYS: Object.freeze(Object.keys(VALUES)), KIND_NAMES: Object.freeze([...KIND_NAMES]) };
  root.ResumeProFeedback = api;
  try { if (typeof module === "object" && module && typeof module.exports === "object") module.exports = api; } catch { /* a page element or frame named "module" (#275) */ }
})(typeof self !== "undefined" ? self : globalThis);
