// #429: answers remembered per site, through the service worker.
const test = require('node:test');
const assert = require('node:assert/strict');

const ID = '11111111-1111-4111-8111-111111111111';
const identity = { archiveId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', restoreEpoch: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
const CAPABILITIES = ['handshake', 'resume.read', 'siteAnswers.read', 'siteAnswers.save'];

async function client({ capabilities = CAPABILITIES, reply } = {}) {
  const { createSiteAnswers } = await import('../link/site-answers.mjs');
  const { validateRequest } = await import('../link/protocol/validate.mjs');
  const sent = [];
  const siteAnswers = createSiteAnswers({
    session: { probe: async () => ({ mode: 'ready', identity, capabilities }) },
    store: { clientInstanceId: async () => ID },
    uuid: () => ID,
    now: () => new Date('2026-11-02T00:00:00Z'),
    send: async (message) => {
      await validateRequest(message);
      sent.push(message);
      return reply ? reply(message) : { status: 'ok', response: { payload: { site: message.payload.site, answers: message.payload.answers ?? [] } } };
    }
  });
  return { siteAnswers, sent };
}

test('reads and saves go out as v5 envelopes about the one site', async () => {
  const c = await client();
  const read = await c.siteAnswers.read('campus.example.com');
  assert.deepEqual(read, { status: 'ok', site: 'campus.example.com', answers: [] });
  const saved = await c.siteAnswers.save('campus.example.com', [
    { key: '是否有亲属在本公司工作', value: '否', extra: 'dropped' },
    { key: '是否曾在本行实习', value: '是', previous: '否' }
  ]);
  assert.equal(saved.status, 'ok');
  assert.deepEqual(c.sent.map((m) => [m.messageType, m.protocolVersion, m.archiveId]), [
    ['siteAnswers.read', 5, identity.archiveId], ['siteAnswers.save', 5, identity.archiveId]
  ]);
  assert.deepEqual(c.sent[1].payload, { site: 'campus.example.com', answers: [
    { key: '是否有亲属在本公司工作', value: '否' }, { key: '是否曾在本行实习', value: '是', previous: '否' }
  ] });
});

test('a desktop that predates #429 is never sent these messages', async () => {
  const c = await client({ capabilities: ['handshake', 'resume.read', 'mail.import'] });
  assert.deepEqual(await c.siteAnswers.read('campus.example.com'), { status: 'unsupported' });
  assert.deepEqual(await c.siteAnswers.save('campus.example.com', [{ key: '是否有亲属在本公司工作', value: '否' }]), { status: 'unsupported' });
  assert.equal(c.sent.length, 0);
});

test('a shared site, an empty batch and refusals come back as a status, never as saved', async () => {
  assert.deepEqual(await (await client()).siteAnswers.read(''), { status: 'no_site' });
  assert.deepEqual(await (await client()).siteAnswers.save('campus.example.com', []), { status: 'invalid_payload' });
  for (const [code, status] of [['conflict', 'conflict'], ['secret_forbidden', 'secret'], ['invalid_payload', 'invalid_payload'],
    ['protocol_incompatible', 'unsupported'], ['restore_epoch_mismatch', 'restore_epoch_mismatch']]) {
    const c = await client({ reply: () => ({ status: 'fatal', code }) });
    assert.deepEqual(await c.siteAnswers.save('campus.example.com', [{ key: '是否有亲属在本公司工作', value: '否' }]), { status }, code);
  }
  const down = await client({ reply: () => ({ status: 'retryable', code: 'unavailable' }) });
  assert.deepEqual(await down.siteAnswers.read('campus.example.com'), { status: 'unavailable' });
  // The plugin's own validator refuses a password-looking question before anything is sent.
  const local = await client();
  assert.deepEqual(await local.siteAnswers.save('campus.example.com', [{ key: '本公司内网密码', value: '不知道' }]), { status: 'secret' });
  assert.equal(local.sent.length, 0);
});

test('only this extension\'s content script in a top frame asks, and the site is that page\'s', async () => {
  const { siteOfSender } = await import('../link/site-answers.mjs');
  const tab = { id: 7 };
  assert.equal(siteOfSender({ id: 'own', tab, frameId: 0, url: 'https://app.mokahr.com/campus-recruitment/acme/1#/apply' }, 'own'), 'app.mokahr.com/acme');
  assert.equal(siteOfSender({ id: 'own', tab, frameId: 0, url: 'https://xyz.51job.com/apply.aspx?ctmid=1' }, 'own'), '');
  for (const sender of [{}, { id: 'other', tab, frameId: 0, url: 'https://a.example.com/' }, { id: 'own', frameId: 0, url: 'chrome-extension://own/sidepanel.html' },
    { id: 'own', tab, frameId: 3, url: 'https://a.example.com/frame' }]) {
    assert.equal(siteOfSender(sender, 'own'), null);
  }
});

test('the worker answers a content script about its own page and refuses anyone else', async () => {
  const { installDesktopLink } = await import('../link/worker.mjs');
  const listeners = [];
  const api = { runtime: { id: 'own', getURL: (p) => `chrome-extension://own/${p}`, getManifest: () => ({ version: '0.5.1' }), onMessage: { addListener: (l) => listeners.push(l) } },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    alarms: { onAlarm: { addListener() {} }, clear: async () => {} } };
  installDesktopLink(api);
  const ask = (message, sender) => new Promise((resolve) => {
    let handled = false;
    for (const listener of listeners) handled = listener(message, sender, resolve) === true || handled;
    if (!handled) setTimeout(() => resolve(undefined), 0);
  });
  assert.deepEqual(await ask({ type: 'DESKTOP_SITE_ANSWERS_READ' }, { id: 'own', url: api.runtime.getURL('sidepanel.html') }), { status: 'forbidden' });
  assert.deepEqual(await ask({ type: 'DESKTOP_SITE_ANSWERS_SAVE', answers: [] }, { id: 'own', tab: { id: 1 }, frameId: 2, url: 'https://a.example.com/' }), { status: 'forbidden' });
  // A shared recruiting site is answered without asking the desktop.
  assert.deepEqual(await ask({ type: 'DESKTOP_SITE_ANSWERS_READ' }, { id: 'own', tab: { id: 1 }, frameId: 0, url: 'https://xiaoyuan.zhaopin.com/job/1' }), { status: 'no_site' });
});
