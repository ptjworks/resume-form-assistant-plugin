// #429 第三项：省市区数据（region-data.js）和按它逐级选的级联。
// - 数据：「深圳」「广东省深圳市南山区」「北京/海淀区」认成从省开始的路径；直辖市在统计用区划里多一级「市辖区」，
//   网站自己的数据可能写成「北京市」「北京城区」，也可能没有这一级，两种口径都要选得上。
// - 组件库的级联（Element 的 el-cascader，替身按它的类名写）：按路径一级一级点，网站只到市时点到市就算选上。
// - 通用路径：北森分类选择器（点名字进下一级、点圈选中、最后点「确定」，替身见 helpers/beisen-form.js 的 wireRegion），
//   和点了冒出新的一列的自制下拉（Moka 这类，没拿到真结构，替身按「点名字出下一列、点到底收起」写）。
// 只有虚构的页面，地名是真实的行政区划名。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { JSDOM } = require("jsdom");
const scanner = require("../field-scan.js");
const { selectItem, wireSelect, wireRegion } = require("./helpers/beisen-form.js");

require("../region-data.js");
const R = globalThis.ResumeProRegions;
const names = (value) => {
  const found = R.resolve(value);
  return found ? found.path.map((part) => part.name + (part.placeholder ? "*" : "")).join(" / ") : null;
};

test("region data: a city alone gets its province, and joined or separated names are split into levels", () => {
  for (const [value, path] of [
    ["深圳", "广东省 / 深圳市"], ["深圳市", "广东省 / 深圳市"], ["苏州", "江苏省 / 苏州市"],
    ["广东深圳", "广东省 / 深圳市"], ["广东省深圳市南山区", "广东省 / 深圳市 / 南山区"], ["广东/深圳", "广东省 / 深圳市"],
    ["广东省 深圳市 南山区", "广东省 / 深圳市 / 南山区"], ["中国/广东省/深圳市", "广东省 / 深圳市"], ["中国广东省深圳市", "广东省 / 深圳市"],
    ["中华人民共和国北京市海淀区", "北京市 / 市辖区* / 海淀区"], ["广州天河", "广东省 / 广州市 / 天河区"],
    ["内蒙古呼和浩特", "内蒙古自治区 / 呼和浩特市"], ["广西南宁", "广西壮族自治区 / 南宁市"], ["新疆乌鲁木齐", "新疆维吾尔自治区 / 乌鲁木齐市"],
    ["恩施", "湖北省 / 恩施土家族苗族自治州"], ["湖北恩施州", "湖北省 / 恩施土家族苗族自治州"], ["延边", "吉林省 / 延边朝鲜族自治州"],
    ["昆山", "江苏省 / 苏州市 / 昆山市"], ["江苏昆山", "江苏省 / 苏州市 / 昆山市"], ["河南南阳南召", "河南省 / 南阳市 / 南召县"],
    ["香港", "香港特别行政区"], ["台北", "台湾省 / 台北市"], ["广东省", "广东省"]
  ]) assert.equal(names(value), path, value);
});

test("region data: municipalities and province-administered counties carry the placeholder level of the statistics data", () => {
  for (const [value, path] of [
    ["北京", "北京市"], ["北京市海淀区", "北京市 / 市辖区* / 海淀区"], ["北京海淀", "北京市 / 市辖区* / 海淀区"],
    ["北京/北京/海淀区", "北京市 / 市辖区* / 海淀区"], ["北京市市辖区东城区", "北京市 / 市辖区* / 东城区"],
    ["上海浦东新区", "上海市 / 市辖区* / 浦东新区"], ["重庆城口", "重庆市 / 县* / 城口县"], ["石柱", "重庆市 / 县* / 石柱土家族自治县"],
    ["济源", "河南省 / 省直辖县级行政区划* / 济源市"], ["神农架", "湖北省 / 省直辖县级行政区划* / 神农架林区"]
  ]) assert.equal(names(value), path, value);
});

