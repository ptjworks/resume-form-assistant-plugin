// #429 item 4: a desktop file goes to a web page only for the tab, site, card and file the user confirmed
// in the side panel, once, within ten minutes, and not after the tab moves on. Before that a page learns
// which file id would go into each of its boxes, never the list itself. Fake values only.
const test = require('node:test');
const assert = require('node:assert/strict');
const slots = require('../upload-slots.js');

const SHA = 'a'.repeat(64);
const OTHER_SHA = 'b'.repeat(64);
const CARD = 'k3x9-a1b2:4';
const api = { runtime: { id: 'ext', getURL: (file) => `chrome-extension://ext/${file}` }, tabs: { get: async () => null } };
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

test('a grant gives each confirmed file once, to the same tab, site and card only, until it expires', async () => {
  const { createUploadGrants, GRANT_TTL_MS } = await load();
  let time = 1000;
  const grants = createUploadGrants({ now: () => time });
  assert.equal(grants.grant(7, 'https://jobs.example.test', CARD, [{ fileId: 'r1', sha256: SHA }, { fileId: 'p1', sha256: OTHER_SHA }]), true);
  assert.equal(took(grants, 8, 'https://jobs.example.test/apply', 'r1', CARD), '', 'another tab');
  assert.equal(took(grants, 7, 'https://evil.example.test/apply', 'r1', CARD), '', 'another site in the same tab');
  assert.equal(took(grants, 7, 'http://jobs.example.test/apply', 'r1', CARD), '', 'same host, other scheme');
  assert.equal(took(grants, 7, 'https://jobs.example.test/apply', 'r1', 'k3x9-a1b2:5'), '', 'a later card on the same page');
  assert.equal(took(grants, 7, 'https://jobs.example.test/apply', 'r1', 'zz-reload:4'), '', 'the same card number after a reload');
  assert.equal(took(grants, 7, 'https://jobs.example.test/apply', 'x9', CARD), '', 'a file that was not confirmed');
  assert.equal(took(grants, 7, 'https://jobs.example.test/apply/step2', 'r1', CARD), SHA, 'the confirmed version');
  assert.equal(took(grants, 7, 'https://jobs.example.test/apply', 'r1', CARD), '', 'only once');
  time += GRANT_TTL_MS + 1;
  assert.equal(took(grants, 7, 'https://jobs.example.test/apply', 'p1', CARD), '', 'expired');
});

test('a grant is refused for a page that is not http(s), a card that is not one, or a malformed list; a new one replaces the old', async () => {
  const { createUploadGrants } = await load();
  const grants = createUploadGrants({ now: () => 0 });
  assert.equal(grants.grant(1, 'chrome-extension://ext', CARD, [{ fileId: 'r1', sha256: SHA }]), false);
  assert.equal(grants.grant(1, 'https://jobs.example.test/apply', CARD, [{ fileId: 'r1', sha256: SHA }]), false, 'an origin, not an address');
  assert.equal(grants.grant(1, 'https://jobs.example.test', '', [{ fileId: 'r1', sha256: SHA }]), false, 'no card');
  assert.equal(grants.grant(1, 'https://jobs.example.test', 'k3x9', [{ fileId: 'r1', sha256: SHA }]), false, 'no version');
  assert.equal(grants.grant(1, 'https://jobs.example.test', CARD, []), false);
  assert.equal(grants.grant(1, 'https://jobs.example.test', CARD, [{ fileId: 'r1', sha256: 'nope' }]), false);
  assert.equal(grants.grant(1, 'https://jobs.example.test', CARD, [{ fileId: 'r1', sha256: SHA }]), true);
  assert.equal(grants.grant(1, 'https://jobs.example.test', 'k3x9-a1b2:5', [{ fileId: 'p1', sha256: OTHER_SHA }]), true);
  assert.equal(took(grants, 1, 'https://jobs.example.test/', 'r1', CARD), '', 'the older yes is gone');
  assert.equal(took(grants, 1, 'https://jobs.example.test/', 'p1', 'k3x9-a1b2:5'), OTHER_SHA);
  grants.grant(2, 'https://jobs.example.test', CARD, [{ fileId: 'r1', sha256: SHA }]);
  grants.revoke(2);
  assert.equal(took(grants, 2, 'https://jobs.example.test/', 'r1', CARD), '');
});

