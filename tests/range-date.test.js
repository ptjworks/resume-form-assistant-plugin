// #429 区间日期（antd RangePicker、Element daterange / monthrange、antd 3 和 ant-design-vue 1.x 的 RangePicker）。
// 页面组件按真组件上看到的行为写替身（antd 4.24、5.21，element-ui 2.15、element-plus 2.8，antd 3.26、ant-design-vue 1.7）：
// - 只选一头就收起弹层，选的那头不算；两头都有了才提交。
// - rc-picker：选完开始，焦点交给结束框，弹层不收；选完结束一起提交、收起。
// - Element：两个框各打各的字，结束框回车提交并收起；Vue 处理完上一次改动之前的回车不收起。
// - 两个面板的日历（只读的 Element、antd 3）：第一下点的是开始，第二下是结束；没值时两个面板挨着，已有值时各停在开始月、结束月。
// 今天固定为 2026-11-02。只有虚构的值。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { JSDOM } = require("jsdom");
const scanner = require("../field-scan.js");
const helpers = require("../ai-helpers.js");

const visible = (el) => !el.closest("[hidden], .ant-picker-dropdown-hidden");
const pad = (n) => String(n).padStart(2, "0");
const iso = (date) => `${date.y}-${pad(date.m)}-${pad(date.d)}`;
const parse = (text) => {
  const hit = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(text);
  return hit ? { y: Number(hit[1]), m: Number(hit[2]), d: hit[3] ? Number(hit[3]) : 1 } : null;
};
const key = (date) => date.y * 10000 + date.m * 100 + date.d;
const daysIn = (y, m) => new Date(y, m, 0).getDate();
const shift = (month, by) => { const index = month.y * 12 + month.m - 1 + by; return { y: Math.floor(index / 12), m: (index % 12) + 1 }; };

function load(html) {
  const dom = new JSDOM(`<form>${html}</form><button type="button" id="away">空白</button>`, { runScripts: "outside-only" });
  const w = dom.window;
  for (const file of ["ai-helpers.js", "custom-controls.js", "control-adapters.js"]) w.eval(fs.readFileSync(file, "utf8"));
  const api = w.ResumeProControls.create({ timeoutMs: 400, settleMs: 30, isVisible: visible });
  return { w, doc: w.document, api };
}
// 扫描出来的两个框，按填写流程的样子交给控件层（options.range 是另一头和它的值）。
function parts(doc, title) {
  const scan = scanner.scanPage(doc, { isVisible: () => true });
  const entry = (control) => ({ kind: "element", element: control.element, elements: control.elements, root: control.root,
    controlKind: "date", pickerType: control.pickerType, binding: control, hints: {},
    pickerInputType: /month/i.test(control.root.className) ? "month" : "date" });
  const [start, end] = ["开始", "结束"].map((part) => scan.controls.find((control) => control.label === `${title}（${part}）`)).map(entry);
  assert.ok(start && end, `scanned ${title}`);
  return { start, end };
}