test("region data: names shared by two places, and words that are not places, are not guessed", () => {
  // 「南山区」深圳、鹤岗都有，「朝阳区」北京、长春都有，「西湖区」杭州、南昌都有；写上上级就认得出。
  for (const value of ["南山区", "朝阳区", "西湖区", "东乡", "北京大学", "中山大学", "长安大学", "汉族", "市场营销", "计算机", "本科", "", "市辖区"]) {
    assert.equal(names(value), null, value);
  }
  assert.equal(names("北京朝阳区"), "北京市 / 市辖区* / 朝阳区");
  assert.equal(names("长春朝阳区"), "吉林省 / 长春市 / 朝阳区");
  // 跳过的级数少的优先：「吉林」「海南」是省，不是吉林市、海南藏族自治州。
  assert.equal(names("吉林"), "吉林省");
  assert.equal(names("吉林市"), "吉林省 / 吉林市");
  assert.equal(names("海南"), "海南省");
  assert.equal(names("朝阳"), "辽宁省 / 朝阳市", "a city before a district of the same short name");
});

test("region data: option texts are compared by full name, short name, or the site's own way of writing the placeholder level", () => {
  const [province, city] = R.resolve("广东省深圳市").path;
  assert.equal(R.matches("广东", province), true);
  assert.equal(R.matches("广东省", province), true);
  assert.equal(R.matches("广西壮族自治区", province), false);
  assert.equal(R.matches("深圳", city), true);
  assert.equal(R.matches("吉林市", R.resolve("吉林").path[0]), false, "吉林市 is not 吉林省");
  const [, urban] = R.resolve("北京海淀").path;
  for (const text of ["市辖区", "北京城区", "城区"]) assert.equal(R.placeholderLike(text, urban), true, text);
  for (const text of ["东城区", "西城区", "北京市"]) assert.equal(R.placeholderLike(text, urban), false, text);
  const [, county] = R.resolve("重庆城口").path;
  for (const text of ["县", "重庆郊县"]) assert.equal(R.placeholderLike(text, county), true, text);
  assert.equal(R.placeholderLike("重庆城区", county), false);
});

test("region data: 34 provincial divisions, the statistics cities, and no towns or streets anywhere", () => {
  const source = fs.readFileSync(require.resolve("../region-data.js"), "utf8");
  const data = JSON.parse(/^ {2}const DATA = (".*");$/m.exec(source)[1]);
  const provinces = data.split("|").map((chunk) => chunk.split(">"));
  assert.equal(provinces.length, 34);
  assert.deepEqual(provinces.slice(-3).map(([name]) => name), ["香港特别行政区", "澳门特别行政区", "台湾省"]);
  const mainland = provinces.slice(0, 31).flatMap(([, cities]) => cities.split(";"));
  assert.equal(mainland.length, 342);
  const countiesOf = (cities) => cities.flatMap((city) => (city.split(":")[1] || "").split(",").filter(Boolean));
  assert.ok(countiesOf(mainland).length > 2800, String(countiesOf(mainland).length));
  // 审查 B7：港澳台和大陆一样，乡、镇、街道不收（台湾县下的乡镇原来漏收进来了），括号里的别名去掉。
  const all = countiesOf(provinces.flatMap(([, cities]) => cities.split(";")));
  assert.deepEqual(all.filter((name) => /(?:镇|街道|乡)$/.test(name) || /[（）()]/.test(name)), []);
  assert.ok(all.includes("嘉模堂区") && all.includes("大安区"));
});

