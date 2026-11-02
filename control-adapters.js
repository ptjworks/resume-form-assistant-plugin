(function attachControls(scope) {
  // These are the shared #219 types. Component libraries are implementation details,
  // never new control kinds or instructions supplied by a model.
  const KINDS = new Set(['text', 'textarea', 'native-select', 'radio', 'checkbox', 'date', 'custom-select', 'cascader', 'contenteditable']);
  function cleanHints(hints) {
    const clean = {};
    if (!hints || typeof hints !== 'object') return clean;
    for (const key of ['searchable', 'multiple']) if (typeof hints[key] === 'boolean') clean[key] = hints[key];
    if (['inline', 'portal'].includes(hints.popup)) clean.popup = hints.popup;
    if (['YYYY-MM-DD', 'YYYY-MM', 'YYYY'].includes(hints.dateFormat)) clean.dateFormat = hints.dateFormat;
    return clean;
  }

  // #400 同源框架里的元素属于框架自己的 window：对这里的 HTMLInputElement 做 instanceof 是 false。
  // 先按当前 window 的构造函数判断，再按元素所在 window 的。全局构造函数用到时才读（测试会在加载后换掉）。
  function localType(name) {
    if (name === 'HTMLInputElement') return typeof HTMLInputElement === 'function' ? HTMLInputElement : null;
    if (name === 'HTMLSelectElement') return typeof HTMLSelectElement === 'function' ? HTMLSelectElement : null;
    return typeof HTMLTextAreaElement === 'function' ? HTMLTextAreaElement : null;
  }
  function isA(node, name) {
    if (!node || typeof node !== 'object') return false;
    const Local = localType(name);
    if (Local && node instanceof Local) return true;
    const Own = node.ownerDocument?.defaultView?.[name];
    return typeof Own === 'function' && Own !== Local && node instanceof Own;
  }
  const isInput = node => isA(node, 'HTMLInputElement');
  // #301 antd 换了类名前缀（飞书招聘 atsx-，见 antd-prefix.js）：选择器里的 .ant- 按节点所在文档的前缀展开，
  // 查类名时换了前缀的也算。
  const antd = (node, selector) => scope.ResumeProAntdPrefix?.css(node, selector) ?? selector;
  const antdHas = (el, name) => scope.ResumeProAntdPrefix?.has(el, name) ?? Boolean(el?.classList?.contains(name));

  function create(deps = {}) {
    const helpers = deps.helpers || scope.ResumeProAIHelpers;
    const now = () => typeof performance !== 'undefined' ? performance.now() : Date.now();
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const settleMs = () => deps.getSettleMs ? deps.getSettleMs() : deps.settleMs ?? 250;
    const checks = new WeakMap();
    const timeoutMs = deps.timeoutMs ?? 2000;
    const visible = el => {
      if (!el || el.isConnected === false || el.hidden || antdHas(el, 'ant-picker-dropdown-hidden')) return false;
      if (deps.isVisible ? deps.isVisible(el) : !el.getBoundingClientRect || el.getBoundingClientRect().height > 0) return true;
      // Liepin's opening motion starts at scale(0): the rendered rect is empty,
      // while the mounted calendar already has layout and can commit selection.
      // Hidden/unmounted parked popups still fail the style/layout checks.
      const css = el.ownerDocument?.defaultView?.getComputedStyle?.(el);
      return Boolean(css && css.display !== 'none' && css.visibility !== 'hidden'
        && el.offsetHeight > 0 && el.offsetWidth > 0);
    };
    const result = (ok, reason, ctx, extra = {}) => ({ ok, reason, observed: {
      ...(KINDS.has(ctx.kind) ? { controlKind: ctx.kind } : {}), connected: ctx.nodes.every(el => el.isConnected !== false),
      rolledBack: reason === 'value_reverted', ...ctx.observed, ...extra
    } });
    function kindOf(entry, el) {
      if (entry?.kind === 'radio') return 'radio';
      if (isA(el, 'HTMLSelectElement')) return 'native-select';
      if (isInput(el)) {
        if (['file', 'submit', 'button', 'reset', 'image', 'hidden', 'password'].includes(el.type)) return 'unsupported';
        if (['checkbox', 'radio'].includes(el.type)) return el.type;
        if (['date', 'month', 'datetime-local', 'time', 'week'].includes(el.type)) return 'date';
      }
      if (isA(el, 'HTMLTextAreaElement')) return 'textarea';
      if (entry?.controlKind && !KINDS.has(entry.controlKind)) return 'unsupported';
      if (entry?.controlKind) return entry.controlKind;
      if (entry?.pickerType) return 'date';
      if (isInput(el)) return 'text';
      return el?.isContentEditable ? 'contenteditable' : 'unsupported';
    }
    function stop(ctx, writing = false) {
      if (!ctx.nodes.length || ctx.nodes.some(el => el.isConnected === false)) return 'element_disconnected';
      if (ctx.nodes.some(el => isInput(el) && ['file', 'password', 'hidden', 'submit', 'reset', 'button', 'image'].includes(el.type))) return 'unsupported_control';
      if (ctx.kind === 'checkbox' && ctx.el.type !== 'checkbox') return 'unsupported_control';
      if (ctx.kind === 'radio' && ctx.nodes.some(el => ctx.customRadio ? isInput(el) : el.type !== 'radio')) return 'unsupported_control';
      if (ctx.kind !== 'radio' && ctx.nodes.some(el => el.disabled)) return 'control_disabled';
      if (['custom-select', 'cascader'].includes(ctx.kind)) {
        const root = scope.ResumeProCustomControls?.describe(ctx.entry).root;
        if (!root?.isConnected || !root.contains(ctx.el)) return 'element_disconnected';
        if (root.getAttribute('aria-disabled') === 'true' || root.matches(antd(root, '.ant-select-disabled, .ant-cascader-disabled, .is-disabled, .arco-select-disabled, .arco-cascader-disabled, .layui-select-disabled'))) return 'control_disabled';
      }
      if (ctx.kind === 'date' && ['date', 'month', 'datetime-local', 'time', 'week'].includes(ctx.el.type) && ctx.el.readOnly) return 'unsupported_control';
      if (ctx.options.isCurrent && !ctx.options.isCurrent()) return 'cancelled';
      if (ctx.userEdited) { ctx.options.beforeWrite?.(true); return 'value_changed'; }
      if (writing && !ctx.wrote && ctx.options.beforeWrite && !ctx.options.beforeWrite()) return 'value_changed';
      return '';
    }
    function markWrite(ctx) {
      if (!ctx.wrote) ctx.options.onWrite?.();
      ctx.wrote = true;
    }
    function write(el, value, ctx) {
      if (ctx) markWrite(ctx);
      if (deps.writeValue) return deps.writeValue(el, value);
      const descriptor = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
      if (descriptor?.set) descriptor.set.call(el, value); else el.value = value;
    }
    function input(el) {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    // 像打字一样写进联想框（#301）：keydown、写值、input、keyup，不派发 change（真打字要到失焦才有）。
    // 只在 keyup 后才去查建议的（YUI）也收得到。一次写整段字。键码只给字母和数字，别的给 0：
    // 回车、Tab、Esc、方向键的键码会被联想框当成选中或收起。
    function type(el, value, ctx) {
      const View = el.ownerDocument?.defaultView;
      const ViewKeyboardEvent = View?.KeyboardEvent || (typeof KeyboardEvent === 'function' ? KeyboardEvent : null);
      const last = Array.from(String(value ?? '')).pop() || '';
      const code = /^[0-9a-z]$/i.test(last) ? last.toUpperCase().charCodeAt(0) : 0;
      const key = name => ViewKeyboardEvent && el.dispatchEvent(new ViewKeyboardEvent(name, { key: last || 'Unidentified', keyCode: code, which: code, bubbles: true, cancelable: true }));
      key('keydown');
      write(el, value, ctx);
      const ViewInputEvent = View?.InputEvent || (typeof InputEvent === 'function' ? InputEvent : null);
      el.dispatchEvent(ViewInputEvent ? new ViewInputEvent('input', { bubbles: true, inputType: 'insertText', data: String(value ?? '') })
        : new (View?.Event || Event)('input', { bubbles: true }));
      key('keyup');
    }
    function focus(el) { if (deps.focus) deps.focus(el); else el.focus?.(); }
    function blur(el) { if (deps.blur) deps.blur(el); else el.blur?.(); }
    function click(el, ctx, committing = false) {
      const reason = stop(ctx, true);
      if (reason) return reason;
      const disabled = () => el.disabled || Boolean(el.closest?.(antd(el, '[aria-disabled="true"], .ant-select-item-option-disabled, .ant-cascader-menu-item-disabled, .is-disabled, .arco-select-option-disabled, .arco-cascader-list-item-disabled')));
      if (disabled()) return 'control_disabled';
      // ARIA/component markup does not authorize form submission or reset.
      const submits = () => ['BUTTON', 'INPUT'].includes(el.tagName) && ['submit', 'reset', 'image'].includes(el.type)
        && !(el.tagName === 'BUTTON' && !el.hasAttribute('type') && !el.form);
      const navigates = () => Boolean(el.closest?.('a[href], area[href]'));
      if (submits() || navigates()) return 'unsupported_control';
      const ViewMouseEvent = el.ownerDocument?.defaultView?.MouseEvent || (typeof MouseEvent === 'function' ? MouseEvent : null);
      const ViewPointerEvent = el.ownerDocument?.defaultView?.PointerEvent || (typeof PointerEvent === 'function' ? PointerEvent : null);
      // Framework options may commit on pointerdown/mousedown, before click.
      // Account for that attempt before dispatching, preserving native activation.
      if (committing && ['custom-select', 'cascader'].includes(ctx.kind)) markWrite(ctx);
      const dispatch = event => {
        const previous = ctx.activating;
        if (committing && ['custom-select', 'cascader'].includes(ctx.kind)) ctx.activating = true;
        try { el.dispatchEvent(event); } finally { ctx.activating = previous; }
      };
      if (ViewPointerEvent) dispatch(new ViewPointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
      if (ViewMouseEvent) dispatch(new ViewMouseEvent('mousedown', { bubbles: true }));
      // A page handler can replace the target, or a cancellation can happen on mousedown.
      const afterPress = stop(ctx, true);
      if (afterPress || el.isConnected === false) return afterPress || 'element_disconnected';
      if (submits() || navigates()) return 'unsupported_control';
      if (disabled()) return 'control_disabled';
      if (ViewPointerEvent) dispatch(new ViewPointerEvent('pointerup', { bubbles: true, pointerType: 'mouse' }));
      if (ViewMouseEvent) dispatch(new ViewMouseEvent('mouseup', { bubbles: true }));
      const beforeActivation = stop(ctx, true);
      if (beforeActivation || el.isConnected === false) return beforeActivation || 'element_disconnected';
      if (submits() || navigates()) return 'unsupported_control';
      if (disabled()) return 'control_disabled';
      // Native activation emits trusted input/change even when .click() itself is
      // synthetic. Exclude only this synchronous activation from user-edit tracking.
      // Custom option handlers can change type/form/href during click dispatch.
      // Cancel default activation while still letting selection handlers run.
      // Native checkbox/radio activation keeps its normal toggle behavior.
      const preventDefaultActivation = event => event.preventDefault();
      const cancelDefault = el.tagName === 'BUTTON' || ['custom-select', 'cascader'].includes(ctx.kind);
      if (cancelDefault) el.addEventListener('click', preventDefaultActivation, { capture: true });
      ctx.activating = true;
      // SVG icons (#269 北森的单选圈) have no click(); dispatch the same activation event instead.
      try {
        if (committing) markWrite(ctx);
        if (typeof el.click === 'function') el.click();
        else if (ViewMouseEvent) el.dispatchEvent(new ViewMouseEvent('click', { bubbles: true, cancelable: true }));
      } finally {
        if (cancelDefault) el.removeEventListener('click', preventDefaultActivation, true);
        ctx.activating = false;
      }
      return '';
    }
    // Observe the relevant subtree and also sample properties: .value/.checked changes
    // do not necessarily produce DOM mutations. Both waits have a hard deadline.
    function waitUntil(ctx, root, read, ready, limit = timeoutMs) {
      return new Promise(resolve => {
        const start = now(); let timer, observer, finished = false;
        const done = answer => { if (finished) return; finished = true; clearTimeout(timer); observer?.disconnect(); resolve(answer); };
        const check = () => { try {
          const reason = stop(ctx);
          if (reason) return done({ reason });
          const value = read();
          if (ready(value)) return done({ value });
          if (now() - start >= limit) return done({ reason: 'verification_timeout' });
          clearTimeout(timer); timer = setTimeout(check, 20);
        } catch { done({ reason: 'operation_failed' }); }
        };
        const Observer = root?.ownerDocument?.defaultView?.MutationObserver || (typeof MutationObserver === 'function' ? MutationObserver : null);
        if (Observer && root) { observer = new Observer(check); observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true }); }
        check();
      });
    }
    async function verify(ctx, accepted, inspect) {
      let stableStart = now(); let previous = null;
      const answer = await waitUntil(ctx, ctx.el.parentElement || ctx.el, () => {
        const same = accepted();
        const verdict = same && inspect ? inspect() : null;
        const signature = `${same}:${verdict?.reason || ''}`;
        if (signature !== previous) { stableStart = now(); previous = signature; }
        return { same, verdict };
      }, () => now() - stableStart >= settleMs(), Math.max(timeoutMs, settleMs() + 100));
      if (answer.reason) return result(false, answer.reason, ctx);
      if (!answer.value.same) return result(false, ctx.acceptedOnce ? 'value_reverted' : 'value_not_committed', ctx);
      if (answer.value.verdict && !answer.value.verdict.ok) return result(false, answer.value.verdict.reason, ctx);
      return result(true, '', ctx);
    }

    // 框里的字和要填的一样：逐字相同，或宿主认可的同一个值（电话框自己加了空格、短横）。
    function shows(el, expected) {
      const current = String(el.value ?? '');
      return current === expected || Boolean(deps.sameTextValue?.(el, current, expected));
    }

    // 写入被拒时框里剩下的是什么（#399 #405）：空、写之前的值或别的值。只给这三个词，不带值本身。
    const rejected = reason => ['value_not_committed', 'value_reverted'].includes(reason);
    function leftover(el, previous) {
      const now = String(el.value ?? '');
      return !now.trim() ? 'empty' : now === previous ? 'previous' : 'other';
    }
    // 页面把数字以外的字滤掉了（10k-15k 剩 1015，面议剩空）：剩下的只有数字、小数点和短横，是写进去的字按顺序去掉一些得到的。
    // 写进去的有数字、却被整段清空的，是页面不收这种写法，不算。
    function droppedNonDigits(left, typed) {
      if (left === typed || !/^[\d.-]*$/.test(left) || (!left && /\d/.test(typed))) return false;
      let index = 0;
      for (const char of typed) if (char === left[index]) index += 1;
      return index === left.length;
    }

    // shown：联想框点了建议、框里已经是要填的字，只是组件没有标出选中状态（#299 51job）：不再写，按文本框核对。
    async function text(ctx, value, shown = false) {
      if (!deps.runTextLifecycle) return result(false, 'unsupported_control', ctx);
      const previous = String(ctx.el.value ?? '');
      // #399 #405 一键填写时，写之前由宿主按框的要求整理：日期框按占位提示的格式换写法，type=number 只写能放心取出的数字，取不出就不写。
      const prepared = shown || !ctx.options.prepare || !deps.prepareText ? { value } : deps.prepareText(ctx.el, value);
      if (prepared.reason) return result(false, prepared.reason, ctx);
      if (prepared.dayDefaulted) ctx.observed = { ...ctx.observed, dayDefaulted: true };
      let typed = String(prepared.value ?? '');
      let expected = deps.normalizeText(ctx.el, typed);
      const guard = () => !stop(ctx, true);
      const didWrite = () => markWrite(ctx);
      // #301 #417 只读的框：聚焦之前记下看得见的对话框、浮层，写不上时收起聚焦后网页打开的那一块（见末尾）。
      const readonly = !shown && ctx.el.readOnly === true;
      const layersBefore = readonly ? scope.ResumeProCustomControls?.openLayers?.(ctx.el.ownerDocument, visible) || null : null;
      if (!shown && !await deps.runTextLifecycle(ctx.el, typed, false, guard, didWrite)) return result(false, stop(ctx) || 'value_changed', ctx);
      ctx.acceptedOnce = shows(ctx.el, expected);
      await deps.waitTextCommit();
      let stopped = stop(ctx);
      if (stopped) return result(false, stopped, ctx);
      let verdict = deps.inspectText(ctx.el, expected, ctx.acceptedOnce);
      if (!verdict.ok && ['validation_not_cleared', 'framework_state_unsynced'].includes(verdict.reason)) {
        stopped = stop(ctx);
        if (stopped) return result(false, stopped, ctx);
        await deps.replayFocusBlur(ctx.el);
        await deps.waitTextCommit();
        stopped = stop(ctx);
        if (stopped) return result(false, stopped, ctx);
        verdict = deps.inspectText(ctx.el, expected, String(ctx.el.value ?? '') === expected);
      }
      // #301 写不进的普通文本框（大易 hotjob 的学校、专业，51job）：可能是只认从建议里选的联想框，框上没有任何下拉标记。
      // 保持焦点、带按键再打一次字，等贴着它新冒出来的建议，只点和要填的字相同的一项；点了或者没有建议框，都失焦再核对。
      // 只在框里换回了写之前的字时再试：这类框没选就还原。改成别的字的（页面改了格式）不再等建议，免得每个框白等。
      if (!verdict.ok && !shown && verdict.reason === 'value_not_committed' && ctx.kind === 'text' && !deps.prefersSequential(ctx.el)
        && String(ctx.el.value ?? '') === previous && scope.ResumeProCustomControls?.suggest) {
        const picked = await scope.ResumeProCustomControls.suggest(ctx, typed, host);
        stopped = stop(ctx);
        if (stopped) return result(false, stopped, ctx);
        if (picked.accepted || picked.typed) {
          // 建议里的字和要填的只差大小写、空格、括号时，框里显示的是建议的写法。
          const current = String(ctx.el.value ?? '');
          if (helpers?.normalizeText?.(current) === helpers?.normalizeText?.(expected)) expected = current;
          // 只打了字、没点建议的，失焦后被换掉仍算没写上，不算被退回。
          const committed = Boolean(picked.accepted) && shows(ctx.el, expected);
          blur(ctx.el);
          await deps.waitTextCommit();
          stopped = stop(ctx);
          if (stopped) return result(false, stopped, ctx);
          ctx.acceptedOnce = committed;
          verdict = deps.inspectText(ctx.el, expected, committed);
        } else if (picked.reason) verdict = { ok: false, reason: picked.reason };
      }
      let after = rejected(verdict.reason) ? leftover(ctx.el, previous) : '';
      let left = String(ctx.el.value ?? '');
      if (!verdict.ok && !shown && deps.prefersSequential(ctx.el) && ['value_not_committed', 'value_reverted'].includes(verdict.reason)) {
        if (!await deps.runTextLifecycle(ctx.el, typed, true, guard, didWrite)) return result(false, stop(ctx) || 'value_changed', ctx);
        const committed = shows(ctx.el, expected);
        await deps.waitTextCommit();
        stopped = stop(ctx);
        if (stopped) return result(false, stopped, ctx);
        verdict = deps.inspectText(ctx.el, expected, committed);
        // 恢复原值之前记下页面留下的。
        after = rejected(verdict.reason) ? leftover(ctx.el, previous) : '';
        left = String(ctx.el.value ?? '');
        // 框里显示的是同一个号码（页面改了格式）时不恢复原值。
        if (!verdict.ok && ['value_not_committed', 'value_reverted'].includes(verdict.reason) && !shows(ctx.el, expected) && guard()) {
          write(ctx.el, previous); deps.dispatchTextInput(ctx.el, previous);
          ctx.el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      // #405 inputmode 是数字的框照原样写了，页面没收下：改写能放心取出的数字（175cm → 175）；
      // 取不出的（10k-15k）只在页面滤掉了数字以外的字时不留滤剩的字（1015），恢复原值，报只能填数字。
      // 页面没有滤字、是别的原因不收的（自己改了格式、整段清空），照原来的原因报，框里的不动。
      if (!verdict.ok && rejected(verdict.reason) && 'numeric' in prepared && guard()
        && (prepared.numeric !== null || droppedNonDigits(left, typed))) {
        if (prepared.numeric === null) {
          if (String(ctx.el.value ?? '') !== previous) {
            write(ctx.el, previous); deps.dispatchTextInput(ctx.el, previous);
            ctx.el.dispatchEvent(new Event('change', { bubbles: true }));
          }
          return result(false, 'format_mismatch', ctx);
        }
        typed = prepared.numeric;
        expected = deps.normalizeText(ctx.el, typed);
        if (!await deps.runTextLifecycle(ctx.el, typed, false, guard, didWrite)) return result(false, stop(ctx) || 'value_changed', ctx);
        const committed = shows(ctx.el, expected);
        await deps.waitTextCommit();
        stopped = stop(ctx);
        if (stopped) return result(false, stopped, ctx);
        verdict = deps.inspectText(ctx.el, expected, committed);
        after = rejected(verdict.reason) ? leftover(ctx.el, previous) : '';
        // 数字也没收下：和逐字重写那条一样恢复原值，不留这次写的。
        if (!verdict.ok && rejected(verdict.reason) && !shows(ctx.el, expected) && String(ctx.el.value ?? '') !== previous && guard()) {
          write(ctx.el, previous); deps.dispatchTextInput(ctx.el, previous);
          ctx.el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      // #301 #417 只读的框写不上：多半是网页自己的选择框（智联的城市、学校、专业，点开是对话框、el-popover 或自制浮层），要在网页里选。
      // 照样先写过了（v-model 绑定的只读框、读输入框值的组件写得上）；写不上的单独报，聚焦时网页打开的收起来。
      if (readonly && !verdict.ok && rejected(verdict.reason)) {
        // 收起之前让宿主记下冒出过弹层（诊断的 overlay=），收起以后它就看不到了。
        if (layersBefore) { ctx.options.beforeDismiss?.(); await scope.ResumeProCustomControls.dismissOpened?.(ctx, layersBefore, host); }
        return result(false, 'readonly_picker', ctx, after ? { after } : {});
      }
      // 页面还提示无效的也留着复核：提示可能要等后面的字段填完才消（开始 / 结束时间）。
      if (verdict.ok || verdict.reason === 'validation_not_cleared') checks.set(ctx.el, { ctx, previous,
        accepted: () => shows(ctx.el, expected),
        inspect: () => deps.inspectText(ctx.el, expected, true) });
      return result(verdict.ok, verdict.reason, ctx, after ? { after } : {});
    }

    // 联想框按文本框填完：建议框常常还开着，或打字后稍后才弹出（#299 51job），会挡住后面的字段。
    // 给这个框发一个 Tab 键收起它（不点页面，焦点也不动），再按文本框核对一次。
    // Element's autocomplete closes its suggestions on Tab (Element UI 2 and Element Plus alike).
    // The key starts at the box being filled and bubbles like a real one: Element UI 2 listens on the
    // wrapper around the box. Unlike a real Tab it moves no focus and types nothing.
    function pressTab(el) {
      const ViewKeyboardEvent = el.ownerDocument?.defaultView?.KeyboardEvent || (typeof KeyboardEvent === 'function' ? KeyboardEvent : null);
      if (!ViewKeyboardEvent) return;
      el.dispatchEvent(new ViewKeyboardEvent('keydown', { key: 'Tab', code: 'Tab', keyCode: 9, which: 9, bubbles: true, cancelable: true }));
    }
    // rc-picker closes when its input loses focus to somewhere outside the picker, and commits
    // nothing when the text did not change. Not Esc: it bubbles to an AntD Modal around the
    // form, which closes on Esc and drops whatever was typed in it. When the page has no focus
    // (一键填写 clicked in the side panel) blur() moves focus without any event, so the
    // focusout React listens for is sent here.
    function leavePicker(el) {
      let left = false;
      const seen = () => { left = true; };
      el.addEventListener('focusout', seen, true);
      try { blur(el); } finally { el.removeEventListener('focusout', seen, true); }
      const View = el.ownerDocument?.defaultView;
      if (!left && View?.FocusEvent && el.ownerDocument.activeElement !== el) el.dispatchEvent(new View.FocusEvent('focusout', { bubbles: true }));
    }

    async function freeText(ctx, value, shown) {
      const typed = await text(ctx, value, shown);
      // Only a filled box gets its suggestions closed; after a failure the page is left alone.
      if (!typed.ok || !ctx.el?.isConnected || stop(ctx)) return typed;
      pressTab(ctx.el);
      const saved = checks.get(ctx.el);
      if (!saved) return typed;
      const again = await verify(ctx, saved.accepted, saved.inspect);
      if (!again.ok && again.reason !== 'validation_not_cleared') checks.delete(ctx.el);
      return again;
    }

    async function operate(target, desiredValue, options = {}) {
      const el = target?.kind === 'element' ? target.element : target;
      const nodes = target?.kind === 'radio' ? target.elements || [] : el ? [el] : [];
      // PR1 accepts the shared hint contract for future adapters. Native types and
      // the actual AntD panel remain authoritative; hints cannot prescribe actions.
      const ctx = { el: nodes[0], nodes, entry: target, options, hints: cleanHints(options.hints), kind: kindOf(target, el), wrote: false, userEdited: false };
      // #301 换了前缀的 antd：操作开始时按页面现在的样子重看前缀，见 antd-prefix.js。
      scope.ResumeProAntdPrefix?.prefixes(ctx.el, { fresh: true });
      // #269 自制单选组：选项是 div（北森 phoenix-radio），没有 input。
      ctx.customRadio = ctx.kind === 'radio' && nodes.length > 0 && nodes.every(node => !isInput(node));
      if (ctx.customRadio && !scope.ResumeProCustomControls) return result(false, 'unsupported_control', ctx);
      ctx.startedEditable = isInput(ctx.el) && !ctx.el.readOnly;
      const custom = ['custom-select', 'cascader'].includes(ctx.kind);
      if (!KINDS.has(ctx.kind) || (custom && !scope.ResumeProCustomControls)) return result(false, 'unsupported_control', ctx);
      if (custom) ctx.nodes = Array.from(new Set([...nodes, scope.ResumeProCustomControls.describe(ctx.entry).root].filter(Boolean)));
      if (ctx.el && typeof ctx.el === 'object') checks.delete(ctx.el);
      const refused = stop(ctx, true);
      if (refused) return result(false, refused, ctx);
      const track = event => {
        if (!event.isTrusted || ctx.activating) return;
        if (custom && event.currentTarget === ctx.el.ownerDocument
          && !ctx.entry.root?.contains(event.target) && !ctx.el.contains(event.target) && !ctx.popup?.contains(event.target)) return;
        ctx.userEdited = true;
      };
      const watched = custom ? Array.from(new Set([...nodes, ctx.entry.root].filter(Boolean))) : nodes;
      if (custom && ctx.el.ownerDocument) watched.push(ctx.el.ownerDocument);
      for (const node of watched) for (const type of ['input', 'change', 'keydown', 'pointerdown']) node.addEventListener?.(type, track, true);
      try {
        if (['text', 'textarea'].includes(ctx.kind) && !['range', 'color'].includes(ctx.el.type)) return await text(ctx, desiredValue);
        const direct = ['week', 'range', 'color'].includes(ctx.el.type);
        if (ctx.kind === 'date' && ctx.entry.pickerType === 'antd' && ctx.el.ownerDocument) {
          const doc = ctx.el.ownerDocument;
          ctx.popupsBefore = new Set(Array.from(doc.querySelectorAll(antd(doc, '.ant-picker-dropdown'))).filter(visible));
          ctx.alreadyOpen = doc.activeElement === ctx.el && ctx.popupsBefore.size === 1;
        }
        // 聚焦之前记下看得见的弹层（见 custom-controls.js 的 shownLayers）：有的下拉、日历一聚焦就展开，聚焦后再记就把它算成了原有的。
        // 只读日期框也走 custom-controls 的日历路径（#301 智联 Element 日期一聚焦就打开）。
        if (custom || (ctx.kind === 'date' && ctx.el?.readOnly)) ctx.popupsBeforeFocus = scope.ResumeProCustomControls?.visiblePopups?.(ctx.entry, visible) || null;
        // #429 区间日期的两个框由 operateRange 自己去点：先不聚焦，Element 一聚焦就打开日历，两头已经填好时只核对、不该打开。
        if (!direct && !(ctx.kind === 'date' && rangeBoxes(ctx))) focus(ctx.el);
        await delay(0);
        const afterFocus = stop(ctx, true);
        if (afterFocus) return result(false, afterFocus, ctx);
        let accepted;
        if (custom) {
          const outcome = await scope.ResumeProCustomControls.run(ctx, desiredValue, host);
          // #269 联想输入框（智联学校名称 el-autocomplete）：本来就允许直接输入，建议里没有时按文本框填写并核对。
          // 点了建议、组件没标出选中状态，但框里已经是要填的字（#299）：不算没选上，按文本框核对。
          if (outcome.reason && scope.ResumeProCustomControls.acceptsFreeText(ctx) && !stop(ctx)) {
            const shown = outcome.reason === 'selection_not_committed' && Boolean(deps.normalizeText)
              && String(ctx.el.value ?? '') === deps.normalizeText(ctx.el, desiredValue);
            if (shown || ['no_option_match', 'options_not_rendered', 'options_timeout'].includes(outcome.reason)) return await freeText(ctx, desiredValue, shown);
          }
          if (outcome.reason) return result(false, outcome.reason, ctx);
          accepted = outcome.accepted;
          // 联想框里打过字：随后才到的建议会再弹出来挡住后面的字段，发一个 Tab 收起（Element 收到后不再显示建议）。
          if (outcome.closeSuggestions) pressTab(ctx.el);
          if (outcome.dayDefaulted) ctx.observed = { ...ctx.observed, dayDefaulted: true };
        } else if (ctx.kind === 'radio' && ctx.customRadio) {
          const custom = scope.ResumeProCustomControls;
          const text = node => String(node.textContent || '').replace(/\s+/g, ' ').trim();
          const disabled = node => node.getAttribute('aria-disabled') === 'true' || /(?:^|[-_])disabled$/i.test(String(node.className || ''))
            || Boolean(node.querySelector('[aria-disabled="true"]'));
          const index = helpers?.findSelectOptionIndex?.(nodes.map(node => ({ value: text(node), text: text(node), disabled: disabled(node) })), desiredValue) ?? -1;
          const chosen = nodes[index];
          if (!chosen) return result(false, 'no_option_match', ctx);
          if (!custom.isChecked(chosen)) { const reason = click(custom.optionTarget(chosen), ctx, true); if (reason) return result(false, reason, ctx); }
          // 只认组件自己标出的选中状态（--checked、aria-checked），并且组里只有这一项选中。
          accepted = () => chosen.isConnected && custom.isChecked(chosen) && nodes.every(node => node === chosen || !custom.isChecked(node));
        } else if (ctx.kind === 'radio') {
          const index = helpers?.findSelectOptionIndex?.(nodes.map(node => ({value:node.value,text:deps.radioLabel?.(node) || node.value,disabled:node.disabled})), desiredValue) ?? -1;
          const chosen = nodes[index];
          if (!chosen) return result(false, 'no_option_match', ctx);
          const reason = click(chosen, ctx, true); if (reason) return result(false, reason, ctx);
          // A controlled component may reject activation. Never force checked after
          // its handler restored state: DOM assignment would create a false success.
          accepted = () => chosen.checked === true;
        } else if (ctx.kind === 'checkbox') {
          const value = String(desiredValue).trim().toLowerCase();
          if (!['true', 'false', '1', '0', '是', '否'].includes(value)) return result(false, 'no_option_match', ctx);
          const checked = ['true', '1', '是'].includes(value);
          if (Boolean(ctx.el.checked) !== checked) { const reason = click(ctx.el, ctx, true); if (reason) return result(false, reason, ctx); }
          accepted = () => Boolean(ctx.el.checked) === checked;
        } else if (ctx.kind === 'native-select' && ctx.el.multiple) {
          // #429 原生多选：要选的几项（splitMultipleValues，整段正好是一个选项时不拆）各对一项，有一项对不上就都不动；选中的正好是这几项。
          const options = Array.from(ctx.el.options).map(option => ({ value: option.value, text: option.text, disabled: option.disabled }));
          const parts = helpers?.splitMultipleValues?.(desiredValue, options) ?? [String(desiredValue ?? '').trim()].filter(Boolean);
          const indexes = parts.map(part => helpers?.findSelectOptionIndex?.(options, part) ?? -1);
          if (!parts.length || indexes.some(index => index < 0)) return result(false, 'no_option_match', ctx);
          const wanted = new Set(indexes);
          markWrite(ctx);
          Array.from(ctx.el.options).forEach((option, index) => { option.selected = wanted.has(index); });
          input(ctx.el);
          const texts = Array.from(wanted, index => ctx.el.options[index].text);
          accepted = () => Array.from(ctx.el.options).every((option, index) => option.selected === wanted.has(index))
            && Array.from(wanted).every((index, at) => ctx.el.options[index]?.text === texts[at]);
        } else if (ctx.kind === 'native-select') {
          const index = helpers?.findSelectOptionIndex?.(Array.from(ctx.el.options).map(option => ({value:option.value,text:option.text,disabled:option.disabled})), desiredValue) ?? -1;
          if (index < 0) return result(false, 'no_option_match', ctx);
          const chosenValue = ctx.el.options[index].value;
          const chosenText = ctx.el.options[index].text;
          write(ctx.el, chosenValue, ctx); ctx.el.selectedIndex = index; input(ctx.el);
          accepted = () => ctx.el.selectedIndex === index && ctx.el.options[index]?.value === chosenValue && ctx.el.options[index]?.text === chosenText;
        } else if (ctx.kind === 'date') {
          const date = await operateDate(ctx, desiredValue);
          if (date.typeText) return await text(ctx, desiredValue);
          if (date.reason) return result(false, date.reason, ctx, date.observed);
          if (date.dayDefaulted) ctx.observed = { ...ctx.observed, dayDefaulted: true };
          accepted = date.accepted || (() => {
            const display = String(ctx.el.value ?? '');
            // The real Liepin picker displays YYYY年MM月 after calendar commit.
            // Compare the actual panel's date precision, preserving its display format.
            const canonical = date.mode === 'year' ? display.match(/^\s*(\d{4})(?:年)?\s*$/)?.[1]
              : date.mode ? helpers?.normalizeDateValue?.(display, date.mode) : display;
            return canonical === date.expected;
          });
        } else if (ctx.kind === 'contenteditable') {
          const expected = String(desiredValue ?? ''); markWrite(ctx); ctx.el.textContent = expected;
          ctx.el.dispatchEvent(new Event('input', { bubbles: true })); accepted = () => ctx.el.textContent === expected;
        } else {
          const expected = String(desiredValue ?? ''); write(ctx.el, expected, ctx); input(ctx.el);
          accepted = () => ctx.el.value === expected;
        }
        ctx.acceptedOnce = accepted();
        if (!direct) blur(ctx.el);
        const inspect = ['date', 'custom-select', 'cascader'].includes(ctx.kind) && !direct && deps.inspectText
          ? () => deps.inspectText(ctx.el, String(ctx.el.value ?? ''), true) : null;
        const verified = await verify(ctx, accepted, inspect);
        if (verified.ok || verified.reason === 'validation_not_cleared') checks.set(ctx.el, { ctx, accepted, inspect });
        return verified;
      } catch {
        // Page exceptions are untrusted and can contain resume data. Only a fixed code escapes.
        return result(false, stop(ctx) || 'operation_failed', ctx);
      } finally {
        for (const node of watched) for (const type of ['input', 'change', 'keydown', 'pointerdown']) node.removeEventListener?.(type, track, true);
      }
    }

    // 题目和占位提示：一段起止取哪一头看它们（见 ai-helpers.js 的 rangeDateValue）。
    const dateHint = ctx => [ctx.entry?.binding?.label, ctx.el?.getAttribute?.('placeholder'), ctx.el?.getAttribute?.('aria-label')].filter(Boolean).join(' ');
    async function operateDate(ctx, raw) {
      const boxes = rangeBoxes(ctx);
      const ranged = boxes ? await operateRange(ctx, raw, boxes) : null;
      if (ranged && !ranged.single) return ranged;
      // 照原来只填这一个框：和原来一样先聚焦（区间的框进来时没有聚焦，见 operate）。
      if (ranged?.single) focus(ctx.el);
      // #301 日期题收到一段起止（「2019.09-2023.06」）：题目写明开始还是结束时取那一头，各种日期控件都一样。
      raw = helpers?.rangeDateValue?.(raw, dateHint(ctx)) ?? raw;
      if (['date', 'month', 'datetime-local', 'time', 'week'].includes(ctx.el.type)) {
        const expected = helpers?.normalizeDateValue?.(raw, ctx.el.type) ?? String(raw ?? '');
        if (!expected) return { reason: 'invalid_date' };
        write(ctx.el, expected, ctx); input(ctx.el); return { expected };
      }
      // An AntD picker often starts readonly, then opens an editable input. Writing
      // that input does not commit rc-picker state; choose an actual calendar cell.
      if (ctx.entry.pickerType === 'antd') return await antDate(ctx, raw);
      if (ctx.entry.pickerType === 'jiandaoyun') return await jdyDate(ctx, raw);
      // #269 只读的日期框（智联 Element 日期选择器）：不能打字，按日历逐级点，和北森的日历共用一套。
      if (ctx.el.readOnly && scope.ResumeProCustomControls?.run) {
        const outcome = await scope.ResumeProCustomControls.run(ctx, raw, host);
        return outcome.reason ? { reason: outcome.reason } : { accepted: outcome.accepted, dayDefaulted: outcome.dayDefaulted };
      }
      const expected = helpers?.normalizeDateValue?.(raw, ctx.entry.pickerInputType || 'date') ?? String(raw ?? '');
      if (ctx.el.readOnly) return { reason: 'unsupported_control' };
      if (typeof ctx.el.click === 'function') {
        const reason = click(ctx.el, ctx); if (reason) return { reason };
      }
      // Preserve the existing generic/Element picker opening window. Recheck the
      // target and user edits after the page has had time to render its popup.
      await delay(150);
      const afterOpening = stop(ctx, true);
      if (afterOpening) return { reason: afterOpening };
      write(ctx.el, expected, ctx); input(ctx.el);
      return { expected };
    }

    async function antDate(ctx, raw) {
      const doc = ctx.el.ownerDocument;
      if (!doc?.querySelectorAll) return { reason: 'unsupported_control' };
      const before = ctx.popupsBefore || new Set(Array.from(doc.querySelectorAll(antd(doc, '.ant-picker-dropdown'))).filter(visible));
      const reason = click(ctx.el, ctx); if (reason) return { reason };
      const opened = await waitUntil(ctx, doc.documentElement, () => {
        const all = Array.from(doc.querySelectorAll(antd(doc, '.ant-picker-dropdown'))).filter(visible);
        const added = all.filter(node => !before.has(node));
        return added.length === 1 ? added[0] : ctx.alreadyOpen && all.length === 1 ? all[0] : null;
      }, popup => Boolean(popup));
      if (opened.reason) return { reason: opened.reason };
      const popup = opened.value;
      ctx.observed = { library: 'antd', popupRole: 'calendar' };
      // 带时间的面板（TimePicker、showTime 的日期框）这里只会点年、月、日：收起日历，框能打字就按文本框打字，
      // 和没认出 antd 时一样（#301 换了前缀的 antd 5 这样能填上；antd 4 失焦时不收打的字，照样报没写上）；框只读的报控件暂不支持。
      // 带时间的区间日期（RangePicker showTime）不打字：一次只写得进开始或结束一个框，填不成一个区间，
      // 和不带时间的区间日期一样报控件暂不支持。
      const timed = Boolean(popup.querySelector(antd(popup, '.ant-picker-time-panel')));
      const range = Boolean(ctx.el.closest?.(antd(ctx.el, '.ant-picker-range')));
      // 页面异常也按失败收尾；只把固定的原因码交出去。
      const picked = timed ? { reason: 'unsupported_control', typeText: !range }
        : await antDatePick(ctx, raw, popup).catch(() => ({ reason: 'operation_failed' }));
      // 选不成时收起自己点开的日历，免得挡住后面的字段：让输入框失焦（见 leavePicker），组件里的值不变。
      // 不按键、不点页面别处；原本就开着的、用户停下或改了内容的不动。
      // 刚在日历里按下过鼠标时，rc-picker 到下一帧才认失焦，这一次它不收：0.1 秒内没开始收起就再失焦一次。
      // 收起有约 0.2 秒的动画，最多等 0.6 秒它走完再交还，免得再点开同一个日历时把还在淡出的它当成原本就开着的。
      if (picked.reason && !before.has(popup) && !stop(ctx) && popup.isConnected && visible(popup)) {
        const gone = () => !popup.isConnected || !visible(popup);
        leavePicker(ctx.el);
        const leaving = await waitUntil(ctx, doc.documentElement, () => gone() || Array.from(popup.classList).some(token => /-leave$/.test(token)), Boolean, 100);
        if (leaving.reason === 'verification_timeout' && !stop(ctx)) leavePicker(ctx.el);
        await waitUntil(ctx, doc.documentElement, gone, Boolean, 600);
      }
      // 用户停下、改了内容的，或框是只读的，不打字。
      if (picked.typeText && (stop(ctx) || ctx.el.readOnly)) return { reason: stop(ctx) || picked.reason };
      return picked;
    }
    // range：区间日期的弹层（#429），并排两个面板，年、月按钮用左边那个（见 antRange）。
    async function antDatePick(ctx, raw, popup, range = false) {
      const find = (node, selector) => node.querySelector(antd(node, selector));
      if (popup.querySelectorAll(antd(popup, '.ant-picker-panel')).length !== (range ? 2 : 1)) return { reason: 'unsupported_control' };
      const mode = find(popup, '.ant-picker-month-panel') ? 'month' : find(popup, '.ant-picker-year-panel') ? 'year' : 'date';
      const expected = mode === 'year' ? String(raw).match(/^\s*(\d{4})(?:年|\b)/)?.[1] : helpers?.normalizeDateValue?.(raw, mode);
      if (!expected || !(mode === 'year' ? /^\d{4}$/ : mode === 'month' ? /^\d{4}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}$/).test(expected)) return { reason: 'invalid_date' };
      const year = Number(expected.slice(0, 4));
      if (year < 1900 || year > 2100) return { reason: 'invalid_date' };
      const take = async (node, committing = false) => {
        if (!node || node.disabled || node.closest?.(antd(node, '.ant-picker-cell-disabled'))) return 'no_option_match';
        return click(node.querySelector?.(antd(node, '.ant-picker-cell-inner')) || node, ctx, committing);
      };
      if (mode !== 'year') {
        const why = await take(find(popup, '.ant-picker-year-btn')); if (why) return { reason: why };
        const panel = await waitUntil(ctx, popup, () => find(popup, '.ant-picker-year-panel'), Boolean);
        if (panel.reason) return { reason: panel.reason };
      }
      let selected = false;
      const started = now();
      for (let step = 0; step < 24 && now() - started < timeoutMs; step++) {
        const panel = find(popup, '.ant-picker-year-panel');
        if (!panel) return { reason: 'selection_not_committed' };
        const cell = panel.querySelector(`td[title="${year}"]`);
        if (cell) { const why = await take(cell, mode === 'year'); if (why) return { reason: why }; selected = true; break; }
        const years = Array.from(panel.querySelectorAll('td[title]')).map(node => Number(node.title)).filter(Number.isFinite);
        if (!years.length) return { reason: 'selection_not_committed' };
        const previous = panel.textContent;
        const why = await take(find(panel, year < Math.min(...years) ? '.ant-picker-header-super-prev-btn' : '.ant-picker-header-super-next-btn'));
        if (why) return { reason: why };
        const changed = await waitUntil(ctx, popup, () => panel.textContent, text => text !== previous);
        if (changed.reason) return { reason: changed.reason };
      }
      if (!selected) return { reason: 'verification_timeout' };
      if (mode === 'year') return { expected, mode };
      const leftYear = await waitUntil(ctx, popup, () => find(popup, '.ant-picker-year-panel'), panel => !panel);
      if (leftYear.reason) return { reason: leftYear.reason };
      if (mode === 'date' && !find(popup, '.ant-picker-month-panel')) {
        const why = await take(find(popup, '.ant-picker-month-btn')); if (why) return { reason: why };
        const month = await waitUntil(ctx, popup, () => find(popup, '.ant-picker-month-panel'), Boolean);
        if (month.reason) return { reason: month.reason };
      }
      const monthCell = find(popup, `.ant-picker-month-panel td[title="${expected.slice(0, 7)}"]`);
      const monthWhy = await take(monthCell, mode === 'month'); if (monthWhy) return { reason: monthWhy };
      if (mode === 'date') {
        // 区间的两个面板里，前一个月、后一个月露出的日子也带同样的 title：先找本月的那格。
        const day = await waitUntil(ctx, popup, () => find(popup, `.ant-picker-date-panel td.ant-picker-cell-in-view[title="${expected}"]`)
          || find(popup, `.ant-picker-date-panel td[title="${expected}"]`), Boolean);
        if (day.reason) return { reason: day.reason };
        const why = await take(day.value, true); if (why) return { reason: why };
      }
      return { expected, mode };
    }

    // #429 区间日期（RangePicker、daterange）：扫描时拆成开始、结束两个框，各是一题。组件要两头都选了才收下：
    // antd 3/4/5、Element 只选一头，弹层一收就丢了（真组件上看过）。宿主把另一头这次要填的值（options.range）一起交来，
    // 一次点开把两头填完，再分别核对两个框。轮到另一头时它的框已经是要填的值、弹层也收了，只核对。
    // 另一头没有能填的日期（没有值、写的是至今）：它的框里原来有日期的，连同那个日期一起选。框也是空的：
    // - antd 4/5 只选这一头，收起弹层看组件留没留下（网站允许只填一头，allowEmpty；antd 4 选完就收下，antd 5 收起时收下）；
    //   没留下就是要两头都有，报起止日期缺一头，组件里的值不变。
    // - 侧栏、字段卡片里手动填 Element 能打字的区间：写进这一个框，弹层开着等另一头，组件还没收下，报起止日期缺一头；
    //   再手动填另一头时开始框里已经有字，两头一起提交，那一题报填上。一键填写里另一头不会再来，Element 不收单独一头，不写。
    // - 认不出是哪家组件、框能打字的：可能一个框自己就收下，照原来只填这一个框（single），按框里的字核对。
    // - 别的不动，报起止日期缺一头。
    // 这一头写的是至今：区间日历里没有这一项，和单个日期一样报没有匹配的选项。
    function rangeBoxes(ctx) {
      const root = ctx.entry?.root;
      if (!ctx.entry?.binding?.rangePart || typeof root?.contains !== 'function' || !root.contains(ctx.el)) return null;
      const boxes = Array.from(root.querySelectorAll('input')).filter(box => !['hidden', 'checkbox', 'radio'].includes(box.type) && visible(box));
      return boxes.length === 2 && boxes.includes(ctx.el) ? boxes : null;
    }
    const pad2 = value => String(value).padStart(2, '0');
    // 拆成年、月、日，只到月的 d 是 0。认不出、年份不在 1900～2100、没有这一天的给 null。
    function dateParts(value) {
      const text = String(value ?? '').trim();
      const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(helpers?.normalizeDateValue?.(text, 'date') || '');
      const hit = day || /^(\d{4})-(\d{2})$/.exec(helpers?.normalizeDateValue?.(text, 'month') || '');
      if (!hit) return null;
      const parts = { y: Number(hit[1]), m: Number(hit[2]), d: day ? Number(day[3]) : 0 };
      const real = new Date(parts.y, parts.m - 1, parts.d || 1);
      return parts.y >= 1900 && parts.y <= 2100 && real.getMonth() === parts.m - 1 && real.getDate() === (parts.d || 1) ? parts : null;
    }
    // 框里显示的是不是这一天：只到月的不看日子，月份框显示的没有日子也算。
    function showsDate(box, want) {
      const shown = dateParts(box?.value);
      return Boolean(shown && want) && shown.y === want.y && shown.m === want.m && (!want.d || !shown.d || shown.d === want.d);
    }
    // 页面上开着的日期弹层（antd 4/5、antd 3、Element）：开着时框里的字可能还没提交。
    const CALENDAR_LAYERS = '.ant-picker-dropdown, .ant-calendar-picker-container, .el-picker-panel';
    async function operateRange(ctx, raw, boxes) {
      const own = boxes.indexOf(ctx.el), other = 1 - own;
      const hint = (entry, box) => [entry?.binding?.label, box.getAttribute('placeholder'), box.getAttribute('aria-label')].filter(Boolean).join(' ');
      const end = (value, entry, box) => String(helpers?.rangeDateValue?.(value ?? '', hint(entry, box)) ?? value ?? '').trim();
      const ownValue = end(raw, ctx.entry, ctx.el);
      if (helpers?.isPresentDate?.(ownValue)) return { reason: 'no_option_match' };
      const want = [];
      want[own] = dateParts(ownValue);
      if (!want[own]) return { reason: 'invalid_date' };
      // 另一头自己没有值时，这一头收到的一段起止（「2019.09-2023.06」）里的另一个日期就是它的。
      const partner = ctx.options.range?.entry?.element === boxes[other] ? ctx.options.range : null;
      want[other] = dateParts(partner?.value != null ? end(partner.value, partner.entry, boxes[other]) : '')
        || dateParts(helpers?.rangeDateParts?.(raw)?.[other]) || dateParts(boxes[other].value);
      if (!want[other]) {
        const typing = !boxes.some(box => box.readOnly);
        if (typing && ctx.entry.pickerType === 'generic') return { single: true };
        if (typing && ctx.entry.pickerType === 'element' && !ctx.options.prepare) {
          const typed = await typedRange(ctx, want, boxes, own);
          return { reason: typed.reason || 'range_incomplete' };
        }
        if (ctx.entry.pickerType !== 'antd') return { reason: 'range_incomplete' };
      }
      const order = date => (date.y * 12 + date.m) * 32 + (date.d || 1);
      if (want[other] && order(want[0]) > order(want[1])) return { reason: 'invalid_date' };
      const accepted = () => showsDate(ctx.el, want[own]);
      // 资料只到月、框里显示到日：选的是 1 号，结果里写明。
      const finished = () => ({ accepted, dayDefaulted: !want[own].d && Boolean(dateParts(ctx.el.value)?.d) });
      const doc = ctx.el.ownerDocument;
      const calendarOpen = () => Array.from(doc.querySelectorAll(antd(doc, CALENDAR_LAYERS))).some(visible);
      // 只有一头的（antd）：另一个框空着才算已经填好。
      const settled = index => (want[index] ? showsDate(boxes[index], want[index]) : !String(boxes[index].value ?? '').trim());
      if (settled(0) && settled(1) && !calendarOpen()) return finished();
      const custom = scope.ResumeProCustomControls;
      let done = ctx.entry.pickerType === 'antd' ? await antRange(ctx, want, boxes)
        : boxes.some(box => box.readOnly) ? (custom?.pickRange ? await custom.pickRange(ctx, want, boxes, host) : { reason: 'unsupported_control' })
          : await typedRange(ctx, want, boxes);
      // 按组件的格式打字没收下（网站改了显示格式）：收起弹层，改点日历格子。
      if (done.retype && custom?.pickRange && !stop(ctx, true)) done = await custom.pickRange(ctx, want, boxes, host);
      if (done.reason) return { reason: done.reason };
      // 两头分别核对：组件收下的是不是要填的那两天。只有一头的（antd）：这次打开的弹层收起了、组件留下了它才算；
      // 没留下就是网站要两头都有。页面上别的日期弹层开着不相干。
      if (!want[other]) return settled(0) && settled(1) && !done.open ? finished() : { reason: 'range_incomplete' };
      if (!showsDate(boxes[0], want[0]) || !showsDate(boxes[1], want[1])) return { reason: 'selection_not_committed' };
      return finished();
    }
    // antd 4/5 的 RangePicker：弹层里并排两个面板。点开始框打开，按单个日期的做法（antDatePick）点年、月、日选开始；
    // 选完 rc-picker 把焦点交给结束框、弹层不收，再同样点出结束日，两头都有了才一起提交、收起。
    // 只有一头（want 里另一头是空的）：选完让框失焦收起弹层，留没留下由 operateRange 核对；交回这次打开的弹层还开着没有（open）。
    async function antRange(ctx, want, boxes) {
      const doc = ctx.el.ownerDocument;
      const dropdowns = () => Array.from(doc.querySelectorAll(antd(doc, '.ant-picker-dropdown'))).filter(visible);
      const before = ctx.popupsBefore || new Set(dropdowns());
      const active = box => doc.activeElement === box || antdHas(box.parentElement, 'ant-picker-input-active');
      let popup = null;
      const picked = await (async () => {
        for (const index of [0, 1]) {
          if (!want[index]) continue;
          // 结束框原来就是要的日子，选完开始就一起提交、收起了：不再点开。
          if (index && popup && !visible(popup) && showsDate(boxes[index], want[index])) continue;
          // 弹层开着、轮到的正是这个框（选完开始，焦点交给了结束框）就接着选；不然点这个框。
          if (!popup || !visible(popup) || !active(boxes[index])) {
            focus(boxes[index]);
            const reason = click(boxes[index], ctx); if (reason) return { reason };
            const opened = await waitUntil(ctx, doc.documentElement, () => {
              const all = dropdowns(), added = all.filter(node => !before.has(node));
              const shown = popup && visible(popup) ? popup : added.length === 1 ? added[0] : ctx.alreadyOpen && all.length === 1 ? all[0] : null;
              return shown && active(boxes[index]) ? shown : null;
            }, Boolean);
            if (opened.reason) return { reason: opened.reason };
            popup = opened.value;
            ctx.observed = { library: 'antd', popupRole: 'calendar' };
          }
          // 带时间的区间（showTime）要点「确定」，这里不处理。
          if (popup.querySelector(antd(popup, '.ant-picker-time-panel'))) return { reason: 'unsupported_control' };
          const one = await antDatePick(ctx, `${want[index].y}-${pad2(want[index].m)}-${pad2(want[index].d || 1)}`, popup, true);
          if (one.reason) return one;
          if (index === 0 && want[1]) {
            const turned = await waitUntil(ctx, doc.documentElement, () => !visible(popup) || active(boxes[1]), Boolean);
            if (turned.reason) return { reason: turned.reason === 'verification_timeout' ? 'selection_not_committed' : turned.reason };
          }
        }
        if (!(want[0] && want[1]) && visible(popup)) {
          // 等 rc-picker 把焦点交给另一个框（antd 4 过一会儿才交）再失焦，不然失焦的是开始框，弹层跟着焦点又开着。
          await waitUntil(ctx, doc.documentElement, () => !visible(popup) || boxes.some(box => box !== ctx.el && active(box)), Boolean, 300);
          return { leave: true };
        }
        const closed = await waitUntil(ctx, doc.documentElement, () => !popup.isConnected || !visible(popup), Boolean);
        return closed.reason ? { reason: closed.reason === 'verification_timeout' ? 'selection_not_committed' : closed.reason } : {};
      })().catch(() => ({ reason: 'operation_failed' }));
      // 选不成时收起自己点开的弹层，同 antDate：已经选的那一头不算，组件里的值不变。只选一头的也这样收起（leave）。
      if ((picked.reason || picked.leave) && popup && !before.has(popup) && !stop(ctx) && popup.isConnected && visible(popup)) {
        // 失焦有焦点的那个框；没收起时再失焦一次，这时焦点已经不在框里，还是对着它（焦点又回到哪个框就对着那个）。
        let focused = boxes.find(box => doc.activeElement === box) || ctx.el;
        const gone = () => !popup.isConnected || !visible(popup);
        leavePicker(focused);
        const leaving = await waitUntil(ctx, doc.documentElement, () => gone() || Array.from(popup.classList).some(token => /-leave$/.test(token)), Boolean, 100);
        if (leaving.reason === 'verification_timeout' && !stop(ctx)) {
          focused = boxes.find(box => doc.activeElement === box) || focused;
          leavePicker(focused);
        }
        await waitUntil(ctx, doc.documentElement, gone, Boolean, 600);
      }
      return picked.reason ? picked : { open: Boolean(popup?.isConnected && visible(popup)) };
    }
    // 能打字的区间（Element UI、Element Plus 的 daterange、monthrange）：两个框按组件默认的格式（YYYY-MM-DD、YYYY-MM）各写各的，
    // 再在结束框上回车。两头都收下时组件提交并收起弹层；不收（网站改了显示格式）弹层还开着，交回去改点格子（retype）。
    // only：手动只填一头时只写这一个框，不回车，弹层开着等另一头（见 operateRange）。
    async function typedRange(ctx, want, boxes, only = -1) {
      const mode = ctx.entry.pickerInputType === 'month' ? 'month' : 'date';
      const text = date => mode === 'month' ? `${date.y}-${pad2(date.m)}` : `${date.y}-${pad2(date.m)}-${pad2(date.d || 1)}`;
      const doc = ctx.el.ownerDocument, View = doc.defaultView;
      // 只看这次打开的日历：上一个日期框的日历可能还在退场。
      const layers = () => Array.from(doc.querySelectorAll(antd(doc, CALENDAR_LAYERS))).filter(visible);
      const before = new Set(layers());
      const calendarOpen = () => layers().some(layer => !before.has(layer));
      for (const index of only < 0 ? [0, 1] : [only]) {
        focus(boxes[index]);
        const reason = click(boxes[index], ctx); if (reason) return { reason };
        // 和单个日期一样，先给页面留出画弹层的时间。
        if (index === 0 || only >= 0) await delay(150);
        // 点开以后没有新冒出来的日历：这个区间的日历可能早就开着（手动先填了一头，日历一直开着等另一头），开着的都要看。
        if (index === 0 && !layers().some(layer => !before.has(layer))) before.clear();
        const stopped = stop(ctx, true); if (stopped) return { reason: stopped };
        write(boxes[index], text(want[index]), ctx); input(boxes[index]);
        // 让一拍：Element UI 要等 Vue 处理完这次改动，紧跟着回车不收起弹层。
        await delay(0);
      }
      if (only >= 0) return {};
      const stopped = stop(ctx, true); if (stopped) return { reason: stopped };
      if (View?.KeyboardEvent) boxes[1].dispatchEvent(new View.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      const taken = await waitUntil(ctx, doc.documentElement, () => showsDate(boxes[0], want[0]) && showsDate(boxes[1], want[1]) && !calendarOpen(), Boolean);
      if (!taken.reason) return {};
      if (taken.reason !== 'verification_timeout') return { reason: taken.reason };
      // 没收下：收起日历，框里打的字随之撤掉（对话框里不按 Esc，见 custom-controls.js 的 leaveCalendar）。
      const open = await scope.ResumeProCustomControls?.leaveRange?.(ctx, boxes, host, before);
      return open || calendarOpen() ? { reason: 'selection_not_committed' } : { retype: true };
    }

    // #301 简道云日期框（.fx-form-datetime .x-datetime）：框里能打字，日历跟着跳到打的日子；可它要等日历收起
    // （点日子、点框外面）才把日历指着的日子交给表单。只打字再失焦（#399），日历一直开着，表单里要等用户下次点别处才有值，
    // 框里又改成了组件自己的格式（出生年月 1999-05-12 → 1999-05），按字面核对就报 value_reverted。
    // 做法：点开日历，看它选日、选月还是选年（带时间的不处理）；按资料的精度打 YYYY-MM-DD / YYYY-MM / YYYY，
    // 日历的年、月和选中的格子对上了，再点那一格：日历自己收起并提交。
    // 选不成时收起自己点开的日历，表单里留原来的值，见 jdyRestore。
    // 填写不按键：Esc 收起日历但不提交，框里留着打的字，表单里没有。只在选不成、原来为空又清不掉时用它收起。
    function jdyDateParts(raw) {
      const text = String(raw ?? '').trim();
      const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(helpers?.normalizeDateValue?.(text, 'date') || '');
      const month = /^(\d{4})-(\d{2})$/.exec(helpers?.normalizeDateValue?.(text, 'month') || '');
      const year = /^(\d{4})(?:年)?$/.exec(text);
      const parts = day ? { year: day[1], month: day[2], day: day[3] } : month ? { year: month[1], month: month[2], day: '' }
        : year ? { year: year[1], month: '', day: '' } : null;
      if (!parts) return null;
      const y = Number(parts.year), m = Number(parts.month || 1), d = Number(parts.day || 1);
      const date = new Date(y, m - 1, d);
      if (y < 1900 || y > 2100 || date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
      return parts;
    }
    const JDY_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    function jdyMonthOf(text) {
      const value = String(text || '').trim().toLowerCase();
      const digits = /^(\d{1,2})/.exec(value);
      if (digits) return Number(digits[1]);
      const index = JDY_MONTHS.findIndex(name => value.startsWith(name));
      return index >= 0 ? index + 1 : 0;
    }
    async function jdyDate(ctx, raw) {
      const doc = ctx.el.ownerDocument;
      const root = ctx.el.closest?.('.fx-form-datetime .x-datetime');
      if (!doc?.querySelectorAll || !root) return { reason: 'unsupported_control' };
      const want = jdyDateParts(raw);
      if (!want) return { reason: 'invalid_date' };
      const popups = () => Array.from(doc.querySelectorAll('.x-popup.x-datetime-content')).filter(visible);
      const before = new Set(popups());
      const original = ctx.el.value;
      const reason = click(ctx.el, ctx); if (reason) return { reason };
      const opened = await waitUntil(ctx, doc.documentElement, () => {
        const added = popups().filter(node => !before.has(node));
        return added.length === 1 ? added[0] : null;
      }, Boolean);
      if (opened.reason) return { reason: opened.reason };
      const popup = opened.value;
      ctx.observed = { library: 'jiandaoyun', popupRole: 'calendar' };
      const picked = await jdyPick(ctx, want, popup).catch(() => ({ reason: 'operation_failed' }));
      if (picked.reason && !stop(ctx) && popup.isConnected && visible(popup)) await jdyRestore(ctx, root, popup, original);
      return picked;
    }
    // 选不成时收起自己点开的日历，表单里留原来的值。框失焦再点框能收起日历，但会把日历指着的日子交给表单，
    // 打过字就是打的那天（#301 评审在真组件上看到）。所以先把日历拨回原来的值再收：框里原来有字就写回去；
    // 原来是空的就点框里的清除按钮，真组件上它收起日历、表单里还是空的（写回空字会被读成 1901-01-01）。
    // 没有清除按钮，或点了没收起：在框上按 Esc，收起、不交给表单，框里留着打的字。
    // 这样还开着才照旧失焦、点框收起：日历开着，下次点别处也会把它指着的日子交出去。
    async function jdyRestore(ctx, root, popup, original) {
      const doc = ctx.el.ownerDocument;
      const gone = () => !popup.isConnected || !visible(popup);
      const settle = () => waitUntil(ctx, doc.documentElement, gone, Boolean, 600);
      if (ctx.el.value !== original) {
        if (original) { write(ctx.el, original, ctx); input(ctx.el); }
        else {
          const clear = root.querySelector('.clear-icon');
          if (clear && !click(clear, ctx)) await settle();
          const View = doc.defaultView;
          if (!gone() && !stop(ctx) && View?.KeyboardEvent) {
            ctx.el.dispatchEvent(new View.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
            await settle();
          }
        }
      }
      if (!gone() && !stop(ctx)) {
        blur(ctx.el);
        await delay(0);
        if (!stop(ctx) && !click(root, ctx)) await settle();
      }
      // 点清除按钮、按 Esc 后框还有焦点，让它失焦；点了清除按钮的，框里的字要等失焦才清掉。
      if (!stop(ctx) && doc.activeElement === ctx.el) blur(ctx.el);
    }
    async function jdyPick(ctx, want, popup) {
      const mode = popup.querySelector('.date-time-picker, .time-body, .week-cell') ? ''
        : popup.querySelector('.date-body .day') ? 'date' : popup.querySelector('.date-month') ? 'month' : popup.querySelector('.date-year') ? 'year' : '';
      if (!mode) return { reason: 'unsupported_control' };
      // 资料只有年份，日历要选到月或日：不替用户编月份。
      if (mode !== 'year' && !want.month) return { reason: 'invalid_date' };
      const text = want.day ? `${want.year}-${want.month}-${want.day}` : want.month ? `${want.year}-${want.month}` : want.year;
      const stopped = stop(ctx, true); if (stopped) return { reason: stopped };
      write(ctx.el, text, ctx); input(ctx.el);
      const year = () => (popup.querySelector('.date-head .btn-year')?.textContent || '').trim();
      const usable = cell => cell && !cell.matches('.disabled, .oday') && !cell.querySelector('.disabled');
      const target = () => {
        if (mode === 'year') {
          const cells = Array.from(popup.querySelectorAll('.date-year .item-cell')).filter(cell => cell.querySelector('.cell-btn.select'));
          return cells.length === 1 && usable(cells[0]) && cells[0].textContent.trim() === want.year ? cells[0] : null;
        }
        if (year() !== want.year) return null;
        if (mode === 'month') {
          const cells = Array.from(popup.querySelectorAll('.date-month .item-cell'));
          const chosen = cells.filter(cell => cell.querySelector('.cell-btn.select'));
          return cells.length === 12 && chosen.length === 1 && cells.indexOf(chosen[0]) === Number(want.month) - 1 && usable(chosen[0]) ? chosen[0] : null;
        }
        if (jdyMonthOf(popup.querySelector('.date-head .btn-month')?.textContent) !== Number(want.month)) return null;
        const days = Array.from(popup.querySelectorAll('.date-body .day.selected'));
        return days.length === 1 && usable(days[0]) && days[0].textContent.trim() === String(Number(want.day || 1)) ? days[0] : null;
      };
      const found = await waitUntil(ctx, popup, target, Boolean);
      // 日历没跳到这一天：多半是超出了表单允许的日期范围。
      if (found.reason) return { reason: found.reason === 'verification_timeout' ? 'no_option_match' : found.reason };
      const why = click(found.value, ctx, true); if (why) return { reason: why };
      const closed = await waitUntil(ctx, popup, () => !popup.isConnected || !visible(popup), Boolean);
      if (closed.reason) return { reason: closed.reason === 'verification_timeout' ? 'selection_not_committed' : closed.reason };
      const expected = mode === 'year' ? want.year : mode === 'month' ? `${want.year}-${want.month}` : `${want.year}-${want.month}-${want.day || '01'}`;
      return { expected, mode, dayDefaulted: mode === 'date' && !want.day };
    }
    function check(target) {
      const el = target?.kind === 'radio' ? target.elements?.[0] : target?.kind === 'element' ? target.element : target;
      const saved = checks.get(el);
      if (!saved) return null;
      // Cancellation gates new actions, not evidence from a completed operation.
      // This path only reads the final DOM and never invokes write/stop callbacks.
      try {
        if (saved.ctx.nodes.some(node => node.isConnected === false)) return result(false, 'element_disconnected', saved.ctx);
        if (saved.ctx.nodes.some(node => isInput(node) && ['file', 'password', 'hidden', 'submit', 'reset', 'button', 'image'].includes(node.type))) return result(false, 'element_disconnected', saved.ctx);
        if (saved.ctx.kind === 'radio' && saved.ctx.nodes.some(node => saved.ctx.customRadio ? isInput(node) : node.type !== 'radio')) return result(false, 'element_disconnected', saved.ctx);
        if (saved.ctx.kind === 'checkbox' && saved.ctx.el.type !== 'checkbox') return result(false, 'element_disconnected', saved.ctx);
        if (kindOf(saved.ctx.entry, saved.ctx.el) !== saved.ctx.kind) return result(false, 'element_disconnected', saved.ctx);
        if (!saved.accepted()) return result(false, 'value_reverted', saved.ctx, typeof saved.previous === 'string' ? { after: leftover(saved.ctx.el, saved.previous) } : {});
        const verdict = saved.inspect?.();
        return result(verdict ? verdict.ok : true, verdict?.reason || '', saved.ctx);
      } catch {
        return result(false, 'operation_failed', saved.ctx);
      }
    }
    // 交给 custom-controls.js 的宿主操作：写值、派发事件、等待和核对都在这里。
    const host = { helpers, visible, click, stop, write, input, type, waitUntil, blur, focus, timeoutMs };
    return { operate, check };
  }
  scope.ResumeProControls = { create, cleanHints, controlKinds: Object.freeze(Array.from(KINDS)) };
})(typeof self !== 'undefined' ? self : globalThis);
