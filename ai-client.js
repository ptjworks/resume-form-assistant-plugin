(function (root) {
  const pending = new Map();
  // 一键填写（AI_FILL）带不带资料原文，只按后台存的「AI 填写时发送资料原文」（插件状态页的开关，默认关）：
  // 调用方自己带的 sendValues 不算；问不到、回得不对都按关着，只发编号、分组和字段名。
  async function sendValuesEnabled() {
    try {
      const status = await chrome.runtime.sendMessage({ type: "AI_SEND_VALUES_STATUS" });
      return status?.ok === true && status.enabled === true;
    } catch {
      return false;
    }
  }
  async function send(message) {
    const key = message.requestId || Symbol();
    let posted;
    pending.set(key, new Promise(resolve => { posted = resolve; }));
    try {
      // 先登记再问开关：问的时候按了停止，cancel 也找得到这一次。
      if (message?.type === "AI_FILL") message = { ...message, sendValues: await sendValuesEnabled() };
      const host = await chrome.runtime.sendMessage({ type: "ENSURE_AI_HOST" });
      if (!host?.ready) throw new Error(host?.error || "无法启动 AI 请求进程。");
      const ready = await chrome.runtime.sendMessage({ type: "AI_HOST_READY" });
      if (!ready?.ready) throw new Error("AI 请求进程尚未就绪，请重新加载扩展。");
      const result = chrome.runtime.sendMessage(message);
      posted(true);
      return await result;
    } finally {
      posted(false);
      pending.delete(key);
    }
  }
  async function cancel(requestId) {
    const posting = pending.get(requestId);
    if (!posting || !await posting) return { cancelled: false };
    return chrome.runtime.sendMessage({ type: "CANCEL_AI_FILL", requestId });
  }
  root.ResumeProAIClient = { send, cancel };
})(typeof self !== "undefined" ? self : globalThis);
