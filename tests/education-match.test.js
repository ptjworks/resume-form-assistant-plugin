// #301 学历下拉「该选哪一项」统一由 educationChoice 判断，搜索时搜层次词（博士）而不是资料原文。
// 纯函数一张表；组件部分的夹具是 antd-select.test.js、virtual-list.test.js 里现成替身的精简拷贝（加了 label 和「搜索按输入筛选」两个参数）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const scanner = require('../extension/field-scan.js');
const helpers = require('../extension/ai-helpers.js');

const NO_PICK = Symbol('undefined');
test('educationChoice picks the one option that stands for the level, and says why not otherwise', () => {
  const table = [
    ['博士研究生（直博）', ['博士', '硕士', '本科'], '博士'],
    ['博士研究生（直博）', ['博士研究生', '硕士研究生'], '博士研究生'],
    ['博士研究生（直博）', ['博士', '博士研究生'], '博士研究生'],
    ['博士研究生（直博）', ['博士研究生（直博）', '博士'], '博士研究生（直博）'],
    ['博士研究生（直博）', ['博士研究生（普博）', '硕士'], undefined],
    ['硕士研究生', ['博士', '硕士', '本科'], '硕士'],
    ['大学本科', ['博士', '硕士', '本科'], '本科'],
    ['本科（全日制、统招）', ['大学本科', '硕士研究生'], '大学本科'],
    ['本科（全日制）', ['本科', '大学本科'], ''],
    ['硕士在读', ['硕士', '本科'], '硕士'],
    ['本科（未毕业）', ['本科'], undefined],
    ['理学学士', ['本科', '硕士'], '本科'],
    ['理学学士', ['博士', '硕士', '本科'], '本科'],
    ['理学硕士', ['硕士', '本科'], ''],
    ['理学硕士', ['理学硕士', '硕士'], '理学硕士'],
    ['博士学位', ['博士', '硕士', '本科'], ''],
    ['理学博士', ['博士', '硕士', '本科'], ''],
    ['理学博士', ['博士'], ''],
    // 带括号附注、完成状态的硕士、博士学位同样不选；学士带学习形式附注仍是本科，带完成状态不推。
    ['理学硕士（全日制）', ['博士', '硕士', '本科'], ''],
    ['理学硕士在读', ['博士', '硕士', '本科'], ''],
    ['全日制理学博士（在读）', ['博士', '硕士', '本科'], ''],
    ['理学硕士（全日制）', ['理学硕士（全日制）', '硕士'], '理学硕士（全日制）'],
    ['理学学士（全日制）', ['博士', '硕士', '本科'], '本科'],
    ['理学学士在读', ['博士', '硕士', '本科'], undefined],
    ['本科（结业）', ['本科'], undefined],
    ['大专（肄业）', ['大专'], undefined],
    ['博士研究生（联合培养）', ['博士'], undefined]
  ];
  for (const label of ['学历', '最高学历']) {
    for (const [value, options, expected] of table) {
      assert.equal(helpers.educationChoice(label, value, options), expected, `${label} ${value} / ${options}`);
    }
  }
  // 选项也可以是 { text, value } 的写法，占位项不算。
  assert.equal(helpers.educationChoice('学历', '博士研究生（直博）', [{ text: '请选择', value: '' }, { text: '博士', value: '3' }]), '博士');
  assert.equal(helpers.educationChoice('学位', '博士研究生', ['博士']), null);
  assert.equal(helpers.educationChoice('学位', '理学学士', ['本科']), null);
  assert.equal(helpers.educationChoice('学位', '理学硕士', ['硕士']), null);
  assert.equal(helpers.isValueValidForField({ label: '学历', inputType: 'select', options: ['博士', '硕士', '本科'] }, '理学硕士'), false);
  // 题目问已取得的学历：在读的不换。
  assert.equal(helpers.educationChoice('最高已取得学历', '硕士在读', ['硕士', '本科']), undefined);
  assert.equal(helpers.educationChoice('学历', '博士研究生', []), null);
  assert.equal(helpers.educationChoice('学历', '博士研究生', null), null);
});

