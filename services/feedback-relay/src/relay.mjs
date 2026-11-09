// 网申快填的反馈中转（Cloudflare Worker app-feedback-relay）。
//
// 插件和桌面端把错误报告 POST 到 /feedback；Muse 用 x-poll-secret 拉 /pending、/ack、
// /create-issue，统计用 /export。这四个接口的请求和返回格式 Muse 在用，不能改。
// 私有层（private_diagnostics）单独存，只能用 x-private-secret 从 /private 读。
//
// KV 里的键：
//   fb:<id>                                  报告本身（公开层），90 天
//   pending:<server_ts>:<id>                 待处理标记，/ack 时删除，90 天
//   priv:<id>                                私有层，90 天
//   privdk:<dedupe_key>:<倒序时间>:<id>      按去重键查私有层的索引，90 天
//   fb:index:pending                         旧的待处理索引，只读出来迁移，不再写入新报告
//   throttle:<ip>                            每个 IP 10 分钟 30 条，10 分钟过期

export const KV_TTL = 90 * 24 * 3600;
export const LEGACY_PENDING_INDEX = 'fb:index:pending';
export const PENDING_PREFIX = 'pending:';
export const PRIVATE_PREFIX = 'priv:';
export const PRIVATE_INDEX_PREFIX = 'privdk:';
export const PRIVATE_MAX_BYTES = 16384;
export const PENDING_PAGE = 200;
const LEGACY_MIGRATE_BATCH = 200;
const ACK_BATCH = 200;
const PRIVATE_DEFAULT_LIMIT = 5;
const PRIVATE_MAX_LIMIT = 20;
const MIN_PRIVATE_SECRET_LENGTH = 32;
// 13 位毫秒数的最大值。私有层索引用它减去 server_ts，KV 按键名升序列出时就是从新到旧。
const MAX_EPOCH_MS = 9999999999999;
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
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

const V3_AFTER = [0, 5, 0];

// 大于 0.5.0 的版本用 v3 键（加完整版本号），每个版本的第一条报告开新 issue。
// 0.5.0 及以下、读不出版本号的照旧用 v2 键，继续折进已有的 issue。
export function usesVersionedKey(appVersion) {
  const version = parseVersion(appVersion);
  if (!version) return false;
  for (let i = 0; i < 3; i++) {
    if (version[i] !== V3_AFTER[i]) return version[i] > V3_AFTER[i];
  }
  return false;
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
  let record = raw ? JSON.parse(raw) : { count: 0, start: nowMs };
  if (nowMs - record.start > THROTTLE_WINDOW_MS) record = { count: 0, start: nowMs };
  record.count += 1;
  await kv.put(key, JSON.stringify(record), { expirationTtl: 600 });
  return record.count <= THROTTLE_LIMIT;
}

// ---- 待处理标记 ----

// 每条报告一个标记键，写入和删除都只碰自己的键，同时来多少条都不会互相覆盖。
export function pendingKey(item) {
  return `${PENDING_PREFIX}${item.server_ts}:${item.id}`;
}

function idOfKey(name) {
  return name.slice(name.lastIndexOf(':') + 1);
}

// 旧版本只把待处理的 id 记在 fb:index:pending 一个键里。这里把其中还没处理的报告
// 补成标记键，处理完就删掉旧索引；返回补上的报告，让这一次 /pending 就能带上它们。
// 部署过程中旧实例可能还会往旧索引里写，下一次 /pending 会再迁一次。
async function migrateLegacyIndex(kv) {
  const raw = await kv.get(LEGACY_PENDING_INDEX);
  if (raw === null) return [];
  let ids;
  try {
    ids = JSON.parse(raw);
  } catch {
    ids = [];
  }
  if (!Array.isArray(ids)) ids = [];
  const batch = ids.slice(0, LEGACY_MIGRATE_BATCH);
  const migrated = [];
  for (const id of batch) {
    const item = await readJson(kv, 'fb:' + id);
    if (item?.status === 'pending' && item.id && item.server_ts) {
      await kv.put(pendingKey(item), '', { expirationTtl: KV_TTL });
      migrated.push(item);
    }
  }
  const rest = ids.slice(LEGACY_MIGRATE_BATCH);
  if (rest.length) await kv.put(LEGACY_PENDING_INDEX, JSON.stringify(rest));
  else await kv.delete(LEGACY_PENDING_INDEX);
  return migrated;
}

async function removeFromLegacyIndex(kv, ids) {
  const raw = await kv.get(LEGACY_PENDING_INDEX);
  if (raw === null) return;
  let index;
  try {
    index = JSON.parse(raw);
  } catch {
    return;
  }
  if (!Array.isArray(index)) return;
  const done = new Set(ids);
  const rest = index.filter(id => !done.has(id));
  if (rest.length === index.length) return;
  if (rest.length) await kv.put(LEGACY_PENDING_INDEX, JSON.stringify(rest));
  else await kv.delete(LEGACY_PENDING_INDEX);
}

// 按 server_ts 从旧到新，最多返回 200 条：积压时先处理最早的，不会有报告一直排不到。
async function listPending(kv) {
  const migrated = await migrateLegacyIndex(kv);
  const page = await kv.list({ prefix: PENDING_PREFIX, limit: PENDING_PAGE });
  const items = new Map(migrated.map(item => [item.id, item]));
  for (const key of page.keys) {
    const id = idOfKey(key.name);
    if (items.has(id)) continue;
    const item = await readJson(kv, 'fb:' + id);
    // 报告还没读到（刚写入、其他地区还没同步）就跳过，标记留着下次再看。
    if (!item) continue;
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
  await kv.put(PRIVATE_PREFIX + item.id, JSON.stringify(record), { expirationTtl: KV_TTL });
  if (item.dedupe_key) {
    await kv.put(privateIndexKey(item.dedupe_key, item.server_ts, item.id), '', { expirationTtl: KV_TTL });
  }
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
  await kv.put('fb:' + item.id, JSON.stringify(item), { expirationTtl: KV_TTL });
  // 私有层先于待处理标记写入：Muse 看到报告时，私有层已经能读到。
  if (privateText) await storePrivate(kv, item, privateText);
  await kv.put(pendingKey(item), '', { expirationTtl: KV_TTL });
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

async function ack(request, kv) {
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
    await kv.put('fb:' + id, JSON.stringify(item), { expirationTtl: KV_TTL });
    // 先记成已处理再删标记：中途失败时留下的标记，下次 /pending 会清掉。
    if (item.server_ts) await kv.delete(pendingKey(item));
  }
  await removeFromLegacyIndex(kv, ids);
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

export function createWorker({ now = () => new Date() } = {}) {
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
      // 其余地址（包括根地址、GET /feedback）都当作健康检查。
      if (!POLL_PATHS.has(url.pathname)) {
        return json({ ok: true, service: 'app-feedback-relay' });
      }
      if (!await secretMatches(request.headers.get('x-poll-secret'), env.POLL_SECRET)) {
        return json({ ok: false, error: 'unauthorized' }, 401);
      }
      if (url.pathname === '/pending' && request.method === 'GET') {
        const items = await listPending(kv);
        return json({ ok: true, count: items.length, items });
      }
      if (url.pathname === '/export' && request.method === 'GET') {
        const items = await exportAll(kv);
        return json({ ok: true, count: items.length, items });
      }
      if (url.pathname === '/ack' && request.method === 'POST') {
        return ack(request, kv);
      }
      if (url.pathname === '/create-issue' && request.method === 'POST') {
        return createIssue(request, env);
      }
      return json({ ok: false, error: 'not found' }, 404);
    },
  };
}