// Element 式的区间（element-ui、element-plus）。editable：框能打字；slash：只收 2019/09/01 这样的写法；
// month：monthrange；unlinked：已有值时两个面板各停在开始月、结束月（antd 3 的区间日历就是这样）。
// dialog：区间放在 Element 对话框里（Esc 会关掉对话框）。
function elementRange({ editable = true, slash = false, month = false, unlinked = false, title = "在校时间", value = null, dialog = false } = {}) {
  const h = load(`${dialog ? '<div class="el-dialog">' : ""}<div class="row"><label class="row-label">${title}</label>
    <div class="el-date-editor el-range-editor el-date-editor--${month ? "monthrange" : "daterange"}">
      <input class="el-range-input" placeholder="${month ? "开始月份" : "开始日期"}" ${editable ? "" : "readonly"}><span>至</span>
      <input class="el-range-input" placeholder="${month ? "结束月份" : "结束日期"}" ${editable ? "" : "readonly"}></div></div>${dialog ? "</div>" : ""}`);
  const { doc, w } = h;
  const boxes = Array.from(doc.querySelectorAll(".el-range-input"));
  const log = { opened: 0, writes: 0, clicks: 0, keys: [] };
  let model = value, pending = [null, null], picking = null, panel = null, months = null, dirty = false;
  const text = (date) => (month ? `${date.y}-${pad(date.m)}` : iso(date));
  const read = (raw) => {
    const hit = slash ? /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(raw) : month ? /^(\d{4})-(\d{2})$/.exec(raw) : /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    return hit ? { y: Number(hit[1]), m: Number(hit[2]), d: hit[3] ? Number(hit[3]) : 1 } : null;
  };
  const show = () => boxes.forEach((box, index) => { box.value = model ? text(model[index]) : ""; });
  const commit = (pair) => { model = pair; show(); close(); };
  const close = () => { panel?.remove(); panel = null; pending = [null, null]; picking = null; show(); };
  const draw = () => {
    const side = (index) => {
      const at = months[index];
      const buttons = (dir) => (dir < 0 ? `<button type="button" class="el-picker-panel__icon-btn d-arrow-left"></button><button type="button" class="el-picker-panel__icon-btn arrow-left"></button>`
        : `<button type="button" class="el-picker-panel__icon-btn arrow-right"></button><button type="button" class="el-picker-panel__icon-btn d-arrow-right"></button>`);
      const own = index === 0 ? buttons(-1) + (unlinked ? buttons(1) : "") : (unlinked ? buttons(-1) : "") + buttons(1);
      const cells = month
        ? ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"]
          .map((name, i) => `<td data-y="${at.y}" data-m="${i + 1}" data-d="1"><div><a class="cell">${name}</a></div></td>`).join("")
        : [...Array.from({ length: 3 }, (_, i) => { const prev = shift(at, -1); const d = daysIn(prev.y, prev.m) - 2 + i;
          return `<td class="prev-month" data-y="${prev.y}" data-m="${prev.m}" data-d="${d}"><div><span>${d}</span></div></td>`; }),
          ...Array.from({ length: daysIn(at.y, at.m) }, (_, i) => `<td class="available" data-y="${at.y}" data-m="${at.m}" data-d="${i + 1}"><div><span>${i + 1}</span></div></td>`),
          ...[1, 2].map((d) => { const next = shift(at, 1); return `<td class="next-month" data-y="${next.y}" data-m="${next.m}" data-d="${d}"><div><span>${d}</span></div></td>`; })].join("");
      return `<div class="el-picker-panel__content el-date-range-picker__content is-${index ? "right" : "left"}">
        <div class="el-date-range-picker__header">${own}<div>${month ? `${at.y} 年` : `${at.y} 年 ${at.m} 月`}</div></div>
        <table class="${month ? "el-month-table" : "el-date-table"}"><tbody><tr>${cells}</tr></tbody></table></div>`;
    };
    panel.innerHTML = `<div class="el-picker-panel__body">${side(0)}${side(1)}</div>`;
  };
  const open = () => {
    if (panel) return;
    log.opened += 1;
    const start = model ? model[0] : { y: 2026, m: 11 };
    const end = model && unlinked && (model[1].y * 12 + model[1].m) - (start.y * 12 + start.m) > (month ? 12 : 1) ? model[1] : shift(start, month ? 12 : 1);
    months = [{ y: start.y, m: start.m }, { y: end.y, m: end.m }];
    panel = doc.createElement("div");
    panel.className = "el-picker-panel el-date-range-picker el-popper";
    panel.addEventListener("click", (event) => {
      log.clicks += 1;
      const button = event.target.closest("button");
      if (button) {
        const step = (/d-arrow/.test(button.className) || month ? 12 : 1) * (/left/.test(button.className) ? -1 : 1);
        const index = button.closest(".is-right") ? 1 : 0;
        if (unlinked) months[index] = shift(months[index], step); else months = [shift(months[0], step), shift(months[1], step)];
        draw();
        return;
      }
      const cell = event.target.closest("td");
      if (!cell || /month/.test(cell.className)) return;
      const date = { y: Number(cell.dataset.y), m: Number(cell.dataset.m), d: Number(cell.dataset.d) };
      if (!picking) { picking = date; return; }
      const pair = key(date) < key(picking) ? [date, picking] : [picking, date];
      commit(pair);
    });
    doc.body.append(panel);
    draw();
  };
  const editor = doc.querySelector(".el-range-editor");
  editor.addEventListener("click", open);
  boxes.forEach((box, index) => {
    box.addEventListener("focus", open);
    box.addEventListener("input", () => { log.writes += 1; });
    box.addEventListener("change", () => {
      const date = read(box.value);
      if (!date) return;
      pending[index] = date;
      const pair = [pending[0] || model?.[0], pending[1] || model?.[1]];
      dirty = true;
      Promise.resolve().then(() => { dirty = false; });
      if (pair[0] && pair[1] && key(pair[0]) <= key(pair[1])) { model = pair; pending = [null, null]; }
    });
    box.addEventListener("keydown", (event) => {
      log.keys.push(event.key);
      if (event.key === "Escape") close();
      // 回车：两头都收下了才收起；Vue 还没处理完刚才的改动时不收（element-ui 2.15 上看到的）。
      if (event.key === "Enter" && !dirty && model && !pending[0] && !pending[1]) close();
    });
  });
  // 在外面按下：收起，没提交的不算。
  doc.addEventListener("mousedown", (event) => { if (panel && !panel.contains(event.target) && !editor.contains(event.target)) close(); });
  show();
  return { ...h, boxes, log, model: () => model && model.map(text), open: () => Boolean(panel), ...parts(doc, title) };
}

