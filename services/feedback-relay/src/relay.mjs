// 网申快填的反馈中转（Cloudflare Worker app-feedback-relay）。
//
// 插件和桌面端把错误报告 POST 到 /feedback；Muse 用 x-poll-secret 拉 /pending、/ack、
// /create-issue，统计用 /export。这四个接口的请求和返回格式 Muse 在用，不能改。
// 私有层（private_diagnostics）单独存，只能用 x-private-secret 从 /private 读。
// 0.5.0 以下的自动报告只存不进待处理（状态 skipped），Muse 不再为它们开 issue。
// 桌面检查更新的备用来源 /releases 代查 GitHub 的发布列表，见 releases.mjs，不碰 KV。
//
// KV 里的键：
//   fb:<id>                                  报告本身（公开层），90 天
//   pending:<server_ts>:<id>                 待处理标记，/ack 时删除，90 天
//   priv:<id>                                私有层，90 天
//   privdk:<dedupe_key>:<倒序时间>:<id>      按去重键查私有层的索引，90 天
//   fb:index:pending                         旧的待处理索引，只读出来补标记，不再写入
//   meta:legacy-index-first-seen             第一次看到旧索引的时间，一小时后删旧索引
//   throttle:<ip>                            每个 IP 10 分钟 30 条，10 分钟过期
import { releases } from './releases.mjs';

export const KV_TTL = 90 * 24 * 3600;
export const LEGACY_PENDING_INDEX = 'fb:index:pending';
export const PENDING_PREFIX = 'pending:';
export const PRIVATE_PREFIX = 'priv:';
export const PRIVATE_INDEX_PREFIX = 'privdk:';
export const PRIVATE_MAX_BYTES = 16384;
export const PENDING_PAGE = 200;
const LEGACY_MIGRATE_BATCH = 200;
const LEGACY_SEEN_KEY = 'meta:legacy-index-first-seen';
// 部署后旧实例最多再活几分钟；第一次看到旧索引一小时后，就不会再有人往里写了。
const LEGACY_RETIRE_AFTER_MS = 60 * 60 * 1000;
const ACK_BATCH = 200;
const PRIVATE_DEFAULT_LIMIT = 5;
const PRIVATE_MAX_LIMIT = 20;
const MIN_PRIVATE_SECRET_LENGTH = 32;
// 13 位毫秒数的最大值。私有层索引用它减去 server_ts，KV 按键名升序列出时就是从新到旧。
const MAX_EPOCH_MS = 9999999999999;
const NO_SERVER_TS = '0000-00-00T00:00:00.000Z';
const MISSING_REPORT_GRACE_MS = 60 * 60 * 1000;
const THROTTLE_WINDOW_MS = 10 * 60 * 1000;
const THROTTLE_LIMIT = 30;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEDUPE_KEY_PATTERN = /^v\d{1,3}:[0-9a-f]{16}$/;
const POLL_PATHS = new Set(['/pending', '/ack', '/create-issue', '/export']);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-poll-secret',
};
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders, ...headers },
  });
}

function str(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

// 请求体不是 JSON 对象（null、数组、数字）时按空对象处理，不让读字段抛异常变成 500。
async function readBody(request) {
  const body = await request.json();
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
}

async function readJson(kv, key) {
  const raw = await kv.get(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---- 去重键 ----

const MULTI_PART_SUFFIXES = new Set([
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'com.hk', 'edu.hk', 'org.hk', 'gov.hk',
  'com.tw', 'edu.tw', 'org.tw',
  'com.sg', 'edu.sg',
  'co.jp', 'ac.jp',
  'co.uk', 'ac.uk',
  'com.au', 'edu.au',
  'github.io', 'gitee.io', 'pages.dev', 'workers.dev', 'vercel.app', 'netlify.app',
]);

// 只取可注册的主域名（school.example.com.cn → example.com.cn），同一学校不同子站算一处。
export function siteOf(host) {
  const h = String(host || '').toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(h) || /^[\d.]+$/.test(h) || !h.includes('.')) return h.slice(0, 80);
  const parts = h.split('.');
  return MULTI_PART_SUFFIXES.has(parts.slice(-2).join('.')) ? parts.slice(-3).join('.') : parts.slice(-2).join('.');
}

// 从诊断信息里取「key: value」一行的值（只取第一个词）。
export function diagField(text, key) {
  const match = text.match(new RegExp('^' + key + ':[ \\t]*(\\S+)', 'm'));
  return match ? match[1].slice(0, 80) : '';
}

// 读出「主.次.补丁」三段；读不出时返回 null。后面带 -beta、+build 之类的后缀不影响。
export function parseVersion(value) {
  const match = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})/.exec(String(value || '').trim());
  return match ? match.slice(1, 4).map(Number) : null;
}

