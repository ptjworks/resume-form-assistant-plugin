const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const helpers = require("../ai-helpers.js");

const options = (texts) => texts.map((text) => ({ value: text, text }));

// 用真实的 ai-worker.js，桩掉桌面回包，看它到底把哪些字段交给了 AI。
function loadWorker(onRequest) {
  const context = vm.createContext({
    importScripts() {}, ResumeProAIHelpers: helpers,
    ResumeProProfile: require('../profile-fields.js'),
    AbortController, TextEncoder, SyntaxError, performance,
    crypto: { randomUUID: () => 'synthetic-call' }
  });
  context.self = { postMessage(message) {
    if (message.kind !== 'desktop-complete') return;
    onRequest(message);
    queueMicrotask(() => context.self.onmessage({ data: { kind: 'desktop-result', callId: message.callId, reply: { ok: true, text: '[]' } } }));
  } };
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../ai-worker.js"), "utf8"), context);
  return context;
}

test("rule-based matching keeps strong basic info and ignores unsupported pinyin derivation", () => {
  const formFields = [
    { fieldId: "field-name", label: "姓名", placeholder: "", name: "", idAttr: "", ariaLabel: "" },
    { fieldId: "field-pinyin", label: "姓拼音", placeholder: "", name: "", idAttr: "", ariaLabel: "" },
    { fieldId: "field-email", label: "邮箱", placeholder: "", name: "", idAttr: "", ariaLabel: "" },
    { fieldId: "field-phone", label: "手机号码", placeholder: "", name: "", idAttr: "", ariaLabel: "" }
  ];

  const resumeFields = [
    { group: "基本信息", key: "姓名", value: "测试用户" },
    { group: "基本信息", key: "邮箱", value: "demo.user@example.com" },
    { group: "基本信息", key: "手机号码", value: "13800138000" }
  ];

  const matches = helpers.buildRuleBasedMatches(formFields, resumeFields);

  assert.deepEqual(matches, [
    { fieldId: "field-name", value: "测试用户" },
    { fieldId: "field-email", value: "demo.user@example.com" },
    { fieldId: "field-phone", value: "13800138000" }
  ]);
});

test("value validation rejects obviously wrong AI matches", () => {
  const formFields = [
    { fieldId: "pinyin", label: "姓拼音", placeholder: "", name: "", idAttr: "", ariaLabel: "" },
    { fieldId: "birth", label: "出生日期", placeholder: "", name: "", idAttr: "", ariaLabel: "" },
    { fieldId: "email", label: "邮箱", placeholder: "", name: "", idAttr: "", ariaLabel: "" }
  ];

  const filtered = helpers.filterValidMatches(formFields, [
    { fieldId: "pinyin", value: "demo.user@example.com" },
    { fieldId: "birth", value: "博士研究生" },
    { fieldId: "email", value: "化学工程与技术" }
  ]);

  assert.deepEqual(filtered, []);
});

test("select and radio matches must hit actual options", () => {
  const filtered = helpers.filterValidMatches([
    { fieldId: "gender", label: "性别", inputType: "radio", options: ["男", "女"] },
    { fieldId: "degree", label: "学历", inputType: "select", options: ["本科", "硕士", "博士"] }
  ], [
    { fieldId: "gender", value: "男" },
    { fieldId: "degree", value: "华东理工大学" }
  ]);

  assert.deepEqual(filtered, [
    { fieldId: "gender", value: "男" }
  ]);
});

test("select validation accepts the same loose spellings the page fill accepts", () => {
  const filtered = helpers.filterValidMatches([
    { fieldId: "degree", label: "最高学历", inputType: "select", options: ["请选择", "大学本科", "硕士研究生"] }
  ], [{ fieldId: "degree", value: "本科" }]);

  assert.deepEqual(filtered, [{ fieldId: "degree", value: "本科" }]);
});

// 没被识别成联动组的下一级下拉框，刚出来时只有「请选择」。AI 给的值要留到页面上等选项加载后再选。
test("a select whose options have not loaded yet does not throw the value away", () => {
  const filtered = helpers.filterValidMatches([
    { fieldId: "city", label: "所在城市", inputType: "select", options: ["请选择"] },
    { fieldId: "empty", label: "所在区县", inputType: "select", options: [] }
  ], [{ fieldId: "city", value: "南阳市" }, { fieldId: "empty", value: "南召县" }]);

  assert.deepEqual(filtered, [{ fieldId: "city", value: "南阳市" }, { fieldId: "empty", value: "南召县" }]);
});

test("region: 户口性质 is filled from a field with exactly that name", () => {
  const matches = helpers.buildRuleBasedMatches(
    [{ fieldId: "a", label: "户口性质", inputType: "select", options: ["城镇", "农村"] }],
    [
      { group: "户籍与地区", key: "户口所在地省", value: "河南省" },
      { group: "户籍与地区", key: "户口性质", value: "农村" }
    ]
  );

  assert.deepEqual(matches, [{ fieldId: "a", value: "农村" }]);
});

test("parsed fields get semantic names from anchor values", () => {
  const normalized = helpers.normalizeParsedFields([
    { group: "实习经历", key: "实习1公司", value: "陶氏" },
    { group: "实习经历", key: "实习1岗位", value: "研发实习生" },
    { group: "实习经历", key: "实习1起止时间", value: "2023.06-2023.08" },
    { group: "教育背景", key: "教育1学校", value: "华东理工大学" },
    { group: "教育背景", key: "教育1专业", value: "化学工程与技术" }
  ]);

  assert.deepEqual(normalized, [
    { group: "实习经历", key: "陶氏实习经历-公司", value: "陶氏" },
    { group: "实习经历", key: "陶氏实习经历-岗位", value: "研发实习生" },
    { group: "实习经历", key: "陶氏实习经历-起止时间", value: "2023.06-2023.08" },
    { group: "教育背景", key: "华东理工大学教育经历-学校", value: "华东理工大学" },
    { group: "教育背景", key: "华东理工大学教育经历-专业", value: "化学工程与技术" }
  ]);
});

test("findSelectOptionIndex: exact value or text", () => {
  assert.equal(helpers.findSelectOptionIndex(options(["男", "女"]), "男"), 0);
  assert.equal(helpers.findSelectOptionIndex([{ value: "1", text: "身份证" }], "1"), 0);
  assert.equal(helpers.findSelectOptionIndex(["汉族", "回族"], "回族"), 1);
});

test("findSelectOptionIndex: 选择其他 is a real option, Select… is a placeholder, values compare loosely", () => {
  assert.equal(helpers.findSelectOptionIndex(options(["选择", "选择其他", "本科"]), "选择其他"), 1);
  assert.equal(helpers.findSelectOptionIndex(options(["Select Degree", "Bachelor"]), "degree"), -1);
  assert.equal(helpers.findSelectOptionIndex([{ value: "MALE", text: "Man" }, { value: "FEMALE", text: "Woman" }], "male"), 0);
  assert.equal(helpers.isPlaceholderOption({ value: "", text: "Choose one" }), true);
});

test("person scope: English emergency contact and a 父母 group stay off the applicant", () => {
  const matches = helpers.buildRuleBasedMatches(
    [
      { fieldId: "emg", label: "Emergency Contact Name", inputType: "text", options: [] },
      { fieldId: "parents", label: "姓名", group: "父母情况", inputType: "text", options: [] },
      { fieldId: "own", label: "姓名", inputType: "text", options: [] }
    ],
    [{ group: "基本信息", key: "姓名", value: "张三" }]
  );

  assert.deepEqual(matches, [{ fieldId: "own", value: "张三" }]);
});

test("findSelectOptionIndex: ignores spacing, brackets and hyphens", () => {
  assert.equal(helpers.findSelectOptionIndex(options(["中国(CHINA)", "美国(USA)"]), "中国（CHINA）"), 0);
  assert.equal(helpers.findSelectOptionIndex(options(["CET-6", "CET-4"]), "cet6"), 0);
});

test("findSelectOptionIndex: containment in either direction when it is unambiguous", () => {
  assert.equal(helpers.findSelectOptionIndex(options(["请选择学位", "大学本科", "硕士研究生"]), "本科"), 1);
  assert.equal(helpers.findSelectOptionIndex(options(["学士", "硕士", "博士"]), "硕士学位"), 1);
});

