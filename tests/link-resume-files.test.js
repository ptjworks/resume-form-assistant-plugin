// #429: resume files kept on the desktop, read chunk by chunk through the service worker.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const ID = '11111111-1111-4111-8111-111111111111';
const FILE = '66666666-6666-4666-8666-666666666601';
const identity = { archiveId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', restoreEpoch: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
const CAPABILITIES = ['handshake', 'resume.read', 'resumeFiles.list', 'resumeFiles.read'];
const CHUNK = 45054;
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function pdf(size) {
  const bytes = Buffer.alloc(size);
  Buffer.from('%PDF-1.7\n').copy(bytes);
  for (let i = 9; i < size; i += 1) bytes[i] = i % 251;
  return bytes;
}

// A desktop that answers like plugin_bridge: one chunk per request, the version that was asked for.
function desktop(bytes, { patch = () => ({}), fail = () => null } = {}) {
  const sent = [];
  const reply = (message) => {
    sent.push(message);
    const failure = fail(message);
    if (failure) return { protocolVersion: 6, correlationId: message.messageId, ok: false, payload: {}, error: failure };
    if (message.messageType === 'resumeFiles.list') {
      return { protocolVersion: 6, correlationId: message.messageId, ok: true, payload: { files: [{
        fileId: FILE, kind: 'resume', name: '测试用户_简历.pdf', label: '', mime: 'application/pdf', byteSize: bytes.length,
        sha256: sha(bytes), isDefault: true, templateIds: [], updatedAt: '2026-11-03T08:00:00Z' }] } };
    }
    const index = message.payload.chunkIndex;
    const piece = bytes.subarray(index * CHUNK, (index + 1) * CHUNK);
    return { protocolVersion: 6, correlationId: message.messageId, ok: true, payload: {
      fileId: message.payload.fileId, sha256: message.payload.sha256, byteSize: bytes.length, chunkIndex: index,
      chunkCount: Math.ceil(bytes.length / CHUNK), chunkSha256: sha(piece), bytesBase64: piece.toString('base64'),
      ...patch(message, index) } };
  };
  return { sent, reply };
}

async function client(bytes, { capabilities = CAPABILITIES, send, openChannel, ...desk } = {}) {
  const { createResumeFiles } = await import('../link/resume-files.mjs');
  const { validateRequest } = await import('../link/protocol/validate.mjs');
  const fake = desktop(bytes, desk);
  const channels = [];
  const answer = async (_host, message) => {
    await validateRequest(message);
    return { response: fake.reply(message) };
  };
  const files = createResumeFiles({
    ...(send ? { send } : {}),
    session: { probe: async () => ({ mode: 'ready', identity, capabilities }) },
    store: { clientInstanceId: async () => ID },
    uuid: () => crypto.randomUUID(),
    now: () => new Date('2026-11-03T00:00:00Z'),
    sleep: async () => {},
    sendNative: answer,
    openChannel: openChannel ?? (() => {
      const channel = { closed: false, sends: 0, send: async (host, message) => { channel.sends += 1; return answer(host, message); }, close() { channel.closed = true; } };
      channels.push(channel);
      return channel;
    })
  });
  return { files, sent: fake.sent, channels };
}

test('a file is read chunk by chunk over one port, checked, and handed back whole', async () => {
  const bytes = pdf(CHUNK * 2 + 1);
  const c = await client(bytes);
  const listed = await c.files.list();
  assert.equal(listed.status, 'ok');
  assert.equal(listed.files[0].sha256, sha(bytes));
  const fetched = await c.files.fetch(listed.files[0]);
  assert.equal(fetched.status, 'ok');
  assert.equal(fetched.bytesBase64, bytes.toString('base64'));
  assert.deepEqual([fetched.name, fetched.mime, fetched.byteSize], ['测试用户_简历.pdf', 'application/pdf', bytes.length]);
  assert.deepEqual(c.sent.map((m) => [m.messageType, m.protocolVersion, m.payload.chunkIndex]),
    [['resumeFiles.list', 6, undefined], ['resumeFiles.read', 6, 0], ['resumeFiles.read', 6, 1], ['resumeFiles.read', 6, 2]]);
  assert.equal(c.channels.length, 1, 'one port for the whole file');
  assert.deepEqual([c.channels[0].sends, c.channels[0].closed], [3, true]);
});

test('a desktop that predates #429 is never asked', async () => {
  const c = await client(pdf(10), { capabilities: ['handshake', 'resume.read', 'siteAnswers.read'] });
  assert.deepEqual(await c.files.list(), { status: 'unsupported' });
  assert.deepEqual(await c.files.fetch({ fileId: FILE, sha256: sha(pdf(10)), byteSize: 10 }), { status: 'unsupported' });
  assert.equal(c.sent.length, 0);
});

test('a chunk or a file that does not match its digest is never handed on', async () => {
  const bytes = pdf(CHUNK + 50);
  const listing = { fileId: FILE, sha256: sha(bytes), byteSize: bytes.length, name: '简历.pdf', mime: 'application/pdf' };
  // The desktop sends other bytes than its chunk digest says.
  const tampered = await client(bytes, { patch: (_m, index) => (index === 1 ? { chunkSha256: 'c'.repeat(64) } : {}) });
  assert.deepEqual(await tampered.files.fetch(listing), { status: 'corrupt' });
  assert.equal(tampered.channels[0].closed, true);
  // Every chunk matches its own digest, but the file is not the one that was listed.
  const other = await client(pdf(CHUNK + 50).fill(7, 20, 30));
  assert.deepEqual(await other.files.fetch(listing), { status: 'corrupt' });
  // The desktop now has a different file under that id.
  const replaced = await client(bytes, { fail: (m) => (m.messageType === 'resumeFiles.read' ? { code: 'conflict', retryable: false, message: '换过了' } : null) });
  assert.deepEqual(await replaced.files.fetch(listing), { status: 'conflict' });
  // The desktop's copy is a different size from the listed one.
  const resized = await client(bytes, { patch: () => ({ byteSize: bytes.length + 1, chunkCount: 2 }) });
  assert.deepEqual(await resized.files.fetch(listing), { status: 'conflict' });
});

test('only the first chunk is retried; a failure later ends the read and closes the port', async () => {
  const bytes = pdf(CHUNK * 3);
  const listing = { fileId: FILE, sha256: sha(bytes), byteSize: bytes.length, name: '简历.pdf', mime: 'application/pdf' };
  let firstTries = 0;
  const c = await client(bytes, { fail: (m) => {
    if (m.payload.chunkIndex === 0 && ++firstTries === 1) return { code: 'unavailable', retryable: true, message: 'starting' };
    if (m.payload.chunkIndex === 2) return { code: 'unavailable', retryable: true, message: 'gone' };
    return null;
  } });
  assert.deepEqual(await c.files.fetch(listing), { status: 'unavailable' });
  assert.deepEqual(c.sent.map((m) => m.payload.chunkIndex), [0, 0, 1, 2], 'chunk 0 retried once, chunk 2 not retried');
  assert.equal(c.channels[0].closed, true);
  for (const bad of [null, {}, { ...listing, byteSize: 0 }, { ...listing, byteSize: 10 * 1024 * 1024 + 1 }]) {
    assert.deepEqual(await c.files.fetch(bad), { status: 'invalid_payload' });
  }
});

test('nativeChannel keeps one port for a run of requests and answers anything waiting when it closes', async () => {
  const { nativeChannel } = await import('../link/chrome.mjs');
  const posted = [];
  const listeners = { message: null, disconnect: null };
  let connects = 0;
  const api = { runtime: { lastError: null, connectNative: () => {
    connects += 1;
    return {
      onMessage: { addListener: (l) => { listeners.message = l; } },
      onDisconnect: { addListener: (l) => { listeners.disconnect = l; } },
      postMessage: (m) => { posted.push(m); setTimeout(() => listeners.message({ echo: m.n }), 0); },
      disconnect: () => {}
    };
  } } };
  const channel = nativeChannel(api)('com.resumepro.desktop');
  assert.deepEqual(await channel.send('ignored', { n: 1 }), { response: { echo: 1 } });
  assert.deepEqual(await channel.send('ignored', { n: 2 }), { response: { echo: 2 } });
  assert.equal(connects, 1);
  channel.close();
  assert.deepEqual(await channel.send('ignored', { n: 3 }), { lastError: 'closed' });
  assert.equal(posted.length, 2);
  // A host that goes away answers the request still waiting.
  const dropped = nativeChannel({ runtime: { lastError: { message: 'Native host has exited.' }, connectNative: () => ({
    onMessage: { addListener() {} }, onDisconnect: { addListener: (l) => { listeners.disconnect = l; } },
    postMessage: () => setTimeout(() => listeners.disconnect(), 0), disconnect() {} }) } })('com.resumepro.desktop');
  assert.deepEqual(await dropped.send('ignored', { n: 1 }), { lastError: 'Native host has exited.' });
});

test('reading a file writes nothing to the console and nothing to extension storage', async () => {
  const bytes = pdf(CHUNK + 10);
  const listing = { fileId: FILE, sha256: sha(bytes), byteSize: bytes.length, name: '测试用户_简历.pdf', mime: 'application/pdf' };
  const logged = [];
  const saved = console;
  const spy = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug', 'trace'].map((name) => [name, (...args) => logged.push([name, ...args])]));
  globalThis.console = { ...saved, ...spy };
  try {
    const c = await client(bytes);
    assert.equal((await c.files.fetch(listing)).status, 'ok');
    const broken = await client(bytes, { patch: () => ({ chunkSha256: 'c'.repeat(64) }) });
    assert.equal((await broken.files.fetch(listing)).status, 'corrupt');
  } finally {
    globalThis.console = saved;
  }
  assert.deepEqual(logged, []);
  // The store handed to the client has nothing but the client id: any attempt to keep the bytes
  // there would throw and turn the read above into 'unavailable'.
});

test('a chunk of the wrong length is corrupt, whether the validator or the client catches it', async () => {
  const bytes = pdf(CHUNK + 50);
  const listing = { fileId: FILE, sha256: sha(bytes), byteSize: bytes.length, name: '简历.pdf', mime: 'application/pdf' };
  // The last chunk comes back three bytes longer, with a digest that matches what was sent.
  const longer = Buffer.concat([bytes.subarray(CHUNK), Buffer.from('xyz')]);
  const padded = await client(bytes, { patch: (_m, index) => (index === 1 ? { bytesBase64: longer.toString('base64'), chunkSha256: sha(longer) } : {}) });
  assert.deepEqual(await padded.files.fetch(listing), { status: 'corrupt' });
  assert.equal(padded.channels[0].closed, true);
  // A transport that does not run the validator: the client checks the length itself before using the bytes.
  const raw = await client(bytes, { send: async (message) => ({ status: 'ok', response: { payload: {
    fileId: FILE, sha256: listing.sha256, byteSize: bytes.length, chunkIndex: message.payload.chunkIndex, chunkCount: 2,
    chunkSha256: sha(longer), bytesBase64: longer.toString('base64') } } }) });
  assert.deepEqual(await raw.files.fetch(listing), { status: 'corrupt' });
});

test('a port the browser refuses to open is unavailable, not a rejected promise', async () => {
  const bytes = pdf(100);
  const c = await client(bytes, { openChannel: () => { throw new Error('Specified native messaging host not found.'); } });
  assert.deepEqual(await c.files.fetch({ fileId: FILE, sha256: sha(bytes), byteSize: bytes.length, name: 'a.pdf', mime: 'application/pdf' }),
    { status: 'unavailable' });
});
