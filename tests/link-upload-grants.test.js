// #429 item 4: a desktop file goes to a web page only for the tab, page address, card and file the user
// confirmed in the side panel, once, within ten minutes, and not after the page moves on. Before that a
// page learns which file id would go into each of its boxes, never the list itself. Fake values only.
const test = require('node:test');
const assert = require('node:assert/strict');
const slots = require('../upload-slots.js');

const SHA = 'a'.repeat(64);
const OTHER_SHA = 'b'.repeat(64);
const CARD = 'k3x9-a1b2:4';
const APPLY = 'https://jobs.example.test/apply';
// 后台取文件时用 tabs.get 看标签页现在的地址（这里默认在 APPLY）。page() 的 url 是消息的 sender.url：
// Chrome 里它是页面载入时的地址，pushState、改 hash 以后也不变，所以不拿它判断标签页在哪。
const api = { runtime: { id: 'ext', getURL: (file) => `chrome-extension://ext/${file}` }, tabs: { get: async (id) => ({ id, url: APPLY }) } };
const PANEL = { id: 'ext', url: 'chrome-extension://ext/sidepanel.html' };
const page = (tabId, url, frameId = 0) => ({ id: 'ext', tab: { id: tabId }, frameId, url });
// 取一份文件：给的话是确认时那一版的 sha256，不给是 ''。
const took = (grants, ...args) => grants.take(...args)?.sha256 ?? '';

async function load() {
  return import('../link/upload-grants.mjs');
}

function call(mod, deps, message, sender) {
  return new Promise((resolve) => {
    const kept = mod.handleUploadMessage({ slots, ...deps }, message, sender, resolve);
    if (kept === null) resolve('not mine');
  });
}

test('a grant gives each confirmed file once, to the same tab, page address and card only, until it expires', async () => {
  const { createUploadGrants, GRANT_TTL_MS } = await load();
  let time = 1000;
  const grants = createUploadGrants({ now: () => time });
  assert.equal(grants.grant(7, APPLY, CARD, [{ fileId: 'r1', sha256: SHA }, { fileId: 'p1', sha256: OTHER_SHA }]), true);
  assert.equal(took(grants, 8, APPLY, 'r1', CARD), '', 'another tab');
  assert.equal(took(grants, 7, 'https://evil.example.test/apply', 'r1', CARD), '', 'another site in the same tab');
  assert.equal(took(grants, 7, 'http://jobs.example.test/apply', 'r1', CARD), '', 'same host, other scheme');
  // 单页应用在同一个网站里换了地址（pushState）：是另一页了。
  assert.equal(took(grants, 7, `${APPLY}/step2`, 'r1', CARD), '', 'another address on the same site');
  assert.equal(took(grants, 7, APPLY, 'r1', 'k3x9-a1b2:5'), '', 'a later card on the same page');
  assert.equal(took(grants, 7, APPLY, 'r1', 'zz-reload:4'), '', 'the same card number after a reload');
  assert.equal(took(grants, 7, APPLY, 'x9', CARD), '', 'a file that was not confirmed');
  assert.equal(took(grants, 7, APPLY, 'r1', CARD), SHA, 'the confirmed version');
  assert.equal(took(grants, 7, APPLY, 'r1', CARD), '', 'only once');
  time += GRANT_TTL_MS + 1;
  assert.equal(took(grants, 7, APPLY, 'p1', CARD), '', 'expired');
});

test('a grant is refused for a page that is not http(s), a card that is not one, or a malformed list; a new one replaces the old', async () => {
  const { createUploadGrants } = await load();
  const grants = createUploadGrants({ now: () => 0 });
  assert.equal(grants.grant(1, 'chrome-extension://ext/sidepanel.html', CARD, [{ fileId: 'r1', sha256: SHA }]), false);
  assert.equal(grants.grant(1, APPLY, '', [{ fileId: 'r1', sha256: SHA }]), false, 'no card');
  assert.equal(grants.grant(1, APPLY, 'k3x9', [{ fileId: 'r1', sha256: SHA }]), false, 'no version');
  assert.equal(grants.grant(1, APPLY, CARD, []), false);
  assert.equal(grants.grant(1, APPLY, CARD, [{ fileId: 'r1', sha256: 'nope' }]), false);
  assert.equal(grants.grant(1, APPLY, CARD, [{ fileId: 'r1', sha256: SHA }]), true);
  assert.equal(grants.grant(1, APPLY, 'k3x9-a1b2:5', [{ fileId: 'p1', sha256: OTHER_SHA }]), true);
  assert.equal(took(grants, 1, APPLY, 'r1', CARD), '', 'the older yes is gone');
  assert.equal(took(grants, 1, APPLY, 'p1', 'k3x9-a1b2:5'), OTHER_SHA);
  grants.grant(2, APPLY, CARD, [{ fileId: 'r1', sha256: SHA }]);
  grants.revoke(2);
  assert.equal(took(grants, 2, APPLY, 'r1', CARD), '');
});

