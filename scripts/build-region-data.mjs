// 生成 region-data.js 里的 DATA（#429）：省、市、区县的名字，不带代码。
//
//   node scripts/build-region-data.mjs <china-division 包目录>
//
// 数据取 china-division 2.7.0（https://github.com/modood/Administrative-divisions-of-China，国家统计局 2023 年统计用区划代码）
// 的 dist/pca.json，港澳台取同一个包的 dist/HK-MO-TW.json。包从 npm 下：npm pack china-division@2.7.0，解开后传 package 目录。
// 区县一级只留名字以区、县、市、旗结尾的：东莞、中山、儋州、嘉峪关不设区县，统计用区划在它们下面列的是镇和街道；
// 台湾县下面的乡、镇也不收。名字后面括号里的别名去掉（澳门「嘉模堂区（氹仔）」）。
// 两个数据文件的 sha256 写在下面，对不上就不生成。
// 写法：省之间用 |，省名后面跟 >，市之间用 ;，市名后面跟 :，区县之间用 ,。

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/build-region-data.mjs <china-division package dir>");
  process.exit(1);
}
const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
if (pkg.name !== "china-division" || pkg.version !== "2.7.0") throw new Error(`expected china-division@2.7.0, got ${pkg.name}@${pkg.version}`);
const SHA256 = {
  "pca.json": "4422a0976fbae5d9feb3f8edafa3eb4964489f8f5162d6ec5034ab3ab3f67649",
  "HK-MO-TW.json": "546616aa6ec7239d9bcf02cb063539652604162b1ab74ef65293537c54ea3534"
};
const load = (name) => {
  const bytes = readFileSync(join(dir, "dist", name));
  const sum = createHash("sha256").update(bytes).digest("hex");
  if (sum !== SHA256[name]) throw new Error(`${name}: sha256 ${sum}, expected ${SHA256[name]}`);
  return JSON.parse(bytes.toString("utf8"));
};
const mainland = load("pca.json");
const others = load("HK-MO-TW.json");

const COUNTY = /(?:区|县|市|旗)$/;
const counties = (names) => names.map((name) => name.replace(/（[^）]*）$/, "")).filter((name) => COUNTY.test(name)).map(check);
const SEPARATORS = /[|>;:,]/;
const check = (name) => {
  if (!name || SEPARATORS.test(name)) throw new Error(`bad name: ${JSON.stringify(name)}`);
  return name;
};
const provinces = [];
for (const [province, cities] of Object.entries(mainland)) {
  const parts = Object.entries(cities).map(([city, names]) => {
    const kept = counties(names);
    return kept.length ? `${check(city)}:${kept.join(",")}` : check(city);
  });
  provinces.push(`${check(province)}>${parts.join(";")}`);
}
for (const [province, cities] of Object.entries(others)) {
  // 港澳是 { 区域: [区、堂区] }，台湾是 { 市县: [区、乡、镇、县辖市] }，按大陆同样的规则收。
  const parts = Array.isArray(cities) ? cities.map(check) : Object.entries(cities).map(([city, names]) => {
    const kept = counties(names);
    return kept.length ? `${check(city)}:${kept.join(",")}` : check(city);
  });
  provinces.push(`${check(province)}>${parts.join(";")}`);
}
const data = provinces.join("|");

const target = resolve(fileURLToPath(new URL("../region-data.js", import.meta.url)));
const source = readFileSync(target, "utf8");
const line = /^  const DATA = ".*";$/m;
if (!line.test(source)) throw new Error("DATA line not found in region-data.js");
writeFileSync(target, source.replace(line, () => `  const DATA = ${JSON.stringify(data)};`));
console.log(`region-data.js: ${provinces.length} provinces, ${data.length} chars`);
