// #429 item 4: a desktop file goes to a web page only for the tab, site and file the user confirmed in
// the side panel, once, within ten minutes. Fake values only.
const test = require('node:test');
const assert = require('node:assert/strict');

const SHA = 'a'.repeat(64);
const OTHER_SHA = 'b'.repeat(64);
const api = { runtime: { id: 'ext', getURL: (file) => `chrome-extension://ext/${file}` }, tabs: { get: async () => null } };
const PANEL = { id: 'ext', url: 'chrome-extension://ext/sidepanel.html' };
const page = (tabId, url, frameId = 0) => ({ id: 'ext', tab: { id: tabId }, frameId, url });

async function load() {
  return import('../link/upload-grants.mjs');
}

function call(mod, deps, message, sender) {
  return new Promise((resolve) => {
    const kept = mod.handleUploadMessage(deps, message, sender, resolve);
    if (kept === null) resolve('not mine');
  });
}

test('a grant gives each confirmed file once, to the same tab and site only, until it expires', async () => {
  const { createUploadGrants, GRANT_TTL_MS } = await load();
  let time = 1000;
  const grants = createUploadGrants({ now: () => time });
  assert.equal(grants.grant(7, 'https://jobs.example.test', [{ fileId: 'r1', sha256: SHA }, { fileId: 'p1', sha256: OTHER_SHA }]), true);
  assert.equal(grants.take(8, 'https://jobs.example.test/apply', 'r1', SHA), false, 'another tab');
  assert.equal(grants.take(7, 'https://evil.example.test/apply', 'r1', SHA), false, 'another site in the same tab');
  assert.equal(grants.take(7, 'http://jobs.example.test/apply', 'r1', SHA), false, 'same host, other scheme');
  assert.equal(grants.take(7, 'https://jobs.example.test/apply', 'r1', OTHER_SHA), false, 'another version of the file');
  assert.equal(grants.take(7, 'https://jobs.example.test/apply', 'x9', SHA), false, 'a file that was not confirmed');
  assert.equal(grants.take(7, 'https://jobs.example.test/apply/step2', 'r1', SHA), true);
  assert.equal(grants.take(7, 'https://jobs.example.test/apply', 'r1', SHA), false, 'only once');
  time += GRANT_TTL_MS + 1;
  assert.equal(grants.take(7, 'https://jobs.example.test/apply', 'p1', OTHER_SHA), false, 'expired');
});

test('a grant is refused for a page that is not http(s) or a malformed list, and a new one replaces the old', async () => {
  const { createUploadGrants } = await load();
  const grants = createUploadGrants({ now: () => 0 });
  assert.equal(grants.grant(1, 'chrome-extension://ext', [{ fileId: 'r1', sha256: SHA }]), false);
  assert.equal(grants.grant(1, 'https://jobs.example.test/apply', [{ fileId: 'r1', sha256: SHA }]), false, 'an origin, not an address');
  assert.equal(grants.grant(1, 'https://jobs.example.test', []), false);
  assert.equal(grants.grant(1, 'https://jobs.example.test', [{ fileId: 'r1', sha256: 'nope' }]), false);
  assert.equal(grants.grant(1, 'https://jobs.example.test', [{ fileId: 'r1', sha256: SHA }]), true);
  assert.equal(grants.grant(1, 'https://jobs.example.test', [{ fileId: 'p1', sha256: OTHER_SHA }]), true);
  assert.equal(grants.take(1, 'https://jobs.example.test/', 'r1', SHA), false, 'the older yes is gone');
  assert.equal(grants.take(1, 'https://jobs.example.test/', 'p1', OTHER_SHA), true);
  grants.grant(2, 'https://jobs.example.test', [{ fileId: 'r1', sha256: SHA }]);
  grants.revoke(2);
  assert.equal(grants.take(2, 'https://jobs.example.test/', 'r1', SHA), false);
});

function desk({ rows = [{ fileId: 'r1', kind: 'resume', name: '测试用户_简历.pdf', mime: 'application/pdf', byteSize: 3, sha256: SHA }] } = {}) {
  const fetched = [];
  return {
    fetched,
    list: async () => ({ status: 'ok', files: rows }),
    fetch: async (row) => { fetched.push(row.fileId); return { status: 'ok', name: row.name, mime: row.mime, byteSize: row.byteSize, sha256: row.sha256, bytesBase64: 'JVBE' }; }
  };
}

