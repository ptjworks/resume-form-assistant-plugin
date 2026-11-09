# 反馈中转 Worker（app-feedback-relay）

插件和桌面端的错误报告、手动反馈先发到这里存进 Cloudflare KV，Muse 定时拉取、建 GitHub issue。统计用 `/export` 导出全部报告。桌面检查更新时 GitHub 连不上，改从 `/releases` 拿发布列表。

这个 Worker 以前只在 Cloudflare 上有一份，没有源码仓库。11-09 用 `wrangler init --from-dash` 拉下线上代码，整理成现在的 `src/`，以后以仓库里的代码为准（#497）。

## 地址

| 地址 | 说明 |
| --- | --- |
| `https://feedback.19991107.xyz` | 新地址，国内直连能用。新版本的插件和桌面端发到这里 |
| `https://app-feedback-relay.nebula-lab.workers.dev` | 旧地址，`*.workers.dev` 在国内被 DNS 污染。老版本还在往这里发，一直保留 |

两个地址是同一个 Worker、同一份 KV。

## 接口

| 接口 | 口令 | 说明 |
| --- | --- | --- |
| `POST /feedback` | 无 | 收报告。每个 IP 10 分钟最多 30 条，超出返回 429。没有 `app` 字段返回 400 |
| `GET /pending` | `x-poll-secret` | 待处理的报告，按收到的时间从旧到新，最多 200 条 |
| `POST /ack` | `x-poll-secret` | `{ "ids": [...] }`，把报告记成已处理，一次最多 200 个 |
| `POST /create-issue` | `x-poll-secret` | 代 Muse 建 GitHub issue。标签不存在时去掉标签重试一次 |
| `GET /export` | `x-poll-secret` | 全部报告（含已处理），按收到的时间从旧到新 |
| `GET /private` | `x-private-secret` | 读私有层，见下文 |
| `GET /releases` | 无 | 代查 GitHub 的发布列表，桌面检查更新的备用来源，见下文 |
| 其余地址 | 无 | 健康检查，返回 `{"ok":true,"service":"app-feedback-relay"}` |

`/pending`、`/ack`、`/create-issue`、`/export` 的请求和返回格式 Muse 在用，改之前先改 Muse。口令只认请求头，放在网址参数里不算数。

### 报告格式

`POST /feedback` 的 JSON 字段：`app`、`app_version`、`os`、`error_type`、`error_stack`、`user_description`、`anonymous_id`、`timestamp`，都是字符串，超长截断。中转另加 `id`、`client_ts`（就是 `timestamp`）、`server_ts`、`reporter_ip`、`status`、`dedupe_key`。`/pending` 和 `/export` 返回的就是这些字段。

可选字段 `private_diagnostics`（私有层）：字符串，UTF-8 超过 16384 字节时截断（截在完整字符处）。不是字符串或为空就不存。

### 去重键

Muse 按 `dedupe_key` 把同一个问题的报告折进同一个 issue。

- 手动反馈：`app`、`manual`、`anonymous_id`、`client_ts`，每条都不同。
- 填写问题（`fill_` 开头）：`app`、`error_type`、网站主域名、`error_category`、`first_failing_stage`、`error_code`（`http_503` 记成 `http_5xx`）。后四项从 `user_description` 的「key: value」行里取。
- 代码异常：`app`、`error_type`、`app_version`、`error_stack`。
- `app_version` 大于 0.5.0 的报告用 `v3:` 键：在上面的字段后面再加完整版本号，每个新版本（包括补丁版）的第一条报告开新 issue。键是 `["v3", ...字段, 版本号]` 的 SHA-256 前 8 字节。
- 0.5.0 及以下、读不出版本号的照旧用 `v2:` 键（`["v2", ...字段]`），继续折进已有的 issue。`test/fixtures/legacy-dedupe.json` 里是用迁移前的线上代码算出来的键，测试保证它们不变。

版本号只看开头的「主.次.补丁」：`0.5.1-beta.1` 算大于 0.5.0，`0.5.0-beta.1` 不算。

### 私有层

私有层只用于我们自己排查问题，不进 GitHub issue。`/pending`、`/export` 永远不返回它，报告本身（`fb:<id>`）里也没有。

```
GET /private?id=<报告 id>
GET /private?dedupe_key=<去重键>&limit=<1～20，默认 5>
```

请求头 `x-private-secret` 和 Worker 密钥 `PRIVATE_READ_SECRET` 比对。没配这个密钥、少于 32 个字符、和 `POLL_SECRET` 相同，或者请求头对不上，一律返回 401。返回：

```json
{ "ok": true, "items": [{ "id": "…", "dedupe_key": "v3:…", "app_version": "0.5.1", "server_ts": "…", "private_diagnostics": "…" }] }
```

按 `server_ts` 从新到旧。`id` 和 `dedupe_key` 只能给一个，格式不对返回 400；查不到返回空的 `items`。

这个接口只给命令行用：CORS 预检不放行 `x-private-secret`，浏览器页面跨域调不了，这是有意的。

