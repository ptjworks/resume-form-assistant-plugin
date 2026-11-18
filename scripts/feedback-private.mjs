#!/usr/bin/env node
// 按 GitHub Issue 编号、去重键（dedupe_key）或报告 ID 拉取并格式化反馈私有诊断层（/private）。
// 口令优先从环境变量 PRIVATE_READ_SECRET 或标准输入读取，避免出现在命令行参数中。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ENDPOINT = "https://feedback.19991107.xyz";
const DEDUPE_RE = /<!--\s*feedback-dedupe-key:\s*(v\d{1,3}:[0-9a-f]{16})\s*-->/i;
const KEY_RE = /^v\d{1,3}:[0-9a-f]{16}$/i;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveEndpoint(raw = process.env.FEEDBACK_RELAY_URL || DEFAULT_ENDPOINT) {
  let parsed;
  try {
    parsed = new URL(String(raw || DEFAULT_ENDPOINT));
  } catch {
    throw new Error(`无效的 FEEDBACK_RELAY_URL: ${raw}`);
  }
  const isLocal = parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  if (parsed.protocol !== "https:" && !isLocal) {
    throw new Error(`拒绝通过非 HTTPS 地址发送私有读取凭据: ${parsed.origin}`);
  }
  return parsed.origin;
}

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { issue: "", dedupeKey: "", id: "", limit: 5, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] ?? "");
    if (arg === "--json") {
      out.json = true;
    } else if (arg === "--issue" && argv[i + 1]) {
      out.issue = String(argv[++i]).replace(/^#/, "");
    } else if ((arg === "--dedupe-key" || arg === "--key") && argv[i + 1]) {
      out.dedupeKey = String(argv[++i]);
    } else if (arg === "--id" && argv[i + 1]) {
      out.id = String(argv[++i]);
    } else if (arg === "--limit" && argv[i + 1]) {
      out.limit = Math.max(1, Math.min(20, Number.parseInt(argv[++i], 10) || 5));
    } else if (/^#?\d+$/.test(arg) && !out.issue) {
      out.issue = arg.replace(/^#/, "");
    } else if (KEY_RE.test(arg) && !out.dedupeKey) {
      out.dedupeKey = arg;
    } else if (ID_RE.test(arg) && !out.id) {
      out.id = arg;
    }
  }
  return out;
}

export function extractDedupeKeyFromBody(body) {
  return DEDUPE_RE.exec(String(body ?? ""))?.[1] || "";
}

function resolveDedupeKeyFromIssue(issueNumber) {
  const raw = execFileSync("gh", ["issue", "view", String(issueNumber), "--json", "number,title,body,url"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const issue = JSON.parse(raw);
  const dedupeKey = extractDedupeKeyFromBody(issue.body);
  if (!dedupeKey) {
    throw new Error(`Issue #${issueNumber} 正文中未找到 <!-- feedback-dedupe-key: ... --> 标记`);
  }
  return { dedupeKey, issue };
}

function readSecret() {
  if (process.env.PRIVATE_READ_SECRET?.trim()) {
    return process.env.PRIVATE_READ_SECRET.trim();
  }
  if (!process.stdin.isTTY) {
    try {
      const piped = fs.readFileSync(0, "utf8").trim();
      if (piped) return piped;
    } catch {
      // Fall through to 1Password CLI.
    }
  }
  try {
    const secret = execFileSync(
      "op-sensitive",
      ["read", "op://Dev-Sensitive/app-feedback-relay PRIVATE_READ_SECRET/credential"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    ).trim();
    if (secret) return secret;
  } catch {
    // Fall through to error.
  }
  throw new Error(
    "未读取到 PRIVATE_READ_SECRET。请通过环境变量 PRIVATE_READ_SECRET 或标准输入管道传入口令。"
  );
}

export function formatPrivateItems(payload, meta = {}) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const header = [];
  if (meta.issue) {
    header.push(`Issue: #${meta.issue.number} ${meta.issue.title} (${meta.issue.url})`);
  }
  if (meta.dedupeKey) header.push(`Dedupe Key: ${meta.dedupeKey}`);
  if (meta.id) header.push(`Report ID: ${meta.id}`);
  header.push(`共查到 ${items.length} 条私有诊断记录`);
  if (!items.length) return header.join("\n");
  const blocks = items.map((item, idx) => [
    `=== 记录 ${idx + 1}/${items.length} | id=${item.id} | version=${item.app_version} | server_ts=${item.server_ts} ===`,
    String(item.private_diagnostics || "（无私有诊断内容）").trim()
  ].join("\n"));
  return `${header.join("\n")}\n\n${blocks.join("\n\n")}`;
}

async function main() {
  const args = parseArgs();
  let issueInfo = null;
  let dedupeKey = args.dedupeKey;
  if (!dedupeKey && !args.id && args.issue) {
    const resolved = resolveDedupeKeyFromIssue(args.issue);
    dedupeKey = resolved.dedupeKey;
    issueInfo = resolved.issue;
  }
  if (!dedupeKey && !args.id) {
    console.error("用法: node scripts/feedback-private.mjs <--issue 533 | --dedupe-key v3:... | --id uuid> [--limit 5] [--json]");
    process.exit(1);
  }
  const endpoint = resolveEndpoint();
  const secret = readSecret();
  const query = args.id
    ? `id=${encodeURIComponent(args.id)}`
    : `dedupe_key=${encodeURIComponent(dedupeKey)}&limit=${args.limit}`;
  const res = await fetch(`${endpoint}/private?${query}`, {
    headers: { "x-private-secret": secret }
  });
  const body = await res.json().catch(() => ({ ok: false, status: res.status }));
  if (!res.ok || !body?.ok) {
    console.error(`查询 /private 失败 (HTTP ${res.status}):`, JSON.stringify(body));
    process.exit(1);
  }
  if (args.json) {
    console.log(JSON.stringify(body, null, 2));
  } else {
    console.log(formatPrivateItems(body, { issue: issueInfo, dedupeKey, id: args.id }));
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath && import.meta.url === invokedPath) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