function compareVersion(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

const V3_AFTER = [0, 5, 0];

// 大于 0.5.0 的版本用 v3 键（加完整版本号），每个版本的第一条报告开新 issue。
// 0.5.0 及以下、读不出版本号的照旧用 v2 键，继续折进已有的 issue。
export function usesVersionedKey(appVersion) {
  const version = parseVersion(appVersion);
  return Boolean(version) && compareVersion(version, V3_AFTER) > 0;
}

const ISSUE_FLOOR = [0, 5, 0];

// 0.5.0 以下的自动报告只存不进待处理：多是解压安装、不会自动更新的旧插件，
// 报的问题新版本里修过或另有记录，报告也缺定位要用的信息，开 issue 只添乱（#301）。
// 手动反馈是用户自己写的，不分版本照常进待处理；读不出版本号的（dev 等）也照常。
export function skipsIssue(item) {
  if (item.error_type === 'manual') return false;
  const version = parseVersion(item.app_version);
  return Boolean(version) && compareVersion(version, ISSUE_FLOOR) < 0;
}

async function digestKey(tag, parts) {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify([tag, ...parts])));
  return tag + ':' + [...new Uint8Array(hash)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function dedupeKey(item) {
  let parts;
  if (item.error_type === 'manual') {
    parts = [item.app, 'manual', item.anonymous_id, item.client_ts];
  } else if (item.error_type.startsWith('fill_')) {
    const d = item.user_description;
    let code = diagField(d, 'error_code');
    if (/^http_\d{3}$/.test(code)) code = 'http_' + code.charAt(5) + 'xx';
    parts = [item.app, item.error_type, siteOf(diagField(d, 'host')), diagField(d, 'error_category'), diagField(d, 'first_failing_stage'), code];
  } else {
    parts = [item.app, item.error_type, item.app_version, item.error_stack];
  }
  if (usesVersionedKey(item.app_version)) return digestKey('v3', [...parts, item.app_version]);
  return digestKey('v2', parts);
}

// ---- 口令 ----

// 两边各取 SHA-256 再逐字节比，比较时间和口令内容无关。
async function secretMatches(given, expected) {
  if (!given || typeof expected !== 'string' || !expected) return false;
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(given)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// 读私有层的口令必须单独配置：没配、太短、或者和 Muse 的 POLL_SECRET 相同，都当作没配。
function privateSecretOf(env) {
  const secret = env.PRIVATE_READ_SECRET;
  if (typeof secret !== 'string' || secret.length < MIN_PRIVATE_SECRET_LENGTH) return '';
  if (secret === env.POLL_SECRET) return '';
  return secret;
}

// ---- 限流 ----

async function throttle(kv, ip, nowMs) {
  const key = 'throttle:' + ip;
  const raw = await kv.get(key);
  let record = null;
  try {
    record = raw ? JSON.parse(raw) : null;
  } catch {
    // 计数坏了就从头算，不让一条坏数据把这个 IP 的报告都挡成 500。
  }
  if (typeof record?.count !== 'number' || typeof record.start !== 'number' || nowMs - record.start > THROTTLE_WINDOW_MS) {
    record = { count: 0, start: nowMs };
  }
  record.count += 1;
  await kv.put(key, JSON.stringify(record), { expirationTtl: 600 });
  return record.count <= THROTTLE_LIMIT;
}

// ---- 待处理标记 ----

// 每条报告一个标记键，写入和删除都只碰自己的键，同时来多少条都不会互相覆盖。
// 没有 server_ts 的报告（正常不会有）排在最前面，照样能列出来、能 ack。
export function pendingKey(item) {
  return `${PENDING_PREFIX}${item.server_ts || NO_SERVER_TS}:${item.id}`;
}

function idOfKey(name) {
  return name.slice(name.lastIndexOf(':') + 1);
}

// 旧版本只把待处理的 id 记在 fb:index:pending 一个键里。这里把其中还没处理的报告补成标记键，
// 返回补上的报告，让这一次 /pending 就能带上它们。
// 旧索引只读不改：部署切换时旧实例可能同时往里加 id，改写会把它刚加的盖掉。等第一次看到旧索引
// 一小时以后（旧实例早已不在），每次照样补完标记，再删掉旧索引。
async function migrateLegacyIndex(kv, nowMs) {
  const raw = await kv.get(LEGACY_PENDING_INDEX);
  if (raw === null) return [];
  let ids;
  try {
    ids = JSON.parse(raw);
  } catch {
    ids = [];
  }
  if (!Array.isArray(ids)) ids = [];
  const migrated = [];
  for (const id of ids.slice(0, LEGACY_MIGRATE_BATCH)) {
    if (typeof id !== 'string') continue;
    const item = await readJson(kv, 'fb:' + id);
    if (item?.status !== 'pending') continue;
    const report = item.id === id ? item : { ...item, id };
    const marker = pendingKey(report);
    if (await kv.get(marker) === null) await kv.put(marker, '', { expirationTtl: KV_TTL });
    migrated.push(report);
  }
  const firstSeen = Number(await kv.get(LEGACY_SEEN_KEY));
  if (!firstSeen) {
    await kv.put(LEGACY_SEEN_KEY, String(nowMs), { expirationTtl: KV_TTL });
  } else if (nowMs - firstSeen >= LEGACY_RETIRE_AFTER_MS && ids.length <= LEGACY_MIGRATE_BATCH) {
    // 超过 200 个 id 的旧索引一次补不完，留着不删（实际只有零星几个）。
    await kv.delete(LEGACY_PENDING_INDEX);
    await kv.delete(LEGACY_SEEN_KEY);
  }
  return migrated;
}

// 按 server_ts 从旧到新，最多返回 200 条：积压时先处理最早的，不会有报告一直排不到。
async function listPending(kv, nowMs) {
  const migrated = await migrateLegacyIndex(kv, nowMs);
  const page = await kv.list({ prefix: PENDING_PREFIX, limit: PENDING_PAGE });
  const items = new Map(migrated.map(item => [item.id, item]));
  for (const key of page.keys) {
    const id = idOfKey(key.name);
    if (items.has(id)) continue;
    const item = await readJson(kv, 'fb:' + id);
    if (!item) {
      // 刚写入、其他地区还没同步时会暂时读不到，标记留着下次再看。过了一小时还读不到，
      // 就是报告已经过期（从旧索引迁来的标记比报告晚过期），删掉，免得占着前面的位置。
      const receivedMs = Date.parse(key.name.slice(PENDING_PREFIX.length, key.name.lastIndexOf(':')));
      if (!(nowMs - receivedMs < MISSING_REPORT_GRACE_MS)) await kv.delete(key.name);
      continue;
    }
    if (item.status === 'pending') items.set(id, item);
    // 已处理的报告留下的标记（/ack 中途失败）顺手删掉。
    else await kv.delete(key.name);
  }
  return [...items.values()]
    .sort((a, b) => (a.server_ts || '').localeCompare(b.server_ts || ''))
    .slice(0, PENDING_PAGE);
}

// ---- 私有层 ----

// 超过 16384 字节时截断，退回到完整字符的边界，不留半个汉字。
export function privateDiagnosticsOf(value) {
  if (typeof value !== 'string' || !value) return '';
  const bytes = encoder.encode(value);
  if (bytes.length <= PRIVATE_MAX_BYTES) return value;
  let end = PRIVATE_MAX_BYTES;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return decoder.decode(bytes.subarray(0, end));
}

export function privateIndexKey(dedupe, serverTs, id) {
  const reversed = String(MAX_EPOCH_MS - Date.parse(serverTs)).padStart(13, '0');
  return `${PRIVATE_INDEX_PREFIX}${dedupe}:${reversed}:${id}`;
}

async function storePrivate(kv, item, text) {
  const record = {
    id: item.id,
    dedupe_key: item.dedupe_key || null,
    app_version: item.app_version,
    server_ts: item.server_ts,
    private_diagnostics: text,
  };
  // 先写按去重键查的索引，再写私有层本身：中途失败时只会留下一个查不到内容的索引（读的时候跳过），
  // 不会有存进去却按去重键查不到的私有层。
  if (item.dedupe_key) {
    await kv.put(privateIndexKey(item.dedupe_key, item.server_ts, item.id), '', { expirationTtl: KV_TTL });
  }
  await kv.put(PRIVATE_PREFIX + item.id, JSON.stringify(record), { expirationTtl: KV_TTL });
}

function privateItem(record) {
  return {
    id: record.id,
    dedupe_key: record.dedupe_key ?? null,
    app_version: record.app_version ?? '',
    server_ts: record.server_ts ?? '',
    private_diagnostics: record.private_diagnostics ?? '',
  };
}

function parseLimit(raw) {
  if (raw === null) return PRIVATE_DEFAULT_LIMIT;
  if (!/^\d{1,2}$/.test(raw)) return 0;
  const limit = Number(raw);
  return limit >= 1 && limit <= PRIVATE_MAX_LIMIT ? limit : 0;
}

async function readPrivate(url, kv) {
  const id = url.searchParams.get('id');
  const dedupe = url.searchParams.get('dedupe_key');
  if ((id === null) === (dedupe === null)) {
    return json({ ok: false, error: 'give id or dedupe_key' }, 400);
  }
  if (id !== null) {
    if (!ID_PATTERN.test(id)) return json({ ok: false, error: 'invalid id' }, 400);
    const record = await readJson(kv, PRIVATE_PREFIX + id.toLowerCase());
    return json({ ok: true, items: record ? [privateItem(record)] : [] });
  }
  if (!DEDUPE_KEY_PATTERN.test(dedupe)) return json({ ok: false, error: 'invalid dedupe_key' }, 400);
  const limit = parseLimit(url.searchParams.get('limit'));
  if (!limit) return json({ ok: false, error: 'limit must be 1-20' }, 400);
  const page = await kv.list({ prefix: `${PRIVATE_INDEX_PREFIX}${dedupe}:`, limit });
  const items = [];
  for (const key of page.keys) {
    const record = await readJson(kv, PRIVATE_PREFIX + idOfKey(key.name));
    if (record) items.push(privateItem(record));
  }
  items.sort((a, b) => b.server_ts.localeCompare(a.server_ts));
  return json({ ok: true, items });
}

// ---- 各接口 ----

async function receiveFeedback(request, kv, now) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const received = now();
  if (!await throttle(kv, ip, received.getTime())) {
    return json({ ok: false, error: 'too many requests' }, 429);
  }
  let body;
  try {
    body = await readBody(request);
  } catch {
    return json({ ok: false, error: 'invalid json' }, 400);
  }
  const item = {
    id: crypto.randomUUID(),
    app: str(body.app, 80),
    app_version: str(body.app_version, 40),
    os: str(body.os, 120),
    error_type: str(body.error_type, 160),
    error_stack: str(body.error_stack, 20000),
    user_description: str(body.user_description, 5000),
    anonymous_id: str(body.anonymous_id, 80),
    client_ts: str(String(body.timestamp ?? ''), 40),
    server_ts: received.toISOString(),
    reporter_ip: ip,
    status: 'pending',
  };
  if (!item.app) return json({ ok: false, error: 'app required' }, 400);
  try {
    item.dedupe_key = await dedupeKey(item);
  } catch {
    // 算不出去重键也照样收下，Muse 会按没有键处理。
  }
  const privateText = privateDiagnosticsOf(body.private_diagnostics);
  const skipped = skipsIssue(item);
  if (skipped) item.status = 'skipped';
  // 先写待处理标记再写报告：报告写失败时只剩一个读不到报告的标记，一小时后 /pending 会删掉。
  // 反过来的话，标记写失败的报告会留在 KV 里，Muse 却永远看不到。
  if (!skipped) await kv.put(pendingKey(item), '', { expirationTtl: KV_TTL });
  await kv.put('fb:' + item.id, JSON.stringify(item), { expirationTtl: KV_TTL });
  // 私有层尽力写：写失败不影响公开层，报告照样收下。日志里只记 id，不记内容。
  if (privateText) {
    try {
      await storePrivate(kv, item, privateText);
    } catch {
      console.warn(`private_diagnostics not stored for ${item.id}`);
    }
  }
  return json({ ok: true, id: item.id });
}

async function exportAll(kv) {
  const keys = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: 'fb:', cursor });
    for (const key of page.keys) {
      if (key.name !== LEGACY_PENDING_INDEX) keys.push(key.name);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const items = [];
  for (const name of keys) {
    const item = await readJson(kv, name);
    if (item) items.push(item);
  }
  items.sort((a, b) => (a.server_ts || '').localeCompare(b.server_ts || ''));
  return items;
}