test('choiceValue goes through educationChoice for 学历 only', () => {
  const field = { label: '学历', inputType: 'select', options: ['博士', '硕士', '本科'] };
  assert.equal(helpers.choiceValue(field, '博士研究生（直博）'), '博士');
  assert.equal(helpers.choiceValue({ ...field, label: '学位' }, '博士研究生（直博）'), '博士研究生（直博）');
  assert.equal(helpers.choiceValue({ ...field, options: ['本科', '大学本科'] }, '本科（全日制）'), '');
  assert.equal(helpers.choiceValue(field, '理学硕士（全日制）'), '');
  assert.equal(helpers.choiceValue(field, '理学硕士在读'), '');
});

test('educationSearchTerms gives the words every way of writing a level shares', () => {
  const terms = (label, value) => helpers.educationSearchTerms(label, value);
  assert.deepEqual(terms('学历', '博士研究生（直博）'), ['博士']);
  assert.deepEqual(terms('学历', '硕士研究生'), ['硕士']);
  assert.deepEqual(terms('学历', '大学本科'), ['本科']);
  assert.deepEqual(terms('学历', '大学专科'), ['专科', '大专']);
  assert.deepEqual(terms('学历', '大专'), ['大专', '专科']);
  // 「在读」不影响层次；学历栏只写了学士就是本科；硕士、博士学位不推；未毕业、肄业不去掉。
  assert.deepEqual(terms('学历', '硕士在读'), ['硕士']);
  assert.deepEqual(terms('学历', '理学学士'), ['本科']);
  assert.deepEqual(terms('学历', '理学学士（全日制）'), ['本科']);
  assert.equal(terms('学历', '理学硕士（全日制）'), null);
  assert.equal(terms('学历', '理学学士在读'), null);
  assert.equal(terms('学历', '理学硕士'), null);
  assert.equal(terms('学历', '理学博士'), null);
  assert.equal(terms('学历', '本科（未毕业）'), null);
  assert.equal(terms('学历', '大专（肄业）'), null);
  assert.equal(terms('最高已取得学历', '硕士在读'), null);
  assert.equal(terms('学位', '博士研究生'), null);
});

const visible = el => !el.closest('[hidden]');
function load(control, label = '学历') {
  const dom = new JSDOM(`<form><div class="ant-form-item"><div class="ant-form-item-label"><label title="${label}">${label}</label></div>
    <div class="ant-form-item-control">${control}</div></div></form>`, { runScripts: 'outside-only' });
  const w = dom.window;
  for (const file of ['ai-helpers.js', 'custom-controls.js', 'control-adapters.js']) w.eval(fs.readFileSync(`extension/${file}`, 'utf8'));
  const api = w.ResumeProControls.create({ timeoutMs: 200, settleMs: 35, isVisible: visible });
  const found = scanner.scanPage(w.document, { isVisible: visible }).controls.find(item => item.label === label);
  assert.ok(found, `scanned ${label}`);
  const target = { kind: 'element', element: found.element, elements: found.elements, root: found.root, controlKind: found.controlKind, hints: {}, binding: found };
  return { w, doc: w.document, api, target };
}