// ---- 组件库的级联（Element 的 el-cascader）----
// tree：{ 名字: 下级 }，没有下级的写 null。点有下级的出下一列，点到底在框里写上整条路径并收起。
function load(html) {
  const dom = new JSDOM(`<form>${html}</form>`, { runScripts: "outside-only" });
  const w = dom.window;
  for (const file of ["ai-helpers.js", "region-data.js", "custom-controls.js", "control-adapters.js"]) w.eval(fs.readFileSync(file, "utf8"));
  const api = w.ResumeProControls.create({ timeoutMs: 200, settleMs: 35, isVisible: (el) => !el.closest("[hidden]") });
  return { w, doc: w.document, api };
}
function elCascader(tree) {
  const h = load('<label id="q">籍贯</label><div class="el-cascader"><input role="combobox" readonly aria-labelledby="q" aria-controls="choices"></div>');
  const { doc } = h;
  const input = doc.querySelector("input"), root = doc.querySelector(".el-cascader");
  const clicks = [];
  root.addEventListener("click", () => {
    if (doc.getElementById("choices")) return;
    const popup = doc.createElement("div"); popup.id = "choices"; popup.className = "el-cascader__dropdown";
    const column = (branch, path, depth) => {
      popup.querySelectorAll(".el-cascader-menu").forEach((menu, index) => { if (index >= depth) menu.remove(); });
      const menu = doc.createElement("div"); menu.className = "el-cascader-menu";
      for (const [name, below] of Object.entries(branch)) {
        const node = doc.createElement("div"); node.className = "el-cascader-node";
        node.innerHTML = `<span class="el-cascader-node__label">${name}</span>`;
        node.addEventListener("click", () => {
          clicks.push(name);
          menu.querySelectorAll(".is-active").forEach((other) => other.classList.remove("is-active"));
          node.classList.add("is-active");
          if (below) { setTimeout(() => column(below, [...path, name], depth + 1), 10); return; }
          input.value = [...path, name].join(" / "); popup.remove();
        });
        menu.append(node);
      }
      popup.append(menu);
    };
    column(tree, [], 0);
    doc.body.append(popup);
  });
  return { ...h, input, clicks, target: { kind: "element", element: input, root, controlKind: "cascader", hints: {} } };
}
const GD = { 广东省: { 广州市: { 天河区: null, 越秀区: null }, 深圳市: { 福田区: null, 南山区: null } }, 江苏省: { 苏州市: { 昆山市: null } } };

test("a cascader gets a city alone as province / city", async () => {
  // 改前：「深圳」当成第一列的一项去找，报没有匹配的选项。
  const h = elCascader({ 广东省: { 广州市: null, 深圳市: null }, 浙江省: { 杭州市: null } });
  const result = await h.api.operate(h.target, "深圳");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.clicks, ["广东省", "深圳市"]);
  assert.equal(h.input.value, "广东省 / 深圳市");
});

test("a cascader gets province, city and district written together, and a county-level city by its own name", async () => {
  for (const [value, clicks] of [["广东省深圳市南山区", ["广东省", "深圳市", "南山区"]], ["昆山", ["江苏省", "苏州市", "昆山市"]]]) {
    const h = elCascader(GD);
    const result = await h.api.operate(h.target, value);
    assert.equal(result.ok, true, `${value} ${JSON.stringify(result)}`);
    assert.deepEqual(h.clicks, clicks, value);
  }
});

test("a municipality is picked whichever way the site writes its second level", async () => {
  // 统计用区划：北京市 / 市辖区 / 海淀区；有的数据第二级也叫北京市、或叫北京城区；有的没有这一级。
  for (const [tree, clicks] of [
    [{ 北京市: { 市辖区: { 东城区: null, 海淀区: null } }, 天津市: { 市辖区: { 和平区: null } } }, ["北京市", "市辖区", "海淀区"]],
    [{ 北京市: { 北京市: { 东城区: null, 海淀区: null } }, 天津市: { 天津市: { 和平区: null } } }, ["北京市", "北京市", "海淀区"]],
    [{ 北京市: { 北京城区: { 东城区: null, 海淀区: null } } }, ["北京市", "北京城区", "海淀区"]],
    [{ 北京市: { 东城区: null, 海淀区: null }, 天津市: { 和平区: null } }, ["北京市", "海淀区"]]
  ]) {
    for (const value of ["北京市海淀区", "北京/海淀"]) {
      const h = elCascader(tree);
      const result = await h.api.operate(h.target, value);
      assert.equal(result.ok, true, `${value} ${JSON.stringify(tree)} ${JSON.stringify(result)}`);
      assert.deepEqual(h.clicks, clicks, value);
    }
  }
});

