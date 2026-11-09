// #497 The [来源] section's build line: a copy loaded from the repository says `dev`, a release zip the commit it was
// packed from (desktop/scripts/pack-plugin.js writes extension/build.mjs into the zip).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");

const repo = path.join(__dirname, "..");

// One file out of a zip, without unzip: the central directory gives its local header, the local header its data.
function readZipEntry(file, name) {
  const zip = fs.readFileSync(file);
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < zip.readUInt16LE(eocd + 10); i += 1) {
    const nameLength = zip.readUInt16LE(at + 28);
    const entry = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    if (entry === name) {
      const method = zip.readUInt16LE(at + 10);
      const size = zip.readUInt32LE(at + 20);
      const local = zip.readUInt32LE(at + 42);
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + size);
      return (method === 8 ? zlib.inflateRawSync(data) : data).toString("utf8");
    }
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return null;
}

test("the repository's build.mjs says dev, and the worker writes it into [来源]", async () => {
  const { BUILD } = await import("../extension/build.mjs");
  assert.equal(BUILD, "dev");
  const { createFeedback } = await import("../extension/link/feedback.mjs");
  const data = {};
  const worker = createFeedback({ storage: { get: async () => structuredClone(data), set: async value => Object.assign(data, structuredClone(value)) },
    version: "0.5.0", os: "Windows / Chrome 140", fetchImpl: async () => new Response("{}") });
  assert.match(worker.preview({ description: "" }).user_description, /^build: dev$/m);
});

test("the release zip's build.mjs carries the first 8 hex digits of the commit it was packed from", async () => {
  const { BUILD_FILE, buildStamp, listPluginArchive, packPlugin } = await import("../desktop/scripts/pack-plugin.js");
  assert.equal(BUILD_FILE, "build.mjs");
  assert.ok(listPluginArchive(repo).includes(BUILD_FILE));
  assert.match(buildStamp("0123456789abcdef0123456789abcdef01234567"), /^export const BUILD = "01234567";$/m);
  assert.throws(() => buildStamp("HEAD"), /提交号/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-build-"));
  try {
    const zip = packPlugin(repo, path.join(dir, "plugin.zip"));
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const text = readZipEntry(zip, BUILD_FILE);
    assert.match(text, new RegExp(`^export const BUILD = "${head.slice(0, 8)}";$`, "m"));
    // Every other file is the commit's own.
    assert.equal(readZipEntry(zip, "manifest.json"), execFileSync("git", ["show", "HEAD:extension/manifest.json"], { cwd: repo, encoding: "utf8" }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
