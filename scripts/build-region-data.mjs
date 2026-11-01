// 生成 region-data.js 里的 DATA（#429）：省、市、区县的名字，不带代码。
//
//   node scripts/build-region-data.mjs <china-division 包目录>
//
// 数据取 china-division 2.7.0（https://github.com/modood/Administrative-divisions-of-China，国家统计局 2023 年统计用区划代码）
// 的 dist/pca.json，港澳台取同一个包的 dist/HK-MO-TW.json。包从 npm 下：npm pack china-division@2.7.0，解开后传 package 目录。
// 区县一级只留名字以区、县、市、旗结尾的：东莞、中山、儋州、嘉峪关不设区县，统计用区划在它们下面列的是镇和街道。
// 写法：省之间用 |，省名后面跟 >，市之间用 ;，市名后面跟 :，区县之间用 ,。

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
const mainland = JSON.parse(readFileSync(join(dir, "dist", "pca.json"), "utf8"));
const others = JSON.parse(readFileSync(join(dir, "dist", "HK-MO-TW.json"), "utf8"));

const COUNTY = /(?:区|县|市|旗)$/;
const SEPARATORS = /[|>;:,]/;
const check = (name) => {
  if (!name || SEPARATORS.test(name)) throw new Error(`bad name: ${JSON.stringify(name)}`);
  return name;
};
const provinces = [];
for (const [province, cities] of Object.entries(mainland)) {
  const parts = Object.entries(cities).map(([city, counties]) => {
    const kept = counties.filter((name) => COUNTY.test(name)).map(check);
    return kept.length ? `${check(city)}:${kept.join(",")}` : check(city);
  });
  provinces.push(`${check(province)}>${parts.join(";")}`);
}
for (const [province, cities] of Object.entries(others)) {
  // 台湾省只到市县一级（数组），港澳是 { 区域: [堂区] }。
  const parts = Array.isArray(cities) ? cities.map(check)
    : Object.entries(cities).map(([city, counties]) => `${check(city)}:${counties.map(check).join(",")}`);
  provinces.push(`${check(province)}>${parts.join(";")}`);
}
const data = provinces.join("|");

const target = resolve(fileURLToPath(new URL("../region-data.js", import.meta.url)));
const source = readFileSync(target, "utf8");
const line = /^  const DATA = ".*";$/m;
if (!line.test(source)) throw new Error("DATA line not found in region-data.js");
writeFileSync(target, source.replace(line, () => `  const DATA = ${JSON.stringify(data)};`));
console.log(`region-data.js: ${provinces.length} provinces, ${data.length} chars`);