test("Chongqing counties go under 县 or 重庆郊县, its districts under 市辖区 or 重庆城区", async () => {
  for (const [tree, value, clicks] of [
    [{ 重庆市: { 市辖区: { 渝中区: null }, 县: { 城口县: null } } }, "重庆城口县", ["重庆市", "县", "城口县"]],
    [{ 重庆市: { 重庆城区: { 渝中区: null }, 重庆郊县: { 城口县: null } } }, "重庆城口县", ["重庆市", "重庆郊县", "城口县"]],
    [{ 重庆市: { 重庆城区: { 渝中区: null }, 重庆郊县: { 城口县: null } } }, "重庆渝中区", ["重庆市", "重庆城区", "渝中区"]]
  ]) {
    const h = elCascader(tree);
    const result = await h.api.operate(h.target, value);
    assert.equal(result.ok, true, `${value} ${JSON.stringify(result)}`);
    assert.deepEqual(h.clicks, clicks, value);
  }
});

test("a site that only goes down to the city takes province / city for a value written to the district", async () => {
  // 改前：点了深圳市后一直等下一列，报等待下一级选项超时。
  const h = elCascader({ 广东省: { 广州市: null, 深圳市: null } });
  const result = await h.api.operate(h.target, "广东省深圳市南山区");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.clicks, ["广东省", "深圳市"]);
  assert.equal(h.input.value, "广东省 / 深圳市");
});

test("a value that stops above the site's last level is not completed by guessing", async () => {
  const h = elCascader(GD);
  const result = await h.api.operate(h.target, "广东省深圳市");
  assert.equal(result.ok, false);
  assert.deepEqual(h.clicks, ["广东省", "深圳市"], "no district is clicked");
  assert.equal(h.input.value, "");
});

test("a country column first, and short names without 省 or 市, are followed", async () => {
  for (const [tree, value, clicks] of [
    [{ 中国: { 广东省: { 深圳市: null } }, 美国: { 加利福尼亚州: null } }, "深圳", ["中国", "广东省", "深圳市"]],
    [{ 广东: { 广州: null, 深圳: null }, 广西: { 南宁: null } }, "广东省深圳市", ["广东", "深圳"]],
    // 网站把名字写得和统计用区划不一样，只要正好一项包含它就照原来认。
    [{ 新疆维吾尔族自治区: { 乌鲁木齐市: null }, 西藏自治区: { 拉萨市: null } }, "新疆/乌鲁木齐", ["新疆维吾尔族自治区", "乌鲁木齐市"]]
  ]) {
    const h = elCascader(tree);
    const result = await h.api.operate(h.target, value);
    assert.equal(result.ok, true, `${value} ${JSON.stringify(result)}`);
    assert.deepEqual(h.clicks, clicks, value);
  }
});

test("cascaders that are not about places keep the old splitting, and a district name shared by two cities is not guessed", async () => {
  const majors = elCascader({ 工学: { 计算机类: { 软件工程: null } }, 理学: { 数学类: null } });
  assert.equal((await majors.api.operate(majors.target, "工学/计算机类/软件工程")).ok, true);
  assert.deepEqual(majors.clicks, ["工学", "计算机类", "软件工程"]);
  const shared = elCascader({ 广东省: { 深圳市: { 南山区: null } }, 黑龙江省: { 鹤岗市: { 南山区: null } } });
  const result = await shared.api.operate(shared.target, "南山区");
  assert.equal(result.reason, "no_option_match");
  assert.deepEqual(shared.clicks, []);
});

// ---- 通用路径：北森分类选择器 ----
function scanned(doc, label) {
  const control = scanner.scanPage(doc, { isVisible: () => true }).controls.find((item) => item.label === label);
  assert.ok(control, `scanned ${label}`);
  return { kind: "element", element: control.element, elements: control.elements, root: control.root, controlKind: control.controlKind, hints: {} };
}
function beisenRegion(options) {
  const h = load(selectItem("f1", "期望工作城市", 100));
  return { ...h, ...wireRegion(h.doc, "f1", options), target: scanned(h.doc, "期望工作城市") };
}
const SZ = { 福田区: null, 南山区: null, 罗湖区: null };
const BEISEN = { 北京市: { 东城区: null, 海淀区: null }, 广东省: { 广州市: { 天河区: null }, 深圳市: SZ }, 黑龙江省: { 鹤岗市: { 南山区: null, 向阳区: null } } };