test('only the side panel may grant, and only for the site its tab shows now', async () => {
  const mod = await load();
  const grants = mod.createUploadGrants();
  const tabs = { get: async (id) => ({ id, url: 'https://jobs.example.test/apply/form' }) };
  const deps = { api: { ...api, tabs }, grants, files: desk() };
  const message = { type: mod.RESUME_FILES_GRANT, tabId: 4, origin: 'https://jobs.example.test', files: [{ fileId: 'r1', sha256: SHA }] };
  assert.deepEqual(await call(mod, deps, message, page(4, 'https://jobs.example.test/apply')), { status: 'forbidden' });
  assert.deepEqual(await call(mod, deps, message, { id: 'ext', url: 'chrome-extension://ext/popup.html' }), { status: 'forbidden' });
  assert.deepEqual(await call(mod, deps, { ...message, origin: 'https://other.example.test' }, PANEL), { status: 'stale' });
  assert.deepEqual(await call(mod, deps, message, PANEL), { status: 'ok' });
});

test('a content script gets a file only after the grant, from the top frame, and only the version confirmed', async () => {
  const mod = await load();
  const grants = mod.createUploadGrants();
  const files = desk();
  const deps = { api, grants, files };
  const fetch = { type: mod.RESUME_FILE_FETCH, fileId: 'r1', sha256: SHA };
  assert.deepEqual(await call(mod, deps, fetch, page(4, 'https://jobs.example.test/apply')), { status: 'not_confirmed' });
  grants.grant(4, 'https://jobs.example.test', [{ fileId: 'r1', sha256: SHA }]);
  assert.deepEqual(await call(mod, deps, fetch, page(4, 'https://jobs.example.test/apply', 3)), { status: 'forbidden' }, 'a subframe');
  assert.deepEqual(await call(mod, deps, fetch, { ...page(4, 'https://jobs.example.test/apply'), id: 'another-extension' }), { status: 'forbidden' });
  const got = await call(mod, deps, fetch, page(4, 'https://jobs.example.test/apply'));
  assert.equal(got.status, 'ok');
  assert.equal(got.name, '测试用户_简历.pdf');
  assert.deepEqual(files.fetched, ['r1']);
  assert.deepEqual(await call(mod, deps, fetch, page(4, 'https://jobs.example.test/apply')), { status: 'not_confirmed' }, 'not twice');
  // 确认之后桌面里换了文件：同一个 fileId，内容不同。
  grants.grant(5, 'https://jobs.example.test', [{ fileId: 'r1', sha256: SHA }]);
  const changed = { ...deps, files: desk({ rows: [{ fileId: 'r1', kind: 'resume', name: 'x.pdf', mime: 'application/pdf', byteSize: 3, sha256: OTHER_SHA }] }) };
  assert.deepEqual(await call(mod, changed, fetch, page(5, 'https://jobs.example.test/apply')), { status: 'conflict' });
  assert.deepEqual(changed.files.fetched, []);
});

test('the list is open to the side panel and top-frame content scripts; other messages are not handled here', async () => {
  const mod = await load();
  const deps = { api, grants: mod.createUploadGrants(), files: desk() };
  assert.equal((await call(mod, deps, { type: mod.RESUME_FILES_LIST }, PANEL)).status, 'ok');
  assert.equal((await call(mod, deps, { type: mod.RESUME_FILES_LIST }, page(1, 'https://jobs.example.test/'))).status, 'ok');
  assert.deepEqual(await call(mod, deps, { type: mod.RESUME_FILES_LIST }, page(1, 'https://jobs.example.test/', 2)), { status: 'forbidden' });
  assert.equal(await call(mod, deps, { type: 'DESKTOP_RESUME_READ' }, PANEL), 'not mine');
});

test('the side panel can take its yes back; a page cannot', async () => {
  const mod = await load();
  const grants = mod.createUploadGrants();
  const deps = { api, grants, files: desk() };
  grants.grant(4, 'https://jobs.example.test', [{ fileId: 'r1', sha256: SHA }]);
  assert.deepEqual(await call(mod, deps, { type: mod.RESUME_FILES_REVOKE, tabId: 4 }, page(4, 'https://jobs.example.test/')), { status: 'forbidden' });
  assert.deepEqual(await call(mod, deps, { type: mod.RESUME_FILES_REVOKE, tabId: 4 }, PANEL), { status: 'ok' });
  assert.equal(grants.take(4, 'https://jobs.example.test/', 'r1', SHA), false);
});