私有层是尽力写的：写失败时报告照样收下、照样进 `/pending`，日志里留一行 `private_diagnostics not stored for <id>`（不含内容）。

调用示例（口令经管道传给 curl，不进命令行和网址）：

```sh
op-sensitive read "op://Dev-Sensitive/app-feedback-relay PRIVATE_READ_SECRET/credential" \
  | { IFS= read -r secret; printf 'header = "x-private-secret: %s"\n' "$secret"; } \
  | curl -sS -K - "https://feedback.19991107.xyz/private?dedupe_key=v3:0123456789abcdef&limit=5"
```

### 发布列表（/releases）

桌面检查更新先直接问 GitHub（`https://api.github.com/repositories/1217054301/releases`），连不上、超时、5xx 或限流时，同一页改问这里（#497）。

```
GET /releases?per_page=<1～100>&page=<1～10>
```

- 参数只认 `per_page` 和 `page`，不给时和 GitHub 一样是 30 和 1。超范围、不是整数、重复或者带了别的参数，一律返回 400，不去问 GitHub。
- 返回和 GitHub 同样的 JSON 数组，分页结果也一样，但每条只留 `tag_name`、`draft`、`prerelease`、`html_url`。
- 草稿只留 `"draft": true`，版本号和地址是 `null`：带口令去问时 GitHub 会把草稿也列出来，不能从这里外泄。条目不删，每页条数和 GitHub 一致。
- 不管请求的 `per_page` 是多少，中转都按每页 100 条去问 GitHub，再切出请求的那一段。上游最多只有 10 种请求，查到的结果有缓存，换着参数刷也不会多问 GitHub（GitHub 出错时见「已知的限制」）。
- 每个上游页在 Cloudflare 的边缘缓存（Cache API）里存 10 分钟，每个机房各存一份，不占 KV。响应头 `X-Relay-Cache` 是 `hit`（全部来自缓存）或 `miss`。
- 去问 GitHub 时带 `GITHUB_TOKEN`：匿名额度按 Cloudflare 的出口 IP 算，和别人的 Worker 共用，常常不够。口令被拒（401）时改用匿名再问一次；没配口令就直接匿名问。
- GitHub 出错时不缓存，原样告诉桌面：连不上或超时（8 秒）返回 502 `github_unreachable`；403、429 返回 503 `github_rate_limited`；其他非 2xx 返回 502 `github_error`（带 `status`）；返回的不是列表返回 502 `github_bad_response`。桌面只把 200 的列表当作查到了。

## KV 里的键

都在 `FEEDBACK_KV`（id `e4a6992ede1a4ddbbcb16b692da9aa0a`）里，除了限流计数都保留 90 天。`/ack` 改写报告时沿用收到后 90 天的到期时间，不续期（隐私政策写的是最长保留 90 天）。

| 键 | 内容 |
| --- | --- |
| `fb:<id>` | 报告本身。`/export` 列的就是 `fb:` 开头的键 |
| `pending:<server_ts>:<id>` | 待处理标记，值为空。`/ack` 时删掉 |
| `priv:<id>` | 私有层 |
| `privdk:<dedupe_key>:<倒序时间>:<id>` | 按去重键查私有层的索引。倒序时间是 9999999999999 减去收到时的毫秒数，KV 按键名升序列出时就是从新到旧 |
| `fb:index:pending` | 旧的待处理索引，见下文 |
| `meta:legacy-index-first-seen` | 第一次看到旧索引的时间，删旧索引时一起删 |
| `throttle:<ip>` | 限流计数，10 分钟过期 |

### 待处理标记和旧索引

以前所有待处理的 id 都记在 `fb:index:pending` 这一个键里：收到报告时读出来、加一条、整个写回。两条报告同时到，后写的会盖掉先写的，被盖掉的报告还在 KV 里，但 Muse 看不到（10-29 丢过 1 条）。本地测试里同时发 50 条，旧代码的 `/pending` 只看得到 2 条。

现在每条报告单独写一个 `pending:` 标记键，`/pending` 按前缀列出来，`/ack` 删掉对应的键，谁也不会盖掉谁。收报告时先写标记再写报告：报告写失败时客户端收到 500，只留下一个读不到报告的标记（见下文会被清掉），不会有存进去却进不了 `/pending` 的报告。

部署新代码时旧索引里可能还有没处理的报告：`/pending` 每次先看旧索引在不在，在的话把其中还没处理、也还没有标记的补成标记键（一次最多看 200 个），这一次的返回里就带上它们。旧索引只读不改：部署切换的几秒里旧实例还可能往里加 id，新代码改写它就会把刚加的盖掉。第一次看到旧索引一小时后（旧实例早已不在），`/pending` 照样补完标记，再删掉旧索引。`/ack` 不碰旧索引，报告记成已处理后就不会再被补标记。