test("Beisen region picker: names are clicked to go down, only the last level's radio is clicked, then 确定", async () => {
  // 改前：整段「广东省深圳市南山区」拿去搜索，搜不到，报没有匹配的选项。
  const h = beisenRegion({ tree: BEISEN, display: "path" });
  const result = await h.api.operate(h.target, "广东省深圳市南山区");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.events, ["drill:广东省", "drill:深圳市", "radio:广东省/深圳市/南山区", "ok"]);
  assert.equal(h.shown(), "广东省/深圳市/南山区");
  assert.deepEqual(h.searches, []);
});

test("Beisen region picker: a city alone, a municipality's district, and a component that shows only the last name", async () => {
  for (const [value, events, shown] of [
    ["深圳", ["drill:广东省", "radio:广东省/深圳市", "ok"], "深圳市"],
    ["北京市海淀区", ["drill:北京市", "radio:北京市/海淀区", "ok"], "海淀区"]
  ]) {
    const h = beisenRegion({ tree: BEISEN });
    const result = await h.api.operate(h.target, value);
    assert.equal(result.ok, true, `${value} ${JSON.stringify(result)}`);
    assert.deepEqual(h.events, events, value);
    assert.equal(h.shown(), shown, value);
  }
});

test("Beisen region picker that only goes down to the city: the city's radio is clicked once its name opens nothing", async () => {
  const h = beisenRegion({ tree: { 广东省: { 广州市: null, 深圳市: null }, 浙江省: { 杭州市: null } }, display: "path" });
  const result = await h.api.operate(h.target, "广东省深圳市南山区");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.events, ["drill:广东省", "radio:广东省/深圳市", "ok"]);
  assert.equal(h.shown(), "广东省/深圳市");
});

test("Beisen region picker whose next level is slow to load: the province is not taken as the answer", async () => {
  // 点了省以后城市过了等待时间才画出来，期间没有加载图标：省带着下级箭头，不能当成网站只到省，把省选上。
  const h = beisenRegion({ tree: BEISEN, drillMs: 600 });
  const result = await h.api.operate(h.target, "广东省深圳市");
  assert.equal(result.reason, "cascade_timeout");
  assert.deepEqual(h.events, ["drill:广东省"], "no radio is clicked");
  assert.equal(h.shown(), "");
});

test("Beisen region picker with the province below the first screen: the district is searched, and the row naming 广东省/深圳市 is taken", async () => {
  // 一屏只画 9 个省，广东省在后面。搜「南山」出来深圳、鹤岗两个南山区，按名字下面的上级选深圳的。
  const filler = Object.fromEntries(["河北省", "山西省", "辽宁省", "吉林省", "江苏省", "浙江省", "安徽省", "福建省", "江西省", "山东省"].map((name) => [name, { 示例市: null }]));
  const h = beisenRegion({ tree: { ...filler, ...BEISEN }, rows: 9 });
  const result = await h.api.operate(h.target, "广东省深圳市南山区");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.searches, ["南山"], "the district is searched by its short name");
  assert.deepEqual(h.events, ["radio:广东省/深圳市/南山区", "ok"]);
  assert.equal(h.shown(), "南山区");
});

test("Beisen region picker: a district shared by two cities with no upper level written is not guessed", async () => {
  const filler = Object.fromEntries(["河北省", "山西省", "辽宁省", "吉林省", "江苏省", "浙江省", "安徽省", "福建省", "江西省", "山东省"].map((name) => [name, { 示例市: null }]));
  const h = beisenRegion({ tree: { ...filler, ...BEISEN }, rows: 9 });
  const result = await h.api.operate(h.target, "南山区");
  assert.equal(result.ok, false);
  assert.deepEqual(h.events, [], "no radio is clicked");
});

