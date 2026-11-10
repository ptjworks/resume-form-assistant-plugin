// 打一份只含插件运行文件的 zip。桌面发版和插件发版共用这一份清单，
// 避免两个工作流各写一份 git archive，漏了 link/ 之类的目录。
//
//   node desktop/scripts/pack-plugin.js --output dist/wangshen-kuaitian-plugin-0.4.0.zip

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** 插件运行文件在仓库里的位置。包里去掉这一层，`manifest.json` 直接在包根目录。 */
export const PLUGIN_DIR = "extension";

/** 放在仓库根目录、原样进包根目录的文件。 */
export const REPO_ROOT_ENTRIES = ["README.md", "LICENSE"];

/**
 * 包里的路径。目录会按 Git 树展开。除了 `REPO_ROOT_ENTRIES`，都相对 `PLUGIN_DIR`。
 * 增删这里时，`check-plugin-release-allowlist.js` 会核对运行时引用是否都在包里。
 */
export const PLUGIN_ARCHIVE_OPERANDS = [
  "manifest.json",
  "background.js",
  "content.js",
  "webmail.js",
  "gmail-download.html",
  "gmail-download.js",
  "sidepanel-mail.js",
  "content.css",
  "sidebar-state.js",
  "control-adapters.js",
  "antd-prefix.js",
  "custom-controls.js",
  "region-data.js",
  "ai-helpers.js",
  "form-agent.js",
  "fill-probe.js",
  "field-scan.js",
  "page-outline.js",
  "deep-analysis.js",
  "page-actions.js",
  "page-recipe.js",
  "site-knowledge.js",
  "upload-slots.js",
  "feedback-core.js",
  "build.mjs",
  "usage-signals.js",
  "usage-ui.js",
  "usage-ui.css",
  "feedback-ui.js",
  "feedback.css",
  "ai-worker.js",
  "ai-host.js",
  "ai-host.html",
  "ai-client.js",
  "resume-utils.js",
  "profile-fields.js",
  "resume-data.js",
  "update-reminder.js",
  "template-fields.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "sidepanel.html",
  "sidepanel.css",
  "sidepanel.js",
  "sidepanel-compose.js",
  "sidepanel-queue.js",
  "sidepanel-template-editor.js",
  "link",
  "icons",
  "README.md",
  "LICENSE",
];

/** 包里的路径在仓库里对应的路径。 */
export function sourcePathOf(entry) {
  const top = entry.split("/")[0];
  return REPO_ROOT_ENTRIES.includes(top) ? entry : `${PLUGIN_DIR}/${entry}`;
}

function git(root, args, input) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
}

const lines = (text) => text.split(/\r?\n/).filter(Boolean);

/** 先把 treeish 解析成提交号，后面每一步都读同一个提交，中途分支移动也不会混进别的提交。 */
function resolveCommit(root, treeish) {
  try {
    return git(root, ["rev-parse", "--verify", "--quiet", `${treeish}^{commit}`]).trim();
  } catch {
    throw new Error(`${treeish} 不是提交，插件包只从提交打`);
  }
}

/** 插件文件所在的树。挪进 `PLUGIN_DIR` 之前的提交里，它们在仓库根目录。 */
function pluginTreeOf(root, commit) {
  try {
    git(root, ["cat-file", "-e", `${commit}:${PLUGIN_DIR}/manifest.json`]);
    return `${commit}:${PLUGIN_DIR}`;
  } catch {
    return commit;
  }
}

/**
 * 构建标识（#497）：仓库里的 `build.mjs` 写的是 `dev`，包里换成打包的提交号前 8 位，
 * 插件错误报告的 [来源] 靠它分开发布包和本地加载的开发版。
 */
export const BUILD_FILE = "build.mjs";
export function buildStamp(commit) {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit)) {
    throw new Error(`${commit} 不是完整的提交号`);
  }
  return `// Written by desktop/scripts/pack-plugin.js: the commit this release zip was packed from.\nexport const BUILD = "${commit.slice(0, 8)}";\n`;
}