// AntD 4/5：mode=full 不能搜索；search 可搜索、列表一开始就是全的、搜索按输入筛选（小米）；remote 输入前没有列表。
// filler 项垫在前面（tail 时垫在后面），列表超过 8 项，带虚拟滚动条，只画前 10 项（列表不全）。
function antd4(choices, { mode = 'full', filler = 0, tail = false, prefix = false } = {}) {
  const fill = Array.from({ length: filler }, (_, i) => `示例${String(i).padStart(3, '0')}`);
  const all = tail ? [...choices, ...fill] : [...fill, ...choices];
  const typing = mode !== 'full';
  const h = load(`<div class="ant-select ant-select-single${typing ? ' ant-select-show-search' : ''}"><div class="ant-select-selector">
    <span class="ant-select-selection-search"><input type="search" autocomplete="off" class="ant-select-selection-search-input" role="combobox"
      aria-haspopup="listbox" aria-owns="rc_select_0_list" aria-autocomplete="list" aria-controls="rc_select_0_list" aria-expanded="false"${typing ? '' : ' readonly'}></span>
    <span class="ant-select-selection-placeholder">请选择</span></div></div>`);
  const { doc } = h;
  const root = doc.querySelector('.ant-select'), input = root.querySelector('input');
  const picked = [], searches = [];
  let dropdown = null, items = mode === 'remote' ? [] : all;
  const choose = text => {
    picked.push(text);
    root.querySelector('.ant-select-selection-placeholder')?.remove();
    const item = doc.createElement('span'); item.className = 'ant-select-selection-item'; item.title = text; item.textContent = text;
    root.querySelector('.ant-select-selector').append(item);
    input.value = ''; dropdown.hidden = true; input.setAttribute('aria-expanded', 'false');
  };
  const render = () => {
    if (!items.length) { if (dropdown) dropdown.hidden = true; return; }
    if (!dropdown) { dropdown = doc.createElement('div'); dropdown.className = 'ant-select-dropdown'; doc.body.append(dropdown); }
    dropdown.hidden = false; input.setAttribute('aria-expanded', 'true');
    const virtual = items.length > 8;
    dropdown.innerHTML = `<div><div role="listbox" id="rc_select_0_list" style="height: 0px; width: 0px; overflow: hidden;">${items.slice(0, 2)
      .map((text, index) => `<div aria-label="${text}" role="option" id="rc_select_0_list_${index}">${text}</div>`).join('')}</div>
      <div class="rc-virtual-list"><div class="rc-virtual-list-holder"><div><div class="rc-virtual-list-holder-inner"></div></div></div>
      ${virtual ? '<div class="rc-virtual-list-scrollbar rc-virtual-list-scrollbar-vertical"><div class="rc-virtual-list-scrollbar-thumb"></div></div>' : ''}</div></div>`;
    const inner = dropdown.querySelector('.rc-virtual-list-holder-inner');
    for (const text of items.slice(0, 10)) {
      const item = doc.createElement('div'); item.className = 'ant-select-item ant-select-item-option'; item.title = text;
      item.innerHTML = `<div class="ant-select-item-option-content">${text}</div>`;
      item.addEventListener('click', () => choose(text));
      inner.append(item);
    }
  };
  root.querySelector('.ant-select-selector').addEventListener('click', () => { input.setAttribute('aria-expanded', 'true'); render(); });
  input.addEventListener('input', () => {
    searches.push(input.value);
    const query = input.value;
    setTimeout(() => { items = mode === 'remote' && !query ? [] : all.filter(text => prefix ? text.startsWith(query) : text.includes(query)); render(); }, 20);
  });
  return { ...h, picked, searches };
}

// AntD 3：点根展开，弹层挂在 body；full 一开始就是全的，remote 输入前没有弹层，输入后按搜索词给选项；multiple 选完成标签。
function antd3(choices, { multiple = false, remote = false, initial = [] } = {}) {
  const mode = multiple ? 'multiple' : 'single';
  const field = '<div class="ant-select-search__field__wrap"><input autocomplete="off" class="ant-select-search__field" value=""></div>';
  const search = multiple ? `<ul><li class="ant-select-search ant-select-search--inline">${field}</li></ul>`
    : remote ? `<div class="ant-select-search ant-select-search--inline" hidden>${field}</div>` : '';
  const h = load(`<div class="ant-select ant-select-enabled"><div class="ant-select-selection ant-select-selection--${mode}" role="combobox"
    aria-autocomplete="list" aria-haspopup="true" aria-controls="menu-1" aria-expanded="false" tabindex="0"><div class="ant-select-selection__rendered">
    <div class="ant-select-selection__placeholder">请选择</div>${search}</div></div></div>`);
  const { doc } = h;
  const root = doc.querySelector('.ant-select'), combo = root.querySelector('[role="combobox"]'), input = root.querySelector('input');
  const picked = [], searches = [];
  let dropdown = null, open = false, items = remote ? initial : choices;
  const choose = text => {
    picked.push(text);
    root.querySelector('.ant-select-selection__placeholder').hidden = true;
    if (multiple) {
      const tag = doc.createElement('li'); tag.className = 'ant-select-selection__choice'; tag.title = text;
      tag.innerHTML = `<div class="ant-select-selection__choice__content">${text}</div><span class="ant-select-selection__choice__remove"><i></i></span>`;
      root.querySelector('.ant-select-search').before(tag);
      return;
    }
    const value = doc.createElement('div'); value.className = 'ant-select-selection-selected-value'; value.title = text; value.textContent = text;
    root.querySelector('.ant-select-selection__rendered').append(value);
    open = false; dropdown.hidden = true; combo.setAttribute('aria-expanded', 'false');
  };
  const render = () => {
    if (remote && !items.length) { if (dropdown) dropdown.hidden = true; return; }
    if (!dropdown) {
      dropdown = doc.createElement('div');
      dropdown.innerHTML = '<div id="menu-1"><ul role="listbox" class="ant-select-dropdown-menu"></ul></div>';
      doc.body.append(dropdown);
    }
    dropdown.hidden = false; dropdown.className = `ant-select-dropdown ant-select-dropdown--${mode}`;
    const list = dropdown.querySelector('ul'); list.innerHTML = '';
    for (const text of items) {
      const li = doc.createElement('li');
      li.setAttribute('role', 'option'); li.className = 'ant-select-dropdown-menu-item'; li.textContent = text;
      li.addEventListener('click', () => choose(text));
      list.append(li);
    }
  };
  root.addEventListener('click', () => {
    if (open) return;
    open = true; combo.setAttribute('aria-expanded', 'true');
    if (remote) input.closest('.ant-select-search').hidden = false;
    render();
  });
  input?.addEventListener('input', () => {
    if (!remote) return;
    const query = input.value; searches.push(query);
    setTimeout(() => { items = query ? choices.filter(text => text.includes(query)) : []; if (open) render(); }, 20);
  });
  return { ...h, picked, searches };
}

