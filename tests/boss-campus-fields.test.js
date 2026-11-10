const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { JSDOM } = require("jsdom");
const scanner = require("../extension/field-scan.js");

const campus = "https://xiaoyuan.zhipin.com/volunteer/index";
const visible = el => !el.closest("[hidden]");
const row = (title, html) => `<div class="form-item">
  ${title ? `<div class="item-label"><div class="form-label-tips"><span class="label-text">${title}</span>
    <span class="form-tip">帮助说明</span></div></div>` : ""}
  <div class="item-content">${html}</div>
</div>`;
const select = (id, { search = false, disabled = false } = {}) => `<div id="${id}" class="ui-select ui-select-single ${disabled ? "ui-select-disabled" : ""}">
  <div class="ui-select-selection" tabindex="0"><input type="hidden">
    <span class="ui-select-placeholder">请选择</span>
    ${search ? '<div class="ui-select-inner"><label><input class="ui-select-input" placeholder="请选择"></label></div>' : ""}
  </div>
</div>`;
const school = () => `<div class="combo-input-container">
  <div class="ui-dropmenu"><div class="ui-dropmenu-label"><span>中国大陆</span></div></div>
  <div class="content">${select("school", { search: true })}</div>
</div>`;

function load(t, html, url = campus) {
  const dom = new JSDOM(`<form class="ui-form">${html}</form>`, { url, runScripts: "outside-only" });
  t.after(() => dom.window.close());
  return dom.window.document;
}

test("BOSS binds form titles, inner prefixes and the school search without borrowing auxiliary controls", t => {
  const html = row("真实姓名", '<input placeholder="请输入">')
    + row("", '<div class="ui-input"><span class="label-prefix">身高(CM)</span><input placeholder="请输入"></div>')
    + row("性别", select("gender"))
    + row("最高学历", select("level", { disabled: true }))
    + row("学校名称", school())
    + row("本人手机号", `<div class="phone-combine">${select("code", { search: true }).replace('class="ui-select ui-select-single', 'class="area-code-select ui-select ui-select-single')}<input type="tel" placeholder="请输入"></div>`)
    + row("", '<input placeholder="请输入"><span class="label-prefix">元</span>');
  const doc = load(t, html);
  const { controls } = scanner.scanPage(doc, { isVisible: visible });
  assert.deepEqual(controls.map(({ label, controlKind }) => [label, controlKind]), [
    ["真实姓名", "text"], ["身高(CM)", "text"], ["性别", "custom-select"], ["学校名称", "custom-select"], ["本人手机号", "text"]
  ]);
  assert.equal(controls[2].element.id, "gender");
  assert.equal(controls[3].element, doc.querySelector("#school .ui-select-input"));
  assert.equal(scanner.labelForElement(controls[3].element, { isVisible: visible }), "学校名称");
  assert.ok(controls.every(control => scanner.isBindingCurrent(control, doc, { isVisible: visible })));
  const schoolTitle = controls[3].item.querySelector(".label-text");
  schoolTitle.textContent = "其他学校";
  assert.equal(scanner.isBindingCurrent(controls[3], doc, { isVisible: visible }), false);
  const elsewhere = load(t, html, "https://example.test/");
  assert.ok(!scanner.scanPage(elsewhere, { isVisible: visible }).controls.some(control => control.element.id === "gender"));
});

function simulateDropdown(root, { transferred = false, commit = true } = {}) {
  const doc = root.ownerDocument;
  const trigger = root.querySelector(".ui-select-selection");
  const input = root.querySelector(".ui-select-input");
  const committed = root.querySelector('input[type="hidden"]');
  const placeholder = root.querySelector(".ui-select-placeholder");
  const popup = doc.createElement("div");
  popup.className = transferred ? "ui-select-dropdown ui-select-dropdown-transfer" : "ui-select-dropdown";
  if (transferred) popup.dataset.transfer = "true";
  popup.innerHTML = '<ul class="ui-dropdown-list"></ul>';
  popup.hidden = true;
  (transferred ? doc.body : root).append(popup);
  trigger.getBoundingClientRect = () => ({ width: 120, left: 20, right: 140, top: 20, bottom: 40 });
  popup.getBoundingClientRect = () => ({ width: 120, left: 20, right: 140, top: 40, bottom: 120 });
  const picked = [];
  const close = () => { root.classList.remove("ui-select-visible"); popup.hidden = true; };
  const options = values => {
    const list = popup.firstElementChild;
    list.replaceChildren();
    for (const [text, disabled] of values) {
      const li = doc.createElement("li");
      li.className = disabled ? "ui-select-item ui-select-item-disabled" : "ui-select-item";
      li.textContent = text;
      li.addEventListener("click", () => {
        picked.push(text);
        if (commit) {
          committed.value = "selected-id";
          if (input) input.value = text;
          else { placeholder.className = "ui-select-selected-value"; placeholder.textContent = text; }
        }
        close();
      });
      list.append(li);
    }
  };
  trigger.addEventListener("click", () => {
    root.classList.add("ui-select-visible");
    popup.hidden = false;
    options(input ? [] : [["本科"], ["研究生", true]]);
  });
  trigger.addEventListener("keydown", event => { if (event.key === "Escape") close(); });
  input?.addEventListener("input", () => options([["示例大学"], ["示例大学附属学院"]]));
  return { picked, committed };
}