test("a generic list whose option is the whole value keeps picking it whole, on the first screen or by searching", async () => {
  // 审查 B1：选项本身写着「广东省深圳市南山区」时照原来整段选，不按地区拆。
  const first = load(selectItem("f1", "工作地点", 100));
  const pick = wireSelect(first.doc, "f1", { choices: ["北京市海淀区", "广东省深圳市南山区"] });
  const result = await first.api.operate(scanned(first.doc, "工作地点"), "广东省深圳市南山区");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(pick.events, ["radio:广东省深圳市南山区", "ok"]);
  const later = load(selectItem("f1", "工作地点", 100));
  const choices = [...Array.from({ length: 12 }, (_, i) => `示例地点${i + 1}`), "深圳市南山区"];
  const searched = wireSelect(later.doc, "f1", { choices, rows: 9 });
  const found = await later.api.operate(scanned(later.doc, "工作地点"), "深圳市南山区");
  assert.equal(found.ok, true, JSON.stringify(found));
  assert.deepEqual(searched.searches, ["南山"], "the district search already lists the whole option");
  assert.deepEqual(searched.events, ["radio:深圳市南山区", "ok"]);
});

test("a flat Beisen list of provinces only takes the province for a value written to the city", async () => {
  // 只列省、没有下级箭头：点了名字等不到下一级，就是网站只到省，选上省（和改前一样）。
  const h = load(selectItem("f1", "籍贯", 100));
  const pick = wireSelect(h.doc, "f1", { choices: ["北京市", "河北省", "河南省", "湖北省"] });
  const result = await h.api.operate(scanned(h.doc, "籍贯"), "河南省南阳市");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(pick.events, ["radio:河南省", "ok"]);
  assert.equal(pick.shown(), "河南省");
});

test("a flat list with both provinces and cities takes the city, not its province", async () => {
  // 审查 C4：平铺列表里「广东省」「深圳市」都有，要填「深圳」时选深圳市。原来先找到省，点了名字等不到下一级，就把省选上了。
  const h = load(selectItem("f1", "期望工作城市", 100));
  const pick = wireSelect(h.doc, "f1", { choices: ["北京市", "广东省", "广州市", "深圳市"] });
  const result = await h.api.operate(scanned(h.doc, "期望工作城市"), "深圳");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(pick.events, ["radio:深圳市", "ok"]);
  assert.equal(pick.shown(), "深圳市");
});

test("a generic control marked as a cascader still picks an option that is the whole value", async () => {
  // 审查 A16：标成级联时整段相同的一项（选项就写着「广东省/深圳市/南山区」）也直接选，不按「/」拆开去找。
  const h = load(selectItem("f1", "工作地点", 100));
  const pick = wireSelect(h.doc, "f1", { choices: ["北京市/海淀区", "广东省/深圳市/南山区"] });
  const result = await h.api.operate({ ...scanned(h.doc, "工作地点"), controlKind: "cascader" }, "广东省/深圳市/南山区");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(pick.events, ["radio:广东省/深圳市/南山区", "ok"]);
});

test("bilingual options are matched by their Chinese part and accepted when the component shows the whole text", async () => {
  // 审查 B10：选项写成「深圳市 / Shenzhen」，组件上显示整段。
  const h = load(selectItem("f1", "期望工作城市", 100));
  const pick = wireSelect(h.doc, "f1", { choices: ["广州市 / Guangzhou", "深圳市 / Shenzhen"] });
  const result = await h.api.operate(scanned(h.doc, "期望工作城市"), "深圳");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(pick.events, ["radio:深圳市 / Shenzhen", "ok"]);
});

test("a district the site writes without 区 is found by searching its short name, not replaced by its city", async () => {
  // 审查 B9：网站写「南山」。原来搜「南山区」搜不到，退去搜「深圳市」，把市选上了。
  const filler = Object.fromEntries(["河北省", "山西省", "辽宁省", "吉林省", "江苏省", "浙江省", "安徽省", "福建省", "江西省", "山东省"].map((name) => [name, { 示例市: null }]));
  const h = beisenRegion({ tree: { ...filler, 广东省: { 深圳市: { 南山: null, 福田: null } } }, rows: 9 });
  const result = await h.api.operate(h.target, "广东省深圳市南山区");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.searches, ["南山"]);
  assert.deepEqual(h.events, ["radio:广东省/深圳市/南山", "ok"]);
});

