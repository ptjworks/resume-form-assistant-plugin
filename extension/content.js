(function () {
  // Runs once per page, even if this script runs twice in the same world: a second run would add
  // a second message listener and second error handlers. The mark is a symbol on this world's
  // global, so no element on the page can stand in for it.
  const loaded = Symbol.for("resumePro.content");
  if (self[loaded]) return;
  self[loaded] = true;
  const sendFeedback = report => chrome.runtime.sendMessage({ type: "FEEDBACK_AUTO", report });
  self.ResumeProFeedback?.install(sendFeedback, { origin: chrome.runtime.getURL(""), requireOwn: true });
  const SIDEBAR_ID = "resume-pro-sidebar";
  const SIDEBAR_PANEL_ID = "resume-pro-sidebar-panel";
  const SIDEBAR_DEFAULT_TOP = 96;
  const SIDEBAR_DEFAULT_RIGHT = 24;
  const FIELD_HIGHLIGHT_CLASS = "resume-pro__field-highlight";
  const FIELD_HIGHLIGHT_STYLE_ID = "resume-pro-field-highlight-styles";
  const FIELD_HIGHLIGHT_STYLE_TEXT = `
.${FIELD_HIGHLIGHT_CLASS} {
  animation: resume-pro-field-highlight 2.6s ease-out forwards !important;
  outline: 2px solid rgba(34, 197, 94, 0.95) !important;
  outline-offset: 2px !important;
  box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.14), 0 0 12px rgba(34, 197, 94, 0.5) !important;
  background-color: rgba(34, 197, 94, 0.1) !important;
}

@keyframes resume-pro-field-highlight {
  0% {
    outline-color: rgba(34, 197, 94, 0.95);
    box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.14), 0 0 12px rgba(34, 197, 94, 0.5);
    background-color: rgba(34, 197, 94, 0.1);
  }

  70% {
    outline-color: rgba(34, 197, 94, 0.8);
    box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.09), 0 0 8px rgba(34, 197, 94, 0.28);
    background-color: rgba(34, 197, 94, 0.06);
  }

  100% {
    outline-color: rgba(34, 197, 94, 0);
    box-shadow: 0 0 0 0 rgba(34, 197, 94, 0);
    background-color: transparent;
  }
}
  `;
  const fieldHighlightTimers = new WeakMap();
  const chipSelectionIdsByTarget = new WeakMap();
  const chipWriteTargets = new WeakSet();
  // 每个网页目标最后一次有效的光标/选区。点原生侧栏会让网页失焦，所以不能等到
  // 收到侧栏操作时才去读 selection。只放在页面内存里，按元素保存，不跨文本框复用。
  const savedTextSelections = new WeakMap();
  // 侧栏最近一次来问过目标状态的时间。只有侧栏在线时，才把「目标变了」通知过去。
  let panelQueriedAt = 0;
  let panelNotifyTimer = null;
  const PANEL_ONLINE_MS = 5000;
  // 等 AI 多久后给提示（#402，原来是 90 秒）。
  const WAIT_HINT_SECONDS = 30;
  const textFillFailures = new WeakMap();
  // #429 超出字数上限没填的框：当时的上限，没填上的原因里写明（见 prepareTextValue、limitText）。
  const textLimits = new WeakMap();
  // 给页面自己的校验留一点时间。短到不拖慢整表，长过常见的几十毫秒回滚。
  let textCommitWaitMs = 100;
  // #173：本次一键填写成功的文本框，只放在当前网页的内存里，不写 storage。
  let fillSession = null;
  let submitGesture = null;
  let submitSyncBound = false;
  let submitSyncBusy = false;
  // 网站校验通常在点击后几十毫秒内出结果，多等一拍再检查有没有仍标红的字段。
  let submitCheckDelayMs = 500;
  const SUBMIT_GESTURE_DEDUPE_MS = 1500;
  const TEXT_FILL_FAILURE_LABELS = {
    value_not_committed: "值没有写上",
    value_reverted: "值被页面退回",
    element_disconnected: "字段已被页面替换",
    validation_not_cleared: "页面仍提示无效",
    framework_state_unsynced: "页面表单状态未同步",
    value_changed: "字段内容已变化",
    verification_timeout: "尚未确认页面已接受",
    unsupported_control: "控件暂不支持",
    no_option_match: "没有匹配的选项",
    selection_not_committed: "选项选择未提交",
    options_not_rendered: "没有发现选项",
    options_timeout: "等待选项更新超时",
    ambiguous_option: "选项存在歧义",
    ambiguous_popup: "无法确定控件弹层",
    cascade_timeout: "等待下一级选项超时",
    cascade_parent_failed: "上一级选择失败",
    cascade_unsupported: "两级选择暂不支持",
    control_disabled: "字段不可操作",
    invalid_date: "日期格式或范围不符",
    ai_conflict: "AI 对同一题给了不同的值",
    too_many_items: "AI 给的资料项太多",
    region_unavailable: "地区数据没加载",
    region_too_coarse: "地址只认出了省",
    region_level_missing: "资料里没有这一级地区",
    too_long: "超出字数上限",
    range_incomplete: "起止日期缺一头",
    format_mismatch: "只能填数字",
    readonly_picker: "网页自己的选择框",
    operation_failed: "控件操作失败",
    cancelled: "填写已停止",
    // #429 本地规则特意不填的（ai-helpers.js 的 blocked）。
    id_type_mismatch: "和证件号码对不上"
  };
  let shadowRoot = null;
  // idle → running → ready or failed; unsupported on a page that cannot hold the controller.
  // The side panel counts the page as connected only once startup is ready.
  let startupState = "idle";
  // The host this startup built, so a startup that fails after building it can hide it.
  let startupHost = null;
  // Desktop data this page cannot read fails again on every read; it is reported once per page.
  let unreadableReported = false;
  // 最近一次填写的 v1 诊断块（#215）：手动反馈附上的是它，不是侧栏那段给人看的文字。
  let lastFillReport = "";
  // #497 最近一次填写的私有诊断：题目原文、分组、选项列表和出错字段附近的页面大纲（都已脱敏），
  // 只发到我们的中转，不进公开报告。手动反馈预览时一起显示。{ input, text }：text 用到时才拼（privateText）。
  let lastPrivate = null;
  // #497 有没有同意自动错误报告（后台存的 feedbackStateV1，只读）：没同意时后台不发，填完也就不做私有诊断。
  // 页面打开时读一次，每次一键填写开始时再读一次（填完之前早就读到了）。读不到当没同意。
  let feedbackAgreed = false;
  function readFeedbackAgreed() {
    try {
      Promise.resolve(chrome.storage?.local?.get?.("feedbackStateV1"))
        // 后台只认当前版本的同意（link/feedback.mjs 的 CONSENT_VERSION，现在是 3）；读失败当没同意。
        .then(found => { feedbackAgreed = found?.feedbackStateV1?.consent === true && found.feedbackStateV1.consentVersion >= 3; },
          () => { feedbackAgreed = false; });
    } catch {
      feedbackAgreed = false;
    }
  }
  readFeedbackAgreed();
  // 侧栏的「一键填写」正在点页面里的填写按钮（#301 诊断记录填写从哪里开始）：只在 click() 同步派发期间为真。
  let panelFillStarting = false;
  // 最近一次「保存岗位到桌面端」的过程（#301），只给手动反馈的 [岗位]：只有固定的词，不记公司、岗位、网页文字或网址。
  // 单独的变量：idlePanelJob、idlePanelSubmit 会把 panelJob、panelSubmit 整个换掉。「确认已投递」核对出的那一份
  // 只在它转去保存岗位时接着用。
  let jobTrace = null;
  let submitJobTrace = null;
  // Archiving a finished fill from the native side panel (#178). Declared up here because the
  // side panel's status message can arrive before the rest of this script has run.
  let panelFill = null;
  // #429 第 4 项：一键填写时上传文件（见 prepareUpload、runUpload）。也放在这里：侧栏的状态消息要读它。
  const UPLOAD_PENDING_MS = 10 * 60 * 1000;
  const UPLOAD_WATCH_MS = 30000;
  const upload = {
    // idle、offer（侧栏等用户确认）、running、done（结果留在侧栏）
    phase: "idle",
    version: 0,
    epoch: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    href: "",
    // [{ slot, fileId, reason, byteSize? }]：每个上传框给的文件编号（后台按桌面里的文件挑的）或不传的原因。
    // 页面这边没有文件名、标签这些，文件列表只给侧栏的卡片；上传结束后只留原因。
    plan: [],
    platform: null,
    // 卡片上先说会改回哪些：{ count, labels, pending }
    preview: null,
    // 上次解析被打断时记下的值：{ href, records, at, stopValues }；pendingNotes 是其中改不回的，写进这一次的结果。
    // stopValues 里用户等解析时动过的框记成 UPLOAD_EDITED，认不准的记成 UPLOAD_UNSURE：这两种都不改回。
    pending: null,
    pendingNotes: [],
    // upload、fill：正在上传还是正在填写（侧栏的停止按哪一边算）
    step: "",
    stop: false,
    result: null,
    report: null,
    // 没出卡片时的诊断（report）还没写进这次填写的诊断：下一次侧栏开始的填写带上它。
    reportForFill: false,
    // 后台对「每个框放哪份文件」的回答（PLAN 的 status），诊断用。
    planStatus: "none"
  };
  // 网站解析填上的框：控件 → 解析后的值。照常填写时它们不算用户已有的内容，有资料就填，不问要不要覆盖。
  let uploadParsed = new WeakMap();
  let uploadClock = {
    now: () => performance.now(),
    sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
    // 用户自己的输入（浏览器发的事件）；网站和插件写值发的事件不算。
    trusted: (event) => event.isTrusted === true
  };
  const UPLOAD_EDITED = "\u0000edited";
  const UPLOAD_UNSURE = "\u0000unsure";
  // 一键填写能不能先传简历（侧栏提示用）：页面上空着的简历框要什么，问后台桌面里有没有放得进的。
  // 同样的框一分钟问一次。key 是这些框的要求和当前模板。
  let uploadHintSeen = { key: "", at: -Infinity, asking: false, value: null };
  // 每问一次（包括点一键填写时问到的）加一：回答回来时已经有更新的回答，这一个就过期了，丢掉。
  let uploadHintSeq = 0;
  const state = {
    dragOffsetX: 0,
    dragOffsetY: 0,
    dragging: false,
    sidebarUiState: null,
    currentStore: null,
    desktopMode: "unavailable",
    aiBusy: false,
    suggestedView: null,
    statusTimer: null,
    lastFocusedField: null,
    chipAction: null,
    nativeSidePanel: false,
    // 「加到我的信息」（#189）：候选连着网页上的控件，只在本页内存里；值每次都现读。
    profileOfferCandidates: [],
    profileOfferVersion: 0,
    profileOfferEpoch: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    profileOfferResult: null,
    profileResultCandidateSignature: "",
    profileDismissedCandidateSignature: null,
    profileSaving: false,
    // #429：这个网站记住的回答，{ site, answers } 或读不到时的 { status }；null 是这次填写还没读过。
    siteAnswers: null,
    // 正在读网站回答时是那次读取（读完就清掉）：候选规划据此先不列问到对方公司的题，保存时等它读完。
    siteAnswersReading: null,
    // 给出这批候选时页面所在的网站（#429）：网站回答只存到这个网站，页面换了网站就不存。
    profileOfferSite: ""
  };
  // #188 辅助新增的状态，只在本页内存里；控制逻辑见 handlePanelRepeat。
  const REPEAT_ACTIVE = ["scanning", "planning", "preview", "executing", "filling"];
  const REPEAT_STOPPABLE = ["scanning", "planning", "executing", "filling"];
  const repeat = { phase: "idle", requestId: "", message: "", plan: [], added: 0, run: null };

  // The native side panel owns the visible UI. The existing shadow DOM remains
  // mounted as the form-filling controller so its tested AI and site adapters
  // continue to run in the page's content-script context.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !String(message.type || "").startsWith("RESUME_PANEL_")) return false;
    if (sender.id && sender.id !== chrome.runtime.id) return false;

    if (message.type === "RESUME_PANEL_STATUS") {
      const button = shadowRoot?.querySelector("#resume-pro-ai-fill");
      const status = shadowRoot?.querySelector("#resume-pro-status");
      const cancel = shadowRoot?.querySelector("#resume-pro-cancel-fill");
      const waitHint = shadowRoot?.querySelector("#resume-pro-wait-hint");
      const desktopStatus = shadowRoot?.querySelector("#resume-pro-desktop-status");
      const diagnosticsPanel = shadowRoot?.querySelector("#resume-pro-diagnostics");
      const jobAssist = shadowRoot?.querySelector("#resume-pro-job-assist");
      dropStalePanelJob();
      dropStalePanelSubmit();
      const jobSave = panelJobSnapshot();
      // #429 正在上传、等网站解析时也算在忙，侧栏的「停止」停的是上传。
      const uploading = upload.phase === "running" && upload.step === "upload";
      sendResponse({
        ready: Boolean(button) && startupState === "ready",
        // `disabled` also covers the controller's pre-read state. Treating that as
        // "busy" deadlocks the native side panel: it cannot send the fill command
        // which performs the desktop reread below. Only an active AI run is busy.
        // 上传那几步（取文件、传、等解析、改回）算上传在忙；到了填写那一步，忙不忙、能不能停照填写自己的。
        busy: state.aiBusy || uploading,
        phase: button?.textContent || "",
        status: status?.classList.contains("is-visible") ? status.textContent : "",
        statusKind: status?.classList.contains("is-error") ? "error" : "success",
        openView: state.suggestedView,
        // While 辅助新增 runs, its own 停止 is the one control; the fill's cancel stays hidden.
        canCancel: uploading || (!repeatActive() && Boolean(cancel && !cancel.hidden && !cancel.disabled)),
        cancelLabel: uploading ? "停止上传" : "",
        // #429 第 4 项：上传前的确认卡片、上传中、上传结果；null 是没有。
        upload: uploadSnapshot(),
        // 等 AI 久了的提示（#402）：网页里的旧侧栏是隐藏的，侧栏自己显示这段文字。
        waitHint: state.aiBusy && waitHint && !waitHint.hidden ? waitHint.textContent : "",
        // 保存到「我的信息」的候选、勾选依据和结果（#189）；null 表示没有可问的。
        profileOffer: panelProfileSnapshot(),
        // Archiving the fill that just ended (#178): the offer, the application question and
        // its answer, all drawn by the side panel from this snapshot. Page memory only.
        fillArchive: panelFillSnapshot(),
        desktopStatus: desktopStatus?.textContent || "",
        diagnostics: diagnosticsPanel && !diagnosticsPanel.hidden
          ? diagnosticsPanel.querySelector("#resume-pro-diagnostics-text")?.value || "" : "",
        // 手动反馈附上的诊断（#215 v1）：只含结构和计数，后台还会再按白名单过滤一遍。
        // 这个标签页做过「保存岗位到桌面端」时再附上 [岗位]（#301），只有固定的词；自动报告不带它。
        diagnosticsReport: [diagnosticsPanel && !diagnosticsPanel.hidden ? lastFillReport : "", jobTraceReport()].filter(Boolean).join("\n\n"),
        // #497 同一次填写的私有诊断：后台只在用户同意过第 3 版说明时带上，预览里显示。
        privateReport: diagnosticsPanel && !diagnosticsPanel.hidden ? privateText(lastPrivate) : "",
        // Job recognition runs in the page's controls; the side panel shows it and can cancel it.
        jobAssist: jobAssist && !jobAssist.hidden
          ? { fragments: jobAssist.querySelectorAll("#resume-pro-job-assist-fragments li").length } : null,
        // Saving a job from the side panel itself (#172); held in this page's memory only.
        jobSave,
        // Confirming a submission from the side panel (#172); also held in this page's memory only.
        submitConfirm: panelSubmitSnapshot(),
        // AI 辅助新增条目 from the side panel (#188); also held in this page's memory only.
        repeat: describeRepeat(),
        // 深度分析本页 (#224)：阶段、我们自己的文案和计数；入口要不要突出由上一次常规填写决定。
        deep: describeDeep(),
        deepOffer: deepOfferLevel(),
        deepConsent: deepConsentSeen(),
        // #226 本站配方：只说有没有、上次是不是过期，不带网址和配方内容。
        recipe: recipeStatus(),
        // #429 上传简历后会覆盖已填内容的平台：侧栏提示先上传简历再填写。
        siteHint: siteHint()
      });
      return false;
    }

    if (message.type === "RESUME_PANEL_FILL") {
      if (repeatActive()) {
        sendResponse({ ok: false, error: "AI 辅助新增正在进行，请先完成或停止。" });
        return false;
      }
      if (deepActive()) {
        sendResponse({ ok: false, error: "深度分析正在进行，请先等待或停止。" });
        return false;
      }
      if (upload.phase === "running") {
        sendResponse({ ok: false, error: "正在上传文件，请稍候。" });
        return false;
      }
      StorageService.getState().then(async store => {
        state.currentStore = store;
        if (shadowRoot?.querySelector("#resume-pro-template-select")) renderSidebar();
        const button = shadowRoot?.querySelector("#resume-pro-ai-fill");
        if (!button || button.hidden || button.disabled) { sendResponse({ ok: false, error: "桌面简历当前不可用。" }); return; }
        // #226：本站配方要先点「编辑 / 展开 / 添加」时转到配方模式，在侧栏预览、确认后才点。配方模式不上传文件。
        const route = await recipeRoute().catch(() => null);
        const controller = route ? deepAnalysis() : null;
        if (route && controller && !state.aiBusy && !repeatActive() && !deepActive()) {
          const started = controller.startRecipe(route);
          sendResponse(started.ok ? { ok: true } : { ok: false, error: started.error });
          return;
        }
        // #429 第 4 项：页面上有要传的文件，先在侧栏确认，确认后才上传和填写。
        if (await prepareUpload(store).catch(() => false)) {
          sendResponse({ ok: true, upload: true });
          return;
        }
        panelFillStarting = true;
        try { button.click(); } finally { panelFillStarting = false; }
        sendResponse({ ok: true });
      }).catch(() => sendResponse({ ok: false, error: "桌面简历当前不可用。" }));
      return true;
    }
    if (message.type === "RESUME_PANEL_UPLOAD") {
      Promise.resolve(handlePanelUpload(message)).then(sendResponse)
        .catch(() => sendResponse({ ok: false, error: "上传没有开始，网页没有改动。" }));
      return true;
    }
    if (message.type === "RESUME_PANEL_CANCEL") {
      // #429 正在上传或等网站解析：停下来，已经交给网站的文件不撤回。
      if (upload.phase === "running" && upload.step === "upload") {
        upload.stop = true;
        sendResponse({ ok: true });
        return false;
      }
      const selector = "#resume-pro-cancel-fill";
      const button = shadowRoot?.querySelector(selector);
      if (!button || button.hidden || button.disabled) sendResponse({ ok: false, error: "当前操作不可用。" });
      else { button.click(); sendResponse({ ok: true }); }
      return false;
    }

    if (message.type === "RESUME_PANEL_REPEAT") {
      Promise.resolve(handlePanelRepeat(message)).then(sendResponse)
        .catch(() => sendResponse({ ok: false, error: "辅助新增失败，请手动核对网页。" }));
      return true;
    }

    if (message.type === "RESUME_PANEL_RECIPE") {
      Promise.resolve(handlePanelRecipe(message)).then(sendResponse)
        .catch(() => sendResponse({ ok: false, error: "没能删除本站配方，请稍后再试。" }));
      return true;
    }

    if (message.type === "RESUME_PANEL_DEEP") {
      Promise.resolve(handlePanelDeep(message)).then(sendResponse)
        .catch(() => sendResponse({ ok: false, error: "深度分析没有开始，网页没有改动。" }));
      return true;
    }

    if (message.type === "RESUME_PANEL_TARGET") {
      panelQueriedAt = Date.now();
      sendResponse(describePanelTarget(readPanelChips(message.chips)));
      return false;
    }

    if (message.type === "RESUME_PANEL_FIELD") {
      handlePanelFieldAction(message, sender).then(sendResponse).catch(() => sendResponse({ ok: false, error: "字段填写失败，请手动核对网页。" }));
      return true;
    }
    if (message.type === "RESUME_PANEL_OFFER") {
      const action = String(message.action || "");
      if (action === "profileSkip") { closeProfileOffer(); sendResponse({ ok: true }); return false; }
      if (action === "profileDismiss") { dismissProfileResult(); sendResponse({ ok: true, profileOffer: panelProfileSnapshot() }); return false; }
      if (action === "profileAdd") {
        addUnansweredToProfile(message).then(sendResponse)
          .catch(() => sendResponse({ ok: false, saved: 0, error: "保存失败，请稍后再试。", profileOffer: panelProfileSnapshot() }));
        return true;
      }
      // Archiving a fill is no longer answered here (#178): the side panel runs the whole
      // question itself (RESUME_PANEL_ARCHIVE_*) and never sends the user to the page overlay.
      sendResponse({ ok: false, error: "当前操作不可用。" });
      return false;
    }
    if (message.type === "RESUME_PANEL_ARCHIVE_START") {
      startPanelFillArchive(message).then(sendResponse)
        .catch(() => sendResponse(panelFillOutcome({ ok: false, error: "没能开始留档，请稍后再试。" })));
      return true;
    }
    if (message.type === "RESUME_PANEL_ARCHIVE_REQUERY") {
      requeryPanelFillArchive(message).then(sendResponse)
        .catch(() => sendResponse(panelFillOutcome({ ok: false, error: "没能重新查找，请稍后再试。" })));
      return true;
    }
    if (message.type === "RESUME_PANEL_ARCHIVE_CHOOSE") {
      choosePanelFillArchive(message).then(sendResponse)
        .catch(() => sendResponse(panelFillOutcome({ ok: false, error: "没能留档，请到「待同步」核对后再操作。" })));
      return true;
    }
    if (message.type === "RESUME_PANEL_ARCHIVE_LATER") {
      laterPanelFillArchive(message).then(sendResponse)
        .catch(() => sendResponse(panelFillOutcome({ ok: false, error: "没能记入待同步，请稍后再试。" })));
      return true;
    }
    if (message.type === "RESUME_PANEL_ARCHIVE_REMOVE") {
      removePanelFillArchive(message).then(sendResponse)
        .catch(() => sendResponse(panelFillOutcome({ ok: false, error: "没能删除这条待同步记录，请在「待同步」里再试。" })));
      return true;
    }
    if (message.type === "RESUME_PANEL_ARCHIVE_CANCEL") {
      sendResponse(cancelPanelFillArchive(message));
      return false;
    }
    if (message.type === "RESUME_PANEL_SAVE_DRAFT") {
      startPanelJobDraft().then(jobSave => sendResponse({ ok: true, jobSave }))
        .catch(() => sendResponse({ ok: false, error: "读取岗位信息失败。", jobSave: panelJobSnapshot() }));
      return true;
    }
    if (message.type === "RESUME_PANEL_SAVE_CONFIRM") {
      confirmPanelJob(message).then(sendResponse)
        .catch(() => sendResponse({ ok: false, error: "这次没能保存，请稍后再试。", jobSave: panelJobSnapshot() }));
      return true;
    }
    if (message.type === "RESUME_PANEL_SAVE_REASSIST") {
      reassistPanelJob(message).then(sendResponse)
        .catch(() => sendResponse({ ok: false, error: "重新识别没有完成，请稍后再试。", jobSave: panelJobSnapshot() }));
      return true;
    }
    if (message.type === "RESUME_PANEL_SAVE_CANCEL") {
      cancelPanelJob(message).then(sendResponse)
        .catch(() => sendResponse({ ok: false, error: "当前无法取消。", jobSave: panelJobSnapshot() }));
      return true;
    }
    if (message.type === "RESUME_PANEL_SAVE_CHOICE") {
      choosePanelJob(message).then(sendResponse)
        .catch(() => sendResponse({ ok: false, error: "这次没能保存，请稍后再试。", jobSave: panelJobSnapshot() }));
      return true;
    }
    if (message.type === "RESUME_PANEL_SUBMIT_START") {
      startPanelSubmit().then(sendResponse)
        .catch(() => sendResponse({ ok: false, error: "没能开始确认投递，请稍后再试。", submitConfirm: panelSubmitSnapshot() }));
      return true;
    }
    if (message.type === "RESUME_PANEL_SUBMIT_QUERY") {
      queryPanelSubmit(message).then(sendResponse)
        .catch(() => sendResponse({ ok: false, error: "没能查到对应的投递记录，这次没有确认投递。请稍后再试。", submitConfirm: panelSubmitSnapshot() }));
      return true;
    }
    if (message.type === "RESUME_PANEL_SUBMIT_CHOICE") {
      choosePanelSubmit(message).then(sendResponse)
        .catch(() => sendResponse({ ok: false, error: "没能确认结果，请到桌面端查看这条申请的当前状态。", submitConfirm: panelSubmitSnapshot() }));
      return true;
    }
    if (message.type === "RESUME_PANEL_SUBMIT_BACK") {
      sendResponse(backPanelSubmit(message));
      return false;
    }
    if (message.type === "RESUME_PANEL_SUBMIT_CANCEL") {
      sendResponse(cancelPanelSubmit(message));
      return false;
    }
    if (message.type === "RESUME_PANEL_SUBMIT_SAVE") {
      savePanelSubmitJob(message).then(sendResponse)
        .catch(() => sendResponse({ ok: false, error: "读取岗位信息失败。", jobSave: panelJobSnapshot(), submitConfirm: panelSubmitSnapshot() }));
      return true;
    }
    if (message.type === "RESUME_PANEL_ADVANCED") {
      if (message.action === "cancel-assist") {
        const running = Boolean(shadowRoot?.querySelector("#resume-pro-job-assist")?.hidden === false);
        if (running) cancelJobAssist();
        sendResponse(running ? { ok: true } : { ok: false, error: "识别已经结束了。" });
        return false;
      }
      if (message.action === "close") {
        shadowRoot?.querySelector(".resume-pro")?.classList.remove("is-legacy-open");
        sendResponse({ ok: true });
        return false;
      }
      // 保存岗位、确认已投递 (#172) and AI 辅助新增条目 (#188) all run in the side panel itself,
      // so nothing here opens the page's old controls any more.
      sendResponse({ ok: false, error: "当前网页无法打开该工具。" });
      return false;
    }
    return false;
  });

  const StorageService = {
    async getState() {
      let result;
      try {
        result = await chrome.runtime.sendMessage({ type: "DESKTOP_RESUME_READ" });
      } catch {
        // No answer at all: the worker, or its link to the desktop, is not there.
        state.desktopMode = "unavailable";
        return null;
      }
      if (result?.status !== "ok") {
        state.desktopMode = result?.status || "unavailable";
        return null;
      }
      try {
        const store = self.ResumeProResumeData.normalize(result.data);
        state.desktopMode = "ready";
        return store;
      } catch (error) {
        // The desktop answered with data this page cannot read. That is an error to report,
        // not a desktop that is not running.
        state.desktopMode = "unreadable";
        if (!unreadableReported) {
          unreadableReported = true;
          reportError(error);
        }
        return null;
      }
    },

    async getSidebarUiState() {
      return self.ResumeProSidebarState.readOrDefault(chrome.storage.local);
    },

    async setSidebarUiState(uiState) {
      await self.ResumeProSidebarState.write(chrome.storage.local, uiState);
    },

    async setActiveTemplate(templateId) {
      return chrome.runtime.sendMessage({ type: "DESKTOP_RESUME_UPDATE", op: "setActiveTemplate", templateId });
    }
  };

  if (window.top !== window) {
    return;
  }

  // Register before a fill starts so this capture listener is as early as the content script
  // can make it. With no active fill session every handler returns immediately.
  bindSubmitSync();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startUp, { once: true });
  } else {
    startUp();
  }

  function startUp() {
    if (!pageCanHostController()) {
      startupState = "unsupported";
      return;
    }
    startupState = "running";
    // init() is async: whatever fails in it ends up here, never as an unhandled rejection.
    init().then(() => { startupState = "ready"; }, (error) => {
      startupState = "failed";
      // A half-built controller must not stay usable on a page that shows as not connected.
      // init() returns early when the page already had the id, so an element with it here was
      // put in by this startup, even when createSidebar threw before handing it back.
      const host = startupHost || document.getElementById(SIDEBAR_ID);
      if (host) host.style.display = "none";
      reportError(error, "unhandledrejection");
    });
  }

  // XML, RSS and SVG pages, and XHTML served as XML, give no HTML elements to build the
  // controller from (#296). Nothing is built there and nothing is reported.
  function pageCanHostController() {
    try {
      return document instanceof HTMLDocument && document.createElement("div") instanceof HTMLElement;
    } catch {
      return false;
    }
  }

  // Sent the way the global handlers send an error, once. A failed init keeps the source
  // "unhandledrejection", which is what it was before it had a boundary.
  // Returns the report (error type and this extension's frames only), or null.
  function reportError(error, source = "error") {
    try {
      const report = self.ResumeProFeedback?.exception(error, chrome.runtime.getURL(""), source);
      if (report?.stack) Promise.resolve(sendFeedback(report)).catch(() => {});
      return report || null;
    } catch {
      /* no recursive reporting */
      return null;
    }
  }

  async function init() {
    if (document.getElementById(SIDEBAR_ID)) {
      return;
    }
    // Every helper this script calls must have loaded. A page element or frame named "module"
    // once kept one from loading (#275), and the page then must not show as connected.
    // Upload boxes (ResumeProUploadSlots, #429) are not on the list: without them only uploading
    // is off (see prepareUpload) and filling works as before.
    const helpers = ["ResumeProFeedback", "ResumeProAIClient", "ResumeProAIHelpers", "ResumeProAntdPrefix", "ResumeProRegions", "ResumeProCustomControls",
      "ResumeProControls", "ResumeProProfile", "ResumeProResumeData", "ResumeProFormAgent", "ResumeProFillProbe",
      "ResumeProFieldScan", "ResumeProPageOutline", "ResumeProDeepAnalysis", "ResumeProPageActions",
      "ResumeProPageRecipe", "ResumeProSiteKnowledge", "ResumeProSidebarState"];
    const missing = helpers.find((name) => !self[name]);
    if (missing) throw new TypeError(`${missing} is not loaded`);

    // No desktop read here. This script runs on every page, and each read starts the
    // native host (and cold-starts the desktop app). The data is read when the in-page
    // panel is actually shown, or when the user starts an action.
    // The controller starts in the default place and takes the saved one once it has been
    // read, so a slow or stuck storage read cannot hold up the page.
    StorageService.getSidebarUiState().then(applyStoredSidebarUiState).catch(() => {});
    // Without content.css nothing in the shadow root is hidden or styled, so the whole host
    // is hidden instead (#256). The controller still mounts and the page stays usable.
    let cssText = await fetch(chrome.runtime.getURL("content.css")).then((r) => (r.ok ? r.text() : null)).catch(() => null);
    const sheet = new CSSStyleSheet();
    try {
      sheet.replaceSync(cssText ?? "");
    } catch {
      cssText = null;
    }
    injectFieldHighlightStyles();
    // Chrome and Edge 116+ own the visible UI in the native side panel.
    // Background opens the manager tab if that API is unavailable.
    state.nativeSidePanel = true;
    const host = createSidebar(sheet);
    startupHost = host;
    if (cssText === null) host.style.display = "none";
    renderSidebar();
    bindStorageSync();
    document.addEventListener("visibilitychange", () => {
      // A plan made for this tab must not keep clicking once the user has moved to another one.
      if (document.hidden) invalidateRepeat("已切换到其他标签页，计划已失效，请重新预览。");
      else refreshVisibleStore().catch(() => {});
    });
    bindFocusTracking();
    window.addEventListener("resize", constrainSidebarToViewport);
  }

  function inPageUiVisible() {
    return Boolean(shadowRoot?.querySelector(".resume-pro")?.classList.contains("is-legacy-open"));
  }

  // Reads the desktop only while the in-page panel is on screen. With the native side
  // panel it stays hidden, and the side panel reads for itself.
  async function refreshVisibleStore() {
    if (!inPageUiVisible()) return false;
    state.currentStore = await StorageService.getState();
    renderSidebar();
    const { legacyImport } = await chrome.storage.local.get(["legacyImport"]).catch(() => ({}));
    const hint = shadowRoot?.querySelector("#resume-pro-legacy-hint");
    if (hint) hint.hidden = !["sending", "waiting"].includes(legacyImport?.phase);
    return true;
  }

  function createSidebar(sheet) {
    const uiState = self.ResumeProSidebarState.normalize(state.sidebarUiState);
    state.sidebarUiState = uiState;
    const host = document.createElement("div");
    host.id = SIDEBAR_ID;
    Object.assign(host.style, {
      position: "fixed",
      top: `${SIDEBAR_DEFAULT_TOP}px`,
      right: `${SIDEBAR_DEFAULT_RIGHT}px`,
      zIndex: "2147483647"
    });

    if (uiState.left !== null && uiState.top !== null) {
      host.style.left = `${uiState.left}px`;
      host.style.top = `${uiState.top}px`;
      host.style.right = "auto";
    }

    document.body.appendChild(host);
    shadowRoot = host.attachShadow({ mode: "closed" });
    shadowRoot.adoptedStyleSheets = [sheet];

    const sidebar = document.createElement("aside");
    sidebar.id = SIDEBAR_PANEL_ID;
    sidebar.className = uiState.collapsed ? "resume-pro is-collapsed" : "resume-pro";
    sidebar.innerHTML = `
      <div class="resume-pro__header" data-drag-handle="true">
        <div class="resume-pro__title-wrap">
          <p class="resume-pro__eyebrow">网申快填</p>
          <strong class="resume-pro__title">填表助手</strong>
        </div>
        <button class="resume-pro__collapse" type="button" aria-label="折叠助手" aria-controls="${SIDEBAR_PANEL_ID}">−</button>
      </div>
      <div class="resume-pro__body">
        <label class="resume-pro__field">
          <span>当前模板</span>
          <select class="resume-pro__select" id="resume-pro-template-select"></select>
        </label>
        <button class="resume-pro__ai-button" id="resume-pro-ai-fill" type="button">一键 AI 填写</button>
        <button class="resume-pro__manager-button" id="resume-pro-repeat-fill" type="button">AI 辅助新增条目（先预览）</button>
        <button class="resume-pro__manager-button" id="resume-pro-cancel-fill" type="button" hidden>取消 AI 等待（保留本地匹配）</button>
        <p id="resume-pro-wait-hint" role="status" hidden></p>
        <div class="resume-pro__status" id="resume-pro-status" aria-live="polite"></div>
        <div class="resume-pro__fill-record" id="resume-pro-profile-offer" hidden>
          <p class="resume-pro__save-note" id="resume-pro-profile-offer-text"></p>
          <div class="resume-pro__save-actions">
            <button class="resume-pro__ai-button" type="button" id="resume-pro-profile-offer-add">保存到我的信息</button>
            <button class="resume-pro__manager-button" type="button" id="resume-pro-profile-offer-skip">不用</button>
          </div>
        </div>
        <div class="resume-pro__fill-record" id="resume-pro-fill-record" hidden>
          <p class="resume-pro__save-note" id="resume-pro-fill-record-summary"></p>
          <label class="resume-pro__fill-record-option">
            <input type="checkbox" id="resume-pro-fill-record-snapshot" checked>
            <span>附上这次用的简历模板拷贝（先存在本机，传到桌面后可在申请里查看）</span>
          </label>
          <div class="resume-pro__save-actions">
            <button class="resume-pro__ai-button" type="button" id="resume-pro-fill-record-save">留档到桌面</button>
            <button class="resume-pro__manager-button" type="button" id="resume-pro-fill-record-skip">不留档</button>
          </div>
        </div>
        <details class="resume-pro__diagnostics" id="resume-pro-diagnostics" hidden>
          <summary>填写诊断（不含简历内容）</summary>
          <textarea id="resume-pro-diagnostics-text" readonly aria-label="填写诊断摘要，可选择复制" rows="14"></textarea>
        </details>
        <div class="resume-pro__divider"></div>
        <div class="resume-pro__desktop">
          <button class="resume-pro__manager-button" id="resume-pro-save-job" type="button">保存岗位到桌面端</button>
          <p class="resume-pro__footer-tip">页面信息不全时，会经桌面把几段岗位文字发给 AI 识别，不会发送表单或简历内容。</p>
          <button class="resume-pro__manager-button" id="resume-pro-confirm-submit" type="button">确认已投递</button>
          <form class="resume-pro__save-form" id="resume-pro-save-form" hidden>
            <label class="resume-pro__field">
              <span>公司<em>*</em></span>
              <input type="text" id="resume-pro-save-company" autocomplete="off" required>
            </label>
            <label class="resume-pro__field">
              <span>岗位<em>*</em></span>
              <input type="text" id="resume-pro-save-title" autocomplete="off" required>
            </label>
            <label class="resume-pro__field">
              <span>地点</span>
              <input type="text" id="resume-pro-save-location" autocomplete="off">
            </label>
            <label class="resume-pro__field">
              <span>来源链接</span>
              <input type="text" id="resume-pro-save-url" readonly>
            </label>
            <p class="resume-pro__save-note" id="resume-pro-save-note"></p>
            <div class="resume-pro__save-actions">
              <button class="resume-pro__ai-button" type="submit">确认</button>
              <button class="resume-pro__manager-button" type="button" id="resume-pro-save-cancel">取消</button>
              <button class="resume-pro__manager-button" type="button" id="resume-pro-save-open-ai" hidden>打开桌面 AI 设置</button>
            </div>
          </form>
          <div class="resume-pro__save-form" id="resume-pro-job-assist" hidden>
            <p class="resume-pro__save-note" id="resume-pro-job-assist-note" role="status"></p>
            <ul class="resume-pro__candidate-list" id="resume-pro-job-assist-fragments"></ul>
            <div class="resume-pro__save-actions">
              <button class="resume-pro__manager-button" type="button" id="resume-pro-job-assist-cancel">取消识别</button>
            </div>
          </div>
          <div class="resume-pro__candidates" id="resume-pro-candidates" hidden>
            <p class="resume-pro__save-note" id="resume-pro-candidates-note"></p>
            <div class="resume-pro__candidate-list" id="resume-pro-candidate-list"></div>
            <div class="resume-pro__save-actions">
              <button class="resume-pro__ai-button" type="button" id="resume-pro-bind-new">新建一条</button>
              <button class="resume-pro__manager-button" type="button" id="resume-pro-bind-later">稍后再说</button>
            </div>
          </div>
          <div class="resume-pro__desktop-status" id="resume-pro-desktop-status" aria-live="polite"></div>
          <details class="resume-pro__pending" id="resume-pro-pending" hidden>
            <summary>待同步 <span id="resume-pro-pending-count">0</span> 条</summary>
            <div class="resume-pro__pending-list" id="resume-pro-pending-list"></div>
          </details>
        </div>
        <div class="resume-pro__divider"></div>
        <div class="resume-pro__groups" id="resume-pro-groups"></div>
        <div class="resume-pro__footer">
          <button class="resume-pro__manager-button" id="resume-pro-open-manager" type="button">打开桌面</button>
          <p class="resume-pro__footer-tip">简历数据和 AI 设置由桌面程序管理。</p>
          <p class="resume-pro__footer-tip" id="resume-pro-legacy-hint" hidden>插件里的旧简历正在迁到桌面，请到桌面「简历」页确认导入。</p>
        </div>
      </div>
    `;

    shadowRoot.appendChild(sidebar);
    updateCollapseButton(sidebar);
    constrainSidebarToViewport();
    const chipActions = document.createElement("div");
    chipActions.id = "resume-pro-chip-actions";
    chipActions.className = "resume-pro__chip-actions";
    chipActions.hidden = true;
    chipActions.setAttribute("role", "menu");
    chipActions.setAttribute("aria-label", "字段填写方式");
    chipActions.innerHTML = `
      <button type="button" role="menuitem" data-chip-mode="add">添加</button>
      <button type="button" role="menuitem" data-chip-mode="replace">替换</button>
    `;
    shadowRoot.appendChild(chipActions);
    bindSidebarEvents(sidebar);
    return host;
  }

  function bindSidebarEvents(sidebar) {
    const header = sidebar.querySelector(".resume-pro__header");
    const collapseButton = sidebar.querySelector(".resume-pro__collapse");
    const templateSelect = sidebar.querySelector("#resume-pro-template-select");
    const aiFillButton = sidebar.querySelector("#resume-pro-ai-fill");
    const openManagerButton = sidebar.querySelector("#resume-pro-open-manager");
    header.addEventListener("mousedown", startDrag);
    document.addEventListener("mousemove", onDrag);
    document.addEventListener("mouseup", stopDrag);

    collapseButton.addEventListener("click", () => {
      const host = document.getElementById(SIDEBAR_ID);
      if (!host) {
        return;
      }
      const rect = host.getBoundingClientRect();
      host.style.left = `${rect.left}px`;
      host.style.top = `${rect.top}px`;
      host.style.right = "auto";
      sidebar.classList.toggle("is-collapsed");
      updateCollapseButton(sidebar);
      persistSidebarUiState();
    });

    templateSelect.addEventListener("change", async (event) => {
      const result = await StorageService.setActiveTemplate(event.target.value).catch(() => null);
      state.currentStore = await StorageService.getState();
      renderSidebar();
      showStatus(result?.status === "missing_template" ? "这个模板在桌面里已经删掉了" : result?.status === "ok" ? "模板已切换。" : "桌面暂时无法切换模板。", result?.status === "ok" ? "success" : "error");
    });

    aiFillButton.addEventListener("click", handleAiFillClick);
    sidebar.querySelector("#resume-pro-repeat-fill").addEventListener("click", handleRepeatFillClick);
    openManagerButton?.addEventListener("click", () => state.desktopMode === "ready" ? openManager("home") : openDesktopAction(state.desktopMode));
    sidebar.querySelector("#resume-pro-profile-offer-add")?.addEventListener("click", () => { addUnansweredToProfile().catch(() => {}); });
    sidebar.querySelector("#resume-pro-profile-offer-skip")?.addEventListener("click", closeProfileOffer);
    bindDesktopEvents(sidebar);

    const chipActions = shadowRoot.querySelector("#resume-pro-chip-actions");
    chipActions?.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    chipActions?.querySelectorAll("[data-chip-mode]").forEach((actionButton) => {
      actionButton.addEventListener("click", () => handleChipAction(actionButton.dataset.chipMode));
    });
    document.addEventListener("mousedown", () => closeChipActionMenu());
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeChipActionMenu();
      }
    });
  }

  function bindStorageSync() {
    chrome.storage.onChanged.addListener(async (changes, areaName) => {
      if (areaName !== "local") {
        return;
      }

      const sidebarStateChange = changes[self.ResumeProSidebarState.STORAGE_KEY];
      if (sidebarStateChange && !state.dragging) {
        state.sidebarUiState = self.ResumeProSidebarState.normalize(sidebarStateChange.newValue);
        applySidebarUiState();
      }
    });
  }

  function renderSidebar() {
    if (!shadowRoot) {
      return;
    }

    const templateSelect = shadowRoot.querySelector("#resume-pro-template-select");
    const groupsContainer = shadowRoot.querySelector("#resume-pro-groups");
    const activeTemplate = getActiveTemplate(state.currentStore);
    const templates = state.currentStore?.templates || [];
    const profileFields = profileResumeFields();
    const downgrade = state.desktopMode !== "ready" ? state.desktopMode
      : !activeTemplate && !profileFields.length ? "empty" : null;
    const downgradeCopy = downgrade ? self.ResumeProResumeData.modeCopy(downgrade) : null;
    const openButton = shadowRoot.querySelector("#resume-pro-open-manager");
    if (openButton) openButton.textContent = downgradeCopy?.action || "打开桌面";

    templateSelect.innerHTML = templates.length
      ? templates.map((template) => `
          <option value="${escapeHtml(template.id)}" ${template.id === state.currentStore.activeTemplateId ? "selected" : ""}>
            ${escapeHtml(template.name)}
          </option>
        `).join("")
      : '<option value="">暂无模板</option>';

    templateSelect.disabled = Boolean(downgradeCopy) || !templates.length;
    const aiFillButton = shadowRoot.querySelector("#resume-pro-ai-fill");
    if (aiFillButton) aiFillButton.disabled = Boolean(downgradeCopy) || state.aiBusy;
    const repeatButton = shadowRoot.querySelector("#resume-pro-repeat-fill");
    if (repeatButton) {
      repeatButton.disabled = Boolean(downgradeCopy) || !activeTemplate || state.aiBusy;
      // With the native side panel this runs from there; the page's copy (window.confirm) stays off.
      repeatButton.hidden = Boolean(state.nativeSidePanel);
    }

    if (downgradeCopy) {
      groupsContainer.innerHTML = `
        <div class="resume-pro__empty">
          <p>${escapeHtml(downgradeCopy.message)}</p>
          <button class="resume-pro__setup-button" id="resume-pro-setup-button" type="button">${escapeHtml(downgradeCopy.action)}</button>
        </div>
      `;
    } else {
      groupsContainer.innerHTML = (activeTemplate ? activeTemplate.groups : []).map((group, groupIndex) => `
      <section class="resume-pro__group">
        <div class="resume-pro__group-name">${escapeHtml(group.name)}</div>
        <div class="resume-pro__chips">
          ${group.fields.map((field, fieldIndex) => `
            <button
              class="resume-pro__chip"
              type="button"
              data-chip-id="${escapeHtml(`${activeTemplate.id}:${groupIndex}:${fieldIndex}`)}"
              data-value="${escapeHtml(field.value)}"
              title="${escapeHtml(field.value)}"
            >
              ${escapeHtml(field.key)}
            </button>
          `).join("")}
        </div>
      </section>
    `).join("") + buildProfileChipsHtml(profileFields);

      groupsContainer.querySelectorAll(".resume-pro__chip").forEach((button) => {
        button.addEventListener("mousedown", (event) => {
          event.preventDefault();
        });
        button.addEventListener("click", () => handleFieldChipClick(button));
      });
    }

    const setupButton = groupsContainer.querySelector("#resume-pro-setup-button");
    if (setupButton) {
      setupButton.addEventListener("click", () => openDesktopAction(downgrade));
    }

    closeChipActionMenu();
    syncChipSelectionState();
  }

  async function handleFieldChipClick(button) {
    const value = button.dataset.value || "";
    const target = getLastFocusedFillTarget();

    closeChipActionMenu();
    if (!value) {
      return;
    }

    if (!target) {
      await copyText(value);
      return;
    }

    if (isBlockedFillTarget(target)) {
      return;
    }

    if (!isComposableTextTarget(target)) {
      await copyText(value);
      const filled = await Promise.resolve(setElementValue(target, value));
      if (filled) {
        target.focus?.();
        state.lastFocusedField = target;
      }
      return;
    }

    const selection = captureTextSelection(target);
    const currentValue = getComposableTargetValue(target);
    syncChipSelectionState();
    if (button.classList.contains("is-in-field")) {
      await applyChipValue(target, value, "remove", selection, button.dataset.chipId);
      return;
    }

    if (!currentValue) {
      await copyText(value);
      await applyChipValue(target, value, "add", selection, button.dataset.chipId);
      return;
    }

    showChipActionMenu(button, target, value, selection);
  }

  const PANEL_COMPOSE_MODES = new Set(["add", "replace", "remove"]);
  const PANEL_MAX_CHIPS = 2000;

  // The side panel sends only what it needs to judge a field: its id and its own value.
  // Nothing here reads the page's text back out to the panel.
  function readPanelChips(raw, extra = null) {
    const chips = [];
    const seen = new Set();
    const push = (chipId, value) => {
      if (typeof chipId !== "string" || !chipId || typeof value !== "string" || !value || seen.has(chipId)) return;
      if (chips.length >= PANEL_MAX_CHIPS) return;
      seen.add(chipId);
      chips.push({ dataset: { chipId, value } });
    };
    if (Array.isArray(raw)) {
      raw.forEach((item) => push(item?.chipId, item?.value));
    }
    if (extra) {
      const at = chips.findIndex((chip) => chip.dataset.chipId === extra.chipId);
      if (at >= 0) chips[at].dataset.value = extra.value;
      else push(extra.chipId, extra.value);
    }
    return chips;
  }

  function planChipActions(target, chips) {
    const current = getComposableTargetValue(target);
    const selection = resolveTextSelection(target);
    const selected = resolveSelectedChipIds(target, chips, current);
    const actions = {};
    chips.forEach((chip) => {
      const chipId = chip.dataset.chipId;
      const value = chip.dataset.value;
      const contained = selected.has(chipId);
      actions[chipId] = {
        add: !contained && composeChipText(current, value, "add", selection).changed,
        replace: current !== "" && composeChipText(current, value, "replace", selection).changed,
        remove: contained && composeChipText(current, value, "remove", selection).changed
      };
    });
    return { current, selected, actions };
  }

  // 侧栏只拿到布尔能力和 chipId，不会拿到文本框原文。
  function describePanelTarget(chips) {
    const target = getLastFocusedFillTarget();
    const none = { ok: true, targetAvailable: false, composable: false, empty: true, selectedChipIds: [], actions: {} };
    if (!target) return none;
    if (!isComposableTextTarget(target)) return { ...none, targetAvailable: true };
    const plan = planChipActions(target, chips);
    return {
      ok: true,
      targetAvailable: true,
      composable: true,
      empty: plan.current === "",
      selectedChipIds: Array.from(plan.selected),
      actions: plan.actions
    };
  }

  function panelActionRefusal(mode, plan, chipId) {
    if (plan.actions[chipId]?.[mode]) return "";
    if (mode === "add") {
      return plan.selected.has(chipId) ? "网页输入框已包含这个字段。" : "添加不会改变网页内容。";
    }
    if (mode === "replace") {
      return plan.current === "" ? "网页输入框是空的，请使用「添加」。" : "替换不会改变网页内容。";
    }
    return plan.selected.has(chipId) ? "删除不会改变网页内容。" : "网页输入框里没有这个字段。";
  }

  async function applyPanelComposeAction(message, chipId, value, mode, trusted) {
    const target = getLastFocusedFillTarget();
    if (!target) return { ok: false, error: "请先点击网页输入框。" };
    if (!isComposableTextTarget(target)) {
      return { ok: false, error: "这个网页控件不能组合字段，请换到普通文本框。" };
    }
    // Hidden page chips may be older than the panel's snapshot; only the panel's own
    // list is used for identity when the sender is this extension.
    const chips = readPanelChips(trusted ? message.chips : null, { chipId, value });
    if (!trusted) {
      Array.from(shadowRoot?.querySelectorAll(".resume-pro__chip") || []).forEach((button) => {
        if (button.dataset.chipId && button.dataset.value && !chips.some((chip) => chip.dataset.chipId === button.dataset.chipId)) {
          chips.push({ dataset: { chipId: button.dataset.chipId, value: button.dataset.value } });
        }
      });
    }
    const plan = planChipActions(target, chips);
    const refusal = panelActionRefusal(mode, plan, chipId);
    if (refusal) return { ok: false, error: refusal };
    const applied = await applyChipValue(target, value, mode, resolveTextSelection(target), chipId);
    if (!applied) return { ok: false, error: "网页控件没有接受这次修改，内容未变化，请手动核对。" };
    const done = { add: "已添加到网页输入框。", replace: "已替换网页输入框内容。", remove: "已从网页输入框删除。" };
    return { ok: true, message: done[mode] };
  }

  async function handlePanelFieldAction(message, sender) {
    const mode = message.mode;
    if (mode !== "fill" && mode !== "copy" && !PANEL_COMPOSE_MODES.has(mode)) {
      return { ok: false, error: "未知的字段操作。" };
    }
    const chipId = String(message.chipId || "");
    const button = Array.from(shadowRoot?.querySelectorAll(".resume-pro__chip") || [])
      .find((item) => item.dataset.chipId === chipId);
    // The native side panel has its own fresh desktop snapshot. Its value is trusted
    // only when the sender is this extension; the hidden page chips may be older.
    const trustedValue = sender?.id === chrome.runtime.id && typeof message.value === "string";
    const value = trustedValue
      ? message.value : button?.dataset.value || "";
    if (!button && !trustedValue) return { ok: false, error: "模板字段已变化，请刷新侧栏。" };
    if (!value) return { ok: false, error: "这个字段没有内容。" };

    if (mode === "copy") {
      return { ok: false, needsCopy: true, message: "请在侧栏复制字段内容。" };
    }
    if (PANEL_COMPOSE_MODES.has(mode)) {
      return applyPanelComposeAction(message, chipId, value, mode, trustedValue);
    }

    // 兼容旧的 fill：字段主区域的快捷行为。
    const target = getLastFocusedFillTarget();
    if (!target) {
      return { ok: false, error: "请先点击网页输入框，再选择字段。" };
    }
    if (isBlockedFillTarget(target)) {
      return { ok: false, error: "这个输入框可能是密码、验证码或文件，插件不会自动填写。" };
    }

    if (isComposableTextTarget(target)) {
      if (getComposableTargetValue(target)) {
        return { ok: false, needsChoice: true, message: "网页输入框已有内容，请点击「添加」或「替换」。" };
      }
      const filled = await applyChipValue(target, value, "add", resolveTextSelection(target), chipId);
      if (filled) return { ok: true, message: "已填入网页输入框。" };
      return { ok: false, error: "网页控件没有接受写入，内容未变化，请手动核对。" };
    }

    if (hasExistingValue({ kind: "element", element: target })) {
      return { ok: false, needsCopy: true, message: "网页控件已有内容；请先核对，再粘贴复制的字段。" };
    }
    const filled = await Promise.resolve(setElementValue(target, value));
    if (filled) {
      target.focus?.();
      state.lastFocusedField = target;
      return { ok: true, message: "已填入网页输入框。" };
    }
    return { ok: false, needsCopy: true, message: "网页控件未接受写入；请手动粘贴复制的字段。" };
  }

  async function handleChipAction(mode) {
    const action = state.chipAction;
    closeChipActionMenu();
    if (!action || !["add", "replace"].includes(mode)) {
      return;
    }

    await copyText(action.value);
    const filled = await applyChipValue(action.target, action.value, mode, action.selection, action.button.dataset.chipId);
    if (!filled) {
      return;
    }
  }

  function showChipActionMenu(button, target, value, selection) {
    const menu = shadowRoot?.querySelector("#resume-pro-chip-actions");
    if (!menu) {
      return;
    }

    state.chipAction = { button, target, value, selection };
    menu.hidden = false;
    const buttonRect = button.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(buttonRect.left, window.innerWidth - menuRect.width - 8));
    const fitsBelow = buttonRect.bottom + menuRect.height + 8 <= window.innerHeight;
    const top = fitsBelow ? buttonRect.bottom + 6 : Math.max(8, buttonRect.top - menuRect.height - 6);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  function closeChipActionMenu() {
    const menu = shadowRoot?.querySelector?.("#resume-pro-chip-actions");
    if (menu) {
      menu.hidden = true;
    }
    state.chipAction = null;
  }

  function readLiveTextSelection(target) {
    if (isInputElement(target) || isTextAreaElement(target)) {
      let start;
      let end;
      try {
        start = target.selectionStart;
        end = target.selectionEnd;
      } catch {
        return null;
      }
      return Number.isInteger(start) && Number.isInteger(end) ? { start, end } : null;
    }

    const selection = viewOf(target).getSelection?.();
    if (!selection?.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!target.contains?.(range.commonAncestorContainer)) return null;
    const beforeStart = range.cloneRange();
    beforeStart.selectNodeContents(target);
    beforeStart.setEnd(range.startContainer, range.startOffset);
    const beforeEnd = range.cloneRange();
    beforeEnd.selectNodeContents(target);
    beforeEnd.setEnd(range.endContainer, range.endOffset);
    return { start: beforeStart.toString().length, end: beforeEnd.toString().length };
  }

  function validTextSelection(selection, length) {
    if (!selection || !Number.isInteger(selection.start) || !Number.isInteger(selection.end)) return null;
    const start = Math.min(selection.start, selection.end);
    const end = Math.max(selection.start, selection.end);
    return start >= 0 && end <= length ? { start, end } : null;
  }

  // 优先取网页里此刻的光标；取不到（例如 contenteditable 失焦后选区没了，或 email
  // 输入框没有 selectionStart）就用最后保存的；再无效就回到文本末尾。
  function resolveTextSelection(target) {
    const length = getComposableTargetValue(target).length;
    const live = validTextSelection(readLiveTextSelection(target), length);
    if (live) {
      savedTextSelections.set(target, live);
      return live;
    }
    const saved = validTextSelection(savedTextSelections.get(target), length);
    return saved || { start: length, end: length };
  }

  function captureTextSelection(target) {
    return resolveTextSelection(target);
  }

  function rememberTextSelection(target) {
    // 只记光标下标，不记文本；这里不做敏感判断，避免每次 selectionchange 都去找标签。
    const textual = isInputElement(target) || isTextAreaElement(target)
      || (isHtmlElement(target) && target.isContentEditable);
    if (!textual || chipWriteTargets.has(target)) return;
    const live = validTextSelection(readLiveTextSelection(target), getComposableTargetValue(target).length);
    if (live) savedTextSelections.set(target, live);
  }

  function composeChipText(currentValue, chipValue, mode, selection = {}) {
    const current = String(currentValue || "");
    const chip = String(chipValue || "");
    const rawStart = Number.isInteger(selection.start) ? selection.start : current.length;
    const start = Math.min(Math.max(0, rawStart), current.length);

    if (!chip) {
      return { value: current, caret: start, changed: false };
    }

    if (mode === "replace") {
      return { value: chip, caret: chip.length, changed: current !== chip };
    }

    if (mode === "remove") {
      const index = findNearestChipOccurrence(current, chip, start);
      if (index < 0) {
        return { value: current, caret: start, changed: false };
      }
      return {
        value: current.slice(0, index) + current.slice(index + chip.length),
        caret: index,
        changed: true
      };
    }

    return {
      value: current.slice(0, start) + chip + current.slice(start),
      caret: start + chip.length,
      changed: true
    };
  }

  function findNearestChipOccurrence(current, chip, caret) {
    let nearestIndex = -1;
    let nearestDistance = Number.POSITIVE_INFINITY;
    let index = current.indexOf(chip);
    while (index >= 0) {
      const distance = caret < index ? index - caret : caret > index + chip.length ? caret - (index + chip.length) : 0;
      if (distance < nearestDistance) {
        nearestIndex = index;
        nearestDistance = distance;
      }
      index = current.indexOf(chip, index + Math.max(1, chip.length));
    }
    return nearestIndex;
  }

  async function applyChipValue(target, chipValue, mode, selection, chipId = "") {
    if (!isComposableTextTarget(target) || !inPage(target)) {
      return false;
    }

    const composed = composeChipText(getComposableTargetValue(target), chipValue, mode, selection);
    if (!composed.changed) {
      if (mode === "replace" && chipId) {
        updateTrackedChipSelection(target, chipId, mode);
        syncChipSelectionState();
        return true;
      }
      return false;
    }

    const hadTrackedSelection = chipSelectionIdsByTarget.has(target);
    const previousSelection = new Set(chipSelectionIdsByTarget.get(target) || []);
    updateTrackedChipSelection(target, chipId, mode);
    chipWriteTargets.add(target);
    let filled;
    try {
      filled = await Promise.resolve(setElementValue(target, composed.value));
    } finally {
      chipWriteTargets.delete(target);
    }
    if (!filled) {
      if (chipId) {
        if (hadTrackedSelection) {
          chipSelectionIdsByTarget.set(target, previousSelection);
        } else {
          chipSelectionIdsByTarget.delete(target);
        }
      }
      return false;
    }

    target.focus?.();
    if (isInputElement(target) || isTextAreaElement(target)) {
      target.setSelectionRange?.(composed.caret, composed.caret);
    } else {
      setContentEditableCaret(target, composed.caret);
    }
    savedTextSelections.set(target, { start: composed.caret, end: composed.caret });
    state.lastFocusedField = target;
    syncChipSelectionState();
    return true;
  }

  function getComposableTargetValue(target) {
    return isInputElement(target) || isTextAreaElement(target)
      ? String(target.value || "")
      : String(target.textContent || "");
  }

  function findTextPosition(root, offset) {
    let remaining = offset;
    let last = null;
    const walk = (node) => {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3) {
          const length = child.textContent?.length || 0;
          if (remaining <= length) return { node: child, offset: remaining };
          remaining -= length;
          last = child;
        } else if (child.firstChild) {
          const found = walk(child);
          if (found) return found;
        }
      }
      return null;
    };
    const found = walk(root);
    if (found) return found;
    return last ? { node: last, offset: last.textContent?.length || 0 } : { node: root, offset: 0 };
  }

  function setContentEditableCaret(target, caret) {
    const selection = viewOf(target).getSelection?.();
    const range = docOf(target).createRange?.();
    if (!selection || !range) {
      return;
    }
    const position = findTextPosition(target, caret);
    range.setStart(position.node, position.offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // 验证码、一次性口令类字段不能只看 input.type：这里复用档案里的敏感词表，再补上
  // 验证码/OTP 的常见写法，以及浏览器自己的 autocomplete 声明。
  const OTP_HINT = /(?:^|[^a-z])otp(?:[^a-z]|$)|one[-_ ]?time|sms[-_ ]?code|verif(?:y|ication)[-_ ]?code|security[-_ ]?code|captcha|验证码|校验码|短信码|动态码|安全码/i;

  function isSensitiveTextTarget(target) {
    if (!isHtmlElement(target)) return false;
    const type = String(target.type || "").toLowerCase();
    if (type === "password") return true;
    const attr = (name) => String(target.getAttribute?.(name) || "");
    if (/one-time-code|current-password|new-password/i.test(attr("autocomplete"))) return true;
    let label = "";
    try {
      label = getFieldLabel(target);
    } catch {
      label = "";
    }
    const hint = [target.name, target.id, attr("placeholder"), attr("aria-label"), attr("data-label"), label].join(" ");
    const secret = self.ResumeProProfile?.SECRET_LABEL;
    return OTP_HINT.test(hint) || Boolean(secret && secret.test(hint));
  }

  function isBlockedFillTarget(target) {
    return isSensitiveTextTarget(target)
      || (isInputElement(target) && String(target.type || "").toLowerCase() === "file");
  }

  function isComposableTextTarget(target) {
    if (!isHtmlElement(target) || target.disabled || target.readOnly || isSensitiveTextTarget(target)) {
      return false;
    }
    if (isTextAreaElement(target) || target.isContentEditable) {
      return true;
    }
    return isInputElement(target) && ["text", "search", "tel", "url", "email"].includes(target.type || "text");
  }

  function syncChipSelectionState() {
    // 侧栏在线时，选中状态以侧栏发来的字段清单为准；隐藏的旧字段可能比它旧。
    if (!shadowRoot?.querySelectorAll || Date.now() - panelQueriedAt < PANEL_ONLINE_MS) {
      return;
    }
    const target = getLastFocusedFillTarget();
    const currentValue = target && isComposableTextTarget(target) ? getComposableTargetValue(target) : "";
    const buttons = Array.from(shadowRoot.querySelectorAll(".resume-pro__chip"));
    const selectedIds = target && isComposableTextTarget(target)
      ? resolveSelectedChipIds(target, buttons, currentValue)
      : new Set();
    buttons.forEach((button) => {
      const selected = selectedIds.has(button.dataset.chipId);
      button.classList.toggle("is-in-field", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
  }

  function updateTrackedChipSelection(target, chipId, mode) {
    if (!chipId) {
      return;
    }
    const selectedIds = new Set(chipSelectionIdsByTarget.get(target) || []);
    if (mode === "replace") {
      selectedIds.clear();
    }
    if (mode === "remove") {
      selectedIds.delete(chipId);
    } else {
      selectedIds.add(chipId);
    }
    chipSelectionIdsByTarget.set(target, selectedIds);
  }

  function resolveSelectedChipIds(target, buttons, currentValue) {
    const hasTrackedSelection = chipSelectionIdsByTarget.has(target);
    const previousIds = chipSelectionIdsByTarget.get(target) || new Set();
    const nextIds = new Set();
    const buttonsByValue = new Map();

    buttons.forEach((button, index) => {
      if (!button.dataset.chipId) {
        button.dataset.chipId = `rendered-chip-${index}`;
      }
      const value = button.dataset.value || "";
      if (!value) {
        return;
      }
      if (!buttonsByValue.has(value)) {
        buttonsByValue.set(value, []);
      }
      buttonsByValue.get(value).push(button);
    });

    buttonsByValue.forEach((sameValueButtons, value) => {
      let remaining = countTextOccurrences(currentValue, value);
      const preferred = sameValueButtons.filter((button) => previousIds.has(button.dataset.chipId));
      const candidates = hasTrackedSelection
        ? preferred
        : sameValueButtons;
      candidates.forEach((button) => {
        if (remaining > 0) {
          nextIds.add(button.dataset.chipId);
          remaining -= 1;
        }
      });
    });

    chipSelectionIdsByTarget.set(target, nextIds);
    return nextIds;
  }

  function countTextOccurrences(text, value) {
    if (!value) {
      return 0;
    }
    let count = 0;
    let index = String(text || "").indexOf(value);
    while (index >= 0) {
      count += 1;
      index = String(text || "").indexOf(value, index + value.length);
    }
    return count;
  }

  function newRequestId() {
    return crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16)).join("-");
  }

  // A fill record's id has to be a real UUID (link/fillrecords.mjs). `randomUUID` is missing
  // on plain-http pages, so the same shape is built from random bytes there.
  function newRecordId() {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // The retained page button is guarded while Chrome/Edge use the native side panel (#188).
  async function handleRepeatFillClick(event) {
    const button = event.currentTarget;
    if (state.nativeSidePanel) {
      showStatus("请在浏览器侧栏的「填写」页使用「AI 辅助新增条目」。", "error");
      return;
    }
    const fillButton = shadowRoot.querySelector("#resume-pro-ai-fill");
    if (button.disabled || fillButton.disabled || state.aiBusy) return;
    state.aiBusy = true;
    state.suggestedView = null;
    const release = message => {
      state.aiBusy = false;
      fillButton.disabled = state.desktopMode !== "ready" || !hasResumeData();
      button.disabled = state.desktopMode !== "ready" || !getActiveTemplate(state.currentStore);
      if (message) showStatus(message, "error");
    };
    state.currentStore = await StorageService.getState();
    if (shadowRoot?.querySelector("#resume-pro-template-select")) renderSidebar();
    if (state.desktopMode !== "ready") {
      release(self.ResumeProResumeData.modeCopy(state.desktopMode).message);
      return;
    }
    const template = getActiveTemplate(state.currentStore);
    const templateFingerprint = JSON.stringify(template);
    if (!template) {
      release("请先在桌面准备简历模板。");
      return;
    }
    const agent = self.ResumeProFormAgent;
    let snapshot;
    try { snapshot = agent.collect(document, flattenTemplateFields(template)); }
    catch { release("无法识别网页分组，请手动新增条目。"); return; }
    if (!snapshot.candidates.length) {
      release("未识别到可安全新增的分组，请先手动新增条目，再一键填写。");
      return;
    }
    button.disabled = true;
    fillButton.disabled = true;
    const cancel = shadowRoot.querySelector("#resume-pro-cancel-fill");
    const hint = shadowRoot.querySelector("#resume-pro-wait-hint");
    const requestId = newRequestId();
    let stopped = false;
    let planning = true;
    let expanded;
    cancel.hidden = false;
    cancel.disabled = false;
    cancel.textContent = "停止辅助新增";
    cancel.onclick = () => {
      stopped = true;
      cancel.disabled = true;
      if (planning) self.ResumeProAIClient.cancel(requestId).catch(() => {});
    };
    const start = performance.now();
    const progress = () => {
      const seconds = Math.floor((performance.now() - start) / 1000);
      button.textContent = `AI 规划中... ${seconds}s`;
      if (seconds >= 90) {
        hint.hidden = false;
        hint.textContent = "正在等待 AI 规划，上游模型、中转或网络可能较慢；不会自动取消，可手动停止。";
      }
    };
    progress();
    const timer = window.setInterval(progress, 1000);
    try {
      const reply = await self.ResumeProAIClient.send({ type: "AI_PLAN_REPEAT", requestId, candidates: snapshot.candidates });
      planning = false;
      window.clearInterval(timer);
      if (stopped) throw new Error("已停止，未执行新增。");
      if (!reply?.success) {
        if (reply?.openView === "settings-ai") {
          state.suggestedView = "settings-ai";
          await openManager("settings-ai");
        }
        throw new Error(reply?.error || "AI 规划失败，未执行新增。可稍后重试或手动新增。");
      }
      const plan = agent.validatePlan(reply.plan, snapshot.candidates);
      if (!plan.length) throw new Error("AI 未给出可确认的新增操作，请手动处理。");
      const preview = plan.map(action => `${snapshot.candidates.find(c => c.id === action.id).label}：${action.count} 条`).join("\n");
      if (!window.confirm(`允许以下操作吗？\n${preview}\n\n确认后将点击网页新增按钮，再用 AI 填写这些分组的空字段。不会提交、删除或覆盖已有内容。网页自身可能保存新条目；停止后不自动删除。`)) return;
      state.currentStore = await StorageService.getState();
      if (shadowRoot?.querySelector("#resume-pro-template-select")) renderSidebar();
      if (JSON.stringify(getActiveTemplate(state.currentStore)) !== templateFingerprint) throw new Error("当前模板已变化，请重新预览。");
      button.textContent = "正在新增并检查网页...";
      hint.hidden = true;
      expanded = await agent.execute(plan, snapshot, () => stopped || JSON.stringify(getActiveTemplate(state.currentStore)) !== templateFingerprint);
    } catch (error) {
      showStatus(error.message || "辅助新增失败，请手动核对网页。", "error");
    } finally {
      window.clearInterval(timer);
      cancel.hidden = true;
      cancel.onclick = null;
      cancel.textContent = "取消 AI 等待（保留本地匹配）";
      hint.hidden = true;
      button.disabled = state.desktopMode !== "ready" || !getActiveTemplate(state.currentStore);
      state.aiBusy = false;
      fillButton.disabled = state.desktopMode !== "ready" || !hasResumeData();
      button.textContent = "AI 辅助新增条目（先预览）";
    }
    if (expanded && !stopped) {
      state.currentStore = await StorageService.getState();
      if (JSON.stringify(getActiveTemplate(state.currentStore)) === templateFingerprint) {
        await handleAiFillClick({ currentTarget: fillButton }, { scopes: expanded.scopes });
      } else {
        showStatus("当前模板已变化，已停止辅助填写，请重新预览。", "error");
      }
    }
  }

  // #188：原生侧栏的「AI 辅助新增条目」。扫描、规划、预览、执行、填写都在这里跑，侧栏只显示
  // describeRepeat() 给出的有限字段，并用 requestId 发确认、取消、停止。一次操作绑定本页地址、
  // 模板 ID 与内容、扫描时的候选；任何一项变了，旧计划作废，不再点击网页。

  function repeatActive() {
    return REPEAT_ACTIVE.includes(repeat.phase);
  }

  function repeatLabel(domain) {
    return self.ResumeProFormAgent?.labels?.[domain] || "条目";
  }

  function repeatAddedNote(added) {
    return added > 0 ? `已经新增的 ${added} 条空记录会保留，请在网页中核对。` : "网页没有新增条目。";
  }

  function setRepeat(run, phase, message, extra = {}) {
    if (repeat.run !== run) return false;
    repeat.phase = phase;
    repeat.message = message;
    if (extra.plan) repeat.plan = extra.plan;
    if (Number.isInteger(extra.added)) repeat.added = extra.added;
    if (!REPEAT_ACTIVE.includes(phase)) {
      run.done = true;
      state.aiBusy = false;
      if (shadowRoot?.querySelector("#resume-pro-template-select")) renderSidebar();
    }
    return true;
  }

  // Everything the side panel may see. Labels come from our fixed domain table, never the page.
  function describeRepeat() {
    const run = repeat.run;
    // A tab switch or address change (an SPA moving to another job fires no page event) ends
    // any run in flight. Scanning, planning and preview stop here; execution and filling see the
    // flag before their next step and report the rows they really added.
    if (run && !run.done && repeatActive() && repeatStale(run)) invalidateRepeat(repeatStale(run));
    const phase = repeat.phase;
    return {
      phase,
      requestId: repeat.requestId,
      message: repeat.message,
      plan: repeat.plan.map(({ domain, count }) => ({ domain, count })),
      added: repeat.added,
      canConfirm: phase === "preview",
      canCancel: phase === "preview",
      canStop: REPEAT_STOPPABLE.includes(phase)
    };
  }

  // Why this run may no longer touch the page, or "" while it still may.
  function repeatStale(run) {
    if (run.invalid) return run.invalid;
    if (location.href !== run.url) return "网页地址已变化，计划已失效，请重新预览。";
    if (document.hidden) return "已切换到其他标签页，计划已失效，请重新预览。";
    return "";
  }

  function repeatStopped(run) {
    return run.stopped || repeat.run !== run || Boolean(repeatStale(run));
  }

  // Ends whatever run is in flight. A planning request is cancelled; an execution sees the
  // flag at its next check and stops before the next click.
  function stopRepeat(run, message) {
    if (!run || run.done) return;
    run.stopped = true;
    if (repeat.phase === "planning") self.ResumeProAIClient.cancel(run.requestId).catch(() => {});
    if (repeat.phase === "filling" && run.fillRequestId) self.ResumeProAIClient.cancel(run.fillRequestId).catch(() => {});
    // Planning and preview have not clicked anything, so they end here. Execution and filling
    // finish their current step and then report the real count.
    if (["scanning", "planning", "preview"].includes(repeat.phase)) setRepeat(run, "stopped", message);
  }

  function invalidateRepeat(reason) {
    const run = repeat.run;
    if (!run || run.done) return false;
    run.invalid = reason;
    stopRepeat(run, reason);
    return true;
  }

  async function startRepeat() {
    if (repeatActive() || deepActive() || state.aiBusy) return { ok: false, error: "已有填写或新增正在进行，请先完成或停止。" };
    const run = { requestId: newRequestId(), url: location.href, stopped: false, invalid: "", done: false };
    repeat.run = run;
    repeat.requestId = run.requestId;
    repeat.plan = [];
    repeat.added = 0;
    state.aiBusy = true;
    state.suggestedView = null;
    setRepeat(run, "scanning", "正在检查网页中可以安全新增的经历…");
    planRepeat(run).catch(error => {
      if (!run.done) setRepeat(run, "failed", error?.message || "辅助新增失败，请手动核对网页。");
    });
    return { ok: true, requestId: run.requestId };
  }

  // A run that went stale while waiting ends with its reason instead of staying "in progress".
  // A user stop has already ended it, and a newer run owns the card.
  function abandonRepeat(run) {
    if (!run.done && repeat.run === run) setRepeat(run, "stopped", repeatStale(run) || "已停止，未新增任何条目。");
  }

  async function planRepeat(run) {
    state.currentStore = await StorageService.getState();
    if (repeatStopped(run)) { abandonRepeat(run); return; }
    if (state.desktopMode !== "ready") {
      setRepeat(run, "failed", self.ResumeProResumeData.modeCopy(state.desktopMode).message);
      return;
    }
    const template = getActiveTemplate(state.currentStore);
    if (!template) {
      setRepeat(run, "failed", "请先在桌面准备简历模板。");
      return;
    }
    run.templateId = template.id;
    run.fingerprint = JSON.stringify(template);
    const agent = self.ResumeProFormAgent;
    try {
      run.snapshot = agent.collect(document, flattenTemplateFields(template));
    } catch {
      setRepeat(run, "failed", "无法识别网页分组，请手动新增条目。");
      return;
    }
    if (!run.snapshot.candidates.length) {
      setRepeat(run, "failed", "未识别到可安全新增的分组，请先手动新增条目，再一键填写。");
      return;
    }
    setRepeat(run, "planning", "AI 正在规划需要新增的条目…");
    // Only the local candidate summary goes out: id, domain, label, current, target.
    const reply = await self.ResumeProAIClient.send({ type: "AI_PLAN_REPEAT", requestId: run.requestId, candidates: run.snapshot.candidates });
    // A stop, cancel, tab switch or newer run already answered the user; this reply is late.
    if (repeatStopped(run)) { abandonRepeat(run); return; }
    if (!reply?.success) {
      if (reply?.openView === "settings-ai") {
        state.suggestedView = "settings-ai";
        await openManager("settings-ai").catch(() => {});
      }
      setRepeat(run, "failed", reply?.error || "AI 规划失败，未执行新增。可稍后重试或手动新增。");
      return;
    }
    let plan;
    try {
      plan = agent.validatePlan(reply.plan, run.snapshot.candidates);
    } catch (error) {
      setRepeat(run, "failed", `${error.message || "AI 计划无效。"}未执行新增。`);
      return;
    }
    if (!plan.length) {
      setRepeat(run, "failed", "AI 未给出可确认的新增操作，请手动处理。");
      return;
    }
    run.plan = plan;
    const preview = plan.map(action => ({ domain: run.snapshot.candidates.find(c => c.id === action.id).domain, count: action.count }));
    setRepeat(run, "preview", "计划新增以下条目：", { plan: preview });
  }

  // The desktop template and the page's candidates must still be what the user previewed.
  async function recheckRepeat(run) {
    const stale = repeatStale(run);
    if (stale) return stale;
    state.currentStore = await StorageService.getState();
    if (repeatStopped(run)) return repeatStale(run) || "已停止。";
    const template = getActiveTemplate(state.currentStore);
    if (state.desktopMode !== "ready" || !template || template.id !== run.templateId || JSON.stringify(template) !== run.fingerprint) {
      return "当前模板已变化，计划已失效，请重新预览。";
    }
    return "";
  }

  // The page's candidates must be exactly the scanned ones, moved on only by the rows this plan
  // has added so far (`addedById`). A group that appears, goes, is rebuilt or grows by itself
  // means the plan the user confirmed no longer describes the page.
  function repeatGroupsAsExpected(run, addedById) {
    let fresh;
    try {
      fresh = self.ResumeProFormAgent.collect(document, flattenTemplateFields(JSON.parse(run.fingerprint)));
    } catch {
      return false;
    }
    const expected = run.snapshot.candidates
      .map(c => ({ button: run.snapshot.refs.get(c.id)?.button, domain: c.domain, label: c.label, current: c.current + (addedById.get(c.id) || 0), target: c.target }))
      .filter(c => c.current < c.target);
    const actual = fresh.candidates
      .map(c => ({ button: fresh.refs.get(c.id)?.button, domain: c.domain, label: c.label, current: c.current, target: c.target }));
    return expected.length === actual.length && expected.every((c, i) => c.button === actual[i].button
      && c.domain === actual[i].domain && c.label === actual[i].label && c.current === actual[i].current && c.target === actual[i].target);
  }

  // Rows this plan has added before `step`'s click, per candidate.
  function repeatAddedBefore(run, step) {
    const added = new Map();
    for (const action of run.plan) {
      if (action.id === step.id) { added.set(action.id, step.index - 1); break; }
      added.set(action.id, action.count);
    }
    return added;
  }

  async function confirmRepeat(requestId) {
    const run = repeat.run;
    if (repeat.phase !== "preview" || !run || run.done || run.requestId !== requestId) {
      return { ok: false, error: "这个计划已经失效，请重新预览。" };
    }
    // The phase moves before any await, so a second 确认新增 finds no preview to confirm.
    setRepeat(run, "executing", "正在核对网页和模板…");
    executeRepeat(run).catch(error => {
      if (!run.done) setRepeat(run, "failed", error?.message || "辅助新增失败，请手动核对网页。");
    });
    return { ok: true };
  }

  async function executeRepeat(run) {
    const stale = await recheckRepeat(run) || (repeatGroupsAsExpected(run, new Map()) ? "" : "网页分组已变化，计划已失效，请重新预览。");
    if (stale) {
      setRepeat(run, "stopped", `${stale}${repeatAddedNote(0)}`, { added: 0 });
      return;
    }
    let expanded;
    try {
      expanded = await self.ResumeProFormAgent.execute(run.plan, run.snapshot, () => repeatStopped(run), progress => {
        setRepeat(run, "executing", `正在新增${repeatLabel(progress.domain)} ${progress.index}/${progress.count}…`, { added: progress.added });
      }, step => repeatGroupsAsExpected(run, repeatAddedBefore(run, step)));
    } catch (error) {
      const added = Number.isInteger(error?.added) ? error.added : repeat.added;
      if (run.stopped || repeatStale(run)) {
        setRepeat(run, "stopped", `${run.invalid || repeatStale(run) || "已停止。"}${repeatAddedNote(added)}`, { added });
      } else {
        setRepeat(run, "failed", `${error?.message || "辅助新增失败。"}${added > 0 ? repeatAddedNote(added) : ""}`, { added });
      }
      return;
    }
    const added = expanded.added;
    const summary = run.plan.map(action => `${repeatLabel(run.snapshot.candidates.find(c => c.id === action.id).domain)} ${action.count} 条`).join("、");
    setRepeat(run, "filling", `已新增${summary}，正在填写新增的分组…`, { added });
    const stale2 = await recheckRepeat(run);
    if (stale2) {
      setRepeat(run, "stopped", `${stale2}已停止填写。${repeatAddedNote(added)}`, { added });
      return;
    }
    // Only the new scopes, only empty text fields; the fill itself never submits the form.
    state.aiBusy = false;
    const fillButton = shadowRoot?.querySelector("#resume-pro-ai-fill");
    if (shadowRoot?.querySelector("#resume-pro-template-select")) renderSidebar();
    const result = fillButton
      ? await handleAiFillClick({ currentTarget: fillButton }, {
        scopes: expanded.scopes, quiet: true,
        stopped: () => repeatStopped(run),
        onRequest: id => { run.fillRequestId = id; }
      })
      : { outcome: "failed", filledCount: 0, unconfirmedCount: 0, error: "填写控件不可用。" };
    if (repeat.run !== run) return;
    // Fields may already be written when a stop or failure lands mid-fill: say so, not "空记录".
    const filled = Number.isInteger(result?.filledCount) ? result.filledCount : 0;
    const unconfirmed = Number.isInteger(result?.unconfirmedCount) ? result.unconfirmedCount : 0;
    const kept = filled || unconfirmed
      ? `已新增的 ${added} 条记录会保留，其中 ${filled} 项已确认填写${unconfirmed ? `，${unconfirmed} 项可能已写入但未确认` : ""}，请在网页中核对。`
      : repeatAddedNote(added);
    if (run.stopped || repeatStale(run)) {
      setRepeat(run, "stopped", `${run.invalid || repeatStale(run) || ""}已停止填写。${kept}`, { added });
    } else if (result?.outcome === "success") {
      setRepeat(run, "completed", `已新增${summary}，并完成新字段填写（${result.filledCount} 项）。请核对网页内容。`, { added });
    } else if (result?.outcome === "partial") {
      setRepeat(run, "completed", `已新增${summary}；新字段已填写 ${result.filledCount} 项${result.unconfirmedCount ? `，${result.unconfirmedCount} 项未确认` : ""}，请核对网页内容。`, { added });
    } else {
      const why = result?.error && result.error !== "busy" ? result.error : "填写没有开始";
      setRepeat(run, "failed", `已新增${summary}，但新字段${filled > 0 ? "没有填完" : "没有填写"}：${why}。${kept}`, { added });
    }
  }

  function handlePanelRepeat(message) {
    const action = String(message?.action || "");
    const requestId = typeof message?.requestId === "string" ? message.requestId : "";
    const run = repeat.run;
    const current = run && !run.done && requestId === run.requestId;
    if (action === "start") return startRepeat();
    if (action === "confirm") return confirmRepeat(requestId);
    if (action === "cancel") {
      if (!current || repeat.phase !== "preview") return { ok: false, error: "这个计划已经结束了。" };
      run.stopped = true;
      setRepeat(run, "stopped", "已取消，网页没有变化。");
      return { ok: true };
    }
    if (action === "stop") {
      if (!current || !REPEAT_STOPPABLE.includes(repeat.phase)) return { ok: false, error: "当前没有可以停止的新增。" };
      stopRepeat(run, "已停止，未新增任何条目。");
      return { ok: true };
    }
    if (action === "invalidate") {
      // The side panel switched the template: whatever was planned was for the old one.
      invalidateRepeat("当前模板已切换，计划已失效，请重新预览。");
      return { ok: true };
    }
    if (action === "dismiss") {
      if (repeatActive()) return { ok: false, error: "新增还在进行。" };
      repeat.phase = "idle";
      repeat.requestId = "";
      repeat.message = "";
      repeat.plan = [];
      repeat.added = 0;
      repeat.run = null;
      return { ok: true };
    }
    return { ok: false, error: "当前操作不可用。" };
  }

  // #224「深度分析本页」：编排在 deep-analysis.js，这里只注入本页的能力。大纲、编号和元素的对应
  // 只放在这次分析的内存里；结束、停止或换页后丢掉。#225：「编辑 / 展开 / 新增」先在侧栏预览，
  // 用户确认后由 page-actions.js 逐个执行并核验（新增复用 form-agent.js）。
  let deepController = null;
  let deepHighlighter = null;
  const DEEP_CONSENT_KEY = "deepAnalysisConsent";

  function deepAnalysis() {
    const api = self.ResumeProDeepAnalysis;
    if (!api || !self.ResumeProPageOutline) return null;
    if (!deepController) {
      deepController = api.createController(deepDeps(api));
      // 页面要离开（跳转、刷新、关闭）：深度分析立即停下，后面的点击和填写都不再进行。
      window.addEventListener("pagehide", () => {
        deepHighlighter?.clear();
        deepController?.invalidate("页面正在离开，深度分析已停止。");
      });
    }
    return deepController;
  }

  // 首次说明是否已经同意过：侧栏不读 storage，由这里上报。读取是异步的，先回上一次读到的结果。
  let deepConsentCache = false;
  function deepConsentSeen() {
    try {
      Promise.resolve(chrome.storage.local.get([DEEP_CONSENT_KEY]))
        .then(stored => { deepConsentCache = stored?.[DEEP_CONSENT_KEY]?.version === 1; })
        .catch(() => {});
    } catch {
      // 扩展重新加载后旧页面拿不到 storage：照旧回上一次的结果，开始时还会再查。
    }
    return deepConsentCache;
  }

  function deepActive() {
    return Boolean(deepController?.active());
  }

  function describeDeep() {
    return deepController ? deepController.describe() : { phase: "idle" };
  }

  // 上一次常规一键填写的结果决定入口是否突出显示。辅助新增和深度填写本身的结果不再推荐深度分析。
  function deepOfferLevel() {
    if (!self.ResumeProDeepAnalysis || deepActive() || repeatActive()) return "none";
    const summary = fillSession?.summary || null;
    // #226：本站配方没能用上（过期）时，突出提示可以重新深度分析。按配方填写时，规则扫描看不到的控件
    // （Shadow DOM、框架里的）已经由配方找到，只按有没有没填上的字段判断。
    if (summary?.recipe?.status === "stale" && !summary.assisted) return "prominent";
    if (summary?.recipe?.status === "hit" && !summary.assisted && !summary.deep) {
      try {
        return self.ResumeProDeepAnalysis.offerLevel({ ...summary, probe: null });
      } catch {
        return "secondary";
      }
    }
    if (summary && (summary.assisted || summary.deep)) return "secondary";
    try {
      return self.ResumeProDeepAnalysis.offerLevel(summary);
    } catch {
      return "secondary";
    }
  }

  // 同源框架里的元素属于框架自己的 window：按元素所在的文档取样式，不能拿顶层 window 去算。
  function isVisibleInOwnDocument(element) {
    const view = element?.ownerDocument?.defaultView || window;
    const styles = view.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return styles.display !== "none" && styles.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  // 脱敏用的简历内容：整条值，以及长文本按标点拆开的片段（查看状态的页面常把一段经历拆开显示）。
  function deepResumeValues(resumeFields) {
    const values = [];
    for (const field of resumeFields) {
      const value = String(field?.value ?? "").trim();
      if (!value) continue;
      values.push(value);
      if (value.length > 12) {
        for (const piece of value.split(/[\n\r，。；;,、/|]+/)) if (piece.trim().length >= 4) values.push(piece.trim());
      }
    }
    return values;
  }

  function deepDeps(api) {
    return {
      url: () => location.href,
      newRequestId,
      busy: () => repeatActive() ? "AI 辅助新增正在进行，请先完成或停止。"
        : state.aiBusy ? "已有填写正在进行，请先完成或停止。" : "",
      consented: async () => {
        try {
          const stored = await chrome.storage.local.get([DEEP_CONSENT_KEY]);
          return stored?.[DEEP_CONSENT_KEY]?.version === 1;
        } catch {
          return false;
        }
      },
      acquire: () => { state.aiBusy = true; state.suggestedView = null; },
      release: () => { state.aiBusy = false; },
      async prepare() {
        state.currentStore = await StorageService.getState();
        if (state.desktopMode !== "ready") return { ok: false, error: self.ResumeProResumeData.modeCopy(state.desktopMode).message };
        const template = getActiveTemplate(state.currentStore);
        const profileFields = profileResumeFields();
        if (!template && !profileFields.length) return { ok: false, error: "请先导入简历模板，或在「我的信息」里填写内容。" };
        const templateFields = template ? flattenTemplateFields(template) : [];
        const resumeFields = self.ResumeProProfile ? self.ResumeProProfile.mergeResumeFields(templateFields, profileFields) : templateFields;
        // 新增条目的数量只按桌面模板的记录数算（和「AI 辅助新增条目」一样），「我的信息」不参与。
        return { ok: true, resumeValues: deepResumeValues(resumeFields), templateFields };
      },
      buildOutline: resumeValues => self.ResumeProPageOutline.build(document, {
        isVisible: isVisibleInOwnDocument,
        exclude: element => Boolean(element.closest?.(`#${SIDEBAR_ID}`)),
        resumeValues,
        fieldScan: self.ResumeProFieldScan
      }),
      emptyHint: () => {
        const probe = withFillProbe(probeApi => probeApi.probePage(document, { href: location.href }), null);
        return withFillProbe(probeApi => probeApi.emptyPageHint(probe), "");
      },
      analyze: ({ requestId, text, part, parts }) => self.ResumeProAIClient.send({
        type: "AI_ANALYZE_PAGE", requestId, outline: text, part, parts
      }).catch(() => ({ success: false, error: "无法连接 AI 请求进程，请重新加载扩展后再试。", errorCode: "unavailable" })),
      cancelRequest: requestId => { self.ResumeProAIClient.cancel(requestId).catch(() => {}); },
      toFillInput: (fields, nodes) => withScanBindings(api.toFillInput(fields, nodes, { optionText: getRadioOptionLabel, pickerInputType: inferPickerInputType })),
      planActions: self.ResumeProPageActions && self.ResumeProFormAgent ? planDeepActions : null,
      // #226 站点配方：保存（深度分析效果更好时）、配方模式下找按钮和字段。
      baseline: deepBaseline,
      recipeActionLocators: recipeApi() ? ({ items, outline }) => recipeApi().actionLocators(items, outline) : null,
      recipeSectionLocators: recipeApi() ? ({ sections, outline }) => recipeApi().sectionLocators(sections, outline) : null,
      draftRecipe: recipeApi() ? draftDeepRecipe : null,
      saveRecipe: recipeApi() ? saveDeepRecipe : null,
      onRecipeSaved: info => {
        recipeCache.loaded = false;
        if (fillSession?.summary?.deep) {
          fillSession.summary.recipe = info;
          writeFillDiagnostics({ ...fillSession.summary, unsyncedCount: fillSession.unsynced });
        }
      },
      recipeActions: recipeApi() ? ({ recipe, outline }) => recipeApi().locateActions(recipe, outline) : null,
      recipeFillInput: recipeApi() ? recipeFillInput : null,
      executeActions: (plan, hooks) => self.ResumeProPageActions.executePlan(plan, {
        ...hooks, doc: document, deep: api, describe: self.ResumeProPageOutline.describeButton,
        isVisible: isVisibleInOwnDocument, formAgent: self.ResumeProFormAgent
      }),
      highlight: element => {
        if (!deepHighlighter) deepHighlighter = self.ResumeProPageActions?.createHighlighter() || null;
        if (element) deepHighlighter?.show(element);
        else deepHighlighter?.clear();
      },
      async fill(options) {
        const fillButton = shadowRoot?.querySelector("#resume-pro-ai-fill");
        if (options.mode === "recipe") noteRecipeUse(options.fields ? "hit" : "stale");
        if (!fillButton) return { outcome: "failed", filledCount: 0, unconfirmedCount: 0, unfilledCount: 0, error: "填写控件不可用。" };
        options.report.fillStarted = true;
        // 交给普通一键填写：它自己占用并释放忙碌状态。网页里的填写按钮可能还停在读桌面之前的禁用状态
        // （刷新后的页面不会主动读桌面），先按 prepare() 刚读到的桌面状态重画，和普通填写的入口一致。
        state.aiBusy = false;
        if (shadowRoot?.querySelector("#resume-pro-template-select")) renderSidebar();
        return handleAiFillClick({ currentTarget: fillButton }, null, options);
      },
      onFinish: report => { if (report && !report.fillStarted) writeDeepDiagnostics(report); }
    };
  }

  // #225：说明书（或 #226 配方找到的按钮）→ 动作计划。题目来自大纲，用来认出一个容器里装了两条记录。
  function planDeepActions({ spec, outline, templateFields }) {
    const labels = new Map();
    for (const node of outline.nodes.values()) {
      if (node.type === "control" && node.control?.label) node.elements?.forEach(el => labels.set(el, node.control.label));
    }
    return self.ResumeProPageActions.buildPlan({
      spec, nodes: outline.nodes, titles: outline.titles, redact: outline.redact, templateFields, doc: document,
      formAgent: self.ResumeProFormAgent, deep: self.ResumeProDeepAnalysis, describe: self.ResumeProPageOutline.describeButton,
      isVisible: isVisibleInOwnDocument, labelOf: el => labels.get(el) || ""
    });
  }

  // 普通扫描也认识的控件：沿用它的题目对应关系。填写前的复查、「加到我的信息」的询问都和普通填写一致；
  // 只有深度分析才找到的控件（框架、Shadow DOM 里的）没有这份对应关系，不询问，免得用模型起的题目名存档。
  // scanned：已经扫过的结果（#226 配方补漏时复用同一次扫描）。
  function withScanBindings(prepared, scanned = null) {
    if (!scanned) {
      try {
        scanned = scanFillableFields();
      } catch {
        return prepared;
      }
    }
    const byElement = new Map();
    for (const entry of scanned.fieldMap.values()) {
      const key = entry.kind === "radio" ? entry.elements?.[0] : entry.element;
      if (key) byElement.set(key, entry);
    }
    for (const entry of prepared.fieldMap.values()) {
      const known = byElement.get(entry.kind === "radio" ? entry.elements?.[0] : entry.element);
      if (!known?.binding) continue;
      Object.assign(entry, { binding: known.binding, offerable: known.offerable, offerLabel: known.offerLabel });
    }
    return prepared;
  }

  async function handlePanelDeep(message) {
    const action = String(message?.action || "");
    const requestId = typeof message?.requestId === "string" ? message.requestId : "";
    const controller = deepAnalysis();
    if (!controller) return { ok: false, error: "当前网页无法使用深度分析。" };
    if (action === "start" || action === "consent") {
      if (repeatActive()) return { ok: false, error: "AI 辅助新增正在进行，请先完成或停止。" };
      // 「同意并开始分析」：用户在侧栏的首次说明里点了同意，记住后再开始；记不住就不开始。
      if (action === "consent") {
        try {
          await chrome.storage.local.set({ [DEEP_CONSENT_KEY]: { version: 1 } });
          deepConsentCache = true;
        } catch {
          return { ok: false, error: "没能记住你的选择，请重试。" };
        }
      }
      return controller.start();
    }
    const planId = typeof message?.planId === "string" ? message.planId : "";
    if (action === "stop") return controller.stop(requestId);
    if (action === "confirm") return controller.confirm(requestId, planId);
    if (action === "cancel") return controller.cancel(requestId);
    if (action === "highlight") return controller.highlight(requestId, planId, Number.isInteger(message?.index) ? message.index : -1);
    if (action === "dismiss") return controller.dismiss();
    return { ok: false, error: "当前操作不可用。" };
  }

  // #226 站点配方。配方放在 chrome.storage.local 的 fillRecipes:v1，这里只读；保存、删除、更新最近使用都交给
  // 后台排队写入（两个网页同时保存也不会互相覆盖）。侧栏只看得到「本站有没有配方」，看不到网址和配方内容。
  // 配方是可以重新生成的本机缓存：不上传、不进桌面备份、不随留档或反馈发出。
  let recipeCache = { id: "", loaded: false, recipe: null, lastUse: "" };
  let recipeCacheLoading = null;
  // 同一页面上一次普通一键填写核验后的填写数（深度分析比较效果用）。只在本页内存里，换了网址不算。
  let lastPlainFill = null;

  function recipeApi() {
    return self.ResumeProPageRecipe && self.ResumeProPageOutline && self.ResumeProDeepAnalysis ? self.ResumeProPageRecipe : null;
  }

  function currentRecipeKey() {
    const api = recipeApi();
    if (!api) return null;
    const key = api.pageKey(location.href);
    return key.ok ? key : null;
  }

  const recipeId = key => key ? `${key.host}${key.path}` : "";

  async function loadPageRecipe() {
    const api = recipeApi();
    const key = currentRecipeKey();
    if (!api || !key) return { key: null, recipe: null };
    watchRecipes();
    let stored;
    try {
      stored = await chrome.storage.local.get([api.STORAGE_KEY]);
    } catch {
      return { key, recipe: null };
    }
    const recipe = api.lookup(stored?.[api.STORAGE_KEY], key);
    const id = recipeId(key);
    recipeCache = { id, loaded: true, recipe, lastUse: recipeCache.id === id ? recipeCache.lastUse : "" };
    return { key, recipe };
  }

  // 别的网页保存或删除了配方：下次侧栏来问状态时重新读。第一次读配方时才开始监听。
  let recipeWatching = false;
  function watchRecipes() {
    if (recipeWatching) return;
    recipeWatching = true;
    try {
      chrome.storage?.onChanged?.addListener((changes, area) => {
        if (area === "local" && changes?.[self.ResumeProPageRecipe?.STORAGE_KEY]) recipeCache.loaded = false;
      });
    } catch {
      // 扩展重新加载后的旧页面：状态按需再读。
    }
  }

  // 侧栏状态：有没有本站配方、上一次用的时候是不是过期了。读取是异步的，先回上一次读到的结果。
  function recipeStatus() {
    const key = currentRecipeKey();
    if (!key) return null;
    const id = recipeId(key);
    if (recipeCache.id !== id || !recipeCache.loaded) {
      if (!recipeCacheLoading) {
        recipeCacheLoading = loadPageRecipe().catch(() => null).finally(() => { recipeCacheLoading = null; });
      }
      if (recipeCache.id !== id) return null;
    }
    return { saved: Boolean(recipeCache.recipe), stale: recipeCache.lastUse === "stale" };
  }

  // #429 侧栏的平台提示（见 site-knowledge.js）：同一网址 2 秒内用上次认的，过了再认一次（要读页面特征；单页应用的表单是后画出来的，
  // 也会换掉）。一键填写能替用户传简历时（页面上有空着的简历框，桌面里有放得进去的简历附件）换成说明一键填写会怎么做。
  let siteHintSeen = { href: "", at: 0, text: "" };
  function siteHint() {
    const href = location.href;
    if (siteHintSeen.href === href && Date.now() - siteHintSeen.at < 2000) return siteHintSeen.text;
    let text = "";
    try {
      const knowledge = self.ResumeProSiteKnowledge;
      const platform = knowledge?.detect(document, href) || null;
      const canUpload = platform?.overwrites ? canUploadResume() : false;
      // 还没问到桌面里有没有放得进的简历附件：先照旧显示这个页面上次的那句，不先给一句可能不对的；问到以后下一次再认。
      if (canUpload === null) return siteHintSeen.href === href ? siteHintSeen.text : "";
      text = knowledge?.uploadHint(platform, { canUpload }) || "";
    } catch {
      text = "";
    }
    siteHintSeen = { href, at: Date.now(), text };
    return text;
  }

  // --- #429 第 4 项：一键填写时上传简历附件、证件照 ------------------------------------------
  // 侧栏的一键填写先看页面上的上传框。有要传的文件，就在侧栏列出「哪个文件 → 哪个框 → 哪个网站」，用户点「上传并填写」才传；
  // 每次都问，不记「这个网站以后不用问」。顺序：记下表单现在的值 → 传简历 → 等网站解析完 → 把解析改掉的值改回去 →
  // 照常填写 → 传证件照和其他材料。只改回认得准的框（原来那个框还在，或同一分组里题目唯一），认不准的列出来请用户核对。
  // 网站解析超时、弹出「是否覆盖」这类对话框时不替用户点，停下来说明，记下的值留到下一次一键填写再改回。
  // 文件只在这一次上传期间在内存里，不写 storage，不进诊断、反馈和 AI 请求；诊断里只有计数和固定的原因码。
  // 上传框的题目是网站自己的字，只给侧栏的卡片和结果显示。
  const uploadName = (slot) => slot.title || self.ResumeProUploadSlots?.KIND_NAMES?.[slot.kind] || "上传框";
  const uploadSize = (bytes) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const uploadClip = (text, max = 60) => { const value = String(text ?? "").replace(/\s+/g, " ").trim(); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };

  function uploadOptions() {
    const exclude = (element) => Boolean(element.closest?.(`#${SIDEBAR_ID}`));
    return {
      isVisible,
      exclude,
      describe: (input, root, uploads) => self.ResumeProFieldScan?.uploadItem?.(input, root, { isVisible, exclude, uploads }) || null
    };
  }

  function uploadDocs() {
    return fillDocuments().map(({ doc }) => doc);
  }

  function findUploadSlots() {
    const api = self.ResumeProUploadSlots;
    if (!api) return [];
    const options = uploadOptions();
    const slots = [];
    for (const doc of uploadDocs()) {
      try {
        slots.push(...api.find(doc, options));
      } catch {
        // 这一份文档读不了，就不看它的上传框。
      }
    }
    slots.forEach((slot, index) => { slot.id = `upload-${index}`; });
    return slots;
  }

  const UPLOAD_PLANNED = ["resume", "photo", "transcript"];
  // 后台对「每个框放哪份文件」不是 ok 时，框不传的原因。别的 status（unavailable、超时、没装、没配对）算桌面连不上。
  const PLAN_REASONS = { unsupported: "desktop_old", invalid_payload: "plan_invalid", forbidden: "plan_forbidden", stopped: "plan_stopped" };
  // 问后台每个框放哪份文件、取一份文件，各最多等多久：桌面卡住时一键填写和平台提示不能一直挂着。
  const UPLOAD_ASK_MS = 5000;
  const UPLOAD_FETCH_MS = 60000;
  // 平台提示里「能不能先传简历」最多用多久：桌面里的附件变了没有消息过来，过了这么久再问一次。
  const UPLOAD_HINT_MS = 15000;

  // 问后台：最多等 ms 毫秒，到时没回按「桌面暂时连不上」（unavailable）；stopped() 为真（用户按了停止）也不再等。
  function askDesktop(message, ms, stopped = () => false) {
    return new Promise((resolve) => {
      let timer = null;
      let poll = null;
      let settled = false;
      const finish = (reply) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        window.clearInterval(poll);
        resolve(reply);
      };
      timer = window.setTimeout(() => finish({ status: "unavailable" }), ms);
      poll = window.setInterval(() => { if (stopped()) finish({ status: "stopped" }); }, 200);
      Promise.resolve().then(() => chrome.runtime.sendMessage(message)).then(finish, () => finish({ status: "unavailable" }));
    });
  }

  // 每个上传框放桌面里的哪份文件，问后台：页面只说框要什么（类别、收的格式、大小上限、语言），后台按桌面里的文件挑，
  // 回每个框的文件编号或不传的原因（文件都太大时带上最小的大小）。文件名、标签这些不给页面，卡片上的由侧栏自己读。
  async function planDesktopFiles(slots, templateId) {
    const wanted = slots.filter((slot) => UPLOAD_PLANNED.includes(slot.kind) && !slot.hasFile);
    if (!wanted.length) return { status: "ok", slots: [] };
    const reply = await askDesktop({ type: "DESKTOP_RESUME_FILES_PLAN", templateId,
      slots: wanted.map((slot) => ({ id: slot.id, kind: slot.kind, accept: slot.accept, limit: slot.limit, language: slot.language || [] })) },
    UPLOAD_ASK_MS);
    if (reply?.status === "ok" && Array.isArray(reply.slots)) return { status: "ok", slots: reply.slots };
    return { status: typeof reply?.status === "string" && reply.status ? reply.status : "unavailable", slots: [] };
  }

  // 平台提示的缓存按什么认：空着的简历框要什么、当前模板、桌面连没连上。换了模板、桌面连上或断开，都重新问。
  function uploadHintKey(slots) {
    return JSON.stringify([getActiveTemplate(state.currentStore)?.id || "", state.desktopMode || "",
      slots.map((slot) => [slot.accept, slot.limit, slot.language])]);
  }

  // 后台对这些简历框的回答里，有没有能放进去的简历附件（自动选上的，或几份里请用户选）。
  function resumeFits(planned) {
    return planned.status === "ok" && planned.slots.some((item) => item.fileId || item.reason === "choose");
  }

  // 一键填写能不能替用户传简历（侧栏提示用）：页面上有空着的简历框，桌面里有能放进去的简历附件（和 prepareUpload 同一套挑法：
  // 当前模板能用、框收这种格式、不超过上限）。同样的框 15 秒问一次后台，点一键填写时也会更新；问的时候照旧用上次问到的，
  // 还没问到时返回 null（还不知道）。
  function canUploadResume() {
    let slots;
    try {
      slots = findUploadSlots().filter((slot) => slot.kind === "resume" && !slot.hasFile);
    } catch {
      return false;
    }
    if (!slots.length) return false;
    const key = uploadHintKey(slots);
    if ((key !== uploadHintSeen.key || Date.now() - uploadHintSeen.at > UPLOAD_HINT_MS) && !uploadHintSeen.asking) {
      const seq = (uploadHintSeq += 1);
      uploadHintSeen.asking = true;
      const done = (value) => {
        if (seq !== uploadHintSeq) return;
        uploadHintSeen = { key, at: Date.now(), asking: false, value };
      };
      planDesktopFiles(slots, getActiveTemplate(state.currentStore)?.id || "").then((planned) => done(resumeFits(planned)), () => done(false));
    }
    return uploadHintSeen.key === key ? uploadHintSeen.value : null;
  }

  // 卡片开着时网页换了地址（单页应用跳走）：卡片作废，请用户重新点。
  function dropStaleUpload() {
    if (upload.phase === "offer" && location.href !== upload.href) {
      upload.phase = "idle";
      upload.plan = [];
      releaseUploadCard();
    }
  }

  // 告诉后台：这张卡片的确认还剩下的都不要了（网页换了地址，或者这次上传结束了）。后台按地址和卡片也会核对，这里是多一道。
  function releaseUploadCard() {
    const card = `${upload.epoch}:${upload.version}`;
    Promise.resolve().then(() => chrome.runtime.sendMessage({ type: "DESKTOP_RESUME_FILES_RELEASE", card })).catch(() => {});
  }

  // 记下表单现在的样子：每个框的值（比较用）和能写回去的文字（改回用；读不准的控件是 null）。只在这个页面的内存里。
  function recordFormValues() {
    let scanned;
    try {
      scanned = scanFillableFields();
    } catch {
      return [];
    }
    return scanned.fields.flatMap((field) => {
      const entry = scanned.fieldMap.get(field.fieldId);
      if (!entry) return [];
      const filled = hasExistingValue(entry);
      return [{ entry, label: field.label || field.placeholder || "未命名字段", snapshot: fillValueSnapshot(entry),
        filled, value: filled ? restorableValue(entry) : null }];
    });
  }

  // 能原样写回去的值：文本框、日期框的文字，单选、原生下拉、单选下拉选中的那一项。多选、级联、勾选读不准，不写回。
  function restorableValue(entry) {
    try {
      if (entry.kind === "radio") {
        const checked = entry.elements.find(radioChecked);
        if (!checked) return null;
        return (isInputElement(checked) ? getRadioOptionLabel(checked) : checked.textContent.trim()) || null;
      }
      const el = entry.element;
      if (entry.controlKind === "cascader") return null;
      if (entry.controlKind === "custom-select") {
        const texts = self.ResumeProCustomControls?.readSelection?.(entry)?.texts || [];
        return texts.length === 1 && texts[0] ? texts[0] : null;
      }
      if (el.type === "checkbox" || el.type === "radio") return null;
      if (isSelectElement(el)) return el.multiple ? null : el.options[el.selectedIndex]?.text?.trim() || null;
      return String(el.value ?? "");
    } catch {
      return null;
    }
  }

  // 记下的框现在在哪：还是原来那个（还在原来的题目下），或者页面重画后同一分组里题目、序号都对得上的唯一一个。认不出是 null。
  // 页面只扫一遍，按 rebindFieldEntry 同样的条件（控件类型、区块、题目、同名题目的序号和总数）对。
  function locateRecords(records) {
    let fresh = null;
    const byKey = () => {
      if (fresh) return fresh;
      fresh = new Map();
      try {
        const scanned = scanFillableFields();
        for (const entry of scanned.fieldMap.values()) {
          const key = fieldBindingKey(entry.binding);
          if (!key || entry.deepRef) continue;
          fresh.set(key, fresh.has(key) ? null : entry);
        }
      } catch { /* 扫不了就都认不出 */ }
      return fresh;
    };
    return records.map((record) => {
      const node = record.entry.kind === "radio" ? record.entry.elements?.[0] : record.entry.element;
      if (node?.isConnected && !documentGone(entryDocument(record.entry)) && isFieldBindingCurrent(record.entry)) return record.entry;
      const key = fieldBindingKey(record.entry.binding);
      return key ? byKey().get(key) || null : null;
    });
  }

  // 停下来时记下的值留到下一次一键填写：records 是传简历之前的样子，stopValues 是停下那一刻每个框的值。
  // edited(index, entry, record) 为真的框是用户等解析时自己动过的，记成 UPLOAD_EDITED，下一次不改回。
  // 接着上次的记录又停下时，上次停下以后变过的框认不准是谁改的，记成 UPLOAD_UNSURE，也不改回。
  function keepPending(records, edited = () => false) {
    const earlier = upload.pending?.records === records ? upload.pending.stopValues || null : null;
    let located = [];
    try {
      located = locateRecords(records);
    } catch {
      located = [];
    }
    const stopValues = records.map((record, index) => {
      if ([UPLOAD_EDITED, UPLOAD_UNSURE].includes(earlier?.[index])) return earlier[index];
      if (edited(index, located[index], record)) return UPLOAD_EDITED;
      let value = null;
      try { value = located[index] ? fillValueSnapshot(located[index]) : null; } catch { value = null; }
      return earlier && earlier[index] !== value ? UPLOAD_UNSURE : value;
    });
    upload.pending = { href: upload.href, records, at: Date.now(), stopValues };
  }

  // 原来那个框还在网页上、值和记下的一样（框只是暂时对不上，比如分步显示时被藏起来了）：没被改过，不用改回，也不用列出来。
  // 框已经不在网页上、读不到值的，认不准，照旧当找不到。
  function uploadUnchanged(record) {
    try {
      const now = fillValueSnapshot(record.entry);
      return now !== null && now === record.snapshot;
    } catch {
      return false;
    }
  }

  // 上次被打断的值，还在这一页、没过期，并且有用户原来填的框被改了：下一次一键填写先改回能改回的（卡片里先说）。分四种：
  // labels 改回（和用户原来填的不一样、和停下那一刻一样：是网站解析改的）；later 不改回（停下以后又变过：可能是用户自己改的，
  // 也可能是网站后来写的，认不准）；edited 不改回（等解析时用户自己动过）；missed 找不到原来的框、又变过或读不到。
  function pendingRestore() {
    const pending = upload.pending;
    if (!pending || pending.href !== location.href || Date.now() - pending.at > UPLOAD_PENDING_MS) {
      upload.pending = null;
      return null;
    }
    const located = locateRecords(pending.records);
    const labels = [];
    const later = [];
    const edited = [];
    const missed = [];
    pending.records.forEach((record, index) => {
      if (!record.filled) return;
      const entry = located[index];
      if (!entry) {
        // 找不到原来的框：值没变过（框只是暂时看不见，比如分步显示）就不算，变过或读不到才列出来。
        if (!uploadUnchanged(record)) missed.push(record.label);
        return;
      }
      const now = fillValueSnapshot(entry);
      if (now === record.snapshot) return;
      if (pending.stopValues?.[index] === UPLOAD_EDITED) edited.push(record.label);
      else if (now === pending.stopValues?.[index]) labels.push(record.label);
      else later.push(record.label);
    });
    if (!labels.length && !later.length && !edited.length && !missed.length) {
      upload.pending = null;
      return null;
    }
    return { ...pending, labels, later, edited, missed };
  }

  // 上次被打断的值里改不回的：结果里请用户核对。
  function pendingNotes(pending) {
    return [
      ...(pending?.edited?.length ? [`上次等网站解析时你改过这几项，没有改回，请核对：${summarizeLabels(pending.edited)}。`] : []),
      ...(pending?.later?.length ? [`这几项在上次停下以后又变过，没有改回，请核对：${summarizeLabels(pending.later)}。`] : []),
      ...(pending?.missed?.length ? [`上次被网站解析改掉的这几项找不到原来的框，没有改回，请核对：${summarizeLabels(pending.missed)}。`] : [])
    ];
  }

  // 卡片上「会改回哪些」：已知会覆盖的平台上要传简历、页面上已经有内容时先说；上次被打断的，说那次被改掉的。
  // 不改回的（停下以后又变过、等解析时用户改过）合在一起说。
  function uploadPreview(plan, pending) {
    if (pending) {
      const kept = [...pending.edited, ...pending.later];
      return { count: pending.labels.length, labels: pending.labels.slice(0, 5), pending: true,
        laterCount: kept.length, later: kept.slice(0, 5) };
    }
    const resume = plan.some((item) => item.fileId && item.slot.kind === "resume");
    if (!resume || !upload.platform?.overwrites) return null;
    const labels = recordFormValues().filter((record) => record.filled).map((record) => record.label);
    return labels.length ? { count: labels.length, labels: labels.slice(0, 5), pending: false } : null;
  }

  // 侧栏点一键填写时先看上传框。有要传的文件、要用户选的，或上次被打断记着要改回的值，就在侧栏出确认卡片，返回 true；
  // 没有就照常填写，能说明的（桌面旧、这类文件桌面里还没有、框里已经有文件、认不出要什么）写进结果。
  async function prepareUpload(store) {
    const api = self.ResumeProUploadSlots;
    upload.result = null;
    upload.report = null;
    upload.reportForFill = false;
    upload.planStatus = "none";
    upload.phase = "idle";
    upload.plan = [];
    upload.pendingNotes = [];
    // 上传框的辅助脚本没加载（它不是内容脚本的必需依赖）：只关掉上传，照常填写，诊断里记一笔。
    if (!api) {
      upload.report = { ...uploadReport([], null, null, []), reasons: { upload_helper_missing: 1 } };
      upload.reportForFill = true;
      return false;
    }
    const slots = findUploadSlots();
    const pending = pendingRestore();
    if (!slots.length && !pending) return false;
    const templateId = getActiveTemplate(store)?.id || "";
    const planned = await planDesktopFiles(slots, templateId);
    upload.planStatus = /^[a-z_]{1,32}$/.test(planned.status) ? planned.status : "unavailable";
    const answers = new Map(planned.slots.filter((item) => typeof item?.id === "string").map((item) => [item.id, item]));
    // 点一键填写时问到的回答也更新平台提示：桌面里的附件刚换过的话，提示跟着变，不用等缓存过期。
    const resumeSlots = slots.filter((slot) => slot.kind === "resume" && !slot.hasFile);
    if (resumeSlots.length) {
      // 这是最新的回答：还在路上的那次平台提示的回答回来时已经过期，丢掉（见 canUploadResume）。
      uploadHintSeq += 1;
      uploadHintSeen = { key: uploadHintKey(resumeSlots), at: Date.now(), asking: false,
        value: resumeFits({ status: planned.status, slots: resumeSlots.map((slot) => answers.get(slot.id)).filter(Boolean) }) };
    }
    let platform = null;
    try {
      platform = self.ResumeProSiteKnowledge?.detect(document, location.href) || null;
    } catch {
      platform = null;
    }
    const plan = slots.map((slot) => {
      if (slot.hasFile) return { slot, fileId: null, reason: slot.fileUnsure ? "file_unsure" : "has_file" };
      // 后台的回答不是 ok：按原因分开（桌面太旧、请求不对、后台不认这个发件人、停下了），只有连不上和超时才算桌面连不上。
      // 原来的 status 另外记进诊断（upload.planStatus）。
      if (planned.status !== "ok") return { slot, fileId: null, reason: PLAN_REASONS[planned.status] || "desktop_unavailable" };
      if (!UPLOAD_PLANNED.includes(slot.kind)) return { slot, fileId: null, reason: slot.reason || "unknown_kind" };
      const answer = answers.get(slot.id);
      const fileId = typeof answer?.fileId === "string" && /^[\w-]{1,64}$/.test(answer.fileId) ? answer.fileId : null;
      return { slot, fileId, reason: fileId ? "" : typeof answer?.reason === "string" && /^[a-z_]{1,32}$/.test(answer.reason) ? answer.reason : "no_file",
        ...(Number.isInteger(answer?.byteSize) && answer.byteSize > 0 ? { byteSize: answer.byteSize } : {}) };
    });
    // 会覆盖的平台每传一次简历都会再解析一遍：自动只传一份简历，别的简历框由用户在卡片里自己定。
    if (platform?.overwrites) {
      let seen = false;
      for (const item of plan) {
        if (!item.fileId || item.slot.kind !== "resume") continue;
        if (seen) Object.assign(item, { fileId: null, reason: "one_resume" });
        seen = true;
      }
    }
    upload.platform = platform;
    upload.href = location.href;
    upload.plan = plan;
    // 上次被打断的值里有能改回的才留着（卡片上问）；只剩改不回的，结果里请用户核对，记录不再留。
    const restorable = pending && pending.labels.length ? pending : null;
    upload.pending = restorable ? { href: pending.href, records: pending.records, at: pending.at, stopValues: pending.stopValues } : null;
    if (!plan.some((item) => item.fileId || item.reason === "choose") && !restorable) {
      const lines = [...plan.map((item) => uploadLine(item)).filter(Boolean), ...pendingNotes(pending)];
      upload.result = lines.length ? { lines, tone: pending ? "warn" : "info" } : null;
      upload.phase = upload.result ? "done" : "idle";
      // 没出卡片也把每个框为什么没传记进这次填写的诊断（框的类别和原因码）。
      if (plan.length) {
        upload.report = uploadReport(plan.map((item) => ({ slot: item.slot, file: null, reason: item.reason })), null, null, []);
        upload.reportForFill = true;
      }
      return false;
    }
    upload.pendingNotes = restorable ? [] : pendingNotes(pending);
    upload.preview = uploadPreview(plan, restorable);
    upload.phase = "offer";
    upload.version += 1;
    return true;
  }

  // 侧栏卡片要的：网站、每个上传框（题目、认成什么、收什么、上限、建议的文件），会改回哪些。文件名、大小侧栏自己向后台读。
  function uploadSnapshot() {
    dropStaleUpload();
    if (upload.phase === "offer") {
      return {
        phase: "offer", version: upload.version, epoch: upload.epoch, host: location.host,
        platform: upload.platform?.overwrites ? upload.platform.name : "",
        slots: upload.plan.map((item) => ({ id: item.slot.id, title: item.slot.title, kind: item.slot.kind, reason: item.reason || "",
          fileId: item.fileId || "", accept: item.slot.accept, limit: item.slot.limit, siteLimit: item.slot.siteLimit })),
        restore: upload.preview
      };
    }
    if (upload.phase === "running") return { phase: "running", version: upload.version, epoch: upload.epoch, step: upload.step };
    if (upload.phase === "done" && upload.result) {
      // 结果是那一页的：单页应用换了页面就不再给侧栏，免得把上一页的「已上传」当成这一页的。
      if (location.href !== upload.href) {
        upload.phase = "idle";
        upload.result = null;
        return null;
      }
      return { phase: "done", version: upload.version, epoch: upload.epoch, host: location.host, lines: upload.result.lines,
        tone: upload.result.tone, addFiles: upload.plan.some((item) => item.reason === "no_file") };
    }
    return null;
  }

  // 一个上传框的结果写成一句话。outcome 是这次上传的结果；没有时说为什么没传。
  function uploadLine(item) {
    const name = uploadName(item.slot);
    const file = item.file?.name || "";
    const outcome = item.outcome || null;
    const kinds = self.ResumeProUploadSlots?.KIND_NAMES || {};
    if (outcome) {
      switch (outcome.code) {
        case "done": return `${name}：已上传 ${file}。`;
        case "error": return outcome.message ? `${name}：网站提示「${uploadClip(outcome.message)}」，没有传上。` : `${name}：没有传上，请看一下网页。`;
        case "dialog": return `${name}：网站弹出了「${uploadClip(outcome.message)}」，请在网页上处理。`;
        case "uploading": case "unconfirmed": case "none": return `${name}：传了 ${file}，没确认网站收到，请看一下网页。`;
        case "has_file": return `${name}：已经有文件了，没有替换。`;
        case "file_unsure": return `${name}：框里像是已经有文件了，没有上传，请看一下网页。`;
        case "slot_changed": case "slot_gone": return `${name}：上传框已经变了，没有上传。`;
        // 卡片作废：结果第一句已经说了，不再一个框一个框地说。
        case "card_void": return "";
        case "not_fit": return `${name}：选的文件放不进这个框，没有上传。`;
        case "fetch_conflict": return `${name}：桌面里的这个文件换过或删掉了，没有上传。`;
        case "fetch_corrupt": return `${name}：从桌面读出来的文件不完整，没有上传。`;
        case "fetch_not_confirmed": return `${name}：没有在侧栏确认，没有上传。`;
        case "fetch_wrong_template": return `${name}：这个文件只给别的简历模板用，没有上传。`;
        case "unsupported": case "rejected": return `${name}：这个上传框不能自动上传，请自己上传。`;
        case "stopped": case "not_reached": return `${name}：没有上传。`;
        default: return `${name}：没能从桌面取到文件，没有上传。`;
      }
    }
    switch (item.reason) {
      case "has_file": return `${name}：已经有文件了，没有替换。`;
      case "file_unsure": return `${name}：框里像是已经有文件了，没有上传，请看一下网页。`;
      case "desktop_old": return `${name}：桌面程序版本较旧，不能上传文件；更新桌面程序，或者自己上传。`;
      case "desktop_unavailable": return `${name}：桌面暂时连不上，没有上传。`;
      case "plan_invalid": case "plan_forbidden": case "plan_stopped": return `${name}：插件没能处理这个上传框，没有上传，请自己上传。`;
      case "no_file": return `这页要${kinds[item.slot.kind] || "文件"}，桌面里还没有。到桌面「简历资料 › 附件」添加，或者自己上传。`;
      case "too_large": return item.slot.siteLimit
        ? `${name}：网站要求不超过 ${uploadSize(item.slot.limit)}，桌面里的文件 ${uploadSize(item.byteSize || 0)}，没有上传。`
        : `${name}：桌面里的文件太大，没有上传。`;
      case "not_accepted": return `${name}：网站不收桌面里这类文件的格式，没有上传。`;
      case "one_resume": return `${name}：这个网站每传一次简历都会重新解析，这一份没有传。`;
      case "other_kind": return `${name}：插件只传简历附件、证件照和成绩单，这一项请自己上传。`;
      case "choose": case "not_chosen": return `${name}：没有选文件，没有上传。`;
      case "unknown_kind": case "ambiguous_kind": case "accept_mismatch": case "style_mismatch": return `${name}：认不出要什么文件，没有上传。`;
      default: return "";
    }
  }

  // 侧栏卡片上的操作：confirm（上传并填写）、fill（只填写）、cancel、dismiss（收起结果）。
  // 确认时带上卡片的版本和每个框选的文件；页面只认卡片上那一份，换了网址、过期的不认。
  async function handlePanelUpload(message) {
    const action = String(message?.action || "");
    if (action === "dismiss") {
      if (upload.phase === "done") { upload.phase = "idle"; upload.result = null; }
      return { ok: true };
    }
    if (upload.phase === "running") return { ok: false, error: "正在上传文件，请稍候。" };
    if (upload.phase !== "offer" || message?.version !== upload.version || message?.epoch !== upload.epoch) {
      return { ok: false, error: "这张卡片已经过期，请重新点一键填写。" };
    }
    if (location.href !== upload.href) {
      upload.phase = "idle";
      releaseUploadCard();
      return { ok: false, error: "网页已经变了，请重新点一键填写。" };
    }
    if (action === "cancel") {
      upload.phase = "idle";
      upload.plan = [];
      upload.preview = null;
      upload.platform = null;
      return { ok: true };
    }
    if (action === "fill") {
      // 「只填写，不改回」：上次被网站改掉的值这次不改回，记录也不留（留着的话，下一次会把这次填好的又改回去），结果里写明。
      const skipped = upload.pending && upload.preview?.pending ? upload.preview : null;
      upload.pending = null;
      upload.phase = "idle";
      upload.plan = [];
      upload.preview = null;
      upload.platform = null;
      const more = (list, count) => `${list.join("、")}${count > list.length ? " 等" : ""}`;
      const lines = [
        ...(skipped ? [`这次没有改回上次被网站改掉的 ${skipped.count} 项，请核对：${more(skipped.labels, skipped.count)}。`] : []),
        ...(skipped?.laterCount ? [`后来又改过的这几项也没有改回，请核对：${more(skipped.later, skipped.laterCount)}。`] : []),
        ...upload.pendingNotes
      ];
      upload.pendingNotes = [];
      if (lines.length) {
        upload.result = { lines, tone: "warn" };
        upload.phase = "done";
      }
      return startPanelFill();
    }
    if (action !== "confirm") return { ok: false, error: "当前操作不可用。" };
    const picked = new Map((Array.isArray(message.choices) ? message.choices : [])
      .filter((choice) => typeof choice?.slot === "string" && typeof choice?.fileId === "string" && choice.fileId)
      .map((choice) => [choice.slot, choice.fileId]));
    const items = upload.plan.map((item) => {
      const fileId = picked.get(item.slot.id) || "";
      return { ...item, file: fileId ? { fileId } : null, reason: fileId ? "" : item.reason === "choose" || (item.fileId && !fileId) ? "not_chosen" : item.reason };
    });
    // 选了文件的框要是这张卡片上的、框里还没有文件、桌面连得上。文件放不放得进这个框（类型、大小），取到文件时按它本身再核对。
    const blocked = ["has_file", "file_unsure", "desktop_old", "desktop_unavailable", "plan_invalid", "plan_forbidden", "plan_stopped"];
    if ([...picked].some(([slotId, fileId]) => {
      const planned = upload.plan.find((item) => item.slot.id === slotId);
      return !planned || !/^[\w-]{1,64}$/.test(fileId) || planned.slot.hasFile || blocked.includes(planned.reason);
    })) {
      return { ok: false, error: "选的文件放不进对应的上传框，请重新选。" };
    }
    if (!items.some((item) => item.file) && !upload.pending) return { ok: false, error: "没有选要上传的文件。" };
    upload.phase = "running";
    runUpload(items).catch(() => {});
    return { ok: true };
  }

  // 「只填写」和上传之后的填写：和侧栏点一键填写一样，从「一键 AI 填写」按钮开始。
  function startPanelFill() {
    const button = shadowRoot?.querySelector("#resume-pro-ai-fill");
    if (!button || button.hidden || button.disabled) return { ok: false, error: "桌面简历当前不可用。" };
    panelFillStarting = true;
    try { button.click(); } finally { panelFillStarting = false; }
    return { ok: true };
  }

  async function fillAfterUpload(button) {
    button.disabled = false;
    panelFillStarting = true;
    let running;
    try {
      running = handleAiFillClick({ currentTarget: button });
    } finally {
      panelFillStarting = false;
    }
    return running;
  }

  // 取一份用户在这张卡片上确认过的文件：后台只认这一页、这张卡片（这次加载的 epoch 和卡片版本）、确认过的那一版。
  // 回来的有内容，还有把它交给网站要用的文件名、类型、大小，和用来核对放不放得进框的类别。
  // 最多等 UPLOAD_FETCH_MS（10 MB 的文件在桌面上读完大约要 7 秒）；用户按了停止就不再等。
  async function fetchDesktopFile(fileId, card) {
    const reply = await askDesktop({ type: "DESKTOP_RESUME_FILE_FETCH", fileId, card }, UPLOAD_FETCH_MS, () => upload.stop);
    if (reply?.status !== "ok" || typeof reply.bytesBase64 !== "string") return { status: String(reply?.status || "unavailable") };
    const max = self.ResumeProUploadSlots?.MAX_FILE_BYTES || 0;
    if (typeof reply.name !== "string" || !reply.name || reply.name.length > 255 || typeof reply.mime !== "string" || typeof reply.kind !== "string"
      || !Number.isInteger(reply.byteSize) || reply.byteSize <= 0 || reply.byteSize > max) return { status: "corrupt" };
    try {
      const binary = atob(reply.bytesBase64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      if (bytes.length !== reply.byteSize) return { status: "corrupt" };
      return { status: "ok", meta: { name: reply.name, mime: reply.mime, kind: reply.kind, byteSize: reply.byteSize },
        file: new File([bytes], reply.name, { type: reply.mime, lastModified: Date.parse(reply.updatedAt) || Date.now() }) };
    } catch {
      return { status: "corrupt" };
    }
  }

  // 等网站解析时用户自己动过的框：记下用户按下、按键、输入、粘贴、拖放落在哪里（网站和插件用脚本发的事件不算）。
  // 动过的框不改回，也不算网站解析填的。自定义下拉的选项常常画在别处，所以连同点开它的那一下（落在组件里）一起算。
  function watchUserEdits(docs) {
    const nodes = new Set();
    const trusted = uploadClock.trusted || ((event) => event.isTrusted === true);
    const note = (event) => {
      if (!trusted(event)) return;
      const target = event.composedPath?.()[0] || event.target;
      const element = target?.nodeType === 1 ? target : target?.parentElement;
      if (element) nodes.add(element);
    };
    const types = ["pointerdown", "mousedown", "keydown", "input", "change", "paste", "drop"];
    const attached = [];
    for (const doc of docs) {
      for (const type of types) {
        try {
          doc.addEventListener(type, note, true);
          attached.push([doc, type]);
        } catch { /* 文档没了 */ }
      }
    }
    const touched = (entry) => {
      if (!entry || !nodes.size) return false;
      const own = [entry.element, ...(entry.elements || [])].filter(Boolean);
      const areas = [...own, ...(entry.root?.nodeType === 1 ? [entry.root] : [])];
      for (const node of nodes) {
        if (areas.some((area) => area === node || area.contains?.(node))) return true;
        const label = node.closest?.("label");
        if (label?.control && own.includes(label.control)) return true;
      }
      return false;
    };
    return {
      touched,
      stop() {
        for (const [doc, type] of attached) {
          try { doc.removeEventListener(type, note, true); } catch { /* 文档没了 */ }
        }
        attached.length = 0;
      }
    };
  }

  // 文件已经交给框以后的结果。等的时候按了停止，文件也已经交给网页了：算没确认，不算没传。
  function uploadOutcome(seen) {
    return { code: ["done", "error", "dialog"].includes(seen.state) ? seen.state : "unconfirmed", message: seen.message || "" };
  }

  // 等解析时侧栏的进度：已知会解析覆盖的平台先说大约要多久（至少等这么久），过了这个时间说最多等多久；别的网站说最多等多久。
  function parseStep(timing, ms, changed = false) {
    const seconds = (value) => Math.max(1, Math.round(value / 1000));
    const waited = Math.floor(ms / 1000);
    // 别的网站：表单值变过才把上限放宽，没变过的上限是 maxMs。
    if (!timing.known) return `正在等网站处理简历，已等 ${waited} 秒，最多 ${seconds(changed ? timing.extendMs : timing.maxMs)} 秒…`;
    return ms < timing.minMs ? `正在等网站解析简历，大约 ${seconds(timing.minMs)} 秒（已等 ${waited} 秒）…`
      : `正在等网站解析简历，已等 ${waited} 秒，最多 ${seconds(timing.maxMs)} 秒…`;
  }

  // 等解析时读记下的框现在的值，每次都对到页面上现在的框：整张表重画了，读的是新框的值，不拿已经不在页面上的旧框比。
  // 上一次对上的框都还在页面上就接着用；有框没了，或者还有对不上的（每秒最多一次），才按 locateRecords 重新对。
  // 每个值带上框的编号：换成了新框也算变化。对不上的记成「?」：从对得上变成对不上（或反过来）也算变化，一直对不上就不算。
  function parseValues(records) {
    const ids = new WeakMap();
    let next = 0;
    const idOf = (node) => {
      if (!ids.has(node)) ids.set(node, (next += 1));
      return ids.get(node);
    };
    const onPage = (entry) => Boolean(uploadNode(entry)?.isConnected) && !documentGone(entryDocument(entry));
    let bound = records.map((record) => record.entry);
    let boundAt = -Infinity;
    // 每个记录先后对到过的框，第一个是传简历之前那个：用户在网站重画之前的旧框里动过，也认得出（见 runUpload 的 edited）。
    const history = new Map(records.map((record) => [record, record.entry ? [record.entry] : []]));
    const values = () => {
      const lost = bound.some((entry) => entry && !onPage(entry));
      const unbound = bound.some((entry) => !entry) && uploadClock.now() - boundAt >= 1000;
      if (lost || unbound) {
        try {
          bound = locateRecords(records);
        } catch {
          bound = records.map(() => null);
        }
        boundAt = uploadClock.now();
        bound.forEach((entry, index) => {
          const seen = history.get(records[index]);
          if (entry && seen && !seen.some((old) => uploadNode(old) === uploadNode(entry))) seen.push(entry);
        });
      }
      return bound.map((entry) => {
        if (!entry) return "?";
        try {
          return `${idOf(uploadNode(entry))}:${fillValueSnapshot(entry) ?? "∅"}`;
        } catch {
          return "?";
        }
      }).join("\u0001");
    };
    values.history = (record) => history.get(record) || (record?.entry ? [record.entry] : []);
    return values;
  }

  // 等解析时每 200ms 读一次：记下的框现在的值（见 parseValues，加上页面上输入框的个数）、网页忙不忙、
  // 有没有新弹出的对话框、简历框传得怎么样。
  function readParse(values, sent, docs, baseline = null) {
    const api = self.ResumeProUploadSlots;
    const now = uploadClock.now();
    const states = sent.map((item) => api.state(item.slot, item.file.name, item.seen, docs, isVisible, { now }));
    const dialog = states.find((seen) => seen.state === "dialog");
    let controls = 0;
    for (const doc of docs) {
      try { controls += doc.querySelectorAll("input, select, textarea").length; } catch { /* 文档没了 */ }
    }
    return {
      signature: `${controls}\u0001${values()}`,
      busy: api.busy(docs, isVisible, (element) => Boolean(element.closest?.(`#${SIDEBAR_ID}`)), baseline),
      dialog: dialog ? dialog.message || "对话框" : "",
      upload: states.some((seen) => seen.state === "error") ? "error"
        : states.some((seen) => seen.state === "uploading") ? "uploading"
          : states.length && states.every((seen) => seen.state === "done") ? "done" : "none"
    };
  }

  // 把网站解析改掉的、用户原来填的值写回去。只写认得准的框；读不准原值的控件（多选、级联、勾选）、找不到的框列出来请用户核对。
  // edited(index, entry, record) 为真的框是用户等解析时自己动过的：不写，列出来（edited）。
  // stopValues：上次停下那一刻每个框的值（接着上次被打断的改回时才有）。停下以后又变过的框，可能是用户自己改的，
  // 也可能是网站后来写的，认不准：不写，列出来（later）。中途停下时，还没看的已填项列出来（left）。
  async function restoreFormValues(records, stopValues = null, edited = () => false) {
    const out = { restored: [], missed: [], later: [], edited: [], left: [] };
    const located = locateRecords(records);
    for (const [index, record] of records.entries()) {
      if (upload.stop || location.href !== upload.href) {
        out.left.push(...records.slice(index).filter((item) => item.filled).map((item) => item.label));
        break;
      }
      if (!record.filled) continue;
      const entry = located[index];
      if (!entry) {
        if (uploadUnchanged(record)) continue;
        out.missed.push(record.label);
        continue;
      }
      const now = fillValueSnapshot(entry);
      if (now === null || now === record.snapshot) continue;
      if (stopValues?.[index] === UPLOAD_EDITED || edited(index, entry, record)) {
        out.edited.push(record.label);
        continue;
      }
      if (stopValues && now !== stopValues[index]) {
        out.later.push(record.label);
        continue;
      }
      if (record.value === null) {
        out.missed.push(record.label);
        continue;
      }
      // 写之前再看一眼：还是刚才读到的解析结果才写，期间又变了就不碰。
      const guard = (userEdited = false) => !userEdited && fillValueSnapshot(entry) === now && location.href === upload.href;
      let done = false;
      try {
        done = await setElementValue(entry, record.value, guard, () => isFieldBindingCurrent(entry), () => {}, { fill: true });
      } catch {
        done = false;
      }
      if (done && showsFilledValue(entry, record.value)) out.restored.push(record.label);
      else out.missed.push(record.label);
    }
    return out;
  }

  function uploadNode(entry) {
    return entry?.kind === "radio" ? entry.elements?.[0] : entry?.element;
  }

  // 等完以后把整张表再扫一遍：传之前空着的框（包括解析后才冒出来的题目）现在有值的，是网站解析填的，照常填写时有资料就填，
  // 不问要不要覆盖。不算的：传之前用户填过的框（改回已经处理过）、用户等解析时动过的框（touched）、和找不到原来框的已填项同名的框。
  // 接着上次的记录时（stopValues），只算记录里停下以后没再变过的框：停下以后变过的、记录里没有的框，认不准是谁填的。
  function markParsed(records, stopValues = null, touched = () => false) {
    let located = [];
    let scanned;
    try {
      located = locateRecords(records);
      scanned = scanFillableFields();
    } catch {
      return [];
    }
    const known = new Set();
    const skip = new Set();
    const lost = new Set();
    records.forEach((record, index) => {
      const entry = located[index];
      if (!entry) {
        if (record.filled) lost.add(record.label);
        return;
      }
      known.add(uploadNode(entry));
      if (record.filled || (stopValues && fillValueSnapshot(entry) !== stopValues[index])) skip.add(uploadNode(entry));
    });
    const parsed = [];
    for (const field of scanned.fields) {
      const entry = scanned.fieldMap.get(field.fieldId);
      const node = uploadNode(entry);
      if (!entry || !node || skip.has(node) || (stopValues && !known.has(node))) continue;
      const label = field.label || field.placeholder || "未命名字段";
      try {
        if (lost.has(label) || touched(entry) || !hasExistingValue(entry)) continue;
        const snapshot = fillValueSnapshot(entry);
        if (snapshot !== null) parsed.push({ entry, label, snapshot });
      } catch { /* 读不了的框不算 */ }
    }
    return parsed;
  }

  // 填写时：这个框的内容是网站解析填上的、填写开始时还是那个值，就不算用户已有的内容。
  function parsedBySite(entry) {
    const node = uploadNode(entry);
    return Boolean(node) && uploadParsed.has(node) && uploadParsed.get(node) === fillValueSnapshot(entry);
  }

  // 上传结束，把一键填写按钮还回去：上传时写在按钮上的字马上换回来。别的 AI 任务（AI 辅助新增条目、保存岗位时的识别）
  // 这时正占着忙碌状态的话，等它放手再按桌面状态解禁：那些任务结束时只管自己的按钮。
  function releaseFillButton(button) {
    if (!button) return;
    button.textContent = "一键 AI 填写";
    const settle = () => {
      if (upload.phase === "running") return;
      if (state.aiBusy) {
        window.setTimeout(settle, 500);
        return;
      }
      button.disabled = state.desktopMode !== "ready" || !hasResumeData();
    };
    settle();
  }

  // 上传和填写。items 是卡片上的每个框，带着用户确认的文件（file：{ fileId }，取到以后补上文件名、类型、类别、大小）或不传的原因。
  async function runUpload(items) {
    const api = self.ResumeProUploadSlots;
    const options = uploadOptions();
    const button = shadowRoot?.querySelector("#resume-pro-ai-fill");
    const card = `${upload.epoch}:${upload.version}`;
    const files = new Map();
    const lines = [];
    let docs = uploadDocs();
    let parse = null;
    let restored = null;
    let filled = null;
    let parsed = [];
    let parsedLeft = [];
    let watcher = null;
    // 记下的框先后对到过的框（传简历之前那个，等解析时重画出来的新框，见 parseValues）。
    let boundBefore = (record) => (record?.entry ? [record.entry] : []);
    upload.phase = "running";
    upload.stop = false;
    upload.result = null;
    const step = (text, stage = "upload") => {
      upload.step = stage;
      if (button) { button.textContent = text; button.disabled = true; }
    };
    // 用户等解析时自己动过的框（见 watchUserEdits）：不改回，停下时也记成不改回。用户动的是网站重画之前的旧框也算：
    // 网站把这一题整个重画了、留着用户写的值，现在的框里没有用户点过的节点，只看它会把用户刚写的改回去。
    const edited = (index, entry, record = null) => Boolean(watcher?.touched(entry) || boundBefore(record).some((old) => watcher?.touched(old)));
    // 交给框之前再扫一遍要传的框：换了控件、类别、要的中英文、收的格式、大小上限或所在分组，这张卡片就作废，一个都不再传，请用户重新确认。
    // 框里已经有文件的，只是那个框不传。
    // 网站重画了框、还认得出是哪个：接着用现在页面上的那个（见 recheck）。
    const cardVoid = (list) => {
      const found = list.map((item) => api.recheck(item.slot, options));
      if (found.some((result) => result.state === "changed" || result.state === "gone")) return true;
      list.forEach((item, index) => {
        if (found[index].slot) item.slot = { ...found[index].slot, id: item.slot.id };
        if (found[index].state) item.outcome = { code: found[index].state };
      });
      return false;
    };
    const voidCard = (text) => {
      for (const item of items) if (item.file && !item.outcome) item.outcome = { code: "card_void" };
      lines.push(text);
    };
    // 会覆盖的平台上，简历还没交给网站就停下（卡片作废、按了停止、简历没交出去）：先记下表单现在的样子再停。
    // 之后用户自己传简历、网站一解析，下一次一键填写拿它对照（见 keepPending）。
    const holdRecords = (records = null) => {
      if (upload.platform?.overwrites) keepPending(records || upload.pending?.records || recordFormValues(), edited);
    };
    try {
      const chosen = items.filter((item) => item.file);
      if (cardVoid(chosen)) {
        holdRecords();
        voidCard("上传框和确认时不一样了，这张卡片作废，没有上传，也没有填写。请重新点一键填写，再确认一次。");
        return;
      }
      const wanted = chosen.filter((item) => !item.outcome);
      if (wanted.length) step("正在从桌面取文件…");
      for (const fileId of new Set(wanted.map((item) => item.file.fileId))) {
        if (upload.stop) break;
        files.set(fileId, await fetchDesktopFile(fileId, card));
      }
      for (const item of wanted) {
        const got = files.get(item.file.fileId);
        if (!got || got.status === "stopped") item.outcome = { code: "stopped" };
        else if (got.status !== "ok") item.outcome = { code: `fetch_${["conflict", "corrupt", "not_confirmed", "wrong_template"].includes(got.status) ? got.status : "unavailable"}` };
        else {
          Object.assign(item.file, got.meta);
          // 选的文件要放得进这个框：认得出要什么的框只收这一类，框收这种格式，不超过上限。
          if ((UPLOAD_PLANNED.includes(item.slot.kind) && got.meta.kind !== item.slot.kind) || !api.fits(item.slot, got.meta)) item.outcome = { code: "not_fit" };
        }
      }
      if (upload.stop) {
        for (const item of wanted) if (!item.outcome) item.outcome = { code: "stopped" };
        holdRecords();
        lines.push("已停止，没有上传，也没有填写。");
        return;
      }
      if (location.href !== upload.href) throw new Error("网页已经变了，这次没有上传，也没有填写。");
      // 算不算简历只看框：简历框，或者认不出要什么的框选了简历、也放得进。证件照、成绩单、其他材料框里就算放的是简历文件，
      // 也不先传，最后和别的材料一起传。
      const isResume = (item) => item.slot.kind === "resume"
        || (item.slot.kind === "unknown" && item.file?.kind === "resume" && item.outcome?.code !== "not_fit");
      const ready = wanted.filter((item) => !item.outcome);
      const first = ready.filter(isResume);
      const later = ready.filter((item) => !isResume(item));
      // 会覆盖的平台上简历没能交给网站（取不到文件、放不进、框不收）：也不往下填。用户之后自己传简历，网站一解析，填好的就被盖掉。
      // 只算上面说的简历那几项：别的框选错了文件，只是那个框不传，不算简历没传上。
      const resumeLost = () => Boolean(upload.platform?.overwrites) && wanted.some((item) => isResume(item) && item.outcome);
      const stopForResume = (sent, records) => {
        for (const item of sent) item.outcome = uploadOutcome(api.state(item.slot, item.file.name, item.seen, docs, isVisible, { withDialogs: false, now: uploadClock.now() }));
        holdRecords(records);
        for (const item of later) item.outcome = { code: "not_reached" };
        lines.push("简历上传失败，所以没有继续填写。请在网页上看一下简历框，自己传好简历、等页面不动了，再点一键填写。");
      };
      if (resumeLost()) {
        stopForResume([], null);
        return;
      }
      if (first.length || upload.pending) {
        // 上次被打断记下的值优先：那时还是用户自己填的样子。
        const records = upload.pending?.records || recordFormValues();
        const stopValues = upload.pending?.stopValues || null;
        const sent = [];
        // 传简历之前就在的忙碌标志（常驻的进度条、「审核处理中」这类状态字）：等解析时不算。
        const busyBaseline = api.busyBaseline(docs, isVisible, (element) => Boolean(element.closest?.(`#${SIDEBAR_ID}`)));
        if (first.length) {
          if (cardVoid(first)) {
            holdRecords(records);
            voidCard("上传框和确认时不一样了，这张卡片作废，没有上传，也没有填写。请重新点一键填写，再确认一次。");
            return;
          }
          step("正在上传简历…");
          watcher = watchUserEdits(docs);
          for (const [index, item] of first.entries()) {
            // 前一份简历交出去以后，网站可能改了后面的框：每交一份之前都再扫一遍还没交的，对不上就作废这张卡片。
            if (sent.length && cardVoid(first.slice(index).filter((rest) => !rest.outcome))) {
              for (const done of sent) done.outcome = uploadOutcome(api.state(done.slot, done.file.name, done.seen, docs, isVisible, { withDialogs: false, now: uploadClock.now() }));
              holdRecords(records);
              voidCard("上传框和确认时不一样了，这张卡片作废，后面的文件没有上传，也没有填写。请重新点一键填写，再确认一次。");
              return;
            }
            if (item.outcome) continue;
            item.seen = api.before(item.slot, docs, isVisible);
            const put = api.put(item.slot, files.get(item.file.fileId).file);
            if (put.ok) sent.push(item);
            else item.outcome = { code: put.reason };
          }
        }
        if (resumeLost()) {
          stopForResume(sent, records);
          return;
        }
        if (sent.length) {
          const timing = self.ResumeProSiteKnowledge?.parseTiming?.(upload.platform)
            || { known: false, minMs: 1000, quietMs: 1500, maxMs: 10000, extendMs: 15000 };
          const values = parseValues(records);
          boundBefore = values.history;
          parse = await api.waitForParse(() => readParse(values, sent, docs, busyBaseline), {
            ...timing, now: uploadClock.now, sleep: uploadClock.sleep,
            stopped: () => upload.stop || location.href !== upload.href,
            onTick: (ms, changed) => step(parseStep(timing, ms, changed))
          });
          // 简历本身传没传上只看它自己的框：网站弹的对话框另起一句说。
          for (const item of sent) item.outcome = uploadOutcome(api.state(item.slot, item.file.name, item.seen, docs, isVisible, { withDialogs: false, now: uploadClock.now() }));
          // 简历没传上（网站报错）也停下：网站可能其实收到了文件、过一会儿才解析，解析结果会把填好的盖掉。
          if (["dialog", "timeout", "stopped", "upload_failed"].includes(parse.status)) {
            // 不填，记下的值留到下一次一键填写：那时简历框里已经有文件，不会再传，先改回再填。用户等的时候动过的框不改回。
            keepPending(records, edited);
            for (const item of later) item.outcome = { code: "not_reached" };
            lines.push(parse.status === "dialog" ? `网站在问「${uploadClip(parse.text, 80)}」，请自己选，选完再点一键填写。`
              : parse.status === "timeout" ? "网站还在解析简历，等页面不动了再点一键填写。"
                : parse.status === "upload_failed" ? "简历上传失败，所以没有继续填写。请在网页上看一下简历框，自己传好简历、等页面不动了，再点一键填写。"
                  : "已停止，没有填写。");
            return;
          }
        }
        if (location.href !== upload.href) throw new Error("网页已经变了，没有填写。");
        restored = await restoreFormValues(records, stopValues, edited);
        upload.pending = null;
        parsed = markParsed(records, stopValues, (entry) => edited(-1, entry));
        uploadParsed = new WeakMap(parsed.map((item) => [uploadNode(item.entry), item.snapshot]).filter(([node]) => node));
        watcher?.stop();
      }
      if (upload.stop) {
        for (const item of later) item.outcome = { code: "stopped" };
        lines.push("已停止，没有填写。");
        return;
      }
      if (button) {
        step("正在扫描网页...", "fill");
        filled = await fillAfterUpload(button);
      }
      // 网站解析填的、填写之后还是网站的值：请用户核对。
      parsedLeft = parsed.filter((item) => fillValueSnapshot(item.entry) === item.snapshot).map((item) => item.label);
      // 用户在填写时按了停止：后面的文件也不传。
      if (filled && fillSession?.summary?.cancelled) upload.stop = true;
      // 最后传证件照和其他材料。每传一个之前再扫一遍还没传的框，对不上就作废这张卡片，剩下的都不传。
      docs = uploadDocs();
      for (const [index, item] of later.entries()) {
        if (upload.stop || location.href !== upload.href) { item.outcome = { code: "stopped" }; continue; }
        if (cardVoid(later.slice(index).filter((rest) => !rest.outcome))) {
          for (const rest of later.slice(index)) if (!rest.outcome) rest.outcome = { code: "card_void" };
          lines.push("上传框和确认时不一样了，这张卡片作废，后面的文件没有上传。请重新点一键填写，再确认一次。");
          break;
        }
        if (item.outcome) continue;
        step(`正在上传${api.KIND_NAMES[item.file.kind] || "文件"}…`);
        item.seen = api.before(item.slot, docs, isVisible);
        const put = api.put(item.slot, files.get(item.file.fileId).file);
        if (!put.ok) { item.outcome = { code: put.reason }; continue; }
        item.outcome = uploadOutcome(await api.watch(item.slot, item.file.name, item.seen, docs, {
          isVisible, sleep: uploadClock.sleep, now: uploadClock.now, timeoutMs: UPLOAD_WATCH_MS, stopped: () => upload.stop }));
      }
    } catch (error) {
      lines.push(error?.message || "上传没有完成，请看一下网页。");
      for (const item of items) if (item.file && !item.outcome) item.outcome = { code: "stopped" };
    } finally {
      watcher?.stop();
      files.clear();
      // 这次上传结束：这张卡片上没取的文件也不要了。
      releaseUploadCard();
      const slotLines = items.map(uploadLine).filter(Boolean);
      const restoreLines = [
        ...(restored?.restored.length ? [`改回了网站解析改掉的 ${restored.restored.length} 项：${summarizeLabels(restored.restored)}。`] : []),
        ...(restored?.missed.length ? [`网站解析改了 ${restored.missed.length} 项，没能确定原来的框或原来的值，没有改回，请核对：${summarizeLabels(restored.missed)}。`] : []),
        ...(restored?.edited.length ? [`等网站解析时你改过这几项，没有改回，请核对：${summarizeLabels(restored.edited)}。`] : []),
        ...(restored?.later.length ? [`这几项在上次停下以后又变过，没有改回，请核对：${summarizeLabels(restored.later)}。`] : []),
        ...(restored?.left.length ? [`改回时停下了，这几项没有处理，请核对：${summarizeLabels(restored.left)}。`] : []),
        ...(parsedLeft.length ? [`网站解析填的 ${parsedLeft.length} 项没有改，请核对：${summarizeLabels(parsedLeft)}。`] : [])
      ];
      const all = [...lines, ...slotLines, ...restoreLines, ...upload.pendingNotes];
      const unrestored = ["missed", "edited", "later", "left"].some((key) => restored?.[key].length);
      const fine = items.every((item) => !item.file || item.outcome?.code === "done") && !lines.length && !unrestored;
      upload.result = all.length ? { lines: all, tone: fine ? "ok" : "warn" } : null;
      upload.report = uploadReport(items, parse, restored, parsedLeft);
      // 上传结束：页面这边只留结果（几行字和诊断用的计数）和每个框不传的原因（结果里「打开桌面简历资料」要用），
      // 文件编号、文件名、上传框、卡片上会改回的题目、平台都不留。
      upload.plan = upload.plan.map((item) => ({ reason: item.reason }));
      upload.preview = null;
      upload.platform = null;
      upload.pendingNotes = [];
      for (const item of items) item.file = null;
      upload.phase = upload.result ? "done" : "idle";
      upload.step = "";
      upload.stop = false;
      uploadParsed = new WeakMap();
      releaseFillButton(button);
      // 诊断：有填写就补在那次填写的诊断后面，没有填写只写上传这一行。
      const summary = filled && fillSession?.summary ? fillSession.summary : null;
      if (summary) writeFillDiagnostics({ ...summary, unsyncedCount: fillSession.unsynced, upload: upload.report });
      else writeUploadDiagnostics(upload.report);
    }
  }

  // 诊断里的上传：只有计数和固定的原因码，不带文件名、题目和网页文字。
  function uploadReport(items, parse, restored, parsedLeft) {
    const tally = (list) => list.reduce((counts, key) => { counts[key] = (counts[key] || 0) + 1; return counts; }, {});
    return {
      kinds: tally(items.map((item) => item.slot.kind)),
      results: tally(items.map((item) => item.file ? item.outcome?.code || "stopped" : "skipped")),
      reasons: tally(items.filter((item) => !item.file).map((item) => item.reason || "none")),
      parse: parse?.status || "none",
      waitMs: Number.isFinite(parse?.elapsed) ? parse.elapsed : null,
      restored: restored?.restored.length || 0,
      missed: restored?.missed.length || 0,
      later: restored?.later.length || 0,
      edited: restored?.edited.length || 0,
      left: restored?.left.length || 0,
      parsed: parsedLeft.length,
      // 后台对「每个框放哪份文件」的回答：不是 ok 时留着原来的 status，不和「桌面连不上」混在一起。
      plan: upload.planStatus || "none"
    };
  }

  function formatUploadDiagnostics(report) {
    const words = (counts) => Object.entries(counts || {}).filter(([key]) => /^[a-z_]{1,32}$/.test(key))
      .map(([key, value]) => `${key} ${Number.isInteger(value) ? value : 0}`).join("、") || "无";
    const parse = /^[a-z_]{1,32}$/.test(report.parse || "") ? report.parse : "none";
    const waited = Number.isFinite(report.waitMs) ? `，${(report.waitMs / 1000).toFixed(1)} s` : "";
    const plan = /^[a-z_]{1,32}$/.test(report.plan || "") && !["ok", "none"].includes(report.plan) ? `；问桌面 ${report.plan}` : "";
    return `上传：框 ${words(report.kinds)}；结果 ${words(report.results)}；没传的原因 ${words(report.reasons)}${plan}；解析等待 ${parse}${waited}；`
      + `改回 ${report.restored || 0}，没改回 ${report.missed || 0}，停下后又变过 ${report.later || 0}，等解析时用户改过 ${report.edited || 0}，`
      + `停下没处理 ${report.left || 0}，网站填的 ${report.parsed || 0}`;
  }

  function writeUploadDiagnostics(report) {
    if (!report) return;
    const panel = shadowRoot?.querySelector("#resume-pro-diagnostics");
    const text = shadowRoot?.querySelector("#resume-pro-diagnostics-text");
    if (!panel || !text) return;
    lastFillReport = "";
    lastPrivate = null;
    text.value = [`网申快填 v${chrome.runtime.getManifest().version}`, "上传后没有进入填写", formatUploadDiagnostics(report)].join("\n");
    panel.hidden = false;
    panel.open = true;
  }

  function noteRecipeUse(status) {
    const key = currentRecipeKey();
    if (!key || recipeCache.id !== recipeId(key)) return;
    recipeCache.lastUse = status === "hit" ? "hit" : status === "stale" ? "stale" : "";
    if (status === "hit") {
      Promise.resolve(chrome.runtime.sendMessage({ type: "RECIPE_TOUCH", host: key.host, path: key.path })).catch(() => {});
    }
  }

  function currentResumeFields() {
    const template = getActiveTemplate(state.currentStore);
    const templateFields = template ? flattenTemplateFields(template) : [];
    return self.ResumeProProfile ? self.ResumeProProfile.mergeResumeFields(templateFields, profileResumeFields()) : templateFields;
  }

  function buildRecipeOutline(resumeValues) {
    return self.ResumeProPageOutline.build(document, {
      isVisible: isVisibleInOwnDocument,
      exclude: element => Boolean(element.closest?.(`#${SIDEBAR_ID}`)),
      resumeValues,
      fieldScan: self.ResumeProFieldScan
    });
  }

  // 按配方在当前大纲里找字段：达到「至少 80%、失败不超过 5 个」才给出填写输入（配方字段 + 规则扫描补漏，
  // 同一个逻辑控件只留一个）。recipe 是给诊断的固定状态和计数。
  function recipeFillInput({ recipe, outline, extraScopes = [] }) {
    const api = recipeApi();
    const located = api.locateFields(recipe, outline, { extraScopes });
    const info = { status: located.ok ? "hit" : "stale", total: located.total, located: located.located, missing: located.missing,
      ambiguous: located.ambiguous, extra: located.extra, sameStructure: located.sameStructure, supplemented: 0 };
    if (!located.ok) return { recipe: info, input: null };
    const prepared = self.ResumeProDeepAnalysis.toFillInput(api.toSpecFields(located.entries), outline.nodes,
      { optionText: getRadioOptionLabel, pickerInputType: inferPickerInputType });
    // 定位到了却用不了（控件已经不在、暂不支持）的同样算没找到，再按同一个门槛判断一次。
    const usable = located.located - prepared.dropped;
    if (!prepared.fields.length || usable / located.total < api.MIN_RATIO || located.total - usable > api.MAX_FAILED) {
      return { recipe: { ...info, status: "stale", located: Math.max(0, usable) }, input: null };
    }
    let scanned = null;
    try {
      scanned = scanFillableFields();
    } catch {
      scanned = null;
    }
    const input = mergeRecipeScan(withScanBindings(prepared, scanned), scanned);
    info.supplemented = input.supplemented;
    return { recipe: info, input };
  }

  // 规则扫描补漏：配方没有的字段照常填，已经被配方字段占用的控件（同一个元素，或在同一个组件里）不再重复。
  function mergeRecipeScan(prepared, scanned) {
    const fields = [...prepared.fields];
    const fieldMap = new Map(prepared.fieldMap);
    const claimed = new Set();
    const roots = [];
    for (const entry of prepared.fieldMap.values()) {
      for (const el of [entry.element, ...(entry.elements || [])]) if (el) claimed.add(el);
      if (entry.root) roots.push(entry.root);
    }
    let supplemented = 0;
    for (const field of scanned?.fields || []) {
      const entry = scanned.fieldMap.get(field.fieldId);
      if (!entry) continue;
      const own = [entry.element, ...(entry.elements || [])].filter(Boolean);
      const overlaps = own.some(el => claimed.has(el) || roots.some(root => root !== el && root.contains?.(el)))
        || (entry.root && [...claimed].some(el => entry.root !== el && entry.root.contains?.(el)));
      if (overlaps) continue;
      const { cascadeGroup, cascadeLevel, ...rest } = field;
      fields.push(rest);
      fieldMap.set(field.fieldId, entry);
      supplemented += 1;
    }
    const elementOf = field => {
      const entry = fieldMap.get(field.fieldId);
      return entry?.element || entry?.elements?.[0] || null;
    };
    // 按网页上的先后顺序填（省、市这类联动要先选上一级）；跨框架、Shadow DOM 比不出先后的保持原顺序。
    fields.sort((a, b) => {
      const ea = elementOf(a);
      const eb = elementOf(b);
      if (!ea || !eb || ea === eb || typeof ea.compareDocumentPosition !== "function" || ea.ownerDocument !== eb.ownerDocument) return 0;
      const position = ea.compareDocumentPosition(eb);
      return position & 4 ? -1 : position & 2 ? 1 : 0;
    });
    if (self.ResumeProAIHelpers?.detectCascadeGroups) self.ResumeProAIHelpers.detectCascadeGroups(fields, fieldMap);
    return { fields, fieldMap, stats: { ...(scanned?.stats || scanStats(null, fields.length)) }, supplemented, fault: scanned?.fault || null,
      unreadable: Boolean(scanned?.unreadable) };
  }

  // 普通一键填写的扫描：本站有配方先按它找字段，找不到就照常扫描（并记下配方可能已过期）。
  async function scanForFill() {
    if (!recipeApi()) return { scanned: scanFillableFields(), recipe: null };
    const entry = await loadPageRecipe();
    if (!entry.recipe) return { scanned: scanFillableFields(), recipe: { status: "unused" } };
    let prepared;
    try {
      prepared = recipeFillInput({ recipe: entry.recipe, outline: buildRecipeOutline(deepResumeValues(currentResumeFields())) });
    } catch {
      prepared = { recipe: { status: "stale", total: entry.recipe.fields.length, located: 0, missing: 0, ambiguous: 0 }, input: null };
    }
    noteRecipeUse(prepared.recipe.status);
    return prepared.input ? { scanned: prepared.input, recipe: prepared.recipe } : { scanned: scanFillableFields(), recipe: prepared.recipe };
  }

  // 侧栏点「一键 AI 填写」时：本站配方需要先点「编辑 / 展开 / 添加」，并且这些按钮在网页上都找得到，
  // 就转到配方模式（侧栏预览、确认后才点）。其余情况照常一键填写（按字段定位或退回扫描）。
  async function recipeRoute() {
    const api = recipeApi();
    if (!api || !self.ResumeProPageActions || !self.ResumeProFormAgent || state.desktopMode !== "ready") return null;
    const entry = await loadPageRecipe();
    const recipe = entry.recipe;
    if (!recipe || (!recipe.actions?.length && !recipe.sections?.length)) return null;
    let outline;
    try {
      outline = buildRecipeOutline(deepResumeValues(currentResumeFields()));
    } catch {
      return null;
    }
    const found = api.locateActions(recipe, outline);
    if (!found.ok || (!found.preActions.length && !found.sections.length)) return null;
    // 只有「添加」：按当前模板和网页已有条目算一下，要新增就进配方模式（条目数和上次一样、模板却多了一条时
    // 字段也都找得到，不能因此跳过新增，PR #284 审查）；一条都不用加就照常按字段填写。
    if (!found.preActions.length) {
      const templateFields = getActiveTemplate(state.currentStore) ? flattenTemplateFields(getActiveTemplate(state.currentStore)) : [];
      if (!templateFields.length) return null;
      let plan;
      try {
        plan = planDeepActions({ spec: { preActions: [], sections: found.sections, fields: [] }, outline, templateFields });
      } catch {
        return null;
      }
      return plan.error || !plan.items.length ? null : { recipe };
    }
    // 有「编辑 / 展开」：动作之前字段就已经全部在网页上（网页已经是编辑状态）就不用再点。
    // 只差一部分时仍然要点，不能为了凑够 80% 跳过。
    const before = api.locateFields(recipe, outline);
    if (before.located === before.total) return null;
    return { recipe };
  }

  // 深度分析的效果基线：同一页面（同一网址、这次打开）上一次普通一键填写确认填上的数量；
  // 普通扫描一个字段都没有时就是 0。都没有就不比较、不保存。
  function deepBaseline() {
    if (lastPlainFill && lastPlainFill.href === location.href) return { filled: lastPlainFill.filled };
    try {
      return scanFillableFields().fields.length === 0 ? { filled: 0 } : null;
    } catch {
      return null;
    }
  }

  // 深度分析填写之前：按当前网页生成配方草稿和归类（只在内存里，满足保存条件才写入）。
  // actions 为 null 表示确认过的按钮没法可靠地记下来，这份分析不存成配方。
  function draftDeepRecipe({ fields, sections, outline, actions, tier, sectionsBefore = null }) {
    const api = recipeApi();
    const key = api.pageKey(location.href, { redact: outline.redact });
    if (!key.ok) return { ok: false, status: "unsafe" };
    if (actions === null) return { ok: false, status: "unlocatable" };
    const built = api.buildRecipe({ fields, outline, sections, sectionsBefore, actions, tier, now: Date.now() });
    if (!built.ok) return { ok: false, status: built.reason === "privacy" ? "unsafe" : built.reason === "too_large" ? "too_large" : "unlocatable" };
    return { ok: true, key, recipe: built.recipe, missingSections: built.missingSections || [] };
  }

  async function saveDeepRecipe({ draft, validation, result, baseline, current }) {
    const api = recipeApi();
    if (!api) return { status: "" };
    const decision = api.saveDecision({ validation, result, baseline, stopped: !current() });
    if (!decision.save) return { status: decision.reason };
    if (!draft?.ok) return { status: draft?.status || "unlocatable" };
    const { key, recipe } = draft;
    // 换页、停止之后迟到的结果不保存。
    if (!current() || !currentRecipeKey() || recipeId(currentRecipeKey()) !== recipeId(key)) return { status: "cancelled" };
    let reply = null;
    try {
      reply = await chrome.runtime.sendMessage({ type: "RECIPE_SAVE", host: key.host, path: key.path, recipe });
    } catch {
      reply = null;
    }
    recipeCache.loaded = false;
    if (!reply?.ok) return { status: "save_failed" };
    recipeCache.lastUse = "";
    return { status: reply.replaced ? "replaced" : "saved", fields: recipe.fields.length, missingSections: draft.missingSections || [] };
  }

  async function handlePanelRecipe(message) {
    const action = String(message?.action || "");
    const key = currentRecipeKey();
    if (action !== "delete") return { ok: false, error: "当前操作不可用。" };
    if (!key) return { ok: false, error: "当前网页没有本站配方。" };
    if (deepActive()) return { ok: false, error: "深度分析正在进行，请先等待或停止。" };
    let reply = null;
    try {
      reply = await chrome.runtime.sendMessage({ type: "RECIPE_DELETE", host: key.host, path: key.path });
    } catch {
      reply = null;
    }
    recipeCache.loaded = false;
    await loadPageRecipe().catch(() => null);
    if (!reply?.ok) return { ok: false, error: "没能删除本站配方，请稍后再试。" };
    recipeCache.lastUse = "";
    return { ok: true, recipe: recipeStatus() };
  }

  function isAssistedTextField(entry) {
    const el = entry.element;
    if (["custom-select", "cascader"].includes(entry.controlKind)) return false;
    return !el.disabled && !el.readOnly && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && ["text", "email", "tel", "url", "search"].includes(el.type)));
  }

  // 自制单选（#269 北森 phoenix-radio）的选项是 div：选中状态由组件的 --checked / aria-checked 标出。
  function radioChecked(el) {
    return isInputElement(el) ? el.checked : Boolean(self.ResumeProCustomControls?.isChecked?.(el));
  }

  function hasExistingValue(entry) {
    if (entry.kind === "radio") return entry.elements.some(radioChecked);
    const el = entry.element;
    if (!el?.isConnected) return true;
    if (["custom-select", "cascader"].includes(entry.controlKind) && self.ResumeProCustomControls) {
      return self.ResumeProCustomControls.hasExistingValue(entry)
        || Boolean(entry.binding && self.ResumeProFieldScan?.hasDisplayedValue(entry.binding, { isVisible }));
    }
    if (el.type === "checkbox" || el.type === "radio") return el.checked;
    if (el.multiple && el.options) return Array.from(el.options).some(option => option.selected
      && !(option.value === "" && self.ResumeProAIHelpers?.isPlaceholderOption?.({ value: option.value, text: option.text, disabled: option.disabled })));
    if (String(el.value ?? el.textContent ?? "").trim()) return true;
    // 自定义下拉选好的内容显示在组件里，内部 input 常常是空的。
    return entry.controlKind === "custom-select" && Boolean(entry.binding)
      && Boolean(self.ResumeProFieldScan?.hasDisplayedValue(entry.binding, { isVisible }));
  }

  // 只在本次填写期间比较网页值，不保存或发送到桌面/AI。
  function fillValueSnapshot(entry) {
    if (entry.kind === "radio") return entry.elements.every(el => el.isConnected)
      ? JSON.stringify(entry.elements.map(el => [isInputElement(el) ? el.value : el.textContent.trim(), radioChecked(el)])) : null;
    const el = entry.element;
    if (!el?.isConnected) return null;
    if (["custom-select", "cascader"].includes(entry.controlKind) && self.ResumeProCustomControls) {
      const state = self.ResumeProCustomControls.snapshot(entry);
      return state === null ? null : JSON.stringify([state,
        entry.binding ? self.ResumeProFieldScan?.displayedStateForGuard?.(entry.binding, { isVisible }) || [] : []]);
    }
    if (el.type === "checkbox" || el.type === "radio") return JSON.stringify(el.checked);
    if (el.multiple && el.options) return JSON.stringify(Array.from(el.options, option => [option.value, option.selected]));
    if (isSelectElement(el)) {
      const option = el.options[el.selectedIndex];
      const emptyPlaceholder = el.value === "" && (el.selectedIndex < 0
        || (option && self.ResumeProAIHelpers?.isPlaceholderOption?.({ value: option.value, text: option.text, disabled: option.disabled })));
      return JSON.stringify([el.value, emptyPlaceholder ? -1 : el.selectedIndex]);
    }
    return String(el.value ?? el.textContent ?? "");
  }

  // `assisted` limits filling to new rows. The returned summary supplies the side panel;
  // `stopped` and `onRequest` let it stop the AI wait and subsequent writes.
  // `deep`（#224）：深度分析给出的字段 { fields, fieldMap } 代替扫描结果，匹配用强档并受调用预算限制；
  // 覆盖确认、写入前复查、填写会话、诊断和留档提示都和普通一键填写相同。
  // #226：deep.mode 为 "recipe" 时是按本站配方定位出的字段（已含规则扫描补漏），匹配照常用日常模型；
  // fields 为 null 表示配方没能用上，照常扫描。普通一键填写（deep 为空）本站有配方时也先按配方定位。
  async function handleAiFillClick(event, assisted = null, deep = null) {
    const button = event.currentTarget;
    // #301 诊断：这次填写从哪里开始，开始时网页有没有焦点（点侧栏时网页失焦，有的下拉、日历要焦点才弹出）。
    // 要在第一个 await 之前读：侧栏的标记只在 click() 同步派发期间有效。
    const entry = assisted ? "assist" : deep ? (deep.mode === "recipe" ? "recipe" : "deep") : panelFillStarting ? "panel" : "other";
    const pageFocused = typeof document.hasFocus === "function" ? document.hasFocus() : null;
    const failed = error => ({ outcome: "failed", filledCount: 0, unconfirmedCount: 0, error });
    if (button.disabled || state.aiBusy) return failed("busy");
    const report = assisted?.quiet ? () => {} : showStatus;
    state.aiBusy = true;
    state.suggestedView = null;
    state.currentStore = await StorageService.getState();
    if (shadowRoot?.querySelector("#resume-pro-template-select")) renderSidebar();
    if (state.desktopMode !== "ready") {
      state.aiBusy = false;
      const message = self.ResumeProResumeData.modeCopy(state.desktopMode).message;
      report(message, "error");
      return failed(message);
    }
    const activeTemplate = getActiveTemplate(state.currentStore);
    const activeTemplateFingerprint = JSON.stringify(activeTemplate);

    const profileFields = profileResumeFields();
    // #497 填完时要不要做私有诊断，看的是这时读到的同意状态。
    readFeedbackAgreed();

    if (!activeTemplate && !profileFields.length) {
      state.aiBusy = false;
      report("请先导入简历模板，或在「我的信息」里填写内容。", "error");
      return failed("请先导入简历模板，或在「我的信息」里填写内容。");
    }

    button.disabled = true;
    // Warm the desktop modules while the fill runs, so that when it ends the page can be read
    // for the archive offer without waiting on anything (see offerFillRecord).
    loadDesktopModules().catch(() => {});
    const repeatButton = shadowRoot?.querySelector("#resume-pro-repeat-fill");
    if (repeatButton) repeatButton.disabled = true;
    button.textContent = "正在扫描网页...";
    const totalStart = performance.now();
    const timing = { scanMs: null, roundTripMs: null, fillMs: null };
    let phaseStart = totalStart;
    let phase = "scanMs";
    let timer = null;
    // #402 先填：AI 返回前填上了几项、先填花了多久；AI 请求还没回来时出错或停下，结束时一并取消。
    let earlyFilled = 0;
    let earlyFillMs = 0;
    let earlyFrom = null;
    let aiPending = false;
    let aiDoneAt = null;
    // 等 AI 期间被改过、没有覆盖的字段名；诊断里只记个数。
    const kept = [];
    let diagnostics = {};
    let fieldCount = 0;
    let filledCount = 0;
    let unconfirmedCount = 0;
    const verifiedControls = [];
    // 写上了、页面当时还提示无效的字段：提示可能要等后面的字段填完才消（北森开始 / 结束时间联动校验），结束前再看一次。
    const invalidControls = [];
    let recheckVerifiedControls = () => {};
    const unfilledLabels = [];
    const unfilledControls = [];
    // #497 私有诊断：没写上的字段和 AI 看过却没匹配上的字段（题目原文、分组、选项），只在内存里，结束时脱敏后拼进私有层。
    const privateUnfilled = [];
    const aiMisses = [];
    // 资料里有值的字段类别，和脱敏要藏起来的资料值（扫描出错时还没算出来，结束时再补）。
    let resumeKindSet = new Set();
    let privateValues = null;
    // #301 选完后新出现的字段（#269）和首轮字段一样计入结果、诊断和留档；进诊断的只有计数。
    // pendingNew 是排队等 AI 补填的新字段，没轮到补填就结束的算没送 AI。
    const grown = { found: 0, local: 0, matched: 0, aiFields: 0, aiMatches: 0, aiCalled: false, errorCode: "", drops: {} };
    const pendingNew = [];
    let probe = null;
    // #408 扫描出错（整页没扫完，或有控件读不出来被跳过）：错误类型和本扩展代码的位置（feedback-core 的 exception()），
    // 只进本地诊断文字。
    let scanFault = null;
    // 诊断 v1（#215）：失败卡在哪一步，以及这个页面像不像网申填写页。
    const readyAtScan = document.readyState === "complete";
    let scanDone = false;
    let stage = "scan";
    let failedStage = null;
    let requested = false;
    let responded = false;
    let matched = null;
    let stats = null;
    let pageType = null;
    let scanPath = location.pathname;
    let scannedCustom = 0;
    // #301 扫描在通用路径上认出、页面探测没数到的自定义下拉（北森）：只进诊断的 custom_controls，不改深度分析入口的判断。
    let genericCustom = 0;
    let genericLocked = 0;
    // #226 本站配方这次用没用上：只有固定状态码和计数。
    let recipeUse = deep?.mode === "recipe" ? deep.report?.recipe || null : null;
    // 猎聘这类查看状态的页面：页头搜索框之类会被扫描到，但一个都没填上，照样提示先点「编辑」。
    // 只在什么都没匹配上、AI 也没出错时这样说：AI 超时、匹配到了却写不上（#299）都不是查看状态。
    // 从同源框架里扫到了一张表单那么多的字段（#400）：表单已经显示出来，不是查看状态。只有一两个（留言框）照样提示。
    const viewModeHint = () => !assisted && filledCount === 0 && !matched && probe?.editButtons > 0
      && ["none", "no_context"].includes(diagnostics.errorCode || "none")
      ? withFillProbe(api => stats?.frameFields >= api.FORM_INPUTS ? "" : api.emptyPageHint(probe), "") : "";
    let outcome = "failed";
    let failure = "";
    // 失败信息里带了「先点编辑」这类提示，或是扫描到 0 个字段：要一直留在屏幕上，不像别的失败几秒后消失。
    let hinted = false;
    const requestId = newRequestId();
    const cancelButton = shadowRoot?.querySelector("#resume-pro-cancel-fill");
    const waitHint = shadowRoot?.querySelector("#resume-pro-wait-hint");
    let cancelRequested = false;
    let writeCancelled = false;
    const fillUrl = location.href;
    let overwriteDeclined = false;
    // 辅助新增条目是同一次一键填写的延续，接着用当前会话；其余每次都开新会话，上一次的记录清掉。
    const session = assisted && fillSession ? fillSession : beginFillSession();

    try {
      let scanned;
      if (deep) {
        scanned = deep.fields ? { fields: deep.fields, fieldMap: deep.fieldMap, stats: scanStats(null, deep.fields.length) } : scanFillableFields();
      } else if (assisted) {
        scanned = scanFillableFields();
      } else {
        const found = await scanForFill();
        scanned = found.scanned;
        recipeUse = found.recipe;
      }
      // #408 控件一个都没读出来（每一项都要走的判断出了错）：按扫描出错处理，不当作网页还没加载完。
      // 别的控件读出来了、只是禁用或对不上题目时不算，照常给「没找到输入框」那类提示，出错的那一项在 describeScan 里上报。
      if (scanned.unreadable && !scanned.fields.length) {
        stats = scanned.stats;
        throw scanned.fault;
      }
      let fieldMap = scanned.fieldMap;
      let fields = assisted ? scanned.fields.filter(field => {
        const entry = fieldMap.get(field.fieldId);
        return entry?.kind === "element" && isAssistedTextField(entry) && assisted.scopes.some(scope => scope.contains(entry.element)) && !hasExistingValue(entry);
      }) : scanned.fields;
      timing.scanMs = performance.now() - phaseStart;
      phase = null;
      scanDone = true;
      const describeScan = () => {
        fieldCount = fields.length;
        // 和页面探测比较、相减的只算顶层的字段：探测只数顶层的自定义控件和只读框（#400 框架里的字段不算）。
        const topFields = fields.filter(field => entryDocument(fieldMap.get(field.fieldId)) === document);
        scannedCustom = topFields.filter(field => ["custom-select", "cascader"].includes(field.controlKind)).length;
        // 单页应用可能在填写途中换页：诊断描述的是扫描时的那一页。
        scanPath = location.pathname;
        stats = { ...scanned.stats, outOfScope: scanned.fields.length - fields.length };
        // 探测放在扫描计时之后：诊断里的「扫描」耗时不含探测。
        probe = withFillProbe(api => api.probePage(document, { href: location.href }), null);
        pageType = withFillProbe(api => api.pageType({ pathname: scanPath, hash: location.hash, title: document.title, probe, stats }), null);
        // 通用下拉的根只给诊断计数用：读控件出错就不数，填写照常。
        let genericRoots = [];
        try {
          genericRoots = topFields
            .filter(field => ["custom-select", "cascader"].includes(field.controlKind))
            .map(field => { try { return self.ResumeProCustomControls?.describe?.(fieldMap.get(field.fieldId)); } catch { return null; } })
            .filter(info => info?.library === "generic").map(info => info.root);
        } catch { genericRoots = []; }
        genericCustom = withFillProbe(api => api.uncountedControls?.(genericRoots), 0);
        genericLocked = withFillProbe(api => api.uncountedLocked?.(genericRoots), 0);
        // #408 只跳过了读不出来的几项：照样报出错误类型和位置（同一位置一天只报一次），本地诊断也写上。
        if (scanned.fault && !scanFault) scanFault = reportError(scanned.fault);
      };
      describeScan();
      // #301 普通一键填写在网申页上扫到 0 个字段、又没有任何线索：多半是点得太早，表单还没出来。
      // 等网页上出现新的输入控件再扫，扫到就用这次的结果；辅助新增、深度填写和按本站配方的填写不等。
      if (!fields.length && !assisted && !deep && (!recipeUse || recipeUse.status === "unused") && probe
        && pageType?.type === "application_form" && !withFillProbe(api => api.hasClues(probe), true)) {
        button.textContent = "正在等待网页加载...";
        const later = await waitForNewControls(fillUrl, scanFillableFields);
        if (later) {
          scanned = later;
          fieldMap = scanned.fieldMap;
          fields = scanned.fields;
          describeScan();
        }
      }
      if (!fields.length) {
        // 辅助新增只是过滤后为空（页面本身有字段），或本来就在辅助新增：不给「先点编辑」这类提示。
        // 其余零字段的提示按页面类型给，一律留在屏幕上（#301）。
        hinted = !assisted && !scanned.fields.length;
        const hint = hinted
          ? withFillProbe(api => api.emptyPageHint(probe, { notForm: pageType?.type === "unknown", form: pageType?.type === "application_form",
            deepAvailable: Boolean(self.ResumeProDeepAnalysis && self.ResumeProPageOutline), frameUntitled: stats?.frameUntitled }), "") : "";
        throw new Error(`没找到可填写的输入框。${hint}`);
      }
      if (!assisted) closeProfileOffer();
      // 模板字段在前并且优先；「我的信息」只补模板里没有的字段名。
      const templateFields = activeTemplate ? flattenTemplateFields(activeTemplate) : [];
      const resumeFields = self.ResumeProProfile
        ? self.ResumeProProfile.mergeResumeFields(templateFields, profileFields)
        : templateFields;
      // #429：页面上有问到对方公司的题，才去读这个网站记住的回答，并进资料（本网站回答组，只按题目原样比）。
      // 辅助新增不收起上一轮的保存候选，候选按的那份网站回答也留着用。
      if (!assisted) state.siteAnswers = null;
      if (fields.some(siteScopedField)) {
        resumeFields.push(...siteAnswerResumeFields(currentSiteAnswers() || await loadSiteAnswers()));
      }
      // 诊断里要藏起来的简历内容（一个字的值太容易撞上普通字段名，不参与比较）。
      const resumeValues = resumeFields.map(field => normalizeForOverlap(field?.value)).filter(value => value.length >= 2);
      privateValues = resumeValues;
      try { resumeKindSet = self.ResumeProFeedback?.resumeKinds?.(resumeFields) || new Set(); } catch { resumeKindSet = new Set(); }
      phase = "roundTripMs";
      stage = "match";
      phaseStart = performance.now();
      // 补填新出现字段时发出的 AI 请求（#269）：停止时一并取消，不等它返回。
      let catchUpRequestId = null;

      const fieldMetaMap = new Map(fields.map((f) => [f.fieldId, f]));
      const domOrderMap = new Map(fields.map((field, index) => [field.fieldId, index]));
      const byOrder = (a, b) => {
        const ma = fieldMetaMap.get(a.fieldId);
        const mb = fieldMetaMap.get(b.fieldId);
        if (ma?.cascadeGroup !== undefined && ma.cascadeGroup === mb?.cascadeGroup) {
          return (ma.cascadeLevel ?? 0) - (mb.cascadeLevel ?? 0);
        }
        // 其余按页面顺序从上往下填：没被识别成联动组的省/市/县也能等上一级先选好。
        return (domOrderMap.get(a.fieldId) ?? 0) - (domOrderMap.get(b.fieldId) ?? 0);
      };

      // 等 AI 时字段所在的同源框架换了页或被删掉（#400）：和顶层换页一样算页面变了，不往旧文档里写。
      const framesGone = () => {
        for (const entry of fieldMap.values()) if (documentGone(entryDocument(entry))) return true;
        return false;
      };
      const approvedValues = new Map();

      const noteControlFailure = (element, fieldMeta, value, reason, uncertain) => {
        const control = element.kind === 'element' ? element.element : element;
        textFillFailures.set(control, reason);
        if (assisted) { if (uncertain !== false) unconfirmedCount += 1; return; }
        const label = fieldMeta?.label || fieldMeta?.placeholder || fieldMeta?.name || '未命名字段';
        // #399 #405 写入被拒的文本框：框里剩下的是什么；#301 日历没选上、框里却换成了别的日子（#418 回车交出今天）。
        const leftover = LEFTOVER_REASONS.has(reason) ? textLeftovers.get(control) : null;
        const changed = reason === 'selection_not_committed' && leftover?.session === session && leftover.after === 'other';
        const why = changed ? '选成了别的日期' : reason === 'too_long' && textLimits.has(control) ? limitText(textLimits.get(control))
          : TEXT_FILL_FAILURE_LABELS[reason] || '';
        const shown = why ? `${label}（${why}）` : label;
        if (uncertain ?? ['verification_timeout', 'framework_state_unsynced', 'value_changed', 'cancelled', 'element_disconnected'].includes(reason)) {
          unconfirmedCount += 1;
        } else unfilledLabels.push(shown);
        // Preserve the existing overlap redaction for both immediate and final failures.
        const shownValue = normalizeForOverlap(value);
        const shownLabel = normalizeForOverlap(label);
        const overlaps = Boolean(shownValue && shownLabel) && (shownLabel === shownValue
          || (shownValue.length >= 2 && (shownLabel.includes(shownValue) || shownValue.includes(shownLabel))));
        const showsResume = Boolean(shownLabel) && resumeValues.some(value => shownLabel.includes(value));
        // #301 本次填写操作过的下拉：弹层有没有出来、里面有没有选项。没操作过的（上一级没选上）不带。
        const popup = controlPopups.get(control);
        // #399 #405 写入被拒的文本框：填它的 1 秒内有没有冒出建议框或弹层。
        const overlay = TEXT_REJECTED.has(reason) ? overlayWatches.get(control)?.kind() : null;
        const observed = {
          ...(popup && popup.session === session ? { opened: popup.opened, hasOptions: popup.hasOptions } : {}),
          ...(leftover && leftover.session === session ? { after: leftover.after } : {}),
          ...(overlay ? { overlay } : {})
        };
        // #497 公开报告只报字段类别和控件的样子；题目原文、分组和选项只进私有诊断。
        // 读页面出错（网页改过的 getter）只少几项诊断，不打断填写。
        const shape = controlShapes.get(control);
        const current = shape && shape.session === session ? shape : null;
        const kind = fieldKindOf(label);
        let form = null;
        try { form = controlForm(element, current, observed.opened); } catch { form = null; }
        unfilledControls.push({ label: overlaps || showsResume ? '（字段名已隐藏）' : label, reason: why, kind,
          ...(form ? { form } : {}),
          reasonCode: reason, control: withFillProbe(api => api.describeControl(element), null),
          ...(Object.keys(observed).length ? { observed } : {}),
          // 深度填写：插件实际按哪种控件去操作的（说明书给的类型经 DOM 校正后），分清是类型判错还是组件打不开。
          ...(element.deepRef ? { operated: element.controlKind } : {}) });
        try {
          privateUnfilled.push({ label, section: fieldSection(element, fieldMeta), kind, reasonCode: reason, nodes: fieldNodes(element),
            ...privateOptions(element, fieldMeta, label, kind, current) });
        } catch { /* diagnostics never break the fill */ }
      };
      // #497 AI 看过、没给值的字段（ai-worker 的 unansweredIds）：类别、资料里有没有这一类，私有诊断再带题目和选项。
      const noteAiMisses = ids => {
        if (!Array.isArray(ids)) return;
        for (const id of ids) {
          const meta = fieldMetaMap.get(id);
          const entry = fieldMap.get(id);
          if (!meta || !entry || aiMisses.some(item => item.fieldId === id)) continue;
          const label = meta.label || meta.placeholder || meta.name || '';
          const kind = fieldKindOf(label);
          aiMisses.push({ fieldId: id, label, section: fieldSection(entry, meta), kind, inResume: kind !== 'unknown' && resumeKindSet.has(kind),
            nodes: fieldNodes(entry), ...privateOptions(entry, meta, label, kind, null) });
        }
      };
      let controlsRechecked = false;
      recheckVerifiedControls = () => {
        if (controlsRechecked) return;
        controlsRechecked = true;
        for (const item of verifiedControls) {
          let checked;
          if (isFieldBindingCurrent(item.element)) checked = controlOperator?.check(item.element);
          else {
            // 页面重画过：找回的新字段显示的内容和填完那一刻一样，仍算填上。
            const fresh = rebindFieldEntry(item.element);
            checked = fresh && item.after != null && fillValueSnapshot(fresh) === item.after
              ? { ok: true } : { ok: false, reason: 'element_disconnected' };
          }
          if (checked && !checked.ok) {
            filledCount -= 1;
            if (item.isNew) supplemented -= 1;
            rememberLeftover(item.element, checked);
            noteControlFailure(item.element, item.fieldMeta, item.value, checked.reason);
          }
        }
        // 当时还提示无效的：提示已经消了就算填上；提示还在照旧记「页面仍提示无效」，值被页面退回的记复核读到的原因，
        // 字段已被页面替换的记「字段已被页面替换」。
        // 只读：不写值、不聚焦，也不滚动页面。
        for (const item of invalidControls) {
          const current = isFieldBindingCurrent(item.element);
          const checked = current ? controlOperator?.check(item.element) : null;
          if (!checked?.ok) {
            rememberLeftover(item.element, checked);
            noteControlFailure(item.element, item.fieldMeta, item.value, current ? checked?.reason || 'validation_not_cleared' : 'element_disconnected');
            continue;
          }
          const control = item.element.kind === 'element' ? item.element.element : item.element;
          filledCount += 1;
          if (item.isNew) supplemented += 1;
          if (item.element.kind === 'element' && dayDefaultedControls.has(control)) dayDefaulted += 1;
          textFillFailures.delete(control);
          if (item.element.kind === 'element' && !item.element.pickerType && !['custom-select', 'cascader'].includes(item.element.controlKind)) {
            recordFilledTextControl(session, control);
          }
        }
      };
      const isCurrent = () => !writeCancelled && !assisted?.stopped?.() && !deep?.stopped?.()
        && location.href === fillUrl && session === fillSession && !framesGone();
      // 停下来时说清楚是用户按了停止，还是页面或填写会话变了。
      const stopError = () => {
        cancelRequested = true;
        return new Error(writeCancelled ? '已停止后续填写，请核对网页中已填写的内容。' : '已停止填写，页面或填写会话已变化。');
      };
      const failedCascadeGroups = new Set();
      // #269 选了某项后页面才出现的字段（智联选完学历多出专业、院系）：选完等页面安静再扫一次，
      // 新出现的空字段先在本地匹配、当场排进这一轮；本地匹配不上的，这一轮结束后交给 AI 补填，最多补 2 次。
      const queue = [];
      const newFieldIds = new Set();
      let catchUpRounds = 0;
      let supplemented = 0;
      // 本次填写里为看弹层多等过的被拒文本框个数（最多 OVERLAY_WAITS 个）。
      let overlayWaits = 0;
      let dayDefaulted = 0;
      // #301 新字段的去向：「加到我的信息」看 grownFields 和 grownMatchedIds；补填失败或没发出的进 grownMissed，
      // 状态行请用户自己补，并附上补填请求的警告。
      const grownFields = [];
      const grownMatchedIds = new Set();
      const grownMissed = [];
      let grownWarning = "";
      // 首轮 AI 已经超时或服务出错：补填同样会失败，新字段不再发出。AI 回来后才知道。
      let aiDown = false;
      // #402 先填阶段：同一对里还在等 AI 的另一半（Moka 起止时间），和选完后页面带出值、已重新批准的字段。
      let waitingAi = false;
      let awaiting = [];
      const pageFilled = new Set();
      const pickUpNewFields = async (position, doc) => {
        await waitForPageSettle(doc);
        if (!isCurrent()) return;
        // 同名题目的序号会因为新字段插进来而变（两段教育经历都有「专业」）：原来就扫到过的元素不算新字段。
        const nodeOf = entry => entry?.kind === "radio" ? entry.elements?.[0] : entry?.element;
        const known = new Set([...fieldMap.values()].map(entry => fieldBindingKey(entry.binding)));
        const knownNodes = new Set([...fieldMap.values()].map(nodeOf).filter(Boolean));
        // 补填是尽力而为：这次扫描出错就不补，原来排队的字段照常往下填。
        let fresh;
        try {
          fresh = scanFillableFields();
        } catch {
          return;
        }
        const added = fresh.fields.filter(field => {
          const entry = fresh.fieldMap.get(field.fieldId);
          const key = fieldBindingKey(entry?.binding);
          return key && !known.has(key) && !knownNodes.has(nodeOf(entry)) && isFieldBindingCurrent(entry) && !hasExistingValue(entry);
        });
        if (!added.length) return;
        for (const field of added) {
          const entry = fresh.fieldMap.get(field.fieldId);
          const fieldId = `field-new-${newFieldIds.size}`;
          newFieldIds.add(fieldId);
          // 联动组编号是第一次扫描时排的，新字段不沿用，避免和已有的组混在一起。
          delete field.cascadeGroup; delete field.cascadeLevel;
          field.fieldId = fieldId;
          fieldMap.set(fieldId, entry);
          fieldMetaMap.set(fieldId, field);
          approvedValues.set(entry, fillValueSnapshot(entry));
        }
        grown.found += added.length;
        grownFields.push(...added);
        // 后来冒出来的题里才有问到对方公司的：这时再读这个网站记住的回答（#429）。
        if (!siteAnswersSettled() && added.some(siteScopedField)) {
          const siteFields = siteAnswerResumeFields(await loadSiteAnswers());
          resumeFields.push(...siteFields);
          // 诊断里的字段名要藏起这些回答，和一开始就有的资料一样。
          resumeValues.push(...siteFields.map(field => normalizeForOverlap(field.value)).filter(value => value.length >= 2));
          if (!isCurrent()) return;
        }
        const helpers = self.ResumeProAIHelpers;
        // 同名的题要和页面上原有的一起数（#429），所以把整张表的字段也传进去。
        const local = helpers?.localRuleMatches && self.ResumeProProfile
          ? helpers.localRuleMatches(added, resumeFields, self.ResumeProProfile, fresh.fields) : [];
        // 题目名和模板里唯一一项的名称完全相同（「专业」对「专业」），也当场对上；
        // 资料里同名的不止一项（多段教育经历），交给 AI 按上下文分。补充字段和本网站回答上面已经按题目比过，有几类不复用（#429），这里不再看。
        const normalize = value => helpers?.normalizeText ? helpers.normalizeText(value) : String(value ?? "").trim();
        // ResumeProProfile 是启动时必需的脚本；就算缺了，资料里也不会有补充字段（补充字段由它从「我的信息」转出来）。
        const customGroup = self.ResumeProProfile?.CUSTOM_GROUP;
        const siteGroup = self.ResumeProProfile?.SITE_GROUP;
        for (const field of added) {
          if (local.some(match => match.fieldId === field.fieldId)) continue;
          const same = resumeFields.filter(item => item?.value && (!customGroup || item.group !== customGroup) && (!siteGroup || item.group !== siteGroup)
            && normalize(item.key) === normalize(field.label));
          if (same.length === 1) local.push(...(helpers?.filterValidMatches ? helpers.filterValidMatches([field], [{ fieldId: field.fieldId, value: same[0].value }]) : []));
        }
        const localIds = new Set(local.map(match => match.fieldId));
        grown.local += localIds.size;
        grown.matched += localIds.size;
        localIds.forEach(id => grownMatchedIds.add(id));
        pendingNew.push(...added.filter(field => !localIds.has(field.fieldId)));
        const order = match => fieldMap.get(match.fieldId)?.element || fieldMap.get(match.fieldId)?.elements?.[0];
        local.sort((a, b) => (order(a)?.compareDocumentPosition?.(order(b)) & 4) ? -1 : 1);
        queue.splice(position + 1, 0, ...local);
      };
      // 一次补填请求的结果记账。没拿到值的新字段按首轮的口径分（feedback-core 的 fillDrops）：
      // 像密码的不发，太大的没送 AI，AI 看过没给值的算 AI 未匹配，只有请求本身失败才算没拿到结果。
      const noteCatchUp = (batch, reply, more) => {
        const answered = new Set(more.map(match => match.fieldId));
        answered.forEach(id => grownMatchedIds.add(id));
        grown.matched += answered.size;
        const d = reply?.diagnostics || {};
        try { noteAiMisses(d.unansweredIds); } catch { /* diagnostics never break the fill */ }
        const counted = value => Number.isInteger(value) && value > 0 ? value : 0;
        grown.local += counted(d.ruleMatches);
        grown.aiFields += counted(d.aiFields);
        grown.aiMatches += counted(d.aiMatches);
        try {
          if (self.ResumeProFeedback?.aiCalled?.({ diagnostics: reply?.diagnostics, requested: true }) === true) grown.aiCalled = true;
        } catch { /* diagnostics are optional; never break the fill */ }
        let dropped = [];
        try {
          dropped = self.ResumeProFeedback?.fillDrops?.({ fieldCount: batch.length, diagnostics: reply?.diagnostics, requested: true }) || [];
        } catch { /* diagnostics are optional; never break the fill */ }
        for (const [key, value] of dropped) grown.drops[key] = (grown.drops[key] || 0) + value;
        // 请求失败或没发出去的：要用户自己补，错误码和警告说明原因。
        if (dropped.some(([key]) => key === "no_result" || key === "not_sent")) {
          grownMissed.push(...batch.filter(field => !answered.has(field.fieldId)));
          if (typeof d.errorCode === "string" && d.errorCode !== "none") {
            // 留先到的错误码；前一轮只是没资料或太大没送、这一轮请求失败了，换成失败的。
            let code = grown.errorCode || d.errorCode;
            try { code = self.ResumeProFeedback?.shownCode?.(grown.errorCode, d.errorCode) || code; } catch { /* diagnostics are optional; never break the fill */ }
            grown.errorCode = code;
          }
          if (!grownWarning && typeof reply?.warning === "string") grownWarning = reply.warning;
        }
      };

      // #402 普通一键填写分两步：本地规则能确定的空字段先填，AI 请求同时在后台进行；AI 回来后只补剩下的字段，
      // 再照旧复核、补填新出现的字段和记账。已经有内容的字段要问过才覆盖：留到 AI 回来，和其余字段一起只问一次。
      const plain = !assisted && !deep;
      let early = [];
      if (plain) {
        try {
          const helpers = self.ResumeProAIHelpers;
          const local = helpers?.localRuleMatches && self.ResumeProProfile
            ? helpers.localRuleMatches(fields, resumeFields, self.ResumeProProfile) : [];
          // 还没有选项的原生下拉多半在等上一级选好：不先填。
          const ready = new Set(local.filter(match => {
            const entry = fieldMap.get(match.fieldId);
            // #429 第 4 项：传完简历后网站解析填上的不算已有内容，照样先填。
            return entry && isFieldBindingCurrent(entry) && (!hasExistingValue(entry) || parsedBySite(entry))
              && !(entry.kind === "element" && isSelectElement(entry.element) && !hasRealSelectOptions(entry.element));
          }).map(match => match.fieldId));
          // 联动下拉从上往下：上一级没先填，下面几级也不先填。
          const groups = new Map();
          for (const field of fields) {
            if (field.cascadeGroup === undefined) continue;
            if (!groups.has(field.cascadeGroup)) groups.set(field.cascadeGroup, []);
            groups.get(field.cascadeGroup).push(field);
          }
          for (const members of groups.values()) {
            members.sort((a, b) => (a.cascadeLevel ?? 0) - (b.cascadeLevel ?? 0));
            const stop = members.findIndex(field => !ready.has(field.fieldId));
            if (stop >= 0) members.slice(stop).forEach(field => ready.delete(field.fieldId));
          }
          // #429 区间日期两头一起填（见下面写入时的 range）：另一头要等 AI、框里又空着的，这一头也等 AI 回来再填。
          // 另一头框里原来就有日期的照常先填，连同那个日期一起选。
          for (const fieldId of Array.from(ready)) {
            const partnerId = rangePartnerId(fieldMap, fieldMap.get(fieldId));
            if (partnerId && !ready.has(partnerId) && !hasExistingValue(fieldMap.get(partnerId))) ready.delete(fieldId);
          }
          early = local.filter(match => ready.has(match.fieldId)).sort(byOrder);
        } catch {
          early = [];
        }
        // 网页值以点击这一刻为准：等 AI 期间被改过的字段（用户自己填的，或页面带出来的）不覆盖。
        for (const field of fields) {
          const entry = fieldMap.get(field.fieldId);
          if (entry) approvedValues.set(entry, fillValueSnapshot(entry));
        }
        const earlyIds = new Set(early.map(match => match.fieldId));
        if (early.length) awaiting = fields.filter(field => !earlyIds.has(field.fieldId)).map(field => fieldMap.get(field.fieldId)).filter(Boolean);
      }
      // 先填期间在写网页；AI 回来时还是插件写的值的先填字段。
      let writing = false;
      let intactEarly = [];
      // 先填时选项还没出来、没填上的下拉（字典还在加载，或要等上面 AI 的题目先选好）：AI 回来后再试一次。
      // 原来所有字段都等 AI 回来才填，那时选项多半已经有了。被页面拒收、值被改回的不在这里。
      const OPTIONS_LATE = new Set(["options_not_rendered", "options_timeout", "cascade_timeout"]);
      const earlyRetry = [];
      if (cancelButton) {
        cancelButton.hidden = false;
        cancelButton.disabled = false;
        cancelButton.onclick = async () => {
          if (phase === 'fillMs') {
            writeCancelled = true; cancelRequested = true; cancelButton.disabled = true;
            overlayWatch?.stop(true);
            if (catchUpRequestId) self.ResumeProAIClient.cancel(catchUpRequestId).catch(() => {});
            showStatus('已停止后续填写，请核对网页中已填写的内容。', 'error', true);
            return;
          }
          // 先填（#402）还在写时也一样：只取消 AI 等待，本地匹配照常写完，和按钮上写的一致。
          if (phase !== "roundTripMs") return;
          cancelRequested = true;
          cancelButton.disabled = true;
          try {
            const reply = await self.ResumeProAIClient.cancel(requestId);
            cancelRequested = Boolean(reply?.cancelled);
            if (waitHint && phase === "roundTripMs") {
              waitHint.hidden = false;
              waitHint.textContent = !reply?.cancelled ? "请求已结束或无法取消，正在等待结果。"
                : earlyFilled ? "正在取消 AI 等待，已填的会保留。" : "正在取消 AI 等待，保留本地匹配结果。";
            }
          } catch {
            cancelRequested = false;
            if (phase === "roundTripMs") {
              cancelButton.disabled = false;
              if (waitHint) {
                waitHint.hidden = false;
                waitHint.textContent = "取消请求未送达，请重试；当前请求可能仍在等待。";
              }
            }
          }
        };
      }
      const updateProgress = () => {
        if (writing) return;
        const seconds = Math.floor((performance.now() - phaseStart) / 1000);
        button.textContent = earlyFilled ? `已先填 ${earlyFilled} 项，AI 匹配中... ${seconds}s` : `AI 匹配中... ${seconds}s`;
        // #402 等到 30 秒就说：可以接着等，也可以取消，已经填上的不受影响。
        if (seconds >= WAIT_HINT_SECONDS && waitHint && !cancelRequested) {
          waitHint.hidden = false;
          waitHint.textContent = earlyFilled
            ? `已经先填了 ${earlyFilled} 项，剩下的还在等 AI。可以接着等，也可以点取消，已填的会保留。`
            : "AI 还没返回，可以接着等，也可以点取消。";
        }
      };
      writing = early.length > 0;
      if (writing) button.textContent = "正在填写网页...";
      updateProgress();
      timer = window.setInterval(updateProgress, 1000);
      // A stop during the preparation above had no request to cancel yet: send nothing.
      if (assisted?.stopped?.()) throw new Error("已停止辅助填写。");
      if (deep?.stopped?.()) { cancelRequested = true; throw new Error("已停止深度填写，网页没有改动。"); }
      assisted?.onRequest?.(requestId);
      deep?.onRequest?.(requestId);
      requested = true;
      const pending = self.ResumeProAIClient.send({
        type: "AI_FILL",
        requestId,
        formFields: fields,
        resumeFields,
        // 辅助填写只发选中区域的字段：同名的题要和整张表一起数（#429）。
        ...(assisted ? { pageLabels: scanned.fields.map(field => String(field.label ?? "")) } : {}),
        ...(deep?.tier ? { tier: deep.tier, maxCalls: deep.maxCalls } : {})
      });
      aiPending = true;
      // 先填期间请求出错不能成为未处理的拒绝；结果在 settleAi 里照旧处理。
      // 记下 AI 回来的时刻：比先填先回来时，匹配往返不算等先填写完的时间。
      const aiSettled = () => { aiPending = false; aiDoneAt = performance.now(); };
      pending.then(aiSettled, aiSettled);
      let response = null;
      // AI 回来以后：照旧检查结果，再把先填以外的匹配排进 queue。没有先填时拒绝覆盖，返回和末尾同形的结果。
      const settleAi = async () => {
        const earlyRan = waitingAi;
        if (waitingAi) {
          earlyFillMs = performance.now() - earlyFrom;
          earlyFrom = null;
          waitingAi = false;
          writing = false;
          stage = "match";
          earlyFilled = filledCount;
          updateProgress();
        }
        response = await pending;
        timing.roundTripMs = (aiDoneAt ?? performance.now()) - phaseStart;
        phase = null;
        window.clearInterval(timer);
        timer = null;
        if (waitHint) waitHint.hidden = true;
        diagnostics = response?.diagnostics || {};
        responded = Boolean(response);
        try { noteAiMisses(diagnostics.unansweredIds); } catch { /* diagnostics never break the fill */ }
        aiDown = Boolean(self.ResumeProFeedback?.requestFailed?.(diagnostics.errorCode));
        // Cancellation may race a successful AI reply. Only the worker's explicitly
        // cancelled response may retain its documented local matches.
        if (cancelRequested && diagnostics.errorCode !== 'cancelled') {
          writeCancelled = true;
          throw new Error('已取消填写，忽略迟到的 AI 结果。');
        }
        matched = Array.isArray(response?.matches) ? response.matches.length : null;
        if (assisted?.stopped?.()) throw new Error("已停止辅助填写。");
        // 深度分析在等 AI 时被停止：worker 会带回本地匹配，但用户已经说了停，一项都不写。
        if (deep?.stopped?.()) { cancelRequested = true; throw new Error("已停止深度填写，网页没有改动。"); }

        if (response?.openView === "settings-ai") {
          state.suggestedView = "settings-ai";
          await openManager("settings-ai");
        }
        if (!response?.success) {
          throw new Error(response?.error || "AI 填写失败。");
        }
        // 等 AI 时字段所在的同源框架换了页或被删掉（#400）：和顶层换页一样算页面变了，不往旧文档里写。
        if (framesGone()) {
          cancelRequested = true;
          throw new Error("已停止填写，页面或填写会话已变化。");
        }

        button.textContent = "正在填写网页...";
        phase = "fillMs";
        stage = "fill";
        phaseStart = performance.now();

        // 先填过的不再填。先填时选项还没出来的，网页上还是点击时的样子，就和 AI 的字段一起按页面顺序再试这一次。
        const done = new Set(early.map(match => match.fieldId));
        const retry = earlyRetry.splice(0).filter(item => {
          const entry = fieldMap.get(item.match.fieldId);
          const current = entry && (isFieldBindingCurrent(entry) ? entry : rebindFieldEntry(entry));
          return Boolean(current) && fillValueSnapshot(current) === approvedValues.get(entry);
        });
        const sortedMatches = [...response.matches.filter(match => !done.has(match.fieldId)), ...retry.map(item => item.match)].sort(byOrder);
        if (assisted) {
          queue.push(...sortedMatches);
          return null;
        }
        // 先填过、这时还是插件写的值的字段：AI 这一步选完上面的题目后，页面可能把它清回原样（证件类型→证件号码）。
        if (earlyRan) intactEarly = verifiedControls.filter(item => done.has(item.fieldId)
          && isFieldBindingCurrent(item.element) && fillValueSnapshot(item.element) === item.after);
        const later = [];
        const occupied = new Set();
        const keep = (match) => {
          const meta = fieldMetaMap.get(match.fieldId);
          kept.push(meta?.label || meta?.placeholder || meta?.name || "未命名字段");
        };
        for (const match of sortedMatches) {
          let entry = fieldMap.get(match.fieldId);
          if (entry && !plain) approvedValues.set(entry, fillValueSnapshot(entry));
          else if (entry && !isFieldBindingCurrent(entry)) {
            // 先填的选择让页面重画了后面的字段（#269 智联）：找回的新字段和点击时一样，就按新字段判断有没有内容；
            // 新字段的内容变了（等 AI 时用户在新字段里填了，或页面带出的值），和没重画的字段一样保留不覆盖。
            // 找不回或读不出内容的，交给下面循环里原有的重绑和写入前复查。
            const fresh = rebindFieldEntry(entry);
            const now = fresh ? fillValueSnapshot(fresh) : null;
            if (now === null) {
              later.push(match);
              continue;
            }
            if (now !== approvedValues.get(entry)) {
              keep(match);
              continue;
            }
            approvedValues.set(fresh, approvedValues.get(entry));
            if (pageFilled.has(entry)) pageFilled.add(fresh);
            fieldMap.set(match.fieldId, fresh);
            entry = fresh;
          } else if (entry && fillValueSnapshot(entry) !== approvedValues.get(entry)) {
            keep(match);
            continue;
          }
          // 先填时页面跟着带出值的另一半（Moka 的月份）不算已有内容。
          // 不填的（blocked）不用问要不要覆盖。
          // 网站解析简历填上的（#429 第 4 项）不是用户手动改的，有资料就填，不问。
          if (entry && !match.blocked && !pageFilled.has(entry) && hasExistingValue(entry) && !parsedBySite(entry)) occupied.add(entry);
          later.push(match);
        }
        if (occupied.size && !window.confirm(
          `本次将重新填写 ${occupied.size} 个已有内容的字段，可能覆盖你手动修改的内容。\n\n确定继续填写吗？${earlyRan
            ? "取消会保留这些字段的现有内容，剩下的字段也不再填写，已经先填的不受影响。"
            : "取消将保留网页现有内容，本次不会写入任何字段。"}AI 匹配已完成，取消不会撤销已发生的 AI 请求。`
        )) {
          overwriteDeclined = true;
          cancelRequested = true;
          if (earlyRan) {
            // 先填的已经写上了：剩下的不再填写，先填的照常同步，结果按部分完成算。
            await finalSyncFillSession(session);
            throw new Error(`已取消后续填写，已有内容的字段没有改动。此前已填写 ${filledCount} 项，请核对网页。`);
          }
          showStatus("已取消填写，网页现有内容未修改。", "error", true);
          // finally 照常收尾；返回和末尾同形的结果，深度填写据此说明是用户取消（#224）。
          return { outcome: "failed", filledCount: 0, unconfirmedCount: 0, unfilledCount: 0, error: "", overwriteDeclined: true,
            calls: Number(diagnostics.calls) || 0, budgetExhausted: Boolean(diagnostics.budgetExhausted) };
        }
        // 要再试的：先填那次记下的没填上撤掉，以这次的结果为准。
        for (const item of retry) {
          const control = unfilledControls.indexOf(item.control);
          if (control >= 0) unfilledControls.splice(control, 1);
          const label = unfilledLabels.lastIndexOf(item.label);
          if (label >= 0) unfilledLabels.splice(label, 1);
        }
        queue.push(...later);
        return null;
      };
      if (early.length) {
        queue.push(...early);
        waitingAi = true;
        stage = "fill";
        earlyFrom = performance.now();
      } else {
        const declined = await settleAi();
        if (declined) return declined;
      }
      for (let position = 0; ; position++) {
        // 先填的本地匹配填完了（#402）：等 AI 回来，把剩下的字段排进来接着填。新出现字段的补填还在这之后。
        if (position >= queue.length && waitingAi) await settleAi();
        // AI 这一步的字段也填完了：先填过的字段被页面清回点击时的样子（上面的选择变了，页面清空下面的），
        // 按原值再填一次，和原来从上往下填的结果一样。只看这一遍。
        if (position >= queue.length && intactEarly.length && isCurrent()) {
          for (const item of intactEarly.splice(0)) {
            const fresh = isFieldBindingCurrent(item.element) ? item.element : rebindFieldEntry(item.element);
            const now = fresh ? fillValueSnapshot(fresh) : null;
            const index = verifiedControls.indexOf(item);
            if (now === null || now !== approvedValues.get(item.element) || now === item.after || index < 0) continue;
            // 换成这次重填的记账：先前那次不再算填上，也不再复核。
            verifiedControls.splice(index, 1);
            filledCount -= 1;
            if (item.isNew) supplemented -= 1;
            if (item.element.kind === "element" && dayDefaultedControls.has(item.element.element)) dayDefaulted -= 1;
            queue.push(early.find(match => match.fieldId === item.fieldId));
          }
        }
        if (position >= queue.length) {
          // 停下来的、两轮补填用完的、首轮 AI 已经失败的：排队的新字段不再发出，循环后统一收尾。
          // 用户取消了 AI 等待（#402）：先填时选出来的新字段也不再发 AI，请用户自己补。
          if (assisted || deep || !pendingNew.length || !isCurrent() || catchUpRounds >= 2 || aiDown || diagnostics.errorCode === "cancelled") break;
          catchUpRounds += 1;
          const batch = pendingNew.splice(0);
          button.textContent = "正在补填新出现的字段...";
          let reply = null;
          catchUpRequestId = `${requestId}-more-${catchUpRounds}`;
          try {
            // pageLabels：页面上已知的全部题目（首轮扫到的整张表加上后来冒出来的），worker 数同名的题要和这一批以外的一起数（#429）。
            reply = await self.ResumeProAIClient.send({ type: "AI_FILL", requestId: catchUpRequestId, formFields: batch, resumeFields,
              pageLabels: [...scanned.fields, ...grownFields].map(field => String(field.label ?? "")) });
          } catch {
            reply = null;
          }
          catchUpRequestId = null;
          button.textContent = "正在填写网页...";
          // 等补填时按了停止或换了页：这一批的结果不用，算没送 AI。
          if (!isCurrent()) { pendingNew.push(...batch); break; }
          const ids = new Set(batch.map(field => field.fieldId));
          const more = reply?.success && Array.isArray(reply.matches) ? reply.matches.filter(match => ids.has(match.fieldId)) : [];
          noteCatchUp(batch, reply, more);
          if (!more.length) break;
          queue.push(...more);
        }
        const match = queue[position];
        if (!isCurrent()) throw stopError();
        if (assisted?.stopped?.()) throw new Error("已停止辅助填写。");
        if (assisted && JSON.stringify(getActiveTemplate(state.currentStore)) !== activeTemplateFingerprint) throw new Error("模板已变化，已停止辅助填写，请核对网页。");
        let element = fieldMap.get(match.fieldId);

        if (!element) continue;
        // #269 页面整块重画过（智联选完学位，整张表单删掉重建）：找回同一个字段；它的内容和批准时一样
        // （插件还没填它、用户也没动过），就在新字段上接着填。
        if (!assisted && !isFieldBindingCurrent(element)) {
          const fresh = rebindFieldEntry(element);
          if (fresh && fillValueSnapshot(fresh) === approvedValues.get(element)) {
            approvedValues.set(fresh, approvedValues.get(element));
            fieldMap.set(match.fieldId, fresh);
            element = fresh;
          }
        }
        // 匹配期间页面可能展开、重渲染：控件已经不在原来的题目下，就不按旧的对应关系写。
        if (!isFieldBindingCurrent(element)) {
          const stale = fieldMetaMap.get(match.fieldId);
          if (stale?.cascadeGroup !== undefined) failedCascadeGroups.add(stale.cascadeGroup);
          if (assisted) {
            unconfirmedCount += 1;
          } else {
            const staleMeta = fieldMetaMap.get(match.fieldId);
            unfilledLabels.push(`${staleMeta?.label || staleMeta?.placeholder || staleMeta?.name || "未命名字段"}（页面已变化）`);
            unfilledControls.push({ label: "（字段名已隐藏）", reason: "页面已变化", reasonCode: "element_disconnected",
              control: withFillProbe(api => api.describeControl(element), null) });
          }
          continue;
        }
        if (assisted && (!isAssistedTextField(element) || hasExistingValue(element) || !assisted.scopes.some(scope => scope.isConnected && scope.contains(element.element)))) continue;

        // 控件内部也会异步等待；实际写入及重试前复查，不能仅在进入控件时检查。
        const beforeWrite = assisted ? undefined : (userEdited = false) => {
          if (overwriteDeclined || !isCurrent()) return false;
          const currentValue = fillValueSnapshot(element);
          if (!userEdited && currentValue !== null && currentValue === approvedValues.get(element)) return true;
          overwriteDeclined = true;
          cancelRequested = true;
          outcome = filledCount ? "partial" : "failed";
          showStatus(`填写期间检测到字段内容变化，已停止后续填写，保留该字段的现有内容。此前已填写 ${filledCount} 项，请核对网页。`, "error", true);
          return false;
        };
        const fieldMeta = fieldMetaMap.get(match.fieldId);
        if (fieldMeta?.cascadeGroup !== undefined && failedCascadeGroups.has(fieldMeta.cascadeGroup)) {
          noteControlFailure(element, fieldMeta, match.value, 'cascade_parent_failed');
          continue;
        }
        if (match.blocked) {
          noteControlFailure(element, fieldMeta, match.value, match.blocked);
          continue;
        }
        // Host-owned accounting callback: a guard refusal before any write is
        // skipped, while an interrupted attempted write remains unconfirmed.
        let writeAttempted = false;
        const onWrite = () => { writeAttempted = true; };
        const controlCurrent = () => isCurrent() && isFieldBindingCurrent(element);
        const stopInterruptedControl = () => {
          if (!overwriteDeclined && isCurrent()) return;
          cancelRequested = true;
          noteControlFailure(element, fieldMeta, match.value, textFillFailureCode(element) || 'cancelled', writeAttempted);
          throw new Error(overwriteDeclined
            ? "字段内容已变化，已停止后续填写并保留现有内容，请核对网页。"
            : "已停止填写，请核对网页。");
        };
        // #301 Moka 起止时间：选了年，页面会把同一对里还空着的月带成 1。只看只装着这两个字段的那一层里排在后面的另一半，
        // 它从批准起没变、还空着；选完后它变了，就按页面带出的值重新批准，不当成用户改的。
        const choice = entry => CHOICE_CONTROL_KINDS.has(entry.kind === "radio" ? "radio" : entry.controlKind);
        const pair = element.binding?.item?.parentElement;
        const inPair = entry => { const node = entry.kind === "radio" ? entry.elements?.[0] : entry.element; return Boolean(node) && pair.contains(node); };
        // 先填阶段（#402）另一半可能还在等 AI，不在 queue 里。
        const partner = !assisted && !deep && pair && choice(element) && [...new Set(fieldMap.values())].filter(inPair).length === 2
          ? [...queue.slice(position + 1).map(next => fieldMap.get(next.fieldId)), ...(waitingAi ? awaiting : [])]
            .find(other => other && other !== element && choice(other)
            && other.binding?.item?.parentElement === pair && fillValueSnapshot(other) === approvedValues.get(other) && !hasExistingValue(other))
          : null;
        const partnerBefore = partner ? fillValueSnapshot(partner) : null;
        // #429 区间日期：另一头这次也要填的，把它的值一起交给控件层，一次点开填完两头（见 control-adapters.js 的 operateRange）。
        const rangeId = rangePartnerId(fieldMap, element);
        const writeField = async () => {
          let other = rangeId ? fieldMap.get(rangeId) : null;
          // 页面重画过（下面找回新字段重试时）：另一头也按新页面找回，和这一头一样，内容和批准时一样才换成新的。
          if (other && !isFieldBindingCurrent(other)) {
            const fresh = rebindFieldEntry(other);
            if (fresh && fillValueSnapshot(fresh) === approvedValues.get(other)) {
              approvedValues.set(fresh, approvedValues.get(other));
              fieldMap.set(rangeId, fresh);
              other = fresh;
            }
          }
          const range = other ? { entry: other, value: queue.find(next => next.fieldId === rangeId)?.value ?? null } : null;
          const before = range ? fillValueSnapshot(range.entry) : null;
          const done = await setElementValue(element, match.value, beforeWrite, controlCurrent, onWrite, { fill: true, range });
          // 另一头的框是这次一起填上的：按填上的值重新批准，轮到它时不当成用户改的。
          if (range && approvedValues.get(range.entry) === before) {
            const now = fillValueSnapshot(range.entry);
            if (now !== null && now !== before) approvedValues.set(range.entry, now);
          }
          return done;
        };
        let filled = await writeField();
        stopInterruptedControl();
        // 选完页面立刻重画（智联学位）：旧字段已经不在了，看找回的新字段——
        // 内容和填写前一样（重建冲掉了这次写入）就在新字段上重做一次；显示的正是刚选的值就算填上；
        // 别的内容（可能是用户刚改的，或页面带出的）不碰，按未确认处理。
        if (!filled && !assisted && writeAttempted && textFillFailureCode(element) === "element_disconnected") {
          const fresh = rebindFieldEntry(element);
          const approved = approvedValues.get(element);
          const now = fresh ? fillValueSnapshot(fresh) : null;
          if (fresh && now !== null && now === approved) {
            approvedValues.set(fresh, approved);
            fieldMap.set(match.fieldId, fresh);
            element = fresh;
            filled = await writeField();
            stopInterruptedControl();
          } else if (fresh && showsFilledValue(fresh, match.value)) {
            approvedValues.set(fresh, now);
            fieldMap.set(match.fieldId, fresh);
            textFillFailures.delete(fresh.kind === "radio" ? fresh.elements[0] : fresh.element);
            element = fresh;
            filled = true;
          }
        }
        if (assisted && filled) {
          await new Promise(resolve => window.setTimeout(resolve, 50));
          // 日期控件显示的是组件自己的格式（猎聘是「1998年06月」）：交给控件层按面板精度复核，不逐字比较（#236）。
          // 手机号框自己加了空格、短横的按数字比（#229），日期样式的文本框按年月日比（#399）。节点被页面替换的，都算未确认。
          filled = element.element.isConnected && (element.pickerType
            ? Boolean(controlOperator?.check(element)?.ok)
            : showsPreparedText(element.element, String(element.element.value ?? ""), match.value));
        }

        // 联动下拉的选项是上一级选完才异步加载的。没被识别成联动组、但除了「请选择」还没有选项的下拉框
        // 也按同样的方式等一等（和 worker 放行它用的是同一个判断）；选项出来了却对不上，不再白等。
        if (!filled && element.kind === "element" && isSelectElement(element.element)
          && (fieldMeta?.cascadeGroup !== undefined || !hasRealSelectOptions(element.element))) {
          for (let retry = 0; retry < 3; retry++) {
            await new Promise((resolve) => setTimeout(resolve, 150));
            filled = await setElementValue(element, match.value, beforeWrite, controlCurrent, onWrite, { fill: true });
            stopInterruptedControl();
            if (filled || (fieldMeta?.cascadeGroup === undefined && hasRealSelectOptions(element.element))) break;
          }
        }

        if (filled) {
          filledCount += 1;
          if (newFieldIds.has(match.fieldId)) supplemented += 1;
          if (element.kind === "element" && dayDefaultedControls.has(element.element)) dayDefaulted += 1;
          verifiedControls.push({ element, fieldMeta, value: match.value, after: fillValueSnapshot(element), isNew: newFieldIds.has(match.fieldId),
            fieldId: match.fieldId });
          highlightFilledField(element, match.value);
          if (element.kind === "element" && !element.pickerType && !["custom-select", "cascader"].includes(element.controlKind)) {
            recordFilledTextControl(session, element.element);
          }
        } else {
          // #399 #405 写入被拒的文本框：前 3 个看满 1 秒有没有冒出弹层再填下一个，免得把下一个字段的弹层算到它头上。
          // 再往后的不等：下一个字段开始时停下，没看到弹层就不报。按停止时马上不等（见停止按钮）。
          if (!assisted && TEXT_REJECTED.has(textFillFailureCode(element)) && overlayWaits < OVERLAY_WAITS) {
            overlayWaits += 1;
            await overlayWatches.get(element.element)?.settled;
          }
          // 北森的日期也是选择框（phoenix-select），所以选择类控件也延后；复核算填上的不再补扫选后新出现的字段。
          const reason = textFillFailureCode(element);
          if (!assisted && reason === "validation_not_cleared") {
            invalidControls.push({ element, fieldMeta, value: match.value, isNew: newFieldIds.has(match.fieldId) });
          } else {
            const labels = unfilledLabels.length;
            const controls = unfilledControls.length;
            noteControlFailure(element, fieldMeta, match.value, reason);
            // #402 先填时选项还没出来：照常记下没填上，AI 回来后再试一次（见 settleAi）。联动组的下一级会被挡住，不算。
            if (waitingAi && OPTIONS_LATE.has(reason) && fieldMeta?.cascadeGroup === undefined && early.includes(match)
              && unfilledLabels.length > labels) {
              earlyRetry.push({ match, label: unfilledLabels[labels], control: unfilledControls[controls] });
            }
          }
          if (fieldMeta?.cascadeGroup !== undefined) failedCascadeGroups.add(fieldMeta.cascadeGroup);
        }

        if (filled && fieldMeta?.cascadeGroup !== undefined) {
          const groupFields = fields.filter((f) => f.cascadeGroup === fieldMeta.cascadeGroup);
          const maxLevelInGroup = Math.max(...groupFields.map((f) => f.cascadeLevel));
          
          if (fieldMeta.cascadeLevel < maxLevelInGroup) {
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }

        if (filled && !assisted && !deep && CHOICE_CONTROL_KINDS.has(element.kind === "radio" ? "radio" : element.controlKind)) {
          await pickUpNewFields(position, entryDocument(element));
          const partnerNow = partner ? fillValueSnapshot(partner) : null;
          if (partnerNow !== null && partnerNow !== partnerBefore) {
            approvedValues.set(partner, partnerNow);
            if (waitingAi) pageFilled.add(partner);
          }
        }
      }
      // 最后一次选择后等页面安静、重扫时按了停止，也不算正常结束（#301），有没有待补的新字段都一样。
      if (!assisted && !deep && !isCurrent()) throw stopError();
      await finalSyncFillSession(session);
      // 最后同步要等文字提交，这时按的停止也一样。
      if (!assisted && !deep && !isCurrent()) throw stopError();
      // 两轮补填用完或首轮 AI 已经失败，还在排队的新字段也要用户自己补。
      grownMissed.push(...pendingNew);

      // A later control's focus can roll back an earlier picker. Re-read the final
      // state before counting success; verification never writes or retries.
      recheckVerifiedControls();
      stage = null;

      // 只提还在网页上的新字段（页面重画过的按题目找回）。
      const grownLeft = grownMissed.filter(field => {
        const entry = fieldMap.get(field.fieldId);
        return isFieldBindingCurrent(entry) || Boolean(rebindFieldEntry(entry));
      });
      outcome = response.warning || unconfirmedCount || unfilledLabels.length || grownLeft.length || kept.length ? "partial" : "success";
      const supplementNote = (supplemented ? `（其中新出现的字段补填 ${supplemented} 项）` : "")
        + (dayDefaulted ? `（${dayDefaulted} 项日期资料里只有年月，已按 1 日填写）` : "");
      const unfilledNote = (unfilledLabels.length
        ? `${unfilledLabels.length} 项没填上：${summarizeLabels(unfilledLabels)}，请手动补上。` : '')
        + (unconfirmedCount ? `${unconfirmedCount} 项未确认，请核对网页。` : '')
        + (grownLeft.length ? `新出现的 ${grownLeft.length} 项没有补填：${summarizeLabels(grownLeft.map(field => field.label))}，请手动补上。`
          + (grownWarning !== response.warning ? grownWarning : '') : '')
        + (kept.length ? `等 AI 时有改动的 ${kept.length} 项没有覆盖：${summarizeLabels(kept)}，请核对。` : '');
      const emptyHint = viewModeHint();
      const recipeLead = !deep && recipeUse?.status === "hit" ? "已按本站配方定位字段。" : "";
      const recipeTail = !deep && recipeUse?.status === "stale" ? "本站配方可能已过期，可以重新深度分析。" : "";
      if (assisted) {
        report(`辅助填写：已验证 ${filledCount} 项。${unconfirmedCount ? `${unconfirmedCount} 项未确认，请核对网页。` : ""}${response.warning || ""}`, outcome === "partial" ? "error" : "success");
      } else if (emptyHint) {
        hinted = true;
        // 一个都没填上：提示放最后，AI 的提醒和没填上的字段照旧列出。
        // 状态已经说要先点「编辑」了，诊断和留档就不能再写「完成」；已经是部分完成的保持不变。
        if (outcome === "success") outcome = "failed";
        showStatus(`${recipeLead}已填写 0 个字段。${unfilledNote}${response.warning || ""}${emptyHint}${recipeTail}`, "error", true);
      } else if (response.warning) {
        showStatus(`${recipeLead}本地已填写 ${filledCount} 项${supplementNote}；${unfilledNote}${response.warning}${recipeTail}`, "error", Boolean(unfilledNote || recipeTail));
      } else if (unfilledNote) {
        // 没填上的字段要用户自己去补，提示不自动消失。
        showStatus(`${recipeLead}已填写 ${filledCount} 个字段${supplementNote}。${unfilledNote}${recipeTail}`, "error", true);
      } else if (recipeTail) {
        showStatus(`已填写 ${filledCount} 个字段${supplementNote}。${recipeTail}`, "success", true);
      } else {
        showStatus(`${recipeLead}已填写 ${filledCount} 个字段${supplementNote}。`, "success");
      }

      if (!assisted) {
        const matchedIds = new Set([...response.matches.map((match) => match.fieldId), ...grownMatchedIds]);
        // 只有对上了题目的字段才问：占位文字、计数器、跨行借来的文字都不会出现在这里。
        // 选完后新出现的字段和首轮的一样问（#301）。
        const offerStats = {};
        offerUnansweredFields([...fields, ...grownFields].flatMap((field) => {
          const entry = fieldMap.get(field.fieldId);
          if (!(entry?.offerable && entry.offerLabel)) return [];
          const control = entry.element || entry.elements?.[0];
          return [{
            label: entry.offerLabel,
            title: entry.binding?.label || "",
            section: entry.binding?.section || "",
            sectionRepeatable: Boolean(entry.binding?.sectionRepeatable),
            inputType: field.inputType,
            matched: matchedIds.has(field.fieldId),
            autocomplete: control?.getAttribute?.("autocomplete") || "",
            entry
          }];
        }), offerStats);
        // 「加到我的信息」没问的字段：只有这里真的挑过一遍，辅助新增和填写失败时不记。
        if (stats) stats.offerSkipped = { ambiguous: stats.ambiguous || 0, entry: offerStats.entry || 0 };
      }
    } catch (error) {
      // 先填（#402）已经写上了几项、AI 这一步才出错：先填的文字照常做最后一次同步，和拒绝覆盖时一样。
      // 这不是停止，用户没让停下写入。
      if (stage === "match" && filledCount > 0) await finalSyncFillSession(session);
      // Interrupted fills still get a read-only final count; never replay focus,
      // write, or retry after a stop/overwrite refusal.
      recheckVerifiedControls();
      // 先填已经写上了几项：也是部分完成，并说清网页上已经填了几项。
      const filledEarly = stage === "match" && filledCount > 0;
      if (stage === "fill" || filledEarly) outcome = filledCount > 0 ? "partial" : "failed";
      failedStage = stage;
      if (!scanDone) {
        // #408 扫描还没做完就出错，或控件一个都没读出来（「没找到输入框」在扫描完成之后才报）：上报错误类型和
        // 本扩展代码的位置，诊断记 scan_exception，页面结构在 finally 里补上。网页上不显示英文原文。
        scanFault = reportError(error);
        diagnostics = { errorCode: "scan_exception" };
        failure = `读这个页面的表单时出错了。${!assisted && !deep && self.ResumeProDeepAnalysis && self.ResumeProPageOutline
          ? "可以试试下方的「深度分析本页」。" : "可以把侧栏的「填写诊断」复制给我们。"}`;
        hinted = true;
      } else {
        failure = error.message || "AI 填写失败。";
        if (filledEarly) failure += `已先填写 ${filledCount} 项，请核对网页。`;
      }
      if (!deep && recipeUse?.status === "stale") failure += "本站配方可能已过期，可以重新深度分析。";
      // AI 没匹配上（none / no_context）才补这个提示；认证、网络等失败与页面状态无关。
      if (!hinted && ["none", "no_context"].includes(diagnostics.errorCode)) {
        const hint = viewModeHint();
        failure += hint;
        hinted = Boolean(hint);
      }
      report(failure, "error", hinted);
    } finally {
      if (cancelButton) {
        cancelButton.hidden = true;
        cancelButton.onclick = null;
      }
      if (waitHint) waitHint.hidden = true;
      if (timer !== null) window.clearInterval(timer);
      // 先填时出错或被停下（#402）：后台还在等的 AI 请求一并取消，不让它白等到超时。
      if (aiPending) {
        aiPending = false;
        try { Promise.resolve(self.ResumeProAIClient.cancel(requestId)).catch(() => {}); } catch { /* the request ends on its own */ }
      }
      // 填写耗时 = 先填的时间 + AI 回来后填写的时间；等 AI 的时间算在匹配里。
      if (earlyFrom !== null) earlyFillMs = performance.now() - earlyFrom;
      if (phase) timing[phase] = (phase === "roundTripMs" && aiDoneAt !== null ? aiDoneAt : performance.now()) - phaseStart
        + (phase === "fillMs" ? earlyFillMs : 0);
      if (timing.fillMs === null && earlyFillMs) timing.fillMs = earlyFillMs;
      const totalMs = performance.now() - totalStart;
      // #408 扫描出错时补跑页面探测和输入框计数，报告里照样有页面结构。没扫完，谈不上并入同一控件。
      if (!scanDone && !probe) {
        // 控件全都读不出来时已经有这次扫描的计数（含 scan_error），不再重数。
        if (!stats) {
          try {
            stats = { ...scanStats(null, 0), grouped: 0 };
          } catch {
            stats = null;
          }
        }
        probe = withFillProbe(api => api.probePage(document, { href: location.href }), null);
        pageType = withFillProbe(api => api.pageType({ pathname: scanPath, hash: location.hash, title: document.title, probe, stats }), null);
      }
      // 没轮到补填就结束的新字段（两轮用完、首轮 AI 已经失败、中途停止或出错）算没送 AI。
      if (pendingNew.length) grown.drops.not_sent = (grown.drops.not_sent || 0) + pendingNew.length;
      const totalFields = fieldCount + grown.found;
      const totalMatched = matched === null ? null : matched + grown.matched;
      // 补填的 AI 请求失败（#301）：首轮没有错误码时，类别和阶段按它算，和诊断里的 error_code 一致。
      // #497 资料里有这一类、AI 却没匹配上的字段数：够 AI_MISSED_MIN 项就单独上报（error_category ai_missed）。
      const aiMissedWithData = aiMisses.filter(item => item.inResume).length;
      const verdict = fillVerdict({ scanned: scanDone, fieldCount: totalFields, pageType: pageType?.type ?? null, frames: probe?.frames ?? null,
        failedStage, responded, errorCode: diagnostics.errorCode, catchUpCode: grown.errorCode, matched: totalMatched, filledCount,
        unfilledCount: unfilledLabels.length, unconfirmedCount, aiMissedWithData });
      const summaryInput = { ...timing, totalMs,
        fieldCount: totalFields, filledCount, unfilledCount: unfilledLabels.length, outcome, diagnostics, probe, unfilledControls,
        path: scanPath, pageType, readyAtScan, stats, matched: totalMatched, requested, unconfirmedCount, ...verdict, grown,
        entry, pageFocused, genericCustom, genericLocked, scanFault, earlyFilled, keptCount: kept.length,
        // #497 公开报告只用类别和「资料里有没有」，题目留在私有诊断。
        aiMissed: aiMisses.map(item => ({ kind: item.kind, inResume: item.inResume })),
        // 「深度分析本页」入口判断用（#224）；只有计数和标记。
        scannedCustom, cancelled: cancelRequested, overwriteDeclined, assisted: Boolean(assisted),
        // #226 本站配方：命中 / 过期 / 未使用及计数（深度分析保存的结果稍后补上）。
        recipe: recipeUse,
        // 总调用次数 = 分析阶段（deep.report.analysisCalls）+ 本次匹配（diagnostics.calls）。
        deep: deep ? { ...deep.report, calls: (Number(deep.report?.analysisCalls) || 0) + (Number(diagnostics.calls) || 0),
          budgetExhausted: Boolean(deep.report?.budgetExhausted || diagnostics.budgetExhausted) } : null };
      if (session === fillSession) session.summary = summaryInput;
      // #226：普通一键填写（含按配方的）核验后的结果，作为同一页面深度分析的比较基线。取消、拒绝覆盖、
      // 认证或网络这类失败不算基线（不代表这个页面普通填写能填多少）。
      if (!assisted && !deep) {
        const comparable = fieldCount === 0 || stage === null || ["none", "no_context"].includes(diagnostics.errorCode);
        if (scanDone && !cancelRequested && !overwriteDeclined && comparable) lastPlainFill = { href: fillUrl, filled: filledCount };
      }
      // 侧栏、手动反馈和自动上报用同一份输入，两个通道的诊断块一致。
      const reportInput = { ...summaryInput, unsyncedCount: session === fillSession ? session.unsynced : 0 };
      // 侧栏的一键填写前看过上传框、没出卡片：上传那一行补在这次填写的诊断后面（只在这一次）。
      if (entry === "panel" && upload.reportForFill && upload.report) reportInput.upload = upload.report;
      upload.reportForFill = false;
      writeFillDiagnostics(reportInput);
      // #497 私有诊断的材料：有没写上的、AI 没匹配上的字段，或扫描出错时才留。拼成文字（要遍历整页做大纲）留到用得上时：
      // 同意了自动报告、这次要发的时候（放开忙碌状态之后），或手动反馈预览的时候。
      // 没同意自动报告的人，自动报告和手动反馈都不带私有层：页面元素和资料值不留到下一次填写。
      lastPrivate = feedbackAgreed && (privateUnfilled.length || aiMisses.length || scanFault?.message)
        ? { input: { unfilled: privateUnfilled, missed: aiMisses, fault: scanFault, values: privateValues || redactionValues(activeTemplate, profileFields) },
          text: null } : null;
      const privateHolder = lastPrivate;
      // Feedback cannot delay filling, archiving or releasing the busy state.
      let autoReport = null;
      try {
        // 不是网申填写页（page_not_supported）不上报：没有可修的东西。AI 请求失败（首轮或补填，#301）即使都填上了也上报；
        // 没装桌面端、没配对、没配置模型不算请求失败。
        // 深度填写（#224）和辅助新增一样不自动上报：隐私说明里自动报告只覆盖普通一键填写。
        const kind = self.ResumeProFeedback?.fillFailure({ assisted: Boolean(assisted || deep), cancelled: cancelRequested,
          overwriteDeclined, fieldCount, filledCount, unfilledCount: unfilledLabels.length, unconfirmedCount,
          editHint: hinted && probe?.editButtons > 0, category: verdict.category, errorCode: diagnostics.errorCode, catchUpCode: grown.errorCode });
        if (kind) autoReport = { kind, diagnostics: self.ResumeProFeedback.fillReport(reportInput) };
      } catch { /* feedback is optional; never break the fill lifecycle */ }
      state.aiBusy = false;
      button.disabled = state.desktopMode !== "ready" || !hasResumeData();
      if (repeatButton) repeatButton.disabled = state.desktopMode !== "ready" || !getActiveTemplate(state.currentStore);
      button.textContent = "一键 AI 填写";
      // 没同意自动报告时后台什么都不发，私有诊断也就不做。
      if (autoReport) {
        try {
          const hidden = feedbackAgreed ? privateText(privateHolder) : "";
          Promise.resolve(chrome.runtime.sendMessage({ type: "FEEDBACK_AUTO", report: { ...autoReport, ...(hidden ? { private: hidden } : {}) } }))
            .catch(() => {});
        } catch { /* feedback is optional; never break the fill lifecycle */ }
      }
      // A page with nothing to fill produced nothing worth archiving.
      if (fieldCount > 0 && (!overwriteDeclined || filledCount > 0)) {
        offerFillRecord({
          outcome, cancelled: cancelRequested, fieldCount: totalFields, filledCount, unconfirmedCount,
          timing: { scanMs: timing.scanMs, roundTripMs: timing.roundTripMs, fillMs: timing.fillMs, totalMs },
          templateName: activeTemplate?.name,
          endedAt: new Date().toISOString()
        }, activeTemplate).catch(() => {});
      }
    }
    return { outcome, filledCount, unconfirmedCount, unfilledCount: unfilledLabels.length, error: failure, overwriteDeclined,
      fieldCount: fieldCount + grown.found, calls: Number(diagnostics.calls) || 0, budgetExhausted: Boolean(diagnostics.budgetExhausted) };
  }

  function summarizeLabels(labels, limit = 5) {
    const unique = [...new Set(labels.map((label) => String(label ?? "").trim()).filter(Boolean))];
    const shown = unique.slice(0, limit).join("、");
    return unique.length > limit ? `${shown} 等` : shown;
  }

  // 比较字段名和简历内容前先去掉空白、统一全角半角和大小写。
  function normalizeForOverlap(text) {
    return String(text ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  }

  // 失败类别和第一个失败的阶段由 feedback-core.js 判断；它缺席或出错时退回 unknown，填写不受影响。
  function fillVerdict(input) {
    try {
      const verdict = self.ResumeProFeedback?.fillCategory?.(input);
      if (verdict) return verdict;
    } catch { /* fall through */ }
    return { category: "unknown", stage: input.failedStage || "none" };
  }

  // #497 报告用的字段类别（feedback-core 的表，和本地匹配的那张分开）。认不出或它缺席都是 unknown。
  function fieldKindOf(label) {
    try {
      return self.ResumeProFeedback?.fieldKind?.(label) || "unknown";
    } catch {
      return "unknown";
    }
  }

  // #497 控件是哪一种，加上自定义下拉操作时看到的样子（custom-controls.js 的 shape）。只有固定的词、是否和毫秒数。
  // opened：这次填写看到的弹层（popupObserved），点开的是日历就按日期控件算。
  function controlForm(entry, shape, opened = "") {
    const kind = entry?.controlKind;
    const el = entry?.kind === "radio" ? entry.elements?.[0] : entry?.element;
    const type = isInputElement(el) ? String(el.type || "").toLowerCase() : "";
    const mode = String(el?.getAttribute?.("inputmode") || "").toLowerCase();
    const form = entry?.kind === "radio" || kind === "radio" ? "radio"
      : kind === "native-select" || isSelectElement(el) ? "select"
        : kind === "cascader" ? "cascader"
          : opened === "calendar" || kind === "date" || entry?.pickerType || ["date", "month", "datetime-local", "week", "time"].includes(type) ? "date"
            : kind === "custom-select" ? (shape?.freeText ? "autocomplete" : "dropdown")
              : kind === "textarea" || el?.tagName === "TEXTAREA" ? "textarea"
                : kind === "checkbox" || type === "checkbox" ? "checkbox"
                  : type === "number" || ["numeric", "decimal"].includes(mode) ? "number"
                    : el ? "text" : "other";
    if (!shape) return { form };
    const wait = { openMs: shape.openMs, waitMs: shape.waitMs, spinner: shape.spinner };
    // 日历谈不上搜索、后台加载和多选，只带等待过程。
    return form === "date" ? { form, ...wait }
      : { form, search: shape.search, remote: shape.remote, multi: shape.multi, version: shape.version, ...wait };
  }

  // 字段所在分组的标题（扫描时找到的区块），私有诊断用。
  function fieldSection(entry, meta) {
    return String(entry?.binding?.section || meta?.group || "");
  }

  // 字段的元素，给私有诊断在页面大纲里找出错字段的位置。
  function fieldNodes(entry) {
    const nodes = entry?.kind === "radio" ? Array.from(entry.elements || []) : [entry?.element, ...(entry?.elements || [])];
    return [...new Set(nodes.filter(Boolean))];
  }

  // #497 私有诊断里的选项列表，规则和公开报告的「有没有选项」一样：级联只看第一列（自定义下拉的列表在
  // custom-controls.js 里就只记第一层、插件输入之前的），选完才冒出来的字段（#269）不收。省、市分成两个下拉时，
  // 市的列表是按资料里的省加载的，会透露省份，题目上又不一定看得出是哪一级（就叫「现居住地」）：地区类的题只收级联的
  // 第一列，别的地区下拉都不收。自定义下拉在这次填写里插件已经选过别的下拉或单选之后才点开的（shape.afterChoice）
  // 也不收：列表可能是按前面选的值加载的。原生下拉用扫描时（填写之前）的选项。
  // 地区类的题不只看类别：「城市」「省份」「区县」这类题目类别表认不出（unknown），题目里有地区的字也算。
  const REGION_KINDS = new Set(["籍贯户口", "现居住地", "地址", "国家地区"]);
  const REGION_WORDS = /省|市|区|县|镇|乡|街道|城市|地点|province|city|district|county|town/i;
  function privateOptions(entry, meta, label, kind, shape) {
    if ((meta?.cascadeLevel ?? 0) > 0 || String(meta?.fieldId || "").includes("field-new-")) return {};
    if ((REGION_KINDS.has(kind) || REGION_WORDS.test(String(label ?? ""))) && entry?.controlKind !== "cascader") return {};
    let list = null;
    let total = 0;
    if (entry?.kind === "radio" || entry?.controlKind === "native-select") {
      list = Array.isArray(meta?.options) ? meta.options : [];
      total = list.length;
    } else if (Array.isArray(shape?.options) && !shape.afterChoice) {
      list = shape.options;
      total = Number.isInteger(shape.optionTotal) ? shape.optionTotal : list.length;
    }
    if (!list?.length) return {};
    return { options: list.slice(0, 40).map(text => String(text ?? "")), optionTotal: total };
  }

  // #497 拼一次私有诊断就留着，页面上的元素随即放掉。出错就是没有。
  function privateText(holder) {
    if (!holder) return "";
    if (holder.text === null) {
      try {
        holder.text = buildPrivateReport(holder.input);
      } catch {
        holder.text = "";
      }
      holder.input = null;
    }
    return holder.text;
  }

  // 脱敏要藏起来的资料值（扫描出错时填写还没读资料，按当前模板和「我的信息」算）。
  function redactionValues(template, profile) {
    try {
      const fields = [...(template ? flattenTemplateFields(template) : []), ...(Array.isArray(profile) ? profile : [])];
      return fields.map(field => normalizeForOverlap(field?.value)).filter(value => value.length >= 2);
    } catch {
      return [];
    }
  }

  // #497 私有诊断：题目原文、分组标题、选项列表、出错字段附近的页面大纲、扫描出错的原文。都过深度分析发送前的那套脱敏
  // （page-outline.js：手机号、邮箱、证件号、网址、凭据和资料里有的文字换成「〔内容〕」，密码、验证码类的控件跳过）。
  // 选项不按资料值藏：藏起来的那一项就是要选的那一项，只挡手机号、证件号、网址这类。不收字段值，也不标出想选的是哪一项。
  function buildPrivateReport({ unfilled, missed, fault, values }) {
    const feedback = self.ResumeProFeedback;
    const outline = self.ResumeProPageOutline;
    if (!feedback?.privateReport || !outline?.createRedactor) return "";
    const redact = outline.createRedactor(values || []);
    const plain = outline.createRedactor([]);
    const field = item => ({ label: redact(item.label, 80), section: redact(item.section, 40), kind: item.kind, reasonCode: item.reasonCode,
      ...(typeof item.inResume === "boolean" ? { inResume: item.inResume } : {}),
      ...(item.options ? { options: item.options.map(text => plain(text, 20)).filter(Boolean), optionTotal: item.optionTotal } : {}) });
    const nodes = [...unfilled, ...missed].flatMap(item => item.nodes || []);
    let page = "";
    if (nodes.length && outline.excerpt) {
      try {
        page = outline.excerpt(document, nodes, { resumeValues: values || [], isVisible: isVisibleInOwnDocument,
          exclude: element => Boolean(element.closest?.(`#${SIDEBAR_ID}`)), fieldScan: self.ResumeProFieldScan });
      } catch {
        page = "";
      }
    }
    // fault 是 reportError 经 feedback-core exception() 得到的：message 已经只剩代码的英文报错（codeMessage），这里再按资料值脱敏。
    const exception = fault?.message ? { name: fault.name, message: redact(fault.message, 500) } : null;
    return feedback.privateReport({ unfilled: unfilled.map(field), missed: missed.map(field), outline: page, exception });
  }

  // fill-probe.js 只读页面结构，给诊断和空页面提示用；它缺席或出错都不能影响填写。
  function withFillProbe(use, fallback) {
    try {
      const api = self.ResumeProFillProbe;
      return api ? use(api) ?? fallback : fallback;
    } catch {
      return fallback;
    }
  }

  // #228 扫描诊断：只有数量，没有字段名、网页内容或网址。没跳过的扫描原因见「丢弃原因」。
  function formatScanStats(stats, feedback) {
    if (!stats) return [];
    const sourceLabels = { explicit: "明确关联", item: "表单项", table: "表格", sibling: "相邻文字", placeholder: "仅占位文字" };
    const sources = (() => {
      try { return feedback?.labelSources?.(stats) || []; } catch { return []; }
    })();
    const offer = stats.offerSkipped;
    const count = (value) => Number.isInteger(value) && value > 0 ? value : 0;
    return [
      // #400 一键填写进了同源框架：扫了几个框架、其中来的字段有几个。
      ...(count(stats.frames) ? [`同源框架：扫描 ${count(stats.frames)} 个，其中的字段 ${count(stats.frameFields)} 个`] : []),
      ...(sources.length ? [`字段名来源：${sources.map(([key, value]) => `${sourceLabels[key] || key} ${value}`).join("、")}`] : []),
      ...(offer ? [`「加到我的信息」没问：同名找不到区块 ${offer.ambiguous || 0}；经历类区块 ${offer.entry || 0}`] : [])
    ];
  }

  function formatFillDiagnostics(result) {
    // 阶段没跑：未执行；跑了但没拿到数字（例如请求发出去后通道断开）：未取得。
    const missing = result.requested ? "未取得" : "未执行";
    const seconds = (value) => typeof value === "number" && Number.isFinite(value) ? `${(value / 1000).toFixed(2)} s` : "未执行";
    const count = (value) => Number.isInteger(value) && value >= 0 ? value : missing;
    const d = result.diagnostics;
    // 选完后新出现的字段（#301）：匹配数加到首轮上；首轮没有错误码，或补填请求失败而首轮没失败时，显示补填的。
    const g = result.grown || {};
    const plus = (value, extra) => Number.isInteger(value) && Number.isInteger(extra) && extra > 0 ? value + extra : value;
    const feedback = self.ResumeProFeedback;
    // Explicit allowlist: never copy provider messages, URL, keys or field values.
    const allowedCodes = new Set(["none", "cancelled", "network", "format", "input_too_large", "no_context", "bad_response",
      "not_configured", "credential_unavailable", "auth", "rate_limited", "timeout", "http", "response_too_large",
      "secret_in_prompt", "not_installed", "not_paired", "never_paired", "incompatible", "unavailable",
      "secret_only", "no_resume_fields", "scan_exception"]);
    const errorCode = (() => {
      try { return feedback?.shownCode?.(d.errorCode, g.errorCode); } catch { return undefined; }
    })() ?? (d.errorCode === "none" && g.errorCode ? g.errorCode : d.errorCode);
    const code = allowedCodes.has(errorCode) || /^http_\d{3}$/.test(errorCode) ? errorCode : missing;
    // 提交校验后网页仍把插件填的框标成无效：不能再算「完成」。
    const unsynced = Number.isInteger(result.unsyncedCount) && result.unsyncedCount > 0 ? result.unsyncedCount : 0;
    const outcome = unsynced && result.outcome === "success" ? "partial" : result.outcome;
    const category = /^[a-z_]{1,32}$/.test(result.category || "") ? result.category : "unknown";
    const stage = ({ scan: "扫描", match: "匹配", fill: "填写", none: "无" })[result.stage] || "无";
    const called = (() => {
      try { return feedback?.aiCalled?.(result) ?? null; } catch { return null; }
    })();
    const drops = (() => {
      try { return feedback?.fillDrops?.(result) || []; } catch { return []; }
    })();
    const dropLabels = { type_hidden: "隐藏输入框", non_fillable: "按钮或文件框", disabled: "禁用", invisible: "不可见",
      popup_internal: "下拉内部输入", grouped: "并入同一控件", page_chrome: "页头导航", site_search: "站内搜索",
      outside_form: "表单外", no_label: "对不上题目", scan_error: "读取出错", out_of_scope: "不在新增范围", secret: "疑似密码", no_resume_mapping: "无对应资料",
      ai_unmatched: "AI 未匹配", open_question: "开放题没有现成回答", no_result: "没拿到 AI 结果", not_sent: "没送 AI", changed_while_waiting: "等 AI 时有改动",
      not_written: "没写上", unconfirmed: "未确认", unsynced: "未同步" };
    const pageType = result.pageType
      ? `${result.pageType.type === "application_form" ? "网申填写页" : "不像网申填写页"}（依据：${({
        url: "网址", title: "标题", edit_button: "「编辑」按钮", structure: "页面结构", none: "无" })[result.pageType.reason] || "无"}）`
      : "未取得";
    const stats = result.stats || {};
    // #408 扫描出错：错误类型和出错的那一行（只有本扩展的文件名和行列，exception() 已经筛过）。
    const fault = result.scanFault;
    return [
      `网申快填 v${chrome.runtime.getManifest().version}`,
      `结果：${({ success: "完成", partial: "部分完成", failed: "失败" })[outcome] || "未知"}；错误类别：${category}；失败阶段：${stage}`,
      ...(fault ? [`扫描出错：${fault.name}${fault.stack ? `（${fault.stack.split("\n")[0]}）` : ""}`] : []),
      `页面类型：${pageType}；扫描时已加载完：${result.readyAtScan === true ? "是" : result.readyAtScan === false ? "否" : "未取得"}`,
      `输入框：页面共 ${count(stats.domInputs)} → 可见可填 ${count(stats.visible)} → 进入匹配 ${count(result.fieldCount)}`
        + ` → 匹配 ${count(result.matched)} → 填入 ${count(result.filledCount)}`,
      ...(drops.length ? [`丢弃原因：${drops.map(([key, value]) => `${dropLabels[key] || key} ${value}`).join("、")}`] : []),
      ...formatScanStats(result.stats, feedback),
      `网页字段：${count(result.fieldCount)}；成功填写：${count(result.filledCount)}；没填上：${count(result.unfilledCount)}；未确认：${count(result.unconfirmedCount)}`,
      ...(unsynced ? [`页面表单状态未同步：${unsynced}（提交校验后网页仍标为无效，请手动点击这些字段确认）`] : []),
      `本地匹配：${count(plus(d.ruleMatches, g.local))}；AI 匹配：${count(plus(d.aiMatches, g.aiMatches))}`,
      `送 AI 字段：${count(plus(d.aiFields, g.aiFields))}；AI：${called === true ? "已调用" : called === false ? "未调用" : "未取得"}；错误码：${code}`,
      // #223：只有这次指定了档位才写，普通一键填写的诊断不变。
      ...(["strong", "default"].includes(d.tierRequested) ? [`模型档位：${d.tierUsed === "strong" ? "强"
        : d.tierUsed === "default" ? (d.tierRequested === "strong" ? "强模型未设置，已退回日常" : "日常") : "未取得"}`] : []),
      `候选 / 简历字段：${count(d.candidateFields)} / ${count(d.resumeFields)}`,
      `敏感字段过滤：${count(d.skippedSecret)}；超大资料跳过：${count(d.skippedOversized)}；无对应资料跳过：${count(d.skippedNoContext)}`,
      `用户 prompt：${count(d.promptBytes)} bytes`,
      `扫描：${seconds(result.scanMs)}`,
      `匹配往返（含后台处理）：${seconds(result.roundTripMs)}`,
      `API（含响应读取）：${called === true ? seconds(d.apiMs) : called === false ? "未调用" : "未取得"}`,
      `填写：${seconds(result.fillMs)}；总计：${seconds(result.totalMs)}`,
      // #402 AI 返回前先填上的项数；只在本机显示。
      ...(Number.isInteger(result.earlyFilled) && result.earlyFilled > 0 ? [`AI 返回前先填：${result.earlyFilled} 项`] : []),
      ...(result.deep ? formatDeepDiagnostics(result.deep) : []),
      ...(result.recipe ? [formatRecipeDiagnostics(result.recipe, d)] : []),
      // #429 第 4 项：这次一键填写前后的上传，只有计数和原因码。
      ...(result.upload ? [formatUploadDiagnostics(result.upload)] : []),
      ...withFillProbe(api => api.formatReport(result.probe || null, result.unfilledControls || []), [])
    ].join("\n");
  }

  // #226 本站配方的诊断：命中、过期、新保存、未保存或未使用，只有固定类别和计数，不含网址、字段名或配方内容。
  function formatRecipeDiagnostics(recipe, d = null) {
    const count = value => Number.isInteger(value) && value >= 0 ? value : 0;
    const reasons = { no_baseline: "没有可比较的普通填写", not_better: "没有比普通填写更好", nothing_filled: "没有确认填上的字段",
      unsafe: "网址或字段名可能含个人信息", unlocatable: "字段没有稳定特征", too_large: "超过大小上限", cancelled: "已停止或网页已变化",
      invalid: "校验没有通过", failed: "填写没有完成", action_missing: "要点的按钮找不到", action_changed: "要点的按钮对不上" };
    switch (recipe?.status) {
      case "hit":
        return `本站配方：命中（定位 ${count(recipe.located)}/${count(recipe.total)}`
          + (recipe.missing || recipe.ambiguous ? `，找不到 ${count(recipe.missing)}，有歧义 ${count(recipe.ambiguous)}` : "")
          + (recipe.extra ? `，新增条目 ${count(recipe.extra)}` : "")
          + `，规则扫描补充 ${count(recipe.supplemented)}；结构${recipe.sameStructure ? "一致" : "有变化"}）；没有做页面分析`
          + (d ? `；匹配简历调用模型 ${count(d.calls)} 次` : "");
      case "stale":
        return recipe.reason && reasons[recipe.reason]
          ? `本站配方：过期（${reasons[recipe.reason]}）`
          : `本站配方：过期（定位 ${count(recipe.located)}/${count(recipe.total)}，找不到 ${count(recipe.missing)}，有歧义 ${count(recipe.ambiguous)}），已退回普通扫描`;
      case "saved": {
        const labels = { education: "教育经历", work: "工作经历", projects: "项目经历", papers: "论文" };
        const missing = (Array.isArray(recipe.missingSections) ? recipe.missingSections : []).map(domain => labels[domain]).filter(Boolean);
        return `本站配方：新保存（${count(recipe.fields)} 个字段${missing.length ? `；未记住的新增分组：${missing.join("、")}` : ""}）`;
      }
      case "not_saved":
        return `本站配方：未保存（${reasons[recipe.reason] || "未满足保存条件"}）`;
      case "save_failed":
        return "本站配方：保存失败（浏览器存储不可用）";
      default:
        return "本站配方：未使用";
    }
  }

  // #224 深度分析的诊断：只有字数、份数、计数、固定的校验码和档位，不含模型原文、网页文字或网址。
  function formatDeepDiagnostics(report) {
    const count = value => Number.isInteger(value) && value >= 0 ? value : 0;
    // #226 配方模式没有页面分析，只记模型调用（匹配简历）和动作。
    if (report.mode === "recipe") {
      return [`按本站配方填写：没有做页面分析；模型调用 ${count(report.calls)} 次（只用于匹配简历）`,
        ...(report.actions ? formatDeepActions(report) : [])];
    }
    const tier = ({ strong: "强", default: "日常（未设置强模型）" })[report.tierUsed] || "未取得";
    const validation = /^(?:通过|analyze_invalid（[a-z_]{1,32}）)$/.test(report.validation || "") ? report.validation : "未执行";
    return [
      `深度分析：大纲 ${count(report.outlineChars)} 字，分 ${count(report.parts)} 次分析${report.truncated ? "（页面过长，后面的部分没有分析）" : ""}`,
      `页面说明书：字段 ${count(report.specFields)}，可填写 ${count(report.usedFields)}${report.overridden ? `，控件类型按网页改正 ${count(report.overridden)}` : ""}；校验：${validation}`,
      ...(report.controlKinds && Object.keys(report.controlKinds).length ? [`说明书控件类型：${Object.entries(report.controlKinds)
        .filter(([kind]) => self.ResumeProDeepAnalysis?.CONTROLS?.has(kind)).map(([kind, n]) => `${kind} ${count(n)}`).join("、")}`] : []),
      `深度分析模型调用：${count(report.calls)}/${count(report.limit)}${report.budgetExhausted ? "（已达上限）" : ""}；分析档位：${tier}`,
      ...(report.actions ? formatDeepActions(report) : [])
    ];
  }

  // #225 前置动作：只有固定的动作类别、计数、停止原因码和分析轮数。
  function formatDeepActions(report) {
    const count = value => Number.isInteger(value) && value >= 0 ? value : 0;
    const kinds = list => `编辑 ${count(list?.edit)}、展开 ${count(list?.expand)}、新增 ${count(list?.add)}`;
    const a = report.actions;
    const stop = /^[a-z_]{1,32}$/.test(a.stop || "") ? a.stop : "";
    return [
      `前置动作：计划 ${kinds(a.planned)}；已完成 ${kinds(a.done)}${stop ? `；停止原因：${stop}` : ""}`,
      `需手动点击：${count(a.manual)}；未自动新增的分组：${count(a.blocked)}${a.missingAdds ? `；配方里找不到「添加」的分组：${count(a.missingAdds)}` : ""}；分析轮数：${count(report.rounds)}`
    ];
  }

  // 深度分析在填写之前就结束了（校验没过、需要先点编辑、AI 失败）：诊断只写深度分析这几行。
  function writeDeepDiagnostics(report) {
    if (!report) return;
    lastFillReport = "";
    lastPrivate = null;
    const panel = shadowRoot?.querySelector("#resume-pro-diagnostics");
    const text = shadowRoot?.querySelector("#resume-pro-diagnostics-text");
    if (!panel || !text) return;
    const code = /^[a-z_]{1,32}$/.test(report.errorCode || "") ? report.errorCode : "";
    text.value = [
      `网申快填 v${chrome.runtime.getManifest().version}`,
      `${report.mode === "recipe" ? "按本站配方填写" : "深度分析"}没有进入填写${code ? `；错误码：${code}` : ""}`,
      ...formatDeepDiagnostics(report),
      ...(report.recipe ? [formatRecipeDiagnostics(report.recipe)] : [])
    ].join("\n");
    panel.hidden = false;
    panel.open = true;
  }

  // #400 同源框架里的元素属于框架自己的 window：对顶层的 HTMLInputElement 做 instanceof 是 false。
  // 先按当前 window 的构造函数判断，再按元素所在 window 的；document、样式、选区也都用元素所在的那一份。
  function viewOf(node) {
    return node?.ownerDocument?.defaultView || window;
  }

  function docOf(node) {
    return node?.ownerDocument || document;
  }

  function isElementOf(node, Local, name) {
    if (!node || typeof node !== "object") return false;
    if (typeof Local === "function" && node instanceof Local) return true;
    const Own = node.ownerDocument?.defaultView?.[name];
    return typeof Own === "function" && Own !== Local && node instanceof Own;
  }

  function isInputElement(node) {
    return isElementOf(node, HTMLInputElement, "HTMLInputElement");
  }

  function isTextAreaElement(node) {
    return isElementOf(node, HTMLTextAreaElement, "HTMLTextAreaElement");
  }

  function isSelectElement(node) {
    return isElementOf(node, HTMLSelectElement, "HTMLSelectElement");
  }

  function isHtmlElement(node) {
    return isElementOf(node, HTMLElement, "HTMLElement");
  }

  // 元素还在网页上：在它自己的文档里，框架的文档也还挂在页面上（框架被删掉后它的 window 就没了）。
  function inPage(node) {
    const doc = docOf(node);
    if (doc === document) return document.contains(node);
    return Boolean(doc.defaultView) && doc.contains(node);
  }

  // #400 一键填写可能要扫的文档：顶层，加上看得见、够大的同源框架（最多两层，见 field-scan.js 的 frameDocuments）。
  // 外层在前，parent 是装着这个框架的文档。框架读不了就只有顶层。侧栏只在顶层。
  function fillDocuments() {
    let frames = [];
    try {
      frames = self.ResumeProFieldScan?.frameDocuments?.(document, {
        isVisible,
        exclude: (element) => Boolean(element.closest?.(`#${SIDEBAR_ID}`))
      }) || [];
    } catch {
      frames = [];
    }
    return [{ doc: document, parent: null }, ...frames];
  }

  // #228：扫描交给 field-scan.js。只收能对上题目的逻辑控件：自定义下拉连同内部输入算一个，
  // 页头搜索、下拉弹层里的搜索框、对不上题目的控件都跳过，只在诊断里记数量。
  // #400 顶层扫不到字段时，接着扫它里面的同源框架；框架也一样，自己扫不到字段才进下一层。顶层表单旁边的客服、
  // 留言框架不碰。字段编号带框架序号（frame1-field-12）；框架正在跳转、扫描出错就跳过它。
  function scanFillableFields() {
    const options = {
      isVisible,
      exclude: (element) => Boolean(element.closest(`#${SIDEBAR_ID}`))
    };
    const fieldMap = new Map();
    const fields = [];
    const scans = [];
    // 扫过的文档各扫到几个字段。
    const yielded = new Map();
    fillDocuments().forEach(({ doc, parent }, index) => {
      if (parent && yielded.get(parent) !== 0) return;
      let scan;
      if (!index) {
        scan = self.ResumeProFieldScan.scanPage(doc, options);
      } else {
        try {
          scan = self.ResumeProFieldScan.scanPage(doc, options);
        } catch {
          return;
        }
        // 框架里的焦点和提交按钮：顶层 document 上的监听收不到，给它的 document 补上。
        watchFrameDocument(doc);
      }
      yielded.set(doc, scan.controls.length);
      scans.push({ doc, scan, before: fields.length });
      addScannedControls(scan, fields, fieldMap, index ? `frame${index}-` : "");
    });

    // 级联判断 (Cascade Detection)
    if (self.ResumeProAIHelpers?.detectCascadeGroups) {
      self.ResumeProAIHelpers.detectCascadeGroups(fields, fieldMap);
    }

    // fault：逐项跳过时第一个出错的原因（#408），只给一键填写上报用，不进诊断。unreadable：有文档的控件一个都没读出来。
    return { fields, fieldMap, stats: scanStats(scans, fields.length), fault: scans.find(({ scan }) => scan.fault)?.scan.fault || null,
      unreadable: scans.some(({ scan }) => scan.unreadable) };
  }

  function addScannedControls(scan, fields, fieldMap, prefix) {
    scan.controls.forEach((control) => {
      const element = control.element;
      // 扫描时的对应关系原样留着，填写和「加到我的信息」用之前拿它复查。
      const binding = control;
      const controlKind = control.controlKind === 'select' ? 'native-select'
        : control.controlKind === 'date-picker' ? 'date' : control.controlKind;
      const common = { controlKind, root: control.root, binding,
        offerable: control.offerable, offerLabel: control.offerLabel };
      const base = {
        controlKind,
        label: control.label,
        placeholder: control.placeholder,
        ariaLabel: element.getAttribute("aria-label") || "",
        group: control.group
      };

      if (control.kind === "radio") {
        const fieldId = `${prefix}field-radio-${fields.length}`;
        fieldMap.set(fieldId, { kind: "radio", elements: control.elements, ...common });
        fields.push({
          fieldId, ...base, placeholder: "", name: element.name || "", idAttr: "",
          tagName: "input", inputType: "radio",
          options: control.elements.map((radio) => getRadioOptionLabel(radio)).filter(Boolean)
        });
        return;
      }

      const fieldId = `${prefix}field-${fields.length}`;
      if (control.controlKind === "date-picker") {
        const pickerType = control.pickerType || "generic";
        const pickerInputType = inferPickerInputType(control.root, element);
        fieldMap.set(fieldId, { kind: "element", element, pickerType, pickerInputType, ...common });
        fields.push({
          fieldId, ...base, name: element.getAttribute("name") || "", idAttr: element.id || "",
          tagName: "input", inputType: "date-picker", pickerType, pickerInputType, options: []
        });
        return;
      }

      fieldMap.set(fieldId, { kind: "element", element, ...common });
      // #429 多选（原生 select multiple、antd 和 Element 的多选下拉）告诉 AI 可以给几项；Element Plus 没选东西时看不出，不写。
      let multiple = false;
      try {
        multiple = isSelectElement(element) ? element.multiple === true
          : control.controlKind === "custom-select" && Boolean(self.ResumeProCustomControls?.describe?.({ element, root: control.root })?.multiple);
      } catch {
        // 认不出就当单选：只是少告诉 AI 一句，照常填写。
      }
      fields.push({
        fieldId, ...base,
        ...(multiple ? { multiple: true } : {}),
        // #429 级联（省 → 市 → 区县这类逐级选的）：要的是从上到下的整条路径，本地匹配会把省、市、县拼起来，AI 提示词第 12 条。
        ...(control.controlKind === "cascader" ? { cascade: true } : {}),
        // #429 字数上限（框的 maxlength 或组件的字数统计）告诉 AI，回答不超过它；按字节算的站点写明，提示词第 13 条。
        ...(["text", "textarea"].includes(control.controlKind) ? lengthHint(element) : {}),
        dynamicOptions: ["custom-select", "cascader"].includes(control.controlKind),
        name: element.getAttribute("name") || "",
        idAttr: element.id || "",
        tagName: element.tagName.toLowerCase(),
        inputType: ["custom-select", "cascader"].includes(control.controlKind) ? "select"
          : isInputElement(element) ? element.type || "text" : element.tagName.toLowerCase(),
        options: isSelectElement(element)
          ? Array.from(element.options).map((option) => option.text.trim()).filter(Boolean)
          : []
      });
    });
  }

  // 诊断漏斗（#215 / #228）：页面上全部输入框按「为什么没进入匹配」分开数。只数数，不读值。
  // 隐藏、按钮或文件框、禁用、看不见按 DOM 数；看得见的再按 field-scan.js 的跳过原因分，
  // 剩下没单列的是并进同一个控件的输入框（一组单选、自定义下拉里的几个输入框算一个）。
  // #400 scans 是这次扫过的每个文档（顶层和同源框架）和它的扫描结果，各项按文档加起来；没有扫描结果时（深度填写）数顶层和看得见的同源框架。
  // frameFields：其中来自框架的字段数；frameUntitled：框架里看得见、却认不出题目的控件数（扫描的 noLabel，认成站内搜索、
  // 页头页脚的不算）。都只给侧栏诊断、零字段提示和深度分析入口用，不进上报。
  function scanStats(scans, fields) {
    const list = scans || fillDocuments().map(({ doc }) => ({ doc, scan: null, before: 0 }));
    const all = list.flatMap(({ doc }) => Array.from(doc.querySelectorAll("input, select, textarea")))
      .filter((element) => !element.closest?.(`#${SIDEBAR_ID}`));
    let typeHidden = 0;
    let nonFillable = 0;
    let disabled = 0;
    let visible = 0;
    for (const element of all) {
      const type = isInputElement(element) ? String(element.type || "").toLowerCase() : "";
      if (type === "hidden") typeHidden += 1;
      else if (["file", "button", "submit", "reset", "image"].includes(type)) nonFillable += 1;
      else if (element.disabled) disabled += 1;
      else if (isVisible(element)) visible += 1;
    }
    const count = (value) => Number.isInteger(value) && value > 0 ? value : 0;
    const sum = (read) => list.reduce((total, { scan }) => total + count(read(scan || {})), 0);
    const listed = { popup: sum((scan) => scan.skipped?.popup), pageChrome: sum((scan) => scan.skipped?.pageChrome),
      siteSearch: sum((scan) => scan.skipped?.siteSearch), outsideForm: sum((scan) => scan.skipped?.outsideForm),
      noLabel: sum((scan) => scan.skipped?.noLabel), scanError: sum((scan) => scan.skipped?.scanError) };
    const listedTotal = Object.values(listed).reduce((total, value) => total + value, 0);
    const sources = {};
    for (const { scan } of list) {
      for (const [key, value] of Object.entries(scan?.sources || {})) sources[key] = (sources[key] || 0) + count(value);
    }
    const frames = list.slice(1).filter(({ scan }) => scan);
    return { domInputs: all.length, visible, typeHidden, nonFillable, disabled,
      invisible: all.length - typeHidden - nonFillable - disabled - visible, ...listed,
      grouped: Math.max(0, visible - fields - listedTotal),
      sources, ambiguous: sum((scan) => scan.skipped?.ambiguous),
      frames: frames.length, frameFields: frames.length ? Math.max(0, fields - frames[0].before) : 0,
      frameUntitled: frames.reduce((total, { scan }) => total + count(scan.skipped?.noLabel), 0) };
  }

  // 题目和控件的对应关系还成立吗：控件还在原来的表单项里、表单项没混进别的控件、题目没变。
  // 选完会让页面长出新字段的控件：下拉、级联、单选、勾选、原生下拉。
  const CHOICE_CONTROL_KINDS = new Set(["custom-select", "cascader", "native-select", "select", "radio", "checkbox"]);

  function fieldBindingKey(binding) {
    return binding?.label ? [binding.controlKind, binding.section, binding.label, binding.repeatIndex, binding.repeatCount].join("\u0000") : "";
  }

  // #429 区间日期的另一头：同一个日期组件（root 相同）里另一个框的字段 id。
  function rangePartnerId(fieldMap, entry) {
    if (entry?.kind !== "element" || !entry.binding?.rangePart) return "";
    for (const [fieldId, other] of fieldMap) {
      if (other !== entry && other?.kind === "element" && other.root === entry.root
        && other.binding?.rangePart && other.binding.rangePart !== entry.binding.rangePart) return fieldId;
    }
    return "";
  }

  // 页面重画后找回的字段显示的是不是刚填的值（只读，不写）：下拉看组件显示的文字，单选看选中项，其余看框里的值。
  function showsFilledValue(entry, value) {
    const helpers = self.ResumeProAIHelpers;
    const matches = texts => texts.some(text => text && (helpers?.findSelectOptionIndex
      ? helpers.findSelectOptionIndex([{ value: text, text }], value) >= 0 : String(text).trim() === String(value).trim()));
    try {
      if (entry.kind === "radio") {
        const checked = entry.elements.find(radioChecked);
        return Boolean(checked) && matches([isInputElement(checked) ? getRadioOptionLabel(checked) : checked.textContent.trim()]);
      }
      const el = entry.element;
      if (["custom-select", "cascader"].includes(entry.controlKind)) {
        const texts = self.ResumeProCustomControls?.readSelection?.(entry)?.texts || [];
        // 日期框（北森日历按下拉认）：按页面显示的精度比，不按文字模糊匹配。
        if (/^\s*\d{4}\s*[-./年]\s*\d{1,2}/.test(String(value))) return texts.length === 1 && sameDateAsPage(texts[0], value);
        return matches(texts);
      }
      if (isSelectElement(el)) return matches([el.options[el.selectedIndex]?.text || ""]);
      const shown = String(el.value ?? "");
      if (entry.pickerType || entry.controlKind === "date") return sameDateAsPage(shown, value);
      return showsPreparedText(el, shown, value);
    } catch {
      return false;
    }
  }

  // 日期按页面要求的精度比：页面只显示到月（只能选到月的日历），年月对上就行；页面显示到日，资料有日就要对到日，
  // 资料只有年月按 1 日（和日历选 1 号一致）。
  function sameDateAsPage(shown, value) {
    const parse = text => {
      const hit = /(\d{4})\s*[-/.年]\s*(\d{1,2})(?:\s*[-/.月]\s*(\d{1,2}))?/.exec(String(text || ""));
      return hit ? { y: hit[1], m: hit[2].padStart(2, "0"), d: hit[3] ? hit[3].padStart(2, "0") : null } : null;
    };
    const page = parse(shown), want = parse(value);
    if (!page || !want || page.y !== want.y || page.m !== want.m) return false;
    return !page.d || page.d === (want.d || "01");
  }

  // 等页面对上一个选择的反应结束：增删节点或样式、显示/隐藏、class 连续 300ms 没有变化，最多等 1.5s。
  // 插件自己的侧栏和填写高亮不算。只看刚选的控件所在的文档（#400 同源框架里的控件看框架的），别的框架里的轮播、时钟不用等。
  function waitForPageSettle(doc = document, quietMs = 300, maxMs = 1500) {
    const Observer = typeof MutationObserver === "function" ? MutationObserver : null;
    const root = doc?.body || doc?.documentElement;
    if (!Observer || !root?.nodeType) return Promise.resolve();
    return new Promise((resolve) => {
      const start = performance.now();
      let last = start;
      const ours = (record) => record.target?.closest?.(`#${SIDEBAR_ID}`) || (record.attributeName === "class"
        && (record.target?.classList?.contains?.(FIELD_HIGHLIGHT_CLASS) || String(record.oldValue || "").includes(FIELD_HIGHLIGHT_CLASS)));
      const observer = new Observer((records) => {
        if (records.some((record) => !ours(record))) last = performance.now();
      });
      observer.observe(root, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ["style", "hidden", "class"] });
      const tick = () => {
        const now = performance.now();
        if (now - last >= quietMs || now - start >= maxMs) { observer.disconnect(); resolve(); } else window.setTimeout(tick, 50);
      };
      window.setTimeout(tick, 50);
    });
  }

  // #301 零字段时等表单出来：网页上新加了输入框、下拉、可编辑区域或框架，或者含有它们的节点改了样式、class、hidden
  // （藏着的表单显示出来），之后 300ms 没有再增删节点，就用 rescan 扫一次。扫到字段就结束；扫不到（先出来的是
  // 页头搜索框、客服框架这类）就接着等，最多等 2s，到上限时还有没扫过的变化就再扫一次。不轮询；插件自己的侧栏不算。
  // 网址变了（换页、跳到登录页）就不等了，也不扫。没有 MutationObserver 时立即返回。扫到字段时返回那次的扫描结果，否则 null。
  // #400 同源框架里的变化一起看，框架加载完（换了一份文档）也算网页有了变化。顶层和扫得到的框架里的 iframe 都听 load，
  // 等待开始后才插进来的、框架换页后新文档里的也一样。
  const NEW_CONTROL_SELECTOR = "input:not([type=hidden]), textarea, select, [contenteditable]:not([contenteditable=false]), [role=combobox], iframe";
  function waitForNewControls(href, rescan, settleMs = 300, maxMs = 2000) {
    const Observer = typeof MutationObserver === "function" ? MutationObserver : null;
    const root = document.documentElement;
    if (!Observer || !root?.nodeType) return Promise.resolve(null);
    return new Promise((resolve) => {
      let seen = false;
      let settle = null;
      let cap = null;
      const ours = (node) => Boolean(node?.closest?.(`#${SIDEBAR_ID}`));
      const isControl = (node) => node?.nodeType === 1 && !ours(node)
        && Boolean(node.matches?.(NEW_CONTROL_SELECTOR) || node.querySelector?.(NEW_CONTROL_SELECTOR));
      const fresh = (record) => record.type === "attributes" ? isControl(record.target) : Array.from(record.addedNodes || []).some(isControl);
      const changed = () => {
        seen = true;
        window.clearTimeout(settle);
        settle = window.setTimeout(() => {
          const scanned = scan();
          if (scanned) finish(scanned);
        }, settleMs);
      };
      const observer = new Observer((records) => {
        if (location.href !== href) {
          finish(null);
          return;
        }
        for (const record of records) {
          for (const node of record.addedNodes || []) if (node?.nodeType === 1 && !ours(node)) watchFrames(node);
        }
        // 看到控件后，网页还在增删节点就接着等它停下来；只改样式的动画不算。
        if (!records.some(fresh) && !(seen && records.some((record) => record.type !== "attributes" && !ours(record.target)))) return;
        changed();
      });
      const frames = new Set();
      const frameLoaded = () => {
        if (location.href !== href) return;
        // 新文档里的变化也要看到，它里面的框架也要听。
        followFrames();
        changed();
      };
      // node 自己或里面的 iframe 加载完时再扫。
      const watchFrames = (node) => {
        let found = [];
        try {
          found = [...(node.matches?.("iframe, frame") ? [node] : []), ...(node.querySelectorAll?.("iframe, frame") || [])];
        } catch {
          found = [];
        }
        for (const frame of found) {
          if (frames.has(frame) || typeof frame.addEventListener !== "function") continue;
          frame.addEventListener("load", frameLoaded);
          frames.add(frame);
        }
      };
      const observed = new Set();
      const observeRoot = (node) => {
        if (!node?.nodeType || observed.has(node)) return;
        observed.add(node);
        observer.observe(node, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "hidden", "class"] });
      };
      const followFrames = () => {
        for (const { doc } of fillDocuments().slice(1)) {
          observeRoot(doc.documentElement);
          watchFrames(doc);
        }
      };
      function scan() {
        seen = false;
        if (location.href !== href) return null;
        try {
          const scanned = rescan();
          return scanned?.fields?.length ? scanned : null;
        } catch {
          return null;
        }
      }
      function finish(scanned) {
        observer.disconnect();
        for (const frame of frames) frame.removeEventListener?.("load", frameLoaded);
        window.clearTimeout(settle);
        window.clearTimeout(cap);
        resolve(location.href === href ? scanned : null);
      }
      observeRoot(root);
      watchFrames(document);
      followFrames();
      cap = window.setTimeout(() => finish(seen ? scan() : null), maxMs);
    });
  }

  // 字段所在的文档：同源框架里的字段（#400）在框架自己的文档里找、复查。
  function entryDocument(entry) {
    const node = entry?.binding?.item || entry?.element || entry?.elements?.[0];
    return docOf(node);
  }

  // 同源框架换了页或被删掉（#400）：旧文档没有 window 了，里面的元素 isConnected 却还是 true。
  function documentGone(doc) {
    return Boolean(doc) && doc !== document && !doc.defaultView;
  }

  // #269 页面重画后找回同一个字段：同一控件类型、同一区块、同一题目、同名题目的序号和总数都一样，并且只找到一个。
  // 深度分析的字段按大纲定位，不在这里找。
  function rebindFieldEntry(entry) {
    const old = entry?.binding;
    if (!old?.label || entry.deepRef) return null;
    let scan, anchored = [];
    try {
      const doc = entryDocument(entry);
      scan = self.ResumeProFieldScan.scanPage(doc, { isVisible, exclude: (element) => Boolean(element.closest(`#${SIDEBAR_ID}`)) });
      if (old.anchorId && entry.kind !== "radio") {
        const escaped = doc.defaultView?.CSS?.escape?.(old.anchorId);
        anchored = Array.from(doc.querySelectorAll(escaped === undefined ? "[id]" : `#${escaped}`)).filter(node => node.id === old.anchorId);
      }
    } catch {
      return null;
    }
    const candidates = scan.controls.filter((control) => control.controlKind === old.controlKind && control.label === old.label
      && control.section === old.section);
    // A stable unique id can identify the original field even if another repeat was added.
    // Duplicate ids, changed questions/names and changed values must never be guessed through.
    const same = anchored.length
      ? (anchored.length === 1 ? candidates.filter(control => control.element === anchored[0] && control.anchorName === old.anchorName) : [])
      : candidates.filter(control => control.repeatIndex === old.repeatIndex && control.repeatCount === old.repeatCount);
    if (same.length !== 1) return null;
    const control = same[0];
    const fresh = { ...entry, binding: control, root: control.root };
    if (entry.kind === "radio") fresh.elements = control.elements;
    else fresh.element = control.element;
    if (entry.pickerType) fresh.pickerInputType = inferPickerInputType(control.root, control.element);
    return isFieldBindingCurrent(fresh) ? fresh : null;
  }

  function isFieldBindingCurrent(entry) {
    if (!entry?.binding) return true;
    try {
      return self.ResumeProFieldScan.isBindingCurrent(entry.binding, entryDocument(entry), { isVisible });
    } catch {
      return false;
    }
  }

  function getFieldLabel(element) {
    return self.ResumeProFieldScan?.labelForElement(element, {
      isVisible,
      exclude: (candidate) => Boolean(candidate.closest(`#${SIDEBAR_ID}`))
    }) || "";
  }

  // 目标、光标或内容变了，就让在线的侧栏重新问一次状态。消息里不带任何数据。
  function notifyPanelTargetChanged() {
    if (Date.now() - panelQueriedAt >= PANEL_ONLINE_MS || panelNotifyTimer) return;
    panelNotifyTimer = window.setTimeout(() => {
      panelNotifyTimer = null;
      try {
        Promise.resolve(chrome.runtime.sendMessage({ type: "RESUME_TARGET_CHANGED" })).catch(() => {});
      } catch {
        // The panel closed between the query and now.
      }
    }, 60);
  }

  function bindFocusTracking() {
    bindFocusListeners(document);
    // #400 焦点进了同源框架：顶层只收到 window 的 blur，activeElement 变成框架元素。
    window.addEventListener("blur", () => followFocusIntoFrame(document));
  }

  // 用户最后点过的字段。提交前同步会短暂聚焦已填字段，不能把它们当成用户最后点过的字段。
  function noteFocusedTarget(target) {
    if (submitSyncBusy || !isHtmlElement(target) || target.closest?.(`#${SIDEBAR_ID}`) || !isFillTarget(target)) return;
    state.lastFocusedField = target;
    closeChipActionMenu();
    rememberTextSelection(target);
    syncChipSelectionState();
    notifyPanelTargetChanged();
  }

  // #400 同源框架里的焦点和提交按钮：顶层 document 上的监听收不到框架里的事件，给框架的 document 补上同样的监听
  // （一键填写扫到它时，或焦点进了它时）。框架换了文档就是新的 document，到时再补。
  const watchedFrameDocs = new WeakSet();
  function watchFrameDocument(doc) {
    if (!doc || doc === document || watchedFrameDocs.has(doc) || typeof doc.addEventListener !== "function") return;
    watchedFrameDocs.add(doc);
    try {
      bindFocusListeners(doc);
      for (const type of ["pointerdown", "keydown", "click"]) doc.addEventListener(type, handleSubmitGesture, true);
      doc.defaultView?.addEventListener?.("blur", () => followFocusIntoFrame(doc));
    } catch {
      // 框架正在跳转：下次扫描或聚焦时再补。
    }
  }

  // 焦点从 doc 进了它里面的同源框架（最多两层）：补上监听，等框架里的元素拿到焦点后记下来。
  function followFocusIntoFrame(doc) {
    let current = doc;
    for (let depth = 0; depth < 2; depth += 1) {
      const frame = current.activeElement;
      if (!/^(?:IFRAME|FRAME)$/.test(frame?.tagName || "")) break;
      let inner = null;
      try {
        inner = frame.contentDocument;
      } catch {
        inner = null;
      }
      if (!inner) break;
      watchFrameDocument(inner);
      current = inner;
    }
    if (current === doc) return;
    window.setTimeout(() => {
      const active = frameActiveElement();
      if (docOf(active) !== document) noteFocusedTarget(active);
    }, 0);
  }

  // 拿着焦点的元素，进同源框架（最多两层），不进 Shadow DOM（和顶层的 document.activeElement 一样）。
  function frameActiveElement() {
    let active = document.activeElement;
    for (let depth = 0; depth < 2 && /^(?:IFRAME|FRAME)$/.test(active?.tagName || ""); depth += 1) {
      let inner = null;
      try {
        inner = active.contentDocument?.activeElement || null;
      } catch {
        inner = null;
      }
      if (!inner) break;
      active = inner;
    }
    return active || null;
  }

  function bindFocusListeners(doc) {
    const trackedTarget = (event) => {
      const candidate = isHtmlElement(event.target) && isFillTarget(event.target)
        ? event.target : doc.activeElement;
      return isHtmlElement(candidate) && isFillTarget(candidate) && !candidate.closest?.(`#${SIDEBAR_ID}`)
        ? candidate : null;
    };
    doc.addEventListener("focusin", (event) => noteFocusedTarget(event.target), true);
    // 失焦前最后记一次：点侧栏之后，contenteditable 的选区可能已经不在了。
    doc.addEventListener("focusout", (event) => {
      const target = trackedTarget(event);
      if (target) rememberTextSelection(target);
    }, true);
    const trackCaret = (event) => {
      const target = trackedTarget(event);
      if (!target) return;
      rememberTextSelection(target);
      if (target === state.lastFocusedField) notifyPanelTargetChanged();
    };
    doc.addEventListener("selectionchange", trackCaret, true);
    doc.addEventListener("keyup", trackCaret, true);
    doc.addEventListener("mouseup", trackCaret, true);
    doc.addEventListener("input", (event) => {
      // 用户手动改过、或页面自己改过：按值重新推断，不再沿用之前记的字段身份。
      // 我们自己写入时不清，写完由 applyChipValue 收尾。
      if (event.target && !chipWriteTargets.has(event.target)) {
        chipSelectionIdsByTarget.delete(event.target);
      }
      if (event.target === state.lastFocusedField) {
        closeChipActionMenu();
        rememberTextSelection(event.target);
        syncChipSelectionState();
        notifyPanelTargetChanged();
      }
    }, true);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      const helper = document.createElement("textarea");
      helper.value = text;
      helper.setAttribute("readonly", "readonly");
      helper.style.position = "fixed";
      helper.style.opacity = "0";
      document.body.appendChild(helper);
      helper.select();
      const success = document.execCommand("copy");
      helper.remove();
      return success;
    }
  }

  function getLastFocusedFillTarget() {
    const candidates = [state.lastFocusedField, frameActiveElement()];

    for (const candidate of candidates) {
      if (isHtmlElement(candidate) && isFillTarget(candidate) && inPage(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  function hasRealSelectOptions(select) {
    const isPlaceholder = self.ResumeProAIHelpers?.isPlaceholderOption;
    return Array.from(select.options || []).some((option) => String(option.text ?? "").trim()
      && !(isPlaceholder && isPlaceholder({ value: option.value, text: option.text, disabled: option.disabled })));
  }

  function isTextControl(element) {
    if (isTextAreaElement(element)) {
      return true;
    }
    if (!isInputElement(element)) {
      return false;
    }
    const type = String(element.type || "text").toLowerCase();
    return !["checkbox", "radio", "file", "button", "submit", "reset", "image", "hidden", "range", "color", "date", "month", "datetime-local", "time", "week"].includes(type);
  }

  function prefersSequentialInput(element) {
    if (!isInputElement(element)) {
      return false;
    }
    const type = String(element.type || "").toLowerCase();
    if (type === "tel" || type === "email" || type === "number") {
      return true;
    }
    const hint = `${element.name || ""} ${element.id || ""} ${element.getAttribute?.("autocomplete") || ""} ${element.getAttribute?.("inputmode") || ""}`.toLowerCase();
    return /tel|phone|mobile|email|e-mail|idcard|id-card|identity|shenfen|身份证/.test(hint);
  }

  function writeControlValue(element, value) {
    const descriptor = Object.getOwnPropertyDescriptor(element.constructor.prototype, "value");
    if (descriptor?.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
  }

  function dispatchTextInput(element, data) {
    const text = String(data ?? "");
    try {
      if (typeof InputEvent === "function") {
        element.dispatchEvent(new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: text
        }));
        return;
      }
    } catch (_) {
      // 旧环境构造 InputEvent 会抛，退回普通 Event。
    }
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function focusTransition(element, entering) {
    const types = entering ? ["focus", "focusin"] : ["blur", "focusout"];
    const seen = new Set();
    const listeners = types.map(type => [type, () => seen.add(type)]);
    const observe = typeof element.addEventListener === "function" && typeof element.removeEventListener === "function";
    if (observe) for (const [type, listener] of listeners) element.addEventListener(type, listener, true);
    let native = false;
    try {
      const method = entering ? "focus" : "blur";
      if (typeof element[method] === "function") {
        try {
          if (entering) element.focus({ preventScroll: true });
          else element.blur();
        } catch (_) {
          if (!entering) throw _;
          element.focus();
        }
        native = true;
      }
    } catch (_) {
      // Missing native methods and background pages still need the component lifecycle.
    } finally {
      if (observe) for (const [type, listener] of listeners) element.removeEventListener(type, listener, true);
    }
    // A sidebar can leave the page without OS focus: focus()/blur() may change activeElement
    // but emit no events. Complete only the missing events; never duplicate native ones.
    try {
      if (native && docOf(element).hasFocus?.() !== false) return;
      const Focus = viewOf(element).FocusEvent || (typeof FocusEvent === "function" ? FocusEvent : null);
      if (!Focus || element.isConnected === false) return;
      for (const type of types) {
        if (!seen.has(type)) element.dispatchEvent(new Focus(type, { bubbles: type.endsWith("in") || type.endsWith("out") }));
      }
    } catch (_) {
      // Unavailable document/view or event constructor: the normal commit check still decides success.
    }
  }

  function focusControl(element) {
    focusTransition(element, true);
  }

  function blurControl(element) {
    focusTransition(element, false);
  }

  function nextTask() {
    if (textCommitWaitMs <= 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => window.setTimeout(resolve, 0));
  }

  // 先让 focus 引起的页面更新结束，再写值并通知输入事件。
  // 如果先写值，受控表单可能在 focus 后按旧状态重绘，把值清空。
  async function runTextLifecycle(element, value, sequential, beforeWrite, didWrite) {
    focusControl(element);
    await nextTask();
    if (beforeWrite && !beforeWrite()) return false;
    if (!sequential) {
      writeControlValue(element, value);
      didWrite?.();
      dispatchTextInput(element, value);
    } else {
      writeControlValue(element, "");
      didWrite?.();
      dispatchTextInput(element, "");
      let built = "";
      for (const char of Array.from(value)) {
        built += char;
        writeControlValue(element, built);
        dispatchTextInput(element, char);
      }
    }
    element.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTask();
    if (beforeWrite && !beforeWrite()) return false;
    blurControl(element);
    return true;
  }

  // 用户不用改字，点一下输入框再点空白，提示就会消失。校验还在时照这个再做一次。
  async function replayFocusBlur(element) {
    focusControl(element);
    await nextTask();
    blurControl(element);
  }

  // ---- #173 提交前同步 ----
  // 有的网站要等用户第一次点「预览 / 下一步 / 提交」才开始整表校验，那时它内部还没接受插件填的文本，
  // 于是把已经显示着内容的框标红。用户点一下输入框再点空白就好，说明缺的只是一次 focus → blur。
  // 这里记住本次填写成功的文本框，在用户真正点按钮、网站自己的点击处理之前补上这一次。
  // 只做 focus → blur：不写值、不点按钮、不提交、不拦截事件。
  const SYNC_INPUT_TYPES = new Set(["text", "tel", "email"]);
  const CAPTCHA_HINT = /captcha|验证码|校验码|图形码|短信码|verif(?:y|ication)[-_ ]?code|one-time-code|(?:^|[^a-z0-9])otp(?:[^a-z0-9]|$)/i;
  const PASSWORD_HINT = /password|passwd|(?:^|[^a-z0-9])pwd(?:[^a-z0-9]|$)|密码/i;
  const SUBMIT_TEXT_PATTERN = /预览|下一步|下一页|提交|保存并(?:继续|下一步)|^(?:submit|next|continue|preview|save\s*(?:and|&)\s*(?:continue|next)|(?:review|preview)\s*(?:and|&)\s*submit)\b/i;
  const NON_SUBMIT_TEXT_PATTERN = /关闭|删除|取消|返回|上一步|上一页|清空|重置|移除|添加|新增|上传|^(?:close|delete|remove|cancel|back|previous|prev|reset|clear|add|upload)\b/i;

  function controlHintText(element) {
    const parts = [
      element.name,
      element.id,
      element.getAttribute?.("autocomplete"),
      element.getAttribute?.("placeholder"),
      element.getAttribute?.("aria-label")
    ];
    try {
      for (const label of Array.from(element.labels || [])) parts.push(label?.textContent);
    } catch (_) {
      // A custom control may expose a non-standard labels getter. Its other hints still apply.
    }
    const labelledBy = String(element.getAttribute?.("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    for (const id of labelledBy) parts.push(docOf(element).getElementById?.(id)?.textContent);
    return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  }

  // 只有 text / tel / email / textarea 会被记录；密码、验证码、下拉、日期、文件、单选、复选都不碰。
  function isSyncableTextControl(element) {
    const textarea = isTextAreaElement(element);
    const input = isInputElement(element);
    if (!textarea && !input) return false;
    if (input && !SYNC_INPUT_TYPES.has(String(element.type || "text").toLowerCase())) return false;
    const hint = controlHintText(element);
    return !CAPTCHA_HINT.test(hint) && !PASSWORD_HINT.test(hint);
  }

  function buttonLabelText(element) {
    const parts = [
      String(element.tagName || "").toUpperCase() === "INPUT" ? element.value : "",
      element.textContent,
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("title")
    ];
    const text = parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    // 一大段文字不是按钮文案。
    return text.length > 40 ? "" : text;
  }

  function isButtonLike(element) {
    const tag = String(element?.tagName || "").toUpperCase();
    if (tag === "BUTTON" || tag === "A") {
      return true;
    }
    if (tag === "INPUT") {
      return ["submit", "button", "image"].includes(String(element.getAttribute?.("type") ?? element.type ?? "").toLowerCase());
    }
    return element?.getAttribute?.("role") === "button";
  }

  function ownerForm(element) {
    if (element?.form) {
      return element.form;
    }
    let node = element?.parentElement;
    while (node) {
      if (String(node.tagName || "").toUpperCase() === "FORM") {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  function belongsToForm(element, form) {
    return element.form === form || (typeof form.contains === "function" && form.contains(element));
  }

  // 这个按钮是不是「预览 / 下一步 / 提交」一类会触发整表校验的按钮。
  function isSubmitTrigger(element) {
    if (!isButtonLike(element)) {
      return false;
    }
    if (element.disabled === true || element.getAttribute?.("aria-disabled") === "true") {
      return false;
    }
    const text = buttonLabelText(element);
    if (NON_SUBMIT_TEXT_PATTERN.test(text)) {
      return false;
    }
    const tag = String(element.tagName || "").toUpperCase();
    const type = String(element.getAttribute?.("type") ?? "").toLowerCase();
    if (tag === "INPUT" && (type === "submit" || type === "image")) {
      return true;
    }
    if (tag === "BUTTON") {
      if (type === "submit" || (!type && ownerForm(element))) {
        return true;
      }
    }
    return SUBMIT_TEXT_PATTERN.test(text);
  }

  // 从点击落点往上找最近的按钮：最近的按钮就是用户点的那个，它不是提交类就不处理，不再往外层找。
  function findSubmitTrigger(target) {
    let node = target;
    while (node) {
      if (isButtonLike(node)) {
        return isSubmitTrigger(node) ? node : null;
      }
      node = node.parentElement;
    }
    return null;
  }

  // composedPath crosses a shadow boundary while parentElement does not. The first button-like
  // node in the path is what the user actually activated; an ordinary inner button must not be
  // skipped in favour of a submit-looking outer host.
  function findSubmitTriggerInPath(path, target) {
    for (const node of path || []) {
      if (node?.id === SIDEBAR_ID) return null;
      if (isButtonLike(node)) return isSubmitTrigger(node) ? node : null;
    }
    return findSubmitTrigger(target);
  }

  // 真正拿着焦点的元素：进 Shadow DOM，也进同源框架（#400；框架里没有聚焦的元素时就是框架本身）。
  function deepActiveElement() {
    let active = document.activeElement;
    for (let depth = 0; active && depth < 16; depth += 1) {
      if (active.shadowRoot?.activeElement) {
        active = active.shadowRoot.activeElement;
        continue;
      }
      if (!/^(?:IFRAME|FRAME)$/.test(active.tagName || "")) break;
      let inner = null;
      try {
        inner = active.contentDocument?.activeElement || null;
      } catch {
        inner = null;
      }
      if (!inner || inner === inner.ownerDocument?.body) break;
      active = inner;
    }
    return active || null;
  }

  function isEditableElement(element) {
    if (!element) {
      return false;
    }
    if (isTextAreaElement(element) || isSelectElement(element)) {
      return true;
    }
    if (isInputElement(element)) {
      return !["button", "submit", "reset", "image", "checkbox", "radio", "file"].includes(String(element.type || "text").toLowerCase());
    }
    return element.isContentEditable === true;
  }

  function beginFillSession() {
    endFillSession();
    fillSession = { controls: new Map(), unsyncedControls: new Set(), checkTimer: null, unsynced: 0, summary: null };
    bindSubmitSync();
    return fillSession;
  }

  function endFillSession() {
    if (fillSession && fillSession.checkTimer !== null) {
      window.clearTimeout(fillSession.checkTimer);
    }
    fillSession = null;
    submitGesture = null;
  }

  function recordFilledTextControl(session, element) {
    if (!session || session !== fillSession || !isSyncableTextControl(element)) {
      return false;
    }
    session.controls.set(element, String(element.value ?? ""));
    return true;
  }

  // 还能安全同步的字段：已断开的丢掉；空的、禁用的、只读的跳过；给了表单就只取这张表单里的。
  function syncableControls(session, form) {
    const list = [];
    for (const element of Array.from(session.controls.keys())) {
      if (element.isConnected === false) {
        session.controls.delete(element);
        continue;
      }
      if (!isSyncableTextControl(element) || element.disabled || element.readOnly) {
        continue;
      }
      if (!String(element.value ?? "").trim()) {
        continue;
      }
      if (form && !belongsToForm(element, form)) {
        continue;
      }
      list.push(element);
    }
    return list;
  }

  // 全程同步、没有 await / 定时器：必须赶在网站自己的点击处理之前做完。
  function focusBlurNow(controls) {
    if (!controls.length || submitSyncBusy) {
      return;
    }
    const previous = deepActiveElement();
    submitSyncBusy = true;
    try {
      for (const control of controls) {
        focusControl(control);
        blurControl(control);
      }
    } finally {
      submitSyncBusy = false;
    }
    // 把焦点还给原来的元素：空格键靠按钮保持焦点才会在松开时触发点击。
    if (previous && previous !== docOf(previous).body && previous !== docOf(previous).documentElement
      && previous.isConnected !== false && deepActiveElement() !== previous) {
      focusControl(previous);
    }
  }

  // 全部填完、页面稳定后补一次。用户正在别的输入框里操作就不抢焦点，提交前同步还在。
  async function finalSyncFillSession(session) {
    try {
      if (!session || session !== fillSession || !session.controls.size) {
        return;
      }
      await waitForTextCommit();
      if (session !== fillSession || isEditableElement(deepActiveElement())) {
        return;
      }
      focusBlurNow(syncableControls(session, null));
    } catch (_) {
      // 最终同步只是加固，出错不能影响填写结果。
    }
  }

  function writeFillDiagnostics(input) {
    try {
      lastFillReport = self.ResumeProFeedback?.fillReport?.(input) || "";
    } catch {
      lastFillReport = "";
    }
    const panel = shadowRoot?.querySelector("#resume-pro-diagnostics");
    const text = shadowRoot?.querySelector("#resume-pro-diagnostics-text");
    if (panel && text) {
      text.value = formatFillDiagnostics(input);
      panel.hidden = false;
      panel.open = true;
    }
  }

  // 网站校验之后，看看插件填的、用户没改过的框是不是还被标成无效。
  // 未同步的字段记在会话的集合里，一次检查只更新它检查的那一部分：
  // 检查表单 B 不能抹掉表单 A 里仍未同步的记录。
  // 用户改过的字段、真正为空的字段，网站标红是真实错误，不算在内。
  function checkUnsyncedControls(session, form) {
    const flagged = session.unsyncedControls;
    const before = flagged.size;
    const release = (element) => {
      flagged.delete(element);
      if (textFillFailures.get(element) === "framework_state_unsynced") textFillFailures.delete(element);
    };
    const inScope = new Set(syncableControls(session, form));
    // 已移除的字段随时清掉；本范围内不再可检查（清空、禁用、只读）的也清掉；别的表单里的保留。
    for (const element of Array.from(flagged)) {
      if (!session.controls.has(element) || element.isConnected === false
        || (!inScope.has(element) && (!form || belongsToForm(element, form)))) {
        release(element);
      }
    }
    for (const element of inScope) {
      const current = String(element.value ?? "");
      // 用户改过的值，网站标红是真实错误。
      if (current !== session.controls.get(element)) {
        release(element);
        continue;
      }
      // Native type/required/pattern errors are real content errors, not a framework state
      // that another focus/blur can repair. Reading validity has no submission side effect.
      if (element.validity?.valid === false) {
        release(element);
        continue;
      }
      const result = inspectTextCommit(element, current, true);
      if (!result.ok && (result.reason === "validation_not_cleared" || result.reason === "framework_state_unsynced")) {
        flagged.add(element);
        textFillFailures.set(element, "framework_state_unsynced");
      } else {
        release(element);
      }
    }
    session.unsynced = flagged.size;
    if (flagged.size) {
      showStatus("页面仍认为部分内容无效，请检查内容或手动点击字段确认", "error", true);
    } else if (before > 0) {
      showStatus("页面表单状态已同步。", "success");
    }
    if (before !== flagged.size && session.summary) {
      writeFillDiagnostics({ ...session.summary, unsyncedCount: session.unsynced });
    }
  }

  // 一个会话只留一个检查定时器：连续点击只会顺延，不会越积越多。
  function scheduleUnsyncedCheck(session, form) {
    if (session.checkTimer !== null) {
      window.clearTimeout(session.checkTimer);
    }
    session.checkTimer = window.setTimeout(() => {
      session.checkTimer = null;
      if (session !== fillSession) {
        return;
      }
      try {
        checkUnsyncedControls(session, form);
      } catch (_) {
        // 检查失败不影响网页。
      }
    }, submitCheckDelayMs);
  }

  function syncBeforeSubmit(session, trigger) {
    const form = ownerForm(trigger);
    const controls = syncableControls(session, form);
    // 没有可同步的字段时，如果还有旧的未同步记录，也要检查一次，好把已清空 / 已禁用的字段清掉。
    if (!controls.length && !session.unsyncedControls.size) {
      return;
    }
    focusBlurNow(controls);
    scheduleUnsyncedCheck(session, form);
  }

  // 只接住捕获阶段用户真实的鼠标 / 键盘操作：不 preventDefault、不 stopPropagation、不替用户点。
  // pointerdown / keydown 在网站的 click 处理之前，是主要同步点；随后的 click 只认领已同步过的那次，
  // 没有前置手势的 click（例如回车触发的隐式提交）才自己同步一次。
  function handleSubmitGesture(event) {
    try {
      const session = fillSession;
      if (!session || !event || event.isTrusted !== true || submitSyncBusy) {
        return;
      }
      if (event.type === "pointerdown" && event.button !== 0) {
        return;
      }
      if (event.type === "keydown") {
        const activation = event.key === "Enter" || event.key === " " || event.key === "Spacebar";
        if (!activation || event.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey) {
          return;
        }
      }
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      const target = path[0] || event.target;
      if (!target || path.some((node) => node?.id === SIDEBAR_ID)) {
        return;
      }
      const trigger = findSubmitTriggerInPath(path, target);
      if (!trigger) {
        return;
      }
      const now = Date.now();
      if (event.type === "click") {
        const gesture = submitGesture;
        submitGesture = null;
        if (gesture && gesture.trigger === trigger && now - gesture.at < SUBMIT_GESTURE_DEDUPE_MS) {
          return;
        }
      } else {
        submitGesture = { trigger, at: now };
      }
      syncBeforeSubmit(session, trigger);
    } catch (_) {
      // 同步只是辅助，任何异常都不能挡住网站自己的点击。
    }
  }

  // 监听器只注册一次，之后每次新会话复用。
  function bindSubmitSync() {
    if (submitSyncBound) {
      return;
    }
    submitSyncBound = true;
    for (const type of ["pointerdown", "keydown", "click"]) {
      document.addEventListener(type, handleSubmitGesture, true);
    }
    if (typeof window.addEventListener === "function") {
      window.addEventListener("pagehide", endFillSession);
    }
  }

  function classText(node) {
    if (!node) {
      return "";
    }
    if (typeof node.className === "string") {
      return node.className;
    }
    if (node.classList && typeof node.classList.values === "function") {
      return Array.from(node.classList.values()).join(" ");
    }
    return "";
  }

  // #301 antd 换了类名前缀（飞书招聘 atsx-，见 antd-prefix.js）：换了前缀的类名再补一份 ant- 的写法，按 antd 的类名比对；
  // 选择器里的 .ant- 按节点所在文档的前缀展开。
  function antdClassText(node) {
    const antd = self.ResumeProAntdPrefix;
    const text = classText(node);
    if (!antd || !text) return text;
    const tokens = text.split(/\s+/);
    const renamed = tokens.map((token) => antd.token(node, token)).filter((token, index) => token !== tokens[index]);
    return renamed.length ? `${text} ${renamed.join(" ")}` : text;
  }

  function antdCss(node, selector) {
    return self.ResumeProAntdPrefix?.css(node, selector) ?? selector;
  }

  function isShown(node) {
    let current = node;
    const doc = docOf(node);
    const view = viewOf(node);
    while (current && current !== doc) {
      if (current.hidden) {
        return false;
      }
      const hidden = current.getAttribute?.("hidden");
      if (hidden != null && hidden !== "false") {
        return false;
      }
      if (current.getAttribute?.("aria-hidden") === "true") {
        return false;
      }
      if (typeof view.getComputedStyle === "function" && isHtmlElement(current)) {
        const style = view.getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") {
          return false;
        }
      }
      current = current.parentElement;
    }
    return true;
  }

  function looksLikeFieldError(node) {
    if (!node || node === docOf(node).body) {
      return false;
    }
    if (node.getAttribute?.("role") === "alert") {
      return true;
    }
    const className = classText(node);
    return /(?:^|[\s_])(?:error|has-error|is-error|is-invalid|invalid-feedback|field-error|form-error)(?:$|[\s_])/i.test(className)
      || /el-form-item__error|ant-form-item-explain-error|ant-form-item-has-error|Validform_wrong/.test(antdClassText(node));
  }

  function listOtherControls(root, skip) {
    const found = [];
    const stack = [...(root?.children || [])];
    while (stack.length) {
      const node = stack.shift();
      if (node !== skip && (isInputElement(node) || isTextAreaElement(node) || isSelectElement(node))) {
        found.push(node);
      }
      if (node?.children?.length) {
        stack.push(...node.children);
      }
    }
    return found;
  }

  // 表单项里只装控件的内容区（北森 .form-item__content、.form-item__control）不是整道题：
  // 错误提示可能放在内容区外面，要接着往上找到表单项本身。
  const FORM_ITEM_PART = /(?:form-item|form-group|form-field)__(?:content|control)$/i;

  function formItemTokens(element) {
    return classText(element).split(/\s+/).filter((token) => /form-item|form-group|form-field/i.test(token));
  }

  function associatedContainer(element) {
    const doc = docOf(element);
    let current = element.parentElement;
    let best = current;
    while (current && current !== doc.body && current !== doc.documentElement) {
      if (listOtherControls(current, element).length > 0) {
        return best;
      }
      best = current;
      if (/form-item|form-group|form-field|el-form-item|ant-form-item/i.test(classText(current))) {
        const items = formItemTokens(current);
        if (!items.every((token) => FORM_ITEM_PART.test(token))) {
          return current;
        }
        // 内容区（form-item__content 之类）外面那一层就是它的表单项，有的网站把错误提示放在那里。
        // 只往上看这一层，而且要真是表单项、里面没有别的框，免得把相邻题目的提示算进来。
        const parent = current.parentElement;
        const parentItems = parent ? formItemTokens(parent) : [];
        if (parentItems.length && !parentItems.every((token) => FORM_ITEM_PART.test(token))
          && listOtherControls(parent, element).length === 0) {
          return parent;
        }
        return current;
      }
      current = current.parentElement;
    }
    // 没有其他控件作边界时，不要把整张表单的错误算到唯一输入框上。
    return element.parentElement;
  }

  function describedErrorVisible(element) {
    const ids = `${element.getAttribute?.("aria-describedby") || ""} ${element.getAttribute?.("aria-errormessage") || ""}`
      .split(/\s+/)
      .filter(Boolean);
    return ids.some((id) => {
      const node = docOf(element).getElementById?.(id);
      return node && node !== element && isShown(node) && String(node.textContent || "").trim()
        && (looksLikeFieldError(node) || node.getAttribute?.("role") === "alert");
    });
  }

  function containerErrorVisible(element) {
    const container = associatedContainer(element);
    if (!container) {
      return false;
    }
    const stack = [...(container.children || [])];
    while (stack.length) {
      const node = stack.shift();
      if (node === element) {
        continue;
      }
      if (looksLikeFieldError(node) && isShown(node) && String(node.textContent || "").trim()) {
        return true;
      }
      if (node?.children?.length) {
        stack.push(...node.children);
      }
    }
    return false;
  }

  function containerFrameworkUnsynced(element) {
    const container = associatedContainer(element);
    return /ant-form-item-has-error|(?:^|\s)has-error(?:\s|$)|is-error|is-invalid|Validform_wrong/.test(antdClassText(container));
  }

  // #229 手机号框会自己改格式（138 0013 8000、138-0013-8000、+86 开头）：去掉空格、短横和开头的 +86 / 86 后数字相同，
  // 就是写上了，不能当成没写上，也不能恢复成写之前的值。
  const PHONE_HINT = /手机|电话|联系方式|mobile|phone|(?:^|[^a-z])tel(?:[^a-z]|$)/i;

  function phoneDigits(text) {
    const digits = String(text ?? "").replace(/[\s-]/g, "").replace(/^\+86/, "").replace(/^86(?=1\d{10}$)/, "");
    return /^\d+$/.test(digits) ? digits : "";
  }

  function isPhoneInput(element) {
    if (!isInputElement(element)) {
      return false;
    }
    if (String(element.type || "").toLowerCase() === "tel") {
      return true;
    }
    return PHONE_HINT.test(`${controlHintText(element)} ${getFieldLabel(element)}`);
  }

  function sameTextValue(element, current, expected) {
    if (current === expected) {
      return true;
    }
    const digits = phoneDigits(current);
    if (digits && digits === phoneDigits(expected) && isPhoneInput(element)) {
      return true;
    }
    return sameDateText(current, expected) && isDateLikeText(element);
  }

  // #399 日期样式的文本框（简道云的「出生年月」不是认得出的日期组件，按文本框填）：组件失焦后常按自己的格式改写，
  // 1998-06 变成 1998-06-01、1998/06。按年月日比是同一天就是写上了。只认整段就是一个日期的写法。
  const DATE_TEXT_HINT = /出生|生日|日期|年月|时间|date|birth|time/i;

  function parseDateText(text) {
    const s = String(text ?? "").normalize("NFKC").trim();
    const dashed = /^(\d{4})([-/.])(\d{1,2})(?:\2(\d{1,2}))?$/.exec(s);
    const written = /^(\d{4})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*[日号]?)?$/.exec(s);
    const year = /^(\d{4})\s*年?$/.exec(s);
    const [y, m, d] = dashed ? [dashed[1], dashed[3], dashed[4]] : written ? written.slice(1, 4) : year ? [year[1]] : [];
    if (!y || +y < 1900 || +y > 2100 || (m && (+m < 1 || +m > 12)) || (d && (+d < 1 || +d > 31))) {
      return null;
    }
    return { y, m: m ? m.padStart(2, "0") : null, d: d ? d.padStart(2, "0") : null };
  }

  // 按页面显示的精度比：只到月就比年月；到日时，资料只有年月按 1 日（和日历选 1 号一致）。只有年的不比。
  function sameDateText(shown, wanted) {
    const page = parseDateText(shown);
    const want = parseDateText(wanted);
    if (!page?.m || !want?.m || page.y !== want.y || page.m !== want.m) {
      return false;
    }
    return !page.d || page.d === (want.d || "01");
  }

  function isDateLikeText(element) {
    if (!isInputElement(element) || !isTextControl(element)) {
      return false;
    }
    return Boolean(datePlaceholderFormat(element)) || DATE_TEXT_HINT.test(`${controlHintText(element)} ${getFieldLabel(element)}`);
  }

  // 占位提示写明的日期格式：YYYY-MM-DD、yyyy/mm、YYYY年MM月、YYYYMMDD 这类，或只给了一个示例日期（例：2020.09）。
  // 带时分的、写了两个日期的（起止）不算。
  function datePlaceholderFormat(element) {
    const hint = String(element?.getAttribute?.("placeholder") || "").normalize("NFKC");
    // 月、日写在年前面的（MM/DD/YYYY）也不认。
    if (!hint || /h{1,2}\s*:\s*m{1,2}|\d{1,2}:\d{2}/i.test(hint) || (hint.match(/y{4}/gi) || []).length > 1
      || /(?<![a-z])[md]{1,2}\s*[-/.]\s*(?:[md]{1,2}\s*[-/.]\s*)?y{4}/i.test(hint)) {
      return null;
    }
    const pattern = /(?<![a-z])y{4}(?:([-/.])(m{1,2})(?:\1(d{1,2}))?|年(m{1,2})月(?:(d{1,2})日)?|(mm)(dd)?)?(?![a-z])/i.exec(hint);
    if (pattern) {
      const month = pattern[2] || pattern[4] || pattern[6];
      const day = pattern[3] || pattern[5] || pattern[7];
      return { sep: pattern[4] ? "年" : pattern[1] || "", precision: day ? "day" : month ? "month" : "year", pad: !month || month.length === 2 };
    }
    // 只给了示例的，框本身得是填日期的（题目、name 或占位提示里有日期、时间这类词），示例也得是一个真日期：
    // 「期望月薪」的「如：2000.50」是金额。
    const examples = hint.match(/(?<!\d)(?:19|20)\d{2}(?:([-/.])\d{1,2}(?:\1\d{1,2})?|年\d{1,2}月(?:\d{1,2}日)?)(?!\d)/g) || [];
    if (examples.length !== 1 || !parseDateText(examples[0]) || !DATE_TEXT_HINT.test(`${controlHintText(element)} ${getFieldLabel(element)}`)) {
      return null;
    }
    const example = /^\d{4}(?:([-/.])(\d{1,2})(?:\1(\d{1,2}))?|年(\d{1,2})月(?:(\d{1,2})日)?)$/.exec(examples[0]);
    const month = example[2] || example[4];
    return { sep: example[4] ? "年" : example[1], precision: example[3] || example[5] ? "day" : "month", pad: month.length === 2 };
  }

  // 按占位提示的格式重写资料里的日期。资料只有年月、框要到日时按 1 日（dayDefaulted，状态栏会说明）；认不出的不改。
  function formatDateText(text, format) {
    const date = parseDateText(text);
    if (!date || (format.precision !== "year" && !date.m)) {
      return null;
    }
    if (format.precision === "year") {
      return { value: date.y };
    }
    const part = (value) => format.pad ? value : String(Number(value));
    const parts = [date.y, part(date.m)];
    if (format.precision === "day") {
      parts.push(part(date.d || "01"));
    }
    const value = format.sep === "年" ? `${parts[0]}年${parts[1]}月${parts[2] ? `${parts[2]}日` : ""}` : parts.join(format.sep);
    return format.precision === "day" && !date.d ? { value, dayDefaulted: true } : { value };
  }

  // #405 数字框（type=number，或 inputmode 是 numeric / decimal）：type=number 会直接清掉不是数字的字，受控组件也常把它们滤掉，
  // 写进去只会被拒或剩下拼起来的数字。资料带单位的，只在能放心取出时写数字：一个数加一个常见单位（175cm、65 公斤、8000 元/月、3 年），
  // 而且题目或占位提示没写明别的单位（身高（m）、月薪（千元）、月薪（美元））、别的周期（期望月薪配 8000 元/年）。
  // 范围、带 k / 万、几个数的都不写，报 format_mismatch 让用户手填。
  const NUMBER_UNITS = [["cm", "厘米", "公分"], ["kg", "公斤", "千克"], ["元", "rmb", "人民币"], ["岁", "周岁"], ["年"],
    ["个月", "月"], ["周", "星期"], ["天"], ["小时"], ["分"]];
  // 题目里写明这些单位时，资料里的单位对不上就不取：取出的数字意思变了。
  const STATED_UNITS = new Set([...NUMBER_UNITS.flat(), "m", "米", "mm", "毫米", "斤", "g", "克", "千", "千元", "k", "万", "万元", "w", "%"]);
  // 规则表外、一看就是单位的写法：别的币种（美元、港币、万美元、$）和英制、公里这类。题目写明了这些，资料里的单位总对不上。
  const OTHER_UNIT = /^(?:[\u4e00-\u9fa5]{0,3}[元币]|美金|英镑|[$€£]|us\$|usd|hkd|eur|gbp|jpy|sgd|英寸|英尺|英里|公里|千米|分米|磅|inch|in|ft|lbs?|km)$/;
  const unitHintText = (element) => `${element.getAttribute?.("placeholder") || ""} ${element.getAttribute?.("aria-label") || ""} ${getFieldLabel(element)}`
    .normalize("NFKC").toLowerCase();

  function numericInputKind(element) {
    if (String(element.type || "").toLowerCase() === "number") {
      return "number";
    }
    return ["numeric", "decimal"].includes(String(element.getAttribute?.("inputmode") || "").trim().toLowerCase()) ? "mode" : "";
  }

  // 题目、占位提示里括号中或「单位：」后面写明的单位，规则表外的（美元）也记下。括号里还带别的话的（m，必填）按逗号、顿号分段看。
  function statedUnits(element) {
    const units = [];
    for (const hit of unitHintText(element).matchAll(/\(\s*([^()]{1,20}?)\s*\)|单位\s*:?\s*(?:为|是)?\s*([^\s,，。;；()]{1,6})/g)) {
      for (const part of (hit[1] || hit[2]).split(/\s*[,、;]\s*/)) {
        const unit = part.replace(/^单位\s*:?\s*(?:为|是)?\s*/, "").replace(/\s*(?:\/|每)\s*(?:月|年)$/, "");
        if (STATED_UNITS.has(unit) || OTHER_UNIT.test(unit)) units.push(unit);
      }
    }
    return units;
  }

  // 题目、占位提示写明的周期：按月（月薪、元/月、每月）还是按年（年薪、元/年）。都没写的是空的。
  function statedPeriods(element) {
    const text = unitHintText(element);
    return [["月", /月薪|月收入|月工资|(?:\/|每)\s*月|monthly|per month/], ["年", /年薪|年收入|年工资|年包|(?:\/|每)\s*年|annual|yearly|per year/]]
      .filter(([, pattern]) => pattern.test(text)).map(([period]) => period);
  }

  // 能放心写进数字框的数字；取不出返回 null。
  function numericText(element, text) {
    const raw = String(text ?? "").normalize("NFKC").trim();
    if (!raw || /^-?\d+(?:\.\d+)?$/.test(raw)) {
      return raw;
    }
    if (isPhoneInput(element) && phoneDigits(raw)) {
      return phoneDigits(raw);
    }
    const hit = /^(¥\s*)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*([^\d\s.,][^\d]*)?$/.exec(raw);
    if (!hit) {
      return null;
    }
    const number = `${hit[2].replace(/,/g, "")}${hit[3] || ""}`;
    const suffix = String(hit[4] || "").trim().toLowerCase();
    // 资料写了按月还是按年（8000 元/年），题目写明的周期对不上：8000 写进月薪的框意思就错了。
    const period = /(?:\/|每)\s*(月|年)$/.exec(suffix)?.[1];
    const periods = period ? statedPeriods(element) : [];
    if (periods.length && !periods.includes(period)) {
      return null;
    }
    const unit = suffix.replace(/\s*(?:\/|每)\s*(?:月|年)$/, "") || (hit[1] ? "元" : "");
    if (!unit) {
      return number;
    }
    const group = NUMBER_UNITS.find((words) => words.includes(unit));
    if (!group || (hit[1] && unit !== "元")) {
      return null;
    }
    return statedUnits(element).every((stated) => group.includes(stated)) ? number : null;
  }

  // #429 文本框的字数上限：框的 maxlength 或组件自己的字数统计（见 site-knowledge.js）；字数按字节算的站点按字节量。
  function textLimit(element) {
    const knowledge = self.ResumeProSiteKnowledge;
    const max = knowledge?.limitOf(element);
    if (!Number.isInteger(max)) return null;
    // 看框所在文档的网址（同源框架里的表单看框架自己的）；about:blank 这类框架往外层框架找，都没有看整页的。
    return { max, bytes: knowledge.countsBytes(knowledge.addressOf(element.ownerDocument, location.href)) };
  }
  function lengthHint(element) {
    const limit = textLimit(element);
    return limit ? { maxLength: limit.max, ...(limit.bytes ? { lengthUnit: "byte" } : {}) } : {};
  }
  function limitText(limit) {
    return limit.bytes ? `超过 ${limit.max} 字节上限，汉字算 2` : `超过 ${limit.max} 字上限`;
  }
  // #399 #405 一键填写写之前按框的要求整理要写的字（控件层写之前调用；侧栏、字段卡片手动写入不整理）。
  // 返回 { value }，日期按 1 日补齐的带 dayDefaulted。type=number 里取不出数字的返回 { reason: "format_mismatch" }，不写。
  // inputmode 只是给手机键盘的提示，很多框什么都收：先照原样写，numeric 是页面没收下时改写的数字（取不出是 null）。
  // #429 整理完再看字数上限：超了不写，返回 { reason: "too_long" }，没填上的原因写明超过几字上限。
  // 不截断：截断会把学校、专业这类名称截成别的，长回答断在半句，由用户自己改短。
  function prepareTextValue(element, value) {
    const prepared = formatTextValue(element, value);
    if (prepared.reason) return prepared;
    const limit = textLimit(element);
    const written = normalizeExpectedTextValue(element, prepared.value);
    if (!limit || self.ResumeProSiteKnowledge.measure(written, limit.bytes) <= limit.max) return prepared;
    textLimits.set(element, limit);
    return { reason: "too_long" };
  }

  function formatTextValue(element, value) {
    const text = String(value ?? "");
    if (!isInputElement(element)) {
      return { value: text };
    }
    const format = datePlaceholderFormat(element);
    const prepared = (format && formatDateText(text, format)) || { value: text };
    const numeric = numericInputKind(element);
    if (!numeric) {
      return prepared;
    }
    const number = numericText(element, prepared.value);
    if (numeric === "number") {
      return number === null ? { reason: "format_mismatch" } : { ...prepared, value: number };
    }
    return number === prepared.value.normalize("NFKC").trim() ? prepared : { ...prepared, numeric: number };
  }

  // 框里显示的是不是一键填写写进去的字：按 prepareTextValue 整理过的，或 inputmode 数字框改写过的数字。
  function showsPreparedText(element, shown, value) {
    const prepared = prepareTextValue(element, value);
    const typed = prepared.reason ? String(value ?? "") : prepared.value;
    return sameTextValue(element, shown, normalizeExpectedTextValue(element, typed))
      || (typeof prepared.numeric === "string" && sameTextValue(element, shown, prepared.numeric));
  }

  function inspectTextCommit(element, expected, committedBeforeWait) {
    if (element.isConnected === false) {
      return { ok: false, reason: "element_disconnected" };
    }
    const current = String(element.value ?? "");
    if (!sameTextValue(element, current, expected)) {
      return { ok: false, reason: committedBeforeWait ? "value_reverted" : "value_not_committed" };
    }
    if (element.getAttribute?.("aria-invalid") === "true" || describedErrorVisible(element) || containerErrorVisible(element)) {
      return { ok: false, reason: "validation_not_cleared" };
    }
    if (containerFrameworkUnsynced(element)) {
      return { ok: false, reason: "framework_state_unsynced" };
    }
    return { ok: true, reason: "" };
  }

  function waitForTextCommit() {
    if (textCommitWaitMs <= 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => window.setTimeout(resolve, textCommitWaitMs));
  }

  function textFillFailureCode(element) {
    const control = element?.kind === "element" ? element.element : element;
    return (control && textFillFailures.get(control)) || "";
  }

  function textFillFailureLabel(element) {
    const control = element?.kind === "element" ? element.element : element;
    const code = textFillFailureCode(element);
    if (code === "too_long" && textLimits.has(control)) return limitText(textLimits.get(control));
    return TEXT_FILL_FAILURE_LABELS[code] || "";
  }

  function normalizeExpectedTextValue(element, value) {
    const text = String(value ?? "");
    if (isTextAreaElement(element)) {
      return text.replace(/\r\n?/g, "\n");
    }
    if (!isInputElement(element)) {
      return text;
    }
    const type = String(element.type || "text").toLowerCase();
    if (type === "email" || type === "url") {
      return text.replace(/[\r\n]/g, "").replace(/^[\t\f ]+|[\t\f ]+$/g, "");
    }
    if (["text", "search", "tel", "password"].includes(type)) {
      return text.replace(/[\r\n]/g, "");
    }
    // 数字等类型的无效值会被浏览器拒绝，不能把清空后的值当成成功。
    return text;
  }

  let controlOperator;
  function operateControl(target, value, options = {}) {
    if (!controlOperator) controlOperator = self.ResumeProControls.create({
      helpers: self.ResumeProAIHelpers, radioLabel: getRadioOptionLabel,
      isVisible, writeValue: writeControlValue, focus: focusControl, blur: blurControl,
      normalizeText: normalizeExpectedTextValue, prepareText: prepareTextValue, runTextLifecycle, sameTextValue,
      inspectText: inspectTextCommit, waitTextCommit: waitForTextCommit,
      replayFocusBlur, prefersSequential: prefersSequentialInput, dispatchTextInput,
      getSettleMs: () => textCommitWaitMs <= 0 ? 0 : 250
    });
    // #230's scanner uses date-picker; the #219 operation contract uses date.
    const entry = target?.controlKind === 'date-picker' ? { ...target, controlKind: 'date' } : target;
    return controlOperator.operate(entry, value, options);
  }

  // #269 资料只有年月、日历要选到日时按 1 日填写：记下来，结果里写明。
  const dayDefaultedControls = new WeakSet();
  // #301 下拉、级联和日历最近一次操作时弹层的样子：没弹出，或弹出的是哪类、里面有没有选项（只有固定类别和是否）。
  // 记下是哪一次填写会话操作的，没填上的字段只带本次填写里的记录。
  const controlPopups = new WeakMap();
  // #497 自定义下拉最近一次操作的样子：能不能搜索、是不是后台加载、单选多选、组件库大版本、等了多久、结束时还在不在加载；
  // 第一层的选项文字（插件输入之前的）只给私有诊断用。
  const controlShapes = new WeakMap();
  // 这次填写会话里选上的下拉、级联和单选，以及写上的可能带出别的列表的文本框有几个（见 setElementValue）。
  let choiceWrites = { session: null, count: 0 };
  const DRIVER_KINDS = new Set(["学校", "专业", "学历", "学位", "公司", "职位", "籍贯户口", "现居住地", "地址", "国家地区"]);
  // 没弹出（opened=none）只在插件点开过、弹层却没出来时才记（没有发现选项、级联等待超时）；
  // 被禁用、不支持这类还没去点开就停下的，不说弹层的事。
  function popupObserved(observed, reason) {
    const role = ["listbox", "tree", "menu", "component", "calendar"].includes(observed?.popupRole) ? observed.popupRole : "";
    if (role === "calendar") return { opened: "calendar" };
    // 有没有选项只在网页自己先给出的第一层列表读到时才有（custom-controls.js）；没有就不报，不当成没有选项。
    if (role) return { opened: role, ...(typeof observed.hasOptions === "boolean" ? { hasOptions: observed.hasOptions } : {}) };
    return ["custom-select", "cascader"].includes(observed?.controlKind) && ["options_not_rendered", "cascade_timeout"].includes(reason)
      ? { opened: "none" } : null;
  }

  // #399 #405 写入被拒（值没有写上、被页面退回，#417 只读的选择框写不上）的文本框，诊断里多带两样：框里剩下的是什么（控件层给的 empty / previous / other），
  // 和填它的 1 秒内页面有没有冒出建议框或别的弹层（日历、提示框、对话框）。弹层只看 role 和 class 里的词、是否可见，不读里面的字。
  const TEXT_REJECTED = new Set(["value_not_committed", "value_reverted", "readonly_picker"]);
  // 框里剩下的也给没选上的日历记（#301）：控件层只在框里换成了别的日子时给 after=other。
  const LEFTOVER_REASONS = new Set([...TEXT_REJECTED, "selection_not_committed"]);
  const textLeftovers = new WeakMap();
  // 类名里的词不分大小写（CSS Modules 的 Calendar_panel__k3x）；只叫 x-datepicker、没有 role 的日历也算。
  const OVERLAY_SELECTOR = ["[role='listbox']", "[role='menu']", "[role='tree']", "[role='dialog']", "[role='alertdialog']", "[role='tooltip']",
    ...["dropdown", "popper", "popover", "popup", "suggest", "autocomplete", "picker-panel", "picker-dropdown", "picker-container",
      "datepicker", "date-picker", "calendar", "laydate", "toast", "tooltip", "modal"].map((word) => `[class*='${word}' i]`),
    ".el-message", ".ant-message"].join(", ");
  let overlayWindowMs = 1000;
  // 整页都写不上时不能每个框都多等 1 秒：只等前几个，诊断看这几个就够了。
  const OVERLAY_WAITS = 3;
  let overlayWatch = null;
  const overlayWatches = new WeakMap();

  function rememberLeftover(target, result) {
    const control = target?.kind === "element" ? target.element : target;
    if (!control || typeof control !== "object") return;
    if (LEFTOVER_REASONS.has(result?.reason) && result.observed?.after) textLeftovers.set(control, { after: result.observed.after, session: fillSession });
    else textLeftovers.delete(control);
  }

  const overlayWords = (element) => `${element.getAttribute?.("role") || ""} ${typeof element.className === "string" ? element.className : ""}`;
  // 日历：带 picker、calendar、laydate，或 date / datetime 单独成词（x-datetime-content、DatePanel）。
  // candidate、update、validate 里的 date 不算。
  const isCalendarOverlay = (element) => {
    const words = overlayWords(element);
    return /picker|calendar|laydate/i.test(words) || /(?<![a-z])date(?:time)?(?![a-z])/i.test(words.replace(/([a-z])(?=[A-Z])/g, "$1 "));
  };

  // 日期面板、日历算别的弹层；下拉、联想建议算建议框。
  function overlayKind(element) {
    if (isCalendarOverlay(element)) return "other";
    return /listbox|menu|tree|dropdown|suggest|autocomplete|select|option/i.test(overlayWords(element)) ? "list" : "other";
  }

  // #399 简道云的日期框失焦后把 1998-06 显示成 1998-06-01，日历却不收起：要点日子或在别处按下鼠标，表单才收下。
  // 框里只是年月日相同（被改写过）、这次弹出的日历过了收起动画的时间还开着，就不算写上。
  let calendarCloseMs = 500;
  async function calendarKeptOpen(watch, element, value) {
    const prepared = prepareTextValue(element, value);
    const typed = prepared.reason ? String(value ?? "") : prepared.value;
    const shown = String(element.value ?? "");
    if (shown === normalizeExpectedTextValue(element, typed) || !sameDateText(shown, typed) || !watch.calendarOpen()) {
      return false;
    }
    for (let waited = 0; waited < calendarCloseMs; waited += 50) {
      await new Promise((resolve) => window.setTimeout(resolve, 50));
      if (!watch.calendarOpen()) return false;
    }
    return true;
  }

  // 从开始填这个框起看 1 秒：结果是 list / other / none；没看完时 kind() 是 null。
  // 下一个字段开始填写时停下（stop(true)），免得把下一个字段的弹层算到这个框头上；这时还没看到弹层的，不说 none。
  function watchOverlays(control) {
    const visibleOverlays = () => {
      try {
        return Array.from(docOf(control).querySelectorAll(antdCss(control, OVERLAY_SELECTOR)))
          .filter((node) => !node.contains(control) && !node.closest(`#${SIDEBAR_ID}`) && isVisible(node));
      } catch {
        return [];
      }
    };
    const before = new Set(visibleOverlays());
    let kind = null;
    let done = false;
    let pending = null;
    let observer = null;
    let timer = null;
    let finish;
    const settled = new Promise((resolve) => { finish = resolve; });
    const look = () => {
      const fresh = visibleOverlays().filter((node) => !before.has(node));
      if (fresh.length) kind = fresh.some((node) => overlayKind(node) === "list") ? "list" : "other";
      return Boolean(kind);
    };
    const stop = (early = false) => {
      if (done) return;
      done = true;
      observer?.disconnect();
      window.clearTimeout(timer);
      window.clearTimeout(pending);
      if (!look() && !early) kind = "none";
      finish();
    };
    timer = window.setTimeout(stop, overlayWindowMs);
    try {
      observer = new MutationObserver(() => {
        if (pending === null) pending = window.setTimeout(() => { pending = null; if (!done && look()) stop(); }, 30);
      });
      observer.observe(docOf(control).documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "aria-hidden"] });
    } catch {
      // 没有 MutationObserver 时只在结束时看一次。
    }
    const calendarOpen = () => visibleOverlays().some((node) => !before.has(node) && isCalendarOverlay(node));
    // 插件自己要收起网页打开的弹层之前（#301 #417 只读框写不上），先看一眼：防抖的那一次可能还没到，收起以后就看不到了。
    const peek = () => { if (!done && look()) stop(); };
    return { kind: () => kind, settled, stop, calendarOpen, peek };
  }

  // fill：一键填写（含辅助新增）。只有它按框的要求整理要写的字、看写入后的弹层；侧栏和字段卡片的手动写入照原样写。
  // range：区间日期另一头的字段和这次要填的值（#429，见填写流程）。
  async function setElementValue(target, value, beforeWrite, isCurrent, onWrite, { fill = false, range = null } = {}) {
    const control = target?.kind === 'element' ? target.element : target;
    // 文本框才看弹层；不等文字提交时（测试）不看。
    overlayWatch?.stop(true);
    overlayWatch = fill && textCommitWaitMs > 0 && isHtmlElement(control) && !target?.pickerType
      && !["custom-select", "cascader", "date", "date-picker"].includes(target?.controlKind) && isTextControl(control) ? watchOverlays(control) : null;
    const watch = overlayWatch;
    // 这次没看弹层的（按日期组件、下拉填的，手动写入）不留上一次看到的。
    if (watch) overlayWatches.set(control, watch);
    else if (control && typeof control === 'object') overlayWatches.delete(control);
    let result = await operateControl(target, value, { hints: target?.hints, beforeWrite, isCurrent, onWrite, prepare: fill,
      beforeDismiss: () => watch?.peek(), range });
    if (result.ok && watch && isInputElement(control) && await calendarKeptOpen(watch, control, value)) {
      result = { ...result, ok: false, reason: "value_reverted", observed: { ...result.observed, rolledBack: true, after: "other" } };
    }
    if (control && typeof control === 'object') {
      rememberLeftover(control, result);
      if (result.ok) textFillFailures.delete(control);
      else textFillFailures.set(control, result.reason);
      // 页面还提示无效的也记下：结束前复核时提示消了，照样算填上（见 recheckVerifiedControls）。
      if ((result.ok || result.reason === 'validation_not_cleared') && result.observed?.dayDefaulted) dayDefaultedControls.add(control);
      else dayDefaultedControls.delete(control);
      const popup = popupObserved(result.observed, result.reason);
      if (popup) controlPopups.set(control, { ...popup, session: fillSession });
      else controlPopups.delete(control);
      // #497 控件的样子和等待过程（custom-controls.js 的 shape），只给没写上的字段的诊断用。这次填写里插件已经选过
      // 别的下拉或单选（afterChoice）：点开的列表可能是按那个值加载的（学院 → 专业），私有诊断不收它的选项。
      if (choiceWrites.session !== fillSession) choiceWrites = { session: fillSession, count: 0 };
      if (result.observed?.shape) controlShapes.set(control, { ...result.observed.shape, afterChoice: choiceWrites.count > 0, session: fillSession });
      else controlShapes.delete(control);
      // 文本框也算：学校、专业、公司、地区这类写进去的字，页面可能拿它去加载后面下拉的列表（学校 → 专业）。
      if (result.ok && (target?.kind === "radio" || ["custom-select", "cascader", "native-select", "radio"].includes(target?.controlKind)
        || DRIVER_KINDS.has(fieldKindOf(target?.binding?.label)))) choiceWrites.count += 1;
    }
    return result.ok;
  }

  function highlightFilledField(fieldEntry, value) {
    getHighlightTargets(fieldEntry, value).forEach((target) => {
      if (!isHtmlElement(target)) {
        return;
      }

      if (!isInViewport(target)) {
        target.scrollIntoView({ block: "center", behavior: "smooth" });
        queueFieldHighlightWhenVisible(target);
        return;
      }

      applyFieldHighlight(target);
    });
  }

  function queueFieldHighlightWhenVisible(target, attempt = 0) {
    clearFieldHighlightTimer(target);
    const timer = window.setTimeout(() => {
      if (isInViewport(target) || attempt >= 18) {
        applyFieldHighlight(target);
        return;
      }

      queueFieldHighlightWhenVisible(target, attempt + 1);
    }, 100);
    fieldHighlightTimers.set(target, timer);
  }

  function applyFieldHighlight(target) {
    clearFieldHighlightTimer(target);
    // 同源框架里的字段（#400）：高亮样式要放进框架自己的文档。
    if (docOf(target) !== document) injectFieldHighlightStyles(docOf(target));
    target.classList.remove(FIELD_HIGHLIGHT_CLASS);
    void target.offsetWidth;
    target.classList.add(FIELD_HIGHLIGHT_CLASS);

    const timer = window.setTimeout(() => {
      target.classList.remove(FIELD_HIGHLIGHT_CLASS);
      fieldHighlightTimers.delete(target);
    }, 2800);
    fieldHighlightTimers.set(target, timer);
  }

  function clearFieldHighlightTimer(target) {
    if (!fieldHighlightTimers.has(target)) {
      return;
    }

    window.clearTimeout(fieldHighlightTimers.get(target));
    fieldHighlightTimers.delete(target);
  }

  function getHighlightTargets(fieldEntry, value) {
    if (fieldEntry?.kind === "radio") {
      const trimmedValue = String(value || "").trim();
      const matchedRadio = fieldEntry.elements.find((radio) => {
        const optionText = getRadioOptionLabel(radio);
        return optionText === trimmedValue || radio.value === trimmedValue;
      });

      if (!matchedRadio) {
        return [];
      }

      return [matchedRadio.labels?.[0] || matchedRadio.closest("label") || matchedRadio];
    }

    const element = fieldEntry?.kind === "element" ? fieldEntry.element : fieldEntry;

    if (!isHtmlElement(element)) {
      return [];
    }

    if (fieldEntry?.pickerType) {
      return [element.closest(antdCss(element, ".ant-picker, .el-date-editor, [class*='date-picker'], .fx-form-datetime .x-datetime")) || element];
    }

    return [element];
  }

  // 按元素自己的视口算：同源框架里的元素（#400）的位置是相对框架的。
  function isInViewport(element) {
    const rect = element.getBoundingClientRect();
    const view = viewOf(element);
    const root = docOf(element).documentElement;
    return rect.top >= 0
      && rect.left >= 0
      && rect.bottom <= (view.innerHeight || root.clientHeight)
      && rect.right <= (view.innerWidth || root.clientWidth);
  }

  function injectFieldHighlightStyles(doc = document) {
    try {
      if (doc.getElementById(FIELD_HIGHLIGHT_STYLE_ID)) {
        return;
      }

      const style = doc.createElement("style");
      style.id = FIELD_HIGHLIGHT_STYLE_ID;
      style.textContent = FIELD_HIGHLIGHT_STYLE_TEXT;
      (doc.head || doc.documentElement).appendChild(style);
    } catch {
      // 框架正在跳转：这次不高亮，不影响填写。
    }
  }

  function profileResumeFields() {
    return self.ResumeProProfile?.profileToResumeFields(state.currentStore?.profile) || [];
  }

  function buildProfileChipsHtml(profileFields) {
    const groups = new Map();

    profileFields.forEach((field) => {
      if (!groups.has(field.group)) groups.set(field.group, []);
      groups.get(field.group).push(field);
    });

    return Array.from(groups, ([name, groupFields]) => `
      <section class="resume-pro__group">
        <div class="resume-pro__group-name">我的信息 · ${escapeHtml(name)}</div>
        <div class="resume-pro__chips">
          ${groupFields.map((field) => `
            <button
              class="resume-pro__chip"
              type="button"
              data-chip-id="${escapeHtml(`profile:${name}:${field.key}`)}"
              data-value="${escapeHtml(field.value)}"
              title="${escapeHtml(field.value)}"
            >
              ${escapeHtml(field.key)}
            </button>
          `).join("")}
        </div>
      </section>
    `).join("");
  }

  // #429：问到对方公司的题，回答按网站存在桌面，只在同一个网站本地复用（profile-fields.js 的 siteScopedTitle）。
  function siteScopedField(field) {
    const api = self.ResumeProProfile;
    return Boolean(api?.siteScopedTitle?.(api.normalizeKey(field?.title || field?.label)));
  }

  // 读这个网站记住的回答。网站由后台按本页网址认，这里不传；桌面旧、共享招聘站认不出公司、没连上时记下原因，当作没有。
  async function loadSiteAnswers() {
    const reading = readSiteAnswers();
    state.siteAnswersReading = reading;
    try {
      return await reading;
    } finally {
      if (state.siteAnswersReading === reading) state.siteAnswersReading = null;
    }
  }

  async function readSiteAnswers() {
    let reply = null;
    try {
      reply = await chrome.runtime.sendMessage({ type: "DESKTOP_SITE_ANSWERS_READ" });
    } catch {
      reply = null;
    }
    const ok = reply?.status === "ok" && typeof reply.site === "string" && Array.isArray(reply.answers);
    // 回复到的时候页面已经跳到别的网站（单页应用）：这份不是眼前这个网站的，不留，下次再读。
    const here = self.ResumeProProfile?.siteKeyOf?.(location.href) || "";
    const next = ok && reply.site === here ? { site: reply.site, answers: reply.answers }
      : { status: ok ? "stale" : String(reply?.status || "unavailable") };
    // 保存时重读失败：留着已经读到的这个网站的回答，候选不会因此从网站回答挪回补充字段。
    // 留着的不是眼前这个网站的（页面已经换了网站），照实换成这次的结果，免得「认不出网站」之类之后还反复去读。
    if (next.site || !currentSiteAnswers()) state.siteAnswers = next;
    return next;
  }

  // 读到的是不是这个页面所在网站的回答：单页应用可能已经跳到另一家公司的地址。
  function currentSiteAnswers() {
    const answers = state.siteAnswers;
    return answers?.site && answers.site === self.ResumeProProfile?.siteKeyOf?.(location.href) ? answers : null;
  }

  // 不用再读的：已经有这个网站的回答，或者桌面不支持、认不出网站、后台不认这个发送方（再读结果也一样）。
  // 别的失败（桌面暂时没连上之类）后来冒出公司题时再读。
  function siteAnswersSettled() {
    return Boolean(currentSiteAnswers()) || ["unsupported", "no_site", "forbidden"].includes(state.siteAnswers?.status);
  }

  function siteAnswerResumeFields(siteAnswers) {
    return siteAnswers?.site ? self.ResumeProProfile.siteAnswerFields(siteAnswers.answers) : [];
  }

  // 候选规划用：读到了这个网站的回答才按网站分；还在读时这类题先不列，读完重算；
  // 读不到（桌面旧、共享站点、读取失败）这类题照旧按补充字段处理。
  function siteOfferContext() {
    const answers = currentSiteAnswers();
    if (answers) return { answers: answers.answers };
    return state.siteAnswersReading && !siteAnswersSettled() ? { pending: true } : null;
  }

  // 填完之后，网页上没匹配上的字段（已填的和空着的）和它们此刻的内容，列给用户勾选后存进桌面「我的信息」（#189）。
  // 档案只在桌面：这里不留副本，每次都按网页当前的值和桌面最新的档案重新算。
  function offerUnansweredFields(candidates, stats = null) {
    const api = self.ResumeProProfile;
    if (!api) return;

    state.profileOfferCandidates = candidates;
    state.profileOfferSite = api.siteKeyOf?.(location.href) || "";
    state.profileOfferResult = null;
    state.profileResultCandidateSignature = "";
    state.profileDismissedCandidateSignature = null;
    state.profileOfferVersion += 1;
    // 问到对方公司的题这次填写时没读过网站回答（比如都没在填写的字段里），或者上次没读成：再读一次。
    // 读的时候这类题先不列（不然用户这时保存，会按补充字段存进「我的信息」），读完重算一遍，候选换了版本。
    if (!siteAnswersSettled() && candidates.some((candidate) => api.siteScopedCandidate(candidate))) {
      const version = state.profileOfferVersion;
      loadSiteAnswers().then(() => {
        if (version !== state.profileOfferVersion || !state.profileOfferCandidates?.length) return;
        state.profileOfferVersion += 1;
        const fresh = currentProfilePlan();
        if (api.planHasOffer(fresh)) syncProfileOfferCard(fresh);
      }).catch(() => {});
    }
    const plan = currentProfilePlan(state.currentStore, stats);

    if (!api.planHasOffer(plan)) {
      // 问到对方公司的题还空着，或者网站回答还在读（#429）：候选留着、卡片先不显示（没有可存的项时 syncProfileOfferCard 把它收起，
      // 侧栏的快照也是 null），用户在网页上答了、读完了，侧栏下一次刷新就列出来。
      if (plan.siteWaiting) {
        syncProfileOfferCard(plan);
        return;
      }
      closeProfileOffer();
      return;
    }
    syncProfileOfferCard(plan);
  }

  function closeProfileOffer() {
    const card = shadowRoot?.querySelector("#resume-pro-profile-offer");
    if (card) card.hidden = true;
    state.profileOfferCandidates = [];
    state.profileOfferSite = "";
    state.profileOfferResult = null;
    state.profileResultCandidateSignature = "";
    state.profileDismissedCandidateSignature = null;
  }

  // 「完成」收起整张卡；保留候选以便网页上补出新答案时重新出现。
  function dismissProfileResult() {
    const result = state.profileOfferResult;
    state.profileOfferResult = null;
    state.profileResultCandidateSignature = "";
    // 部分保存后仍有可处理的候选时，直接把更新后的内容交还给用户复核。
    state.profileDismissedCandidateSignature = result?.kind === "partial" ? null
      : profileCandidateSignature(currentProfilePlan());
  }

  function syncProfileOfferCard(plan) {
    const api = self.ResumeProProfile;
    const card = shadowRoot?.querySelector("#resume-pro-profile-offer");
    if (!card) return;
    const offered = api.planHasOffer(plan);
    card.hidden = !offered;
    const note = card.querySelector?.("#resume-pro-profile-offer-text");
    if (offered && note) note.textContent = api.profileOfferSummary(plan);
  }

  const PROFILE_UNREADABLE_TYPES = new Set(["password", "file", "hidden", "checkbox"]);

  function cleanProfileText(value, multiline) {
    const raw = String(value ?? "").replace(/\r\n?/g, "\n").trim();
    return multiline ? raw : raw.replace(/\s+/g, " ");
  }

  // 读出用户眼前看到的值：文本原样、下拉和单选是选项文字（不是内部 code）。
  // stale = 控件没了或和题目的对应关系变了；unreadable = 有内容但读不准，不猜。
  function readProfileEntry(entry) {
    const stale = { state: "stale", value: "" };
    const unreadable = { state: "unreadable", value: "" };
    const ready = (value) => ({ state: "ready", value });
    const controls = entry?.kind === "radio" ? entry.elements : [entry?.element];
    if (!controls?.length || !controls.every((el) => el?.isConnected) || !isFieldBindingCurrent(entry)) return stale;
    try {
      if (entry.kind === "radio") {
        const checked = entry.elements.find(radioChecked);
        if (!checked) return ready("");
        const label = cleanProfileText(isInputElement(checked) ? checked.labels?.[0]?.textContent || checked.closest?.("label")?.textContent
          || checked.getAttribute?.("aria-label") : checked.textContent, false);
        return label ? ready(label) : unreadable;
      }
      const el = entry.element;
      if (PROFILE_UNREADABLE_TYPES.has(String(el.type || "").toLowerCase())) return unreadable;
      if (["custom-select", "cascader"].includes(entry.controlKind)) {
        const selection = self.ResumeProCustomControls?.readSelection?.(entry);
        if (selection?.texts?.length) return ready(cleanProfileText(selection.texts.join(selection.cascade ? "/" : "、"), false));
        return hasExistingValue(entry) ? unreadable : ready("");
      }
      if (isSelectElement(el)) {
        const options = Array.from(el.options || []);
        const chosen = el.multiple ? options.filter((option) => option.selected) : [options[el.selectedIndex]].filter(Boolean);
        const texts = chosen
          .filter((option) => option.value !== "" && !self.ResumeProAIHelpers?.isPlaceholderOption?.({ value: option.value, text: option.text, disabled: option.disabled }))
          .map((option) => cleanProfileText(option.text ?? option.textContent, false))
          .filter(Boolean);
        return ready(texts.join("、"));
      }
      return ready(cleanProfileText(el.isContentEditable ? el.textContent : el.value, el.tagName === "TEXTAREA" || el.isContentEditable));
    } catch {
      return unreadable;
    }
  }

  // 此刻的候选规划：网页当前的值 × 给定的桌面档案和模板。
  function currentProfilePlan(store = state.currentStore, stats = null) {
    const candidates = (state.profileOfferCandidates || []).map((candidate) =>
      candidate.matched ? candidate : { ...candidate, ...readProfileEntry(candidate.entry) });
    const template = getActiveTemplate(store);
    return self.ResumeProProfile.planProfileOffer({
      candidates, profile: store?.profile, templateFields: template ? flattenTemplateFields(template) : [], stats,
      site: siteOfferContext()
    });
  }

  // 侧栏画候选用的快照。值只经这条本机消息给侧栏，不进诊断、反馈或存储。
  function panelProfileSnapshot() {
    const api = self.ResumeProProfile;
    let result = state.profileOfferResult;
    if (!api || (!state.profileOfferCandidates?.length && !result)) return null;
    const plan = state.profileOfferCandidates?.length
      ? currentProfilePlan()
      : { filled: [], pending: [], conflicts: [], site: [], notes: [], same: 0, hidden: 0 };
    // 保存完成后保持简短结果；用户随后在网页补出新答案时，再展示新的保存建议。
    if (result?.saved > 0 && profileCandidateSignature(plan) !== state.profileResultCandidateSignature) {
      state.profileOfferResult = null;
      result = null;
    }
    if (state.profileDismissedCandidateSignature !== null) {
      if (profileCandidateSignature(plan) === state.profileDismissedCandidateSignature) return null;
      state.profileDismissedCandidateSignature = null;
    }
    if (!api.planHasOffer(plan) && !result) return null;
    return {
      epoch: state.profileOfferEpoch,
      version: state.profileOfferVersion,
      saving: state.profileSaving,
      summary: api.planHasOffer(plan) ? api.profileOfferSummary(plan) : "",
      filled: plan.filled.map(({ id, key, value, completes, jobSpecific, defaultSelected }) => ({ id, key, value, completes, jobSpecific, defaultSelected })),
      pending: plan.pending.map(({ id, key, unreadable }) => ({ id, key, unreadable, defaultSelected: false })),
      conflicts: plan.conflicts.map(({ id, key, value, existing }) => ({ id, key, value, existing, defaultSelected: false })),
      site: (plan.site || []).map(({ id, key, value, existing, defaultSelected }) => ({ id, key, value, existing, defaultSelected })),
      siteName: currentSiteAnswers()?.site || "",
      notes: plan.notes.map((note) => note.text),
      same: plan.same,
      hidden: plan.hidden,
      result: state.profileOfferResult ? { ...state.profileOfferResult } : null
    };
  }

  function profileCandidateSignature(plan) {
    return JSON.stringify([
      ...(plan?.filled || []).map((item) => [item.id, item.value]),
      ...(plan?.conflicts || []).map((item) => [item.id, item.value, item.existing]),
      ...(plan?.site || []).map((item) => [item.id, item.value, item.existing])
    ]);
  }

  function normalizeProfileSelection(raw) {
    return (Array.isArray(raw) ? raw : []).slice(0, 200).map((item) => ({
      id: String(item?.id ?? ""),
      key: String(item?.key ?? ""),
      kind: ["filled", "pending", "conflict", "site"].includes(item?.kind) ? item.kind : undefined,
      reviewedValue: typeof item?.reviewedValue === "string" ? item.reviewedValue : undefined,
      replaceOf: typeof item?.replaceOf === "string" ? item.replaceOf : undefined
    }));
  }

  function profileSaveFailure(status) {
    if (status === "conflict") return "「我的信息」刚在别处改过，这次没有保存；候选还在，请再点一次保存。";
    if (status === "secret") return "桌面认为有一项内容像密码或验证码，这次没有保存任何内容；候选还在。";
    if (status === "input_too_large") return "「我的信息」太大，桌面没有保存。先在桌面删掉用不上的补充字段；候选还在。";
    if (status === "invalid_payload") return "桌面没有接受这次保存（可能超出补充字段数量或大小限制），什么都没有写入；候选还在。";
    if (["not_installed", "not_paired", "never_paired", "incompatible", "unavailable"].includes(status)) {
      return `没有保存：${self.ResumeProResumeData.modeCopy(status).message}候选还在，连上后再点保存。`;
    }
    return "桌面暂时无法保存「我的信息」，什么都没有写入；候选还在，可以稍后再试。";
  }

  function siteSaveFailure(status) {
    if (status === "conflict") return "这个网站的回答刚在桌面改过，网站回答这次没有保存；请重新核对后再保存。";
    if (status === "secret") return "桌面认为有一项回答像密码或验证码，网站回答这次没有保存。";
    if (status === "invalid_payload" || status === "input_too_large") return "桌面没有接受这次的网站回答（可能超出数量限制，或桌面认为这道题不该按网站记住），什么都没有写入。";
    if (status === "unsupported") return "桌面程序版本较旧，不能按网站记住回答；更新桌面程序后再保存。";
    if (status === "no_site") return "认不出这个网站是哪家公司，网站回答没有保存。";
    if (status === "stale") return "页面已经换到别的网站，网站回答这次没有保存；候选还在。";
    if (["not_installed", "not_paired", "never_paired", "incompatible", "unavailable"].includes(status)) {
      return `网站回答没有保存：${self.ResumeProResumeData.modeCopy(status).message}`;
    }
    return "桌面暂时无法保存网站回答，什么都没有写入；可以稍后再试。";
  }

  // #429：勾选的网站回答。点击时重读桌面里这个网站的回答和网页当前的值；previous 对不上（桌面刚改过）重读一次再核对。
  async function saveSiteSelection(selection) {
    const api = self.ResumeProProfile;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const read = await loadSiteAnswers();
      if (!read.site) return { saved: [], skipped: [], error: siteSaveFailure(read.status) };
      // 用户核对候选时是另一个网站（单页应用已经跳走）：那些回答不是这个网站的，不存。
      if (read.site !== state.profileOfferSite) return { saved: [], skipped: [], error: siteSaveFailure("stale") };
      const plan = currentProfilePlan();
      const outcome = api.applySiteSelection(plan, selection ?? api.defaultProfileSelection(plan));
      if (!outcome.answers.length) return { saved: [], skipped: outcome.skipped, error: "" };
      let reply = null;
      try {
        // 带上要存到的网站：后台按发消息时的页面地址再核对一次，读和存之间页面换了网站就不写。
        reply = await chrome.runtime.sendMessage({ type: "DESKTOP_SITE_ANSWERS_SAVE", site: read.site, answers: outcome.answers });
      } catch {
        reply = null;
      }
      if (reply?.status === "conflict" && attempt === 0) continue;
      if (reply?.status !== "ok") return { saved: [], skipped: outcome.skipped, error: siteSaveFailure(reply?.status) };
      // 桌面确认写入了；下次填写和候选都用它回的这个网站的全部回答。
      state.siteAnswers = { site: reply.site, answers: reply.answers };
      return { saved: outcome.saved, skipped: outcome.skipped, error: "" };
    }
    return { saved: [], skipped: [], error: siteSaveFailure("conflict") };
  }

  // 点击保存：补充字段和网站回答（#429）分开写，各自重读桌面、各自核对；两边的结果合在一起告诉用户。
  async function saveProfileSelection(request) {
    const api = self.ResumeProProfile;
    const selected = request ? normalizeProfileSelection(request.selected) : null;
    const siteChosen = selected ? selected.filter((item) => item.id.startsWith("site:")) : null;
    const profileChosen = selected ? selected.filter((item) => !item.id.startsWith("site:")) : null;
    // 网站回答还在读：等读完再按结果规划，问到对方公司的题不先按补充字段存（#429）。
    if (state.siteAnswersReading) await state.siteAnswersReading;
    const profile = !selected || profileChosen.length ? await saveProfileFields(profileChosen) : null;
    const site = (!selected && currentSiteAnswers()) || siteChosen?.length ? await saveSiteSelection(siteChosen) : null;
    if (!site) return profile ?? { ...api.describeProfileSave({}), saved: 0 };
    const saved = [...(profile?.savedItems || []), ...site.saved.map(({ key, value, kind }) => ({ key, value, kind }))];
    const skipped = [...(profile?.skippedItems || []), ...site.skipped];
    const errors = [profile?.kind === "error" ? profile.text : "", site.error].filter(Boolean);
    if (!saved.length && errors.length) return { kind: "error", text: errors.join(" "), hint: "", details: skipped.map((item) => item.text), saved: 0 };
    const message = api.describeProfileSave({ saved, skipped });
    if (errors.length) {
      message.kind = "partial";
      message.details = [...errors, ...message.details];
    }
    return {
      ...message, saved: saved.length, savedItems: saved,
      hint: [message.hint, profile?.reloadHint || ""].filter(Boolean).join(" ")
    };
  }

  // 补充字段：重新读桌面档案和网页当前的值，按用户的勾选写入，成功后再读一次桌面档案。
  async function saveProfileFields(selected) {
    const api = self.ResumeProProfile;
    const fail = (text) => ({ kind: "error", text, hint: "", details: [], saved: 0 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const fresh = await StorageService.getState();
      if (!fresh) return fail(profileSaveFailure(state.desktopMode));
      state.currentStore = fresh;
      const plan = currentProfilePlan(fresh);
      const selection = selected ?? api.defaultProfileSelection(plan);
      const outcome = api.applyProfileSelection(fresh.profile, plan, selection);
      if (!outcome.saved.length) return { ...api.describeProfileSave(outcome), saved: 0, savedItems: [], skippedItems: outcome.skipped };

      const reply = await chrome.runtime.sendMessage({
        type: "DESKTOP_RESUME_UPDATE", op: "saveProfile",
        profile: outcome.profile, expectedRevision: fresh.profileRevision
      });
      if (reply?.status === "conflict" && attempt === 0) continue;
      if (reply?.status !== "ok") return fail(profileSaveFailure(reply?.status));

      // 桌面确认写入了；插件显示和下次填写用的都是重新读到的桌面档案。
      const after = await StorageService.getState();
      if (after) {
        state.currentStore = after;
        if (shadowRoot?.querySelector("#resume-pro-template-select")) renderSidebar();
      }
      const message = api.describeProfileSave(outcome);
      const reloadHint = after ? "" : "暂时没能重新读取桌面档案，下次填写前会再读一次。";
      return {
        ...message, saved: outcome.saved.length,
        savedItems: outcome.saved.map(({ key, value, kind }) => ({ key, value, kind })),
        skippedItems: outcome.skipped, reloadHint,
        hint: [message.hint, reloadHint].filter(Boolean).join(" ")
      };
    }
    return fail(profileSaveFailure("conflict"));
  }

  async function addUnansweredToProfile(request = null) {
    const done = (extra) => ({ ...extra, profileOffer: panelProfileSnapshot() });
    if (!self.ResumeProProfile || !state.profileOfferCandidates?.length) {
      return done({ ok: false, saved: 0, error: "没有可保存的内容，请先一键填写。" });
    }
    if (Number.isInteger(request?.version) && request.version !== state.profileOfferVersion) {
      return done({ ok: false, saved: 0, error: "候选已经更新，请重新核对后再保存。" });
    }
    if (state.profileSaving) return done({ ok: false, saved: 0, error: "正在保存，请稍候。" });

    state.profileSaving = true;
    state.profileOfferResult = null;
    let result;
    try {
      result = await saveProfileSelection(request);
    } catch (error) {
      result = { kind: "error", text: `没有保存：${error?.message || "写入失败"}；候选还在。`, hint: "", details: [], saved: 0 };
    } finally {
      state.profileSaving = false;
    }
    state.profileOfferResult = result;
    const plan = currentProfilePlan();
    state.profileResultCandidateSignature = profileCandidateSignature(plan);
    syncProfileOfferCard(plan);
    // 原生侧栏自己显示结果；旧的页面内侧栏只读这块状态区，需要明确反馈。
    if (inPageUiVisible()) {
      const shown = [result.text, ...(result.details || []), result.hint].filter(Boolean).join(" ");
      showStatus(shown, result.kind === "success" ? "success" : "error", result.kind !== "success");
    }
    return done({ ok: result.saved > 0, saved: result.saved });
  }

  function flattenTemplateFields(template) {
    return template.groups.flatMap((group) => group.fields.map((field) => ({
      group: group.name,
      key: field.key,
      value: field.value
    })));
  }

  function getRadioOptionLabel(radio) {
    if (!isInputElement(radio)) return String(radio.textContent || "").replace(/\s+/g, " ").trim();
    const directLabel = radio.labels?.[0]?.textContent?.trim();

    if (directLabel) {
      return directLabel;
    }

    const wrappingLabel = radio.closest("label")?.textContent?.trim();
    if (wrappingLabel) {
      return wrappingLabel;
    }

    return radio.value?.trim() || "";
  }

  async function openManager(view = "home") {
    try {
      const result = await chrome.runtime.sendMessage({ type: "DESKTOP_OPEN_VIEW", view });
      if (result?.status !== "ok") {
        showStatus("桌面程序暂时无法打开，请检查连接。", "error");
      }
    } catch {
      showStatus("桌面程序暂时无法打开，请检查连接。", "error");
    }
  }

  async function openDesktopAction(mode) {
    const kind = self.ResumeProResumeData.modeCopy(mode).kind;
    if (kind === "download") {
      window.open(self.ResumeProResumeData.DOWNLOAD_URL, "_blank", "noopener");
    } else if (kind === "pair") {
      await copyText(chrome.runtime.id);
      showStatus("扩展 ID 已复制，请在桌面设置中粘贴并完成配对。", "success", true);
    } else if (kind === "retry") {
      state.currentStore = await StorageService.getState();
      renderSidebar();
    } else {
      await openManager(kind === "resume" ? "resume" : "home");
    }
  }

  function isFillTarget(target) {
    return (
      isInputElement(target) ||
      isTextAreaElement(target) ||
      isSelectElement(target) ||
      (isHtmlElement(target) && target.isContentEditable)
    );
  }

  function getActiveTemplate(store) {
    return store?.activeTemplate || null;
  }

  function hasResumeData() {
    return Boolean(getActiveTemplate(state.currentStore) || profileResumeFields().length);
  }

  function showStatus(message, variant, persist = false) {
    const statusElement = shadowRoot?.querySelector("#resume-pro-status");

    if (!statusElement) {
      return;
    }

    statusElement.textContent = message;
    statusElement.className = `resume-pro__status is-visible is-${variant}`;

    if (state.statusTimer) {
      clearTimeout(state.statusTimer);
      state.statusTimer = null;
    }

    if (persist) {
      return;
    }

    state.statusTimer = window.setTimeout(() => {
      statusElement.className = "resume-pro__status";
      statusElement.textContent = "";
    }, 2400);
  }

  function startDrag(event) {
    if (event.target.closest("button, select, input")) {
      return;
    }

    const host = document.getElementById(SIDEBAR_ID);
    const rect = host.getBoundingClientRect();
    state.dragging = true;
    state.dragOffsetX = event.clientX - rect.left;
    state.dragOffsetY = event.clientY - rect.top;
    shadowRoot?.querySelector(".resume-pro")?.classList.add("is-dragging");
  }

  function onDrag(event) {
    if (!state.dragging) {
      return;
    }

    const sidebar = document.getElementById(SIDEBAR_ID);
    const width = sidebar.offsetWidth;
    const height = sidebar.offsetHeight;
    const nextLeft = clamp(event.clientX - state.dragOffsetX, 12, window.innerWidth - width - 12);
    const nextTop = clamp(event.clientY - state.dragOffsetY, 12, window.innerHeight - height - 12);

    sidebar.style.left = `${nextLeft}px`;
    sidebar.style.top = `${nextTop}px`;
    sidebar.style.right = "auto";
  }

  function stopDrag() {
    if (!state.dragging) {
      return;
    }

    state.dragging = false;
    shadowRoot?.querySelector(".resume-pro")?.classList.remove("is-dragging");
    persistSidebarUiState();
  }

  function updateCollapseButton(sidebar = shadowRoot?.querySelector(".resume-pro")) {
    const collapseButton = sidebar?.querySelector(".resume-pro__collapse");
    if (!collapseButton) {
      return;
    }

    const collapsed = sidebar.classList.contains("is-collapsed");
    collapseButton.textContent = collapsed ? "+" : "−";
    collapseButton.setAttribute("aria-label", collapsed ? "展开助手" : "折叠助手");
    collapseButton.setAttribute("aria-expanded", String(!collapsed));
  }

  function readSidebarUiState() {
    const host = document.getElementById(SIDEBAR_ID);
    const sidebar = shadowRoot?.querySelector(".resume-pro");
    if (!host || !sidebar) {
      return self.ResumeProSidebarState.normalize(state.sidebarUiState);
    }

    // The host uses position: fixed, so these are viewport coordinates unless a
    // page deliberately establishes a transformed containing block.
    const rect = host.getBoundingClientRect();
    return self.ResumeProSidebarState.normalize({
      collapsed: sidebar.classList.contains("is-collapsed"),
      left: rect.left,
      top: rect.top
    });
  }

  function applySidebarUiState() {
    const host = document.getElementById(SIDEBAR_ID);
    const sidebar = shadowRoot?.querySelector(".resume-pro");
    if (!host || !sidebar) {
      return;
    }

    const uiState = self.ResumeProSidebarState.normalize(state.sidebarUiState);
    sidebar.classList.toggle("is-collapsed", uiState.collapsed);
    updateCollapseButton(sidebar);

    if (uiState.left === null || uiState.top === null) {
      host.style.removeProperty("left");
      host.style.top = `${SIDEBAR_DEFAULT_TOP}px`;
      host.style.right = `${SIDEBAR_DEFAULT_RIGHT}px`;
      state.sidebarUiState = uiState;
      return;
    }

    const rect = host.getBoundingClientRect();
    const constrained = self.ResumeProSidebarState.constrain(
      uiState,
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight }
    );
    host.style.left = `${constrained.left}px`;
    host.style.top = `${constrained.top}px`;
    host.style.right = "auto";
    state.sidebarUiState = constrained;
  }

  // The saved state is read while startup goes on. Before the controller exists it is simply
  // kept for createSidebar; after that it is applied, unless a drag is in progress.
  function applyStoredSidebarUiState(uiState) {
    if (state.dragging) return;
    state.sidebarUiState = self.ResumeProSidebarState.normalize(uiState);
    applySidebarUiState();
  }

  function constrainSidebarToViewport() {
    const current = self.ResumeProSidebarState.normalize(state.sidebarUiState);
    if (current.left === null || current.top === null) {
      // Keep the untouched default anchored to the right edge as the viewport changes.
      state.sidebarUiState = current;
      applySidebarUiState();
      return false;
    }

    // A resize only pulls the sidebar back into view for this session. It is
    // deliberately not persisted: a window the user shrank for a moment should not
    // overwrite the position they chose on a larger one.
    state.sidebarUiState = readSidebarUiState();
    applySidebarUiState();
    return !self.ResumeProSidebarState.equal(current, state.sidebarUiState);
  }

  function persistSidebarUiState() {
    const previous = self.ResumeProSidebarState.normalize(state.sidebarUiState);
    state.sidebarUiState = readSidebarUiState();
    applySidebarUiState();
    if (self.ResumeProSidebarState.equal(previous, state.sidebarUiState)) {
      return;
    }
    StorageService.setSidebarUiState(state.sidebarUiState).catch(() => {});
  }

  function clamp(value, min, max) {
    return max < min ? 0 : Math.min(Math.max(value, min), max);
  }

  function inferPickerInputType(container, inner) {
    // 简道云日期框的类名都带 datetime（x-datetime），说明不了格式，只看占位文字。
    const cls = container.matches?.(".fx-form-datetime .x-datetime") ? "" : container.className || "";
    const placeholder = (inner.getAttribute("placeholder") || "").toLowerCase();
    if (/time/i.test(cls) || /时间|hh:mm/.test(placeholder)) return "time";
    if (/month/i.test(cls) || /年月|月份|month/.test(placeholder)) return "month";
    if (/datetime/i.test(cls) || /日期.*时间|datetime/.test(placeholder)) return "datetime-local";
    return "date";
  }

  // 样式按元素所在的 window 取（#400 同源框架里的元素）。
  function isVisible(element) {
    const styles = viewOf(element).getComputedStyle(element);
    const rect = element.getBoundingClientRect();

    return styles.display !== "none"
      && styles.visibility !== "hidden"
      && rect.width > 0
      && rect.height > 0;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  // --- Desktop link ---------------------------------------------------------
  //
  // The sidebar reads the page and shows the result; the service worker owns the native
  // messaging port and both queues. Content scripts cannot open that port at all, so every
  // desktop operation is a message.
  //
  // Extraction and URL redaction run here rather than in the worker because the worker has
  // no DOM, and because §5.2 puts the credential stripping before anything leaves the page.

  let desktopModules = null;
  let pendingFields = null;
  let saveInFlight = false;
  let extractInFlight = false;
  let lastSubmittedFields = null;
  let extractToken = 0;
  let assistRequestId = null;
  let assistFallback = null;
  // The finished fill the card is offering to archive, and a copy of the template it used.
  // Held only until the user answers; the template copy leaves only if the box is ticked.
  let pendingFill = null;
  let pendingFillTemplate = null;

  async function loadDesktopModules() {
    if (!desktopModules) {
      const [extract, copy, fillrecords, snapshot, saveFlow] = await Promise.all([
        import(chrome.runtime.getURL("link/extract.mjs")),
        import(chrome.runtime.getURL("link/copy.mjs")),
        import(chrome.runtime.getURL("link/fillrecords.mjs")),
        import(chrome.runtime.getURL("link/snapshot.mjs")),
        import(chrome.runtime.getURL("link/save-flow.mjs"))
      ]);
      desktopModules = { extract, copy, fillrecords, snapshot, saveFlow };
    }
    return desktopModules;
  }

  function bindDesktopEvents(sidebar) {
    sidebar.querySelector("#resume-pro-save-job")?.addEventListener("click", handleSaveJobClick);
    sidebar.querySelector("#resume-pro-confirm-submit")?.addEventListener("click", handleConfirmSubmitClick);
    sidebar.querySelector("#resume-pro-save-cancel")?.addEventListener("click", closeSaveForm);
    sidebar.querySelector("#resume-pro-job-assist-cancel")?.addEventListener("click", cancelJobAssist);
    sidebar.querySelector("#resume-pro-save-open-ai")?.addEventListener("click", () => openManager("settings-ai"));
    sidebar.querySelector("#resume-pro-fill-record-save")?.addEventListener("click", handleRecordFillClick);
    sidebar.querySelector("#resume-pro-fill-record-skip")?.addEventListener("click", closeFillRecord);
    sidebar.querySelector("#resume-pro-save-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      submitSaveForm({ force: false });
    });
    refreshPendingList();
  }

  async function handleSaveJobClick() {
    const form = shadowRoot?.querySelector("#resume-pro-save-form");
    if (!form || !form.hidden || saveInFlight || extractInFlight) return;
    const token = ++extractToken;
    extractInFlight = true;
    const button = shadowRoot.querySelector("#resume-pro-save-job");
    if (button) button.disabled = true;
    form.hidden = true;
    setDesktopStatus(null);

    try {
      const draft = await draftJobFields({
        isCurrent: () => token === extractToken,
        onAssistStart: (described, requestId, fallback) => {
          assistRequestId = requestId;
          assistFallback = fallback;
          showJobAssist(described);
        },
        onAssistEnd: (requestId) => {
          if (assistRequestId === requestId) assistRequestId = null;
          if (token === extractToken) hideJobAssist();
        }
      });
      if (!draft || token !== extractToken) return;
      openSaveForm(draft.fields, draft.note, { openView: draft.openView });
    } catch (error) {
      if (token !== extractToken) return;
      setDesktopStatus({ tone: "warn", text: "读取页面信息失败，请手动填写后再保存。" });
      openSaveForm(emptyJobFields(), "读取页面信息失败，请手动填写。");
    } finally {
      if (token === extractToken) {
        extractInFlight = false;
        if (button) button.disabled = saveInFlight;
      }
    }
  }

  function emptyJobFields() {
    return { company: "", title: "", location: "", sourceUrl: "", dedupeUrl: "" };
  }

  // Step one of saving a job, shared by the page form and the native side panel: read the
  // page, ask the desktop's AI only when extraction is unsure, and return what the user
  // should review. Nothing is written anywhere here. `null` means the caller moved on
  // (cancelled or restarted) and the answer must be dropped.
  // `trace`（#301）：调用方给的 [岗位] 记录，这里写进来源、还缺哪个和 AI 识别的结果码。
  async function draftJobFields({ isCurrent, onAssistStart, onAssistEnd, trace = null }) {
    const { extract, saveFlow, copy } = await loadDesktopModules();
    const extraction = extract.extractJobFields(document, location.href);
    const step = saveFlow.nextSaveStep(extraction);
    if (!isCurrent()) return null;
    // 先按本地读到的记：AI 识别中途取消时，表单就是这一份。
    traceJobFields(trace, step.fields, jobSources(step.fields, extraction));
    if (step.action === "commit") {
      return { fields: step.fields, note: copy.describeReviewSave(), openView: null, fallback: step.fields };
    }
    if (step.action === "assist") {
      const outcome = await runJobAssist(step.fragments, step.fields, { isCurrent, onAssistStart, onAssistEnd, trace });
      if (!isCurrent() || outcome.action === "ignore") return null;
      traceJobFields(trace, outcome.fields, jobSources(outcome.fields, extraction, outcome.aiFields, step.fragments));
      return {
        fields: outcome.fields,
        note: outcome.action === "commit" ? copy.describeReviewSave() : outcome.note,
        openView: outcome.openView || null,
        fallback: step.fields
      };
    }
    return { fields: step.fields, note: copy.describeManualSave(step.reason), openView: null, fallback: step.fields };
  }

  // The worker asks the desktop's AI and gives up after 25 seconds itself; this timer only
  // covers a worker that never answers. There is no automatic retry either way.
  async function runJobAssist(fragments, fallback, { isCurrent, onAssistStart, onAssistEnd, trace = null }) {
    const { saveFlow, copy } = await loadDesktopModules();
    // The user may have cancelled, or the page moved on, while the modules were loading.
    // Checked before anything is shown or sent: an assist panel raised for a job nobody is
    // waiting for would have no request to end it and would stay on screen.
    if (!isCurrent()) return { action: "ignore" };
    const requestId = newRequestId();
    onAssistStart?.(copy.describeJobAssist(saveFlow.assistDisclosure(fragments)), requestId, fallback);
    // Showing the progress can itself hand control away (a caller that re-renders). If the
    // job stopped being current, the progress is taken down again and nothing is sent.
    if (!isCurrent()) {
      onAssistEnd?.(requestId);
      return { action: "ignore" };
    }
    if (trace) trace.aiCalled = true;
    let reply;
    let timer;
    try {
      reply = await Promise.race([
        self.ResumeProAIClient.send({ type: "AI_EXTRACT_JOB", requestId, fragments }),
        new Promise(resolve => {
          timer = setTimeout(() => {
            self.ResumeProAIClient.cancel(requestId).catch(() => {});
            resolve({ status: "manual", reason: "timeout", reliable: false, fields: {} });
          }, 30000);
        })
      ]);
    } catch {
      reply = { status: "manual", reason: "internal", reliable: false, fields: {} };
    } finally {
      clearTimeout(timer);
      onAssistEnd?.(requestId);
    }
    if (!isCurrent()) return { action: "ignore" };
    // 结果码只取固定的原因码，feedback-core 再按白名单过一遍；取消后晚到的回复不记。
    if (trace) trace.aiCode = typeof reply?.reason === "string" ? reply.reason : "other";
    const after = saveFlow.afterAssist(reply, fallback);
    if (after.action === "form") {
      // `note` is a desktop failure from the worker; `error` is the host saying the worker itself died.
      const detail = [reply?.note, reply?.error].find(value => typeof value === "string" && value) || "";
      after.note = copy.describeManualSave(after.reason, detail);
      if (reply?.openView === "settings-ai") after.openView = "settings-ai";
    }
    // What the AI suggested, only to tell where the review's company and title came from (#301).
    after.aiFields = reply?.fields || null;
    return after;
  }

  // #301 手动反馈的 [岗位]：核对表单里的公司、岗位从哪来。本地读到的分结构化数据（JobPosting）和站点规则（北森、hotjob）；
  // AI 识别的看它引用的是不是页面标题。认不出来源（用户自己写的）返回空字符串，由 traceJobFields 沿用之前的。
  function jobSources(fields, extraction, ai = null, fragments = []) {
    const of = key => {
      const value = fields?.[key];
      if (!value) return "none";
      const local = extraction?.sources?.[key];
      if (local?.value === value) return local.source === "jobposting" ? "structured" : "site_rule";
      if (ai?.[key] === value) return fragments.some(item => item.role === "page-title" && item.text === value) ? "page_title" : "ai";
      return "";
    };
    return { company: of("company"), title: of("title") };
  }

  function newJobTrace() {
    return { companySource: "none", titleSource: "none", missingCompany: true, missingTitle: true, aiCalled: false, aiCode: "", end: "open" };
  }

  // 没做过「保存岗位到桌面端」、或 feedback-core 缺席时没有这一段。
  function jobTraceReport() {
    try { return self.ResumeProFeedback?.jobReport?.(jobTrace) || ""; } catch { return ""; }
  }

  // 核对表单现在是什么样：来源和还缺哪个。只记固定的词和是否为空，不记内容。
  function traceJobFields(trace, fields, sources = {}) {
    if (!trace) return;
    trace.companySource = sources.company || trace.companySource;
    trace.titleSource = sources.title || trace.titleSource;
    trace.missingCompany = !fields?.company;
    trace.missingTitle = !fields?.title;
  }

  // 写入桌面的结果 → [岗位] 的结局：存进桌面、进了待同步、没能确认、没写上。
  function jobWriteEnd(status) {
    if (status === "saved") return "saved";
    if (["pending", "queued", "duplicate"].includes(status)) return "queued";
    return !status || status === "unknown" ? "unknown" : "failed";
  }

  function showJobAssist(described) {
    const panel = shadowRoot?.querySelector("#resume-pro-job-assist");
    if (!panel) return;
    // The note is a status region: show the panel first so a screen reader hears the text
    // arrive, rather than finding it already there.
    panel.hidden = false;
    panel.querySelector("#resume-pro-job-assist-note").textContent = described.text;
    const list = panel.querySelector("#resume-pro-job-assist-fragments");
    list.textContent = "";
    for (const line of described.fragments || []) {
      const item = document.createElement("li");
      item.textContent = line;
      list.appendChild(item);
    }
  }

  function hideJobAssist() {
    const panel = shadowRoot?.querySelector("#resume-pro-job-assist");
    if (!panel) return;
    panel.hidden = true;
    // Cleared so the next recognition is announced again.
    const note = panel.querySelector("#resume-pro-job-assist-note");
    if (note) note.textContent = "";
  }

  function cancelJobAssist() {
    const token = ++extractToken;
    extractInFlight = false;
    if (assistRequestId) self.ResumeProAIClient.cancel(assistRequestId).catch(() => {});
    assistRequestId = null;
    const button = shadowRoot?.querySelector("#resume-pro-save-job");
    if (button) button.disabled = saveInFlight;
    hideJobAssist();
    const fields = assistFallback || pendingFields || emptyJobFields();
    // The panel is already gone; the form has to open either way or the user is left with nothing.
    loadDesktopModules().then(({ copy }) => copy.describeManualSave("cancelled"), () => "已取消识别。请手动补全后再保存。")
      .then(note => {
        if (token !== extractToken) return;
        openSaveForm(fields, note);
      });
  }

  function openSaveForm(fields, note, { openView = null } = {}) {
    const form = shadowRoot?.querySelector("#resume-pro-save-form");
    if (!form) return;
    pendingFields = fields;
    form.querySelector("#resume-pro-save-company").value = fields.company || "";
    form.querySelector("#resume-pro-save-title").value = fields.title || "";
    form.querySelector("#resume-pro-save-location").value = fields.location || "";
    form.querySelector("#resume-pro-save-url").value = fields.sourceUrl || "";
    form.querySelector("#resume-pro-save-note").textContent = note;
    const openAi = form.querySelector("#resume-pro-save-open-ai");
    if (openAi) openAi.hidden = openView !== "settings-ai";
    form.hidden = false;
  }

  // Confirming a submission is its own act: it has nothing to do with whether the AI fill
  // worked, and nothing to do with having saved the posting a moment ago. The application is
  // chosen from the desktop's own candidates rather than remembered here, so the plugin never
  // holds a stale application id across a restore.
  async function handleConfirmSubmitClick() {
    const { extract, copy } = await loadDesktopModules();
    const fields = extract.extractJobFields(document, location.href);
    if (!fields.company) {
      setDesktopStatus({ tone: 'warn', text: '这个页面看不出是哪家公司，请先在桌面里确认投递。' });
      return;
    }

    let candidates;
    try {
      candidates = await chrome.runtime.sendMessage({ type: "DESKTOP_CANDIDATES_FOR", fields });
    } catch {
      candidates = null;
    }
    if (candidates?.status !== "ok") {
      // Nothing was written or queued: say which way the desktop could not be reached.
      setDesktopStatus(copy.describeConfirmBlocked(confirmBlockedMode(candidates?.status), { extensionId: chrome.runtime.id }));
      return;
    }

    const options = [...candidates.exact, ...candidates.sameCompany];
    if (!options.length) {
      setDesktopStatus({ tone: 'warn', text: '桌面里还没有这家公司的申请，请先保存岗位。' });
      return;
    }

    const box = shadowRoot?.querySelector("#resume-pro-candidates");
    const list = shadowRoot?.querySelector("#resume-pro-candidate-list");
    shadowRoot.querySelector("#resume-pro-candidates-note").textContent = "这次投递的是哪一条申请？";
    list.textContent = "";
    for (const candidate of options) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "resume-pro__candidate";
      row.textContent = `${candidate.company} · ${candidate.title}`;
      row.addEventListener("click", async () => {
        box.hidden = true;
        let result;
        try {
          result = await chrome.runtime.sendMessage({
            type: "DESKTOP_CONFIRM_SUBMIT", applicationId: candidate.applicationId
          });
        } catch {
          result = { status: "unknown" };
        }
        setDesktopStatus(copy.describeConfirmResult(result ?? { status: "unknown" }));
        refreshPendingList();
      });
      list.appendChild(row);
    }
    shadowRoot.querySelector("#resume-pro-bind-new").hidden = true;
    box.hidden = false;
  }

  // What the desktop's answer to a candidates query means for "确认已投递". Only these modes
  // have their own wording; a retryable or fatal failure is "the desktop is not answering".
  const CONFIRM_BLOCKED_MODES = new Set(["not_installed", "not_paired", "never_paired", "incompatible", "unavailable"]);
  function confirmBlockedMode(status) {
    return CONFIRM_BLOCKED_MODES.has(status) ? status : "unavailable";
  }

  // --- D08: archiving a finished fill ----------------------------------------------------
  //
  // After every fill the sidebar may offer to archive it. It never blocks the fill and never
  // throws into it, and a profile that has never paired a desktop is not asked at all: those
  // users keep nothing. What is offered is counts and timings; the field values stay here.

  async function offerFillRecord(raw, template) {
    const card = shadowRoot?.querySelector("#resume-pro-fill-record");
    if (!card) return;
    // Read the page before waiting on the worker: on a single-page site the user can move on
    // to the next posting meanwhile, and this fill must not be filed under that one. The
    // modules were warmed when the fill started; if they were not, and the page changed while
    // they loaded, there is no posting to offer this fill under.
    const pageUrl = location.href;
    const { extract, copy, fillrecords, snapshot } = await loadDesktopModules();
    if (location.href !== pageUrl) return;
    const job = extract.extractJobFields(document, pageUrl);
    const link = await chrome.runtime.sendMessage({ type: "DESKTOP_LINK_STATE" });
    if (!link?.everPaired) return;
    // The template the fill actually used, frozen now: editing the template before answering
    // must not change what the snapshot says was used (D08 decision 2).
    pendingFillTemplate = template ? structuredClone(template) : null;
    pendingFill = {
      ...raw,
      // This one finished fill's id (#178). Minted here, it is the record's id if the user
      // archives it, so a repeated or doubled request can never become a second record.
      recordId: newRecordId(),
      urlRedacted: job.sourceUrl,
      templateVersion: (await snapshot.templateVersionOf(template)) || "",
      pluginVersion: chrome.runtime.getManifest().version,
      job: { company: job.company, title: job.title, sourceUrl: job.sourceUrl }
    };
    // The summary is built from exactly what would be sent, so the card cannot promise more.
    const summary = copy.describeFillOffer(fillrecords.buildFillPayload(pendingFill));
    card.querySelector("#resume-pro-fill-record-summary").textContent = summary;
    const option = card.querySelector("#resume-pro-fill-record-snapshot");
    if (option) {
      option.checked = true;
      option.disabled = !pendingFillTemplate;
    }
    card.hidden = false;
    offerPanelFillArchive(pendingFill, pendingFillTemplate, summary);
  }

  function closeFillRecord() {
    const card = shadowRoot?.querySelector("#resume-pro-fill-record");
    if (card) card.hidden = true;
    pendingFill = null;
    pendingFillTemplate = null;
    // Answered on the page overlay: the side panel's copy of the same offer goes too.
    if (panelFill?.phase === "offer") panelFill = idlePanelFill(panelFill);
  }

  async function handleRecordFillClick() {
    const raw = pendingFill;
    if (!raw) return;
    const withSnapshot = shadowRoot?.querySelector("#resume-pro-fill-record-snapshot")?.checked;
    const snapshotTemplate = withSnapshot ? pendingFillTemplate : null;
    closeFillRecord();

    let candidates = null;
    if (raw.job?.company) {
      try {
        candidates = await chrome.runtime.sendMessage({ type: "DESKTOP_CANDIDATES_FOR", fields: raw.job });
      } catch {
        candidates = null;
      }
    }
    if (candidates?.status !== "ok") {
      // The desktop is not answering, or the page does not say which company this is. The
      // fill waits, and the application is picked from the pending list later.
      await recordFill(raw, null, snapshotTemplate);
      return;
    }

    const options = [...candidates.exact, ...candidates.sameCompany];
    showFillCandidates(options, {
      note: options.length
        ? "这次填写属于哪条申请？"
        : "桌面里还没有这家公司的申请。可以先「保存岗位到桌面端」，或者稍后在待同步里选择。",
      onPick: applicationId => recordFill(raw, applicationId, snapshotTemplate),
      onLater: () => recordFill(raw, null, snapshotTemplate)
    });
  }

  async function recordFill(raw, applicationId, snapshotTemplate) {
    const { copy } = await loadDesktopModules();
    let result;
    try {
      result = await chrome.runtime.sendMessage({
        type: "DESKTOP_RECORD_FILL", raw, recordId: raw.recordId, applicationId, snapshotTemplate
      });
    } catch {
      result = { status: "rejected" };
    }
    setDesktopStatus(copy.describeFillRecordResult(result ?? { status: "rejected" }));
    revealDesktopStatus();
    refreshPendingList();
  }

  // The card sits under the fill result; the answer lands in the desktop section further
  // down. Bring it into view so the click does not look like it did nothing.
  function revealDesktopStatus() {
    shadowRoot?.querySelector("#resume-pro-desktop-status")?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }

  // The same candidate box saving a job uses. There is no "new application" here: a fill
  // belongs to an application that exists, and nothing is ever bound on the user's behalf.
  function showFillCandidates(options, { note, onPick, onLater }) {
    const box = shadowRoot?.querySelector("#resume-pro-candidates");
    const list = shadowRoot?.querySelector("#resume-pro-candidate-list");
    if (!box || !list) return;
    shadowRoot.querySelector("#resume-pro-candidates-note").textContent = note;
    list.textContent = "";
    for (const candidate of options) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "resume-pro__candidate";
      row.textContent = `${candidate.company} · ${candidate.title}${candidate.stage ? `（${candidate.stage}）` : ""}`;
      row.addEventListener("click", () => {
        box.hidden = true;
        onPick(candidate.applicationId);
      });
      list.appendChild(row);
    }
    shadowRoot.querySelector("#resume-pro-bind-new").hidden = true;
    shadowRoot.querySelector("#resume-pro-bind-later").onclick = () => {
      box.hidden = true;
      onLater();
    };
    box.hidden = false;
    box.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }

  // What the desktop shows as an application's id. Checked before binding: a mistyped id would
  // otherwise be queued and then refused on every attempt.
  const APPLICATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // A waiting record, bound from the pending list.
  async function chooseFillApplication(record) {
    const { copy } = await loadDesktopModules();
    if (!record.job?.company) {
      const typed = prompt("这条留档要记到哪条申请？请粘贴桌面里的申请 ID：")?.trim();
      if (!typed) return;
      if (!APPLICATION_ID_PATTERN.test(typed)) {
        setDesktopStatus(copy.describeFillRecordResult({ status: "rejected", reason: "invalid_application_id" }));
        return;
      }
      await bindFillRecord(record.recordId, typed);
      return;
    }
    let candidates;
    try {
      candidates = await chrome.runtime.sendMessage({ type: "DESKTOP_CANDIDATES_FOR", fields: record.job });
    } catch {
      candidates = null;
    }
    if (candidates?.status !== "ok") {
      setDesktopStatus(copy.describeFillRecordResult({ status: "recorded", mode: "unavailable" }));
      return;
    }
    const options = [...candidates.exact, ...candidates.sameCompany];
    showFillCandidates(options, {
      note: options.length ? "这次填写属于哪条申请？" : "桌面里还没有这家公司的申请，请先保存岗位。",
      onPick: applicationId => bindFillRecord(record.recordId, applicationId),
      onLater: () => {}
    });
  }

  async function bindFillRecord(recordId, applicationId) {
    const { copy } = await loadDesktopModules();
    let result;
    try {
      result = await chrome.runtime.sendMessage({ type: "DESKTOP_BIND_FILL", recordId, applicationId });
    } catch {
      result = { status: "pending" };
    }
    setDesktopStatus(copy.describeFillRecordResult(result ?? { status: "pending" }));
    revealDesktopStatus();
    refreshPendingList();
  }

  // --- Archiving a fill from the native side panel (#178) --------------------------------
  //
  //   offer -> querying -> choosing | empty | blocked -> saving
  //         -> saved | queued | pending_bind | failed | unknown      (or cancelled)
  //
  // The side panel draws every step from panelFillSnapshot() and answers with the messages
  // above (RESUME_PANEL_ARCHIVE_*). Nothing is written until the user picks an application
  // or explicitly asks to keep the fill waiting; cancelling writes and stages nothing. The
  // archive is bound to:
  //   - `archiveId`, the recordId minted when the fill was offered. The record, if any, gets
  //     this id, so a second request for the same fill is a duplicate (link/fillrecords.mjs);
  //   - a token that every cancel, re-query and new fill replaces, so an answer still on its
  //     way for an earlier question is dropped instead of reopening it;
  //   - this page load (`epoch`), so the panel never compares versions across a reload.
  // The candidates are the desktop's list for this fill's company; the panel can only pick
  // from it, and even a single candidate waits for the user. Page memory only.

  const PANEL_FILL_EPOCH = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const PANEL_FILL_OPEN = ["offer", "querying", "choosing", "empty", "blocked"];
  const PANEL_FILL_DONE = ["saved", "queued", "pending_bind", "failed", "unknown"];
  const PANEL_FILL_BLOCKED_MODES = new Set(["unavailable", "incompatible", "not_installed", "not_paired", "never_paired"]);
  const PANEL_FILL_ENDED = "这次填写的留档已经结束了。";
  let panelFillWaitMs = 30000;
  panelFill = idlePanelFill(null);

  function idlePanelFill(previous) {
    return {
      archiveId: null, phase: "idle", version: (previous?.version || 0) + 1, token: (previous?.token || 0) + 1,
      raw: null, template: null, summary: "", withSnapshot: false, candidates: [], reason: "",
      canQueue: false, result: null, application: null, snapshotId: null, recordKept: false, saving: ""
    };
  }

  function touchPanelFill(changes) {
    Object.assign(panelFill, changes, { version: panelFill.version + 1 });
  }

  // What the side panel may see: counts in the summary, labels and ids of the offered
  // applications, and the answer. Never the page's field values, and never the template.
  function panelFillSnapshot() {
    const job = panelFill || idlePanelFill(null);
    return {
      epoch: PANEL_FILL_EPOCH,
      archiveId: job.archiveId,
      phase: job.phase,
      version: job.version,
      summary: job.summary,
      snapshotAvailable: Boolean(job.template),
      withSnapshot: job.withSnapshot,
      saving: job.saving,
      reason: job.reason,
      canQueue: job.canQueue,
      candidates: job.candidates.map(candidate => ({ applicationId: candidate.applicationId, label: candidate.label })),
      result: job.result ? { ...job.result } : null,
      recordKept: job.recordKept,
      snapshotId: job.snapshotId
    };
  }

  const panelFillOutcome = (extra = {}) => ({ ...extra, fillArchive: panelFillSnapshot() });

  // A new finished fill replaces whatever question the previous one left open. A write that
  // is already on its way keeps going; its answer is dropped by the token and lands in the
  // pending list instead.
  function offerPanelFillArchive(raw, template, summary) {
    panelFill = idlePanelFill(panelFill);
    touchPanelFill({ archiveId: raw.recordId, phase: "offer", raw, template, summary, withSnapshot: Boolean(template) });
  }

  function panelFillMatches(archiveId) {
    return Boolean(archiveId) && archiveId === panelFill?.archiveId;
  }

  async function waitForPanelFill(promise, fallback) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise(resolve => { timer = setTimeout(() => resolve(fallback), panelFillWaitMs); })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function startPanelFillArchive(message) {
    if (!panelFillMatches(message.archiveId)) return panelFillOutcome({ ok: false, error: PANEL_FILL_ENDED });
    // A second click while the first is looking: the same question, not a second one.
    if (panelFill.phase !== "offer") return panelFillOutcome({ ok: panelFill.phase !== "idle" && panelFill.phase !== "cancelled" });
    // The side panel owns this fill now; the page overlay's copy of the offer goes away so
    // the two can never both send it.
    const card = shadowRoot?.querySelector("#resume-pro-fill-record");
    if (card) card.hidden = true;
    pendingFill = null;
    pendingFillTemplate = null;
    // Decided now, with the offer on screen: the template copy leaves only if this was ticked.
    touchPanelFill({ withSnapshot: Boolean(panelFill.template) && message.withSnapshot !== false });
    return queryPanelFillCandidates();
  }

  async function requeryPanelFillArchive(message) {
    if (!panelFillMatches(message.archiveId)) return panelFillOutcome({ ok: false, error: PANEL_FILL_ENDED });
    if (panelFill.phase === "querying") return panelFillOutcome({ ok: true });
    if (!["empty", "blocked", "choosing"].includes(panelFill.phase)) {
      return panelFillOutcome({ ok: false, error: "现在不能重新查找。" });
    }
    return queryPanelFillCandidates();
  }

  async function queryPanelFillCandidates() {
    // A new token: an earlier lookup's answer belongs to a question nobody is asking now.
    touchPanelFill({ phase: "querying", token: panelFill.token + 1, candidates: [], reason: "", canQueue: false, result: null });
    const token = panelFill.token;
    const isCurrent = () => panelFill.token === token && panelFill.phase === "querying";
    const job = panelFill.raw?.job || {};
    try {
      const { copy } = await loadDesktopModules();
      if (!isCurrent()) return panelFillOutcome({ ok: true });
      if (!job.company) {
        // Nothing to look up. Not an empty list either: that would suggest the desktop has
        // no application for a company the page never named.
        const blocked = copy.describeFillArchiveBlocked("unrecognized");
        touchPanelFill({ phase: "blocked", reason: "unrecognized", canQueue: blocked.canQueue, result: blocked });
        return panelFillOutcome({ ok: true });
      }
      const asked = { company: job.company, title: job.title || "", sourceUrl: job.sourceUrl || "" };
      let answer;
      try {
        answer = await waitForPanelFill(chrome.runtime.sendMessage({ type: "DESKTOP_CANDIDATES_FOR", fields: asked }), null);
      } catch {
        answer = null;
      }
      if (!isCurrent()) return panelFillOutcome({ ok: true });
      if (answer?.status !== "ok") {
        // No answer is not "no candidates": an empty list would push the user towards saving
        // a job the desktop may already have.
        const reason = PANEL_FILL_BLOCKED_MODES.has(answer?.status) ? answer.status : "unavailable";
        const blocked = copy.describeFillArchiveBlocked(reason, { extensionId: chrome.runtime.id });
        touchPanelFill({ phase: "blocked", reason, canQueue: blocked.canQueue, result: blocked });
        return panelFillOutcome({ ok: true });
      }
      const seen = new Set();
      const options = [...(answer.exact || []), ...(answer.sameCompany || [])].filter(candidate => {
        if (!candidate || typeof candidate.applicationId !== "string" || !candidate.applicationId) return false;
        if (typeof candidate.company !== "string" || typeof candidate.title !== "string") return false;
        if (seen.has(candidate.applicationId)) return false;
        seen.add(candidate.applicationId);
        return true;
      }).map(candidate => ({
        applicationId: candidate.applicationId, company: candidate.company, title: candidate.title,
        label: copy.describeApplicationChoice(candidate)
      }));
      if (options.length) {
        // Even one candidate waits for the user: the plugin never picks an application.
        touchPanelFill({ phase: "choosing", candidates: options });
      } else {
        touchPanelFill({ phase: "empty", reason: "no-record", result: copy.describeFillArchiveEmpty() });
      }
    } catch {
      if (isCurrent()) {
        touchPanelFill({
          phase: "blocked", reason: "unavailable", canQueue: true,
          result: { tone: "warn", text: "没能查到对应的投递记录。", hint: "可以稍后重新查找，或者先记入待同步。现在还没有留档到桌面。" }
        });
      }
    }
    return panelFillOutcome({ ok: true });
  }

  async function choosePanelFillArchive(message) {
    if (!panelFillMatches(message.archiveId)) return panelFillOutcome({ ok: false, error: PANEL_FILL_ENDED });
    // Claimed synchronously below, so a second click can never send a second record.
    if (panelFill.phase === "saving") return panelFillOutcome({ ok: false, error: "正在留档，请稍候。" });
    if (panelFill.phase !== "choosing") return panelFillOutcome({ ok: false, error: "这个选择已经失效了。" });
    const candidate = panelFill.candidates.find(item => item.applicationId === message.applicationId);
    if (!candidate) return panelFillOutcome({ ok: false, error: "请选择列表里的申请。" });
    return recordPanelFill(candidate);
  }

  // "稍后处理" / "稍后在待同步中选择" / "记入待同步": one waiting record, no application.
  async function laterPanelFillArchive(message) {
    if (!panelFillMatches(message.archiveId)) return panelFillOutcome({ ok: false, error: PANEL_FILL_ENDED });
    if (panelFill.phase === "saving") return panelFillOutcome({ ok: false, error: "正在处理，请稍候。" });
    const allowed = panelFill.phase === "choosing" || panelFill.phase === "empty"
      || (panelFill.phase === "blocked" && panelFill.canQueue);
    if (!allowed) return panelFillOutcome({ ok: false, error: "现在不能记入待同步。" });
    return recordPanelFill(null);
  }

  async function recordPanelFill(candidate) {
    const token = panelFill.token;
    const archiveId = panelFill.archiveId;
    const raw = panelFill.raw;
    const snapshotTemplate = panelFill.withSnapshot ? panelFill.template : null;
    const application = candidate ? { company: candidate.company, title: candidate.title } : null;
    touchPanelFill({ phase: "saving", saving: candidate ? "bind" : "later", application, result: null });
    let result;
    try {
      result = await waitForPanelFill(chrome.runtime.sendMessage({
        type: "DESKTOP_RECORD_FILL", raw, recordId: archiveId,
        applicationId: candidate ? candidate.applicationId : null, snapshotTemplate
      }), { status: "unknown" });
    } catch {
      // The request may have reached the worker before the port failed: not a failure to retry.
      result = { status: "unknown" };
    }
    refreshPendingList();
    if (panelFill.token !== token || panelFill.archiveId !== archiveId) {
      return panelFillOutcome({ ok: false, expired: true, error: "这次留档的结果已经过期，请在「待同步」里核对。" });
    }
    let phase;
    let described;
    try {
      const { copy } = await loadDesktopModules();
      const status = result?.status;
      if (!status || status === "unknown" || result?.error) {
        phase = "unknown";
        described = { tone: "pending", text: copy.FILL_ARCHIVE_UNKNOWN };
      } else if (status === "saved" || (status === "duplicate" && result.receipt?.outcome === "saved")) {
        // Only a persisted reply gets here, and only this names the application.
        phase = "saved";
        described = copy.describeFillRecordResult(result, { application: status === "saved" ? application : null, uploadShownSeparately: true });
      } else if (status === "recorded" || (status === "duplicate" && result.record?.status === "pending_bind")) {
        phase = "pending_bind";
        described = copy.describeFillRecordResult({ ...result, status: "recorded" });
      } else if (status === "duplicate" && result.receipt?.outcome === "discarded") {
        phase = "failed";
        described = copy.describeFillRecordResult(result);
      } else if (status === "pending" || status === "stalled" || status === "duplicate") {
        phase = "queued";
        described = copy.describeFillRecordResult(status === "stalled" ? { ...result, status: "pending" } : result);
      } else {
        phase = "failed";
        described = copy.describeFillRecordResult(result);
      }
    } catch {
      phase = "unknown";
      described = { tone: "pending", text: "没能确认留档结果，请到「待同步」或桌面端核对后再操作。" };
    }
    touchPanelFill({
      phase, saving: "", result: described, raw: null, template: null,
      // Where the record is now, so the panel can offer the pending list only when it exists.
      recordKept: phase === "pending_bind" || phase === "queued" || phase === "unknown" || Boolean(result?.record),
      snapshotId: phase === "saved" && result?.uploadQueued ? result.record?.snapshot?.snapshotId || null : null
    });
    return panelFillOutcome({ ok: true });
  }

  // Deleting the waiting record just made, from the answer card. Only a record that is still
  // waiting can go (removeWaiting); one already sent is left alone.
  async function removePanelFillArchive(message) {
    if (!panelFillMatches(message.archiveId)) return panelFillOutcome({ ok: false, error: PANEL_FILL_ENDED });
    if (panelFill.phase !== "pending_bind") return panelFillOutcome({ ok: false, error: "这条记录现在不能删除。" });
    const token = panelFill.token;
    let reply;
    try {
      reply = await chrome.runtime.sendMessage({ type: "DESKTOP_REMOVE_FILL", recordId: panelFill.archiveId });
    } catch {
      reply = null;
    }
    refreshPendingList();
    if (!reply?.ok) {
      return panelFillOutcome({ ok: false, error: "这条记录已经不在待同步里了，可能已经处理过。" });
    }
    if (panelFill.token === token) panelFill = idlePanelFill(panelFill);
    return panelFillOutcome({ ok: true, removed: true });
  }

  // "不留档" on the offer, "取消留档" on a question, or "知道了" on an answer.
  function cancelPanelFillArchive({ archiveId }) {
    if (!panelFillMatches(archiveId)) return panelFillOutcome({ ok: false, error: PANEL_FILL_ENDED });
    if (panelFill.phase === "saving") {
      return panelFillOutcome({ ok: false, error: "已经在留档了，无法取消。请在「待同步」里核对。" });
    }
    if (PANEL_FILL_OPEN.includes(panelFill.phase)) {
      // Nothing was created and nothing staged. The page overlay's copy goes too.
      const card = shadowRoot?.querySelector("#resume-pro-fill-record");
      if (card) card.hidden = true;
      pendingFill = null;
      pendingFillTemplate = null;
      panelFill = idlePanelFill(panelFill);
      // Kept, so a lookup answer still on its way is recognised as belonging to a closed one.
      touchPanelFill({ archiveId, phase: "cancelled" });
      return panelFillOutcome({ ok: true, cancelled: true });
    }
    if (PANEL_FILL_DONE.includes(panelFill.phase) || panelFill.phase === "cancelled") {
      panelFill = idlePanelFill(panelFill);
      return panelFillOutcome({ ok: true });
    }
    return panelFillOutcome({ ok: false, error: PANEL_FILL_ENDED });
  }

  function closeSaveForm() {
    const form = shadowRoot?.querySelector("#resume-pro-save-form");
    if (form) form.hidden = true;
    hideJobAssist();
    pendingFields = null;
    assistFallback = null;
  }

  async function submitSaveForm({ force, fields: retryFields = null }) {
    const form = shadowRoot?.querySelector("#resume-pro-save-form");
    if (!form || saveInFlight || extractInFlight) return;

    // "再存一次" resends what was confirmed. By then the form may be closed and
    // pendingFields cleared, so reading them again would drop the redacted URLs.
    const fields = retryFields || {
      company: form.querySelector("#resume-pro-save-company").value.trim(),
      title: form.querySelector("#resume-pro-save-title").value.trim(),
      location: form.querySelector("#resume-pro-save-location").value.trim(),
      // The URL is whatever redaction produced when the form opened. It is not editable and
      // is never re-read from the address bar here, so no un-redacted URL can reach storage.
      sourceUrl: pendingFields?.sourceUrl || "",
      dedupeUrl: pendingFields?.dedupeUrl || ""
    };
    lastSubmittedFields = fields;
    saveInFlight = true;
    try {
      await commitSave(fields, { force });
    } finally {
      saveInFlight = false;
    }
  }

  // The click, the corrected form and "完成保存" all end here. A live desktop with no exact
  // duplicate is written in this call. Same-company other jobs are not a second question.
  async function commitSave(fields, { force }) {
    const { copy } = await loadDesktopModules();
    presentSaveResult(copy, await saveReviewedJob(fields, { force }));
  }

  // Step two of saving a job, shared by the page form and the native side panel: write what
  // the user confirmed through the existing worker path (duplicate check, offline queue).
  // The URLs always come from the draft's local redaction, never from the caller's edits.
  function reviewedJobFields(draftFields, edited = {}) {
    const text = value => typeof value === "string" ? value.trim() : "";
    return {
      company: text(edited.company),
      title: text(edited.title),
      // Location is shown beside company and title and is part of the user's confirmation.
      location: text(edited.location),
      sourceUrl: typeof draftFields?.sourceUrl === "string" ? draftFields.sourceUrl : "",
      dedupeUrl: typeof draftFields?.dedupeUrl === "string" ? draftFields.dedupeUrl : ""
    };
  }

  async function saveReviewedJob(fields, { force }) {
    try {
      return (await chrome.runtime.sendMessage({ type: "DESKTOP_SAVE_JOB", fields, force: Boolean(force) })) ?? { status: "error" };
    } catch {
      return { status: "error" };
    }
  }

  async function bindSavedJob(intentId, applicationId) {
    try {
      return (await chrome.runtime.sendMessage({ type: "DESKTOP_BIND", intentId, applicationId })) ?? { status: "unknown" };
    } catch {
      // A missing response is not proof that the background queued the bind. Callers keep the
      // existing intent available for recovery, but must not promise an automatic retry.
      return { status: "unknown" };
    }
  }

  // Outcomes after which the job is no longer the form's business: it was written, queued,
  // or is waiting in the pending list. Anything else leaves the form open to try again.
  function saveResultClosesForm(result) {
    const status = result?.status;
    return status === "saved" || status === "pending" || status === "queued" || status === "duplicate"
      || (status === "rejected" && result.reason === "queue_full" && Boolean(result.intent))
      || (status === "failed" && Boolean(result.intent));
  }

  async function continueIntent(intentId) {
    const { copy } = await loadDesktopModules();
    let result;
    try {
      result = await chrome.runtime.sendMessage({ type: "DESKTOP_CONTINUE_SAVE", intentId });
    } catch (error) {
      result = { status: "error" };
    }
    presentSaveResult(copy, result);
  }

  function presentSaveResult(copy, result) {
    if (result?.status === "needs_choice") {
      closeSaveForm();
      showExactChoice(result.intent.intentId, result.exact || []);
      refreshPendingList();
      return;
    }
    setDesktopStatus(describeCommit(copy, result ?? { status: "error" }));
    if (saveResultClosesForm(result)) {
      closeSaveForm();
    }
    refreshPendingList();
  }

  function describeCommit(copy, result) {
    if (result?.status === "saved" || result?.status === "pending" || result?.status === "failed") {
      return copy.describeBindResult(result);
    }
    if (result?.status === "duplicate" && result?.reason === "already_queued") {
      return copy.describeBindResult(result);
    }
    if (result?.status === "rejected" && ["unknown_intent", "no_identity", "awaiting_reconcile", "not_paused"].includes(result.reason)) {
      return copy.describeBindResult(result);
    }
    if (result?.status === "rejected" && result.reason === "queue_full" && result.intent) {
      return copy.describeBindResult(result);
    }
    return copy.describeSaveResult(result);
  }

  // Exact duplicate only. Another title at the same company never reaches this box.
  function showExactChoice(intentId, exact) {
    const box = shadowRoot?.querySelector("#resume-pro-candidates");
    const list = shadowRoot?.querySelector("#resume-pro-candidate-list");
    if (!box || !list) return;
    list.textContent = "";
    shadowRoot.querySelector("#resume-pro-candidates-note").textContent =
      "这可能是同一个岗位。要使用已有申请，还是新建一条？";
    for (const candidate of exact) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "resume-pro__candidate";
      row.textContent = `使用已有：${candidate.company} · ${candidate.title}${candidate.stage ? `（${candidate.stage}）` : ""}`;
      row.addEventListener("click", () => bindIntent(intentId, candidate.applicationId));
      list.appendChild(row);
    }
    box.hidden = false;
    const bindNew = shadowRoot.querySelector("#resume-pro-bind-new");
    bindNew.hidden = false;
    bindNew.onclick = () => bindIntent(intentId, null);
    shadowRoot.querySelector("#resume-pro-bind-later").onclick = () => {
      box.hidden = true;
      setDesktopStatus({ tone: "pending", text: "已记下，尚未写入桌面。可以稍后在待同步里完成保存。" });
    };
  }

  async function bindIntent(intentId, applicationId) {
    const { copy } = await loadDesktopModules();
    const result = await bindSavedJob(intentId, applicationId);

    const box = shadowRoot?.querySelector("#resume-pro-candidates");
    if (box) box.hidden = true;
    setDesktopStatus(copy.describeBindResult(result));
    refreshPendingList();
  }

  // --- Saving a job from the native side panel (#172) -----------------------------------
  //
  // The same two steps the page form uses, driven by explicit messages instead of page
  // clicks: RESUME_PANEL_SAVE_DRAFT reads the page (and asks the desktop's AI only when the
  // page is unclear), RESUME_PANEL_SAVE_CONFIRM writes what the user reviewed, and
  // RESUME_PANEL_SAVE_CANCEL / RESUME_PANEL_SAVE_CHOICE end it. The draft lives in this
  // page's memory only; nothing about it is written to extension storage.

  const PANEL_JOB_LATER = "已记下，尚未写入桌面。可以稍后在待同步里完成保存。";
  // Shown when the write was sent but its outcome could not be worked out; never "saved".
  const PANEL_JOB_UNKNOWN = {
    tone: "pending",
    // Kept equal to copy.UNKNOWN_SAVE_TEXT (the page overlay's wording); a test holds them together.
    text: "没能确认保存结果，请到桌面或待同步列表核对后再操作。"
  };
  const PANEL_JOB_STALE = "网页已经换成别的页面，刚才的岗位内容已作废。请重新点「保存岗位到桌面端」。";
  const PANEL_JOB_EXPIRED = "这次保存的页面已经变化或已被取消，结果已过期。请到桌面端确认这个岗位是否已保存。";
  let panelJobWriteTimeoutMs = 30000;

  async function waitForPanelJobWrite(promise) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise(resolve => {
          timer = setTimeout(() => resolve({ status: "unknown" }), panelJobWriteTimeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Cancelling is best effort: a worker that is not there has nothing to cancel.
  function cancelAiRequest(requestId) {
    if (!requestId) return;
    try { Promise.resolve(self.ResumeProAIClient?.cancel?.(requestId)).catch(() => {}); } catch {}
  }
  let panelJob = idlePanelJob(null);

  // Every reset takes a new token, so an answer still on its way for the old draft is dropped.
  function idlePanelJob(previous) {
    return {
      draftId: null, phase: "idle", version: (previous?.version || 0) + 1, token: (previous?.token || 0) + 1,
      fields: null, revision: 0, note: "", openView: null, error: "", assist: null, requestId: null,
      fallback: null, confirmed: null, intentId: null, candidates: [], result: null,
      pageUrl: "", discarded: null
    };
  }

  function touchPanelJob(changes) {
    Object.assign(panelJob, changes, { version: panelJob.version + 1 });
  }

  // What the side panel may see. The dedupe URL and the pending intent id stay in the page.
  function panelJobSnapshot() {
    const job = panelJob;
    return {
      draftId: job.draftId,
      phase: job.phase,
      version: job.version,
      revision: job.revision,
      fields: job.fields ? {
        company: job.fields.company || "", title: job.fields.title || "",
        location: job.fields.location || "", sourceUrl: job.fields.sourceUrl || ""
      } : null,
      note: job.note,
      openView: job.openView,
      error: job.error,
      assist: job.assist ? { count: job.assist.lines.length, text: job.assist.text, lines: [...job.assist.lines] } : null,
      candidates: job.candidates.map(candidate => ({
        applicationId: candidate.applicationId,
        label: candidate.label || `${candidate.company} · ${candidate.title}`
      })),
      result: job.result ? { ...job.result } : null,
      discarded: job.discarded
    };
  }

  // A single-page site can swap the job under an open draft without reloading the page. The
  // draft belongs to the address it was read from; once that changes it is thrown away, so
  // the panel can never save the old company and title for the new page.
  function dropStalePanelJob() {
    if (!panelJob.draftId || panelJob.pageUrl === location.href) return false;
    // A completed result is a fact about the write that already happened. Keep that fact on
    // screen after navigation, but an old duplicate warning must not offer "save again" for
    // the previous page.
    if (panelJob.phase === "result") {
      if (panelJob.result?.offerForce) {
        touchPanelJob({
          result: {
            ...panelJob.result,
            offerForce: false,
            hint: "网页已经切换；上面的结果仍然有效，但不能为上一页的岗位再存一次。"
          }
        });
      }
      return false;
    }
    const open = ["extracting", "assist", "review", "choice"].includes(panelJob.phase);
    if (!open) return false;
    cancelAiRequest(panelJob.requestId);
    panelJob = idlePanelJob(panelJob);
    panelJob.discarded = "page-changed";
    if (jobTrace) jobTrace.end = "navigated";
    return true;
  }

  // `sources`（#301 [岗位]）：这份表单的公司、岗位从哪来；不给就沿用之前记下的。
  function openPanelReview(fields, note, openView = null, sources = {}) {
    touchPanelJob({
      phase: "review", fields: { ...emptyJobFields(), ...fields }, revision: panelJob.revision + 1,
      note, openView, error: "", assist: null, requestId: null
    });
    traceJobFields(jobTrace, fields, sources);
    if (jobTrace) jobTrace.end = "open";
  }

  async function startPanelJobDraft() {
    dropStalePanelJob();
    if (panelJob.draftId && panelJob.phase !== "idle" && panelJob.phase !== "result") return panelJobSnapshot();
    // The two questions are never open together (§172): "确认已投递" owns the area until the
    // user finishes it. `savePanelSubmitJob` clears its own phase to "cancelled" before
    // calling here, so that hand-off is not blocked by this guard.
    if (panelSubmitIsActive()) return panelJobSnapshot();
    panelJob = idlePanelJob(panelJob);
    const token = panelJob.token;
    const pageUrl = location.href;
    touchPanelJob({ draftId: newRequestId(), phase: "extracting", pageUrl });
    const trace = jobTrace = newJobTrace();
    const isCurrent = () => panelJob.token === token && panelJob.pageUrl === pageUrl && location.href === pageUrl;
    try {
      const draft = await draftJobFields({
        isCurrent,
        trace,
        onAssistStart: (described, requestId, fallback) => {
          if (!isCurrent()) return;
          touchPanelJob({
            phase: "assist", requestId, fallback,
            assist: { text: described.text, lines: [...(described.fragments || [])] }
          });
        },
        onAssistEnd: requestId => {
          if (isCurrent() && panelJob.requestId === requestId) touchPanelJob({ requestId: null });
        }
      });
      if (draft && isCurrent()) {
        openPanelReview(draft.fields, draft.note, draft.openView);
      } else if (panelJob.token === token && location.href !== pageUrl) {
        dropStalePanelJob();
      }
    } catch {
      if (isCurrent()) {
        openPanelReview(emptyJobFields(), "读取页面信息失败，请手动填写公司和岗位。", null, { company: "none", title: "none" });
      } else if (panelJob.token === token && location.href !== pageUrl) {
        dropStalePanelJob();
      }
    }
    return panelJobSnapshot();
  }

  async function cancelPanelJob({ draftId, scope }) {
    if (!draftId || draftId !== panelJob.draftId) return { ok: false, error: "这次保存已经结束了。", jobSave: panelJobSnapshot() };
    if (panelJob.phase === "saving") return { ok: false, error: "已经在写入桌面，无法取消。", jobSave: panelJobSnapshot() };
    cancelAiRequest(panelJob.requestId);
    if (scope === "assist") {
      if (panelJob.phase !== "assist" && panelJob.phase !== "extracting") {
        return { ok: false, error: "识别已经结束了。", jobSave: panelJobSnapshot() };
      }
      // A new token: whatever the AI says later belongs to a recognition nobody is waiting for.
      const fallback = panelJob.fallback || emptyJobFields();
      touchPanelJob({ token: panelJob.token + 1 });
      if (jobTrace?.aiCalled) jobTrace.aiCode = "cancelled";
      let note = "已取消识别。请手动补全后再保存。";
      try { note = (await loadDesktopModules()).copy.describeManualSave("cancelled"); } catch {}
      openPanelReview(fallback, note);
      return { ok: true, jobSave: panelJobSnapshot() };
    }
    // Cancelling the draft itself: nothing was written, and nothing will be. Dismissing a
    // finished result is not a cancel.
    if (jobTrace && ["extracting", "assist", "review", "choice"].includes(panelJob.phase)) jobTrace.end = "cancelled";
    panelJob = idlePanelJob(panelJob);
    return { ok: true, jobSave: panelJobSnapshot() };
  }

  async function confirmPanelJob(message) {
    if (!message.draftId || message.draftId !== panelJob.draftId) {
      return { ok: false, error: "这份岗位草稿已经失效，请重新点「保存岗位到桌面端」。", jobSave: panelJobSnapshot() };
    }
    if (dropStalePanelJob()) return { ok: false, error: PANEL_JOB_STALE, jobSave: panelJobSnapshot() };
    if (panelJob.phase === "saving" || saveInFlight) return { ok: false, error: "正在保存，请稍候。", jobSave: panelJobSnapshot() };
    // "再存一次" after a duplicate resends exactly what was confirmed; anything else needs the form.
    const again = message.force === true && panelJob.phase === "result" && panelJob.result?.offerForce && panelJob.confirmed;
    if (!again && panelJob.phase !== "review") return { ok: false, error: "请先核对岗位信息。", jobSave: panelJobSnapshot() };

    const fields = again ? panelJob.confirmed : reviewedJobFields(panelJob.fields, message);
    traceJobFields(jobTrace, fields);
    if (!again) {
      const missing = [!fields.company && "公司名称", !fields.title && "岗位名称"].filter(Boolean);
      if (missing.length) {
        const error = `请补全${missing.join("和")}后再保存。`;
        touchPanelJob({
          error,
          fields: { ...panelJob.fields, company: fields.company, title: fields.title, location: fields.location }
        });
        return { ok: false, error, missing, jobSave: panelJobSnapshot() };
      }
    }
    // Claimed before the first await, so a second click cannot send a second write.
    const token = panelJob.token;
    saveInFlight = true;
    touchPanelJob({
      phase: "saving", confirmed: fields, error: "",
      fields: { ...panelJob.fields, company: fields.company, title: fields.title, location: fields.location }
    });
    let result = null;
    let failed = false;
    try {
      // Only "save again" after a duplicate warning may skip the duplicate check; a "force"
      // sent with an ordinary confirm is ignored.
      result = await waitForPanelJobWrite(saveReviewedJob(fields, { force: Boolean(again) }));
    } catch {
      failed = true;
    } finally {
      saveInFlight = false;
    }
    if (panelJob.token !== token) {
      refreshPendingList();
      return { ok: false, expired: true, error: PANEL_JOB_EXPIRED, jobSave: panelJobSnapshot() };
    }
    // Whatever goes wrong from here on, the phase must leave "saving": the desktop may
    // already hold the job, so the panel says it could not tell rather than stay locked.
    // [岗位] (#301) keeps how this write ended: needs_choice is still open, a refused write "failed".
    const trace = jobTrace;
    const end = value => { if (trace) trace.end = value; };
    try {
      if (failed) throw new Error("save-failed");
      if (result?.status === "unknown") {
        touchPanelJob({ phase: "result", candidates: [], error: "", result: { ...PANEL_JOB_UNKNOWN } });
        end("unknown");
      } else {
        const { copy } = await loadDesktopModules();
        if (result?.status === "needs_choice") {
        // The desktop sends its stage code ("saved"); the label uses the same Chinese name
        // "确认已投递" shows, so the two lists never read differently for one application.
        const candidates = (result.exact || []).map(candidate => ({ ...candidate, label: copy.describeApplicationChoice(candidate) }));
        touchPanelJob({ phase: "choice", intentId: result.intent?.intentId || null, candidates, result: null });
        end("open");
        } else if (saveResultClosesForm(result) || result?.status === "not_queued") {
          // Written, queued, or a clear "no desktop / not paired" answer the user has to act on.
          touchPanelJob({ phase: "result", result: describeCommit(copy, result) });
          end(jobWriteEnd(result?.status));
        } else {
          // Not written and not queued: keep the reviewed form so the user can try again.
          touchPanelJob({ phase: "review", error: describeCommit(copy, result).text, result: null });
          end("failed");
        }
      }
    } catch {
      if (panelJob.token === token) {
        touchPanelJob({ phase: "result", candidates: [], error: "", result: { ...PANEL_JOB_UNKNOWN } });
        end("unknown");
      }
    }
    refreshPendingList();
    return { ok: true, jobSave: panelJobSnapshot() };
  }

  // "AI 重新识别": the local read looked fine but the user says it is wrong. Same AI step as
  // the first recognition, same progress and cancel. What the user has typed is the
  // fallback: a failed, cancelled or unsure AI leaves it exactly as it was, and nothing is
  // saved until the user confirms again.
  async function reassistPanelJob(message) {
    if (!message.draftId || message.draftId !== panelJob.draftId) {
      return { ok: false, error: "这份岗位草稿已经失效，请重新点「保存岗位到桌面端」。", jobSave: panelJobSnapshot() };
    }
    if (dropStalePanelJob()) return { ok: false, error: PANEL_JOB_STALE, jobSave: panelJobSnapshot() };
    if (panelJob.phase !== "review" || saveInFlight) {
      return { ok: false, error: "现在不能重新识别，请稍后再试。", jobSave: panelJobSnapshot() };
    }
    const pageUrl = panelJob.pageUrl;
    let modules;
    try {
      modules = await loadDesktopModules();
    } catch {
      return { ok: false, error: "暂时无法重新识别，请稍后再试。", jobSave: panelJobSnapshot() };
    }
    if (message.draftId !== panelJob.draftId || panelJob.phase !== "review") {
      return { ok: false, error: "这份岗位草稿已经变化，请重新操作。", jobSave: panelJobSnapshot() };
    }
    if (panelJob.pageUrl !== pageUrl || location.href !== pageUrl) {
      dropStalePanelJob();
      return { ok: false, error: PANEL_JOB_STALE, jobSave: panelJobSnapshot() };
    }
    const { extract, saveFlow, copy } = modules;
    const extraction = extract.extractJobFields(document, location.href);
    const fragments = saveFlow.allowFragments(extraction.fragments);
    if (!fragments.length) {
      const error = "这个页面没有可交给 AI 识别的岗位文字，请直接修改后保存。";
      touchPanelJob({ error });
      return { ok: false, error, jobSave: panelJobSnapshot() };
    }
    const typed = reviewedJobFields(panelJob.fields, message);
    const fallback = {
      company: typed.company, title: typed.title, location: typed.location,
      sourceUrl: typeof extraction.sourceUrl === "string" ? extraction.sourceUrl : typed.sourceUrl,
      dedupeUrl: typeof extraction.dedupeUrl === "string" ? extraction.dedupeUrl : typed.dedupeUrl
    };
    // A new token: an answer to an earlier recognition of this draft is dropped.
    touchPanelJob({
      token: panelJob.token + 1, phase: "assist", fields: { ...fallback }, fallback, error: "", note: "",
      openView: null, requestId: null, assist: { text: "", lines: [] }, pageUrl
    });
    const token = panelJob.token;
    const isCurrent = () => panelJob.token === token && panelJob.pageUrl === pageUrl && location.href === pageUrl;
    if (!jobTrace) jobTrace = newJobTrace();
    try {
      const outcome = await runJobAssist(fragments, fallback, {
        isCurrent,
        trace: jobTrace,
        onAssistStart: (described, requestId, fb) => {
          if (!isCurrent()) return;
          touchPanelJob({ requestId, fallback: fb, assist: { text: described.text, lines: [...(described.fragments || [])] } });
        },
        onAssistEnd: requestId => {
          if (isCurrent() && panelJob.requestId === requestId) touchPanelJob({ requestId: null });
        }
      });
      if (!isCurrent() || outcome.action === "ignore") {
        if (panelJob.token === token && location.href !== pageUrl) {
          dropStalePanelJob();
          return { ok: false, error: PANEL_JOB_STALE, jobSave: panelJobSnapshot() };
        }
        return { ok: true, jobSave: panelJobSnapshot() };
      }
      if (outcome.action === "commit") {
        openPanelReview(outcome.fields, copy.describeReviewSave(), null, jobSources(outcome.fields, extraction, outcome.aiFields, fragments));
      } else {
        // Not sure, failed or timed out: keep what the user has, only filling what is blank.
        const suggested = outcome.fields || {};
        const kept = {
          company: fallback.company || suggested.company || "",
          title: fallback.title || suggested.title || "",
          location: fallback.location || suggested.location || "",
          sourceUrl: fallback.sourceUrl, dedupeUrl: fallback.dedupeUrl
        };
        openPanelReview(kept, outcome.note, outcome.openView || null, jobSources(kept, extraction, outcome.aiFields, fragments));
      }
    } catch {
      if (isCurrent()) openPanelReview(fallback, "重新识别没有完成，已保留你现在的内容，可以手动修改后保存。");
    }
    return { ok: true, jobSave: panelJobSnapshot() };
  }

  async function choosePanelJob(message) {
    if (message.draftId && message.draftId === panelJob.draftId && dropStalePanelJob()) {
      return { ok: false, error: PANEL_JOB_STALE, jobSave: panelJobSnapshot() };
    }
    if (!message.draftId || message.draftId !== panelJob.draftId || panelJob.phase !== "choice") {
      return { ok: false, error: "这个选择已经失效了。", jobSave: panelJobSnapshot() };
    }
    if (saveInFlight) return { ok: false, error: "正在保存，请稍候。", jobSave: panelJobSnapshot() };
    const action = String(message.action || "");
    if (action === "later") {
      touchPanelJob({ phase: "result", candidates: [], result: { tone: "pending", text: PANEL_JOB_LATER } });
      if (jobTrace) jobTrace.end = "queued";
      return { ok: true, jobSave: panelJobSnapshot() };
    }
    let applicationId = null;
    if (action === "existing") {
      applicationId = panelJob.candidates.find(candidate => candidate.applicationId === message.applicationId)?.applicationId || null;
      if (!applicationId) return { ok: false, error: "请选择列表里的已有岗位。", jobSave: panelJobSnapshot() };
    } else if (action !== "new") {
      return { ok: false, error: "当前操作不可用。", jobSave: panelJobSnapshot() };
    }
    const token = panelJob.token;
    const trace = jobTrace;
    saveInFlight = true;
    touchPanelJob({ phase: "saving" });
    let bound;
    let end = "unknown";
    try {
      const result = await waitForPanelJobWrite(bindSavedJob(panelJob.intentId, applicationId));
      if (panelJob.token !== token) {
        refreshPendingList();
        return { ok: false, expired: true, error: PANEL_JOB_EXPIRED, jobSave: panelJobSnapshot() };
      }
      bound = result?.status === "unknown"
        ? { ...PANEL_JOB_UNKNOWN }
        : (await loadDesktopModules()).copy.describeBindResult(result);
      end = jobWriteEnd(result?.status);
    } catch {
      bound = { ...PANEL_JOB_UNKNOWN };
    } finally {
      saveInFlight = false;
    }
    if (panelJob.token === token) {
      touchPanelJob({ phase: "result", candidates: [], result: bound });
      if (trace) trace.end = end;
    }
    refreshPendingList();
    return { ok: true, jobSave: panelJobSnapshot() };
  }

  // --- Confirming a submission from the native side panel (#172) -------------------------
  //
  // "确认已投递" only moves an application's stage on the desktop: the user says they already
  // applied on the job site. Nothing here clicks, submits or listens to the site's controls.
  //
  //   idle -> extracting -> assist -> review -> querying -> choosing -> confirming
  //        -> confirmed | empty | unavailable | unknown | failed | cancelled
  //
  // Step one (extracting/assist) only reads the page and, when it is unsure, asks the
  // desktop's AI — exactly draftJobFields(), the same step "保存岗位到桌面端" uses. It always
  // lands on an editable review; nothing is queried yet, so a wrong local read ("公安" instead
  // of "金发科技") is never sent to the desktop. Only "查找对应申请" (querying) leaves the page,
  // and only with what the user confirmed on the review form.
  //
  // The state is this page's (one page controller per tab) and is bound to the address it
  // was started on, a token that any cancel, restart or page change replaces, and the list of
  // candidates the desktop offered. The panel can only pick from that list.

  const SUBMIT_STALE = "网页已经换成别的页面，刚才核对的内容已作废。请重新点「确认已投递」。";
  const SUBMIT_EMPTY = "桌面里还没有这家公司的投递记录。";
  // Every phase between clicking "确认已投递" and a final answer, except "confirming": a
  // write already on its way to the desktop is never yanked out from under itself by a page
  // change, same rule as saving a job. "confirmed" is a fact about the desktop and also stays.
  const SUBMIT_DROPPABLE_PHASES = [
    "extracting", "assist", "review", "querying", "choosing", "empty", "unavailable", "failed", "unknown"
  ];
  const SUBMIT_BACK_PHASES = ["choosing", "empty", "unavailable", "failed", "unknown"];
  const PANEL_SUBMIT_EPOCH = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let panelSubmit = idlePanelSubmit(null);

  function idlePanelSubmit(previous) {
    return {
      confirmId: null, phase: "idle", version: (previous?.version || 0) + 1, token: (previous?.token || 0) + 1,
      pageUrl: "", fields: null, revision: 0, note: "", openView: null, error: "", assist: null, requestId: null,
      fallback: null, candidates: [], reason: "", result: null, discarded: null
    };
  }

  function touchPanelSubmit(changes) {
    Object.assign(panelSubmit, changes, { version: panelSubmit.version + 1 });
  }

  // What the side panel may see: the editable draft (never the page's raw text beyond what
  // the user already typed), AI progress, and labels/ids of the offered applications.
  function panelSubmitSnapshot() {
    const job = panelSubmit;
    return {
      // Names this page load, so a snapshot from before a reload is never compared by version.
      epoch: PANEL_SUBMIT_EPOCH,
      confirmId: job.confirmId,
      phase: job.phase,
      version: job.version,
      revision: job.revision,
      fields: job.fields
        ? { company: job.fields.company || "", title: job.fields.title || "", sourceUrl: job.fields.sourceUrl || "" }
        : null,
      note: job.note,
      openView: job.openView,
      error: job.error,
      reason: job.reason,
      assist: job.assist ? { count: job.assist.lines.length, text: job.assist.text, lines: [...job.assist.lines] } : null,
      candidates: job.candidates.map(candidate => ({ applicationId: candidate.applicationId, label: candidate.label })),
      result: job.result ? { ...job.result } : null,
      discarded: job.discarded
    };
  }

  function panelJobIsActive() {
    return ["extracting", "assist", "review", "saving", "choice"].includes(panelJob.phase);
  }

  function panelSubmitIsActive() {
    return SUBMIT_DROPPABLE_PHASES.includes(panelSubmit.phase) || panelSubmit.phase === "confirming";
  }

  // A single-page site can swap the job under an open question. The draft and candidates
  // belong to the address they were read from; once it changes they are thrown away. A
  // write already sent (confirming) and a finished result (confirmed) are facts and stay.
  function dropStalePanelSubmit() {
    if (!panelSubmit.confirmId || panelSubmit.pageUrl === location.href) return false;
    if (!SUBMIT_DROPPABLE_PHASES.includes(panelSubmit.phase)) return false;
    cancelAiRequest(panelSubmit.requestId);
    panelSubmit = idlePanelSubmit(panelSubmit);
    panelSubmit.discarded = "page-changed";
    return true;
  }

  const submitOutcome = (extra = {}) => ({ ...extra, submitConfirm: panelSubmitSnapshot() });

  function openSubmitReview(fields, note, openView = null) {
    touchPanelSubmit({
      phase: "review", fields: { company: "", title: "", sourceUrl: "", ...fields },
      revision: panelSubmit.revision + 1, note, openView, error: "", assist: null, requestId: null
    });
  }

  // Step one, shared with "保存岗位到桌面端" (draftJobFields): read the page, ask the
  // desktop's AI only when extraction is unsure, and land on an editable review. Nothing
  // leaves the page here and nothing is written; a query only happens from "查找对应申请".
  async function startPanelSubmit() {
    dropStalePanelSubmit();
    if (panelSubmitIsActive()) return submitOutcome({ ok: true });
    if (panelJobIsActive()) {
      return submitOutcome({ ok: false, error: "请先完成或取消正在进行的岗位保存。" });
    }
    panelSubmit = idlePanelSubmit(panelSubmit);
    const token = panelSubmit.token;
    const pageUrl = location.href;
    touchPanelSubmit({ confirmId: newRequestId(), phase: "extracting", pageUrl });
    const isCurrent = () => panelSubmit.token === token && panelSubmit.pageUrl === pageUrl && location.href === pageUrl;
    const trace = submitJobTrace = newJobTrace();
    try {
      const draft = await draftJobFields({
        isCurrent,
        trace,
        onAssistStart: (described, requestId, fallback) => {
          if (!isCurrent()) return;
          touchPanelSubmit({
            phase: "assist", requestId, fallback,
            assist: { text: described.text, lines: [...(described.fragments || [])] }
          });
        },
        onAssistEnd: requestId => {
          if (isCurrent() && panelSubmit.requestId === requestId) touchPanelSubmit({ requestId: null });
        }
      });
      if (draft && isCurrent()) {
        openSubmitReview(draft.fields, draft.note, draft.openView);
      } else if (panelSubmit.token === token && location.href !== pageUrl) {
        dropStalePanelSubmit();
      }
    } catch {
      if (isCurrent()) {
        openSubmitReview(emptyJobFields(), "读取页面信息失败，请手动填写公司和岗位。");
      } else if (panelSubmit.token === token && location.href !== pageUrl) {
        dropStalePanelSubmit();
      }
    }
    return submitOutcome({ ok: true });
  }

  // Step two: only now does anything leave the page. `company`/`title` are the user's
  // reviewed text, whatever they are after "公安" became "金发科技"; the address is always
  // the draft's own redacted one, never something the panel message could substitute.
  async function queryPanelSubmit(message) {
    if (!message.confirmId || message.confirmId !== panelSubmit.confirmId) {
      return submitOutcome({ ok: false, error: "这份核对内容已经失效，请重新点「确认已投递」。" });
    }
    if (dropStalePanelSubmit()) return submitOutcome({ ok: false, error: SUBMIT_STALE });
    if (panelSubmit.phase !== "review") {
      return submitOutcome({ ok: false, error: "请先核对公司和岗位。" });
    }
    const company = typeof message.company === "string" ? message.company.trim() : "";
    const title = typeof message.title === "string" ? message.title.trim() : "";
    const sourceUrl = typeof panelSubmit.fields?.sourceUrl === "string" ? panelSubmit.fields.sourceUrl : "";
    if (!company || !title) {
      const missing = [!company && "公司名称", !title && "岗位名称"].filter(Boolean).join("和");
      const error = `请补全${missing}后再查找。`;
      touchPanelSubmit({ error, fields: { ...panelSubmit.fields, company, title } });
      return submitOutcome({ ok: false, error, missing });
    }
    const token = panelSubmit.token;
    const pageUrl = panelSubmit.pageUrl;
    // Only company/title change; the draft's own location and redacted URLs stay, so a later
    // "保存岗位到桌面端" can start from exactly what the user reviewed here.
    touchPanelSubmit({ phase: "querying", error: "", fields: { ...panelSubmit.fields, company, title, sourceUrl } });
    const asked = { company, title, sourceUrl };
    let answer;
    try {
      answer = await waitForPanelJobWrite(chrome.runtime.sendMessage({ type: "DESKTOP_CANDIDATES_FOR", fields: asked }));
    } catch {
      answer = null;
    }
    if (panelSubmit.token !== token) {
      return submitOutcome({ ok: false, expired: true, error: SUBMIT_STALE });
    }
    if (location.href !== pageUrl) {
      dropStalePanelSubmit();
      return submitOutcome({ ok: false, error: SUBMIT_STALE });
    }
    try {
      const { copy } = await loadDesktopModules();
      if (answer?.status !== "ok") {
        // No reply is not "no candidates": an empty list would push the user into saving a duplicate.
        touchPanelSubmit({
          phase: "unavailable", candidates: [],
          result: copy.describeConfirmBlocked(confirmBlockedMode(answer?.status), { extensionId: chrome.runtime.id })
        });
        return submitOutcome({ ok: true });
      }
      const seen = new Set();
      const options = [...(answer.exact || []), ...(answer.sameCompany || [])].filter(candidate => {
        if (!candidate || typeof candidate.applicationId !== "string" || !candidate.applicationId) return false;
        if (typeof candidate.company !== "string" || typeof candidate.title !== "string") return false;
        if (seen.has(candidate.applicationId)) return false;
        seen.add(candidate.applicationId);
        return true;
      }).map(candidate => ({
        applicationId: candidate.applicationId, company: candidate.company, title: candidate.title,
        label: copy.describeApplicationChoice(candidate)
      }));
      if (!options.length) {
        touchPanelSubmit({ phase: "empty", reason: "no-record", candidates: [], result: { tone: "info", text: SUBMIT_EMPTY } });
      } else {
        // Even one candidate waits for the user: the plugin never picks an application.
        touchPanelSubmit({ phase: "choosing", candidates: options });
      }
    } catch {
      touchPanelSubmit({
        phase: "failed", candidates: [],
        result: { tone: "warn", text: "没能查到对应的投递记录，这次没有确认投递。请稍后再试。" }
      });
    }
    return submitOutcome({ ok: true });
  }

  async function choosePanelSubmit(message) {
    const stale = () => submitOutcome({ ok: false, error: SUBMIT_STALE });
    if (message.confirmId && message.confirmId === panelSubmit.confirmId && dropStalePanelSubmit()) return stale();
    if (!message.confirmId || message.confirmId !== panelSubmit.confirmId) {
      return submitOutcome({ ok: false, error: "这个选择已经失效了，请重新点「确认已投递」。" });
    }
    // Claimed synchronously, so a second click can never send a second confirmation.
    if (panelSubmit.phase === "confirming") return submitOutcome({ ok: false, error: "正在确认，请稍候。" });
    if (panelSubmit.phase !== "choosing") return submitOutcome({ ok: false, error: "这个选择已经失效了，请重新点「确认已投递」。" });
    const candidate = panelSubmit.candidates.find(item => item.applicationId === message.applicationId);
    if (!candidate) return submitOutcome({ ok: false, error: "请选择列表里的申请。" });

    const token = panelSubmit.token;
    touchPanelSubmit({ phase: "confirming", result: null });
    let result = null;
    try {
      result = await waitForPanelJobWrite(chrome.runtime.sendMessage({
        type: "DESKTOP_CONFIRM_SUBMIT", applicationId: candidate.applicationId
      }));
    } catch {
      // The request may have reached the desktop before the port failed: not a failure to retry.
      result = { status: "unknown" };
    }
    if (panelSubmit.token !== token) {
      refreshPendingList();
      return submitOutcome({ ok: false, expired: true, error: "这次确认已经过期，请到桌面端查看这条申请的当前状态。" });
    }
    let described;
    let phase;
    try {
      const { copy } = await loadDesktopModules();
      const status = result?.status;
      described = copy.describeConfirmResult(result ?? { status: "unknown" });
      if (status === "saved") {
        // Only a persisted reply gets to say "已确认投递".
        phase = "confirmed";
        described = {
          tone: "success", text: `已确认投递：${candidate.company} · ${candidate.title}`,
          hint: "只更新了桌面上的申请阶段，没有提交招聘网站上的申请。"
        };
      } else if (!status || status === "unknown") {
        phase = "unknown";
      } else if (status === "failed" || status === "rejected") {
        phase = "failed";
      } else {
        phase = "unavailable";
      }
    } catch {
      phase = "unknown";
      described = { tone: "pending", text: "没能确认结果，请到桌面端查看这条申请的当前状态。" };
    }
    if (panelSubmit.token === token) touchPanelSubmit({ phase, candidates: [], result: described });
    refreshPendingList();
    return submitOutcome({ ok: true });
  }

  // "返回修改": go back to the editable review with what is already there. No re-extraction,
  // no new AI request, nothing sent to the desktop — the company/title the user last typed
  // (or the candidates/result screen showed) are exactly what the review form gets back.
  function backPanelSubmit({ confirmId }) {
    if (!confirmId || confirmId !== panelSubmit.confirmId) {
      return submitOutcome({ ok: false, error: "这次确认已经结束了。" });
    }
    if (dropStalePanelSubmit()) return submitOutcome({ ok: false, error: SUBMIT_STALE });
    if (!SUBMIT_BACK_PHASES.includes(panelSubmit.phase)) {
      return submitOutcome({ ok: false, error: "现在无法返回修改。" });
    }
    touchPanelSubmit({ phase: "review", revision: panelSubmit.revision + 1, candidates: [], result: null, error: "" });
    return submitOutcome({ ok: true });
  }

  function cancelPanelSubmit({ confirmId, scope }) {
    if (!confirmId || confirmId !== panelSubmit.confirmId) {
      return submitOutcome({ ok: false, error: "这次确认已经结束了。" });
    }
    if (panelSubmit.phase === "confirming") {
      return submitOutcome({ ok: false, error: "已经在确认了，无法取消。请到桌面端查看这条申请的当前状态。" });
    }
    if (scope === "assist") {
      // The one button covers three waits: recognizing the page, and looking the company up
      // on the desktop. None of them has anything left to do once cancelled but go back to
      // an editable review — "abandon the whole attempt" is the other button's job.
      if (!["extracting", "assist", "querying"].includes(panelSubmit.phase)) {
        return submitOutcome({ ok: false, error: "识别已经结束了。" });
      }
      cancelAiRequest(panelSubmit.requestId);
      if (panelSubmit.phase === "querying") {
        // Nothing to re-run here, just the fields the user had reviewed before the query.
        const fields = panelSubmit.fields || emptyJobFields();
        touchPanelSubmit({ token: panelSubmit.token + 1 });
        openSubmitReview(fields, "");
        return submitOutcome({ ok: true });
      }
      // A new token: whatever the AI says later belongs to a recognition nobody is waiting for.
      const fallback = panelSubmit.fallback || emptyJobFields();
      touchPanelSubmit({ token: panelSubmit.token + 1 });
      if (submitJobTrace?.aiCalled) submitJobTrace.aiCode = "cancelled";
      openSubmitReview(fallback, "已取消识别。请手动补全后再查找。");
      return submitOutcome({ ok: true });
    }
    if (SUBMIT_DROPPABLE_PHASES.includes(panelSubmit.phase)) {
      // A new token: an AI reply or a candidate list still on its way belongs to a question
      // nobody is asking any more.
      cancelAiRequest(panelSubmit.requestId);
      panelSubmit = idlePanelSubmit(panelSubmit);
      panelSubmit.phase = "cancelled";
      return submitOutcome({ ok: true });
    }
    // A finished result being dismissed.
    panelSubmit = idlePanelSubmit(panelSubmit);
    return submitOutcome({ ok: true });
  }

  // "桌面里还没有这家公司的投递记录 → 保存岗位到桌面端": hands over to the review flow.
  // Nothing is created here, and the application still has to be chosen afterwards.
  async function savePanelSubmitJob({ confirmId }) {
    if (!confirmId || confirmId !== panelSubmit.confirmId) {
      return { ok: false, error: "这次确认已经结束了。", jobSave: panelJobSnapshot(), submitConfirm: panelSubmitSnapshot() };
    }
    if (dropStalePanelSubmit()) return { ok: false, error: SUBMIT_STALE, jobSave: panelJobSnapshot(), submitConfirm: panelSubmitSnapshot() };
    if (panelSubmit.phase !== "empty") {
      return { ok: false, error: "现在不能保存岗位。", jobSave: panelJobSnapshot(), submitConfirm: panelSubmitSnapshot() };
    }
    // The save form opens with what the user already reviewed and corrected here ("公安" →
    // "金发科技"), not with a fresh read of the page: re-reading would bring the wrong
    // company back (or ask the AI again), and the user would have to fix it a second time.
    const reviewed = { ...emptyJobFields(), ...panelSubmit.fields };
    const pageUrl = panelSubmit.pageUrl;
    panelSubmit = idlePanelSubmit(panelSubmit);
    panelSubmit.phase = "cancelled";
    if (panelJob.draftId && panelJob.phase !== "idle" && panelJob.phase !== "result") {
      return { ok: true, jobSave: panelJobSnapshot(), submitConfirm: panelSubmitSnapshot() };
    }
    let note = "可直接修改，确认后才会写入桌面。";
    try { note = (await loadDesktopModules()).copy.describeReviewSave(); } catch {}
    if (location.href !== pageUrl) {
      return { ok: false, error: SUBMIT_STALE, jobSave: panelJobSnapshot(), submitConfirm: panelSubmitSnapshot() };
    }
    panelJob = idlePanelJob(panelJob);
    touchPanelJob({ draftId: newRequestId(), pageUrl });
    // [岗位]（#301）接着「确认已投递」读页面时的记录：来源和 AI 识别都发生在那一步。
    jobTrace = { ...(submitJobTrace || newJobTrace()), end: "open" };
    openPanelReview(reviewed, note);
    return { ok: true, jobSave: panelJobSnapshot(), submitConfirm: panelSubmitSnapshot() };
  }

  function setDesktopStatus(copy) {
    const box = shadowRoot?.querySelector("#resume-pro-desktop-status");
    if (!box) return;
    box.textContent = "";
    box.className = "resume-pro__desktop-status";
    if (!copy) return;

    box.classList.add(`is-${copy.tone}`);
    const line = document.createElement("p");
    line.textContent = copy.text;
    box.appendChild(line);

    if (copy.extensionId) {
      const id = document.createElement("code");
      id.className = "resume-pro__extension-id";
      id.textContent = copy.extensionId;
      box.appendChild(id);
      const copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.className = "resume-pro__manager-button";
      copyButton.textContent = "复制扩展 ID";
      copyButton.addEventListener("click", () => copyText(copy.extensionId));
      box.appendChild(copyButton);
    }

    if (copy.hint) {
      const hint = document.createElement("p");
      hint.className = "resume-pro__save-note";
      hint.textContent = copy.hint;
      box.appendChild(hint);
    }

    if (copy.offerForce && lastSubmittedFields) {
      const confirmed = lastSubmittedFields;
      const again = document.createElement("button");
      again.type = "button";
      again.className = "resume-pro__manager-button";
      again.textContent = "再存一次";
      again.addEventListener("click", () => submitSaveForm({ force: true, fields: confirmed }));
      box.appendChild(again);
    }
  }

  async function refreshPendingList() {
    const details = shadowRoot?.querySelector("#resume-pro-pending");
    const list = shadowRoot?.querySelector("#resume-pro-pending-list");
    if (!details || !list) return;

    let intents = [];
    let outbox = [];
    let fillRecords = [];
    let expired = new Set();
    let copy;
    try {
      const reply = await chrome.runtime.sendMessage({ type: "DESKTOP_LIST_QUEUE" });
      intents = reply?.intents || [];
      outbox = reply?.outbox || [];
      fillRecords = reply?.fillRecords || [];
      expired = new Set(reply?.expiredSnapshots || []);
      ({ copy } = await loadDesktopModules());
    } catch {
      return;
    }

    const total = intents.length + outbox.length + fillRecords.length;
    details.hidden = total === 0;
    shadowRoot.querySelector("#resume-pro-pending-count").textContent = String(total);
    list.textContent = "";

    for (const intent of intents) {
      const row = pendingRow(
        `${intent.fields.company} · ${intent.fields.title}`,
        intent.fields.sourceUrl,
        intent.status === "pending_bind" ? "待绑定申请" : "待同步（尚未绑定申请）"
      );
      row.appendChild(rowButton("完成保存", () => continueIntent(intent.intentId)));
      row.appendChild(rowButton("删除", async () => {
        await chrome.runtime.sendMessage({ type: "DESKTOP_REMOVE_INTENT", intentId: intent.intentId });
        refreshPendingList();
      }));
      list.appendChild(row);
    }

    for (const record of fillRecords) {
      const row = pendingRow(
        `填写留档 · ${record.fill?.templateName || ""}`,
        [record.job?.company, record.job?.title].filter(Boolean).join(" · "),
        "待同步（尚未选择申请）"
      );
      if (record.snapshot && expired.has(record.snapshot.snapshotId)) {
        appendNote(row, "附带的简历快照已暂存超过 30 天，要继续还是丢弃？");
        row.appendChild(rowButton("丢弃快照", () => dropSnapshot(record.snapshot.snapshotId)));
      }
      row.appendChild(rowButton("选择申请", () => chooseFillApplication(record)));
      row.appendChild(rowButton("删除", async () => {
        await chrome.runtime.sendMessage({ type: "DESKTOP_REMOVE_FILL", recordId: record.recordId });
        refreshPendingList();
      }));
      list.appendChild(row);
    }

    for (const entry of outbox.filter(item => item.messageType === "snapshot.upload")) {
      const state = copy.describeSnapshotUpload(entry, { expired: expired.has(entry.snapshotId) });
      const row = pendingRow(`简历快照 · ${entry.payload?.templateName || ""}`, "", state.text);
      if (entry.status === "paused" || entry.status === "needs_user") {
        // After a restore the only ways out are the user's: upload the kept original again
        // under a new identity, or let it go. Never a plain retry of the old chunks.
        appendNote(row, copy.describeSnapshotReconcile(entry.reconcileStatus).text);
        row.appendChild(rowButton("重新上传到当前档案", () => resolvePaused(entry, "resave")));
        row.appendChild(rowButton("丢弃快照", () => resolvePaused(entry, "discard")));
        list.appendChild(row);
        continue;
      }
      if (state.retry) {
        row.appendChild(rowButton("立即重试", async () => {
          await chrome.runtime.sendMessage({ type: "DESKTOP_RETRY", messageId: entry.messageId });
          refreshPendingList();
        }));
      }
      row.appendChild(rowButton(entry.status === "bytes_lost" ? "移除" : "丢弃快照", () => dropSnapshot(entry.snapshotId)));
      list.appendChild(row);
    }

    for (const entry of outbox.filter(item => item.messageType !== "snapshot.upload")) {
      const row = pendingRow(queueLabel(entry), entry.payload?.sourceUrl, describeOutboxState(entry));
      if (entry.status === "needs_user" || entry.status === "paused") {
        appendReconcileChoices(row, entry);
        list.appendChild(row);
        continue;
      }
      row.appendChild(rowButton("立即重试", async () => {
        const { copy } = await loadDesktopModules();
        const result = await chrome.runtime.sendMessage({ type: "DESKTOP_RETRY", messageId: entry.messageId });
        setDesktopStatus(describeQueueResult(copy, entry, result ?? { status: "pending" }));
        refreshPendingList();
      }));
      row.appendChild(rowButton("取消", async () => {
        await chrome.runtime.sendMessage({ type: "DESKTOP_CANCEL", messageId: entry.messageId });
        refreshPendingList();
      }));
      list.appendChild(row);
    }
  }

  function appendNote(row, text) {
    const note = document.createElement("em");
    note.textContent = text;
    row.appendChild(note);
  }

  // The fill record stays; only the snapshot copy and its upload go.
  async function dropSnapshot(snapshotId) {
    await chrome.runtime.sendMessage({ type: "DESKTOP_DROP_SNAPSHOT", snapshotId });
    refreshPendingList();
  }

  // Each kind of queued message has its own wording: a retried fill must not report that a
  // job was saved, nor a refused one ask the user to check a company name.
  function describeQueueResult(copy, entry, result) {
    if (entry.messageType === "fill.submit") return copy.describeFillRecordResult(result);
    if (entry.messageType === "snapshot.upload") return copy.describeSnapshotResolveResult(result);
    if (entry.messageType === "submit.confirm") return copy.describeConfirmResult(result);
    return copy.describeBindResult(result);
  }

  function queueLabel(entry) {
    if (entry.messageType === "fill.submit") return `填写留档 · ${entry.payload?.templateName || ""}`;
    if (entry.messageType === "submit.confirm") return "确认已投递";
    return `${entry.payload?.company || ""} · ${entry.payload?.title || ""}`;
  }

  function pendingRow(label, title, state) {
    const row = document.createElement("div");
    row.className = "resume-pro__pending-row";

    const name = document.createElement("span");
    name.textContent = label;
    name.title = title || "";
    row.appendChild(name);

    const status = document.createElement("em");
    status.textContent = state;
    row.appendChild(status);
    return row;
  }

  function rowButton(text, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "resume-pro__manager-button";
    button.textContent = text;
    button.addEventListener("click", onClick);
    return button;
  }

  // After a restore the queued envelope carries an epoch the desktop has replaced. There is
  // no "retry" here on purpose: the only ways out are the three the user chooses.
  function appendReconcileChoices(row, entry) {
    loadDesktopModules().then(({ copy }) => {
      const explain = copy.describeReconcileStatus(entry.reconcileStatus);
      const note = document.createElement("em");
      note.textContent = explain.text;
      row.appendChild(note);
    });

    row.appendChild(rowButton("关联到已有申请", async () => {
      const applicationId = prompt("要关联到哪条申请？请粘贴桌面里的申请 ID：");
      if (!applicationId) return;
      await resolvePaused(entry, "associate", applicationId.trim());
    }));
    row.appendChild(rowButton("另存为新的", () => resolvePaused(entry, "resave")));
    row.appendChild(rowButton("丢弃", () => resolvePaused(entry, "discard")));
  }

  async function resolvePaused(entry, choice, applicationId) {
    const { copy } = await loadDesktopModules();
    const result = await chrome.runtime.sendMessage({
      type: "DESKTOP_RESOLVE", messageId: entry.messageId, choice, applicationId
    });
    if (choice !== "discard") {
      // A resaved snapshot is queued, not yet on the desktop: described as pending.
      const shown = result?.status === "queued" ? { status: "pending" } : (result ?? { status: "pending" });
      setDesktopStatus(describeQueueResult(copy, entry, shown));
    }
    refreshPendingList();
  }

  // The reason is the plugin's own classification, not the protocol text: the wording table
  // in link/copy.mjs is the only place that turns a code into a sentence.
  function describeOutboxState(entry) {
    if (entry.status === "paused") return "桌面换过档案库，已暂停";
    if (entry.status === "needs_user") return "桌面换过档案库，等你决定";
    if (entry.status === "failed") return `已停下，需要处理（${describeFailure(entry.lastError)}）`;
    if (entry.status === "stalled") return `重试多次仍未成功，等你决定（${describeFailure(entry.lastError)}）`;
    const next = entry.nextAttemptAt ? `，下次重试 ${formatClock(entry.nextAttemptAt)}` : "";
    return `待同步（已尝试 ${entry.attempts || 0} 次${next}）`;
  }

  function describeFailure(code) {
    if (code === "unavailable") return "桌面暂时不可用";
    if (code === "invalid_payload") return "桌面看不懂这条内容";
    if (code === "restore_epoch_mismatch") return "桌面换过档案库";
    if (code === "previously_purged") return "已在桌面永久删除";
    if (code === "conflict") return "与桌面已有记录冲突";
    return "原因未知";
  }

  function formatClock(iso) {
    const at = new Date(iso);
    return Number.isNaN(at.getTime())
      ? "稍后"
      : at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  if (self.__RESUME_PRO_TEST__) {
    self.ResumeProHighlightTest = {
      applySidebarUiState,
      applyStoredSidebarUiState,
      bindStorageSync,
      bindFocusTracking,
      describePanelTarget,
      readPanelChips,
      resolveTextSelection,
      isSensitiveTextTarget,
      constrainSidebarToViewport,
      persistSidebarUiState,
      readSidebarUiState,
      stopDrag,
      handleRepeatFillClick,
      handlePanelRepeat,
      describeRepeat,
      addUnansweredToProfile,
      formatFillDiagnostics,
      getHighlightTargets,
      handleAiFillClick,
      setUploadClock(clock) {
        uploadClock = clock;
      },
      handleSaveJobClick,
      cancelJobAssist,
      submitSaveForm,
      describeCommit,
      presentSaveResult,
      draftJobFields,
      runJobAssist,
      reviewedJobFields,
      panelJobSnapshot,
      getSaveInteractionState() {
        return { extractInFlight, saveInFlight, extractToken };
      },
      setDesktopModules(modules) {
        desktopModules = modules;
      },
      offerFillRecord,
      handleRecordFillClick,
      panelFillSnapshot,
      getPendingFill() {
        return pendingFill;
      },
      setPanelFillWaitMs(ms) {
        panelFillWaitMs = ms;
      },
      setPanelJobWriteTimeoutMs(ms) {
        panelJobWriteTimeoutMs = ms;
      },
      handleChipAction,
      handleFieldChipClick,
      handlePanelFieldAction,
      refreshVisibleStore,
      highlightFilledField,
      injectFieldHighlightStyles,
      isInViewport,
      applyChipValue,
      composeChipText,
      syncChipSelectionState,
      setElementValue,
      operateControl,
      isSyncableTextControl,
      isSubmitTrigger,
      findSubmitTrigger,
      beginFillSession,
      endFillSession,
      recordFilledTextControl,
      finalSyncFillSession,
      getFillSession() {
        return fillSession;
      },
      fillSessionControls() {
        return fillSession ? Array.from(fillSession.controls.keys()) : [];
      },
      setSubmitCheckDelayMs(ms) {
        submitCheckDelayMs = ms;
      },
      setTextCommitWaitMs(ms) {
        textCommitWaitMs = ms;
      },
      setOverlayWindowMs(ms) {
        overlayWindowMs = ms;
      },
      setCalendarCloseMs(ms) {
        calendarCloseMs = ms;
      },
      prepareTextValue,
      sameTextValue,
      textFillFailureReason(element) {
        const control = element?.kind === "element" ? element.element : element;
        return textFillFailures.get(control) || "";
      },
      setCurrentStore(store) {
        state.currentStore = store;
      },
      setAiBusy(busy) {
        state.aiBusy = Boolean(busy);
      },
      setNativeSidePanel(supported) {
        state.nativeSidePanel = Boolean(supported);
      },
      setSiteAnswers(value) {
        state.siteAnswers = value;
      },
      getSiteAnswers() {
        return state.siteAnswers;
      },
      setProfileOffer({ candidates }) {
        state.profileOfferCandidates = candidates;
        state.profileOfferSite = self.ResumeProProfile?.siteKeyOf?.(location.href) || "";
        state.profileOfferResult = null;
        state.profileOfferVersion += 1;
      },
      getProfileOfferVersion() {
        return state.profileOfferVersion;
      },
      panelProfileSnapshot,
      offerUnansweredFields,
      dismissProfileResult,
      setLastFocusedField(field) {
        state.lastFocusedField = field;
      },
      setDragging(dragging) {
        state.dragging = Boolean(dragging);
      },
      setSidebarUiState(uiState) {
        state.sidebarUiState = self.ResumeProSidebarState.normalize(uiState);
      },
      getSidebarUiState() {
        return self.ResumeProSidebarState.normalize(state.sidebarUiState);
      },
      setShadowRoot(root) {
        shadowRoot = root;
      },
      setStartupState(value) {
        startupState = value;
      }
    };
  }
})();
