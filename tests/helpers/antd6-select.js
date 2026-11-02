// #429 antd 6（@rc-component/select 1.x）下拉的替身。按 2026-11-02 在 Chromium 里跑真 antd 6.6.8 + react 18.3.1 看到的结构写：
// - 组件根 .ant-select 下面直接是 .ant-select-content，没有 .ant-select-selector。单选时已选文字直接是 content 里的文本节点
//   （content 带 -content-has-value 和 title；选项带 className 时套一层 .ant-select-content-value），没选时是 .ant-select-placeholder。
//   输入框是 content 里的 input.ant-select-input[role=combobox]，搜索时打的字只在输入框里，已选文字照旧留在 content 里。
// - 多选时 content 是 rc-overflow：一项一个 .ant-select-content-item > .ant-select-selection-item（带 -remove），
//   maxTagCount 折起来的一格是 .ant-select-content-item-rest，输入框在 .ant-select-content-item-suffix 里，没选时 -prefix 里放占位提示。
// - 级联的根同时带 ant-select 和 ant-cascader，选好的路径按「广东省 / 深圳市 / 南山区」写在 content 里；弹层是
//   .ant-select-dropdown.ant-cascader-dropdown，一列一个 ul.ant-cascader-menu。
// - 在组件根上按下鼠标展开，弹层挂在 body 下：0×0 的辅助列表（role=listbox，id 是输入框的 aria-controls）只放前两条，
//   真选项在 .ant-select-dropdown-list-holder-inner 里（antd 5 是 .rc-virtual-list-holder-inner）。收起时弹层带 -dropdown-hidden。
// p 是类名前缀（ConfigProvider 的 prefixCls）。只有虚构的值。

function selectHtml(p, { id = "r0", selected = "", search = false, multiple = false, cascader = false, placeholder = "请选择", styled = false } = {}) {
  const input = `<input id="${id}" type="text"${search || multiple ? "" : " readonly"} autocomplete="new-password" class="${p}-select-input" role="combobox"`
    + ` aria-expanded="false" aria-haspopup="listbox" aria-autocomplete="list" value="">`;
  const classes = [`${p}-select`, cascader ? `${p}-cascader` : "", `${p}-select-outlined`, `${p}-select-in-form-item`,
    multiple ? `${p}-select-multiple` : `${p}-select-single`, `${p}-select-show-arrow`, search || multiple ? `${p}-select-show-search` : ""].filter(Boolean).join(" ");
  const content = multiple ? `<div class="${p}-select-content"><div class="${p}-select-content-item ${p}-select-content-item-suffix">${input}</div></div>`
    : `<div class="${p}-select-content">${single(p, selected, placeholder, styled)}${input}</div>`;
  return `<div class="${classes}">${content}<div class="${p}-select-suffix"><span role="img" aria-label="down" class="anticon anticon-down"></span></div></div>`;
}

function single(p, selected, placeholder, styled) {
  if (!selected) return `<div class="${p}-select-placeholder">${placeholder}</div>`;
  return styled ? `<div class="${p}-select-content-value degree-option" title="${selected}">${selected}</div>` : selected;
}