test("a municipality's district not found by search falls back to the municipality when the site only lists 北京市", async () => {
  // 审查 A19：「北京市海淀区」搜「海淀」搜不到，网站只到「北京市」这一级时搜「北京」选上北京市。
  const filler = Object.fromEntries(["河北省", "山西省", "辽宁省", "吉林省", "江苏省", "浙江省", "安徽省", "福建省", "江西省", "山东省"].map((name) => [name, { 示例市: null }]));
  const h = beisenRegion({ tree: { ...filler, 北京市: null, 广东省: { 深圳市: SZ } }, rows: 9 });
  const result = await h.api.operate(h.target, "北京市海淀区");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.searches, ["海淀", "北京市海淀区", "北京"]);
  assert.deepEqual(h.events, ["radio:北京市", "ok"]);
});

test("search results that show the whole path in one line are matched as the same place", async () => {
  // 98b091a 上 Lane C 未核实的一条：搜索结果一行写着「广东省/深圳市/南山区」。
  const h = load(selectItem("f1", "工作地点", 100));
  const choices = [...Array.from({ length: 12 }, (_, i) => `示例省/示例市${i + 1}`), "广东省/深圳市/南山区", "黑龙江省/鹤岗市/南山区"];
  const pick = wireSelect(h.doc, "f1", { choices, rows: 9 });
  const result = await h.api.operate(scanned(h.doc, "工作地点"), "深圳市南山区");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(pick.searches, ["南山"]);
  assert.deepEqual(pick.events, ["radio:广东省/深圳市/南山区", "ok"]);
});

// 每行一个单选圈加名字，点名字进下一级（reuse：按位置复用原来的行，只换文字），点圈选中，点「确定」后显示。
function rowsPicker(tree, { rowClass = "", reuse = false } = {}) {
  const h = load(selectItem("f1", "籍贯", 100));
  const { doc } = h;
  const root = doc.querySelector(".phoenix-select"), shown = root.querySelector(".phoenix-select__selected");
  const events = [];
  root.addEventListener("click", () => {
    if (doc.querySelector(".rows-layer")) return;
    const layer = doc.createElement("div"); layer.className = "rows-layer";
    layer.innerHTML = `<div class="rows"></div><div class="footer"><button type="button" class="ok">确定</button></div>`;
    const rows = layer.querySelector(".rows");
    let path = [], picked = null;
    const render = () => {
      const branch = path.reduce((at, name) => at[name], tree), names = Object.keys(branch);
      if (!reuse) rows.innerHTML = "";
      while (rows.children.length > names.length) rows.lastElementChild.remove();
      names.forEach((name, index) => {
        let row = rows.children[index];
        if (!row) { row = doc.createElement("div"); row.innerHTML = `<svg class="RadioUnchecked"></svg><span class="name"></span>`; rows.append(row); }
        row.className = `row ${rowClass}`.trim();
        row.querySelector(".name").textContent = name;
      });
    };
    rows.addEventListener("click", (event) => {
      const row = event.target.closest(".row"), name = row?.querySelector(".name").textContent;
      if (!row) return;
      if (event.target.closest("svg")) { picked = [...path, name]; events.push(`radio:${picked.join("/")}`); return; }
      const below = path.reduce((at, part) => at[part], tree)[name];
      if (below) { path = [...path, name]; events.push(`drill:${name}`); render(); }
    });
    layer.querySelector(".ok").addEventListener("click", () => { events.push("ok"); shown.textContent = picked ? picked.join("/") : ""; layer.remove(); });
    render();
    doc.body.append(layer);
    doc.addEventListener("mousedown", (event) => { if (!layer.contains(event.target) && !root.contains(event.target)) layer.remove(); }, true);
  });
  return { ...h, events, shown: () => shown.textContent, target: scanned(doc, "籍贯") };
}