test('a tab that moves to another address or closes loses its yes; other updates keep it', async () => {
  const { createUploadGrants, revokeOnNavigation } = await load();
  const grants = createUploadGrants({ now: () => 0 });
  const listeners = {};
  revokeOnNavigation({ tabs: { onRemoved: { addListener: (fn) => { listeners.removed = fn; } },
    onUpdated: { addListener: (fn) => { listeners.updated = fn; } } } }, grants);
  grants.grant(3, 'https://jobs.example.test', CARD, [{ fileId: 'r1', sha256: SHA }, { fileId: 'p1', sha256: OTHER_SHA }]);
  listeners.updated(3, { status: 'complete' });
  listeners.updated(3, { title: '网上申请' });
  assert.equal(took(grants, 3, 'https://jobs.example.test/apply', 'r1', CARD), SHA, 'loading finished, title changed');
  // 单页应用换了地址（同一个网站）：剩下的文件也不给了。
  listeners.updated(3, { url: 'https://jobs.example.test/apply#step2' });
  assert.equal(took(grants, 3, 'https://jobs.example.test/apply#step2', 'p1', CARD), '');
  grants.grant(4, 'https://jobs.example.test', CARD, [{ fileId: 'r1', sha256: SHA }]);
  listeners.removed(4);
  assert.equal(took(grants, 4, 'https://jobs.example.test/apply', 'r1', CARD), '');
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

test('only the side panel may grant, and only for the site its tab shows now and a well-formed card', async () => {
  const mod = await load();
  const grants = mod.createUploadGrants();
  const tabs = { get: async (id) => ({ id, url: 'https://jobs.example.test/apply/form' }) };
  const deps = { api: { ...api, tabs }, grants, files: desk() };
  const message = { type: mod.RESUME_FILES_GRANT, tabId: 4, origin: 'https://jobs.example.test', card: CARD, files: [{ fileId: 'r1', sha256: SHA }] };
  assert.deepEqual(await call(mod, deps, message, page(4, 'https://jobs.example.test/apply')), { status: 'forbidden' });
  assert.deepEqual(await call(mod, deps, message, { id: 'ext', url: 'chrome-extension://ext/popup.html' }), { status: 'forbidden' });
  assert.deepEqual(await call(mod, deps, { ...message, origin: 'https://other.example.test' }, PANEL), { status: 'stale' });
  assert.deepEqual(await call(mod, deps, { ...message, card: undefined }, PANEL), { status: 'invalid_payload' });
  assert.deepEqual(await call(mod, deps, message, PANEL), { status: 'ok' });
  assert.equal(took(grants, 4, 'https://jobs.example.test/apply', 'r1', CARD), SHA);
});

test('a content script gets a file only after the grant, for that card, from the top frame, and only the version confirmed', async () => {
  const mod = await load();
  const grants = mod.createUploadGrants();
  const files = desk();
  const deps = { api, grants, files };
  const fetch = { type: mod.RESUME_FILE_FETCH, fileId: 'r1', card: CARD };
  assert.deepEqual(await call(mod, deps, fetch, page(4, 'https://jobs.example.test/apply')), { status: 'not_confirmed' });
  grants.grant(4, 'https://jobs.example.test', CARD, [{ fileId: 'r1', sha256: SHA }]);
  assert.deepEqual(await call(mod, deps, fetch, page(4, 'https://jobs.example.test/apply', 3)), { status: 'forbidden' }, 'a subframe');
  assert.deepEqual(await call(mod, deps, fetch, { ...page(4, 'https://jobs.example.test/apply'), id: 'another-extension' }), { status: 'forbidden' });
  assert.deepEqual(await call(mod, deps, { ...fetch, card: 'k3x9-a1b2:5' }, page(4, 'https://jobs.example.test/apply')), { status: 'not_confirmed' }, 'another card');
  // 页面不用再说要哪一版：后台按确认时的那一版给。
  const got = await call(mod, deps, { ...fetch, sha256: OTHER_SHA }, page(4, 'https://jobs.example.test/apply'));
  assert.deepEqual(got, { status: 'ok', name: '测试用户_简历.pdf', mime: 'application/pdf', kind: 'resume', byteSize: 3,
    updatedAt: '2026-11-03T08:00:00Z', bytesBase64: 'JVBE' }, 'no label, template bindings or digest for the page');
  assert.deepEqual(files.fetched, ['r1']);
  assert.deepEqual(await call(mod, deps, fetch, page(4, 'https://jobs.example.test/apply')), { status: 'not_confirmed' }, 'not twice');
  // 确认之后桌面里换了文件：同一个 fileId，内容不同。
  grants.grant(5, 'https://jobs.example.test', CARD, [{ fileId: 'r1', sha256: SHA }]);
  const changed = { ...deps, files: desk({ rows: [{ fileId: 'r1', kind: 'resume', name: 'x.pdf', mime: 'application/pdf', byteSize: 3, sha256: OTHER_SHA }] }) };
  assert.deepEqual(await call(mod, changed, fetch, page(5, 'https://jobs.example.test/apply')), { status: 'conflict' });
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

test('the side panel can take its yes back; a page cannot', async () => {
  const mod = await load();
  const grants = mod.createUploadGrants();
  const deps = { api, grants, files: desk() };
  grants.grant(4, 'https://jobs.example.test', CARD, [{ fileId: 'r1', sha256: SHA }]);
  assert.deepEqual(await call(mod, deps, { type: mod.RESUME_FILES_REVOKE, tabId: 4 }, page(4, 'https://jobs.example.test/')), { status: 'forbidden' });
  assert.deepEqual(await call(mod, deps, { type: mod.RESUME_FILES_REVOKE, tabId: 4 }, PANEL), { status: 'ok' });
  assert.equal(took(grants, 4, 'https://jobs.example.test/', 'r1', CARD), '');
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
  const fetch = (fileId) => call(mod, deps, { type: mod.RESUME_FILE_FETCH, fileId, card: CARD }, page(4, 'https://jobs.example.test/apply'));
  grants.grant(4, 'https://jobs.example.test', CARD, [{ fileId: 'r1', sha256: SHA }, { fileId: 'r2', sha256: OTHER_SHA }], 't1');
  assert.equal((await fetch('r1')).status, 'ok', 'a file bound to no template');
  assert.deepEqual(await fetch('r2'), { status: 'wrong_template' }, 'bound to t2 while t1 is in use');
  assert.deepEqual(files.fetched, ['r1'], 'the file for the other template was not read');
  grants.grant(4, 'https://jobs.example.test', CARD, [{ fileId: 'r2', sha256: OTHER_SHA }], 't2');
  assert.equal((await fetch('r2')).status, 'ok', 'bound to the template in use');
  grants.grant(4, 'https://jobs.example.test', CARD, [{ fileId: 'r2', sha256: OTHER_SHA }]);
  assert.deepEqual(await fetch('r2'), { status: 'wrong_template' }, 'no template in use: only files bound to none');
  assert.equal(grants.grant(4, 'https://jobs.example.test', CARD, [{ fileId: 'r1', sha256: SHA }], 7), false, 'a template id that is not one');
});
