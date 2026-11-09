import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import {
  createWorker, dedupeKey, parseVersion, usesVersionedKey, privateDiagnosticsOf,
  PRIVATE_MAX_BYTES, LEGACY_PENDING_INDEX, KV_TTL,
} from '../src/relay.mjs';
import {
  RELEASES_UPSTREAM, RELEASES_FRESH_SECONDS, RELEASES_STALE_SECONDS, RELEASES_FAILURE_SECONDS,
  releasesCacheKey, parseReleasesQuery,
} from '../src/releases.mjs';

// 全部是测试用的假口令。
const POLL = 'poll-secret-for-tests-only';
const PRIVATE = 'private-read-secret-for-tests-only-0123456789';
const GITHUB = 'github-token-for-tests-only';
const LEGACY = JSON.parse(readFileSync(new URL('./fixtures/legacy-dedupe.json', import.meta.url), 'utf8'));
const OLD_ITEM_FIELDS = ['id', 'app', 'app_version', 'os', 'error_type', 'error_stack', 'user_description',
  'anonymous_id', 'client_ts', 'server_ts', 'reporter_ip', 'status', 'dedupe_key'];
const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const PRIVATE_ITEM_FIELDS = ['id', 'dedupe_key', 'app_version', 'server_ts', 'private_diagnostics'];

let mf, kv, edgeCache, outbound, ipCounter = 0;

