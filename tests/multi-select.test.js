// #429 多选下拉。替身按 2026-10-31 在 Chromium 里跑真 antd 5.21.6、ant-design-vue 1.7.8、Element UI 2.15.14、
// Element Plus 2.8.8 看到的结构写（antd 3 / ant-design-vue 1.x 的替身在 antd-select.test.js）：
// antd 5：已选的是 overflow 里的 .ant-select-selection-item（带 -remove），弹层选项选中后带 -selected，再点一次取消；
//   能搜索，选上以后清掉搜索词，弹层开着，输入框失焦才收起。
// Element UI 2：已选的是 .el-select__tags 里的 .el-tag（文字在 .el-select__tags-text，删除是 .el-tag__close），
//   filterable 时在 .el-select__input 里搜；弹层 .el-select-dropdown.is-multiple 挂在 body 下，失焦不收，Esc 或点外面才收。
// Element Plus：.el-select__selection 里一项一个 .el-select__selected-item > .el-tag；没选东西时组件上看不出是多选。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { JSDOM } = require("jsdom");
const scanner = require("../field-scan.js");
const helpers = require("../ai-helpers.js");

const visible = (el) => !el.closest("[hidden]");
function load(label, control, { wrap = (html) => html } = {}) {
  const dom = new JSDOM(`<form>${wrap(`<div class="form-item"><label>${label}</label><div class="form-item-control">${control}</div></div>`)}</form>`, { runScripts: "outside-only" });
  const w = dom.window;
  for (const file of ["ai-helpers.js", "custom-controls.js", "control-adapters.js"]) w.eval(fs.readFileSync(file, "utf8"));
  const api = w.ResumeProControls.create({ timeoutMs: 200, settleMs: 35, isVisible: visible });
  const found = scanner.scanPage(w.document, { isVisible: visible }).controls.find((item) => item.label === label);
  assert.ok(found, `scanned ${label}`);
  const target = { kind: "element", element: found.element, elements: found.elements, root: found.root, controlKind: found.controlKind, hints: {} };
  return { w, doc: w.document, api, target };
}

