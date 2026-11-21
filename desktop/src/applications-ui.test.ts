import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { findMatchRanges, highlightHtml } from './search-highlight.ts';

const MARK = (text: string) => `<mark class="search-match">${text}</mark>`;
const hl = highlightHtml;

test('highlight: company, title and location mark the characters that matched', () => {
  assert.equal(hl('company', '金发科技', '发'), `金${MARK('发')}科技`);
  assert.equal(hl('title', '研发工程师', '发'), `研${MARK('发')}工程师`);
  assert.equal(hl('title', '研发工程师', '工程'), `研发${MARK('工程')}师`);
  assert.equal(hl('location', '上海市浦东新区', '浦东'), `上海市${MARK('浦东')}新区`);
  assert.equal(hl('location', 'Shanghai', 'HAI'), `Shang${MARK('hai')}`);
});

test('highlight: the same keyword marks company and title, and every occurrence in a field', () => {
  const row = { company: '金发科技', title: '研发工程师' };
  assert.match(hl('company', row.company, '发'), /<mark/);
  assert.match(hl('title', row.title, '发'), /<mark/);
  assert.equal(hl('company', '中化集团', '发'), '中化集团');
  assert.equal(hl('title', '发发科技发', '发'), `${MARK('发')}${MARK('发')}科技${MARK('发')}`);
  assert.equal(hl('title', 'abcABCabc', 'abc'), `${MARK('abc')}${MARK('ABC')}${MARK('abc')}`);
});

test('highlight: Latin case is ignored but the displayed text is untouched', () => {
  assert.equal(hl('title', 'Software ENGINEER', 'engin'), `Software ${MARK('ENGIN')}EER`);
  assert.equal(hl('company', 'OpenAI', 'AI'), `Open${MARK('AI')}`);
  assert.equal(hl('location', 'BeiJing', 'JING'), `Bei${MARK('Jing')}`);
});

test('highlight: no keyword, no mark', () => {
  for (const query of [null, undefined, '', '   ', '\u3000']) {
    for (const field of ['company', 'title', 'location'] as const) {
      assert.doesNotMatch(hl(field, '金发科技 <b>', query), /<mark/);
      assert.deepEqual(findMatchRanges(field, '金发科技', query), []);
    }
  }
  assert.equal(hl('title', '', '发'), '');
  assert.equal(hl('location', null, '发'), '');
});

test('highlight: company follows normalize_company, so the stripped suffix never lights up', () => {
  // 库里存的是去掉后缀后的值：“公司”“Inc.” 在后端根本搜不到，界面也不该高亮。
  assert.equal(hl('company', '星河科技有限公司', '科技'), `星河${MARK('科技')}有限公司`);
  assert.equal(hl('company', '星河科技有限公司', '公司'), '星河科技有限公司');
  assert.equal(hl('company', '星河科技有限公司', '星河科技有限公司'), `${MARK('星河科技')}有限公司`);
  assert.equal(hl('company', 'Acme Inc.', 'inc'), 'Acme Inc.');
  assert.equal(hl('company', 'Acme Inc.', 'ACME'), `${MARK('Acme')} Inc.`);
  // 后缀判断按 UTF-8 字节数：“星有限公司”会去后缀，单独的“有限公司”不会。
  assert.equal(hl('company', '星有限公司', '星有限公司'), `${MARK('星')}有限公司`);
  assert.equal(hl('company', '星有限公司', '有限公司'), '星有限公司');
  // 尾部的 ASCII 标点也被后端去掉。
  assert.equal(hl('company', '金发科技', '科技.'), `金发${MARK('科技')}`);
  // 岗位不去后缀。
  assert.equal(hl('title', '有限公司专员', '公司'), `有限${MARK('公司')}专员`);
});