before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({
    // 和 wrangler 部署时一样：入口 index.mjs 加上它引入的 relay.mjs、releases.mjs。
    modulesRoot: SRC,
    modules: ['index.mjs', 'relay.mjs', 'releases.mjs'].map(name => ({ type: 'ESModule', path: join(SRC, name) })),
    compatibilityDate: '2026-09-29',
    kvNamespaces: ['FEEDBACK_KV'],
    bindings: { POLL_SECRET: POLL, PRIVATE_READ_SECRET: PRIVATE, GITHUB_TOKEN: GITHUB },
    outboundService: request => outbound(request),
  }));
  kv = await mf.getKVNamespace('FEEDBACK_KV');
  edgeCache = (await mf.getCaches()).default;
});
beforeEach(async () => {
  outbound = () => { throw new Error('unexpected outbound request'); };
  let cursor;
  do {
    const page = await kv.list({ cursor });
    await Promise.all(page.keys.map(key => kv.delete(key.name)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  for (const kind of ['fresh', 'stale', 'failed']) {
    for (let page = 1; page <= 10; page++) await edgeCache.delete(releasesCacheKey('https://relay.test', kind, page));
  }
});
after(async () => { await mf?.dispose(); });

const nextIp = () => `2001:db8::${(++ipCounter).toString(16)}`;

function report(overrides = {}) {
  const { item } = LEGACY[0];
  return {
    app: item.app, app_version: item.app_version, os: 'Windows 10', error_type: item.error_type,
    error_stack: item.error_stack, user_description: item.user_description, anonymous_id: item.anonymous_id,
    timestamp: item.client_ts, ...overrides,
  };
}

// 经真实 Workerd 发请求。
async function send(path, { method = 'GET', body, raw, secret, privateSecret, ip = nextIp() } = {}) {
  const headers = { 'cf-connecting-ip': ip };
  if (body !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
  if (secret) headers['x-poll-secret'] = secret;
  if (privateSecret) headers['x-private-secret'] = privateSecret;
  const response = await mf.dispatchFetch('https://relay.test' + path, {
    method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 204 等没有正文 */ }
  return { status: response.status, headers: response.headers, text, data };
}

// 在 Node 里直接调 Worker（可以控制时间），KV 仍是 Miniflare 的。
function local(env = {}, start = Date.parse('2026-11-09T00:00:00.000Z')) {
  let tick = 0;
  const worker = createWorker({ now: () => new Date(start + (tick++) * 1000) });
  const fullEnv = { FEEDBACK_KV: kv, POLL_SECRET: POLL, PRIVATE_READ_SECRET: PRIVATE, ...env };
  return async (path, { method = 'GET', body, secret, privateSecret, ip = nextIp() } = {}) => {
    const headers = new Headers({ 'cf-connecting-ip': ip });
    if (body !== undefined) headers.set('content-type', 'application/json');
    if (secret) headers.set('x-poll-secret', secret);
    if (privateSecret) headers.set('x-private-secret', privateSecret);
    const response = await worker.fetch(new Request('https://relay.test' + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    }), fullEnv);
    const text = await response.text();
    return { status: response.status, text, data: text ? JSON.parse(text) : null };
  };
}

async function keys(prefix) {
  return (await kv.list({ prefix })).keys.map(key => key.name);
}

async function seedItem(id, serverTs, status = 'pending') {
  const item = { ...LEGACY[0].item, id, os: 'Windows 10', server_ts: serverTs, reporter_ip: '192.0.2.1', status, dedupe_key: LEGACY[0].expected };
  await kv.put('fb:' + id, JSON.stringify(item), { expirationTtl: KV_TTL });
  return item;
}

function uuid(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function v3Key(parts) {
  return 'v3:' + createHash('sha256').update(JSON.stringify(['v3', ...parts])).digest('hex').slice(0, 16);
}

test('health check answers on the root and on GET /feedback, OPTIONS keeps CORS', async () => {
  for (const path of ['/', '/feedback', '/anything']) {
    const response = await send(path);
    assert.equal(response.status, 200);
    assert.deepEqual(response.data, { ok: true, service: 'app-feedback-relay' });
  }
  const preflight = await send('/feedback', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'Content-Type, x-poll-secret');
});

test('empty, non-object and broken reports are rejected before anything is stored', async () => {
  assert.deepEqual((await send('/feedback', { method: 'POST', body: {} })).data, { ok: false, error: 'app required' });
  for (const body of [null, [], 42, 'text']) {
    const response = await send('/feedback', { method: 'POST', body });
    assert.equal(response.status, 400);
    assert.equal(response.data.error, 'app required');
  }
  const broken = await send('/feedback', { method: 'POST', raw: '{' });
  assert.equal(broken.status, 400);
  assert.equal(broken.data.error, 'invalid json');
  assert.ok((await keys('')).every(name => name.startsWith('throttle:')));
});

test('one IP may send 30 reports per ten minutes', async () => {
  const ip = '192.0.2.77';
  for (let i = 0; i < 30; i++) assert.equal((await send('/feedback', { method: 'POST', body: report(), ip })).status, 200);
  const blocked = await send('/feedback', { method: 'POST', body: report(), ip });
  assert.equal(blocked.status, 429);
  assert.deepEqual(blocked.data, { ok: false, error: 'too many requests' });
  assert.equal((await send('/feedback', { method: 'POST', body: report() })).status, 200);
});

test('a report is stored in the old format and shows up in /pending', async () => {
  const ip = '192.0.2.10';
  const posted = await send('/feedback', { method: 'POST', body: report(), ip });
  assert.equal(posted.status, 200);
  assert.equal(posted.data.ok, true);
  const pending = await send('/pending', { secret: POLL });
  assert.equal(pending.status, 200);
  assert.equal(pending.data.ok, true);
  assert.equal(pending.data.count, 1);
  const [item] = pending.data.items;
  assert.deepEqual(Object.keys(item), OLD_ITEM_FIELDS);
  assert.equal(item.id, posted.data.id);
  assert.equal(item.reporter_ip, ip);
  assert.equal(item.status, 'pending');
  assert.equal(item.client_ts, LEGACY[0].item.client_ts);
  assert.equal(item.dedupe_key, LEGACY[0].expected);
  assert.deepEqual(JSON.parse(await kv.get('fb:' + item.id)), item);
  assert.deepEqual(await keys('pending:'), [`pending:${item.server_ts}:${item.id}`]);
  assert.equal(await kv.get(LEGACY_PENDING_INDEX), null);
});

test('reports arriving at the same time are all kept in /pending', async () => {
  const results = await Promise.all(Array.from({ length: 50 }, (_, i) => send('/feedback', {
    method: 'POST', body: report({ anonymous_id: `anon-${i}` }),
  })));
  assert.ok(results.every(result => result.status === 200));
  const pending = await send('/pending', { secret: POLL });
  assert.equal(pending.data.count, 50);
  assert.deepEqual(new Set(pending.data.items.map(item => item.id)), new Set(results.map(result => result.data.id)));
});

test('/ack marks reports processed and removes their markers', async () => {
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await send('/feedback', { method: 'POST', body: report() })).data.id);
  const acked = await send('/ack', { method: 'POST', secret: POLL, body: { ids: [ids[0], ids[1], uuid(999)] } });
  assert.deepEqual(acked.data, { ok: true, acked: 3 });
  const pending = await send('/pending', { secret: POLL });
  assert.deepEqual(pending.data.items.map(item => item.id), [ids[2]]);
  assert.equal(JSON.parse(await kv.get('fb:' + ids[0])).status, 'processed');
  assert.equal((await keys('pending:')).length, 1);
  assert.deepEqual((await send('/ack', { method: 'POST', secret: POLL, body: {} })).data, { ok: true, acked: 0 });
  assert.deepEqual((await send('/ack', { method: 'POST', secret: POLL, body: null })).data, { ok: true, acked: 0 });
  assert.equal((await send('/ack', { method: 'POST', secret: POLL, raw: 'x' })).status, 400);
});

test('/pending returns at most 200, oldest first', async () => {
  const start = Date.parse('2026-11-01T00:00:00.000Z');
  await Promise.all(Array.from({ length: 205 }, async (_, i) => {
    const item = await seedItem(uuid(i), new Date(start + i * 1000).toISOString());
    await kv.put(`pending:${item.server_ts}:${item.id}`, '', { expirationTtl: KV_TTL });
  }));
  const pending = await send('/pending', { secret: POLL });
  assert.equal(pending.data.count, 200);
  assert.equal(pending.data.items[0].id, uuid(0));
  assert.equal(pending.data.items[199].id, uuid(199));
});

test('reports still listed in the old fb:index:pending are carried over, and the old index is retired an hour later', async () => {
  const a = await seedItem(uuid(1), '2026-11-08T01:00:00.000Z');
  await seedItem(uuid(2), '2026-11-08T02:00:00.000Z', 'processed');
  const c = await seedItem(uuid(3), '2026-11-08T03:00:00.000Z');
  await kv.put(LEGACY_PENDING_INDEX, JSON.stringify([a.id, uuid(2), c.id, uuid(4)]));
  const fresh = (await send('/feedback', { method: 'POST', body: report() })).data.id;

  const pending = await send('/pending', { secret: POLL });
  assert.deepEqual(pending.data.items.map(item => item.id), [a.id, c.id, fresh]);
  const markers = await keys('pending:');
  assert.equal(markers.length, 3);
  assert.ok(markers.includes(`pending:${a.server_ts}:${a.id}`) && markers.includes(`pending:${c.server_ts}:${c.id}`));
  // 旧索引只读不改，先留着。
  assert.deepEqual(JSON.parse(await kv.get(LEGACY_PENDING_INDEX)), [a.id, uuid(2), c.id, uuid(4)]);
  assert.ok(Number(await kv.get('meta:legacy-index-first-seen')) > 0);

  // ack 不碰旧索引；已处理的报告不会被再补标记。
  await send('/ack', { method: 'POST', secret: POLL, body: { ids: [a.id] } });
  assert.deepEqual(JSON.parse(await kv.get(LEGACY_PENDING_INDEX)), [a.id, uuid(2), c.id, uuid(4)]);
  assert.deepEqual((await send('/pending', { secret: POLL })).data.items.map(item => item.id), [c.id, fresh]);
  assert.equal((await keys('pending:')).length, 2);

  // 一小时后：补完标记再删旧索引，没处理的报告照样在。
  const later = local({}, Date.now() + 2 * 60 * 60 * 1000);
  assert.deepEqual((await later('/pending', { secret: POLL })).data.items.map(item => item.id), [c.id, fresh]);
  assert.equal(await kv.get(LEGACY_PENDING_INDEX), null);
  assert.equal(await kv.get('meta:legacy-index-first-seen'), null);
  assert.deepEqual((await send('/pending', { secret: POLL })).data.items.map(item => item.id), [c.id, fresh]);
});

test('an id an old instance adds to the old index during the switch-over is not lost', async () => {
  const a = await seedItem(uuid(1), '2026-11-08T01:00:00.000Z');
  await kv.put(LEGACY_PENDING_INDEX, JSON.stringify([a.id]));
  assert.deepEqual((await send('/pending', { secret: POLL })).data.items.map(item => item.id), [a.id]);
  // 旧实例在新代码读过旧索引之后写回：加上自己刚收的报告。
  const late = await seedItem(uuid(2), '2026-11-09T00:00:00.000Z');
  await kv.put(LEGACY_PENDING_INDEX, JSON.stringify([a.id, late.id]));
  assert.deepEqual((await send('/pending', { secret: POLL })).data.items.map(item => item.id), [a.id, late.id]);
  assert.ok((await keys('pending:')).includes(`pending:${late.server_ts}:${late.id}`));
});

test('acking a report that is only in the old index stops it from coming back', async () => {
  const a = await seedItem(uuid(1), '2026-11-08T01:00:00.000Z');
  const c = await seedItem(uuid(3), '2026-11-08T03:00:00.000Z');
  await kv.put(LEGACY_PENDING_INDEX, JSON.stringify([a.id, c.id]));
  await send('/ack', { method: 'POST', secret: POLL, body: { ids: [a.id] } });
  assert.equal(JSON.parse(await kv.get('fb:' + a.id)).status, 'processed');
  assert.deepEqual((await send('/pending', { secret: POLL })).data.items.map(item => item.id), [c.id]);
  await send('/ack', { method: 'POST', secret: POLL, body: { ids: [c.id] } });
  assert.equal((await send('/pending', { secret: POLL })).data.count, 0);
  assert.deepEqual(await keys('pending:'), []);
});

test('markers of processed or long-gone reports are cleaned up; a marker whose report is not readable yet stays', async () => {
  const done = await seedItem(uuid(1), '2026-11-08T01:00:00.000Z', 'processed');
  await kv.put(`pending:${done.server_ts}:${done.id}`, '', { expirationTtl: KV_TTL });
  const expired = `pending:2026-08-01T00:00:00.000Z:${uuid(2)}`;
  const fresh = `pending:${new Date(Date.now() - 60_000).toISOString()}:${uuid(3)}`;
  await kv.put(expired, '', { expirationTtl: KV_TTL });
  await kv.put(fresh, '', { expirationTtl: KV_TTL });
  const pending = await send('/pending', { secret: POLL });
  assert.equal(pending.data.count, 0);
  assert.deepEqual(await keys('pending:'), [fresh]);

  // 同一个标记，在本地按「一小时后」再看一次就会删掉。
  const later = local({}, Date.now() + 2 * 60 * 60 * 1000);
  assert.equal((await later('/pending', { secret: POLL })).data.count, 0);
  assert.deepEqual(await keys('pending:'), []);
});

test('dedupe keys of 0.5.0 and older reports match the code that ran before the repo', async () => {
  for (const { name, item, expected } of LEGACY) {
    assert.equal(await dedupeKey(item), expected, name);
  }
  for (const { name, item, expected } of LEGACY) {
    const body = { app: item.app, app_version: item.app_version, os: 'Windows 10', error_type: item.error_type,
      error_stack: item.error_stack, user_description: item.user_description, anonymous_id: item.anonymous_id, timestamp: item.client_ts };
    const { id } = (await send('/feedback', { method: 'POST', body })).data;
    assert.equal(JSON.parse(await kv.get('fb:' + id)).dedupe_key, expected, name);
  }
  // 规则本身：v2 是对 ["v2", ...字段] 取 SHA-256 的前 8 字节。
  const parts = ['resume-form-assistant-plugin', 'fill_failed', 'example.com.cn', 'dropdown_no_option', 'select', 'http_5xx'];
  assert.equal('v2:' + createHash('sha256').update(JSON.stringify(['v2', ...parts])).digest('hex').slice(0, 16), LEGACY[0].expected);
});

test('versions above 0.5.0 get a v3 key that adds the full version', async () => {
  const parts = ['resume-form-assistant-plugin', 'fill_failed', 'example.com.cn', 'dropdown_no_option', 'select', 'http_5xx'];
  const item = version => ({ ...LEGACY[0].item, app_version: version, user_description: LEGACY[0].item.user_description.replace('0.4.4', version) });
  assert.equal(await dedupeKey(item('0.5.1')), v3Key([...parts, '0.5.1']));
  assert.equal(await dedupeKey(item('0.6.0')), v3Key([...parts, '0.6.0']));
  assert.equal(await dedupeKey(item('0.5.1-beta.1')), v3Key([...parts, '0.5.1-beta.1']));
  assert.notEqual(await dedupeKey(item('0.5.1')), await dedupeKey(item('0.5.2')));
  assert.equal(await dedupeKey(item('0.5.0')), LEGACY[0].expected);
  assert.equal(await dedupeKey(item('0.5.0-beta.1')), LEGACY[0].expected);
  const exception = LEGACY.find(entry => entry.name.startsWith('exception')).item;
  assert.equal(await dedupeKey({ ...exception, app_version: '0.7.0' }),
    v3Key([exception.app, exception.error_type, '0.7.0', exception.error_stack, '0.7.0']));

  for (const [version, versioned] of [
    ['0.5.0', false], ['0.4.10', false], ['0.4.4', false], ['0.5.0-beta.1', false], ['0.5.0+build', false],
    ['0.5.1', true], ['0.10.0', true], ['1.0.0', true], ['v0.6.0', true], ['0.5.1-beta.1', true],
    ['', false], ['dev', false], ['0.5', false], [undefined, false],
  ]) assert.equal(usesVersionedKey(version), versioned, String(version));
  assert.deepEqual(parseVersion('12.3.4-rc.1'), [12, 3, 4]);
  assert.equal(parseVersion('x1.2.3'), null);
});

test('private diagnostics are kept apart and never appear in /pending, /export or the report', async () => {
  const marker = '--- 私有诊断 v1 ---\n[字段]\nlabel: 政治面貌 PRIVATE-MARKER';
  const posted = await send('/feedback', { method: 'POST', body: report({ private_diagnostics: marker }) });
  const { id } = posted.data;
  assert.deepEqual(Object.keys(posted.data), ['ok', 'id']);
  for (const path of ['/pending', '/export']) {
    const response = await send(path, { secret: POLL });
    assert.equal(response.data.count, 1);
    assert.equal(response.text.includes('PRIVATE-MARKER'), false, path);
    assert.equal(response.text.includes('private_diagnostics'), false, path);
  }
  assert.equal((await kv.get('fb:' + id)).includes('PRIVATE-MARKER'), false);

  const read = await send(`/private?id=${id}`, { privateSecret: PRIVATE });
  assert.equal(read.status, 200);
  assert.equal(read.data.ok, true);
  assert.equal(read.data.items.length, 1);
  assert.deepEqual(Object.keys(read.data.items[0]), PRIVATE_ITEM_FIELDS);
  const stored = JSON.parse(await kv.get('fb:' + id));
  assert.deepEqual(read.data.items[0], {
    id, dedupe_key: stored.dedupe_key, app_version: '0.4.4', server_ts: stored.server_ts, private_diagnostics: marker,
  });
  assert.equal((await keys(`privdk:${stored.dedupe_key}:`)).length, 1);
});

test('private diagnostics over 16384 UTF-8 bytes are cut on a character boundary', async () => {
  const byteLength = text => new TextEncoder().encode(text).length;
  assert.equal(PRIVATE_MAX_BYTES, 16384);
  const ascii = 'a'.repeat(20000);
  assert.equal(privateDiagnosticsOf(ascii), ascii.slice(0, 16384));
  const exact = 'b'.repeat(16384);
  assert.equal(privateDiagnosticsOf(exact), exact);
  const han = privateDiagnosticsOf('汉'.repeat(6000));
  assert.equal(byteLength(han), 16383);
  assert.equal(han, '汉'.repeat(5461));
  const emoji = privateDiagnosticsOf('a' + '😀'.repeat(5000));
  assert.equal(byteLength(emoji), 16381);
  assert.equal(emoji.includes('�'), false);
  for (const value of [undefined, null, '', 42, { text: 'x' }, ['x']]) assert.equal(privateDiagnosticsOf(value), '');

  const long = (await send('/feedback', { method: 'POST', body: report({ private_diagnostics: '汉'.repeat(6000) }) })).data.id;
  const read = await send(`/private?id=${long}`, { privateSecret: PRIVATE });
  assert.equal(read.data.items[0].private_diagnostics, han);

  const none = (await send('/feedback', { method: 'POST', body: report({ private_diagnostics: { nested: true } }) })).data.id;
  assert.deepEqual((await send(`/private?id=${none}`, { privateSecret: PRIVATE })).data, { ok: true, items: [] });
  assert.equal(await kv.get('priv:' + none), null);
});

test('/private only opens with its own secret', async () => {
  const id = (await send('/feedback', { method: 'POST', body: report({ private_diagnostics: 'x' }) })).data.id;
  const path = `/private?id=${id}`;
  for (const options of [{}, { privateSecret: POLL }, { secret: POLL }, { secret: PRIVATE }, { privateSecret: PRIVATE + 'x' }]) {
    const response = await send(path, options);
    assert.equal(response.status, 401, JSON.stringify(Object.keys(options)));
    assert.deepEqual(response.data, { ok: false, error: 'unauthorized' });
  }
  assert.equal((await send(path, { privateSecret: PRIVATE })).status, 200);
  assert.equal((await send(path, { method: 'POST', privateSecret: PRIVATE })).status, 404);
  assert.equal((await send(path, { method: 'POST' })).status, 401);
  // 口令放在网址里不算数。
  assert.equal((await send(`${path}&secret=${PRIVATE}`)).status, 401);

  const notSet = local({ PRIVATE_READ_SECRET: undefined });
  assert.equal((await notSet(path, { privateSecret: 'anything' })).status, 401);
  const sameAsPoll = local({ PRIVATE_READ_SECRET: 'p'.repeat(40), POLL_SECRET: 'p'.repeat(40) });
  assert.equal((await sameAsPoll(path, { privateSecret: 'p'.repeat(40) })).status, 401);
  const tooShort = local({ PRIVATE_READ_SECRET: 'short-secret' });
  assert.equal((await tooShort(path, { privateSecret: 'short-secret' })).status, 401);
});

test('/private by dedupe key returns the newest first, 5 by default and at most 20', async () => {
  const call = local();
  const body = report({ app_version: '0.5.1' });
  const ids = [];
  for (let i = 1; i <= 22; i++) {
    const posted = await call('/feedback', { method: 'POST', body: { ...body, private_diagnostics: `#${i}` } });
    ids.push(posted.data.id);
  }
  await call('/feedback', { method: 'POST', body });
  await call('/feedback', { method: 'POST', body: report({ app_version: '0.5.2', private_diagnostics: 'other version' }) });
  const key = JSON.parse(await kv.get('fb:' + ids[0])).dedupe_key;
  assert.match(key, /^v3:[0-9a-f]{16}$/);

  const byKey = async query => call(`/private?${query}`, { privateSecret: PRIVATE });
  const first = await byKey(`dedupe_key=${key}`);
  assert.equal(first.status, 200);
  assert.deepEqual(first.data.items.map(item => item.private_diagnostics), ['#22', '#21', '#20', '#19', '#18']);
  assert.ok(first.data.items.every(item => item.dedupe_key === key && item.app_version === '0.5.1'));
  const twenty = await byKey(`dedupe_key=${encodeURIComponent(key)}&limit=20`);
  assert.equal(twenty.data.items.length, 20);
  assert.equal(twenty.data.items[19].private_diagnostics, '#3');
  assert.deepEqual((await byKey(`dedupe_key=${key}&limit=1`)).data.items.map(item => item.id), [ids[21]]);
  assert.deepEqual((await byKey('dedupe_key=v3:0000000000000000')).data, { ok: true, items: [] });

  for (const query of [`dedupe_key=${key}&limit=0`, `dedupe_key=${key}&limit=21`, `dedupe_key=${key}&limit=abc`,
    `dedupe_key=${key}&limit=-1`, `dedupe_key=${key}&limit=`, '', `id=${ids[0]}&dedupe_key=${key}`,
    'dedupe_key=v3', 'dedupe_key=v3:', `dedupe_key=${key.slice(0, 10)}`, 'id=not-an-id']) {
    assert.equal((await byKey(query)).status, 400, query);
  }
});

test('/export lists every report oldest first, without the old index or the private layer', async () => {
  const call = local();
  const first = (await call('/feedback', { method: 'POST', body: report({ private_diagnostics: 'secret detail' }) })).data.id;
  const second = (await call('/feedback', { method: 'POST', body: report({ error_type: 'manual' }) })).data.id;
  await kv.put(LEGACY_PENDING_INDEX, JSON.stringify([]));
  const exported = await send('/export', { secret: POLL });
  assert.deepEqual(exported.data.items.map(item => item.id), [first, second]);
  assert.equal(exported.data.count, 2);
  assert.ok(exported.data.items.every(item => Object.keys(item).join() === OLD_ITEM_FIELDS.join()));
  assert.equal(exported.text.includes('secret detail'), false);
});

test('poll endpoints still need x-poll-secret and keep their 404 for other methods', async () => {
  for (const path of ['/pending', '/export', '/ack', '/create-issue']) {
    assert.equal((await send(path)).status, 401, path);
    assert.equal((await send(path, { secret: 'wrong' })).status, 401, path);
    assert.equal((await send(path, { privateSecret: PRIVATE })).status, 401, path);
    assert.equal((await send(`${path}?secret=${POLL}`)).status, 401, path);
  }
  assert.deepEqual((await send('/ack', { secret: POLL })).data, { ok: false, error: 'not found' });
  assert.equal((await send('/pending', { method: 'POST', secret: POLL, body: {} })).status, 404);
  assert.equal((await local({ POLL_SECRET: undefined })('/pending', { secret: 'anything' })).status, 401);
});

test('/create-issue keeps its request and response format', async () => {
  const calls = [];
  outbound = async request => {
    calls.push({ url: request.url, method: request.method, auth: request.headers.get('authorization'), agent: request.headers.get('user-agent'), body: await request.json() });
    return calls.length === 1
      ? Response.json({ message: 'Validation Failed' }, { status: 422 })
      : Response.json({ html_url: 'https://github.com/owner/repo/issues/7', number: 7 }, { status: 201 });
  };
  const created = await send('/create-issue', { method: 'POST', secret: POLL, body: { repo: 'owner/repo', title: 'T', body: 'B', labels: ['bug', 7, ''] } });
  assert.deepEqual(created.data, { ok: true, issue_url: 'https://github.com/owner/repo/issues/7', issue_number: 7 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.github.com/repos/owner/repo/issues');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].auth, `Bearer ${GITHUB}`);
  assert.equal(calls[0].agent, 'app-feedback-relay');
  assert.deepEqual(calls[0].body, { title: 'T', body: 'B', labels: ['bug'] });
  assert.deepEqual(calls[1].body, { title: 'T', body: 'B', labels: [] });

  outbound = async () => Response.json({ message: 'Bad credentials' }, { status: 401 });
  const failed = await send('/create-issue', { method: 'POST', secret: POLL, body: { repo: 'owner/repo', title: 'T' } });
  assert.equal(failed.status, 502);
  assert.deepEqual(failed.data, { ok: false, error: 'github_error', detail: '{"message":"Bad credentials"}' });

  assert.equal((await send('/create-issue', { method: 'POST', secret: POLL, body: { repo: 'owner/repo' } })).data.error, 'repo and title required');
  assert.equal((await send('/create-issue', { method: 'POST', secret: POLL, body: { repo: 'no-slash', title: 'T' } })).data.error, 'invalid repo');
  const noToken = await local({ GITHUB_TOKEN: undefined })('/create-issue', { method: 'POST', secret: POLL, body: { repo: 'owner/repo', title: 'T' } });
  assert.equal(noToken.status, 500);
  assert.deepEqual(noToken.data, { ok: false, error: 'github_not_configured' });
});

// 包一层 Miniflare 的 KV，让指定前缀的写入失败。
function failingKv(prefix) {
  return {
    get: (...args) => kv.get(...args),
    list: (...args) => kv.list(...args),
    delete: (...args) => kv.delete(...args),
    put: (key, ...rest) => key.startsWith(prefix) ? Promise.reject(new Error('KV write failed')) : kv.put(key, ...rest),
  };
}

test('a failed private-layer write still lets the report through to /pending', async () => {
  const call = local({ FEEDBACK_KV: failingKv('priv') });
  const warn = console.warn;
  const warnings = [];
  console.warn = message => warnings.push(message);
  let posted;
  try {
    posted = await call('/feedback', { method: 'POST', body: report({ private_diagnostics: 'PRIVATE-MARKER' }) });
  } finally { console.warn = warn; }
  assert.equal(posted.status, 200);
  assert.deepEqual(warnings, [`private_diagnostics not stored for ${posted.data.id}`]);
  const pending = await send('/pending', { secret: POLL });
  assert.deepEqual(pending.data.items.map(item => item.id), [posted.data.id]);
  assert.equal(await kv.get('priv:' + posted.data.id), null);
});

test('a failed report write leaves no report Muse cannot see, and its marker is cleaned up later', async () => {
  const call = local({ FEEDBACK_KV: failingKv('fb:') });
  await assert.rejects(call('/feedback', { method: 'POST', body: report() }), /KV write failed/);
  assert.deepEqual(await keys('fb:'), []);
  assert.equal((await keys('pending:')).length, 1);
  const later = local({}, Date.now() + 2 * 60 * 60 * 1000);
  assert.equal((await later('/pending', { secret: POLL })).data.count, 0);
  assert.deepEqual(await keys('pending:'), []);
});

test('a broken throttle counter starts over instead of failing the report', async () => {
  const ip = '192.0.2.99';
  for (const value of ['not json', 'null', '{"count":"x"}']) {
    await kv.put('throttle:' + ip, value, { expirationTtl: 600 });
    assert.equal((await send('/feedback', { method: 'POST', body: report(), ip })).status, 200, value);
    assert.deepEqual(JSON.parse(await kv.get('throttle:' + ip)).count, 1);
  }
});

test('an old-index report without server_ts is still carried over and can be acked', async () => {
  const item = await seedItem(uuid(5), undefined);
  delete item.server_ts;
  await kv.put('fb:' + item.id, JSON.stringify(item), { expirationTtl: KV_TTL });
  await kv.put(LEGACY_PENDING_INDEX, JSON.stringify([item.id, 7, null]));
  assert.deepEqual((await send('/pending', { secret: POLL })).data.items.map(entry => entry.id), [item.id]);
  assert.deepEqual(await keys('pending:'), [`pending:0000-00-00T00:00:00.000Z:${item.id}`]);
  await send('/ack', { method: 'POST', secret: POLL, body: { ids: [item.id] } });
  assert.deepEqual(await keys('pending:'), []);
  assert.equal((await send('/pending', { secret: POLL })).data.count, 0);
  assert.deepEqual(await keys('pending:'), []);
});

test('the private record is written after its dedupe-key index entry', async () => {
  const call = local({ FEEDBACK_KV: failingKv('priv:') });
  const warn = console.warn;
  console.warn = () => {};
  let posted;
  try {
    posted = await call('/feedback', { method: 'POST', body: report({ private_diagnostics: 'x' }) });
  } finally { console.warn = warn; }
  assert.equal(posted.status, 200);
  const key = JSON.parse(await kv.get('fb:' + posted.data.id)).dedupe_key;
  // 索引在、内容没写进去：按去重键查时跳过，不报错。
  assert.equal((await keys(`privdk:${key}:`)).length, 1);
  assert.deepEqual((await send(`/private?dedupe_key=${key}`, { privateSecret: PRIVATE })).data, { ok: true, items: [] });
});

test('/ack keeps the original 90-day expiry of a report instead of renewing it', async () => {
  const received = Date.now();
  const id = (await local({}, received)('/feedback', { method: 'POST', body: report() })).data.id;
  await local({}, received + 10 * 24 * 3600 * 1000)('/ack', { method: 'POST', secret: POLL, body: { ids: [id] } });
  assert.equal(JSON.parse(await kv.get('fb:' + id)).status, 'processed');
  const [entry] = (await kv.list({ prefix: 'fb:' + id })).keys;
  assert.equal(entry.expiration, Math.floor(received / 1000) + KV_TTL);
});

// ---- /releases ----

const RELEASE_FIELDS = ['tag_name', 'draft', 'prerelease', 'html_url'];
const RELEASES = '/releases?per_page=100&page=1';
const cacheKey = (kind, page = 1) => releasesCacheKey('https://relay.test', kind, page);

// GitHub 返回的样子：字段比桌面用到的多得多。
function githubRelease(i, overrides = {}) {
  const tag = i % 3 === 0 ? `desktop-v0.${i}.0` : `v0.${i}.0`;
  return {
    url: `https://api.github.com/repos/ptjworks/resume-form-assistant-plugin/releases/${1000 + i}`,
    id: 1000 + i,
    author: { login: 'someone', id: 1 },
    tag_name: tag,
    name: tag,
    draft: false,
    prerelease: i % 5 === 4,
    html_url: `https://github.com/ptjworks/resume-form-assistant-plugin/releases/tag/${tag}`,
    assets: [{ name: 'setup.exe', browser_download_url: 'https://github.com/x/setup.exe' }],
    body: 'release notes',
    ...overrides,
  };
}

function trimmed(item) {
  return { tag_name: item.tag_name, draft: item.draft, prerelease: item.prerelease, html_url: item.html_url };
}

// 假的 GitHub：按 per_page、page 分页返回 all，记下每次请求。
function fakeGitHub(all) {
  const calls = [];
  outbound = request => {
    const url = new URL(request.url);
    const perPage = Number(url.searchParams.get('per_page'));
    const page = Number(url.searchParams.get('page'));
    calls.push({
      url: request.url, page, auth: request.headers.get('authorization'),
      agent: request.headers.get('user-agent'), accept: request.headers.get('accept'),
    });
    return Response.json(all.slice((page - 1) * perPage, page * perPage));
  };
  return calls;
}

test('/releases returns the GitHub list with only the four fields the desktop reads, and hides drafts', async () => {
  const all = Array.from({ length: 150 }, (_, i) => githubRelease(i));
  all[0] = githubRelease(0, {
    tag_name: 'desktop-v9.9.9', name: 'UNPUBLISHED', draft: true,
    html_url: 'https://github.com/ptjworks/resume-form-assistant-plugin/releases/tag/untagged-UNPUBLISHED',
  });
  const calls = fakeGitHub(all);
  const response = await send(RELEASES);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('x-relay-cache'), 'miss');
  assert.equal(response.data.length, 100);
  assert.ok(response.data.every(item => Object.keys(item).join() === RELEASE_FIELDS.join()));
  assert.deepEqual(response.data[0], { tag_name: null, draft: true, prerelease: false, html_url: null });
  assert.equal(response.text.includes('9.9.9') || response.text.includes('UNPUBLISHED'), false);
  assert.deepEqual(response.data.slice(1), all.slice(1, 100).map(trimmed));
  assert.deepEqual(calls, [{
    url: `${RELEASES_UPSTREAM}?per_page=100&page=1`, page: 1, auth: `Bearer ${GITHUB}`,
    agent: 'app-feedback-relay', accept: 'application/vnd.github+json',
  }]);
  assert.equal(RELEASES_UPSTREAM, 'https://api.github.com/repositories/1217054301/releases');

  // 其余页照 GitHub 的分页；超过最后一页是空列表。
  assert.deepEqual((await send('/releases?page=2&per_page=100')).data, all.slice(100, 150).map(trimmed));
  assert.deepEqual((await send('/releases?per_page=100&page=10')).data, []);
  assert.deepEqual(calls.slice(1).map(call => call.url), [
    `${RELEASES_UPSTREAM}?per_page=100&page=2`, `${RELEASES_UPSTREAM}?per_page=100&page=10`,
  ]);
});

test('/releases answers from the edge cache for ten minutes and keeps the last good list for a day', async () => {
  const all = Array.from({ length: 25 }, (_, i) => githubRelease(i));
  const calls = fakeGitHub(all);
  assert.equal((await send(RELEASES)).headers.get('x-relay-cache'), 'miss');
  const again = await send(RELEASES);
  assert.equal(again.headers.get('x-relay-cache'), 'hit');
  assert.deepEqual(again.data, all.map(trimmed));
  assert.equal(calls.length, 1);
  for (const [kind, seconds] of [['fresh', RELEASES_FRESH_SECONDS], ['stale', RELEASES_STALE_SECONDS]]) {
    const stored = await edgeCache.match(cacheKey(kind));
    assert.equal(stored.headers.get('cache-control'), `max-age=${seconds}`, kind);
    // 缓存里也只有四个字段。
    assert.ok((await stored.json()).every(item => Object.keys(item).join() === RELEASE_FIELDS.join()), kind);
  }
  assert.equal(await edgeCache.match(cacheKey('failed')), undefined);
  assert.deepEqual([RELEASES_FRESH_SECONDS, RELEASES_STALE_SECONDS, RELEASES_FAILURE_SECONDS], [600, 86400, 60]);
});

test('/releases accepts only per_page=100 and page 1-10', async () => {
  const calls = fakeGitHub([]);
  for (const query of ['', 'per_page=100', 'page=1', 'per_page=30&page=1', 'per_page=1&page=1', 'per_page=99&page=1',
    'per_page=0100&page=1', 'per_page=100&page=0', 'per_page=100&page=11', 'per_page=100&page=01', 'per_page=100&page=abc',
    'per_page=100&page=-1', 'per_page=100&page=1.5', 'per_page=100&page=', 'per_page=100&page=%201', 'per_page=100&page=1e1',
    'per_page=100&page=1&page=2', 'per_page=100&per_page=100', 'per_page=100&page=1&token=x',
    'toString=1&page=1', '__proto__=1&per_page=100']) {
    const response = await send(`/releases?${query}`);
    assert.equal(response.status, 400, query);
    assert.deepEqual(response.data, { ok: false, error: 'only per_page=100 and page=1-10 are accepted' }, query);
  }
  assert.equal(calls.length, 0);
  assert.equal(parseReleasesQuery(new URLSearchParams('per_page=100&page=10')), 10);
  assert.equal(parseReleasesQuery(new URLSearchParams('page=3&per_page=100')), 3);
  assert.equal((await send(RELEASES, { method: 'POST', body: {} })).status, 404);
  assert.equal(calls.length, 0);
});

test('/releases passes GitHub failures on and does not ask GitHub again for a minute', async () => {
  const cases = [
    [() => new Response('oops', { status: 500 }), 502, { ok: false, error: 'github_error', status: 500 }],
    [() => new Response('{}', { status: 404 }), 502, { ok: false, error: 'github_error', status: 404 }],
    [() => Response.json({ message: 'API rate limit exceeded' }, { status: 403 }), 503,
      { ok: false, error: 'github_rate_limited', status: 403 }],
    [() => new Response('', { status: 429 }), 503, { ok: false, error: 'github_rate_limited', status: 429 }],
    [() => new Response('<html>not json</html>', { status: 200 }), 502, { ok: false, error: 'github_bad_response' }],
    [() => Response.json({ message: 'Not Found' }), 502, { ok: false, error: 'github_bad_response' }],
  ];
  for (const [answer, status, data] of cases) {
    for (const kind of ['fresh', 'stale', 'failed']) await edgeCache.delete(cacheKey(kind));
    let asked = 0;
    outbound = request => { asked++; return answer(request); };
    const first = await send(RELEASES);
    assert.equal(first.status, status, JSON.stringify(data));
    assert.deepEqual(first.data, data);
    assert.equal(first.headers.get('x-relay-cache'), 'miss');
    // 一分钟内同样的答复，不再问 GitHub。
    const second = await send(RELEASES);
    assert.equal(second.status, status, JSON.stringify(data));
    assert.deepEqual(second.data, data);
    assert.equal(second.headers.get('x-relay-cache'), 'hit');
    assert.equal(asked, 1, JSON.stringify(data));
    const marker = await edgeCache.match(cacheKey('failed'));
    assert.equal(marker.headers.get('cache-control'), `max-age=${RELEASES_FAILURE_SECONDS}`);
    // 失败不进 10 分钟的新鲜结果，也不顶替上次成功的结果。
    assert.equal(await edgeCache.match(cacheKey('fresh')), undefined);
    assert.equal(await edgeCache.match(cacheKey('stale')), undefined);
  }
  // 失败标记过期后（这里直接删掉）GitHub 好了，就照常返回。
  await edgeCache.delete(cacheKey('failed'));
  const all = [githubRelease(3)];
  fakeGitHub(all);
  const recovered = await send(RELEASES);
  assert.deepEqual(recovered.data, all.map(trimmed));
  assert.equal(recovered.headers.get('x-relay-cache'), 'miss');

  // 连不上（Workerd 会把 outboundService 抛的错变成 500，这里在 Node 里换掉全局 fetch）。
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('network down'); };
  try {
    const unreachable = await local()(RELEASES);
    assert.equal(unreachable.status, 502);
    assert.deepEqual(unreachable.data, { ok: false, error: 'github_unreachable' });
    // 响应头到了、正文读到一半断开，也算连不上，不算返回的东西不对。
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('[{"tag_name":'));
        controller.error(new TypeError('connection reset'));
      },
    }), { status: 200 });
    const cut = await local()(RELEASES);
    assert.equal(cut.status, 502);
    assert.deepEqual(cut.data, { ok: false, error: 'github_unreachable' });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('/releases falls back to the last good list while GitHub is failing', async () => {
  const before = [githubRelease(3), githubRelease(4)];
  fakeGitHub(before);
  assert.equal((await send(RELEASES)).headers.get('x-relay-cache'), 'miss');
  // 十分钟过去（新鲜结果过期，这里直接删掉），GitHub 出错。
  await edgeCache.delete(cacheKey('fresh'));
  let asked = 0;
  outbound = () => { asked++; return new Response('', { status: 503 }); };
  const stale = await send(RELEASES);
  assert.equal(stale.status, 200);
  assert.equal(stale.headers.get('x-relay-cache'), 'stale');
  assert.deepEqual(stale.data, before.map(trimmed));
  // 一分钟内照样用上次的结果，不再问 GitHub。
  const again = await send(RELEASES);
  assert.equal(again.headers.get('x-relay-cache'), 'stale');
  assert.deepEqual(again.data, before.map(trimmed));
  assert.equal(asked, 1);

  // 失败标记过期后 GitHub 好了：新结果同时替换新鲜结果和上次成功的结果。
  await edgeCache.delete(cacheKey('failed'));
  const after = [githubRelease(6), ...before];
  fakeGitHub(after);
  const fresh = await send(RELEASES);
  assert.equal(fresh.headers.get('x-relay-cache'), 'miss');
  assert.deepEqual(fresh.data, after.map(trimmed));
  assert.deepEqual(await (await edgeCache.match(cacheKey('stale'))).json(), after.map(trimmed));
});

test('/releases prefers its own token, retries without it when GitHub rejects it, and asks anonymously when none is set', async () => {
  const all = [githubRelease(3), githubRelease(4)];
  const auths = [];
  outbound = request => {
    const auth = request.headers.get('authorization');
    auths.push(auth);
    return auth ? Response.json({ message: 'Bad credentials' }, { status: 401 }) : Response.json(all);
  };
  const response = await send(RELEASES);
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, all.map(trimmed));
  assert.deepEqual(auths, [`Bearer ${GITHUB}`, null]);

  // 没配口令：直接匿名问。这里在 Node 里跑，换掉全局 fetch 记下请求。
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
    return Response.json(all);
  };
  try {
    const anonymous = await local({ GITHUB_TOKEN: undefined })(RELEASES);
    assert.equal(anonymous.status, 200);
    assert.deepEqual(anonymous.data, all.map(trimmed));
    // 配了 /releases 专用的口令就用它，不用 Muse 的 GITHUB_TOKEN。
    const dedicated = await local({ GITHUB_TOKEN: GITHUB, RELEASES_GITHUB_TOKEN: 'releases-token-for-tests-only' })(RELEASES);
    assert.equal(dedicated.status, 200);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(seen, [
    { url: `${RELEASES_UPSTREAM}?per_page=100&page=1`, auth: null },
    { url: `${RELEASES_UPSTREAM}?per_page=100&page=1`, auth: 'Bearer releases-token-for-tests-only' },
  ]);
});
