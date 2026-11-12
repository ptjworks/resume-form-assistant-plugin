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

function simulateDropdown(root, { transferred = false, commit = true, choices = [["本科"], ["研究生", true]] } = {}) {
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
    options(input ? [] : choices);
  });
  trigger.addEventListener("keydown", event => { if (event.key === "Escape") close(); });
  input?.addEventListener("input", () => options([["示例大学"], ["示例大学附属学院"]]));
  return { picked, committed };
}

function operator(doc) {
  const w = doc.defaultView;
  for (const file of ["ai-helpers.js", "region-data.js", "custom-controls.js", "control-adapters.js"]) w.eval(fs.readFileSync(`extension/${file}`, "utf8"));
  return w.ResumeProControls.create({ timeoutMs: 550, settleMs: 35, isVisible: visible });
}

test("an explicit outer combobox opens the menu while its nested search input supplies the query", async t => {
  const doc = load(t, `<div class="form-item">
    <div id="office" role="combobox" aria-label="办公地点" tabindex="0" aria-controls="locations" aria-expanded="false">
      ${select("inner", { search: true }).replace('placeholder="请选择"', 'aria-autocomplete="list"')}
    </div>
  </div><div id="locations" role="listbox" hidden><div role="option">其他城市</div></div>`, "https://jobs.example.test/apply");
  const outer = doc.getElementById("office");
  const inner = doc.getElementById("inner");
  const input = inner.querySelector("input.ui-select-input");
  const list = doc.getElementById("locations");
  const seen = [];
  outer.addEventListener("click", event => {
    if (event.target !== outer) return;
    seen.push("outer");
    outer.setAttribute("aria-expanded", "true");
    list.hidden = false;
  });
  inner.querySelector(".ui-select-selection").addEventListener("click", () => seen.push("inner"));
  input.addEventListener("input", () => {
    if (input.value !== "杭州") return;
    seen.push("query");
    list.innerHTML = '<div role="option">杭州</div>';
    list.firstElementChild.addEventListener("click", () => {
      outer.setAttribute("aria-valuetext", "杭州");
      outer.setAttribute("aria-expanded", "false");
      list.hidden = true;
    });
  });
  const { controls } = scanner.scanPage(doc, { isVisible: visible });
  assert.equal(controls.length, 1);
  assert.equal(controls[0].root, outer);
  assert.equal(controls[0].element, outer);
  const result = await operator(doc).operate(controls[0], "杭州");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(seen, ["outer", "query"]);
});

test("a structured select can be filled on another site when no explicit outer combobox exists", async t => {
  const doc = load(t, select("level").replace('id="level"', 'id="level" aria-label="学历"'), "https://jobs.example.test/apply");
  const selectRoot = doc.getElementById("level");
  const dropdown = simulateDropdown(selectRoot);
  const { controls } = scanner.scanPage(doc, { isVisible: visible });
  assert.equal(controls.length, 1);
  assert.equal(controls[0].root, selectRoot);
  const result = await operator(doc).operate(controls[0], "本科");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(dropdown.picked, ["本科"]);
});

test("an unrelated ui-select class does not displace the existing outer control", t => {
  const doc = load(t, '<div role="combobox" id="office" aria-label="办公地点"><span class="ui-select" aria-autocomplete="list"></span></div>',
    "https://jobs.example.test/apply");
  const { controls } = scanner.scanPage(doc, { isVisible: visible });
  assert.deepEqual(controls.map(control => control.element.id), ["office"]);
});

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