test("findSelectOptionIndex: refuses to guess between several containing options", () => {
  assert.equal(helpers.findSelectOptionIndex(options(["博士研究生", "博士后"]), "博士"), -1);
});

// #301 #418 证件类型：「我的信息」里写「居民身份证」「港澳居民来往内地通行证」「台湾居民来往大陆通行证」（profile-fields.js），
// 网站常写「身份证」「回乡证」「台胞证」，旁边还有「香港居民身份证」「澳门居民身份证」，按包含比会几项都沾边。
test("findSelectOptionIndex: an ID type picks the one option that is another name for it", () => {
  const csair = options(["身份证", "护照", "回乡证", "外国人永久居留证", "港澳通行证", "香港居民身份证", "澳门居民身份证", "台湾身份证", "台胞证", "台湾通行证"]);
  const pick = (list, value) => list[helpers.findSelectOptionIndex(list, value)]?.text;
  assert.equal(pick(csair, "居民身份证"), "身份证");
  assert.equal(pick(csair, "港澳居民来往内地通行证"), "回乡证");
  assert.equal(pick(csair, "台湾居民来往大陆通行证"), "台胞证");
  // 反过来：资料写简称，网站写全称。
  const full = options(["居民身份证", "香港居民身份证", "澳门居民身份证", "港澳居民来往内地通行证", "台湾居民来往大陆通行证", "护照"]);
  assert.equal(pick(full, "身份证"), "居民身份证");
  assert.equal(pick(full, "二代身份证"), "居民身份证");
  assert.equal(pick(full, "回乡证"), "港澳居民来往内地通行证");
  assert.equal(pick(full, "台胞证"), "台湾居民来往大陆通行证");
  assert.equal(pick(options(["中华人民共和国居民身份证", "香港居民身份证", "护照"]), "大陆居民身份证"), "中华人民共和国居民身份证");
});

test("findSelectOptionIndex: an ID-type synonym is used only when exactly one option is one", () => {
  // 两项都是身份证的写法：不猜。
  assert.equal(helpers.findSelectOptionIndex(options(["中国居民身份证", "大陆居民身份证", "香港居民身份证"]), "居民身份证"), -1);
  // 「港澳通行证」也可能是内地居民往来港澳通行证，不当成回乡证。
  assert.equal(helpers.findSelectOptionIndex(options(["港澳通行证", "护照"]), "港澳居民来往内地通行证"), -1);
  // 禁用的选项不算。
  assert.equal(helpers.findSelectOptionIndex([{ value: "1", text: "身份证", disabled: true }, { value: "2", text: "香港居民身份证" }, { value: "3", text: "澳门居民身份证" }], "居民身份证"), -1);
  // 同名的照旧先用。
  assert.equal(helpers.findSelectOptionIndex(options(["身份证", "居民身份证", "护照"]), "居民身份证"), 1);
});

test("select validation keeps an ID type that only matches by its other name", () => {
  const filtered = helpers.filterValidMatches([
    { fieldId: "idtype", label: "证件类型", inputType: "select", options: ["请选择", "身份证", "护照", "香港居民身份证", "澳门居民身份证"] }
  ], [{ fieldId: "idtype", value: "居民身份证" }]);
  assert.deepEqual(filtered, [{ fieldId: "idtype", value: "居民身份证" }]);
});

// #429 同义词表（ai-helpers.js 的 OPTION_SYNONYMS）：从源码里取出这张表，查每种写法只在一组里、民族是 56 个。
function synonymTable() {
  const source = fs.readFileSync(path.join(__dirname, "..", "ai-helpers.js"), "utf8");
  const start = source.indexOf("  const ETHNIC_NAMES");
  const end = source.indexOf("  const SYNONYM_GROUPS");
  assert.ok(start > 0 && end > start, "the synonym table is found in ai-helpers.js");
  return new Function(`${source.slice(start, end)}\nreturn { ETHNIC_NAMES, LEVEL_SYNONYMS, OPTION_SYNONYMS };`)();
}

test("option synonyms: every way of writing belongs to one group only, and all 56 ethnic groups are listed", () => {
  const { ETHNIC_NAMES, LEVEL_SYNONYMS, OPTION_SYNONYMS } = synonymTable();
  assert.equal(new Set(ETHNIC_NAMES).size, 56);
  const owner = new Map();
  for (const names of OPTION_SYNONYMS) {
    assert.ok(names.length >= 2, names.join("/"));
    for (const name of names) {
      const key = helpers.normalizeText(name);
      assert.ok(!owner.has(key) || owner.get(key) === names, `${name} is in ${owner.get(key)?.join("/")} and ${names.join("/")}`);
      owner.set(key, names);
      // 每种写法都认得出同组的其他写法；外语等级要看整张列表，单看一项不算。
      for (const other of names) {
        const level = LEVEL_SYNONYMS.includes(names) && helpers.normalizeText(other) !== key;
        assert.equal(helpers.isSameOptionText(other, name), !level, `${other} = ${name}`);
      }
    }
  }
});

test("findSelectOptionIndex: another way of writing the same thing is used when exactly one option is one", () => {
  const pick = (list, value) => list[helpers.findSelectOptionIndex(options(list), value)];
  // 民族：网站写不带「族」的，单字的也算。
  assert.equal(pick(["汉", "蒙古", "回", "土家", "土"], "汉族"), "汉");
  assert.equal(pick(["汉", "蒙古", "回", "土家", "土"], "土家族"), "土家");
  assert.equal(pick(["汉", "蒙古", "回", "土家", "土"], "土族"), "土");
  // 政治面貌：国标全称不含「共青团员」，按包含比对不上。
  const gb = ["中国共产党党员", "中国共产党预备党员", "中国共产主义青年团团员", "无党派民主人士", "群众"];
  assert.equal(pick(gb, "共青团员"), "中国共产主义青年团团员");
  assert.equal(pick(gb, "中共党员"), "中国共产党党员");
  assert.equal(pick(gb, "中共预备党员"), "中国共产党预备党员");
  // 「中共党员」包含于「中共预备党员」以外的写法。
  assert.equal(pick(["中国共产党党员", "中国共产党预备党员", "中国农工民主党党员"], "共产党员"), "中国共产党党员");
  // 外语等级、性别、学历。
  assert.equal(pick(["四级", "六级", "专四", "专八"], "CET-6"), "六级");
  assert.equal(pick(["CET-4", "CET-6", "TEM-4", "TEM-8"], "专业英语四级"), "TEM-4");
  assert.equal(pick(["Male", "Female"], "女"), "Female");
  assert.equal(pick(["男", "女"], "男性"), "男");
  assert.equal(pick(["高中", "大专", "本科", "硕士研究生"], "大学专科"), "大专");
});

test("findSelectOptionIndex: synonyms stay inside their own meaning", () => {
  const index = (list, value) => helpers.findSelectOptionIndex(options(list), value);
  // 学历和学位不混。
  assert.equal(index(["学士", "硕士", "博士"], "本科"), -1);
  assert.equal(index(["本科", "硕士研究生"], "学士"), -1);
  // 国标里「群众」和「无党派民主人士」是两项。
  assert.equal(index(["无党派民主人士", "中共党员"], "群众"), -1);
  assert.equal(index(["无党派民主人士", "群众"], "无党派人士"), 0);
  // 「中国」不当成「中国大陆」：港澳台居民的国籍也是中国。
  assert.equal(index(["中国大陆", "中国香港", "中国澳门", "中国台湾"], "中国"), -1);
  // 「健康」「良好」不当同义。
  assert.equal(index(["健康", "一般", "较差"], "良好"), -1);
  // 单写「党员」不收：民主党派的党员也这么写，几项都沾边时照旧不选。
  assert.equal(index(["中共党员", "中共预备党员", "农工党党员", "致公党党员"], "党员"), -1);
  // 外语等级只在选项里至少有两种外语等级时才用：计算机等级题的「四级」不收「CET-4」。
  assert.equal(index(["一级", "二级", "三级", "四级"], "CET-4"), -1);
  assert.equal(index(["英语四级", "未通过"], "CET-4"), -1);
  assert.equal(index(["CET-4", "CET-6", "未通过"], "四级"), 0);
  // 两项都是同组的写法：不猜。
  assert.equal(index(["中共党员", "中国共产党党员", "群众"], "共产党员"), -1);
  // 同名的照旧先用。
  assert.equal(index(["汉", "汉族"], "汉族"), 1);
});

