// #555：插件侧边栏的 3 Tab 极简重构。这里只钉死结构和文案：三个文字 Tab、多步面板与模板编辑器的节点一个不少、
// 用户可见文案里没有「配方」、诊断折叠区默认收起、零 Emoji、零外部资源。行为由各自的 sidepanel-*.test.js 覆盖。
const test = require('node:test');
const assert = require('node:assert/strict');
const { read } = require('./helpers/sidepanel-harness.js');

const html = read('sidepanel.html');
const css = read('sidepanel.css');
const js = read('sidepanel.js');
const ids = (fragment) => new Set([...fragment.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
const section = (open, close) => html.slice(html.indexOf(open), html.indexOf(close, html.indexOf(open)));

test('three text tabs: 填写 | 简历字段 | 存邮件, in that order', () => {
  const nav = section('<nav class="dock-tabs"', '</nav>');
  const tabs = [...nav.matchAll(/<button[^>]*data-tab="(\w+)"[^>]*>([^<]*)<\/button>/g)].map((match) => [match[1], match[2]]);
  assert.deepEqual(tabs, [['fill', '填写'], ['fields', '简历字段'], ['mail', '存邮件']]);
  assert.doesNotMatch(nav, /<svg|<img/, 'tabs are plain text');
});

test('top bar: app icon, 网申快填, a connection dot and 打开桌面 →', () => {
  const header = section('<header class="dock-header">', '</header>');
  assert.match(header, /<img src="icons\/icon48\.png"[^>]*width="20"/);
  assert.match(header, /网申快填/);
  assert.match(header, /id="desktop-pill"/);
  assert.match(header, /<button id="open-manager"[^>]*>打开桌面<\/button>/);
  assert.match(css, /\.dock-open::after \{ content: " \\2192"/);
  assert.ok(!html.includes('dock-footer'), 'the old footer buttons are gone');
});

test('填写 tab: template on top, full-width 一键 AI 填写, then two light text actions', () => {
  const fill = section('id="fill-view"', 'id="fields-view"');
  const at = (marker) => { const index = fill.indexOf(marker); assert.notEqual(index, -1, marker); return index; };
  assert.ok(!fill.includes('page-domain'), '网站域名标签已去掉');
  assert.ok(!fill.includes('template-edit'), '「编辑字段」只留在简历字段页的「管理字段」');
  assert.ok(at('id="fill-button"') < at('id="deep-button"'));
  assert.ok(at('id="deep-button"') < at('id="repeat-button"'));
  assert.match(fill, /id="fill-button" type="button">一键 AI 填写<\/button>/);
  assert.match(fill, /id="deep-button"[^>]*>深度分析本页<\/button>/);
  assert.match(fill, /id="repeat-button" type="button">辅助新增经历<\/button>/);
  assert.match(fill, /id="job-save-button"[^>]*>保存岗位<\/button>/);
  assert.match(fill, /id="submit-confirm-button"[^>]*>我已投递<\/button>/);
  assert.ok(at('id="queue-toggle"') > at('id="submit-confirm-button"'), '待同步 sits under the flow bar');
  assert.match(css, /\.fill-button \{[^}]*background: var\(--accent\)/);
  assert.doesNotMatch(css, /gradient/, 'no gradients anywhere in the side panel');
});

test('投递区两个按钮的悬停说明用 data-tip 自绘，不依赖浏览器原生 title', () => {
  assert.match(html, /id="job-save-button"[^>]*data-tip="[^"]+"/);
  assert.match(html, /id="submit-confirm-button"[^>]*data-tip="[^"]+"/);
  assert.match(css, /\.job-save-button\[data-tip\]:hover::after/);
});

test('#task-panel and #template-editor keep every node and id', () => {
  const taskPanel = ids(section('<section id="task-panel"', '<div id="feedback-preview-root">'));
  const editor = ids(section('<section id="template-editor"', 'id="mail-view"'));
  const mustHave = [
    'task-panel', 'task-icon', 'task-title', 'task-desc', 'task-exit', 'task-notice', 'task-steps', 'task-body',
    'task-flow-repeat', 'repeat-card', 'repeat-message', 'repeat-plan', 'repeat-confirm', 'repeat-cancel', 'repeat-stop', 'repeat-dismiss',
    'task-flow-upload', 'upload-card', 'upload-site', 'upload-rows', 'upload-notes', 'upload-confirm', 'upload-fill', 'upload-cancel',
    'task-flow-deep', 'deep-consent', 'deep-consent-confirm', 'deep-consent-cancel', 'deep-card', 'deep-message', 'deep-plan', 'deep-notes', 'deep-meta',
    'deep-confirm', 'deep-cancel', 'deep-stop', 'deep-retry', 'deep-dismiss',
    'task-flow-job', 'job-save-progress', 'job-save-progress-text', 'job-save-progress-count', 'job-save-fragments', 'job-save-stop',
    'job-save-form', 'job-save-company', 'job-save-title', 'job-save-error', 'job-save-location', 'job-save-url', 'job-save-note',
    'job-save-reassist', 'job-save-open-ai', 'job-save-confirm', 'job-save-cancel',
    'job-save-choice', 'job-save-candidates', 'job-save-new', 'job-save-later',
    'job-save-result', 'job-save-result-text', 'job-save-result-hint', 'job-save-again', 'job-save-copy-id', 'job-save-dismiss',
    'task-flow-submit', 'submit-confirm-progress', 'submit-confirm-progress-text', 'submit-confirm-progress-count', 'submit-confirm-fragments', 'submit-confirm-stop',
    'submit-confirm-form', 'submit-confirm-company', 'submit-confirm-title', 'submit-confirm-error', 'submit-confirm-url', 'submit-confirm-note',
    'submit-confirm-open-ai', 'submit-confirm-query', 'submit-confirm-review-cancel',
    'submit-confirm-choice', 'submit-confirm-candidates', 'submit-confirm-back', 'submit-confirm-cancel',
    'submit-confirm-result', 'submit-confirm-result-text', 'submit-confirm-result-hint', 'submit-confirm-save', 'submit-confirm-result-back',
    'submit-confirm-copy-id', 'submit-confirm-dismiss',
    'task-flow-archive', 'fill-offer', 'fill-offer-title', 'fill-offer-text', 'fill-offer-hint', 'fill-offer-snapshot-state', 'fill-offer-check',
    'fill-offer-snapshot', 'fill-offer-candidates', 'fill-offer-extension-id', 'fill-offer-actions'
  ];
  for (const id of mustHave) assert.ok(taskPanel.has(id), `#task-panel keeps #${id}`);
  for (const id of ['template-editor', 'te-title', 'te-desc', 'te-exit', 'te-notice', 'te-notice-text', 'te-notice-action', 'te-form', 'te-add-toggle',
    'te-category-toggle', 'te-add', 'te-add-category', 'te-add-new-category-row', 'te-add-new-category', 'te-add-key', 'te-add-value', 'te-add-error',
    'te-add-submit', 'te-add-close', 'te-category', 'te-category-name', 'te-category-error', 'te-category-submit', 'te-category-close',
    'te-groups', 'te-problems', 'te-warnings', 'te-fallback', 'te-foot', 'te-result', 'te-result-text', 'te-result-export', 'te-result-done']) {
    assert.ok(editor.has(id), `#template-editor keeps #${id}`);
  }
});

test('every element sidepanel.js looks up by id still exists in the page', () => {
  const present = ids(html);
  const wanted = new Set([...js.matchAll(/getElementById\("([^"]+)"\)/g)].map((match) => match[1]));
  // feedback-preview-panel is mounted into #feedback-preview-root by feedback-ui.js at runtime.
  const missing = [...wanted].filter((id) => !present.has(id) && id !== 'feedback-preview-panel');
  assert.deepEqual(missing, []);
});

test('no user-visible 配方 in the side panel page or script', () => {
  const visible = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, (tag) => (/(?:title|aria-label|placeholder|alt)="[^"]*配方/.test(tag) ? tag : ''));
  assert.doesNotMatch(visible, /配方/, 'text and attribute copy in sidepanel.html');
  // Strings in sidepanel.js that a user can read: everything inside quotes/backticks outside // comments.
  const code = js.split('\n').filter((line) => !/^\s*\/\//.test(line)).map((line) => line.replace(/\s\/\/.*$/, '')).join('\n');
  assert.doesNotMatch(code, /配方/);
  assert.match(html, /<span class="recipe-line__label">已记住本站填法<\/span>/);
  assert.match(html, /id="recipe-reanalyze"[^>]*>重新识别<\/button>/);
  assert.match(html, /id="recipe-delete"[^>]*>忘掉<\/button>/);
});

test('the diagnostics block is folded by default and holds the diagnostics copy and the privacy summary', () => {
  const start = html.indexOf('<details id="support-details"');
  assert.notEqual(start, -1);
  const open = html.slice(start, html.indexOf('>', start) + 1);
  assert.doesNotMatch(open, /\sopen[\s>=]/, 'collapsed until the user opens it');
  const block = html.slice(start, html.indexOf('</details>', start));
  assert.match(block, /<summary><span>填写异常？查看诊断与反馈<\/span>/);
  for (const id of ['fill-diagnostics', 'fill-diagnostics-text', 'copy-diagnostics', 'privacy-open-status', 'usage-compact-root', 'feedback-auto-root']) {
    assert.ok(block.includes(`id="${id}"`), `#${id} lives inside the folded block`);
  }
  assert.match(block, /id="copy-diagnostics"[^>]*>复制诊断摘要<\/button>/);
  assert.doesNotMatch(html, /提交兼容性问题/, 'not part of this change');
});

test('no emoji, no remote assets', () => {
  for (const [name, text] of [['sidepanel.html', html], ['sidepanel.css', css], ['sidepanel.js', js]]) {
    assert.doesNotMatch(text, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u, `${name} has no emoji`);
  }
  assert.doesNotMatch(html, /(?:src|href)="https?:/);
  assert.doesNotMatch(css, /url\(["']?https?:|@import/);
});