test('a tab that moves to another address or closes loses its yes; other updates keep it', async () => {
  const { createUploadGrants, revokeOnNavigation } = await load();
  const grants = createUploadGrants({ now: () => 0 });
  const listeners = {};
  revokeOnNavigation({ tabs: { onRemoved: { addListener: (fn) => { listeners.removed = fn; } },
    onUpdated: { addListener: (fn) => { listeners.updated = fn; } } } }, grants);
  grants.grant(3, APPLY, CARD, [{ fileId: 'r1', sha256: SHA }, { fileId: 'p1', sha256: OTHER_SHA }]);
  listeners.updated(3, { status: 'complete' });
  listeners.updated(3, { title: '网上申请' });
  listeners.updated(3, { url: APPLY });
  listeners.updated(5, { url: 'https://other.example.test/' });
  assert.equal(took(grants, 3, APPLY, 'r1', CARD), SHA, 'loading finished, title changed, the same address again, another tab moved');
  // 单页应用换了地址（同一个网站）：剩下的文件也不给了，回到原来的地址也不给。
  listeners.updated(3, { url: `${APPLY}#step2` });
  listeners.updated(3, { url: APPLY });
  assert.equal(took(grants, 3, APPLY, 'p1', CARD), '');
  grants.grant(4, APPLY, CARD, [{ fileId: 'r1', sha256: SHA }]);
  listeners.removed(4);
  assert.equal(took(grants, 4, APPLY, 'r1', CARD), '');
  // 没有 tabs 的环境（测试里的假 chrome）不出错。
  assert.doesNotThrow(() => revokeOnNavigation({}, grants));
});

function desk({ rows = [{ fileId: 'r1', kind: 'resume', name: '测试用户_简历.pdf', label: '中文版', mime: 'application/pdf', byteSize: 3, sha256: SHA,
  isDefault: true, templateIds: [], updatedAt: '2026-11-03T08:00:00Z' }], status = 'ok' } = {}) {
  const fetched = [];
  return {
    fetched,
    list: async () => (status === 'ok' ? { status: 'ok', files: rows } : { status }),
    fetch: async (row) => { fetched.push(row.fileId); return { status: 'ok', name: row.name, mime: row.mime, byteSize: row.byteSize, sha256: row.sha256, bytesBase64: 'JVBE' }; }
  };
}

test('only the side panel may grant, and only for the site its tab shows now and a well-formed card; the yes is for that address', async () => {
  const mod = await load();
  const grants = mod.createUploadGrants();
  const tabs = { get: async (id) => ({ id, url: `${APPLY}/form` }) };
  const deps = { api: { ...api, tabs }, grants, files: desk() };
  const message = { type: mod.RESUME_FILES_GRANT, tabId: 4, origin: 'https://jobs.example.test', card: CARD, files: [{ fileId: 'r1', sha256: SHA }] };
  assert.deepEqual(await call(mod, deps, message, page(4, APPLY)), { status: 'forbidden' });
  assert.deepEqual(await call(mod, deps, message, { id: 'ext', url: 'chrome-extension://ext/popup.html' }), { status: 'forbidden' });
  assert.deepEqual(await call(mod, deps, { ...message, origin: 'https://other.example.test' }, PANEL), { status: 'stale' });
  assert.deepEqual(await call(mod, deps, { ...message, card: undefined }, PANEL), { status: 'invalid_payload' });
  assert.deepEqual(await call(mod, deps, message, PANEL), { status: 'ok' });
  assert.equal(took(grants, 4, APPLY, 'r1', CARD), '', 'not for another address on the same site');
  assert.equal(took(grants, 4, `${APPLY}/form`, 'r1', CARD), SHA, 'for the address the tab showed');
});