test('highlight: full-width, half-width and collapsed whitespace follow each field\'s backend rule', () => {
  assert.equal(hl('company', 'ＡＢＣ 公司', 'abc'), `${MARK('ＡＢＣ')} 公司`);
  assert.equal(hl('company', 'abc公司', 'ＡＢＣ'), `${MARK('abc')}公司`);
  assert.equal(hl('title', 'Ｒｕｓｔ　工程师', 'rust 工'), `${MARK('Ｒｕｓｔ　工')}程师`);
  assert.equal(hl('title', 'Senior   Rust', 'senior rust'), MARK('Senior   Rust'));
  assert.equal(hl('title', 'Senior Rust', 'senior    rust'), MARK('Senior Rust'));
  assert.equal(hl('title', '  前端  ', '前端'), `  ${MARK('前端')}  `);
  // 地点只有 ASCII 小写：不折叠全角，也不压缩空白。
  assert.equal(hl('location', 'ＡＢＣ', 'abc'), 'ＡＢＣ');
  assert.equal(hl('location', 'ABC路', 'abc'), `${MARK('ABC')}路`);
  assert.equal(hl('location', 'a  b', 'a b'), 'a  b');
  assert.equal(hl('location', 'a b', 'a b'), MARK('a b'));
  // SQLite lower() 只处理 ASCII，“É” 不会变成 “é”，所以后端搜不到，这里也不高亮。
  assert.equal(hl('location', 'É', 'é'), 'É');
  assert.equal(hl('title', 'É', 'é'), MARK('É'));
});

test('highlight: LIKE wildcards behave like the backend, and non-matching fields stay plain', () => {
  assert.equal(hl('title', 'React Native', 'r_act'), `${MARK('React')} Native`);
  assert.equal(hl('title', 'React Native', 're%ive'), `${MARK('Re')}act Nat${MARK('ive')}`);
  assert.equal(hl('title', 'React Native', 'ive%re'), 'React Native');
  assert.equal(hl('title', 'React Native', '%'), 'React Native');
  assert.equal(hl('company', 'React', '.'), 'React');
});

test('highlight: never splits surrogate pairs or expanded lower-case characters', () => {
  assert.equal(hl('title', '𠮷野家 Engineer', '野'), `𠮷${MARK('野')}家 Engineer`);
  assert.equal(hl('title', '𠮷野家', '𠮷'), `${MARK('𠮷')}野家`);
  assert.equal(hl('location', '😀东京', '东'), `😀${MARK('东')}京`);
  // “İ” 小写后是两个码点（i + U+0307），命中其中一部分时高亮整个原字符。
  assert.equal(hl('title', 'İstanbul', 'stanbul'), `İ${MARK('stanbul')}`);
  assert.equal(hl('title', 'İstanbul', 'i\u0307'), `${MARK('İ')}stanbul`);
  // 词尾 Σ 按整串小写规则变 ς，和后端一致。
  assert.equal(hl('title', 'ΑΣ', 'ας'), MARK('ΑΣ'));
});

