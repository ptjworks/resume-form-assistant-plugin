const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const scanner = require('../extension/field-scan.js');

function picker(t, { transfer = false, label = '毕业时间', editable = false } = {}) {
  const dom = new JSDOM(`<form><table><tbody><tr><td><label for="graduation">${label}</label><div class="ivu-date-picker">
    <div class="ivu-date-picker-rel"><div class="ivu-date-picker-editor ivu-input-wrapper">
      <input id="graduation" class="ivu-input" type="text" readonly>
    </div></div></div></td></tr></tbody></table></form>`, { runScripts: 'outside-only', url: 'https://i.zhaopin.com/resume' });
  t.after(() => dom.window.close());
  const { window } = dom;
  const { document } = window;
  for (const file of ['ai-helpers.js', 'custom-controls.js', 'control-adapters.js']) {
    window.eval(fs.readFileSync(`extension/${file}`, 'utf8'));
  }
  const visible = el => !el.closest('[hidden]');
  const api = window.ResumeProControls.create({ timeoutMs: 200, settleMs: 20, isVisible: visible });
  const root = document.querySelector('.ivu-date-picker');
  const input = root.querySelector('input');
  input.readOnly = !editable;
  const popup = document.createElement('div');
  popup.className = transfer ? 'ivu-select-dropdown ivu-date-picker-transfer' : 'ivu-select-dropdown';
  popup.dataset.transfer = String(transfer);
  popup.style.position = 'absolute';
  popup.hidden = true;
  (transfer ? document.body : root).append(popup);
  const rect = (top, height) => ({ left: 20, right: 230, top, bottom: top + height, width: 210, height });
  root.getBoundingClientRect = input.getBoundingClientRect = () => rect(40, 32);
  popup.getBoundingClientRect = () => rect(76, 250);
  input.onclick = () => { popup.hidden = false; };
  if (editable) input.onfocus = input.onclick;
  input.onkeydown = event => { if (event.key === 'Escape') popup.hidden = true; };
  const binding = scanner.scanPage(document, { isVisible: visible }).controls.find(control => control.element === input);
  assert.equal(binding.controlKind, 'date-picker');
  const target = { ...binding, binding, controlKind: 'date' };
  return { api, target, input, popup, helpers: window.ResumeProAIHelpers };
}

function harness(t, { transfer = false, disabledDay, range = false } = {}) {
  const { api, target, input, popup } = picker(t, { transfer });

  // iView uses spans wrapping <em> for all three views. The single header
  // switches year/month views, and the double arrows page through year lists.
  let view = 'day', year = 2026, month = 5;
  const clicks = [];
  const cell = (label, action, extra = '') => `<span class="ivu-date-picker-cells-cell${extra}"
    data-action="${action}"><em>${label}</em></span>`;
  const arrow = direction => `<span class="ivu-picker-panel-icon-btn ivu-date-picker-${direction}-btn
    ivu-date-picker-${direction}-btn-arrow-double" data-action="${direction}-year"><i></i></span>`;
  function drawPanel() {
    const decade = Math.floor(year / 10) * 10;
    const monthDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const cells = view === 'year' ? Array.from({ length: 10 }, (_, i) => cell(decade + i, `year-${decade + i}`)).join('')
      : view === 'month' ? Array.from({ length: 12 }, (_, i) => cell(`${i + 1}月`, `month-${i + 1}`)).join('')
      : cell(monthDays, 'previous-month', ' ivu-date-picker-cells-cell-prev-month')
        + cell(23, 'week-number', ' ivu-date-picker-cells-cell-week-label')
        + Array.from({ length: monthDays }, (_, i) => cell(i + 1, `day-${i + 1}`,
          i + 1 === disabledDay ? ' ivu-date-picker-cells-cell-disabled' : '')).join('')
        + cell(1, 'next-month', ' ivu-date-picker-cells-cell-next-month');
    popup.innerHTML = `<div><div class="ivu-picker-panel-body-wrapper${range ? ' ivu-date-picker-with-range' : ''}">
      <div class="ivu-picker-panel-body"><div class="ivu-date-picker-header">
      ${arrow('prev')}<span><span class="ivu-date-picker-header-label" data-action="show-year">${year}年</span>
      ${view === 'day' ? `<span class="ivu-date-picker-header-label" data-action="show-month">${month}月</span>` : ''}</span>
      ${arrow('next')}</div><div class="ivu-picker-panel-content"><div class="ivu-date-picker-cells">${cells}</div></div>
      </div></div></div>`;
  }
  popup.onclick = event => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    clicks.push(action);
    if (action === 'show-year') view = 'year';
    else if (action === 'show-month') view = 'month';
    else if (action === 'prev-year') year -= view === 'year' ? 10 : 1;
    else if (action === 'next-year') year += view === 'year' ? 10 : 1;
    else {
      const [kind, value] = action.split('-');
      if (kind === 'year') { year = Number(value); view = 'month'; }
      if (kind === 'month') { month = Number(value); view = 'day'; }
      if (kind === 'day' && Number(value) !== disabledDay) {
        input.value = `${year}-${String(month).padStart(2, '0')}-${value.padStart(2, '0')}`;
        popup.hidden = true;
      }
    }
    drawPanel();
  };
  drawPanel();
  return { api, target, input, popup, clicks };
}