test('a content script gets a file only after the grant, for that card and the address the tab shows, from the top frame, and only the version confirmed', async () => {
  const mod = await load();
  const grants = mod.createUploadGrants();
  const files = desk();
  let at = APPLY;
  const deps = { api: { ...api, tabs: { get: async (id) => ({ id, url: at }) } }, grants, files };
  const fetch = { type: mod.RESUME_FILE_FETCH, fileId: 'r1', card: CARD };
  assert.deepEqual(await call(mod, deps, fetch, page(4, APPLY)), { status: 'not_confirmed' });
  grants.grant(4, APPLY, CARD, [{ fileId: 'r1', sha256: SHA }]);
  assert.deepEqual(await call(mod, deps, fetch, page(4, APPLY, 3)), { status: 'forbidden' }, 'a subframe');
  assert.deepEqual(await call(mod, deps, fetch, { ...page(4, APPLY), id: 'another-extension' }), { status: 'forbidden' });
  assert.deepEqual(await call(mod, deps, { ...fetch, card: 'k3x9-a1b2:5' }, page(4, APPLY)), { status: 'not_confirmed' }, 'another card');
  // 同一个网站里 pushState 跳到下一页（消息里还是载入时的地址）：前一页的确认在这一页取不到文件，回到前一页也取不到了。
  at = `${APPLY}/step2`;
  assert.deepEqual(await call(mod, deps, fetch, page(4, APPLY)), { status: 'not_confirmed' }, 'after a same-site pushState');
  at = APPLY;
  assert.deepEqual(await call(mod, deps, fetch, page(4, APPLY)), { status: 'not_confirmed' }, 'and back again');
  assert.deepEqual(files.fetched, [], 'nothing read for any of these');
  grants.grant(4, APPLY, CARD, [{ fileId: 'r1', sha256: SHA }]);
  // 页面不用再说要哪一版：后台按确认时的那一版给。
  const got = await call(mod, deps, { ...fetch, sha256: OTHER_SHA }, page(4, APPLY));
  assert.deepEqual(got, { status: 'ok', name: '测试用户_简历.pdf', mime: 'application/pdf', kind: 'resume', byteSize: 3,
    updatedAt: '2026-11-03T08:00:00Z', bytesBase64: 'JVBE' }, 'no label, template bindings or digest for the page');
  assert.deepEqual(files.fetched, ['r1']);
  assert.deepEqual(await call(mod, deps, fetch, page(4, APPLY)), { status: 'not_confirmed' }, 'not twice');
  // 确认之后桌面里换了文件：同一个 fileId，内容不同。
  grants.grant(5, APPLY, CARD, [{ fileId: 'r1', sha256: SHA }]);
  const changed = { ...deps, files: desk({ rows: [{ fileId: 'r1', kind: 'resume', name: 'x.pdf', mime: 'application/pdf', byteSize: 3, sha256: OTHER_SHA }] }) };
  assert.deepEqual(await call(mod, changed, fetch, page(5, APPLY)), { status: 'conflict' });
  assert.deepEqual(changed.files.fetched, []);
});