// rc-picker（antd 4/5）式的区间。antd4：选了年份直接回到日期面板（antd 5 先到月份面板）。
// disabledAfter：这一天以后的日子不能选（disabledDate）。
function antdRange({ antd4 = false, value = null, title = "在校时间", disabledAfter = null } = {}) {
  const h = load(`<div class="ant-form-item"><div class="ant-form-item-label"><label>${title}</label></div>
    <div class="ant-form-item-control"><div class="ant-picker ant-picker-range">
      <div class="ant-picker-input"><input readonly placeholder="开始日期"></div><div class="ant-picker-range-separator">→</div>
      <div class="ant-picker-input"><input readonly placeholder="结束日期"></div></div></div></div>`);
  const { doc } = h;
  const boxes = Array.from(doc.querySelectorAll(".ant-picker-input input"));
  const log = { opened: 0 };
  let model = value, pending = [null, null], active = 0, view = "date", left = { y: 2026, m: 11 }, decade = 2020, dropdown = null;
  const show = () => boxes.forEach((box, index) => { box.value = pending[index] ? iso(pending[index]) : model ? iso(model[index]) : ""; });
  const setActive = (index) => {
    active = index;
    boxes.forEach((box, i) => box.parentElement.classList.toggle("ant-picker-input-active", i === index));
    boxes[index].focus();
  };
  const close = () => { dropdown?.classList.add("ant-picker-dropdown-hidden"); pending = [null, null]; show(); };
  const cell = (title, text, inView = true) => {
    const off = disabledAfter && /^\d{4}-\d{2}-\d{2}$/.test(title) && key(parse(title)) > key(disabledAfter);
    return `<td title="${title}" class="ant-picker-cell${inView ? " ant-picker-cell-in-view" : ""}${off ? " ant-picker-cell-disabled" : ""}"><div class="ant-picker-cell-inner">${text}</div></td>`;
  };
  const header = (label) => `<div class="ant-picker-header"><button type="button" class="ant-picker-header-super-prev-btn"></button>${label}<button type="button" class="ant-picker-header-super-next-btn"></button></div>`;
  const yearContent = () => `${header(`<div class="ant-picker-header-view">${decade}-${decade + 9}</div>`)}
    <table><tbody><tr>${Array.from({ length: 12 }, (_, i) => cell(decade - 1 + i, decade - 1 + i, i > 0 && i < 11)).join("")}</tr></tbody></table>`;
  const draw = () => {
    const panels = dropdown.querySelector(".ant-picker-panels");
    if (view === "year") {
      panels.innerHTML = `<div class="ant-picker-panel"><div class="ant-picker-year-panel">${yearContent()}</div></div>`;
      return;
    }
    if (view === "month") {
      panels.innerHTML = `<div class="ant-picker-panel"><div class="ant-picker-month-panel">${header(`<button type="button" class="ant-picker-year-btn">${left.y}年</button>`)}
        <table><tbody><tr>${Array.from({ length: 12 }, (_, i) => cell(`${left.y}-${pad(i + 1)}`, `${i + 1}月`)).join("")}</tr></tbody></table></div></div>`;
      return;
    }
    const side = (at) => {
      const prev = shift(at, -1), next = shift(at, 1);
      const cells = [cell(iso({ ...prev, d: daysIn(prev.y, prev.m) }), daysIn(prev.y, prev.m), false),
        ...Array.from({ length: daysIn(at.y, at.m) }, (_, i) => cell(iso({ ...at, d: i + 1 }), i + 1)), cell(iso({ ...next, d: 1 }), 1, false)];
      return `<div class="ant-picker-panel"><div class="ant-picker-date-panel">${header(`<div class="ant-picker-header-view"><button type="button" class="ant-picker-year-btn">${at.y}年</button><button type="button" class="ant-picker-month-btn">${at.m}月</button></div>`)}
        <table><tbody><tr>${cells.join("")}</tr></tbody></table></div></div>`;
    };
    panels.innerHTML = side(left) + side(shift(left, 1));
  };
  const open = (index) => {
    if (!dropdown) {
      dropdown = doc.createElement("div");
      dropdown.className = "ant-picker-dropdown ant-picker-dropdown-range ant-picker-dropdown-hidden";
      dropdown.innerHTML = `<div class="ant-picker-panel-container"><div class="ant-picker-panels"></div></div>`;
      dropdown.addEventListener("mousedown", (event) => event.preventDefault());
      dropdown.addEventListener("click", (event) => {
        const target = event.target;
        if (target.closest(".ant-picker-year-btn")) { view = "year"; decade = Math.floor(left.y / 10) * 10; draw(); return; }
        if (target.closest(".ant-picker-month-btn")) { view = "month"; draw(); return; }
        const step = target.closest(".ant-picker-header-super-prev-btn") ? -1 : target.closest(".ant-picker-header-super-next-btn") ? 1 : 0;
        // 年份面板翻页时面板还是同一个元素，只换里面的内容（rc-picker 就是这样）。
        if (step && view === "year") { decade += step * 10; dropdown.querySelector(".ant-picker-year-panel").innerHTML = yearContent(); return; }
        if (step) { left = { ...left, y: left.y + step }; draw(); return; }
        const td = target.closest("td[title]");
        if (!td) return;
        if (view === "year") { left = { y: Number(td.title), m: left.m }; view = antd4 ? "date" : "month"; draw(); return; }
        if (view === "month") { left = { y: Number(td.title.slice(0, 4)), m: Number(td.title.slice(5)) }; view = "date"; draw(); return; }
        const date = parse(td.title);
        pending[active] = date;
        const other = pending[1 - active] || model?.[1 - active];
        if (other) {
          const pair = active === 0 ? [date, other] : [other, date];
          if (key(pair[0]) <= key(pair[1])) { model = pair; close(); return; }
        }
        show();
        setActive(1 - active);
      });
      doc.body.append(dropdown);
    }
    if (dropdown.classList.contains("ant-picker-dropdown-hidden")) {
      log.opened += 1;
      view = "date";
      left = model ? { y: model[0].y, m: model[0].m } : { y: 2026, m: 11 };
      dropdown.classList.remove("ant-picker-dropdown-hidden");
      draw();
    }
    setActive(index);
  };
  boxes.forEach((box, index) => {
    box.addEventListener("mousedown", () => open(index));
    // 焦点离开组件（不进日历、不进另一个框）就收起，没提交的不算。
    box.addEventListener("blur", () => setTimeout(() => {
      if (!boxes.includes(doc.activeElement) && !dropdown?.contains(doc.activeElement)) close();
    }, 0));
  });
  show();
  return { ...h, boxes, log, model: () => model && model.map(iso), open: () => Boolean(dropdown) && !dropdown.classList.contains("ant-picker-dropdown-hidden"),
    ...parts(doc, title) };
}

