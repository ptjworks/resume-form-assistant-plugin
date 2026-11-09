// GET /releases：桌面检查更新的备用来源，代查 GitHub 的发布列表（#497）。
//
// 桌面先直接问 GitHub，连不上、超时、5xx 或限流时，同一页改问这里，再用原来的逻辑挑版本。
// 只代查一个固定地址，参数只认桌面实际会发的值：per_page=100、page=1～10。返回和 GitHub 同样的
// JSON 数组，每条只留桌面用得到的 tag_name、draft、prerelease、html_url。
//
// 缓存都在 Cloudflare 的边缘缓存（Cache API）里，每个机房各存一份，不占 KV 的写入额度。每页三份：
//   新鲜结果  10 分钟，期间不再问 GitHub；
//   上次成功  24 小时，GitHub 出错时拿它顶上；
//   失败标记  60 秒，期间不再问 GitHub，有上次成功的结果就返回它，没有就返回这次的错误。
// 这样每个机房每页最多 10 分钟问一次 GitHub，GitHub 出错期间最多每分钟一次。在一处反复刷这个
// 接口，不会多问 GitHub；要耗掉 GITHUB_TOKEN 的额度（Muse 的 /create-issue 也靠它），得把请求分散到
// 很多机房（全局上限是机房数 × 10 页 × 每小时 6 次）。
//
// 带 GITHUB_TOKEN 去问：匿名额度按 Cloudflare 的出口 IP 算，和别人的 Worker 共用，常常不够。
// 口令失效（401）时改用匿名再问一次。带口令时 GitHub 会把草稿也列出来：草稿只留 draft: true，
// 版本号和地址清空，不外泄没发布的版本；条目本身不删，每页的条数和 GitHub 一致，桌面按
// 「这一页不满就到头了」翻页的逻辑不受影响。

export const RELEASES_UPSTREAM = 'https://api.github.com/repositories/1217054301/releases';
export const RELEASES_PER_PAGE = 100;
export const RELEASES_MAX_PAGE = 10;
export const RELEASES_FRESH_SECONDS = 600;
export const RELEASES_STALE_SECONDS = 24 * 3600;
export const RELEASES_FAILURE_SECONDS = 60;
// 桌面每次请求等 10 秒，这里要留出国内到 Cloudflare 的往返时间，在那之前给出答复。
const UPSTREAM_TIMEOUT_MS = 6000;
const PAGE_NUMBER = /^[1-9]\d?$/;

class UpstreamError extends Error {
  constructor(status, code, upstreamStatus) {
    super(code);
    this.status = status;
    this.data = { ok: false, error: code };
    if (upstreamStatus) this.data.status = upstreamStatus;
  }
}

// 只认 per_page=100 和 page=1～10，各出现一次，别的参数一律拒绝。返回页码；不合规返回 0。
export function parseReleasesQuery(searchParams) {
  const keys = [...searchParams.keys()];
  if (keys.length !== 2 || new Set(keys).size !== 2) return 0;
  if (searchParams.get('per_page') !== String(RELEASES_PER_PAGE)) return 0;
  const page = searchParams.get('page');
  if (page === null || !PAGE_NUMBER.test(page)) return 0;
  const number = Number(page);
  return number <= RELEASES_MAX_PAGE ? number : 0;
}

// 只留四个字段。草稿的版本号和地址清空。
export function publicRelease(item) {
  const release = item && typeof item === 'object' ? item : {};
  const draft = release.draft === true;
  return {
    tag_name: !draft && typeof release.tag_name === 'string' ? release.tag_name : null,
    draft,
    prerelease: release.prerelease === true,
    html_url: !draft && typeof release.html_url === 'string' ? release.html_url : null,
  };
}

// kind 是 fresh（新鲜结果）、stale（上次成功）或 failed（失败标记）。缓存键用请求自己的域名。
export function releasesCacheKey(origin, kind, page) {
  return `${origin}/releases-cache/v1/${kind}/${page}`;
}

async function upstreamPage(page, env, signal) {
  const url = `${RELEASES_UPSTREAM}?per_page=${RELEASES_PER_PAGE}&page=${page}`;
  const ask = token => {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'app-feedback-relay' };
    if (token) headers.Authorization = 'Bearer ' + token;
    return fetch(url, { headers, signal });
  };
  let response;
  try {
    response = await ask(env.GITHUB_TOKEN);
    if (response.status === 401 && env.GITHUB_TOKEN) {
      await response.body?.cancel();
      response = await ask('');
    }
  } catch {
    throw new UpstreamError(502, 'github_unreachable');
  }
  if (response.status === 403 || response.status === 429) {
    await response.body?.cancel();
    throw new UpstreamError(503, 'github_rate_limited', response.status);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new UpstreamError(502, 'github_error', response.status);
  }
  // 正文读到一半超时或断开算连不上，读完了解析不了才算返回的东西不对。
  let text;
  try {
    text = await response.text();
  } catch {
    throw new UpstreamError(502, 'github_unreachable');
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new UpstreamError(502, 'github_bad_response');
  }
  if (!Array.isArray(body)) throw new UpstreamError(502, 'github_bad_response');
  return body.map(publicRelease);
}

// 缓存读写都是尽力而为：读坏了当作没有，写不进去就下次再问。
async function readCache(cache, key) {
  if (!cache) return null;
  try {
    const hit = await cache.match(key);
    return hit ? await hit.json() : null;
  } catch {
    return null;
  }
}

async function writeCache(cache, key, value, seconds) {
  if (!cache) return;
  try {
    await cache.put(key, new Response(JSON.stringify(value), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${seconds}` },
    }));
  } catch {
    // 没存上就下次再问。
  }
}

function listResponse(items, cacheState) {
  return { status: 200, data: items, headers: { 'X-Relay-Cache': cacheState } };
}

// 返回 { status, data, headers }，由调用方包成 JSON 响应。X-Relay-Cache：hit 是这次没问 GitHub，
// miss 是刚问过，stale 是 GitHub 出错、返回的是上次成功的结果。
export async function releases(url, env, cache) {
  const page = parseReleasesQuery(url.searchParams);
  if (!page) {
    return {
      status: 400,
      data: { ok: false, error: `only per_page=${RELEASES_PER_PAGE} and page=1-${RELEASES_MAX_PAGE} are accepted` },
      headers: {},
    };
  }
  const key = kind => releasesCacheKey(url.origin, kind, page);
  const fresh = await readCache(cache, key('fresh'));
  if (Array.isArray(fresh)) return listResponse(fresh, 'hit');

  // 刚失败过：一分钟内不再问 GitHub。
  const failed = await readCache(cache, key('failed'));
  if (failed && Number.isInteger(failed.status) && failed.data) {
    const stale = await readCache(cache, key('stale'));
    if (Array.isArray(stale)) return listResponse(stale, 'stale');
    return { status: failed.status, data: failed.data, headers: { 'X-Relay-Cache': 'hit' } };
  }

  let items;
  try {
    items = await upstreamPage(page, env, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS));
  } catch (error) {
    if (!(error instanceof UpstreamError)) throw error;
    await writeCache(cache, key('failed'), { status: error.status, data: error.data }, RELEASES_FAILURE_SECONDS);
    const stale = await readCache(cache, key('stale'));
    if (Array.isArray(stale)) return listResponse(stale, 'stale');
    return { status: error.status, data: error.data, headers: { 'X-Relay-Cache': 'miss' } };
  }
  await writeCache(cache, key('fresh'), items, RELEASES_FRESH_SECONDS);
  await writeCache(cache, key('stale'), items, RELEASES_STALE_SECONDS);
  return listResponse(items, 'miss');
}