test('the file list is for the side panel only; a page asks which file would go into each of its boxes', async () => {
  const mod = await load();
  const rows = [
    { fileId: 'r1', kind: 'resume', name: '测试用户_中文简历.pdf', label: '中文版', mime: 'application/pdf', byteSize: 2048, sha256: SHA, isDefault: true, templateIds: [] },
    { fileId: 'r2', kind: 'resume', name: '测试用户_英文简历.pdf', label: 'English', mime: 'application/pdf', byteSize: 4096, sha256: OTHER_SHA, isDefault: false, templateIds: ['t2'] },
    { fileId: 'p1', kind: 'photo', name: '证件照.jpg', label: '', mime: 'image/jpeg', byteSize: 3 * 1024 * 1024, sha256: SHA, isDefault: true, templateIds: [] }
  ];
  const deps = { api, grants: mod.createUploadGrants(), files: desk({ rows }) };
  assert.equal((await call(mod, deps, { type: mod.RESUME_FILES_LIST }, PANEL)).status, 'ok');
  assert.deepEqual(await call(mod, deps, { type: mod.RESUME_FILES_LIST }, page(1, 'https://jobs.example.test/')), { status: 'forbidden' });
  const plan = {
    type: mod.RESUME_FILES_PLAN, templateId: 't1',
    slots: [
      { id: 'upload-0', kind: 'resume', accept: '.pdf', limit: 10 * 1024 * 1024, language: [] },
      { id: 'upload-1', kind: 'photo', accept: 'image/*', limit: 2 * 1024 * 1024, language: [] },
      { id: 'upload-2', kind: 'transcript', accept: '.pdf', limit: 10 * 1024 * 1024, language: [] },
      { id: 'upload-3', kind: 'resume', accept: '.pdf', limit: 10 * 1024 * 1024, language: ['en'] }
    ]
  };
  const answer = await call(mod, deps, plan, page(1, 'https://jobs.example.test/'));
  assert.deepEqual(answer, { status: 'ok', slots: [
    { id: 'upload-0', fileId: 'r1', reason: '' },
    { id: 'upload-1', fileId: '', reason: 'too_large', byteSize: 3 * 1024 * 1024 },
    { id: 'upload-2', fileId: '', reason: 'no_file' },
    // 英文简历框：英文版绑的是别的模板，这个模板只能用中文版，不自动传，请用户选。
    { id: 'upload-3', fileId: '', reason: 'choose' }
  ] });
  assert.equal(JSON.stringify(answer).includes('简历.pdf') || JSON.stringify(answer).includes(SHA), false, 'no names or digests');
  const bound = await call(mod, deps, { ...plan, templateId: 't2' }, page(1, 'https://jobs.example.test/'));
  assert.equal(bound.slots[0].fileId, 'r2', 'the file bound to the template wins');
  assert.deepEqual(await call(mod, deps, plan, page(1, 'https://jobs.example.test/', 2)), { status: 'forbidden' }, 'a subframe');
  assert.deepEqual(await call(mod, deps, plan, PANEL), { status: 'forbidden' });
  for (const bad of [{ slots: [{ ...plan.slots[0], kind: 'other' }] }, { slots: [{ ...plan.slots[0], limit: 11 * 1024 * 1024 }] },
    { slots: [{ ...plan.slots[0], id: 'resume' }] }, { slots: [{ ...plan.slots[0], language: ['fr'] }] }, { templateId: 7 }]) {
    assert.deepEqual(await call(mod, deps, { ...plan, ...bad }, page(1, 'https://jobs.example.test/')), { status: 'invalid_payload' });
  }
  const old = { ...deps, files: desk({ status: 'unsupported' }) };
  assert.deepEqual(await call(mod, old, plan, page(1, 'https://jobs.example.test/')), { status: 'unsupported' });
  assert.equal(await call(mod, deps, { type: 'DESKTOP_RESUME_READ' }, PANEL), 'not mine');
});

test('the side panel can take its yes back; a page can give back only what is left for its own card', async () => {
  const mod = await load();
  const grants = mod.createUploadGrants();
  const deps = { api, grants, files: desk() };
  grants.grant(4, APPLY, CARD, [{ fileId: 'r1', sha256: SHA }]);
  assert.deepEqual(await call(mod, deps, { type: mod.RESUME_FILES_REVOKE, tabId: 4 }, page(4, APPLY)), { status: 'forbidden' });
  assert.deepEqual(await call(mod, deps, { type: mod.RESUME_FILES_REVOKE, tabId: 4 }, PANEL), { status: 'ok' });
  assert.equal(took(grants, 4, APPLY, 'r1', CARD), '');
  // 页面说它换了地址、上传结束了：自己这张卡片剩下的确认作废。
  grants.grant(4, APPLY, CARD, [{ fileId: 'r1', sha256: SHA }]);
  assert.deepEqual(await call(mod, deps, { type: mod.RESUME_FILES_RELEASE, card: CARD }, page(4, APPLY, 2)), { status: 'forbidden' }, 'a subframe');
  assert.deepEqual(await call(mod, deps, { type: mod.RESUME_FILES_RELEASE, card: 'k3x9-a1b2:9' }, page(4, APPLY)), { status: 'ok' });
  assert.equal(took(grants, 4, APPLY, 'r1', CARD), SHA, 'another card leaves this yes alone');
  grants.grant(4, APPLY, CARD, [{ fileId: 'r1', sha256: SHA }]);
  assert.deepEqual(await call(mod, deps, { type: mod.RESUME_FILES_RELEASE, card: CARD }, page(4, `${APPLY}/step2`)), { status: 'ok' });
  assert.equal(took(grants, 4, APPLY, 'r1', CARD), '', 'its own card: gone');
});