// 已处理的报告照收到后 90 天删除，不因为 ack 续期：隐私政策写的是最长保留 90 天。
// KV 要求到期时间至少在 60 秒以后。
function expiryOf(item, nowMs) {
  const received = Date.parse(item.server_ts);
  const target = Math.floor((Number.isFinite(received) ? received : nowMs) / 1000) + KV_TTL;
  return { expiration: Math.max(target, Math.floor(nowMs / 1000) + 60) };
}

async function ack(request, kv, nowMs) {
  let body;
  try {
    body = await readBody(request);
  } catch {
    return json({ ok: false, error: 'invalid json' }, 400);
  }
  const ids = Array.isArray(body.ids) ? body.ids.slice(0, ACK_BATCH).map(String) : [];
  for (const id of ids) {
    if (!ID_PATTERN.test(id)) continue;
    const item = await readJson(kv, 'fb:' + id);
    if (!item) continue;
    item.status = 'processed';
    await kv.put('fb:' + id, JSON.stringify(item), expiryOf(item, nowMs));
    // 先记成已处理再删标记：中途失败时留下的标记，下次 /pending 会清掉。旧索引不用动：
    // 里面的报告已处理，/pending 就不会再补它的标记。
    await kv.delete(pendingKey({ ...item, id }));
  }
  return json({ ok: true, acked: ids.length });
}