test("select validation keeps an answer whose option is written another way", () => {
  const filtered = helpers.filterValidMatches([
    { fieldId: "nation", label: "民族", inputType: "select", options: ["请选择", "汉", "回", "满"] },
    { fieldId: "party", label: "政治面貌", inputType: "select", options: ["中国共产党党员", "中国共产主义青年团团员", "群众"] }
  ], [{ fieldId: "nation", value: "汉族" }, { fieldId: "party", value: "共青团员" }]);
  assert.deepEqual(filtered, [{ fieldId: "nation", value: "汉族" }, { fieldId: "party", value: "共青团员" }]);
});

test("optionSearchText: types the part every way of writing shares, otherwise the value itself", () => {
  assert.equal(helpers.optionSearchText("土家族"), "土家");
  assert.equal(helpers.optionSearchText("共青团员"), "团员");
  assert.equal(helpers.optionSearchText("中国共产主义青年团团员"), "团员");
  assert.equal(helpers.optionSearchText(" 汉族 "), "汉");
  // 没有共有的一段（「CET-6」和「六级」，「中共党员」和「中国共产党党员」），或不在表里：照原样。
  assert.equal(helpers.optionSearchText("中共党员"), "中共党员");
  assert.equal(helpers.optionSearchText("CET-6"), "CET-6");
  assert.equal(helpers.optionSearchText("男性"), "男性");
  assert.equal(helpers.optionSearchText("北京大学"), "北京大学");
  assert.equal(helpers.optionSearchText(""), "");
});

test("findSelectOptionIndex: negated options never stand in for the positive one, and back", () => {
  assert.equal(helpers.findSelectOptionIndex(options(["全日制", "非全日制"]), "全日制"), 0);
  assert.equal(helpers.findSelectOptionIndex(options(["全日制", "非全日制"]), "非全日制"), 1);
  assert.equal(helpers.findSelectOptionIndex(options(["全日制（统招）", "在职"]), "全日制"), 0);
  assert.equal(helpers.findSelectOptionIndex(options(["全日制", "在职"]), "非全日制"), -1);
});

test("findSelectOptionIndex: placeholders and misses return -1", () => {
  assert.equal(helpers.findSelectOptionIndex(options(["请选择学历", "大学本科"]), "学历"), -1);
  assert.equal(helpers.findSelectOptionIndex(options(["男", "女"]), "保密"), -1);
  assert.equal(helpers.findSelectOptionIndex(options(["汉族"]), ""), -1);
  assert.equal(helpers.findSelectOptionIndex(null, "男"), -1);
});

test("findSelectOptionIndex: a placeholder or disabled option is never a match, even exactly", () => {
  assert.equal(helpers.findSelectOptionIndex(options(["请选择", "男", "女"]), "请选择"), -1);
  assert.equal(helpers.findSelectOptionIndex(options(["Please select", "Yes", "No"]), "Please select"), -1);
  assert.equal(helpers.findSelectOptionIndex([{ value: "x", text: "已停招", disabled: true }, { value: "y", text: "在招" }], "已停招"), -1);
  assert.equal(helpers.findSelectOptionIndex([{ value: " 1 ", text: "身份证" }], "1"), 0);
});

test("rules: an invalid first candidate does not block a valid later one", () => {
  const matches = helpers.buildRuleBasedMatches(
    [{ fieldId: "a", label: "籍贯", inputType: "select", options: ["河南省"] }],
    [
      { group: "户籍与地区", key: "籍贯县", value: "南召县" },
      { group: "户籍与地区", key: "籍贯省", value: "河南省" }
    ]
  );

  assert.deepEqual(matches, [{ fieldId: "a", value: "河南省" }]);
});

test("region: a form field's own label decides its topic before its group name", () => {
  const matches = helpers.buildRuleBasedMatches(
    [{ fieldId: "a", label: "籍贯", group: "户籍与地区", inputType: "select", options: ["河南省"] }],
    [{ group: "基本信息", key: "籍贯", value: "河南省" }]
  );

  assert.deepEqual(matches, [{ fieldId: "a", value: "河南省" }]);
});

test("region: 户口性质 is not a place and never takes 户口所在地", () => {
  const matches = helpers.buildRuleBasedMatches(
    [{ fieldId: "a", label: "户口性质", inputType: "text", options: [] }],
    [{ group: "户籍与地区", key: "户口所在地省", value: "河南省" }]
  );

  assert.deepEqual(matches, []);
});

test("person scope: shortened emergency labels and a generic 家庭主要成员 name stay off the applicant", () => {
  const byId = new Map(helpers.buildRuleBasedMatches(
    [
      { fieldId: "own-name", label: "姓名", inputType: "text", options: [] },
      { fieldId: "emg", label: "紧急联系电话", inputType: "text", options: [] }
    ],
    [
      { group: "家庭主要成员", key: "姓名", value: "张父" },
      { group: "基本信息", key: "手机", value: "13800000000" },
      { group: "基本信息", key: "姓名", value: "张三" }
    ]
  ).map((match) => [match.fieldId, match.value]));

  assert.equal(byId.get("own-name"), "张三");
  assert.equal(byId.has("emg"), false, "the applicant's own mobile is not an emergency contact number");
});

test("region: exam origin is never filled from native place", () => {
  const matches = helpers.buildRuleBasedMatches(
    [
      { fieldId: "a", label: "籍贯", inputType: "select", options: ["河南省"] },
      { fieldId: "b", label: "高考生源地", inputType: "select", options: ["河南省"] }
    ],
    [
      { group: "户籍与地区", key: "籍贯省", value: "河南省" },
      { group: "户籍与地区", key: "籍贯市", value: "南阳市" },
      { group: "户籍与地区", key: "高考生源地省", value: "河南省" }
    ]
  );

  const byId = new Map(matches.map((m) => [m.fieldId, m.value]));
  assert.equal(byId.get("a"), "河南省");
  assert.equal(byId.get("b"), "河南省");
  assert.ok(!matches.some((m) => m.value === "南阳市"));
});

// #429 一个级联框从省选到区县（content.js 给这类字段写 cascade）：简历里分开存的省、市、县拼成一条路径。
test("region: a cascader for 籍贯 gets province/city/county joined, from its own question only", () => {
  const resume = [
    { group: "户籍与地区", key: "籍贯省", value: "河南省" },
    { group: "户籍与地区", key: "籍贯市", value: "南阳市" },
    { group: "户籍与地区", key: "籍贯县", value: "南召县" },
    { group: "户籍与地区", key: "户口所在地省", value: "广东省" },
    { group: "户籍与地区", key: "户口所在地市", value: "深圳市" },
    { group: "户籍与地区", key: "高考生源地省", value: "湖北省" }
  ];
  const matches = helpers.buildRuleBasedMatches([
    { fieldId: "native", label: "籍贯", inputType: "select", options: [], cascade: true },
    { fieldId: "hukou", label: "户口所在地", inputType: "select", options: [], cascade: true },
    { fieldId: "origin", label: "高考生源地", inputType: "select", options: [], cascade: true }
  ], resume);
  const byId = new Map(matches.map((m) => [m.fieldId, m.value]));
  assert.equal(byId.get("native"), "河南省/南阳市/南召县");
  assert.equal(byId.get("hukou"), "广东省/深圳市");
  // 只有省：不拼，照原来填省。
  assert.equal(byId.get("origin"), "湖北省");
});

test("region: a cascader that names its own level, or a plain select, still takes one level", () => {
  const resume = [
    { group: "户籍与地区", key: "籍贯省", value: "河南省" },
    { group: "户籍与地区", key: "籍贯市", value: "南阳市" }
  ];
  assert.deepEqual(helpers.buildRuleBasedMatches(
    [{ fieldId: "a", label: "籍贯（省）", inputType: "select", options: [], cascade: true }], resume), [{ fieldId: "a", value: "河南省" }]);
  assert.deepEqual(helpers.buildRuleBasedMatches(
    [{ fieldId: "a", label: "籍贯", inputType: "select", options: ["河南省"] }], resume), [{ fieldId: "a", value: "河南省" }]);
});