test('a file bound to other templates is not handed over, whatever the panel picked; one bound to the template in use, or to none, is', async () => {
  const mod = await load();
  const rows = [
    { fileId: 'r1', kind: 'resume', name: '通用简历.pdf', mime: 'application/pdf', byteSize: 3, sha256: SHA, templateIds: [], updatedAt: '2026-11-03T08:00:00Z' },
    { fileId: 'r2', kind: 'resume', name: '英文简历.pdf', mime: 'application/pdf', byteSize: 3, sha256: OTHER_SHA, templateIds: ['t2'], updatedAt: '2026-11-03T08:00:00Z' }
  ];
  const grants = mod.createUploadGrants();
  const files = desk({ rows });
  const deps = { api, grants, files };
  const fetch = (fileId) => call(mod, deps, { type: mod.RESUME_FILE_FETCH, fileId, card: CARD }, page(4, APPLY));
  grants.grant(4, APPLY, CARD, [{ fileId: 'r1', sha256: SHA }, { fileId: 'r2', sha256: OTHER_SHA }], 't1');
  assert.equal((await fetch('r1')).status, 'ok', 'a file bound to no template');
  assert.deepEqual(await fetch('r2'), { status: 'wrong_template' }, 'bound to t2 while t1 is in use');
  assert.deepEqual(files.fetched, ['r1'], 'the file for the other template was not read');
  grants.grant(4, APPLY, CARD, [{ fileId: 'r2', sha256: OTHER_SHA }], 't2');
  assert.equal((await fetch('r2')).status, 'ok', 'bound to the template in use');
  grants.grant(4, APPLY, CARD, [{ fileId: 'r2', sha256: OTHER_SHA }]);
  assert.deepEqual(await fetch('r2'), { status: 'wrong_template' }, 'no template in use: only files bound to none');
  assert.equal(grants.grant(4, APPLY, CARD, [{ fileId: 'r1', sha256: SHA }], 7), false, 'a template id that is not one');
});

test('a desktop that fails for a moment does not use up the yes: the next try gets the file, and still only once', async () => {
  const mod = await load();
  const grants = mod.createUploadGrants();
  const files = desk();
  let lists = 0;
  const flaky = { ...files, list: async () => ((lists += 1) === 1 ? { status: 'unavailable' } : files.list()) };
  const deps = { api, grants, files: flaky };
  const fetch = () => call(mod, deps, { type: mod.RESUME_FILE_FETCH, fileId: 'r1', card: CARD }, page(4, APPLY));
  grants.grant(4, APPLY, CARD, [{ fileId: 'r1', sha256: SHA }]);
  assert.deepEqual(await fetch(), { status: 'unavailable' });
  assert.equal((await fetch()).status, 'ok', 'no new yes needed after the desktop came back');
  assert.deepEqual(await fetch(), { status: 'not_confirmed' }, 'still once per yes');
});

test('two requests for the same file at once: the second is turned away before anything is read', async () => {
  const mod = await load();
  const grants = mod.createUploadGrants();
  const files = desk();
  const deps = { api, grants, files };
  const fetch = () => call(mod, deps, { type: mod.RESUME_FILE_FETCH, fileId: 'r1', card: CARD }, page(4, APPLY));
  grants.grant(4, APPLY, CARD, [{ fileId: 'r1', sha256: SHA }]);
  const both = await Promise.all([fetch(), fetch()]);
  assert.deepEqual(both.map((reply) => reply.status).sort(), ['busy', 'ok']);
  assert.deepEqual(files.fetched, ['r1'], 'the desktop was read once');
});