function antd5(choices, { selected = [], search = true, noRemove = false, maxTags = Infinity } = {}) {
  const h = load("外语语种", `<div class="ant-select ant-select-multiple${search ? " ant-select-show-search" : ""}"><div class="ant-select-selector">
    <div class="ant-select-selection-overflow"><div class="ant-select-selection-overflow-item ant-select-selection-overflow-item-suffix">
    <div class="ant-select-selection-search"><input type="search" autocomplete="off" class="ant-select-selection-search-input" role="combobox"
      aria-expanded="false" aria-haspopup="listbox" aria-owns="rc_select_0_list" aria-autocomplete="list" aria-controls="rc_select_0_list" readonly></div></div></div>
    <span class="ant-select-selection-placeholder">请选择</span></div></div>`);
  const { doc } = h;
  const root = doc.querySelector(".ant-select"), input = root.querySelector("input");
  const state = { values: [...selected], clicks: [], removed: [], open: false, escapes: 0 };
  let dropdown = null;
  const renderTags = () => {
    root.querySelectorAll(".ant-select-selection-overflow-item:not(.ant-select-selection-overflow-item-suffix)").forEach((node) => node.remove());
    const suffix = root.querySelector(".ant-select-selection-overflow-item-suffix");
    // maxTagCount：多出来的折成一格「+ N ...」。
    for (const text of state.values.slice(0, maxTags)) {
      const item = doc.createElement("div"); item.className = "ant-select-selection-overflow-item";
      item.innerHTML = `<span title="${text}" class="ant-select-selection-item"><span class="ant-select-selection-item-content">${text}</span>${noRemove ? "" : '<span class="ant-select-selection-item-remove"><i></i></span>'}</span>`;
      item.querySelector(".ant-select-selection-item-remove")?.addEventListener("click", () => { state.removed.push(text); state.values = state.values.filter((v) => v !== text); renderTags(); renderList(); });
      suffix.before(item);
    }
    root.querySelector(".ant-select-selection-placeholder").hidden = state.values.length > 0;
    root.querySelector(".ant-select-selection-overflow-item-rest")?.remove();
    if (state.values.length > maxTags) {
      const rest = doc.createElement("div"); rest.className = "ant-select-selection-overflow-item ant-select-selection-overflow-item-rest";
      rest.innerHTML = `<span class="ant-select-selection-item">+ ${state.values.length - maxTags} ...</span>`;
      suffix.before(rest);
    }
  };
  const renderList = () => {
    if (!dropdown) return;
    const inner = dropdown.querySelector(".rc-virtual-list-holder-inner");
    inner.innerHTML = "";
    for (const text of choices.filter((t) => t.includes(input.value)).slice(0, 10)) {
      const on = state.values.includes(text);
      const item = doc.createElement("div");
      item.className = `ant-select-item ant-select-item-option${on ? " ant-select-item-option-selected" : ""}`; item.title = text; item.setAttribute("aria-selected", String(on));
      item.innerHTML = `<div class="ant-select-item-option-content">${text}</div>`;
      // 再点一次已选的会取消。
      item.addEventListener("click", () => {
        state.clicks.push(text);
        state.values = state.values.includes(text) ? state.values.filter((v) => v !== text) : [...state.values, text];
        input.value = ""; renderTags(); renderList();
      });
      inner.append(item);
    }
  };
  const open = () => {
    if (state.open) return;
    state.open = true; input.readOnly = !search; input.setAttribute("aria-expanded", "true");
    if (!dropdown) {
      dropdown = doc.createElement("div"); dropdown.className = "ant-select-dropdown";
      dropdown.innerHTML = '<div><div role="listbox" id="rc_select_0_list"></div><div class="rc-virtual-list"><div class="rc-virtual-list-holder"><div><div class="rc-virtual-list-holder-inner"></div></div></div></div></div>';
      doc.body.append(dropdown);
    }
    dropdown.hidden = false; renderList();
  };
  const close = () => { state.open = false; input.readOnly = true; input.value = ""; input.setAttribute("aria-expanded", "false"); if (dropdown) dropdown.hidden = true; };
  root.querySelector(".ant-select-selector").addEventListener("click", open);
  input.addEventListener("input", () => setTimeout(renderList, 10));
  input.addEventListener("blur", close);
  input.addEventListener("keydown", (event) => { if (event.key === "Escape") { state.escapes += 1; close(); } });
  renderTags();
  return { ...h, root, input, state, isOpen: () => state.open };
}