test("region: a 户籍 group name does not turn 籍贯 into hukou", () => {
  const matches = helpers.buildRuleBasedMatches(
    [{ fieldId: "a", label: "籍贯", inputType: "select", options: ["河南省"] }],
    [{ group: "户籍与地区", key: "籍贯省", value: "河南省" }]
  );

  assert.deepEqual(matches, [{ fieldId: "a", value: "河南省" }]);
});

test("region: province, city and county each take their own level", () => {
  const matches = helpers.buildRuleBasedMatches(
    [
      { fieldId: "p", label: "户口所在地", placeholder: "请选择省", inputType: "select", options: ["河南省"] },
      { fieldId: "c", label: "户口所在地", placeholder: "请选择市", inputType: "select", options: ["南阳市"] },
      { fieldId: "d", label: "户口所在地", placeholder: "请选择区县", inputType: "select", options: ["南召县"] }
    ],
    [
      { group: "户籍与地区", key: "户口所在地省", value: "河南省" },
      { group: "户籍与地区", key: "户口所在地市", value: "南阳市" },
      { group: "户籍与地区", key: "户口所在地区县", value: "南召县" }
    ]
  );

  const byId = new Map(matches.map((m) => [m.fieldId, m.value]));
  assert.equal(byId.get("p"), "河南省");
  assert.equal(byId.get("c"), "南阳市");
  assert.equal(byId.get("d"), "南召县");
});

test("region: the 区 in 地区 is not a county level", () => {
  const matches = helpers.buildRuleBasedMatches(
    [{ fieldId: "p", label: "籍贯地区", inputType: "select", options: ["河南省"] }],
    [
      { group: "户籍与地区", key: "籍贯省", value: "河南省" },
      { group: "户籍与地区", key: "籍贯县", value: "南召县" }
    ]
  );

  assert.deepEqual(matches, [{ fieldId: "p", value: "河南省" }]);
});

// 工行把紧急联系人放在「个人基本信息」分组下，紧急联系人的姓名和电话曾被填成本人的。
test("person scope: emergency contact and parents never take the applicant's own values", () => {
  const resumeFields = [
    { group: "基本信息", key: "姓名", value: "张三" },
    { group: "基本信息", key: "手机", value: "13800000000" },
    { group: "联系方式", key: "紧急联系人姓名", value: "张父" },
    { group: "联系方式", key: "紧急联系人电话", value: "13700000000" },
    { group: "家庭主要成员", key: "父亲姓名", value: "张父" }
  ];
  const formFields = [
    { fieldId: "own-name", label: "真实姓名", inputType: "text", options: [] },
    { fieldId: "own-phone", label: "移动电话", inputType: "text", options: [] },
    { fieldId: "emg-name", label: "紧急联系人", placeholder: "请输入姓名", inputType: "text", options: [], group: "个人基本信息" },
    { fieldId: "emg-phone", label: "紧急联系人电话", inputType: "text", options: [], group: "个人基本信息" },
    { fieldId: "father-name", label: "请输入姓名", inputType: "text", options: [], group: "父亲" },
    { fieldId: "mother-name", label: "请输入姓名", inputType: "text", options: [], group: "母亲" }
  ];

  const byId = new Map(helpers.buildRuleBasedMatches(formFields, resumeFields).map((m) => [m.fieldId, m.value]));

  assert.equal(byId.get("own-name"), "张三");
  assert.equal(byId.get("own-phone"), "13800000000");
  assert.equal(byId.get("emg-name"), "张父");
  assert.equal(byId.get("emg-phone"), "13700000000");
  assert.equal(byId.get("father-name"), "张父");
  assert.equal(byId.has("mother-name"), false, "no mother data, so nothing, and certainly not the applicant or father");
});

test("person scope: an unspecified family member row gets neither the applicant nor a guessed relative", () => {
  const matches = helpers.buildRuleBasedMatches(
    [{ fieldId: "member", label: "姓名", inputType: "text", options: [], group: "家庭成员" }],
    [
      { group: "基本信息", key: "姓名", value: "张三" },
      { group: "家庭主要成员", key: "父亲姓名", value: "张父" }
    ]
  );

  assert.deepEqual(matches, []);
});

// 简历字段名认得出类别时只按名字算：手机号也是 8 到 18 位数字，纯数字的身份证号也像电话。
const ruleValues = (formFields, resumeFields) =>
  Object.fromEntries(helpers.buildRuleBasedMatches(formFields, resumeFields).map((m) => [m.fieldId, m.value]));
const textField = (fieldId, label, extra = {}) => ({ fieldId, label, inputType: "text", options: [], ...extra });

test("rules: a mobile listed before the ID number does not fill the ID field", () => {
  const byId = ruleValues(
    [textField("name", "姓名"), textField("id", "证件号码"), textField("phone", "手机"), textField("mail", "邮箱")],
    [
      { group: "基本信息", key: "姓名", value: "测试用户" },
      { group: "基本信息", key: "手机", value: "13800138000" },
      { group: "基本信息", key: "身份证号", value: "110101199003071234" },
      { group: "基本信息", key: "邮箱", value: "tester@example.com" }
    ]
  );

  assert.deepEqual(byId, { name: "测试用户", id: "110101199003071234", phone: "13800138000", mail: "tester@example.com" });
});

test("rules: an ID number listed before the mobile does not fill the phone field", () => {
  const byId = ruleValues(
    [textField("phone", "手机号码"), textField("id", "证件号码")],
    [
      { group: "基本信息", key: "证件号码", value: "110101199003071234" },
      { group: "联系方式", key: "手机号码", value: "13800138000" }
    ]
  );

  assert.deepEqual(byId, { phone: "13800138000", id: "110101199003071234" });
});

// 群里反映的手机号和身份证号填反：题目写着证件号码，name、id 或占位文字里却带着 mobile、phone、手机。
// 几样拼在一起找时电话排在证件号前面，这种框被认成了电话。以题目为准，题目认不出再依次看 aria-label、占位文字、name、id。
test("field kind goes by the question before the aria-label, placeholder, name and id", () => {
  const kind = (field) => helpers.inferFieldSemantic(field);
  assert.equal(kind({ label: "身份证号码", name: "mobile" }), "id_number");
  assert.equal(kind({ label: "证件号码", placeholder: "请输入手机号码" }), "id_number");
  assert.equal(kind({ label: "证件号码", idAttr: "contactPhone" }), "id_number");
  assert.equal(kind({ label: "证件号码", placeholder: "请输入手机号码", name: "mobile", idAttr: "contactPhone" }), "id_number");
  assert.equal(kind({ label: "身份证号码", ariaLabel: "请输入手机号码" }), "id_number");
  assert.equal(kind({ ariaLabel: "身份证号码", name: "mobile" }), "id_number");
  assert.equal(kind({ label: "手机号码", name: "idNumber", placeholder: "请输入身份证号" }), "phone");
  // 题目认不出时，依次看后面几样。
  assert.equal(kind({ label: "号码", ariaLabel: "身份证号", placeholder: "请输入手机号" }), "id_number");
  assert.equal(kind({ label: "号码", placeholder: "请输入身份证号", name: "mobile" }), "id_number");
  assert.equal(kind({ label: "号码", placeholder: "请输入手机号", name: "idNumber" }), "phone");
  assert.equal(kind({ label: "请填写", placeholder: "请输入", name: "idNumber", idAttr: "mobile" }), "id_number");
  assert.equal(kind({ name: "mobile", idAttr: "idNumber" }), "phone");
  assert.equal(kind({ idAttr: "mobile" }), "phone");
  assert.equal(kind({ label: "备注", placeholder: "选填" }), "");
});

