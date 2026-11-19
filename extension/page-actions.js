// #225 深度分析的前置动作：把校验过的说明书变成一份可预览的动作计划，用户在侧栏确认后逐个执行并核验。
// 只点「编辑 / 展开」（preActions）和经历分组的「添加」（sections，数量由插件按模板记录数和网页已有条目算）。
// 每一步点击前都按网页当前的样子重新判断目标；点击后等页面安静下来，并核对确实出现了新的输入框。
// 不点跨页、跨站的链接和提交类按钮；不保存、不提交、不删除，也不撤销网页或用户已经做出的改动。
(function attachResumeProPageActions(scope) {
  const MAX_PRE_ACTIONS = 5;
  const MAX_ADDS = 5;
  const QUIET_MS = 500;
  const MAX_WAIT_MS = 5000;
  const POLL_MS = 50;
  const MAX_ROOT_DEPTH = 6;
  const EDITABLE = "input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]):not([type=image]):not([type=file]),"
    + " textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='combobox']";
  const KIND_TEXT = { edit: "编辑", expand: "展开" };
  // 停止原因：只用这些固定的码写诊断，不写网页文字。
  const CODES = ["stopped", "navigated", "target_changed", "no_change", "timeout", "values_changed", "add_failed"];

  // 主文档、开放的 Shadow root、同源框架（和大纲的遍历范围一致）。
  function roots(doc, depth = 0, list = []) {
    if (!doc || depth > MAX_ROOT_DEPTH) return list;
    list.push(doc);
    for (const el of Array.from(doc.querySelectorAll("*"))) {
      if (el.shadowRoot) roots(el.shadowRoot, depth + 1, list);
      if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
        let inner = null;
        try { inner = el.contentDocument; } catch { inner = null; }
        if (inner?.documentElement) roots(inner, depth + 1, list);
      }
    }
    return list;
  }

  function editableControls(doc, isVisible) {
    const found = [];
    for (const root of roots(doc)) {
      for (const el of Array.from(root.querySelectorAll(EDITABLE))) {
        if (el.disabled) continue;
        try { if (isVisible(el)) found.push(el); } catch { /* 看不出可见性的不算 */ }
      }
    }
    return found;
  }

  const valueOf = el => ({ el, value: "value" in el ? el.value : el.textContent, checked: Boolean(el.checked) });
  // 点击前已经在的输入框：还连在网页上的，内容不能被改。网页重新渲染掉的旧框不算改动（编辑态常整块重建）。
  function valuesKept(saved) {
    return saved.every(({ el, value, checked }) => !el.isConnected
      || (("value" in el ? el.value : el.textContent) === value && Boolean(el.checked) === checked));
  }

  function disabledNow(el) {
    return Boolean(el.disabled) || el.getAttribute?.("aria-disabled") === "true" || Boolean(el.closest?.("[aria-disabled='true'], fieldset[disabled]"));
  }

  // 点之前按网页当前的样子再判断一次：还在、看得见、没禁用、文字仍在允许列表里且不在禁止列表里、
  // 不是提交、不离开本页（跨页、跨站、新窗口打开）。deep：deep-analysis.js 的规则；describe：page-outline.js 的按钮描述。
  function targetAllowed(el, kind, { deep, describe, isVisible, doc }) {
    if (!el?.isConnected || (doc && el.ownerDocument !== doc && !roots(doc).some(root => root.contains?.(el)))) return false;
    try { if (!isVisible(el)) return false; } catch { return false; }
    if (disabledNow(el)) return false;
    const anchor = el.closest?.("a[href], area[href]");
    if (anchor && String(anchor.getAttribute("target") || "").trim() && anchor.getAttribute("target") !== "_self") return false;
    const node = { type: "button", ...describe(el) };
    if (node.leaves || node.crossSite || node.submit) return false;
    const allow = kind === "add" ? deep.ALLOW.add : deep.ALLOW[kind];
    return Boolean(allow) && deep.buttonAllowed(node, allow);
  }

  // #301 「没有实习经历」这类开关：点之前再确认一次——还连在网页上、看得见、没禁用，勾选框还是勾着的，字没变。
  function toggleAllowed(item, { isVisible, doc }) {
    const { box, text } = item.toggle || {};
    const el = item.element;
    if (!el?.isConnected || !box?.isConnected || !el.contains(box) || !box.checked || box.disabled) return false;
    if (doc && el.ownerDocument !== doc && !roots(doc).some(root => root.contains?.(el))) return false;
    try { if (!isVisible(el)) return false; } catch { return false; }
    return disabledNow(box) === false && String(el.textContent || "").replace(/[\s\p{P}\p{S}]/gu, "") === text;
  }
  const itemAllowed = (item, ctx) => item.toggle ? toggleAllowed(item, ctx) : targetAllowed(item.element, item.kind, ctx);

  // 模拟一次真实点击（指针、鼠标、click）。链接和按钮的默认动作一律取消：
  // 不让「#」改网址，也不让漏网的提交按钮提交表单；网页自己的点击处理照常运行。
  // guard: false 只给勾选框的开关用（点 label 靠默认动作切换勾选，勾选框点了也不会提交表单）。
  function press(el, { guard: protect = true } = {}) {
    const view = el.ownerDocument?.defaultView;
    const fire = (Type, type) => {
      if (typeof Type !== "function") return;
      el.dispatchEvent(new Type(type, { bubbles: true, cancelable: true, composed: true, button: 0, ...(type.startsWith("pointer") ? { pointerType: "mouse" } : {}) }));
    };
    fire(view?.PointerEvent, "pointerdown");
    fire(view?.MouseEvent, "mousedown");
    if (!el.isConnected) return "target_changed";
    fire(view?.PointerEvent, "pointerup");
    fire(view?.MouseEvent, "mouseup");
    if (!el.isConnected) return "target_changed";
    const guard = protect && (el.tagName === "BUTTON" || Boolean(el.closest?.("a[href], area[href], form")));
    const prevent = event => event.preventDefault();
    if (guard) el.addEventListener("click", prevent, { capture: true });
    try { el.click(); } finally { if (guard) el.removeEventListener("click", prevent, { capture: true }); }
    return "";
  }

  // 等页面安静下来：连续 quietMs 没有结构或属性变化，并且 ready() 成立（出现了新的输入框）；最长 maxMs。
  // 期间 stopped() 给出原因（用户停止、网址变化、页面离开）就立即结束。
  function waitSettled(doc, { stopped, ready, quietMs = QUIET_MS, maxMs = MAX_WAIT_MS, pollMs = POLL_MS } = {}) {
    const View = doc.defaultView;
    const Observer = View?.MutationObserver || scope.MutationObserver;
    return new Promise(resolve => {
      const started = Date.now();
      let last = started;
      const observers = [];
      if (typeof Observer === "function") {
        for (const root of roots(doc)) {
          try {
            const observer = new Observer(() => { last = Date.now(); });
            observer.observe(root, { subtree: true, childList: true, attributes: true });
            observers.push(observer);
          } catch { /* 观察不了的根只靠轮询 */ }
        }
      }
      const finish = result => {
        observers.forEach(observer => observer.disconnect());
        resolve(result);
      };
      const check = () => {
        const reason = stopped?.() || "";
        if (reason) return finish({ settled: false, ready: false, reason });
        const now = Date.now();
        if (now - last >= quietMs && ready()) return finish({ settled: true, ready: true });
        if (now - started >= maxMs) return finish({ settled: false, ready: ready(), quiet: now - last >= quietMs });
        setTimeout(check, pollMs);
      };
      setTimeout(check, pollMs);
    });
  }

  // 校验过的说明书 → 动作计划。preActions：本页的「编辑 / 展开」自动点（跨页的只提示手动点）；
  // sections：交给 form-agent 的 collectSpec 定位分组、数已有条目、按模板算新增数量。
  // 本轮同时有「编辑 / 展开」时不新增：编辑会重画页面，新增按钮可能被换掉，编辑后再分析一次更可靠。
  // 返回 { items, manual, blocked, adds }：items 是要确认的动作（含预览文字），manual / blocked 是要告诉用户的。
  function buildPlan({ spec, nodes, titles, redact, templateFields, formAgent, deep, describe, isVisible, doc, labelOf, timing }) {
    const items = [];
    const manual = [];
    const blocked = [];
    const nameOf = (ref, fallback) => {
      const text = redact(String(nodes.get(ref)?.text || fallback), 12) || fallback;
      const title = titles?.get(ref) || "";
      return { text, title, label: `${title || "页面"}：${text}` };
    };
    for (const action of (spec.preActions || []).slice(0, MAX_PRE_ACTIONS)) {
      const node = nodes.get(action.ref);
      const name = nameOf(action.ref, KIND_TEXT[action.kind]);
      if (action.leaves || node?.leaves) { manual.push(`${name.label}（可能会打开新页面，请手动点击）`); continue; }
      if (!node?.element || !targetAllowed(node.element, action.kind, { deep, describe, isVisible, doc })) {
        return { error: "target_changed" };
      }
      // 同一个按钮或互相嵌套的按钮只点一次：说不清时整份不点。
      if (items.some(item => item.element === node.element || item.element.contains(node.element) || node.element.contains(item.element))) {
        return { error: "ambiguous" };
      }
      items.push({ kind: action.kind, ref: action.ref, element: node.element, label: name.label });
    }
    // #301 勾着「没有实习经历」的分组没有「添加」按钮：简历里有这类经历时，列一步取消勾选，用户确认后才执行。
    // 取消勾选前这一组没有「添加」按钮，第一轮分析看不到它：简历里不止一条时，取消勾选后在这一组里找「添加」接着补齐
    // （见 followToggleAdds），写进预览，和取消勾选一起确认。
    const toggles = formAgent?.emptyToggles?.(doc, templateFields, isVisible) || [];
    for (const toggle of toggles) {
      if (items.some(item => item.element === toggle.element || item.element.contains(toggle.element) || toggle.element.contains(item.element))) continue;
      const label = formAgent.labels?.[toggle.domain] || "条目";
      const follow = toggle.count > 1 && toggle.count <= MAX_ADDS ? { domain: toggle.domain, target: toggle.count, fields: templateFields } : null;
      items.push({ kind: "expand", ref: "", toggle: { box: toggle.box, text: toggle.text, follow }, element: toggle.element,
        label: follow ? `取消勾选「${toggle.text}」，再把${label}补到 ${toggle.count} 条` : `取消勾选「${toggle.text}」` });
    }
    let adds = null;
    const campus = formAgent?.campusGroups?.(doc) || [];
    const sections = (spec.sections || []).filter(section => section.addRef && !campus.some(group =>
      group.domain === section.domain || group.button === nodes.get(section.addRef)?.element));
    if ((sections.length || campus.length) && templateFields.length) {
      // 取消勾选「没有××经历」只让那一组冒出输入框，不重画别的分组：别的分组的「添加」照常一起做。
      if (items.some(item => !item.toggle) || manual.length) {
        blocked.push("先完成「编辑 / 展开」；如果网页上的经历条目比简历少，完成后再点一次「深度分析本页」来新增。");
      } else {
        const groupOf = section => ({
          domain: section.domain,
          button: nodes.get(section.addRef)?.element,
          rows: section.rowRefs.map(ref => nodes.get(ref)?.element).filter(Boolean)
        });
        const groups = [...sections.map(groupOf), ...campus];
        // 「没有××经历」开关属于它自己那一组：别的分组往上扩范围时碰到它就停（取消勾选后那一组会冒出输入框）。
        groups.forEach((group, index) => {
          group.others = [...groups.filter((_, i) => i !== index).flatMap(other => [other.button, ...(other.rows || [])]),
            ...toggles.map(toggle => toggle.element)].filter(Boolean);
        });
        const snapshot = formAgent.collectSpec(groups, templateFields, {
          isVisible, labelOf, press, timing: timing?.add,
          allowed: el => targetAllowed(el, "add", { deep, describe, isVisible, doc })
        });
        for (const problem of snapshot.problems) {
          const label = formAgent.labels[problem.domain] || "条目";
          blocked.push(problem.reason === "over_limit"
            ? `${label}需要新增 ${problem.needed} 条，超过每次 5 条的上限，这次不会自动新增，请先手动新增一部分。`
            : problem.reason === "ambiguous"
              ? `${label}在网页上对应不止一个分组，无法确定在哪里新增，这次不会自动新增。`
              : `${label}在网页上的已有条目无法可靠计数，这次不会自动新增，请手动新增。`);
        }
        const plan = snapshot.candidates.map(candidate => ({ id: candidate.id, count: candidate.target - candidate.current }));
        const total = plan.reduce((sum, action) => sum + action.count, 0);
        if (total > MAX_ADDS) {
          // 总数超过上限：一条也不加，不按分组截断。
          blocked.push(`简历里的经历需要新增 ${total} 条，超过每次 ${MAX_ADDS} 条的上限，这次不会自动新增，请先手动新增一部分。`);
        } else if (plan.length) {
          adds = { snapshot, plan };
          for (const candidate of snapshot.candidates) {
            items.push({ kind: "add", domain: candidate.domain, count: candidate.target - candidate.current,
              element: snapshot.refs.get(candidate.id).button, label: `${candidate.label}：添加 ×${candidate.target - candidate.current}` });
          }
        }
      }
    }
    return { items, manual, blocked, adds };
  }

  // form-agent 的固定报错文案 → 停止细分码（只用这些码写诊断，不写网页文字）。
  const ADD_STOP_DETAILS = [
    [/未确认出现新条目/, "no_new_row"], [/无法确定新增的条目/, "unclear_row"], [/一次新增了多个/, "many_rows"],
    [/分组已被替换/, "scope_replaced"], [/已停止辅助新增/, "stopped"], [/网页重建或改变了已有字段/, "values_changed"],
    [/新条目没有可见输入框/, "no_inputs"],
    [/新增按钮或分组已变化|条目数量已变化|网页条目已变化|页面条目已变化|网页分组已变化/, "target_changed"]
  ];
  function addStopDetail(error) {
    const message = String(error?.message || "");
    return (ADD_STOP_DETAILS.find(([pattern]) => pattern.test(message)) || [null, "other"])[1];
  }

  // 执行前：所有目标都还是预览时那样（同一个元素、仍然允许）。任何一个变了，整份不执行。
  function planStillValid(plan, ctx) {
    return plan.items.every(item => itemAllowed(item, ctx));
  }

  // #301 取消勾选「没有××经历」以后：在这一组新冒出来的那块里找唯一的「添加」，按页面结构数已有条目，补到简历的条数。
  // 找那一块：从开关往上，到第一个装着新输入框的祖先为止。「添加」只认一个、而且按网页当前样子仍然允许点；
  // 找不到、不止一个、数不清就不补（第二轮分析会提示用户再分析一次）。返回 formAgent.execute 的结果，出错时抛出它的错误。
  const FOLLOW_ADD_TEXT = /^[+＋]?(?:添加|新增)(?:一条)?(?:工作|实习|项目)?(?:经历|经验)?$/;
  const bareText = el => String(el?.textContent || "").replace(/[\s\p{P}\p{S}]/gu, "");
  async function followToggleAdds(item, before, ctx, onStep) {
    const follow = item.toggle?.follow;
    if (!follow || !ctx.deep || !ctx.describe || !ctx.formAgent?.collectSpec) return { added: 0, scopes: [] };
    const fresh = editableControls(ctx.doc, ctx.isVisible).filter(el => !before.includes(el));
    let box = item.element.parentElement;
    for (let depth = 0; box && box !== ctx.doc.body && depth < 8 && !fresh.some(el => box.contains(el)); depth += 1) box = box.parentElement;
    if (!fresh.length || !box || box === ctx.doc.body) return { added: 0, scopes: [] };
    const words = Array.from(box.querySelectorAll("*")).filter(el => FOLLOW_ADD_TEXT.test(bareText(el).replace(/^＋/, "+"))
      && !Array.from(el.children).some(child => FOLLOW_ADD_TEXT.test(bareText(child))));
    const buttons = [...new Set(words.map(el => el.closest("button, [role='button'], a[href]") || el))].filter(el => {
      try { return ctx.isVisible(el); } catch { return false; }
    });
    if (buttons.length !== 1 || !targetAllowed(buttons[0], "add", ctx)) return { added: 0, scopes: [] };
    const snapshot = ctx.formAgent.collectSpec([{ domain: follow.domain, button: buttons[0], rows: [], others: [] }], follow.fields || [], {
      isVisible: ctx.isVisible, press, timing: ctx.timing?.add, allowed: el => targetAllowed(el, "add", ctx)
    });
    const plan = snapshot.candidates.map(candidate => ({ id: candidate.id, count: candidate.target - candidate.current }));
    const total = plan.reduce((sum, action) => sum + action.count, 0);
    if (!total || total > MAX_ADDS) return { added: 0, scopes: [] };
    return ctx.formAgent.execute(plan, snapshot, () => Boolean(ctx.stopped()), onStep, () => !ctx.stopped());
  }

  // 逐个执行确认过的计划。ctx：doc、deep、describe、isVisible、formAgent、stopped（返回原因）、onProgress、timing。
  // 返回 { ok, code, message, done: { edit, expand, add }, scopes }；ok 为 false 时后面的动作一律没做。
  async function executePlan(plan, ctx) {
    const done = { edit: 0, expand: 0, add: 0 };
    // 进度按实际点击次数算：「添加 ×k」是 k 次点击（PR #279 审查）。
    // 取消勾选后接着补的条目也算进去（取消勾选后网页多半自带一张空白条目，按少一条估）。
    const total = plan.items.reduce((sum, item) => sum + (item.kind === "add" ? Number(item.count) || 0 : 1)
      + (item.toggle?.follow ? Math.max(0, item.toggle.follow.target - 1) : 0), 0);
    const end = (code, message = "", extra = {}) => ({ ok: false, code, message, done, scopes: [], ...extra });
    if (!planStillValid(plan, ctx)) return end("target_changed");
    let index = 0;
    let scopes = [];
    for (const item of plan.items) {
      if (item.kind === "add") continue;
      index += 1;
      const reason = ctx.stopped();
      if (reason) return end(reason === "navigated" ? "navigated" : "stopped");
      if (!itemAllowed(item, ctx)) return end("target_changed");
      const before = editableControls(ctx.doc, ctx.isVisible);
      // 开关自己的勾选状态本来就要变，不算网页改了用户的内容。
      const saved = before.filter(el => el !== item.toggle?.box).map(valueOf);
      ctx.onProgress?.({ index, total, label: item.label, kind: item.kind });
      const pressed = press(item.element, item.toggle ? { guard: false } : {});
      if (pressed) return end(pressed);
      const fresh = () => editableControls(ctx.doc, ctx.isVisible).some(el => !before.includes(el))
        || Boolean(item.toggle && item.toggle.box.isConnected && !item.toggle.box.checked);
      const waited = await waitSettled(ctx.doc, { stopped: ctx.stopped, ready: fresh, ...(ctx.timing || {}) });
      if (waited.reason) return end(waited.reason === "navigated" ? "navigated" : "stopped");
      // 没出现新的输入框：页面早就安静了是「没有变化」，一直在变是「超时」。两种都停下，不再点下一个。
      if (!waited.ready) return end(waited.quiet ? "no_change" : "timeout");
      if (!valuesKept(saved)) return end("values_changed");
      done[item.kind] += 1;
      if (item.toggle?.follow) {
        const controlsBefore = editableControls(ctx.doc, ctx.isVisible).length;
        try {
          const follow = await followToggleAdds(item, before, ctx, step => {
            ctx.onProgress?.({ index, total, label: `${ctx.formAgent.labels?.[step.domain] || "条目"}：添加 ${step.index}/${step.count}`, kind: "add" });
          });
          done.add += follow.added;
          scopes.push(...follow.scopes);
        } catch (error) {
          done.add += Number.isInteger(error?.added) ? error.added : 0;
          const reason = ctx.stopped();
          if (reason) return end(reason === "navigated" ? "navigated" : "stopped");
          const grew = Math.max(0, editableControls(ctx.doc, ctx.isVisible).length - controlsBefore);
          const text = String(error?.message || "").slice(0, 120);
          return end("add_failed", grew ? `${text}页面上多出了 ${grew} 个输入框，网页可能已经新增了条目，请检查。` : text,
            { detail: addStopDetail(error), grew });
        }
      }
    }
    if (plan.adds) {
      const controlsBefore = editableControls(ctx.doc, ctx.isVisible).length;
      const stopped = () => Boolean(ctx.stopped());
      try {
        const result = await ctx.formAgent.execute(plan.adds.plan, plan.adds.snapshot, stopped, step => {
          index += 1;
          ctx.onProgress?.({ index, total, label: `${ctx.formAgent.labels[step.domain] || "条目"}：添加 ${step.index}/${step.count}`, kind: "add" });
        }, () => !ctx.stopped());
        done.add = result.added;
        scopes.push(...result.scopes);
      } catch (error) {
        done.add = Number.isInteger(error?.added) ? error.added : 0;
        const reason = ctx.stopped();
        if (reason) return end(reason === "navigated" ? "navigated" : "stopped");
        // form-agent 的报错是固定文案，直接给用户看。点过之后页面上多出了输入框，说明网页可能已经加了一条，
        // 只是没认出来：如实告诉用户，不能只报「完成 0」。detail 是固定的停止细分码，写进诊断。
        const grew = Math.max(0, editableControls(ctx.doc, ctx.isVisible).length - controlsBefore);
        const text = String(error?.message || "").slice(0, 120);
        return end("add_failed", grew ? `${text}页面上多出了 ${grew} 个输入框，网页可能已经新增了条目，请检查。` : text,
          { detail: addStopDetail(error), grew });
      }
    }
    return { ok: true, code: "", message: "", done, scopes };
  }

  // 悬停预览时在网页上框出目标。只改元素自己的行内 outline，结束时原样恢复（框架里、Shadow DOM 里的元素也适用）。
  function createHighlighter() {
    const PROPS = [["outline", "3px solid #36756b"], ["outline-offset", "2px"]]; // 侧栏的主色 --accent
    let current = null;
    function clear() {
      if (!current) return;
      const { el, saved } = current;
      current = null;
      try {
        for (const [name, value, priority] of saved) {
          if (value) el.style.setProperty(name, value, priority);
          else el.style.removeProperty(name);
        }
      } catch { /* 元素已经不在了 */ }
    }
    function show(el) {
      if (current?.el === el) return;
      clear();
      if (!el?.isConnected || !el.style) return;
      current = { el, saved: PROPS.map(([name]) => [name, el.style.getPropertyValue(name), el.style.getPropertyPriority(name)]) };
      for (const [name, value] of PROPS) el.style.setProperty(name, value, "important");
      const rect = el.getBoundingClientRect?.();
      const view = el.ownerDocument?.defaultView;
      if (rect && view && (rect.bottom < 0 || rect.top > view.innerHeight)) el.scrollIntoView?.({ block: "center" });
    }
    return { show, clear, active: () => Boolean(current) };
  }

  const api = { MAX_PRE_ACTIONS, MAX_ADDS, QUIET_MS, MAX_WAIT_MS, CODES, editableControls, targetAllowed, press, waitSettled,
    buildPlan, planStillValid, executePlan, createHighlighter, valuesKept };
  scope.ResumeProPageActions = api;
  try { if (typeof module === "object" && module && typeof module.exports === "object") module.exports = api; } catch { /* a page element or frame named "module" (#275) */ }
})(typeof self !== "undefined" ? self : globalThis);