test("BOSS reveals an offscreen dropdown before opening, and maps only the appropriate education or exam terms", async t => {
  const doc = load(t, row("最高学历", select("level")) + row("英语等级", select("english"))
    + row("学位", select("degree")));
  const level = doc.querySelector("#level");
  const chooser = simulateDropdown(level, { transferred: true, choices: [["博士"], ["本科"]] });
  const english = simulateDropdown(doc.querySelector("#english"), { choices: [["四级"], ["六级"]] });
  const degree = simulateDropdown(doc.querySelector("#degree"), { choices: [["学士"], ["理学博士"], ["博士后"]] });
  let scrolled = false;
  const trigger = level.querySelector(".ui-select-selection");
  const anchor = trigger.getBoundingClientRect;
  level.getBoundingClientRect = trigger.getBoundingClientRect = () => scrolled ? anchor()
    : { width: 120, left: 20, right: 140, top: -170, bottom: -140 };
  level.scrollIntoView = () => { scrolled = true; };
  const api = operator(doc);
  const [a, b, c] = scanner.scanPage(doc, { isVisible: visible }).controls;
  for (const [entry, value] of [[a, "博士研究生（全日制）"], [b, "CET-6（587 分）"], [c, "博士"]]) {
    const result = await api.operate({ ...entry, binding: entry }, value);
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  assert.equal(scrolled, true);
  assert.deepEqual([chooser.picked, english.picked, degree.picked], [["博士"], ["六级"], ["理学博士"]]);
  assert.equal((await api.operate({ ...c, binding: c }, "本科")).reason, "no_option_match");
});

test("BOSS city selects the committed province, city and district through the website's columns", async t => {
  const doc = load(t, row("现居住城市", '<div class="ui-cascader2"><input placeholder="请选择" aria-expanded="false"></div>'));
  const root = doc.querySelector(".ui-cascader2"), input = root.querySelector("input");
  const panel = doc.createElement("div");
  panel.className = "ui-popper ui-cascader2__dropdown";
  panel.hidden = true;
  root.append(panel);
  const clicked = [];
  const columns = [["江苏省", "浙江省"], ["南京市", "苏州市"], ["栖霞区", "玄武区"]];
  function appendColumn(index) {
    const list = doc.createElement("ul");
    list.className = "ui-cascader2-menu__list";
    for (const name of columns[index]) {
      const item = doc.createElement("li");
      item.className = "ui-cascader2-node";
      item.innerHTML = `<span class="ui-cascader2-node__label">${name}</span>`;
      item.addEventListener("click", () => {
        clicked.push(name);
        if (index < 2) appendColumn(index + 1);
        else {
          input.value = clicked.join(" / ");
          input.setAttribute("aria-expanded", "false");
          panel.hidden = true;
        }
      });
      list.append(item);
    }
    panel.append(list);
  }
  input.addEventListener("click", () => {
    panel.hidden = false; input.setAttribute("aria-expanded", "true"); appendColumn(0);
  });
  const [city] = scanner.scanPage(doc, { isVisible: visible }).controls;
  assert.equal(city.controlKind, "cascader");
  assert.equal(city.root, root);
  const api = operator(doc);
  const result = await api.operate({ ...city, binding: city }, "江苏省南京市栖霞区");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(clicked, ["江苏省", "南京市", "栖霞区"]);
  assert.equal(input.value, "江苏省 / 南京市 / 栖霞区");
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
  let scrolled = false;
  input.getBoundingClientRect = () => scrolled ? { top: 20, bottom: 40, left: 20, right: 140 }
    : { top: -170, bottom: -150, left: 20, right: 140 };
  input.scrollIntoView = () => { scrolled = true; };
  input.addEventListener("focus", () => { if (scrolled) panel.hidden = false; });
  panel.querySelector("table").addEventListener("click", event => {
    input.value = `2020/09/${event.target.textContent.padStart(2, "0")}`;
    panel.hidden = true;
  });
  const [date] = scanner.scanPage(doc, { isVisible: visible }).controls;
  const api = operator(doc), entry = { ...date, binding: date, controlKind: "date" };
  const result = await api.operate(entry, "2020-09-07");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(scrolled, true);
  assert.equal(input.value, "2020/09/07");
  assert.equal(api.check(entry).ok, true);
});