// 「联系方式」是泛称：只靠它认成电话的，后面几样写明了邮箱就是邮箱，写明了手机就是手机，都没写才按电话。
// 后面认出的是别的类（name 是 contactName）不算，还按电话。
test("a 联系方式 question is a phone unless what follows says email", () => {
  const kind = (field) => helpers.inferFieldSemantic(field);
  assert.equal(kind({ label: "联系方式", placeholder: "请输入邮箱" }), "email");
  assert.equal(kind({ label: "联系方式", placeholder: "请输入手机号" }), "phone");
  assert.equal(kind({ label: "联系方式" }), "phone");
  assert.equal(kind({ label: "联系方式", ariaLabel: "联系方式", name: "email" }), "email");
  assert.equal(kind({ label: "联系方式", name: "contactName" }), "phone");
  assert.equal(kind({ label: "联系方式", name: "contactName", idAttr: "contactEmail" }), "email");
  // 同一样文字里泛称和明确的词都有，按明确的算。
  assert.equal(kind({ label: "联系方式（邮箱）", placeholder: "请输入手机号" }), "email");
  assert.equal(kind({ label: "联系方式/Email" }), "email");
  assert.equal(kind({ label: "联系方式（手机）", placeholder: "请输入邮箱" }), "phone");
  assert.equal(kind({ label: "联系电话", placeholder: "请输入邮箱" }), "phone");

  assert.deepEqual(ruleValues(
    [textField("contact", "联系方式", { placeholder: "请输入邮箱" }), textField("phone", "联系方式", { placeholder: "请输入手机号" })],
    [{ group: "基本信息", key: "手机号码", value: "13812345678" }, { group: "基本信息", key: "邮箱", value: "tester@example.com" }]
  ), { contact: "tester@example.com", phone: "13812345678" });
});

// 同一个原因：name 是 schoolName、majorName 的框，拼在一起找会先碰上「name」，认成姓名，本人的姓名填进了毕业学校。
test("a school or major question is not taken for the name because of its name attribute", () => {
  assert.equal(helpers.inferFieldSemantic({ label: "毕业学校", name: "schoolName" }), "school");
  assert.equal(helpers.inferFieldSemantic({ label: "所学专业", name: "majorName" }), "major");
  assert.deepEqual(ruleValues(
    [textField("school", "毕业学校", { name: "schoolName" }), textField("name", "姓名", { name: "realName" })],
    [{ group: "基本信息", key: "姓名", value: "测试用户" }, { group: "教育经历", key: "学校", value: "示例大学" }]
  ), { name: "测试用户" });
});

const MOBILE = "13812345678";
const ID_18 = "110101199003071233";

test("value validation keeps mobiles out of ID fields and 18-digit ID numbers out of phone fields", () => {
  const fields = [{ fieldId: "phone", label: "手机号码" }, { fieldId: "id", label: "身份证号码" }];
  const kept = (matches) => helpers.filterValidMatches(fields, matches);

  // AI 把两个值对调了，或本地认错了框。
  assert.deepEqual(kept([{ fieldId: "phone", value: ID_18 }, { fieldId: "id", value: MOBILE }]), []);
  assert.deepEqual(kept([{ fieldId: "phone", value: "110101 19900307 1233" }, { fieldId: "id", value: "138 1234 5678" }]), []);
  assert.deepEqual(kept([{ fieldId: "id", value: "8613812345678" }]), []);
  // 带短横的不当证件号：去掉短横就成了 8 到 18 位数字的座机、日期也不收；带短横的身份证号进不了手机框。
  assert.deepEqual(kept([
    { fieldId: "id", value: "010-12345678" }, { fieldId: "id", value: "2001-05-07" }, { fieldId: "id", value: "138-1234-5678" },
    { fieldId: "phone", value: "110101-19900307-1233" }
  ]), []);
  // AI 回的值不是字符串时照样核对，不抛错。
  assert.deepEqual(kept([{ fieldId: "id", value: 13812345678 }, { fieldId: "phone", value: null }, { fieldId: "id", value: undefined }]), []);
  assert.deepEqual(kept([{ fieldId: "phone", value: 13812345678 }]), [{ fieldId: "phone", value: 13812345678 }]);
  // 对的照旧收下：手机、座机、带 X 的身份证号，别的证件的 8 位号码。
  const right = [
    { fieldId: "phone", value: MOBILE }, { fieldId: "phone", value: "+86 138 1234 5678" }, { fieldId: "phone", value: "010-12345678" },
    { fieldId: "id", value: ID_18 }, { fieldId: "id", value: "11010519491231002X" }, { fieldId: "id", value: "12345678" }
  ];
  assert.deepEqual(kept(right), right);
});

test("rules: crossed name, id and placeholder attributes still put each number in its own field", () => {
  const forms = [
    textField("id", "证件号码", { name: "mobile", idAttr: "contactPhone", placeholder: "请输入手机号码" }),
    textField("phone", "手机号码", { name: "idcard" })
  ];
  const mine = [{ group: "基本信息", key: "手机号码", value: MOBILE }, { group: "基本信息", key: "身份证号", value: ID_18 }];
  const unnamed = [{ group: "补充字段", key: "号码1", value: MOBILE }, { group: "补充字段", key: "号码2", value: ID_18 }];

  for (const resume of [mine, [...mine].reverse(), unnamed, [...unnamed].reverse()]) {
    assert.deepEqual(ruleValues(forms, resume), { id: ID_18, phone: MOBILE }, resume.map((field) => field.key).join(","));
    assert.deepEqual(ruleValues([...forms].reverse(), resume), { id: ID_18, phone: MOBILE });
  }
});

test("rules: a named field of another kind is not taken for its look-alike value", () => {
  const byId = ruleValues(
    [textField("id", "身份证号"), textField("phone", "联系电话"), textField("gender", "性别"), textField("birth", "出生日期")],
    [
      { group: "基本信息", key: "姓名", value: "李亚男" },
      { group: "补充字段", key: "学位证书编号", value: "1028712023001234" },
      { group: "基本信息", key: "Mobile", value: "13800138000" },
      { group: "教育补充", key: "毕业时间", value: "2026-06" },
      { group: "实习经历", key: "示例科技实习经历-起止时间", value: "2023.06-2023.08" },
      { group: "基本信息", key: "性别", value: "女" },
      { group: "基本信息", key: "出生年月", value: "2001-05" },
      { group: "基本信息", key: "身份证号", value: "110101199003071234" }
    ]
  );

  assert.deepEqual(byId, { id: "110101199003071234", phone: "13800138000", gender: "女", birth: "2001-05" });
});

test("rules: keys the table cannot name are still matched by what the value looks like", () => {
  const byId = ruleValues(
    [textField("id", "证件号码"), textField("phone", "手机"), textField("gender", "性别"), textField("mail", "邮箱")],
    [
      { group: "补充字段", key: "号码1", value: "110101199003071234" },
      { group: "补充字段", key: "号码2", value: "13800138000" },
      { group: "补充字段", key: "Sex", value: "女" },
      { group: "联系方式", key: "电子邮件", value: "tester@example.com" }
    ]
  );

  assert.deepEqual(byId, { id: "110101199003071234", phone: "13800138000", gender: "女", mail: "tester@example.com" });
});

test("person scope: family and emergency numbers stay with their own person and kind", () => {
  const byId = ruleValues(
    [
      textField("own-phone", "手机号码"),
      textField("own-id", "证件号码"),
      textField("father-id", "身份证号", { group: "父亲" }),
      textField("father-phone", "联系电话", { group: "父亲" }),
      textField("member-phone", "联系电话", { group: "家庭成员" }),
      textField("emg-phone", "紧急联系人电话")
    ],
    [
      { group: "家庭主要成员", key: "父亲联系电话", value: "13900000000" },
      { group: "联系方式", key: "紧急联系人电话", value: "13700000000" },
      { group: "基本信息", key: "证件号码", value: "110101199003071234" },
      { group: "联系方式", key: "手机号码", value: "13800138000" }
    ]
  );

  assert.deepEqual(byId, {
    "own-phone": "13800138000",
    "own-id": "110101199003071234",
    "father-phone": "13900000000",
    "emg-phone": "13700000000"
  });
});

