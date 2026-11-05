import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_ARCHIVE_OPERANDS, PLUGIN_DIR, listPluginArchive, packPlugin, sourcePathOf } from "./pack-plugin.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");

test("清单覆盖插件运行文件，不含 desktop", () => {
  for (const required of ["manifest.json", "background.js", "content.js", "sidepanel.html", "sidepanel.css", "sidepanel.js", "sidepanel-mail.js", "webmail.js", "link", "icons"]) {
    assert.ok(PLUGIN_ARCHIVE_OPERANDS.includes(required), required);
  }
  assert.equal(
    PLUGIN_ARCHIVE_OPERANDS.some((entry) => entry === "desktop" || entry.startsWith("desktop/")),
    false,
  );
  const leaves = listPluginArchive(repo);
  assert.ok(leaves.includes("manifest.json"));
  assert.ok(leaves.some((name) => name.startsWith("link/")));
  assert.equal(
    leaves.some((name) => name === "desktop" || name.startsWith("desktop/")),
    false,
  );
});

test("打出来的是一份真正的 zip", () => {
  const dir = mkdtempSync(join(tmpdir(), "plugin-pack-"));
  const zip = join(dir, "resume-pro-plugin-0.4.0.zip");
  const packed = packPlugin(repo, zip);
  assert.equal(packed, zip);
  assert.ok(statSync(zip).size > 0);
  // PK\x03\x04：不依赖 unzip，Windows runner 上也过。
  assert.equal(readFileSync(zip).subarray(0, 2).toString("utf8"), "PK");
});

// 读中央目录里的文件名和 zip 注释，不依赖 unzip。
function readZipListing(file) {
  const zip = readFileSync(file);
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(eocd + 10);
  const comment = zip.subarray(eocd + 22, eocd + 22 + zip.readUInt16LE(eocd + 20)).toString("utf8");
  const names = [];
  let at = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    const nameLength = zip.readUInt16LE(at + 28);
    names.push(zip.subarray(at + 46, at + 46 + nameLength).toString("utf8"));
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return { names, comment };
}

test("插件文件在 extension/ 里，包根目录仍直接是 manifest.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "plugin-pack-"));
  try {
    const zip = packPlugin(repo, join(dir, "plugin.zip"));
    const { names, comment } = readZipListing(zip);
    const files = names.filter((name) => !name.endsWith("/"));
    assert.deepEqual(files.sort(), listPluginArchive(repo).sort());
    for (const name of ["manifest.json", "background.js", "link/worker.mjs", "icons/icon16.png", "README.md", "LICENSE"]) {
      assert.ok(files.includes(name), name);
    }
    assert.equal(names.some((name) => name.startsWith(`${PLUGIN_DIR}/`)), false);
    assert.equal(comment, execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim());
    assert.equal(sourcePathOf("manifest.json"), "extension/manifest.json");
    assert.equal(sourcePathOf("README.md"), "README.md");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("输出不是 zip 就拒绝", () => {
  assert.throws(() => packPlugin(repo, join(tmpdir(), "plugin.tar")), /\.zip/);
});