async function createIssue(request, env) {
  if (!env.GITHUB_TOKEN) {
    return json({ ok: false, error: 'github_not_configured' }, 500);
  }
  let body;
  try {
    body = await readBody(request);
  } catch {
    return json({ ok: false, error: 'invalid json' }, 400);
  }
  const repo = str(body.repo, 120);
  const title = str(body.title, 200);
  const issueBody = str(body.body, 60000);
  const labels = Array.isArray(body.labels) ? body.labels.map(label => str(label, 40)).filter(Boolean).slice(0, 5) : [];
  if (!repo || !title) return json({ ok: false, error: 'repo and title required' }, 400);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ ok: false, error: 'invalid repo' }, 400);
  const payload = { title, body: issueBody, labels };
  const headers = {
    Authorization: 'Bearer ' + env.GITHUB_TOKEN,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'app-feedback-relay',
  };
  const postIssue = issue => fetch('https://api.github.com/repos/' + repo + '/issues', {
    method: 'POST',
    headers,
    body: JSON.stringify(issue),
  });
  let response;
  try {
    response = await postIssue(payload);
  } catch {
    return json({ ok: false, error: 'github_unreachable' }, 502);
  }
  // 标签不存在时 GitHub 返回 422：去掉标签再建一次。
  if (response.status === 422 && payload.labels.length > 0) {
    payload.labels = [];
    try {
      response = await postIssue(payload);
    } catch {
      return json({ ok: false, error: 'github_unreachable' }, 502);
    }
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return json({ ok: false, error: 'github_error', detail: str(JSON.stringify(data), 500) }, 502);
  }
  return json({ ok: true, issue_url: data.html_url, issue_number: data.number });
}