`/ack` 先把报告记成已处理，再删标记。中途失败留下的标记，下一次 `/pending` 看到报告已处理就删掉。报告暂时读不到（刚写入、别的地区还没同步）的标记会留着，下次再看；收到超过一小时还读不到，说明报告已经过期（从旧索引迁来的标记比报告晚过期），也删掉。

## 本地开发和测试

需要 Node.js 22 以上，在本目录：

```sh
npm ci
npm test                 # Miniflare 跑真实的 Workerd 和本地 KV，不连 Cloudflare
npm run check:deploy     # 用生产配置打包，不上传
```

本地起服务：把 `dev-vars.example` 复制成 `.dev.vars`（已忽略，只放假口令），然后 `npm run dev`，地址是 `http://localhost:8787`。`wrangler dev --local` 用本地模拟的 KV，不碰线上数据。

## 部署

`wrangler.jsonc` 就是生产配置：Worker 名、KV、`workers_dev: true`、`preview_urls: false`、`feedback.19991107.xyz` 自定义域名、可观测性（日志持久化，不开追踪），都照 11-09 的线上设置。在本目录跑 `wrangler deploy` 就是部署生产，所以：

1. 只部署合进 main 的代码。
2. 用有 Cloudflare 账号权限的 wrangler 登录（`wrangler login` 的 OAuth 就行），先看会改什么：

   ```sh
   WRANGLER_SEND_METRICS=false npx wrangler deploy --dry-run
   ```

   核对绑定只有 `env.FEEDBACK_KV (e4a6992ede1a4ddbbcb16b692da9aa0a)`。

3. 部署：

   ```sh
   WRANGLER_SEND_METRICS=false npx wrangler deploy
   ```

   输出里应该同时有 `app-feedback-relay.nebula-lab.workers.dev` 和 `feedback.19991107.xyz (custom domain)`。`keep_vars: true`，面板上配的变量不会被清掉；密钥部署时本来就保留。

4. 验证：两个地址的根路径都返回 `{"ok":true,"service":"app-feedback-relay"}`；`POST /feedback` 发 `{}` 返回 400。要发测试报告的话，`app` 写成 `relay-domain-test`，确认后马上 `/ack`，免得 Muse 拉到。

回退：`npx wrangler deployments list` 找上一个版本，`npx wrangler rollback <版本 id>`。迁进仓库前线上最后一个版本是 `f9670a27-54f3-4459-b13f-5dbc0f26c9be`（10-29）。注意回退到这个版本后，新报告又只记在旧索引里；回退期间只有 `pending:` 标记的报告 Muse 看不到，重新部署新代码后会再出现。

## 密钥

都放在 1Password，不写进仓库、不打印。设置时用管道传给 `wrangler secret put`，值不进命令行：

```sh
op-dev read "op://Dev/app-feedback-relay POLL_SECRET/credential" | npx wrangler secret put POLL_SECRET
```

| Worker 密钥 | 用途 | 1Password |
| --- | --- | --- |
| `POLL_SECRET` | Muse 调 `/pending`、`/ack`、`/create-issue`，统计调 `/export` | Dev「app-feedback-relay POLL_SECRET」的 `credential` |
| `GITHUB_TOKEN` | `/create-issue` 建 issue；`/releases` 代查发布列表（只读公开数据） | Dev「GitHub Personal Access Token-MUSE」的 `token` |
| `PRIVATE_READ_SECRET` | 读私有层 `/private`。只给我们自己用，不给 Muse | Dev-Sensitive「app-feedback-relay PRIVATE_READ_SECRET」的 `credential` |

`PRIVATE_READ_SECRET` 和 `POLL_SECRET` 必须不同。以后要让 Muse 的自动分析也读私有层，先确认它不会把题目、页面片段写进公开评论，再把口令给它。

## 已知的限制

- `/export` 每条报告读一次 KV，报告多了会碰到单次请求的 KV 操作上限。现在 90 天内几百条，够用。
- 限流计数是读出来加一再写回，同一 IP 同时来很多条时可能少算几条，只影响限流的松紧。计数坏了（不是 JSON）就从头算。
- 旧索引超过 200 个 id 时只看前 200 个，也不会删。11-09 部署前看过，生产里的旧索引是空的（`[]`）。
- 部署后可以用 `/export` 里 `status` 为 `pending` 的条数和 `/pending` 对一下，确认没有漏掉的报告。
- `/releases` 的缓存按机房各存一份，GitHub 发了新版本后，各地最多晚 10 分钟看到。缓存没有全局清空的入口，等它过期就行。
- `/releases` 没有按 IP 限流，GitHub 出错时也不缓存（#497 要求出错不留缓存），所以 GitHub 出错期间每个请求都会去问一次 GitHub，占用 `GITHUB_TOKEN` 的额度（每小时 5000 次，和 `/create-issue` 共用）。GitHub 正常时同一机房 10 分钟内最多问 10 次。按 IP 限流要每次写 KV，反而会让人借 `/releases` 刷掉 `/feedback` 用的 KV 写入额度，所以没加；真被刷了，再考虑 Cloudflare 的 Rate Limiting 绑定。
