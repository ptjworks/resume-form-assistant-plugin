// #301：报告里能出现的每一项都要写在隐私政策「错误报告与手动反馈」那一节里，告知也要提到这次新增的内容。
// 新加一个诊断键而没有在这里指到政策里的说法，这个测试就失败：要么补政策，要么补这张表。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../extension/feedback-core.js");

const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const policy = read("docs/privacy-policy.md");
const section = policy.slice(policy.indexOf("## 错误报告与手动反馈"), policy.indexOf("## 可选手动云备份与恢复"));

// Each key the page may put into a report, and the words the policy uses for it.
const KEYS = {
  url_path: "网址路径", page_type: "是否判断为网申填写页", page_type_reason: "判断依据", dom_ready_at_scan: "扫描时页面是否已加载完",
  scan_duration_ms: "扫描耗时", entry: "这次从哪里开始", page_focused: "开始时网页是否在前台",
  dom_inputs: "页面上的输入框", visible_fields: "可见可填", candidates: "进入匹配", matched: "匹配到", filled: "填上的数量",
  drop_reasons: "各步丢掉的数量和原因", label_sources: "字段名的取法", offer_skipped: "「加到我的信息」没问的数量",
  dom_elements: "页面元素总数", iframes_total: "内嵌框架", iframes_cross_origin: "其中跨域的数量", same_origin_iframe_inputs: "同源框架里的输入框",
  shadow_roots_with_inputs: "含输入框的 Shadow DOM", custom_controls: "自定义控件", custom_libraries: "组件库",
  readonly_or_disabled: "只读或禁用输入框", edit_buttons: "「编辑」按钮",
  error_category: "错误类别", first_failing_stage: "失败阶段", error_code: "错误码",
  local_matches: "本地和 AI 各匹配了几个", ai_fields: "送 AI 的字段数", ai_called: "是否调用了 AI", ai_tier: "所用模型档位",
  ai_matches: "本地和 AI 各匹配了几个", ai_latency_ms: "AI 耗时", ai_first_byte_ms: "首字节耗时", ai_timeout_stage: "AI 超时卡在哪一步",
  resume_fields: "简历字段", resume_candidates: "候选字段",
  prompt_bytes: "提示词字节数", timings_ms: "各阶段耗时", reasons: "全部没填上的字段另按失败原因码分别计数", unlisted: "其余只计数",
  // #497
  ai_missed: "按字段类别计数", ai_missed_in_resume: "标出你的资料里有没有这一类", ai_missed_with_data: "其中资料里有这一类的字段数",
  exception_type: "扫描出错时另带异常类型", error_property: "读的是哪个属性",
  job_company_source: "公司和岗位名分别从哪里读到", job_title_source: "公司和岗位名分别从哪里读到", job_missing: "还缺哪一项",
  job_ai_called: "是否调用了 AI 识别", job_ai_code: "结果码", job_end: "这次保存怎样结束"
};
const SECTIONS = { 页面: "- 页面：", 填写: "- 填写方式：", 字段漏斗: "- 字段计数：", 页面结构: "- 页面结构：", 错误: "错误类别、失败阶段和错误码",
  匹配: "- 匹配：", 性能: "- 各阶段耗时", AI未匹配: "- AI 没匹配上的字段", 未填字段: "- 没填上的字段", 岗位: "岗位流程的固定代码" };
// [未填字段] tokens: control structure, the reason code, the popup and whether it had any option.
const TOKENS = { tag: "标签名", type: "类型", role: "role", popup: "控件结构", readonly: "控件结构", picker: "控件结构", lib: "组件库",
  reason: "失败原因码", opened: "弹层有没有出现", options: "里面有没有选项（不含选项个数", inputmode: "输入方式 inputmode",
  after: "框里剩下的是空的、原来的内容还是别的内容（不含内容本身）", overlay: "填写后 1 秒内有没有冒出建议框或别的弹层",
  // #497 What the control is and how its popup waited.
  form: "控件的种类", search: "能不能搜索", remote: "选项是不是从后台加载", multi: "单选还是多选", ver: "组件库的大版本",
  open_ms: "点开后多久弹出", wait_ms: "一共等了多久", spinner: "最后是否还在加载" };
// The worker's [来源] lines.
const SOURCE = { app_version: "版本", os: "系统", install: "安装方式", build: "构建标识", host: "域名" };

test("every diagnostic key and section is named in the privacy policy", () => {
  assert.notEqual(section.length, 0);
  assert.deepEqual(Object.keys(KEYS).sort(), [...core.VALUE_KEYS].sort(), "a key was added or removed: map it to the policy's words");
  assert.deepEqual(Object.keys(SECTIONS).sort(), [...core.SECTION_NAMES].sort());
  for (const [key, words] of Object.entries({ ...KEYS, ...SECTIONS, ...TOKENS, ...SOURCE })) {
    assert.ok(section.includes(words), `${key}: the policy does not say 「${words}」`);
  }
});