// cache 不给时用 Cloudflare 的边缘缓存；给 null 就不缓存（Node 里直接跑时没有边缘缓存）。
export function createWorker({ now = () => new Date(), cache } = {}) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      const kv = env.FEEDBACK_KV;
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
      }
      if (url.pathname === '/feedback' && request.method === 'POST') {
        return receiveFeedback(request, kv, now);
      }
      if (url.pathname === '/private') {
        if (!await secretMatches(request.headers.get('x-private-secret'), privateSecretOf(env))) {
          return json({ ok: false, error: 'unauthorized' }, 401);
        }
        if (request.method !== 'GET') return json({ ok: false, error: 'not found' }, 404);
        return readPrivate(url, kv);
      }
      if (url.pathname === '/releases') {
        if (request.method !== 'GET') return json({ ok: false, error: 'not found' }, 404);
        const result = await releases(url, env, cache === undefined ? globalThis.caches?.default : cache);
        return json(result.data, result.status, result.headers);
      }
      // 其余地址（包括根地址、GET /feedback）都当作健康检查。
      if (!POLL_PATHS.has(url.pathname)) {
        return json({ ok: true, service: 'app-feedback-relay' });
      }
      if (!await secretMatches(request.headers.get('x-poll-secret'), env.POLL_SECRET)) {
        return json({ ok: false, error: 'unauthorized' }, 401);
      }
      if (url.pathname === '/pending' && request.method === 'GET') {
        const items = await listPending(kv, now().getTime());
        return json({ ok: true, count: items.length, items });
      }
      if (url.pathname === '/export' && request.method === 'GET') {
        const items = await exportAll(kv);
        return json({ ok: true, count: items.length, items });
      }
      if (url.pathname === '/ack' && request.method === 'POST') {
        return ack(request, kv, now().getTime());
      }
      if (url.pathname === '/create-issue' && request.method === 'POST') {
        return createIssue(request, env);
      }
      return json({ ok: false, error: 'not found' }, 404);
    },
  };
}