// 合并后模板字段排在「我的信息」前面：模板里的微信、QQ、学号、准考证号不能顶替「我的信息」里的手机和证件号码。
test("rules: other numbers in the template do not stand in for the profile's mobile and ID number", () => {
  const profile = require("../profile-fields.js");
  const mine = profile.profileToResumeFields({ values: { phone: "13800138000", idNumber: "110101199003071234" } });
  const forms = [textField("name", "姓名"), textField("phone", "手机号码"), textField("id", "证件号码"), textField("mail", "邮箱")];
  for (const other of [
    { key: "微信", value: "13911112222" },
    { key: "QQ", value: "123456789" },
    { key: "学号", value: "2019123456" },
    { key: "准考证号", value: "110105123456" }
  ]) {
    const resume = profile.mergeResumeFields([
      { group: "基本信息", key: "姓名", value: "测试用户" },
      { group: "基本信息", ...other },
      { group: "基本信息", key: "邮箱", value: "tester@example.com" }
    ], mine);

    assert.deepEqual(ruleValues(forms, resume),
      { name: "测试用户", phone: "13800138000", id: "110101199003071234", mail: "tester@example.com" }, other.key);
  }
});

// 英文简历的出生日期常写成 DOB：整个字段名是 DOB、D.O.B.、Born 才算，Adobe 不算；排在电话前也不进手机框。
test("rules: a DOB key fills the birth date and is not taken for the phone", () => {
  for (const key of ["DOB", "D.O.B.", "Born"]) {
    const byId = ruleValues(
      [textField("phone", "手机号码"), textField("birth", "出生日期"), textField("mail", "邮箱")],
      [
        { group: "Basic", key: "Adobe 认证", value: "2022.03" },
        { group: "Basic", key, value: "2001-05-07" },
        { group: "Basic", key: "Tel", value: "13800138000" },
        { group: "Basic", key: "E-mail", value: "tester@example.com" }
      ]
    );

    assert.deepEqual(byId, { phone: "13800138000", birth: "2001-05-07", mail: "tester@example.com" }, key);
  }
});

// 性别按值猜时整个值要像性别：模板里带「女」字的经历描述排在「我的信息」的性别前面，也不进性别框。
test("rules: a description that mentions 女 is not taken for the gender", () => {
  const profile = require("../profile-fields.js");
  const resume = profile.mergeResumeFields([
    { group: "基本信息", key: "姓名", value: "测试用户" },
    { group: "实习经历", key: "示例服饰实习经历-工作内容", value: "负责女装线上店铺的商品上新" }
  ], profile.profileToResumeFields({ values: { gender: "女" } }));

  assert.deepEqual(ruleValues([textField("name", "姓名"), textField("gender", "性别")], resume), { name: "测试用户", gender: "女" });
});

// 字段名认得出类别时分组名也不算：「证件信息」下的准考证号、「手机与微信」下的微信、「姓名与性别」下的姓名排在前面，
// 都不能因为分组名填进证件号码、手机、性别。字段名认不出的「号码1」照旧看分组名和值。
test("rules: a group name does not turn a named field of another kind into the ID, phone or gender", () => {
  const forms = [textField("gender", "性别"), textField("name", "姓名"), textField("id", "证件号码"), textField("phone", "手机号码")];
  assert.deepEqual(ruleValues(forms, [
    { group: "证件信息", key: "准考证号", value: "110105123456" },
    { group: "证件信息", key: "身份证号", value: "110101199003071234" },
    { group: "手机与微信", key: "微信", value: "13911112222" },
    { group: "手机与微信", key: "手机", value: "13800138000" },
    { group: "姓名与性别", key: "姓名", value: "李亚男" },
    { group: "姓名与性别", key: "性别", value: "女" }
  ]), { gender: "女", name: "李亚男", id: "110101199003071234", phone: "13800138000" });

  assert.deepEqual(ruleValues([textField("id", "证件号码"), textField("phone", "手机号码")], [
    { group: "证件信息", key: "号码1", value: "110101199003071234" },
    { group: "手机与微信", key: "号码1", value: "13800138000" }
  ]), { id: "110101199003071234", phone: "13800138000" });
  // 7 位的固话按值认不出（按值要 8 位以上），只能靠分组名。
  assert.deepEqual(ruleValues([textField("phone", "联系电话")], [{ group: "联系电话", key: "号码1", value: "6123456" }]), { phone: "6123456" });
});

// 字段名自己带着「证件」「手机」「电话」就算：「证件编号」里的「编号」、「手机/邮箱」里的「邮箱」不能把它挡在外面。
test("rules: a key that names the ID or mobile itself fills it even if it also reads as another kind", () => {
  const forms = [textField("id", "证件号码"), textField("phone", "手机号码")];
  for (const key of ["证件编号", "证件账号", "证件卡号"]) {
    assert.deepEqual(ruleValues(forms, [
      { group: "基本信息", key, value: "110101199003071234" },
      { group: "联系方式", key: "手机", value: "13800138000" }
    ]), { id: "110101199003071234", phone: "13800138000" }, key);
  }
  for (const key of ["手机/邮箱", "邮箱/手机", "电话/邮箱"]) {
    assert.deepEqual(ruleValues(forms, [
      { group: "联系方式", key, value: "13800138000" },
      { group: "基本信息", key: "身份证号", value: "110101199003071234" }
    ]), { id: "110101199003071234", phone: "13800138000" }, key);
  }
});

// 字段名认不出、只能按值猜时，长得明确是手机号的不算证件号，长得明确是身份证号的不算电话：
// 「号码1」「号码2」不管谁排前面、网页先问哪一题，都不互相顶替。
test("rules: unnamed keys holding a mobile and an ID number do not swap in either order", () => {
  const mobile = { group: "补充字段", key: "号码1", value: "13800138000" };
  const idNumber = { group: "补充字段", key: "号码2", value: "11010119900307123X" };
  const plainId = { group: "补充字段", key: "号码2", value: "110101199003071234" };
  for (const resume of [[mobile, idNumber], [idNumber, mobile], [mobile, plainId], [plainId, mobile]]) {
    const id = resume.find((item) => item !== mobile).value;
    for (const forms of [
      [textField("id", "证件号码"), textField("phone", "手机号码")],
      [textField("phone", "手机号码"), textField("id", "证件号码")]
    ]) {
      assert.deepEqual(ruleValues(forms, resume), { id, phone: "13800138000" }, `${resume.map((r) => r.value)} / ${forms.map((f) => f.fieldId)}`);
    }
  }
  // 两样都说不准的号码照旧按值猜。
  assert.deepEqual(ruleValues([textField("phone", "联系电话")], [{ group: "补充字段", key: "Tel", value: "010-62345678" }]), { phone: "010-62345678" });
  assert.deepEqual(ruleValues([textField("id", "证件号码")], [{ group: "补充字段", key: "号码1", value: "12345678" }]), { id: "12345678" });
});

// 姓名和出生日期也只看字段名：分组「姓名与性别」下排在前面的性别不进姓名框，
// 分组名带「出生」的毕业时间不进出生日期框。字段名认不出的才看分组名。
test("rules: a group name does not turn a named field of another kind into the name or birth date", () => {
  assert.deepEqual(ruleValues([textField("name", "姓名"), textField("gender", "性别")], [
    { group: "姓名与性别", key: "性别", value: "女" },
    { group: "姓名与性别", key: "姓名", value: "李亚男" }
  ]), { name: "李亚男", gender: "女" });
  assert.deepEqual(ruleValues([textField("birth", "出生日期")], [
    { group: "出生与毕业", key: "毕业时间", value: "2023-06" },
    { group: "基本信息", key: "出生年月", value: "2001-05" }
  ]), { birth: "2001-05" });
  // 字段名是 schoolName 这类认作「姓名」以外类别的，分组带「姓名」也不算；认不出的「中文」照旧按分组名。
  assert.deepEqual(ruleValues([textField("name", "姓名")], [
    { group: "姓名", key: "性别", value: "女" },
    { group: "姓名", key: "中文", value: "李亚男" }
  ]), { name: "李亚男" });
});