test("the worker's [来源] lines and the unfilled-control tokens are the ones listed above", async () => {
  const { createFeedback } = await import("../extension/link/feedback.mjs");
  const data = {};
  const worker = createFeedback({ storage: { get: async () => structuredClone(data), set: async value => Object.assign(data, structuredClone(value)) },
    version: "0.4.5", os: "Windows / Chrome 140", install: () => "normal", fetchImpl: async () => new Response("{}") });
  await worker.ready();
  const text = worker.preview({ description: "" }, "jobs.example.test").user_description;
  const source = text.slice(text.indexOf("[来源]") + 5).trim().split("\n").map(line => line.split(":")[0]);
  assert.deepEqual(source, Object.keys(SOURCE));
  const report = core.fillReport({ fieldCount: 1, unfilledControls: [{ label: "学历", reasonCode: "no_option_match", observed: { opened: "listbox", hasOptions: true },
    form: { form: "dropdown", search: true, remote: false, multi: false, version: "antd4", openMs: 120, waitMs: 2300, spinner: false },
    control: { tag: "input", type: "text", role: "combobox", readOnly: true, picker: "antd", library: "antd", popup: "listbox" } },
  { label: "出生年月", reasonCode: "value_reverted", observed: { after: "empty", overlay: "none" }, control: { tag: "input", type: "text", inputMode: "numeric" } }] });
  const tokens = report.split("\n").filter(line => /^- (?:学历|出生日期): /.test(line)).flatMap(line => line.replace(/^- [^:]+: /, "").split(" "))
    .map(token => /^[a-z]+\[/.test(token) ? ["tag", "type"] : token.split("=")[0]).flat();
  assert.deepEqual([...new Set(tokens)].sort(), Object.keys(TOKENS).sort());
  // Every keyed token CONTROL_TOKEN accepts (role=, lib=, opened=...), read from its source, so a
  // token that only some other input produces is caught too.
  const definition = read("extension/feedback-core.js").match(/const CONTROL_TOKEN = new RegExp\(([\s\S]*?)\);\r?\n/)[1];
  const keyed = [...definition.matchAll(/(?:\(\?:([a-z_|]+)\)|(?<![a-z_])([a-z_]+))=/g)].flatMap(match => (match[1] || match[2]).split("|"));
  assert.ok(keyed.includes("opened") && keyed.includes("lib"), keyed.join());
  assert.deepEqual([...new Set(keyed)].sort(), Object.keys(TOKENS).filter(key => !["tag", "type", "readonly"].includes(key)).sort());
});

test("the notice names what reports now carry, and when they are sent", () => {
  const ui = read("extension/feedback-ui.js");
  const notice = ui.slice(ui.indexOf("const explanation"), ui.indexOf("if (compact && noticeRoot)"));
  for (const words of ["AI 请求失败", "安装方式", "从哪里开始填写", "网页当时是否在前台", "有没有弹出、里面有没有选项", "模型档位", "多久开始回复",
    "没写上的输入框后来是空的还是被改了", "写入后有没有冒出建议框或别的弹层", "没填上的字段各是什么原因",
    "保存岗位的过程", "不含公司和岗位名",
    // #497
    "资料里有、AI 却没匹配上的字段有 3 项以上", "读的是哪个属性", "构建标识", "没填上的字段属于哪一类", "是哪种控件", "能不能搜索",
    "选项是不是从后台加载", "单选还是多选", "组件库的大版本", "点开后多久弹出", "一共等了多久", "最后是否还在加载",
    "AI 没匹配上的字段各是哪一类和你的资料里有没有这一类", "第二部分只用于我们排查问题，不公开", "题目原文", "所在分组的标题",
    "页面上的选项列表（级联选择只看第一列，插件输入过搜索词之后的列表不收，插件这次已经选过别的下拉、或填过学校和专业这类框之后才点开的列表和地区下拉也不收）", "出错字段附近的页面结构",
    "代码异常的原文（中文、引号里的内容和长数字都换掉，只留英文的报错文字）",
    "也不标出插件想选的是哪一项", "Cloudflare 上的数据中转服务", "存放在境外", "最多保存 90 天", "第二部分和安装编号不会公开",
    "开启了自动错误报告时，附上的诊断和自动报告一样有两部分，预览里都能看到"]) {
    assert.ok(notice.includes(words), words);
  }
  // Whether a list had options, never how many (#301): neither text speaks of a number of options.
  for (const [name, text] of [["notice", notice], ["policy", section]]) {
    assert.doesNotMatch(text, /几个选项|选项的?数量|项数/, name);
  }
  // A city select of its own lists what the page loaded for the province picked before it, and that list
  // is the one looked at: the policy only promises the cascader's first column and lists before typing.
  assert.doesNotMatch(section, /上一级之后/);
  assert.ok(section.includes("级联选择只看第一列，插件输入过搜索词之后的列表不看"));
  // The policy says the same about when a report is sent and that the user is asked again.
  for (const words of ["AI 请求失败", "即使匹配到的字段都填上了也会上报", "报告内容增加时，之前的同意同样不算数，会重新询问"]) {
    assert.ok(section.includes(words), words);
  }
});

// #497 The private layer, where reports are kept, and the new trigger: the policy says each of them, and no address.
test("the policy names the private layer, where reports are kept and the ai_missed trigger, and gives no address", () => {
  for (const words of ["不公开的部分", "题目原文", "所在分组的标题", "页面上的选项列表", "出错字段附近的页面结构", "代码异常的原文",
    "保留 90 天，到期自动删除，只用于我们排查问题，不写进 GitHub issue，也不公开", "不标出插件想选的是哪一项",
    "插件已经选过别的下拉或单选、或者填过学校、专业、公司、地区这类文本框之后才点开的列表也不收", "原文只留英文的报错文字", "没加引号的英文单词会留下", "地区题只收级联选择的第一列，别的地区下拉都不收",
    "发到我们在 Cloudflare 上的数据中转服务，存放在境外", "资料里有这一类、AI 看过却没匹配上的字段达到 3 项时，即使别的字段都填上了也会上报",
    "只有资料里有、AI 却没匹配上的", "没有同意当前说明时，手动反馈只带这次更新之前的诊断内容，不带不公开的部分"]) {
    assert.ok(section.includes(words), words);
  }
  assert.doesNotMatch(policy, /workers\.dev|19991107\.xyz\/feedback|https:\/\/[^\s`]*\/v1\/activity/);
  // The private layer's own markers: the header and the sections the policy speaks of.
  const text = core.privateReport({ unfilled: [{ label: "最高学历", section: "教育信息", kind: "学历", reasonCode: "no_option_match", options: ["本科", "硕士"] }],
    missed: [{ label: "毕业院校", section: "教育信息", kind: "学校", inResume: true }], outline: "[区块] 教育信息\n> e1 combobox ← 最高学历",
    exception: { name: "TypeError", message: "Cannot read properties of undefined (reading 'style')" } });
  assert.equal(text.split("\n")[0], core.PRIVATE_HEADER);
  for (const name of ["[异常]", "[未填字段 1]", "[AI未匹配 1]", "[页面大纲]"]) assert.ok(text.includes(name), name);
});

// #497 Report kinds: one table for reports only, covering the field names reports used to show and every kind local
// matching knows (FIELD_SEMANTICS in ai-helpers.js, read from its source so a new one is caught).
test("the report's field kinds cover the old allowlist and every kind local matching knows", () => {
  const legacy = { 姓名: "姓名", 性别: "性别", 出生年月: "出生日期", 手机: "手机", 手机号: "手机", 邮箱: "邮箱", 学历: "学历", 学位: "学位",
    学校: "学校", 专业: "专业", 毕业时间: "毕业时间", 参加工作时间: "参加工作时间", 现居住地: "现居住地", 当前城市: "现居住地",
    求职状态: "求职状态", 工作经历: "工作经历", 教育经历: "教育经历" };
  for (const [label, kind] of Object.entries(legacy)) assert.equal(core.fieldKind(label), kind, label);
  const expected = { pinyin: ["拼音"], email: ["邮箱"], phone: ["手机"], gender: ["性别"], birth_date: ["出生日期"], name: ["姓名"],
    id_type: ["证件类型"], id_number: ["证件号码"], hometown: ["籍贯户口"], region: ["国家地区"], major: ["专业"], school: ["学校"],
    degree: ["学历", "学位"] };
  const source = read("extension/ai-helpers.js").match(/const FIELD_SEMANTICS = \[([\s\S]*?)\n  \];/)[1];
  const semantics = [...source.matchAll(/\{ type: "([a-z_]+)", keywords: \[([^\]]*)\] \}/g)]
    .map(([, type, words]) => [type, [...words.matchAll(/"([^"]+)"/g)].map(match => match[1])]);
  assert.deepEqual(semantics.map(([type]) => type).sort(), Object.keys(expected).sort(), "a kind was added to local matching: give it a report kind");
  for (const [type, words] of semantics) {
    for (const word of words) assert.ok(expected[type].includes(core.fieldKind(word)), `${type} ${word} → ${core.fieldKind(word)}`);
  }
  // The narrow kinds win over the broad ones they contain.
  for (const [label, kind] of [["紧急联系人电话", "紧急联系人"], ["出生地", "籍贯户口"], ["专业排名", "成绩排名"], ["大学英语四级", "外语"],
    ["学校名称", "学校"], ["公司名称", "公司"], ["请输入", "unknown"], ["（字段名已隐藏）", "unknown"]]) {
    assert.equal(core.fieldKind(label), kind, label);
  }
  for (const kind of core.KIND_NAMES) assert.ok(/^(?:[\u4e00-\u9fff]{2,6}|unknown)$/.test(kind), kind);
});