// 让替身动起来。choices 是选项文字；cascader 时是 { 省: { 市: [区县] } }。
// search：可搜索（输入后 10ms 按包含筛）；remote：边输边搜，不输入就没有弹层。multiple：点一项切换，弹层开着，输入框失焦才收起。
// maxTags：多选的 maxTagCount。返回页面收下的选择（picked）、打过的搜索词（searches）、点过的选项（clicks）、删掉的标签（removed）。
function wire(doc, root, choices, { p = "ant", search = false, remote = false, multiple = false, cascader = false, maxTags = Infinity, values = [], styled = false } = {}) {
  const content = root.querySelector(`:scope > .${p}-select-content`), input = root.querySelector("input");
  const state = { picked: [], searches: [], clicks: [], removed: [], values: [...values], open: false };
  let dropdown = null, path = [];
  const hide = () => {
    state.open = false; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-controls"); input.removeAttribute("aria-owns");
    if (dropdown) { dropdown.hidden = true; dropdown.classList.add(`${p}-select-dropdown-hidden`); }
    input.value = ""; content.classList.remove(`${p}-select-content-has-search-value`);
  };
  const showValue = (text) => {
    for (const node of Array.from(content.childNodes)) if (node !== input) node.remove();
    content.classList.add(`${p}-select-content-has-value`); content.title = text;
    if (styled) input.insertAdjacentHTML("beforebegin", `<div class="${p}-select-content-value degree-option" title="${text}">${text}</div>`);
    else input.before(doc.createTextNode(text));
  };
  const renderTags = () => {
    content.querySelectorAll(`.${p}-select-content-item:not(.${p}-select-content-item-suffix)`).forEach((node) => node.remove());
    const suffix = content.querySelector(`.${p}-select-content-item-suffix`);
    if (!state.values.length) suffix.insertAdjacentHTML("beforebegin", `<div class="${p}-select-content-item ${p}-select-content-item-prefix"><div class="${p}-select-placeholder">请选择</div></div>`);
    for (const text of state.values.slice(0, maxTags)) {
      const item = doc.createElement("div"); item.className = `${p}-select-content-item`;
      item.innerHTML = `<span title="${text}" class="${p}-select-selection-item"><span class="${p}-select-selection-item-content">${text}</span>`
        + `<span class="${p}-select-selection-item-remove" unselectable="on" aria-hidden="true"><span role="img" aria-label="close" class="anticon anticon-close"></span></span></span>`;
      item.querySelector(`.${p}-select-selection-item-remove`).addEventListener("click", () => {
        state.removed.push(text); state.values = state.values.filter((value) => value !== text); renderTags(); renderList();
      });
      suffix.before(item);
    }
    if (state.values.length > maxTags) {
      suffix.insertAdjacentHTML("beforebegin", `<div class="${p}-select-content-item ${p}-select-content-item-rest"><span title="+ ${state.values.length - maxTags} ..." class="${p}-select-selection-item">`
        + `<span class="${p}-select-selection-item-content">+ ${state.values.length - maxTags} ...</span></span></div>`);
    }
  };
  const option = (text) => {
    const on = state.values.includes(text);
    return `<div aria-disabled="false" aria-selected="${on}" class="${p}-select-item ${p}-select-item-option${on ? ` ${p}-select-item-option-selected` : ""}" title="${text}">`
      + `<div class="${p}-select-item-option-content">${text}</div><span class="${p}-select-item-option-state" unselectable="on" aria-hidden="true"></span></div>`;
  };
  const renderList = () => {
    if (!dropdown || cascader) return;
    const items = choices.filter((text) => !input.value || text.includes(input.value));
    dropdown.querySelector("[role='listbox']").innerHTML = items.slice(0, 2)
      .map((text, i) => `<div aria-label="${text}" role="option" id="${input.id}_list_${i}" aria-selected="false">${text}</div>`).join("");
    const inner = dropdown.querySelector(`.${p}-select-dropdown-list-holder-inner`);
    inner.innerHTML = items.slice(0, 10).map(option).join("");
    inner.querySelectorAll(`.${p}-select-item-option`).forEach((node) => node.addEventListener("click", () => choose(node.title)));
  };
  // 一条路径下面的一级：{ 名字: 下一级 } 或区县的数组；到了区县返回 null。
  const childrenOf = (names) => {
    let level = choices;
    for (const name of names) {
      if (!level || Array.isArray(level)) return null;
      level = level[name];
    }
    return level || null;
  };
  const renderMenus = () => {
    const columns = [];
    for (let depth = 0; depth <= path.length; depth += 1) {
      const level = childrenOf(path.slice(0, depth));
      if (!level) break;
      columns.push(Array.isArray(level) ? level : Object.keys(level));
    }
    const menus = dropdown.querySelector(`.${p}-cascader-menus`);
    menus.innerHTML = columns.map((names, depth) => `<ul class="${p}-cascader-menu" role="menu">${names.map((name) => {
      const expand = Boolean(childrenOf([...path.slice(0, depth), name]));
      return `<li class="${p}-cascader-menu-item${expand ? ` ${p}-cascader-menu-item-expand` : ""}${path[depth] === name ? ` ${p}-cascader-menu-item-active` : ""}"`
        + ` role="menuitemcheckbox" title="${name}" aria-checked="false" data-path-key="${name}" data-depth="${depth}"><div class="${p}-cascader-menu-item-content">${name}</div></li>`;
    }).join("")}</ul>`).join("");
    menus.querySelectorAll("li").forEach((node) => node.addEventListener("click", () => {
      path = [...path.slice(0, Number(node.dataset.depth)), node.title];
      if (childrenOf(path)) { renderMenus(); return; }
      state.picked.push(path.join("/"));
      showValue(path.join(" / "));
      hide();
    }));
  };
  const choose = (text) => {
    state.clicks.push(text);
    if (multiple) {
      state.values = state.values.includes(text) ? state.values.filter((value) => value !== text) : [...state.values, text];
      input.value = ""; renderTags(); renderList();
      return;
    }
    state.picked.push(text);
    showValue(text);
    hide();
  };
  const open = () => {
    if (state.open) return;
    if (remote && !input.value) return;
    state.open = true;
    input.setAttribute("aria-expanded", "true");
    if (!cascader) { input.setAttribute("aria-owns", `${input.id}_list`); input.setAttribute("aria-controls", `${input.id}_list`); }
    if (!dropdown) {
      dropdown = doc.createElement("div");
      dropdown.innerHTML = cascader ? `<div class="${p}-cascader-menus"></div>`
        : `<div role="listbox" id="${input.id}_list" data-w="0" data-h="0" style="height: 0px; width: 0px; overflow: hidden;"></div>`
          + `<div class="${p}-select-dropdown-list"><div class="${p}-select-dropdown-list-holder"><div><div class="${p}-select-dropdown-list-holder-inner"></div></div></div></div>`;
      doc.body.append(dropdown);
    }
    dropdown.className = `${p}-select-dropdown${cascader ? ` ${p}-cascader-dropdown` : ""} ${p}-select-dropdown-placement-bottomLeft`;
    dropdown.hidden = false;
    path = [];
    if (cascader) renderMenus(); else renderList();
  };
  root.addEventListener("mousedown", open);
  input.addEventListener("input", () => {
    state.searches.push(input.value);
    content.classList.toggle(`${p}-select-content-has-search-value`, Boolean(input.value));
    if (remote && !state.open) { setTimeout(() => { open(); renderList(); }, 10); return; }
    setTimeout(renderList, 10);
  });
  input.addEventListener("blur", hide);
  input.addEventListener("keydown", (event) => { if (event.key === "Escape") hide(); });
  if (multiple) renderTags();
  return state;
}

module.exports = { selectHtml, wire };