// Element UI 2：选项全画出来的短列表，按排版量出来是完整的（同 virtual-list.test.js 的 elementUi）。
function elementUi(choices) {
  const h = load(`<div class="el-select"><div class="el-input el-input--suffix"><input type="text" readonly autocomplete="off" placeholder="请选择" class="el-input__inner"></div></div>`);
  const { w, doc } = h;
  const root = doc.querySelector('.el-select'), input = root.querySelector('input');
  const picked = [];
  let dropdown = null;
  root.querySelector('.el-input').addEventListener('click', () => {
    if (!dropdown) {
      dropdown = doc.createElement('div'); dropdown.className = 'el-select-dropdown el-popper';
      dropdown.innerHTML = `<div class="el-scrollbar" style="overflow-y: hidden;"><div class="el-select-dropdown__wrap el-scrollbar__wrap" style="overflow-y: scroll;"><ul class="el-select-dropdown__list">${choices
        .map(text => `<li class="el-select-dropdown__item"><span>${text}</span></li>`).join('')}</ul></div></div>`;
      dropdown.querySelectorAll('li').forEach(li => li.addEventListener('click', () => { picked.push(li.textContent); input.value = li.textContent; dropdown.hidden = true; }));
      doc.body.append(dropdown);
    }
    dropdown.hidden = false;
  });
  const content = choices.length * 34 + 12;
  const box = el => {
    const item = el.closest?.('.el-select-dropdown__item');
    if (item) return { top: 106 + Array.from(item.parentElement.children).indexOf(item) * 34, height: 34 };
    if (el.matches?.('.el-select-dropdown__wrap')) return { top: 100, height: content, scrollHeight: content, clientHeight: content };
    if (el.matches?.('.el-scrollbar')) return { top: 100, height: content, scrollHeight: content, clientHeight: content };
    return null;
  };
  Object.defineProperty(w.HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return box(this)?.height ?? 0; } });
  Object.defineProperty(w.HTMLElement.prototype, 'offsetTop', { configurable: true, get() { return box(this)?.top ?? 0; } });
  Object.defineProperty(w.Element.prototype, 'scrollHeight', { configurable: true, get() { return box(this)?.scrollHeight ?? box(this)?.height ?? 0; } });
  Object.defineProperty(w.Element.prototype, 'clientHeight', { configurable: true, get() { return box(this)?.clientHeight ?? box(this)?.height ?? 0; } });
  return { ...h, picked, searches: [] };
}