// 以前政治面貌、学历、学位、年月这类下拉框被挡在 AI 外面，本地规则又不处理，永远填不上。
// 证件类型现在由本地规则按资料和号码填（#429），见下面的 id_type 用例。
test("worker: choice fields the rules cannot fill are sent to AI with their options", async () => {
  let body = null;
  const worker = loadWorker((request) => { body = request; });

  const result = await worker.handleAiFill({
    formFields: [
      { fieldId: "f1", label: "政治面貌", inputType: "select", tagName: "select", options: ["共青团员", "群众"] },
      { fieldId: "f2", label: "最高学历", inputType: "select", tagName: "select", options: ["大学本科", "硕士研究生"] },
      { fieldId: "f3", label: "出生年份", inputType: "select", tagName: "select", options: ["2005", "2006"] }
    ],
    resumeFields: [
      { group: "基本信息", key: "政治面貌", value: "共青团员" },
      { group: "教育背景", key: "最高学历", value: "大学本科" },
      { group: "基本信息", key: "出生年月", value: "2005-09" }
    ]
  });

  assert.equal(result.diagnostics.aiFields, 3);
  const prompt = body.user;
  for (const text of ["政治面貌", "最高学历", "出生年份", "共青团员"]) {
    assert.ok(prompt.includes(text), `${text} should reach the prompt`);
  }
});

test("worker: a rule value the field cannot accept does not count as matched", async () => {
  let body = null;
  const worker = loadWorker((request) => { body = request; });

  const result = await worker.handleAiFill({
    formFields: [{ fieldId: "g", label: "Gender", inputType: "select", tagName: "select", options: ["Herr", "Frau"] }],
    resumeFields: [{ group: "基本信息", key: "性别", value: "男" }, { group: "基本信息", key: "姓名", value: "测试用户" }]
  });

  assert.equal(result.diagnostics.ruleMatches, 0);
  assert.equal(result.diagnostics.aiFields, 1);
  // #429 第 11 项：没有一项资料填得进选项的下拉不发给 AI，记作没有对应的资料。
  assert.equal(body, null);
  assert.equal(result.diagnostics.skippedNoContext, 1);
});

test("worker: an English gender select takes M or F for 男 or 女", async () => {
  const result = await loadWorker(() => {}).handleAiFill({
    formFields: [{ fieldId: "g", label: "Gender", inputType: "select", tagName: "select", options: ["M", "F"] }],
    resumeFields: [{ group: "基本信息", key: "性别", value: "女" }]
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result.matches)), [{ fieldId: "g", value: "F" }]);
  // M、F 不是全局的同义写法：只在问性别的字段上换（choiceValue）。
  assert.equal(helpers.findSelectOptionIndex(["M", "F"], "女"), -1);
  assert.equal(helpers.choiceValue({ label: "Sex", inputType: "radio", options: ["M", "F"] }, "男"), "M");
  assert.equal(helpers.choiceValue({ label: "T恤尺码", inputType: "select", options: ["S", "M", "L"] }, "男"), "男");
});

test("sex counts as a gender question only as a whole word, not inside Middlesex or Essex", async () => {
  assert.equal(helpers.inferFieldSemantic({ label: "Sex", inputType: "radio", options: ["M", "F"] }), "gender");
  assert.notEqual(helpers.inferFieldSemantic({ label: "Middlesex", inputType: "text" }), "gender");
  assert.notEqual(helpers.inferFieldSemantic({ label: "Essex campus address", inputType: "text" }), "gender");
  const result = await loadWorker(() => {}).handleAiFill({
    formFields: [{ fieldId: "school", label: "Middlesex", inputType: "text" }, { fieldId: "address", label: "Essex campus address", inputType: "text" }],
    resumeFields: [{ group: "基本信息", key: "性别", value: "男" }]
  });
  assert.equal(result.diagnostics.ruleMatches, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(result.matches)), []);
});