test('a read that runs past the worker\'s limit ends in time for the page and does not use up the yes; a late result is dropped', async () => {
  const mod = await load();
  const grants = mod.createUploadGrants();
  const files = desk();
  let reads = 0;
  // 第一次读文件要 80 毫秒（比后台的上限 20 毫秒长），第二次马上读完。
  const slow = { ...files, fetch: async (row) => {
    reads += 1;
    if (reads === 1) await new Promise((resolve) => setTimeout(resolve, 80));
    return files.fetch(row);
  } };
  const deps = { api, grants, files: slow, fetchTimeoutMs: 20 };
  const fetch = () => call(mod, deps, { type: mod.RESUME_FILE_FETCH, fileId: 'r1', card: CARD }, page(4, APPLY));
  grants.grant(4, APPLY, CARD, [{ fileId: 'r1', sha256: SHA }]);
  assert.deepEqual(await fetch(), { status: 'unavailable' }, 'the worker gives up first');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await fetch()).status, 'ok', 'tried again without a new yes; the late first read did not use it up');
  assert.deepEqual(await fetch(), { status: 'not_confirmed' });
  assert.equal(mod.FETCH_TIMEOUT_MS < 60000, true, 'shorter than the page waits');
});

test('once the tab has been at another address, the yes is gone for good, even back on the page it was for', async () => {
  const mod = await load();
  const grants = mod.createUploadGrants();
  const files = desk();
  const updated = [];
  let at = APPLY;
  const tabs = { get: async (id) => ({ id, url: at }), onUpdated: { addListener: (fn) => updated.push(fn) } };
  const deps = { api: { ...api, tabs }, grants, files };
  mod.revokeOnNavigation(deps.api, grants);
  const move = (url) => { at = url; for (const fn of updated) fn(4, { url }); };
  const fetch = () => call(mod, deps, { type: mod.RESUME_FILE_FETCH, fileId: 'r1', card: CARD }, page(4, APPLY));
  // 确认以后跳到下一页，再回到原来的地址：旧确认取不到文件。
  grants.grant(4, APPLY, CARD, [{ fileId: 'r1', sha256: SHA }]);
  move(`${APPLY}/step2`);
  move(APPLY);
  assert.deepEqual(await fetch(), { status: 'not_confirmed' });
  // 取文件的消息比 tabs.onUpdated 先到：后台取文件时看标签页在哪，不在确认时的地址就作废，回来以后也不再给。
  grants.grant(4, APPLY, CARD, [{ fileId: 'r1', sha256: SHA }]);
  at = `${APPLY}/step2`;
  assert.deepEqual(await fetch(), { status: 'not_confirmed' });
  at = APPLY;
  assert.deepEqual(await fetch(), { status: 'not_confirmed' }, 'back again');
  // 问不到这个标签页（刚关掉）：也不给。
  grants.grant(4, APPLY, CARD, [{ fileId: 'r1', sha256: SHA }]);
  tabs.get = async () => { throw new Error('No tab with id: 4'); };
  assert.deepEqual(await fetch(), { status: 'not_confirmed' });
  assert.deepEqual(files.fetched, []);
});

test('a single-page app that moved before the yes gets its files: the worker goes by where the tab is, not where the page loaded', async () => {
  const mod = await load();
  const grants = mod.createUploadGrants();
  const files = desk();
  // 页面在 APPLY 载入，确认以前 pushState 到了 step2：Chrome 发来的消息里 sender.url 仍是 APPLY，tabs.get 是 step2。
  const deps = { api: { ...api, tabs: { get: async (id) => ({ id, url: `${APPLY}/step2` }) } }, grants, files };
  const grant = { type: mod.RESUME_FILES_GRANT, tabId: 4, origin: 'https://jobs.example.test', card: CARD, files: [{ fileId: 'r1', sha256: SHA }] };
  assert.deepEqual(await call(mod, deps, grant, PANEL), { status: 'ok' });
  assert.equal((await call(mod, deps, { type: mod.RESUME_FILE_FETCH, fileId: 'r1', card: CARD }, page(4, APPLY))).status, 'ok');
  assert.deepEqual(files.fetched, ['r1']);
});
