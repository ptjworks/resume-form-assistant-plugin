// GET /releases：桌面检查更新的备用来源，代查 GitHub 的发布列表（#497）。
//
// 桌面先直接问 GitHub，连不上、超时、5xx 或限流时，同一页改问这里，再用原来的逻辑挑版本。
// 只代查一个固定地址，参数只认 per_page（1～100）和 page（1～10），返回和 GitHub 同样的 JSON 数组，
// 每条只留桌面用得到的 tag_name、draft、prerelease、html_url。
//
// 上游一律按每页 100 条去要，再切出请求的那一段，结果和 GitHub 按原参数分页一样。这样不管请求
// 怎么组合，上游最多只有 10 种请求，换着参数刷也不会多问 GitHub。每页在 Cloudflare 的边缘
// 缓存里存 10 分钟（每个机房各存一份）；GitHub 出错时不缓存，下一次照样去问（README「已知的限制」）。
//
// 带 GITHUB_TOKEN 去问：匿名额度按 Cloudflare 的出口 IP 算，和别人的 Worker 共用，常常不够。
// 口令失效（401）时改用匿名再问一次。带口令时 GitHub 会把草稿也列出来：草稿只留 draft: true，
// 版本号和地址清空，不外泄没发布的版本；条目本身不删，每页的条数和 GitHub 一致，桌面按
// 「这一页不满就到头了」翻页的逻辑不受影响。

export const RELEASES_UPSTREAM = 'https://api.github.com/repositories/1217054301/releases';
export const RELEASES_CACHE_SECONDS = 600;
const UPSTREAM_PER_PAGE = 100;
const QUERY_LIMITS = { per_page: 100, page: 10 };
// 和 GitHub 一样：不给 per_page 就是 30 条，不给 page 就是第 1 页。
const DEFAULT_PER_PAGE = 30;
// 桌面每次请求等 10 秒，这里要在那之前给出答复。
const UPSTREAM_TIMEOUT_MS = 8000;
const POSITIVE_NUMBER = /^[1-9]\d{0,2}$/;

class UpstreamError extends Error {
  constructor(status, code, upstreamStatus) {
    super(code);
    this.status = status;
    this.code = code;
    this.upstreamStatus = upstreamStatus;
  }
}

// 只认 per_page 和 page，各出现一次，都是不带前导 0 的正整数且不超范围；别的参数一律拒绝。
// 返回 null 表示请求不合规。
export function parseReleasesQuery(searchParams) {
  const values = {};
  for (const [key, raw] of searchParams) {
    if (!Object.hasOwn(QUERY_LIMITS, key) || Object.hasOwn(values, key)) return null;
    if (!POSITIVE_NUMBER.test(raw)) return null;
    const value = Number(raw);
    if (value > QUERY_LIMITS[key]) return null;
    values[key] = value;
  }
  return { perPage: values.per_page ?? DEFAULT_PER_PAGE, page: values.page ?? 1 };
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

// 缓存键用请求自己的域名，不另起一个域名。
export function releasesCacheKey(origin, page) {
  return `${origin}/releases-cache/v1/${page}`;
}

async function upstreamPage(page, env, signal) {
  const url = `${RELEASES_UPSTREAM}?per_page=${UPSTREAM_PER_PAGE}&page=${page}`;
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
  let body;
  try {
    body = await response.json();
  } catch {
    throw new UpstreamError(502, 'github_bad_response');
  }
  if (!Array.isArray(body)) throw new UpstreamError(502, 'github_bad_response');
  return body.map(publicRelease);
}

// 缓存读写都是尽力而为：缓存坏了或写不进去，只是多问一次 GitHub。
async function cachedPage(page, { cache, origin, env, signal }) {
  const key = releasesCacheKey(origin, page);
  if (cache) {
    try {
      const hit = await cache.match(key);
      const items = hit ? await hit.json() : null;
      if (Array.isArray(items)) return { items, hit: true };
    } catch {
      // 当作没命中。
    }
  }
  const items = await upstreamPage(page, env, signal);
  if (cache) {
    try {
      await cache.put(key, new Response(JSON.stringify(items), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${RELEASES_CACHE_SECONDS}` },
      }));
    } catch {
      // 没存上就下次再问。
    }
  }
  return { items, hit: false };
}

// 返回 { status, data, headers }，由调用方包成 JSON 响应。
export async function releases(url, env, cache) {
  const query = parseReleasesQuery(url.searchParams);
  if (!query) {
    return { status: 400, data: { ok: false, error: 'only per_page (1-100) and page (1-10) are accepted' }, headers: {} };
  }
  const start = (query.page - 1) * query.perPage;
  const end = start + query.perPage;
  const context = { cache, origin: url.origin, env, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) };
  const items = [];
  let allHit = true;
  try {
    for (let page = Math.floor(start / UPSTREAM_PER_PAGE) + 1; page <= Math.ceil(end / UPSTREAM_PER_PAGE); page++) {
      const result = await cachedPage(page, context);
      allHit &&= result.hit;
      const offset = (page - 1) * UPSTREAM_PER_PAGE;
      items.push(...result.items.slice(Math.max(start - offset, 0), end - offset));
      // 这一页不满，后面就没有了。
      if (result.items.length < UPSTREAM_PER_PAGE) break;
    }
  } catch (error) {
    if (!(error instanceof UpstreamError)) throw error;
    const data = { ok: false, error: error.code };
    if (error.upstreamStatus) data.status = error.upstreamStatus;
    return { status: error.status, data, headers: {} };
  }
  return { status: 200, data: items, headers: { 'X-Relay-Cache': allHit ? 'hit' : 'miss' } };
}