function elementUi(choices, { selected = [], filterable = true, dialog = false } = {}) {
  const h = load("掌握语言", `<div class="el-select"><div class="el-select__tags"><span></span>${filterable ? '<input type="text" autocomplete="off" class="el-select__input">' : ""}</div>
    <div class="el-input el-input--suffix"><input type="text" readonly autocomplete="off" placeholder="请选择" class="el-input__inner"></div></div>`,
  { wrap: dialog ? (html) => `<div class="el-dialog" role="dialog" aria-modal="true">${html}</div>` : undefined });
  const { doc } = h;
  const root = doc.querySelector(".el-select"), search = root.querySelector(".el-select__input");
  const state = { values: [...selected], clicks: [], removed: [], open: false, escapes: 0, presses: 0 };
  let dropdown = null;
  const renderTags = () => {
    const holder = root.querySelector(".el-select__tags > span");
    holder.innerHTML = "";
    for (const text of state.values) {
      const tag = doc.createElement("span"); tag.className = "el-tag el-tag--info el-tag--small";
      tag.innerHTML = `<span class="el-select__tags-text">${text}</span><i class="el-tag__close el-icon-close"></i>`;
      tag.querySelector(".el-tag__close").addEventListener("click", (event) => { event.stopPropagation(); state.removed.push(text); state.values = state.values.filter((v) => v !== text); renderTags(); renderList(); });
      holder.append(tag);
    }
    root.querySelector(".el-input__inner").placeholder = state.values.length ? "" : "请选择";
  };
  const renderList = () => {
    if (!dropdown) return;
    const list = dropdown.querySelector("ul");
    list.innerHTML = "";
    for (const text of choices) {
      const li = doc.createElement("li");
      li.className = `el-select-dropdown__item${state.values.includes(text) ? " selected" : ""}`;
      li.innerHTML = `<span>${text}</span>`;
      if (search && search.value && !text.includes(search.value)) li.hidden = true;
      li.addEventListener("click", () => {
        state.clicks.push(text);
        state.values = state.values.includes(text) ? state.values.filter((v) => v !== text) : [...state.values, text];
        if (search) search.value = "";
        renderTags(); renderList();
      });
      list.append(li);
    }
  };
  const open = () => {
    state.open = true;
    if (!dropdown) {
      dropdown = doc.createElement("div"); dropdown.className = "el-select-dropdown el-popper is-multiple";
      dropdown.innerHTML = '<div class="el-scrollbar"><div class="el-select-dropdown__wrap"><ul class="el-scrollbar__view el-select-dropdown__list"></ul></div></div>';
      doc.body.append(dropdown);
    }
    dropdown.hidden = false; renderList();
  };
  const close = () => { state.open = false; if (dropdown) dropdown.hidden = true; };
  root.addEventListener("click", () => (state.open ? close() : open()));
  search?.addEventListener("input", () => setTimeout(renderList, 10));
  for (const input of root.querySelectorAll("input")) input.addEventListener("keydown", (event) => { if (event.key === "Escape") { state.escapes += 1; close(); } });
  // 点外面才收（clickoutside 看 mousedown、mouseup）。
  doc.addEventListener("mouseup", (event) => { if (!root.contains(event.target) && !dropdown?.contains(event.target)) { state.presses += 1; close(); } });
  renderTags();
  return { ...h, root, state, isOpen: () => state.open };
}

function elementPlus(choices, { selected = [] } = {}) {
  const h = load("会的语言", `<div class="el-select"><div class="el-select__wrapper is-filterable"><div class="el-select__selection">
    <div class="el-select__selected-item el-select__input-wrapper"><input type="text" class="el-select__input" autocomplete="off" role="combobox"
      aria-controls="el-id-1" aria-expanded="false" aria-autocomplete="none" aria-haspopup="listbox"></div></div></div></div>`);
  const { doc } = h;
  const root = doc.querySelector(".el-select"), input = root.querySelector("input");
  const state = { values: [...selected], clicks: [], open: false, escapes: 0 };
  let popper = null;
  const renderTags = () => {
    root.querySelectorAll(".el-select__selected-item:not(.el-select__input-wrapper)").forEach((node) => node.remove());
    for (const text of state.values) {
      const item = doc.createElement("div"); item.className = "el-select__selected-item";
      item.innerHTML = `<span class="el-tag is-closable el-tag--info"><span class="el-tag__content"><span class="el-select__tags-text">${text}</span></span><i class="el-icon el-tag__close"></i></span>`;
      root.querySelector(".el-select__input-wrapper").before(item);
    }
  };
  const renderList = () => {
    const list = popper.querySelector("ul");
    list.innerHTML = "";
    for (const text of choices.filter((t) => t.includes(input.value))) {
      const on = state.values.includes(text);
      const li = doc.createElement("li");
      li.className = `el-select-dropdown__item${on ? " is-selected" : ""}`; li.setAttribute("role", "option"); li.setAttribute("aria-selected", String(on));
      li.innerHTML = `<span>${text}</span>`;
      li.addEventListener("click", () => { state.clicks.push(text); state.values = on ? state.values.filter((v) => v !== text) : [...state.values, text]; input.value = ""; renderTags(); renderList(); });
      list.append(li);
    }
  };
  root.querySelector(".el-select__wrapper").addEventListener("click", () => {
    state.open = true; input.setAttribute("aria-expanded", "true");
    if (!popper) {
      popper = doc.createElement("div"); popper.className = "el-select__popper el-popper";
      popper.innerHTML = '<div class="el-select-dropdown is-multiple"><div class="el-scrollbar"><ul id="el-id-1" class="el-select-dropdown__list" role="listbox"></ul></div></div>';
      doc.body.append(popper);
    }
    popper.hidden = false; renderList();
  });
  input.addEventListener("input", () => setTimeout(renderList, 10));
  input.addEventListener("keydown", (event) => { if (event.key === "Escape") { state.escapes += 1; state.open = false; popper.hidden = true; } });
  renderTags();
  return { ...h, root, state, isOpen: () => state.open };
}