test('#544 selects a date from an inline iView picker through year, month and day', async t => {
  const { api, target, input, popup, clicks } = harness(t);
  const outcome = await api.operate(target, '2014-06-23');
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.observed.library, 'iview');
  assert.equal(outcome.observed.calendarMode, 'date');
  assert.deepEqual(clicks, ['show-year', 'prev-year', 'year-2014', 'month-6', 'day-23']);
  assert.equal(input.value, '2014-06-23');
  assert.equal(popup.hidden, true);
  assert.equal(api.check(target).ok, true);
});

test('#544 associates only the newly opened transferred iView calendar', async t => {
  const { api, target, input, popup, clicks } = harness(t, { transfer: true });
  const stale = popup.cloneNode(true);
  stale.hidden = false;
  stale.getBoundingClientRect = popup.getBoundingClientRect;
  popup.before(stale);
  let staleClicks = 0;
  stale.onclick = () => staleClicks++;
  const outcome = await api.operate(target, '2026-05-31');
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(input.value, '2026-05-31');
  assert.equal(stale.hidden, false);
  assert.equal(staleClicks, 0);
  assert.deepEqual(clicks, ['day-31']);
});

test('#544 skips disabled dates and an iView range that requires two dates', async t => {
  for (const [options, reason] of [[{ disabledDay: 23 }, 'no_option_match'], [{ range: true }, 'unsupported_control']]) {
    const { api, target, input, popup, clicks } = harness(t, options);
    assert.equal((await api.operate(target, '2026-05-23')).reason, reason);
    assert.equal(input.value, '');
    assert.equal(popup.hidden, true);
    assert.deepEqual(clicks, []);
  }
});

function rangePicker(t, { disabledDate = '', confirm = false, monthPanels = false, transfer = false, editable = false, submittedRange } = {}) {
  const fixture = picker(t, { label: '起止时间', transfer, editable });
  const { input, popup } = fixture;
  let firstMonth = 2026 * 12 + 4;
  const picked = [];
  const render = () => {
    const panel = (side, offset, dir) => {
      const year = Math.floor(offset / 12), month = offset % 12 + 1;
      const prefix = `${year}-${String(month).padStart(2, '0')}`;
      const arrow = (level, advance) => `<span class="ivu-date-picker-${dir}-btn-arrow${level}" data-advance="${advance}"><i></i></span>`;
      const cells = Array.from({ length: monthPanels ? 12 : new Date(year, month, 0).getDate() }, (_, i) => {
        const date = `${prefix}-${String(i + 1).padStart(2, '0')}`;
        return `<span class="ivu-date-picker-cells-cell${date === disabledDate ? ' ivu-date-picker-cells-cell-disabled' : ''}" data-date="${date}"><em>${i + 1}${monthPanels ? '月' : ''}</em></span>`;
      }).join('');
      return `<div class="ivu-picker-panel-content ivu-picker-panel-content-${side}">
        <div class="ivu-date-picker-header">${arrow('-double', dir === 'prev' ? -12 : 12)}${arrow('', dir === 'prev' ? -1 : 1)}
          <span>${year}年</span><span>${month}月</span></div>
        <div class="ivu-date-picker-cells">${cells}</div></div>`;
    };
    popup.innerHTML = `<div><div class="ivu-picker-panel-body-wrapper ivu-date-picker-with-range">
      <div class="ivu-picker-panel-body ivu-picker-panel-body-date">
        ${panel('left', firstMonth, 'prev')}${panel('right', firstMonth + 1, 'next')}
        ${confirm ? '<div class="ivu-picker-confirm"><button>确定</button></div>' : ''}
      </div></div></div>`;
  };
  render();
  popup.onclick = event => {
    const button = event.target.closest('[data-advance]');
    const day = event.target.closest('[data-date]')?.dataset.date;
    if (button) { firstMonth += Number(button.dataset.advance); render(); }
    if (!day || day === disabledDate) return;
    picked.push(day);
    if (picked.length === 2) {
      input.value = submittedRange ?? picked.join(' - ');
      popup.hidden = true;
    }
  };
  return { ...fixture, picked };
}