test('highlight: user text is escaped, and only the fixed mark tag can appear', () => {
  const hostile = [
    ['title', '<script>alert(1)</script>', '<script>'],
    ['company', '"><img src=x onerror=alert(1)>', 'onerror'],
    ['company', `A&B <Co> "q" 'p'`, '&'],
    ['title', `A&B <Co> "q" 'p'`, `'`],
    ['title', `A&B <Co> "q" 'p'`, '"'],
    ['location', '<b>bold</b>', '<b>'],
    ['location', '&lt;script&gt;', '&lt;'],
    ['title', 'plain', '<img src=x onerror=alert(1)>'],
  ] as const;
  for (const [field, text, query] of hostile) {
    const html = hl(field, text, query);
    const rest = html.replaceAll('<mark class="search-match">', '').replaceAll('</mark>', '');
    assert.doesNotMatch(rest, /[<>]/, html);
    assert.doesNotMatch(rest, /["']/, html);
    assert.doesNotMatch(html, /<script|<img|onerror=/, html);
    assert.equal(html.replace(/<\/?mark[^>]*>/g, '').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&'), text);
  }
  assert.equal(hl('title', '<script>alert(1)</script>', '<script>'), `${MARK('&lt;script&gt;')}alert(1)&lt;/script&gt;`);
  assert.equal(hl('company', `A&B "q" 'p'`, 'a&b'), `${MARK('A&amp;B')} &quot;q&quot; &#39;p&#39;`);
  assert.equal(hl('title', `A&B "q" 'p'`, '&'), `A${MARK('&amp;')}B &quot;q&quot; &#39;p&#39;`);
  // 公司查询会被后端去掉尾部标点，只剩标点的查询规范化为空：命中所有行，但没有具体位置可标。
  assert.equal(hl('company', `A&B`, '&'), 'A&amp;B');
});

test('highlight style uses theme variables, not glaring hard-coded colours', () => {
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  const rule = css.match(/\.search-match\s*\{([^}]*)\}/);
  assert.ok(rule, '缺少 .search-match');
  const body = rule[1];
  assert.match(body, /background:\s*var\(--accent-[a-z-]+\)/);
  assert.match(body, /color:\s*var\(--accent-[a-z-]+\)/);
  assert.match(body, /padding:\s*0 2px/);
  assert.match(body, /border-radius:\s*[34]px/);
  assert.match(body, /font-weight:\s*650/);
  assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\b(yellow|red|lime|magenta)\b/i);
  const root = css.match(/:root\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(root, /--accent:\s*#36756b/);
  for (const name of ['--accent-strong', '--accent-mark']) assert.match(root, new RegExp(`${name}:\\s*#[0-9a-f]{6}`), name);
  assert.doesNotMatch(css, /list-no-results/);
});

test('location highlight is asymmetric on purpose: it mirrors what SQLite actually matches', () => {
  // 下面每一行都和真实后端（Rust to_lowercase 的模式 vs SQLite ASCII-only lower() 的文本）核对过。
  assert.equal(hl('location', 'É', 'É'), 'É');
  assert.equal(hl('location', 'É', 'é'), 'É');
  assert.equal(hl('location', 'é', 'é'), MARK('é'));
  assert.equal(hl('location', 'é', 'É'), MARK('é'));
  assert.equal(hl('location', 'İstanbul', 'İ'), 'İstanbul');
  assert.equal(hl('location', 'ABC', 'abc'), MARK('ABC'));
  assert.equal(hl('location', 'abc', 'ABC'), MARK('abc'));
  // 公司、岗位仍是 Unicode 小写。
  assert.equal(hl('title', 'É', 'é'), MARK('É'));
  assert.equal(hl('company', 'É', 'é'), MARK('É'));
});

// --- #550 静态检查：页面结构、文案红线 ---------------------------------------------------

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const section = (html: string, id: string) => {
  const start = html.indexOf(`<section id="${id}"`);
  assert.ok(start >= 0, `缺少 #${id}`);
  const end = html.indexOf('</section>', start);
  return html.slice(start, end);
};

test('the applications page no longer has the old shortcut chips, sort controls, paging or hidden filters', () => {
  const html = section(read('../index.html'), 'view-applications');
  for (const gone of ['app-stage-chips', 'app-shortcut-settings', 'app-sort', 'app-sort-direction', 'btn-prev-page', 'btn-next-page', 'app-stage"', 'app-recycle', 'apps-page', 'correct-stage-dialog', 'evidence-dialog']) {
    assert.ok(!html.includes(gone), `不应再有 ${gone}`);
  }
  for (const kept of ['id="app-search"', 'id="btn-new-app"', 'id="new-job-bar"', 'id="apps-list"', 'id="apps-empty"', 'id="apps-no-results"', 'id="progress-dialog"', 'id="app-form-dialog"', 'id="snapshot-dialog"', 'id="apps-undo"']) {
    assert.ok(html.includes(kept), `应保留 ${kept}`);
  }
  assert.match(html, /<h1>投递<\/h1>/);
  assert.match(html, /placeholder="搜索公司、岗位或城市"/);
  assert.match(html, /没有相关投递记录/);
});

test('user-visible text never says 简历快照 / 冻结字段 / 下载配方 on the applications page', () => {
  const banned = /简历快照|冻结字段|下载配方/;
  assert.doesNotMatch(section(read('../index.html'), 'view-applications'), banned);
  assert.match(read('../index.html'), /<h3>当时交的简历<\/h3>/);
  // 事件文案、状态文案、界面代码里的中文提示都不带这些词（内部类型名 SnapshotView 之类是英文，不受影响）。
  for (const file of ['./applications-ui.ts', './applications.ts', './applications-model.ts']) {
    assert.doesNotMatch(read(file), banned, file);
  }
});

test('the applications page uses inline stroke icons only: no emoji, no ··· row menu, no remote assets', () => {
  const sources = [read('./applications-ui.ts'), read('./applications-model.ts'), section(read('../index.html'), 'view-applications')].join('\n');
  // 真正的 Emoji 区段；「→」「↗」是文字箭头（设计稿里就是这么写的），不在其中。
  assert.doesNotMatch(sources, /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\uFE0F]/u);
  assert.doesNotMatch(sources, /···|⋯|……/);
  assert.doesNotMatch(sources.replace('placeholder="https://"', ''), /https?:\/\/(?!www\.w3\.org)/);
  assert.doesNotMatch(sources, /<img\s/);
  const css = read('./styles.css');
  const block = css.slice(css.indexOf('/* 投递页（#550）'), css.indexOf('.empty { margin: 8px 18px 18px'));
  assert.ok(block.length > 500, '缺少投递页样式块');
  assert.doesNotMatch(block, /url\(|@import|https?:/);
  assert.match(block, /var\(--ui-brand\)/);
  assert.match(block, /grid-template-columns:\s*minmax\(150px,\s*1\.1fr\)\s+minmax\(170px,\s*1\.35fr\)\s+minmax\(130px,\s*0\.95fr\)\s+auto/);
  assert.match(block, /@media \(max-width: 680px\)/);
  // 不做右侧滑出抽屉。
  assert.doesNotMatch(block, /position:\s*fixed|translateX\(100%\)/);
});

test('the community-remote entry is gated by the platform switch and the page never previews mail', () => {
  const source = read('./applications-ui.ts');
  assert.match(source, /data-platform="community-remote" data-platform-off/);
  assert.doesNotMatch(source, /get_evidence_preview_cmd|unassociate_evidence_cmd|set_evidence_recycled_cmd|mountAttachmentList/);
});

test('every command the page sends is a command the Rust side registers', () => {
  const lib = read('../src-tauri/src/lib.rs');
  const source = read('./applications-ui.ts') + read('./applications-model.ts');
  const used = new Set([...source.matchAll(/["'`]([a-z_]+_cmd)["'`]/g)].map((m) => m[1]));
  for (const name of ['list_applications_cmd', 'list_todos_cmd', 'get_application_cmd', 'create_application_cmd', 'update_application_cmd', 'add_note_cmd', 'confirm_submit_cmd', 'correct_stage_cmd', 'set_recycle_cmd', 'get_snapshot_cmd']) assert.ok(used.has(name), `页面应使用 ${name}`);
  for (const name of used) assert.ok(new RegExp(`\\b${name}\\b`).test(lib), `${name} 没有在 lib.rs 注册`);
  // record_*_cmd 是拼出来的，逐个核对。
  for (const stage of ['assessment', 'interview', 'offer', 'rejected', 'withdrawn', 'closed']) assert.ok(lib.includes(`record_${stage}_cmd`), `record_${stage}_cmd`);
});

test('no other desktop source still reads the removed controls', () => {
  const stray = [];
  for (const name of readdirSync(new URL('.', import.meta.url))) {
    if (!/\.(ts|tsx)$/.test(name) || /\.test\./.test(name)) continue;
    if (/app-stage-chips|app-shortcut|btn-prev-page|btn-next-page|app-sort|app-recycle/.test(read(`./${name}`))) stray.push(name);
  }
  assert.deepEqual(stray, []);
});