// #429 身份证号自检：校验码、出生日期和开头。号码都是按规则算出来的虚构号码。
test("idNumberInfo checks the check digit, the birth date and the leading code", () => {
  const info = helpers.idNumberInfo;
  assert.deepEqual(info("11010519491231002X"), { valid: true, kind: "resident" });
  assert.deepEqual(info("11010519491231002x"), { valid: true, kind: "resident" });
  assert.deepEqual(info("110105 19491231 002X"), { valid: true, kind: "resident" });
  assert.deepEqual(info("44030620050712003X"), { valid: true, kind: "resident" });
  assert.deepEqual(info("810000199408230021"), { valid: true, kind: "hkmo" });
  assert.deepEqual(info("820000200002290021"), { valid: true, kind: "hkmo" }, "2000-02-29 is a real day");
  assert.deepEqual(info("830000199201300022"), { valid: true, kind: "tw" });
  assert.deepEqual(info("911840199001010018"), { valid: true, kind: "foreign" });
  // 校验码错、日期不存在、还没到的日期、开头不是省级代码。
  assert.deepEqual(info("110105194912310021"), { valid: false, kind: "" });
  assert.deepEqual(info("110105200002300015"), { valid: false, kind: "" });
  assert.deepEqual(info("11010520991231002X"), { valid: false, kind: "" });
  assert.deepEqual(info("710000199001010015"), { valid: false, kind: "" });
  // 出生日期按本地的年月日和今天比：今天出生的算数，明天的不算。
  const W = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const withCheck = (body) => body + "10X98765432"[[...body].reduce((sum, digit, i) => sum + W[i] * Number(digit), 0) % 11];
  const ymd = (date) => `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
  const now = new Date();
  assert.equal(info(withCheck(`110105${ymd(now)}001`)).valid, true);
  assert.equal(info(withCheck(`110105${ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))}001`)).valid, false);
  // 不是 18 位的不判：15 位一代证、护照、通行证。
  for (const value of ["110105491231002", "E12345678", "H12345678", "", null]) assert.equal(info(value), null, String(value));
});

test("residence permits fall back to the joint option only when the page has no separate one", () => {
  const pick = (texts, value) => { const index = helpers.findSelectOptionIndex(options(texts), value); return index < 0 ? null : texts[index]; };
  assert.equal(pick(["居民身份证", "港澳台居民居住证"], "港澳居民居住证"), "港澳台居民居住证");
  assert.equal(pick(["居民身份证", "港澳台居民居住证"], "台湾居民居住证"), "港澳台居民居住证");
  assert.equal(pick(["港澳居民居住证", "台湾居民居住证", "港澳台居民居住证"], "台湾居民居住证"), "台湾居民居住证");
  // 合写的要分到港澳还是台湾看不出来，不选。
  assert.equal(pick(["港澳居民居住证", "台湾居民居住证"], "港澳台居民居住证"), null);
  assert.equal(pick(["护照", "外国人永久居留证"], "外国人永久居留身份证"), "外国人永久居留证");
  assert.equal(pick(["护照", " 港澳台居民居住证 "], "港澳居民居住证"), " 港澳台居民居住证 ");
});

const idTypeField = (texts, extra = {}) => ({ fieldId: "type", label: "证件类型", inputType: "select", tagName: "select", options: options(texts), ...extra });
const idResume = (type, number) => [
  ...(type ? [{ group: "基本信息", key: "证件类型", value: type }] : []),
  ...(number ? [{ group: "基本信息", key: "证件号码", value: number }] : [])
];
const idTypeMatch = (field, resume) => helpers.buildRuleBasedMatches([field], resume).find((match) => match.fieldId === field.fieldId);

test("id type: without a stated type the number picks the option", () => {
  const all = ["请选择", "身份证", "护照", "港澳居民居住证", "台湾居民居住证", "港澳台居民居住证"];
  assert.deepEqual(idTypeMatch(idTypeField(all), idResume("", "11010519491231002X")), { fieldId: "type", value: "居民身份证" });
  assert.deepEqual(idTypeMatch(idTypeField(all), idResume("", "810000199408230021")), { fieldId: "type", value: "港澳居民居住证" });
  assert.deepEqual(idTypeMatch(idTypeField(all), idResume("", "830000199201300022")), { fieldId: "type", value: "台湾居民居住证" });
  // 选项只有合写的「港澳台居民居住证」：填分写的名字，选的时候落到合写那项。选项读不到（自定义下拉）时也填分写的。
  const joint = idTypeField(["居民身份证", "护照", "港澳台居民居住证"]);
  const jointValue = idTypeMatch(joint, idResume("", "810000199408230021")).value;
  assert.equal(jointValue, "港澳居民居住证");
  assert.equal(helpers.findSelectOptionIndex(joint.options, jointValue), 2);
  assert.equal(idTypeMatch(idTypeField([], { tagName: "input" }), idResume("", "830000199201300022")).value, "台湾居民居住证");
  assert.equal(idTypeMatch(idTypeField(["身份证", "护照", "外国人永久居留证"]), idResume("", "911840199001010018")).value, "外国人永久居留身份证");
  // 号码没过校验、看不出类型，或选项里没有这一类：不填。
  assert.equal(idTypeMatch(idTypeField(all), idResume("", "110105194912310021")), undefined);
  assert.equal(idTypeMatch(idTypeField(all), idResume("", "E12345678")), undefined);
  assert.equal(idTypeMatch(idTypeField(["身份证", "护照"]), idResume("", "810000199408230021")), undefined);
  // 「身份证件类型」也是证件类型；号码框的占位文字提到证件类型的照旧是号码框。
  assert.equal(idTypeMatch(idTypeField(all, { label: "身份证件类型" }), idResume("", "11010519491231002X")).value, "居民身份证");
  assert.deepEqual(ruleValues([textField("no", "证件号码", { placeholder: "请先选择证件类型" })], idResume("居民身份证", "11010519491231002X")),
    { no: "11010519491231002X" });
});

test("id type: a stated type wins, and one the number contradicts is blocked instead of filled", () => {
  const all = ["身份证", "护照", "港澳居民来往内地通行证", "港澳台居民居住证", "其他"];
  assert.deepEqual(idTypeMatch(idTypeField(all), idResume("居民身份证", "11010519491231002X")), { fieldId: "type", value: "居民身份证" });
  assert.deepEqual(idTypeMatch(idTypeField(all), idResume("护照", "E12345678")), { fieldId: "type", value: "护照" });
  assert.deepEqual(idTypeMatch(idTypeField(all), idResume("护照", "")), { fieldId: "type", value: "护照" });
  assert.deepEqual(idTypeMatch(idTypeField(all), idResume("居民身份证", "110105194912310021")), { fieldId: "type", value: "居民身份证" },
    "a number that fails the check says nothing about the type");
  assert.deepEqual(idTypeMatch(idTypeField(all), idResume("居民身份证", "810000199408230021")),
    { fieldId: "type", value: "居民身份证", blocked: "id_type_mismatch" });
  assert.deepEqual(idTypeMatch(idTypeField(all), idResume("港澳居民来往内地通行证", "11010519491231002X")),
    { fieldId: "type", value: "港澳居民来往内地通行证", blocked: "id_type_mismatch" });
  // 「我的信息」没有居住证可选，选了「其他」的按号码选；选项里也没有就填「其他」。持居民身份证却选「其他」的算对不上。
  assert.equal(idTypeMatch(idTypeField(all), idResume("其他", "830000199201300022")).value, "台湾居民居住证", "lands on the joint option");
  assert.equal(idTypeMatch(idTypeField(["身份证", "护照", "其他"]), idResume("其他", "830000199201300022")).value, "其他");
  assert.equal(idTypeMatch(idTypeField(all), idResume("其他", "11010519491231002X")).blocked, "id_type_mismatch");
  // 认得出的写法才比：同义写法、括号里的补充照样对得上；港澳和台湾的居住证不互认；认不出的写法照资料填。
  assert.deepEqual(idTypeMatch(idTypeField(all), idResume("居民身份证（二代）", "11010519491231002X")), { fieldId: "type", value: "居民身份证（二代）" });
  assert.equal(idTypeMatch(idTypeField(all), idResume("台胞证", "11010519491231002X")).blocked, "id_type_mismatch");
  assert.equal(idTypeMatch(idTypeField(all), idResume("台湾居民居住证", "810000199408230021")).blocked, "id_type_mismatch");
  assert.equal(idTypeMatch(idTypeField(all), idResume("港澳居民居住证", "830000199201300022")).blocked, "id_type_mismatch");
  assert.deepEqual(idTypeMatch(idTypeField(all), idResume("港澳台居民居住证", "830000199201300022")), { fieldId: "type", value: "港澳台居民居住证" });
  assert.deepEqual(idTypeMatch(idTypeField(all), idResume("港澳台居住证", "810000199408230021")), { fieldId: "type", value: "港澳台居住证" });
  assert.deepEqual(idTypeMatch(idTypeField(all), idResume("居民身份证 (二代)", "11010519491231002X")), { fieldId: "type", value: "居民身份证 (二代)" });
  // 资料写合写的居住证、选项分开写：按号码选分写的那项。
  const split = idTypeField(["居民身份证", "港澳居民居住证", "台湾居民居住证"]);
  assert.deepEqual(idTypeMatch(split, idResume("港澳台居民居住证", "830000199201300022")), { fieldId: "type", value: "台湾居民居住证" });
  assert.equal(idTypeMatch(idTypeField(["身份证", "护照", "其它"]), idResume("其它", "810000199408230021")).value, "其它");
  assert.equal(idTypeMatch(idTypeField(all), idResume("其它", "810000199408230021")).value, "港澳居民居住证");
  // 号码框填的是排在前面的那条（纯数字的护照号），不拿后面的身份证号来比；字母开头的护照号进不了号码框，号码框填的是身份证号。
  const both = (first, second) => [{ group: "基本信息", key: "证件类型", value: "护照" },
    { group: "基本信息", key: "证件号码", value: first }, { group: "基本信息", key: "身份证号", value: second }];
  assert.deepEqual(idTypeMatch(idTypeField(all), both("123456789", "11010519491231002X")), { fieldId: "type", value: "护照" });
  assert.equal(idTypeMatch(idTypeField(all), both("E12345678", "11010519491231002X")).blocked, "id_type_mismatch");
  // 字段名认不出（「号码1」）的号码照样按值认作证件号，和号码框一样。
  assert.equal(idTypeMatch(idTypeField(["身份证", "港澳台居民居住证"]), [{ group: "基本信息", key: "号码1", value: "810000199408230021" }]).value, "港澳居民居住证");
  // 同一张表上：号码框填的就是拿来比的那条。
  for (const [first, type, number] of [["123456789", { value: "护照" }, "123456789"], ["E12345678", { value: "护照", blocked: "id_type_mismatch" }, "11010519491231002X"]]) {
    const matches = helpers.buildRuleBasedMatches([idTypeField(all), textField("no", "证件号码")], both(first, "11010519491231002X"));
    assert.deepEqual(matches, [{ fieldId: "type", ...type }, { fieldId: "no", value: number }], first);
    // 号码框排在前面也一样。
    const reversed = helpers.buildRuleBasedMatches([textField("no", "证件号码"), idTypeField(all)], both(first, "11010519491231002X"));
    assert.deepEqual(reversed, [{ fieldId: "no", value: number }, { fieldId: "type", ...type }], `${first} reversed`);
  }
  // 紧急联系人的证件类型不用本人的资料。
  assert.equal(idTypeMatch(idTypeField(all, { group: "紧急联系人" }), idResume("", "11010519491231002X")), undefined);
});

test("id type: a blocked match survives the validity filter and keeps the field away from the AI", async () => {
  const field = idTypeField(["身份证", "港澳台居民居住证"]);
  const resume = idResume("护照", "810000199408230021");
  const profile = require("../profile-fields.js");
  // 资料写的「护照」选项里没有，也照样留着，填写时报出来。
  assert.deepEqual(helpers.localRuleMatches([field], resume, profile), [{ fieldId: "type", value: "护照", blocked: "id_type_mismatch" }]);
  let body = null;
  const worker = loadWorker((request) => { body = request; });
  const result = await worker.handleAiFill({ formFields: [field, { fieldId: "major", label: "专业", inputType: "text", options: [] }],
    resumeFields: [...resume, { group: "教育背景", key: "专业", value: "示例专业" }] });
  assert.deepEqual(JSON.parse(body.user.split("\n")[1]).map((item) => item.label), ["专业"], "the type field is not sent to the AI");
  assert.deepEqual(JSON.parse(JSON.stringify(result.matches)), [{ fieldId: "type", value: "护照", blocked: "id_type_mismatch" }]);
});