/** 拼一棵包根目录的树：插件目录下的清单条目，加上仓库根目录的 `REPO_ROOT_ENTRIES`。 */
function archiveTree(root, commit) {
  const plugin = PLUGIN_ARCHIVE_OPERANDS.filter((entry) => !REPO_ROOT_ENTRIES.includes(entry));
  const repo = PLUGIN_ARCHIVE_OPERANDS.filter((entry) => REPO_ROOT_ENTRIES.includes(entry));
  const entries = [
    ...lines(git(root, ["ls-tree", pluginTreeOf(root, commit), "--", ...plugin])),
    ...lines(git(root, ["ls-tree", commit, "--", ...repo])),
  ].map((line) => {
    // build.mjs 换成写着提交号的那一份，其余原样。
    if (line.slice(line.indexOf("\t") + 1) !== BUILD_FILE) return line;
    const blob = git(root, ["hash-object", "-w", "--stdin"], buildStamp(commit)).trim();
    return `100644 blob ${blob}\t${BUILD_FILE}`;
  });
  // git archive 碰到不存在的路径会报错，ls-tree 只会静默跳过，这里补上同样的检查。
  const names = new Set(entries.map((line) => line.slice(line.indexOf("\t") + 1)));
  const missing = PLUGIN_ARCHIVE_OPERANDS.filter((entry) => !names.has(entry));
  if (missing.length) {
    throw new Error(`${commit} 里找不到这些插件文件：${missing.join(", ")}`);
  }
  return git(root, ["mktree"], `${entries.join("\n")}\n`).trim();
}

/** 包里的全部文件路径，和 `packPlugin` 打出来的一致。 */
export function listPluginArchive(root, treeish = "HEAD") {
  const tree = archiveTree(root, resolveCommit(root, treeish));
  return lines(git(root, ["ls-tree", "-r", "--name-only", tree]));
}

export function packPlugin(root, output, treeish = "HEAD") {
  if (!output.endsWith(".zip")) {
    throw new Error(`插件包必须是 .zip，拿到的是 ${output}`);
  }
  const absolute = resolve(output);
  mkdirSync(dirname(absolute), { recursive: true });
  const commit = resolveCommit(root, treeish);
  const tree = archiveTree(root, commit);
  // 直接打一棵树时 git archive 会用当前时间、不写注释。这里沿用提交时间，再把提交号写进
  // zip 注释，和挪目录前直接打提交时一样。
  const mtime = git(root, ["show", "-s", "--no-show-signature", "--format=%cI", commit]).trim();
  try {
    git(root, ["archive", "--format=zip", `--mtime=${mtime}`, `--output=${absolute}`, tree]);
  } catch (error) {
    if (/mtime/.test(String(error.stderr))) {
      throw new Error("git archive 不认 --mtime，打插件包需要 Git 2.42 或更新版本");
    }
    throw error;
  }
  setZipComment(absolute, commit);
  return absolute;
}

/** git archive 写出的 zip 末尾是不带注释的 End of Central Directory，把注释接在后面。 */
function setZipComment(file, comment) {
  const zip = readFileSync(file);
  const eocd = zip.length - 22;
  if (eocd < 0 || zip.readUInt32LE(eocd) !== 0x06054b50 || zip.readUInt16LE(eocd + 20) !== 0) {
    throw new Error(`${file} 的结尾不是 git archive 写出的 zip`);
  }
  const text = Buffer.from(comment, "utf8");
  const out = Buffer.concat([zip, text]);
  out.writeUInt16LE(text.length, eocd + 20);
  writeFileSync(file, out);
}

function main(argv) {
  const outAt = argv.indexOf("--output");
  const output = outAt >= 0 ? argv[outAt + 1] : "";
  if (!output || output.startsWith("--")) {
    throw new Error("--output 后面要跟 zip 路径");
  }
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim();
  const packed = packPlugin(root, output);
  console.log(packed);
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

if (invokedDirectly()) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(1);
  }
}