test("a range splits into a start and an end field; antd 3 and ant-design-vue 1.x ranges split too, their single dates stay dropdowns", () => {
  const dom = new JSDOM(`<form>
    <div class="row"><label class="row-label">在校时间</label><span class="ant-calendar-picker"><span class="ant-calendar-picker-input ant-input">
      <input readonly placeholder="开始日期" class="ant-calendar-range-picker-input"><span class="ant-calendar-range-picker-separator"> ~ </span>
      <input readonly placeholder="结束日期" class="ant-calendar-range-picker-input"></span></span></div>
    <div class="row"><label class="row-label">出生日期</label><span class="ant-calendar-picker"><div><input readonly placeholder="请选择日期" class="ant-calendar-picker-input ant-input"></div></span></div>
  </form>`);
  const controls = scanner.scanPage(dom.window.document, { isVisible: () => true }).controls;
  assert.deepEqual(controls.map((control) => [control.label, control.controlKind, control.rangePart]), [
    ["在校时间（开始）", "date-picker", "开始"], ["在校时间（结束）", "date-picker", "结束"], ["出生日期", "custom-select", ""]]);
  assert.equal(controls[0].root, controls[1].root);
});

test("a range value splits into its start and end, and an open end is at present", () => {
  assert.deepEqual(helpers.rangeDateParts("2019.09-2023.06"), ["2019.09", "2023.06"]);
  assert.deepEqual(helpers.rangeDateParts("2023年9月 - 至今"), ["2023年9月", "至今"]);
  assert.deepEqual(helpers.rangeDateParts("2023.09至今"), ["2023.09", "至今"]);
  assert.equal(helpers.rangeDateParts("2023.09"), null);
  assert.equal(helpers.rangeDateParts("实习 2023.09-至今"), null);
  assert.equal(helpers.isPresentDate(" 至今 "), true);
  assert.equal(helpers.isPresentDate("2023.09"), false);
});