const LANGS = ["英语", "日语", "韩语", "法语", "德语", "俄语", "西班牙语"];

test("splitMultipleValues: list separators split, slashes and spaces do not, repeats are dropped", () => {
  assert.deepEqual(helpers.splitMultipleValues("英语、日语，韩语;法语；德语|俄语｜英语"), ["英语", "日语", "韩语", "法语", "德语", "俄语"]);
  assert.deepEqual(helpers.splitMultipleValues("C/C++\nJava EE"), ["C/C++", "Java EE"]);
  assert.deepEqual(helpers.splitMultipleValues(" 、 "), []);
});

test("AI answers for a multiple select are checked part by part against its options", () => {
  const field = { fieldId: "lang", label: "外语语种", inputType: "select", multiple: true, options: ["请选择", ...LANGS] };
  assert.deepEqual(helpers.filterValidMatches([field], [{ fieldId: "lang", value: "英语、日语" }]), [{ fieldId: "lang", value: "英语、日语" }]);
  assert.deepEqual(helpers.filterValidMatches([field], [{ fieldId: "lang", value: "英语、拉丁语" }]), []);
  // 单选照旧整段比。
  assert.deepEqual(helpers.filterValidMatches([{ ...field, multiple: undefined }], [{ fieldId: "lang", value: "英语、日语" }]), []);
});

test("antd 5 multiple select: each value is picked, the dropdown is closed and the tags are checked", async () => {
  const h = antd5(LANGS);
  assert.equal(h.target.controlKind, "custom-select");
  const result = await h.api.operate(h.target, "英语、日语");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.state.values, ["英语", "日语"]);
  assert.deepEqual(h.state.clicks, ["英语", "日语"]);
  assert.equal(h.isOpen(), false, "closed after picking");
  assert.equal(h.api.check(h.target).ok, true);
  h.state.values = ["英语"]; h.root.querySelectorAll(".ant-select-selection-overflow-item:not(.ant-select-selection-overflow-item-suffix)")[1].remove();
  assert.equal(h.api.check(h.target).ok, false, "a tag that went away is noticed");
});

test("antd 5 multiple select: a value off the first screen is searched for, an already picked one is not clicked again, synonyms count", async () => {
  const cities = Array.from({ length: 40 }, (_, i) => `城市${String(i + 1).padStart(2, "0")}`);
  const h = antd5(cities);
  const result = await h.api.operate(h.target, "城市03、城市37");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.state.values, ["城市03", "城市37"]);
  // 已经选着的同名项不再点（antd 再点一次会取消）。
  const picked = antd5(LANGS, { selected: ["英语"] });
  const again = await picked.api.operate(picked.target, "英语、日语");
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.deepEqual(picked.state.clicks, ["日语"]);
  assert.deepEqual(picked.state.values, ["英语", "日语"]);
  // 外语等级按同义写法选（选项里有几种外语等级）。
  const levels = antd5(["四级", "六级", "专四", "专八"]);
  const synonym = await levels.api.operate(levels.target, "CET-6、专业英语八级");
  assert.equal(synonym.ok, true, JSON.stringify(synonym));
  assert.deepEqual(levels.state.values, ["六级", "专八"]);
});

test("antd 5 multiple select: tags that are not wanted are removed, wanted ones are kept", async () => {
  const h = antd5(LANGS, { selected: ["韩语", "英语"] });
  const result = await h.api.operate(h.target, "英语、日语");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.state.removed, ["韩语"]);
  assert.deepEqual(h.state.values, ["英语", "日语"]);
});