test('#544 dates paired in one iView input are passed through matching, committed and both checked', async t => {
  const { api, target, input, popup, helpers, picked } = rangePicker(t, { transfer: true });
  const field = { inputType: 'date-picker', pickerType: target.pickerType, label: target.label };
  const matched = helpers.pickerDate(field, '2024.06-2026.07.12');
  assert.equal(matched, '2024-06 - 2026-07-12');
  assert.equal(helpers.pickerDate({ ...field, label: '毕业时间' }, '2024.06-2026.07.12'), '2026-07-12');
  assert.equal(helpers.pickerDate({ ...field, label: '教育起止时间（开始）' }, '2024.06-2026.07.12'), '2024-06');
  assert.equal(helpers.pickerDate({ ...field, pickerType: 'generic' }, '2024.06-2026.07.12'), '');
  const outcome = await api.operate(target, matched);
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.observed.dayDefaulted, true);
  assert.equal(input.value, '2024-06-01 - 2026-07-12');
  assert.deepEqual(picked, ['2024-06-01', '2026-07-12']);
  assert.equal(popup.hidden, true);
  input.value = '2024-06-01 - 2026-08-12';
  assert.equal(api.check(target).reason, 'value_reverted');
});

test('#544 iView date ranges reject disabled endpoints, confirmations, and month-only panels', async t => {
  for (const [options, reason, picked] of [
    [{ disabledDate: '2026-07-12' }, 'no_option_match', ['2026-06-01']],
    [{ confirm: true }, 'unsupported_control', []],
    [{ monthPanels: true }, 'unsupported_control', []],
  ]) {
    const fixture = rangePicker(t, options);
    assert.equal((await fixture.api.operate(fixture.target, '2026-06-01 - 2026-07-12')).reason, reason);
    assert.equal(fixture.input.value, '');
    assert.equal(fixture.popup.hidden, true);
    assert.deepEqual(fixture.picked, picked);
  }
});

test('#544 handles equal day numbers in two owned panels without taking another open range', async t => {
  const { api, target, input, popup, picked } = rangePicker(t, { transfer: true, editable: true });
  const stale = popup.cloneNode(true);
  stale.hidden = false;
  stale.getBoundingClientRect = popup.getBoundingClientRect;
  popup.before(stale);
  let staleClicks = 0;
  stale.onclick = () => staleClicks++;
  const outcome = await api.operate(target, '2026-05-12 - 2026-06-12');
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(input.value, '2026-05-12 - 2026-06-12');
  assert.deepEqual(picked, ['2026-05-12', '2026-06-12']);
  assert.equal(staleClicks, 0);
  assert.equal(stale.hidden, false);
});

test('#544 iView date ranges require ordered real dates and verify both displayed endpoints', async t => {
  const { api, target, input, picked } = rangePicker(t, { submittedRange: '2026-05-12 - 2026-06-13' });
  for (const desired of ['2026-06-12 - 2026-05-12', '2026-05-12 - 2026-06-31', '2026-05-12 - 至今']) {
    assert.equal((await api.operate(target, desired)).reason, 'invalid_date');
  }
  assert.deepEqual(picked, []);
  assert.equal(input.value, '');
  assert.equal((await api.operate(target, '2026-05-12 - 2026-06-12')).reason, 'selection_not_committed');
  assert.equal(api.check(target), null);
});

test('#544 leaves an already open inline iView range alone', async t => {
  const { api, target, input, popup, picked } = rangePicker(t);
  popup.hidden = false;
  const outcome = await api.operate(target, '2026-05-12 - 2026-06-12');
  assert.equal(outcome.reason, 'ambiguous_popup', JSON.stringify(outcome));
  assert.deepEqual(picked, []);
  assert.equal(input.value, '');
  assert.equal(popup.hidden, false);
});