for (const antd4 of [false, true]) {
  test(`an antd ${antd4 ? 4 : 5} RangePicker gets both ends in one opening and the end field only checks`, async () => {
    const h = antdRange({ antd4 });
    const first = await h.api.operate(h.start, "2019.09", { range: { entry: h.end, value: "2023.06" } });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.deepEqual(h.model(), ["2019-09-01", "2023-06-01"]);
    assert.equal(first.observed.dayDefaulted, true);
    assert.equal(h.open(), false);
    const second = await h.api.operate(h.end, "2023.06", { range: { entry: h.start, value: "2019.09" } });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.observed.dayDefaulted, true);
    assert.equal(h.log.opened, 1, "the end field does not open the picker again");
    assert.deepEqual([h.api.check(h.start).ok, h.api.check(h.end).ok], [true, true]);
  });
}

test("an antd RangePicker keeps the end it already has when only the start comes, and a lone start with an empty end is left alone", async () => {
  const filled = antdRange({ value: [{ y: 2019, m: 9, d: 1 }, { y: 2023, m: 6, d: 30 }] });
  const result = await filled.api.operate(filled.start, "2020-09-01", { range: { entry: filled.end, value: null } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(filled.model(), ["2020-09-01", "2023-06-30"]);
  assert.equal(filled.log.opened, 1, "picking the start commits with the kept end; the end is not opened again");

  const empty = antdRange();
  const lone = await empty.api.operate(empty.start, "2019-09-01", { range: { entry: empty.end, value: null } });
  assert.equal(lone.ok, false);
  assert.equal(lone.reason, "range_incomplete");
  assert.equal(empty.log.opened, 0, "nothing was opened");
  assert.deepEqual(empty.boxes.map((box) => box.value), ["", ""]);
});

test("a start field given a whole span fills both ends; an open end leaves the range alone", async () => {
  const h = antdRange();
  const result = await h.api.operate(h.start, "2019.09.01-2023.06.30");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.model(), ["2019-09-01", "2023-06-30"]);
  assert.equal(result.observed.dayDefaulted, undefined);

  const present = antdRange({ title: "实习时间" });
  const start = await present.api.operate(present.start, "2023.09-至今", { range: { entry: present.end, value: "2023.09-至今" } });
  const end = await present.api.operate(present.end, "2023.09-至今", { range: { entry: present.start, value: "2023.09-至今" } });
  assert.deepEqual([start.reason, end.reason], ["range_incomplete", "no_option_match"]);
  assert.equal(present.log.opened, 0);
});

test("a range whose start comes after its end, or with a date that does not exist, is not touched", async () => {
  const h = antdRange();
  const backwards = await h.api.operate(h.start, "2023.06", { range: { entry: h.end, value: "2019.09" } });
  assert.equal(backwards.reason, "invalid_date");
  const bad = await h.api.operate(h.start, "2019-02-30", { range: { entry: h.end, value: "2023.06" } });
  assert.equal(bad.reason, "invalid_date");
  assert.equal(h.log.opened, 0);
});

test("an antd RangePicker whose end day cannot be chosen closes the picker and drops the start it chose", async () => {
  const h = antdRange({ disabledAfter: { y: 2026, m: 11, d: 2 } });
  const result = await h.api.operate(h.start, "2019-09-01", { range: { entry: h.end, value: "2027-01-15" } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_option_match");
  assert.equal(h.model(), null);
  assert.deepEqual(h.boxes.map((box) => box.value), ["", ""]);
  assert.equal(h.open(), false);
});

test("an editable Element range types both boxes, waits a beat, then presses Enter once", async () => {
  const h = elementRange();
  const result = await h.api.operate(h.start, "2019-09-01", { range: { entry: h.end, value: "2023-06-30" } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.model(), ["2019-09-01", "2023-06-30"]);
  assert.equal(h.open(), false);
  assert.deepEqual(h.log.keys, ["Enter"]);
  const end = await h.api.operate(h.end, "2023-06-30", { range: { entry: h.start, value: "2019-09-01" } });
  assert.equal(end.ok, true, JSON.stringify(end));
  assert.equal(h.log.opened, 1, "the end field does not open the calendar again");
  assert.equal(h.log.writes, 2);
});

test("an editable Element month range types months", async () => {
  const h = elementRange({ month: true, title: "实习时间" });
  const result = await h.api.operate(h.start, "2022.07", { range: { entry: h.end, value: "2022.09" } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.model(), ["2022-07", "2022-09"]);
  assert.equal(result.observed.dayDefaulted, undefined);
});

test("an Element range that does not take the typed format is closed with Esc and picked on its calendar instead", async () => {
  const h = elementRange({ slash: true });
  const result = await h.api.operate(h.start, "2019-09-01", { range: { entry: h.end, value: "2023-06-30" } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.model(), ["2019-09-01", "2023-06-30"]);
  assert.deepEqual(h.log.keys, ["Enter", "Escape"]);
  assert.equal(h.log.opened, 2);
  assert.equal(h.open(), false);
});

test("inside a dialog the calendar of an untaken typed range is closed with a press beside it, not Esc", async () => {
  const h = elementRange({ slash: true, dialog: true });
  const result = await h.api.operate(h.start, "2019-09-01", { range: { entry: h.end, value: "2023-06-30" } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.model(), ["2019-09-01", "2023-06-30"]);
  assert.deepEqual(h.log.keys, ["Enter"], "no Esc that would close the dialog");
});

test("a read-only Element range is picked on its two-panel calendar, day and month alike", async () => {
  const h = elementRange({ editable: false });
  const result = await h.api.operate(h.start, "2019.09", { range: { entry: h.end, value: "2023.06" } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.model(), ["2019-09-01", "2023-06-01"]);
  assert.equal(result.observed.dayDefaulted, true);
  assert.equal(h.log.writes, 0, "nothing is typed into a read-only box");
  assert.equal(h.open(), false);
  const end = await h.api.operate(h.end, "2023.06", { range: { entry: h.start, value: "2019.09" } });
  assert.equal(end.ok, true, JSON.stringify(end));
  assert.equal(h.log.opened, 1);

  const months = elementRange({ editable: false, month: true, title: "实习时间" });
  const picked = await months.api.operate(months.start, "2022-07", { range: { entry: months.end, value: "2024-03" } });
  assert.equal(picked.ok, true, JSON.stringify(picked));
  assert.deepEqual(months.model(), ["2022-07", "2024-03"]);
});

test("a two-panel calendar whose panels stay on the old start and end months still reaches the new days", async () => {
  // antd 3 的区间日历已有值时，左边停在开始月、右边停在结束月，各翻各的。
  const h = elementRange({ editable: false, unlinked: true, value: [{ y: 2019, m: 9, d: 1 }, { y: 2023, m: 6, d: 1 }] });
  const result = await h.api.operate(h.start, "2020.09", { range: { entry: h.end, value: null } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.model(), ["2020-09-01", "2023-06-01"]);
  const later = await h.api.operate(h.start, "2020.09", { range: { entry: h.end, value: "2024.10" } });
  assert.equal(later.ok, true, JSON.stringify(later));
  assert.deepEqual(h.model(), ["2020-09-01", "2024-10-01"]);
});

test("a read-only range that cannot reach a day closes its calendar and keeps the old value", async () => {
  const h = elementRange({ editable: false, value: [{ y: 2019, m: 9, d: 1 }, { y: 2023, m: 6, d: 1 }] });
  const result = await h.api.operate(h.start, "2019-09-01", { range: { entry: h.end, value: "2099-12-31" } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_option_match");
  assert.deepEqual(h.model(), ["2019-09-01", "2023-06-01"]);
  assert.equal(h.open(), false);
});

test("an editable range of an unknown component still fills one box alone when the other end has no value", async () => {
  // 认不出是哪家组件的区间（类名带 date-picker 的自研组件）：可能一个框自己就收下，照原来只填这一个框。两头都有值时一起填。
  const h = load(`<div class="row"><label class="row-label">在校时间</label>
    <div class="my-date-picker"><input placeholder="开始日期"><span>至</span><input placeholder="结束日期"></div></div>`);
  const { start, end } = parts(h.doc, "在校时间");
  assert.equal(start.pickerType, "generic");
  const lone = await h.api.operate(start, "2019-09-01", { range: { entry: end, value: null } });
  assert.equal(lone.ok, true, JSON.stringify(lone));
  assert.deepEqual([start.element.value, end.element.value], ["2019-09-01", ""]);
  const pair = await h.api.operate(start, "2020-09-01", { range: { entry: end, value: "2023-06-30" } });
  assert.equal(pair.ok, true, JSON.stringify(pair));
  assert.deepEqual([start.element.value, end.element.value], ["2020-09-01", "2023-06-30"]);
});