test("antd 5 multiple select already showing exactly the wanted values is left alone", async () => {
  const h = antd5(LANGS, { selected: ["日语", "英语"] });
  const result = await h.api.operate(h.target, "英语、日语");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.state.clicks, []);
  assert.deepEqual(h.state.removed, []);
});

test("antd 5 multiple select: a value with no option stops there, a tag without a remove button is not touched", async () => {
  const h = antd5(LANGS);
  const result = await h.api.operate(h.target, "英语、拉丁语、日语");
  assert.equal(result.reason, "no_option_match", JSON.stringify(result));
  assert.deepEqual(h.state.clicks, ["英语"], "nothing after the missing value is clicked");
  assert.equal(h.isOpen(), false, "the dropdown is closed after the failure");
  const fixed = antd5(LANGS, { selected: ["韩语"], noRemove: true });
  const refused = await fixed.api.operate(fixed.target, "英语");
  assert.equal(refused.reason, "unsupported_control");
  assert.deepEqual(fixed.state.clicks, []);
  assert.deepEqual(fixed.state.values, ["韩语"]);
});

test("antd 5 multiple select: when a wanted value is missing, the tags picked before are kept", async () => {
  const h = antd5(LANGS, { selected: ["韩语"] });
  const result = await h.api.operate(h.target, "英语、拉丁语");
  assert.equal(result.reason, "no_option_match", JSON.stringify(result));
  assert.deepEqual(h.state.removed, [], "韩语 is only removed once everything wanted is picked");
  assert.deepEqual(h.state.values, ["韩语", "英语"]);
});

test("antd 5 multiple select: an option whose text holds a list separator is one value, and more than ten values are picked", async () => {
  const h = antd5(["Java、C++", "Go", "Rust"]);
  const result = await h.api.operate(h.target, "Java、C++");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.state.values, ["Java、C++"]);
  const cities = Array.from({ length: 40 }, (_, i) => `城市${String(i + 1).padStart(2, "0")}`);
  const many = antd5(cities);
  const wanted = cities.slice(0, 12);
  const all = await many.api.operate(many.target, wanted.join("、"));
  assert.equal(all.ok, true, JSON.stringify(all));
  assert.deepEqual(many.state.values, wanted);
});

test("antd 5 multiple select: a hidden + N slot left by rc-overflow is not taken for collapsed tags", async () => {
  const h = antd5(LANGS, { selected: ["英语"] });
  const rest = h.doc.createElement("div"); rest.className = "ant-select-selection-overflow-item ant-select-selection-overflow-item-rest"; rest.style.opacity = "0";
  rest.innerHTML = '<span class="ant-select-selection-item">+ 0 ...</span>';
  h.root.querySelector(".ant-select-selection-overflow-item-suffix").before(rest);
  const result = await h.api.operate(h.target, "英语、日语");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.state.values, ["英语", "日语"]);
});

test("Element UI 2 multiple select: a value that cannot be found leaves no search text behind and the dropdown closed", async () => {
  const h = elementUi(LANGS);
  const search = h.root.querySelector(".el-select__input");
  const result = await h.api.operate(h.target, "日语、拉丁语");
  assert.equal(result.reason, "no_option_match", JSON.stringify(result));
  assert.deepEqual(h.state.values, ["日语"]);
  assert.equal(search.value, "", "the query typed for 拉丁语 is cleared");
  assert.equal(h.isOpen(), false);
});

test("antd 5 multiple select whose tags fold into + N while picking stops as unsupported, with the dropdown closed", async () => {
  const h = antd5(LANGS, { maxTags: 2 });
  const result = await h.api.operate(h.target, "英语、日语、韩语、法语");
  assert.equal(result.reason, "unsupported_control", JSON.stringify(result));
  assert.deepEqual(h.state.values, ["英语", "日语", "韩语"], "stops once the tags can no longer be read");
  assert.equal(h.isOpen(), false);
});

