import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "index.html"), "utf8");

test("index.html 全界面零 Emoji，图标只用内联 SVG（#545 第 2.1 节）", () => {
  const found = [...html.matchAll(/\p{Extended_Pictographic}/gu)].map((m) => `${m[0]} @${m.index}`);
  assert.deepEqual(found, []);
});

test("index.html 与样式表不引入远程脚本、字体或样式（#545 第 2.2 节）", () => {
  const css = ["styles.css", "settings.css"].map((name) => readFileSync(join(root, "src", name), "utf8")).join("\n");
  assert.doesNotMatch(html, /(?:src|href)="https?:\/\//);
  assert.doesNotMatch(css, /@import|url\(\s*["']?https?:/);
});

test("顶栏中间是 5 个文字 Tab，第 5 个前有分隔线，route 名不变", () => {
  const nav = html.slice(html.indexOf('<nav class="nav"'), html.indexOf("</nav>"));
  const routes = [...nav.matchAll(/data-route="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(routes, ["applications", "todos", "inbox", "resume", "notes"]);
  assert.ok(nav.indexOf('class="nav-sep"') < nav.indexOf('data-route="notes"'));
  assert.ok(nav.indexOf('class="nav-sep"') > nav.indexOf('data-route="resume"'));
});