const LEVELS = ['博士', '硕士', '本科'];
const LONG = ['博士研究生', '硕士研究生', '大学本科'];
// 资料写法 × 列表状态。picked 是选中的一项，searches 是打过的搜索词（null 是不检查），reason 是报错原因。
const CASES = [
  // 小米：可搜索、列表是全的、选项只写层次 —— 直接选「博士」，不搜索。
  { name: 'xiaomi: searchable full list, qualified value', build: () => antd4(LEVELS, { mode: 'search' }), value: '博士研究生（直博）', picked: '博士', searches: [] },
  { name: 'full list, qualified value', build: () => antd4(LEVELS), value: '博士研究生（直博）', picked: '博士', searches: [] },
  { name: 'full list, synonym value', build: () => antd4(LEVELS, { mode: 'search' }), value: '大学本科', picked: '本科', searches: [] },
  { name: 'full list, long options, qualified value', build: () => antd4(LONG, { mode: 'search' }), value: '硕士研究生（非全日制）', picked: '硕士研究生', searches: [] },
  { name: 'full list, 在读 does not change the level', build: () => antd4(LEVELS, { mode: 'search' }), value: '硕士在读', picked: '硕士', searches: [] },
  // 小米（四川大学）：学历栏写的是学位「理学学士」，选项是博士/硕士/本科 —— 选「本科」，不搜索。
  { name: 'xiaomi: bachelor degree in the level field is 本科', build: () => antd4(LEVELS, { mode: 'search' }), value: '理学学士', picked: '本科', searches: [] },
  // 硕士、博士学位不推成层次，也不被「唯一包含」认成「硕士」：不选。
  { name: 'full list, master degree is not a level', build: () => antd4(LEVELS, { mode: 'search' }), value: '理学硕士', reason: 'ambiguous_option', searches: null },
  { name: 'full list, unfinished status is never converted', build: () => antd4(['本科', '硕士'], { mode: 'search' }), value: '本科（未毕业）', reason: 'no_option_match', searches: null },
  { name: 'full list, other qualifier option is not taken', build: () => antd4(['博士研究生（普博）', '硕士', '本科'], { mode: 'search' }), value: '博士研究生（直博）', reason: 'no_option_match', searches: null },
  { name: 'remote search: searches the level word and picks from the results', build: () => antd4(['博士', '博士研究生', '硕士'], { mode: 'remote' }), value: '博士研究生（直博）', picked: '博士研究生', searches: ['博士研究生（直博）', '博士'] },
  { name: 'remote search: only the plain level among the results', build: () => antd4(['博士', '硕士'], { mode: 'remote' }), value: '博士研究生（直博）', picked: '博士', searches: ['博士研究生（直博）', '博士'] },
  { name: 'remote search: same name among the results wins', build: () => antd4(['博士研究生（直博）', '博士'], { mode: 'remote' }), value: '博士研究生（直博）', picked: '博士研究生（直博）', searches: ['博士研究生（直博）'] },
  // 前缀筛选（#481）：搜层次词搜不到带附注的整项，所以先搜原文，原文搜出来的只认同名。
  { name: 'remote prefix-filtered search: qualified original is searched first and picked by name', build: () => antd4(['硕士研究生', '全日制硕士研究生'], { mode: 'remote', prefix: true }), value: '全日制硕士研究生', picked: '全日制硕士研究生', searches: ['全日制硕士研究生'] },
  // 资料写法和层次词不一样（大学本科、硕士在读、理学学士）时也先搜原文（只认同名，搜不到再搜层次词）：只认开头几个字的站点（#481 前缀筛选）
  // 才搜得到「大学专科」。原来这三条只搜层次词，预期按新规则改成原文在前。
  { name: 'remote search: synonym value searches the original first', build: () => antd4(['本科', '硕士'], { mode: 'remote' }), value: '大学本科', picked: '本科', searches: ['大学本科', '本科'] },
  { name: 'remote search: 在读 searches the original, then the level word', build: () => antd4(['硕士', '本科'], { mode: 'remote' }), value: '硕士在读', picked: '硕士', searches: ['硕士在读', '硕士'] },
  { name: 'remote search: bachelor degree searches the original, then 本科', build: () => antd4(['本科', '硕士'], { mode: 'remote' }), value: '理学学士', picked: '本科', searches: ['理学学士', '本科'] },
  { name: 'remote prefix-filtered search: 大学专科 is searched as written', build: () => antd4(['大学专科', '硕士'], { mode: 'remote', prefix: true }), value: '大学专科', picked: '大学专科', searches: ['大学专科'] },
  { name: 'remote search: the level word itself is searched once', build: () => antd4(['博士', '硕士'], { mode: 'remote' }), value: '博士', picked: '博士', searches: ['博士'] },
  { name: 'remote search: 本科 is searched once', build: () => antd4(['本科', '硕士'], { mode: 'remote' }), value: '本科', picked: '本科', searches: ['本科'] },
  // 未毕业不转成层次：搜的是资料原文，搜不到就不选（和改动前一致）。
  { name: 'remote search: unfinished status is never converted', build: () => antd4(['本科', '本科生'], { mode: 'remote' }), value: '本科（未毕业）', reason: 'options_not_rendered', searches: ['本科（未毕业）'] },
  { name: 'virtual partial list: searches the level word', build: () => antd4(LEVELS, { mode: 'search', filler: 100 }), value: '博士研究生（直博）', picked: '博士', searches: ['博士研究生（直博）', '博士'] },
  { name: 'virtual partial list: same name on the screen is picked without searching', build: () => antd4(LEVELS, { mode: 'search', filler: 100, tail: true }), value: '本科', picked: '本科', searches: [] },
  { name: 'antd3 full list, qualified value', build: () => antd3(LEVELS), value: '硕士研究生（全日制）', picked: '硕士', searches: [] },
  { name: 'antd3 full list, unfinished status is never converted', build: () => antd3(LEVELS), value: '本科（未毕业）', reason: 'no_option_match', searches: [] },
  { name: 'antd3 remote search, qualified value', build: () => antd3(['博士', '博士研究生'], { remote: true }), value: '博士研究生（直博）', picked: '博士研究生', searches: ['博士研究生（直博）', '博士'] },
  { name: 'element full list, qualified value', build: () => elementUi(LEVELS), value: '博士研究生（直博）', picked: '博士', searches: [] },
  { name: 'element full list, synonym value', build: () => elementUi(LEVELS), value: '大学本科', picked: '本科', searches: [] },
  { name: 'element full list, bachelor degree is 本科', build: () => elementUi(LEVELS), value: '理学学士', picked: '本科', searches: [] }
];
for (const item of CASES) {
  test(`education select: ${item.name}`, async t => {
    const h = item.build();
    t.after(() => h.w.close());
    const result = await h.api.operate(h.target, item.value);
    if (item.reason) {
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.equal(result.reason, item.reason);
      assert.deepEqual(h.picked, []);
    } else {
      assert.equal(result.ok, true, result.reason);
      assert.deepEqual(h.picked, [item.picked]);
    }
    if (item.searches) assert.deepEqual(h.searches.filter(Boolean), item.searches);
  });
}