test("antd multiple select with collapsed tags (+ N) is not guessed", async () => {
  const h = antd5(LANGS, { selected: ["英语"] });
  const rest = h.doc.createElement("div"); rest.className = "ant-select-selection-overflow-item ant-select-selection-overflow-item-rest";
  rest.innerHTML = '<span class="ant-select-selection-item">+ 2 ...</span>';
  h.root.querySelector(".ant-select-selection-overflow-item-suffix").before(rest);
  const result = await h.api.operate(h.target, "英语、日语");
  assert.equal(result.reason, "unsupported_control");
  assert.deepEqual(h.state.clicks, []);
});

test("Element UI 2 multiple select: values are searched and picked, removed tags go, the dropdown is closed with Escape", async () => {
  const h = elementUi(LANGS, { selected: ["俄语"] });
  const result = await h.api.operate(h.target, "日语、德语");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.state.removed, ["俄语"]);
  assert.deepEqual(h.state.values, ["日语", "德语"]);
  assert.equal(h.isOpen(), false);
  assert.equal(h.state.escapes, 1);
  assert.equal(h.api.check(h.target).ok, true);
});

test("Element UI 2 multiple select in a dialog is closed without Escape", async () => {
  const h = elementUi(LANGS, { dialog: true });
  let escapes = 0;
  h.doc.addEventListener("keydown", (event) => { if (event.key === "Escape") escapes += 1; });
  const result = await h.api.operate(h.target, "英语");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(escapes, 0, "no Escape inside a dialog (#409)");
  assert.equal(h.isOpen(), false);
});

test("Element Plus multiple select: an empty one is recognised once open, one with tags from the start", async () => {
  const empty = elementPlus(LANGS);
  const first = await empty.api.operate(empty.target, "英语、法语");
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(empty.state.values, ["英语", "法语"]);
  assert.equal(empty.isOpen(), false);
  const shown = elementPlus(LANGS, { selected: ["法语"] });
  assert.equal(shown.w.ResumeProCustomControls.hasExistingValue(shown.target), true);
  assert.deepEqual(Array.from(shown.w.ResumeProCustomControls.readSelection(shown.target).texts), ["法语"]);
  const second = await shown.api.operate(shown.target, "法语、西班牙语");
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.deepEqual(shown.state.clicks, ["西班牙语"]);
});

test("native multiple select: every part chooses one option, any unmatched part leaves it untouched", async () => {
  const dom = new JSDOM(`<form><label for="lang">外语语种</label><select id="lang" multiple><option value="">请选择</option>${LANGS.map((t, i) => `<option value="${i}">${t}</option>`).join("")}</select></form>`, { runScripts: "outside-only" });
  const w = dom.window;
  for (const file of ["ai-helpers.js", "custom-controls.js", "control-adapters.js"]) w.eval(fs.readFileSync(file, "utf8"));
  const api = w.ResumeProControls.create({ timeoutMs: 200, settleMs: 35, isVisible: visible });
  const select = w.document.getElementById("lang");
  const target = { kind: "element", element: select, elements: [select], root: select, controlKind: "select" };
  const chosen = () => Array.from(select.selectedOptions, (option) => option.text);
  const result = await api.operate(target, "日语、英语");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(chosen(), ["英语", "日语"]);
  const missing = await api.operate(target, "法语、拉丁语");
  assert.equal(missing.reason, "no_option_match");
  assert.deepEqual(chosen(), ["英语", "日语"], "unchanged");
  // 重新填写时只留这次要的。
  const replaced = await api.operate(target, "法语");
  assert.equal(replaced.ok, true, JSON.stringify(replaced));
  assert.deepEqual(chosen(), ["法语"]);
  // 选项文字里本来就带顿号：整段是一项。
  select.insertAdjacentHTML("beforeend", '<option value="x">Java、C++</option>');
  const whole = await api.operate(target, "Java、C++");
  assert.equal(whole.ok, true, JSON.stringify(whole));
  assert.deepEqual(chosen(), ["Java、C++"]);
  assert.deepEqual(helpers.filterValidMatches([{ fieldId: "skill", label: "技能", inputType: "select", multiple: true, options: ["Java、C++", "Go"] }],
    [{ fieldId: "skill", value: "Java、C++" }]), [{ fieldId: "skill", value: "Java、C++" }]);
});