function operator(doc) {
  const w = doc.defaultView;
  for (const file of ["ai-helpers.js", "custom-controls.js", "control-adapters.js"]) w.eval(fs.readFileSync(`extension/${file}`, "utf8"));
  return w.ResumeProControls.create({ timeoutMs: 550, settleMs: 35, isVisible: visible });
}

test("BOSS custom selects write through the matching popup and verify committed values", async t => {
  const doc = load(t, row("最高学历", select("level")) + row("学校名称", school()));
  const plain = simulateDropdown(doc.querySelector("#level"));
  const remote = simulateDropdown(doc.querySelector("#school"), { transferred: true });
  const unrelated = doc.createElement("div");
  unrelated.className = "ui-select-dropdown ui-select-dropdown-transfer";
  unrelated.dataset.transfer = "true";
  unrelated.getBoundingClientRect = () => ({ width: 120, left: 20, right: 140, top: 40, bottom: 120 });
  unrelated.innerHTML = '<ul class="ui-dropdown-list"><li class="ui-select-item">示例大学</li></ul>';
  doc.body.append(unrelated);
  let foreignClicks = 0;
  unrelated.querySelector("li").addEventListener("click", () => { foreignClicks += 1; });
  const api = operator(doc);
  const [level, college] = scanner.scanPage(doc, { isVisible: visible }).controls;
  level.item.classList.add("lock");
  assert.equal((await api.operate(level, "本科")).reason, "control_disabled");
  assert.deepEqual(scanner.scanPage(doc, { isVisible: visible }).controls.map(control => control.label), ["学校名称"]);
  level.item.classList.remove("lock");
  assert.equal((await api.operate(level, "研究生")).reason, "no_option_match");
  const plainResult = await api.operate(level, "本科");
  assert.equal(plainResult.ok, true, JSON.stringify(plainResult));
  const schoolResult = await api.operate(college, "示例大学");
  assert.equal(schoolResult.ok, true, JSON.stringify(schoolResult));
  assert.deepEqual(plain.picked, ["本科"]);
  assert.deepEqual(remote.picked, ["示例大学"]);
  assert.equal(foreignClicks, 0);
  assert.equal(doc.querySelector(".ui-dropmenu-label").textContent, "中国大陆");
  assert.equal(api.check(college).ok, true);
});

test("BOSS school search does not count the typed query as a selected school", async t => {
  const doc = load(t, row("学校名称", school()));
  const remote = simulateDropdown(doc.querySelector("#school"), { transferred: true, commit: false });
  remote.committed.value = "previous-id";
  const api = operator(doc);
  const [college] = scanner.scanPage(doc, { isVisible: visible }).controls;
  assert.equal((await api.operate(college, "示例大学")).reason, "selection_not_committed");
  assert.deepEqual(remote.picked, ["示例大学"]);
  assert.equal(remote.committed.value, "previous-id");
});

const monthNames = "一 二 三 四 五 六 七 八 九 十 十一 十二".split(" ");