test('education multi-select: a full list is picked from by level, a partial list searches the original, then the level word', async t => {
  const full = antd3(LEVELS, { multiple: true });
  const remote = antd3(['博士', '博士研究生'], { multiple: true, remote: true, initial: ['本科'] });
  t.after(() => { full.w.close(); remote.w.close(); });
  const a = await full.api.operate(full.target, '博士研究生（直博）');
  assert.equal(a.ok, true, a.reason);
  assert.deepEqual(full.picked, ['博士']);
  const b = await remote.api.operate(remote.target, '博士研究生（直博）');
  assert.equal(b.ok, true, b.reason);
  assert.deepEqual(remote.searches.filter(Boolean), ['博士研究生（直博）', '博士']);
  assert.deepEqual(remote.picked, ['博士研究生']);
});

test('education multi-select: a master degree in the level field is not picked from a level list', async t => {
  const full = antd3(LEVELS, { multiple: true });
  const remote = antd3(['博士', '硕士'], { multiple: true, remote: true, initial: ['本科'] });
  t.after(() => { full.w.close(); remote.w.close(); });
  for (const h of [full, remote]) {
    const result = await h.api.operate(h.target, '理学硕士');
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.deepEqual(h.picked, []);
  }
});

test('education select: after searching the original, a near item in the results is not taken for it', async t => {
  // 资料「理学学士」搜原文只搜出一项包含它的「理学学士学位」：这一轮只认同名，不能当成它选上（改前会被「唯一包含」的兜底选上）。
  // 原文这一轮不选，再搜「本科」，列表里没有，最后不选。
  const h = antd4(['理学学士学位', '硕士'], { mode: 'remote' });
  t.after(() => h.w.close());
  const result = await h.api.operate(h.target, '理学学士');
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.deepEqual(h.picked, []);
  assert.deepEqual(h.searches.filter(Boolean), ['理学学士', '本科']);
});