test("a list that redraws the next level into the same rows is still followed", async () => {
  // fc35daf 上 Lane C 未核实的一条：按位置复用节点重画的列表，节点没换、文字换了，也是新冒出来的下一级。
  const h = rowsPicker({ 河南省: { 郑州市: null, 南阳市: null }, 湖北省: { 武汉市: null } }, { reuse: true });
  const result = await h.api.operate(h.target, "河南省南阳市");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.events, ["drill:河南省", "radio:河南省/南阳市", "ok"]);
});

test("a class name that merely contains arrow (is-narrow) is not taken as a sign of a next level", async () => {
  // 审查 B11：只列省、每行带 is-narrow 的列表收到「河南省南阳市」，照样当网站只到省，选上河南省。
  const h = rowsPicker({ 北京市: null, 河南省: null, 湖北省: null }, { rowClass: "is-narrow" });
  const result = await h.api.operate(h.target, "河南省南阳市");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.events, ["radio:河南省", "ok"]);
});

// ---- 通用路径：点了冒出新的一列的自制下拉（Moka 这类）----
function columnsPicker(tree) {
  const h = load(`<div class="item"><label class="title">现居住城市</label>
    <label class="sd-Input-container-3Fx sd-Select-container-9Qa select"><input class="sd-Input-input-7Kd" readonly placeholder="请选择"></label></div>`);
  const { doc } = h;
  const input = doc.querySelector("input");
  const clicks = [];
  input.addEventListener("click", () => {
    if (doc.querySelector(".sd-Cascader-menus")) return;
    const popup = doc.createElement("div"); popup.className = "sd-Cascader-menus";
    const column = (branch, path, depth) => {
      Array.from(popup.children).forEach((menu, index) => { if (index >= depth) menu.remove(); });
      const menu = doc.createElement("div"); menu.className = "sd-Cascader-menu";
      for (const [name, below] of Object.entries(branch)) {
        const item = doc.createElement("div"); item.className = "sd-Cascader-item";
        item.innerHTML = `<span class="sd-Cascader-label">${name}</span>`;
        item.addEventListener("click", () => {
          clicks.push(name);
          if (below) { column(below, [...path, name], depth + 1); return; }
          input.value = [...path, name].join("/"); popup.remove();
        });
        menu.append(item);
      }
      popup.append(menu);
    };
    column(tree, [], 0);
    doc.body.append(popup);
    // 在外面按下就收起。
    doc.addEventListener("mousedown", (event) => { if (!popup.contains(event.target) && event.target !== input) popup.remove(); }, true);
  });
  return { ...h, input, clicks, target: scanned(doc, "现居住城市") };
}

test("a dropdown that opens a new column per level is clicked down the path, also when the site stops at the city", async () => {
  for (const [tree, clicks, shown] of [
    [GD, ["广东省", "深圳市", "南山区"], "广东省/深圳市/南山区"],
    [{ 广东省: { 广州市: null, 深圳市: null }, 浙江省: { 杭州市: null } }, ["广东省", "深圳市"], "广东省/深圳市"]
  ]) {
    const h = columnsPicker(tree);
    const result = await h.api.operate(h.target, "广东省深圳市南山区");
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(h.clicks, clicks);
    assert.equal(h.input.value, shown);
  }
});

test("a generic control marked as a cascader follows a slash-separated region path, not just its first part", async () => {
  // 审查 A11：整段比对用的是整个值，不是按「/」拆开后的第一段「广东省」。
  const h = columnsPicker(GD);
  const result = await h.api.operate({ ...h.target, controlKind: "cascader" }, "广东省/深圳市/南山区");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.clicks, ["广东省", "深圳市", "南山区"]);
  assert.equal(h.input.value, "广东省/深圳市/南山区");
});

test("a column dropdown whose last wanted level still opens another column stops: cascade_unsupported, and the layer is closed", async () => {
  const h = columnsPicker(GD);
  const result = await h.api.operate(h.target, "广东省深圳市");
  assert.equal(result.reason, "cascade_unsupported");
  assert.deepEqual(h.clicks, ["广东省", "深圳市"]);
  assert.equal(h.input.value, "");
  assert.equal(h.doc.querySelector(".sd-Cascader-menus"), null);
});