function bossMonth(root, { portal = false, min = "" } = {}) {
  const doc = root.ownerDocument, input = root.querySelector("input");
  const panel = doc.createElement("div");
  panel.className = "ui-picker-panel ui-date-picker ui-popper";
  panel.hidden = true;
  (portal ? doc.body : root).append(panel);
  input.getBoundingClientRect = () => ({ width: 120, left: 20, right: 140, top: 20, bottom: 40 });
  panel.getBoundingClientRect = () => ({ width: 120, left: 20, right: 140, top: 44, bottom: 200 });
  let year = 2026;
  let opened = 0;
  function render() {
    panel.innerHTML = `<div class="ui-date-picker-header"><button type="button" class="ui-icon-d-arrow-left"></button>
      <span class="ui-date-picker-header-label">${year} 年</span><button type="button" class="ui-icon-d-arrow-right"></button></div>
      <table class="ui-month-table"><tbody><tr>${monthNames.map((name, index) => {
        const month = String(index + 1).padStart(2, "0");
        return `<td class="${`${year}/${month}` < min ? "disabled" : ""}"><div><a class="cell">${name}月</a></div></td>`;
      }).join("")}</tr></tbody></table>`;
    panel.querySelector(".ui-icon-d-arrow-left").onclick = () => { year -= 1; render(); };
    panel.querySelector(".ui-icon-d-arrow-right").onclick = () => { year += 1; render(); };
    panel.querySelectorAll("td").forEach((cell, i) => {
      cell.onclick = () => {
        if (cell.classList.contains("disabled")) return;
        input.value = `${year}/${String(i + 1).padStart(2, "0")}`;
        panel.hidden = true;
      };
    });
  }
  input.addEventListener("click", () => { opened += 1; render(); panel.hidden = false; });
  input.addEventListener("keydown", event => { if (event.key === "Escape") panel.hidden = true; });
  return { opened: () => opened, panel };
}

test("BOSS education dates open and commit two independent calendars instead of a shared range panel", async t => {
  const doc = load(t, `<div class="group-part-item" data-group-id="EDUCATION">${row("时间段", `
    <div class="date-picker-range-wrapper">
      <div class="ui-date-editor ui-date-editor-month"><input readonly placeholder="开始时间"></div>
      <span class="date-range-separator">至</span>
      <div class="ui-date-editor ui-date-editor-month"><input readonly placeholder="结束时间"></div>
    </div>`)}</div>`);
  const [left, right] = doc.querySelectorAll(".ui-date-editor");
  const first = bossMonth(left);
  const last = bossMonth(right, { portal: true, min: "2020/09" });
  const stale = doc.createElement("div");
  stale.className = last.panel.className;
  stale.getBoundingClientRect = last.panel.getBoundingClientRect;
  doc.body.append(stale);
  const [start, end] = scanner.scanPage(doc, { isVisible: visible }).controls;
  assert.equal(start.root, end.root);
  assert.deepEqual([start, end].map(c => [c.label, c.pickerType, c.rangePart]), [
    ["时间段（开始）", "boss", "开始"], ["时间段（结束）", "boss", "结束"]
  ]);
  const api = operator(doc);
  const entry = control => ({ ...control, binding: control, pickerInputType: "month", controlKind: "date" });
  const startResult = await api.operate(entry(start), "2020-09");
  assert.equal(startResult.ok, true, JSON.stringify(startResult));
  assert.equal(end.element.value, "", "the first click sequence cannot commit the second picker");
  assert.equal(last.opened(), 0);
  const endResult = await api.operate(entry(end), "2024-06");
  assert.equal(endResult.ok, true, JSON.stringify(endResult));
  assert.deepEqual([start.element.value, end.element.value], ["2020/09", "2024/06"]);
  assert.deepEqual([first.opened(), last.opened()], [1, 1]);
  const invalid = await api.operate(entry(end), "2020-08");
  assert.equal(invalid.reason, "no_option_match");
  assert.equal(end.element.value, "2024/06");
});

test("BOSS day calendars commit the requested day and keep date precision in the read-back", async t => {
  const doc = load(t, row("出生年月", `<div class="ui-date-editor ui-date-editor-date"><input readonly placeholder="请选择">
    <div class="ui-picker-panel ui-date-picker ui-popper" hidden>
      <div class="ui-date-picker-header"><span>2020 年</span><span>九月</span></div>
      <table class="ui-date-table"><tbody><tr>${Array.from({ length: 30 }, (_, i) =>
        `<td><div><span>${i + 1}</span></div></td>`).join("")}</tr></tbody></table>
    </div></div>`));
  const panel = doc.querySelector(".ui-picker-panel"), input = doc.querySelector("input");
  input.addEventListener("click", () => { panel.hidden = false; });
  panel.querySelector("table").addEventListener("click", event => {
    input.value = `2020/09/${event.target.textContent.padStart(2, "0")}`;
    panel.hidden = true;
  });
  const [date] = scanner.scanPage(doc, { isVisible: visible }).controls;
  const api = operator(doc), entry = { ...date, binding: date, controlKind: "date" };
  const result = await api.operate(entry, "2020-09-07");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(input.value, "2020/09/07");
  assert.equal(api.check(entry).ok, true);
});
