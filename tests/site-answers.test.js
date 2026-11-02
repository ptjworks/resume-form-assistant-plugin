// #429 第五项第 2 点：问到对方公司的题，回答按网站存在桌面，只在同一个网站本地复用。
const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs");
const path = require("node:path");

const profileApi = require("../profile-fields.js");
const helpers = require("../ai-helpers.js");

const web = (label, value, extra = {}) => ({ label, inputType: "text", matched: false, state: "ready", value, ...extra });
const planOf = (candidates, extra = {}) => profileApi.planProfileOffer({ candidates, profile: {}, templateFields: [], ...extra });
const siteOf = (answers = []) => ({ answers });
const siteResume = (answers) => profileApi.siteAnswerFields(answers);
const siteChoices = (plan, extra = {}) => plan.site.map((item) => ({
  id: item.id, key: item.key, kind: "site", reviewedValue: item.value, ...(item.existing && extra.replace ? { replaceOf: item.existing } : {})
}));

test("siteKeyOf is the host, plus the company segment on recruiting sites shared by many companies", () => {
  const cases = [
    ["https://www.Campus.Example.com/apply/123?from=a#/form", "campus.example.com"],
    ["http://127.0.0.1:5173/form.html", "127.0.0.1:5173"],
    ["https://acme.zhiye.com/campus/jobs", "acme.zhiye.com"],
    ["https://acme.jobs.feishu.cn/campus/position/1", "acme.jobs.feishu.cn"],
    ["https://app.mokahr.com/campus-recruitment/acme/1234#/job/5", "app.mokahr.com/acme"],
    ["https://app.mokahr.com/m/campus_apply/acme/9", "app.mokahr.com/acme"],
    ["https://wecruit.hotjob.cn/SU0123456789abcdef01234567/pb/index.html", "wecruit.hotjob.cn/SU0123456789abcdef01234567"],
    ["https://jobs.feishu.cn/acme/position", "jobs.feishu.cn/acme"],
    // 认不出公司的共享站点、Moka 的首页、不是网页的，都不按网站存。
    ["https://xyz.51job.com/external/apply.aspx?ctmid=1", ""],
    ["https://xiaoyuan.zhaopin.com/job/1", ""],
    ["https://app.mokahr.com/", ""],
    ["https://wecruit.hotjob.cn/index.html", ""],
    ["file:///C:/form.html", ""],
    ["chrome-extension://abc/sidepanel.html", ""],
    ["https://[::1]/form", ""],
    ["http://campus.example.com:0/form", ""],
    ["not a url", ""]
  ];
  for (const [url, site] of cases) assert.equal(profileApi.siteKeyOf(url), site, url);
});

// 桌面存储层（archive-store tests/site_answers.rs）用同一份对照，两边判断不一致就有一边先失败。
test("the plugin judges questions and answers like the desktop store does", () => {
  const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "desktop", "crates", "archive-store", "tests", "site_answer_vectors.json"), "utf8"));
  for (const [raw, key] of vectors.keys) assert.equal(profileApi.normalizeKey(raw), key, raw);
  for (const title of vectors.titles.accepted) assert.equal(profileApi.siteScopedTitle(profileApi.normalizeKey(title)), true, title);
  for (const title of vectors.titles.rejected) assert.equal(profileApi.siteScopedTitle(profileApi.normalizeKey(title)), false, title);
  for (const answer of vectors.answers.identifiers) assert.equal(profileApi.looksLikeIdentifier(answer), true, answer);
  for (const answer of vectors.answers.plain) assert.equal(profileApi.looksLikeIdentifier(answer), false, answer);
});

test("siteScopedTitle takes questions about the company, and still none of the four kept-out kinds", () => {
  const scoped = (label) => profileApi.siteScopedTitle(profileApi.normalizeKey(label));
  for (const label of ["是否有亲属在本公司工作", "* 是否有亲属在本行工作：", "是否曾在我司实习", "是否有家人在我行任职", "是否与本单位存在劳动关系"]) {
    assert.equal(scoped(label), true, label);
  }
  for (const label of ["是否服从调剂", "为什么选择本公司", "本公司内推码", "应聘本公司的岗位", "亲属在本公司工作的联系电话",
    "在本公司的期望薪资", "Do you have relatives working here", "本公司系统密码"]) {
    assert.equal(scoped(label), false, label);
  }
});

test("savedAnswerMatches fills a company question only from this site's answers", () => {
  const resume = [
    ...profileApi.profileToResumeFields({ custom: [{ key: "是否服从调剂", value: "是" }, { key: "是否有亲属在本公司工作", value: "是" }] }),
    ...siteResume([{ key: "是否有亲属在本公司工作", value: "否" }, { key: "是否服从调剂", value: "否" }, { key: "", value: "x" }])
  ];
  const form = [
    { fieldId: "relative", label: "*是否有亲属在本公司工作：", group: "其他信息", inputType: "radio", options: ["是", "否"] },
    { fieldId: "adjust", label: "是否服从调剂", group: "其他信息" }
  ];
  // 公司题用这个网站的回答，不用补充字段里的；补充字段的题不用网站回答里的同名题。
  assert.deepEqual(profileApi.savedAnswerMatches(form, resume), [{ fieldId: "relative", value: "否" }, { fieldId: "adjust", value: "是" }]);
  assert.deepEqual(helpers.localRuleMatches(form, resume, profileApi), [{ fieldId: "relative", value: "否" }, { fieldId: "adjust", value: "是" }]);
  // 没有读到这个网站的回答时，公司题照旧交给 AI。
  assert.deepEqual(profileApi.savedAnswerMatches(form, resume.filter((field) => field.group !== profileApi.SITE_GROUP)),
    [{ fieldId: "adjust", value: "是" }]);
  // 家庭区块里问的也填；区块带序号、同名两个、紧急联系人区块里的不填。
  assert.deepEqual(profileApi.savedAnswerMatches([{ fieldId: "f", label: "是否有亲属在本公司工作", group: "家庭成员" }], resume),
    [{ fieldId: "f", value: "否" }]);
  assert.deepEqual(profileApi.savedAnswerMatches([{ fieldId: "f", label: "是否有亲属在本公司工作", group: "家庭成员 2" }], resume), []);
  assert.deepEqual(profileApi.savedAnswerMatches([{ fieldId: "a", label: "是否有亲属在本公司工作" }, { fieldId: "b", label: "是否有亲属在本公司工作" }], resume), []);
  assert.deepEqual(profileApi.savedAnswerMatches([{ fieldId: "f", label: "是否有亲属在本公司工作", group: "紧急联系人" }], resume), []);
  // 回答像号码、太长的不填；这个网站同名的回答有两条也不填。
  const one = [{ fieldId: "x", label: "是否曾在本行实习" }];
  assert.deepEqual(profileApi.savedAnswerMatches(one, siteResume([{ key: "是否曾在本行实习", value: "工号 1234567" }])), []);
  assert.deepEqual(profileApi.savedAnswerMatches(one, siteResume([{ key: "是否曾在本行实习", value: "很".repeat(301) }])), []);
  assert.deepEqual(profileApi.savedAnswerMatches(one, siteResume([{ key: "是否曾在本行实习", value: "是" }, { key: "是否曾在本行实习：", value: "否" }])), []);
});

test("plan: with this site's answers, company questions go to the site list instead of the custom fields", () => {
  const candidates = [web("是否有亲属在本公司工作", "否"), web("是否曾在本行实习", "是"), web("兴趣爱好", "摄影"),
    web("是否与本公司签过协议", ""), web("我司内推人工号", "A1234567"), web("是否认识本单位员工", "认识 13800138000")];
  const withSite = planOf(candidates, { site: siteOf() });
  assert.deepEqual(withSite.site.map(({ id, key, value, existing, defaultSelected }) => ({ id, key, value, existing, defaultSelected })), [
    { id: "site:是否有亲属在本公司工作", key: "是否有亲属在本公司工作", value: "否", existing: "", defaultSelected: true },
    { id: "site:是否曾在本行实习", key: "是否曾在本行实习", value: "是", existing: "", defaultSelected: true }
  ]);
  assert.deepEqual(withSite.filled.map((item) => item.key), ["兴趣爱好", "我司内推人工号"]);
  // 空着的公司题不列，只数一下（调用方据此留着候选）；回答像号码的不按网站记，说明原因。
  assert.equal(withSite.pending.some((item) => item.key === "是否与本公司签过协议"), false);
  assert.equal(withSite.siteWaiting, 1);
  assert.match(withSite.notes.map((note) => note.text).join(" "), /「是否认识本单位员工」的回答太长，或像号码/);
  assert.match(profileApi.profileOfferSummary(withSite), /2 项只在这个网站使用/);
  assert.equal(profileApi.planHasOffer(planOf([web("是否有亲属在本公司工作", "否")], { site: siteOf() })), true);
  // 桌面不支持或认不出网站（不传 site）：照旧按补充字段，公司题列出来但默认不勾。
  const without = planOf(candidates);
  assert.deepEqual(without.site, []);
  assert.equal(without.filled.find((item) => item.key === "是否有亲属在本公司工作").defaultSelected, false);
  // 家庭区块里问对方公司的题，有网站回答时也列出来；别的家庭字段照旧不收。
  const family = planOf([web("是否有亲属在本公司工作", "否", { section: "家庭成员" }), web("工作单位", "某单位", { section: "家庭成员" })], { site: siteOf() });
  assert.deepEqual(family.site.map((item) => item.key), ["是否有亲属在本公司工作"]);
  assert.deepEqual(family.filled, []);
  assert.deepEqual(planOf([web("是否有亲属在本公司工作", "否", { section: "家庭成员" })]).filled, []);
});

test("plan: a company question the template already answers the same way is not offered again; a different answer is", () => {
  const templateFields = [{ group: "其他", key: "是否有亲属在本公司工作", value: "否" }];
  const same = profileApi.planProfileOffer({ candidates: [web("是否有亲属在本公司工作", "否")], profile: {}, templateFields, site: siteOf() });
  assert.deepEqual([same.site, same.same, same.sameIds], [[], 1, ["site:是否有亲属在本公司工作"]]);
  const other = profileApi.planProfileOffer({ candidates: [web("是否有亲属在本公司工作", "是")], profile: {}, templateFields, site: siteOf() });
  assert.deepEqual(other.site.map((item) => [item.key, item.value, item.defaultSelected]), [["是否有亲属在本公司工作", "是", true]]);
  assert.deepEqual(other.notes, [], "not reported as a conflict with the template");
});

test("plan: a site answer already the same is skipped, a different one waits for the user to replace it", () => {
  const site = siteOf([{ key: "是否有亲属在本公司工作：", value: "否" }, { key: "是否曾在本行实习", value: "否" }]);
  const plan = planOf([web("是否有亲属在本公司工作", "否"), web("是否曾在本行实习", "是")], { site });
  assert.equal(plan.same, 1);
  assert.deepEqual(plan.sameIds, ["site:是否有亲属在本公司工作"]);
  assert.deepEqual(plan.site, [{ id: "site:是否曾在本行实习", key: "是否曾在本行实习", value: "是", existing: "否", defaultSelected: false }]);
  // 没勾「替换」不存；勾了就带上看到的旧回答，桌面核对用。
  assert.deepEqual(profileApi.applySiteSelection(plan, siteChoices(plan)).skipped.map((item) => item.reason), ["conflict-unconfirmed"]);
  assert.deepEqual(profileApi.applySiteSelection(plan, siteChoices(plan, { replace: true })).answers,
    [{ key: "是否曾在本行实习", value: "是", previous: "否" }]);
  // 这个网站满了 30 道：新题不列，说明原因；改已有的题不受影响。
  const full = siteOf(Array.from({ length: profileApi.MAX_SITE_ANSWERS_PER_SITE }, (_, i) => ({ key: `本公司问题${i}`, value: "否" })));
  const crowded = planOf([web("是否有亲属在本公司工作", "否"), web("本公司问题0", "是")], { site: full });
  assert.deepEqual(crowded.site.map((item) => item.key), ["本公司问题0"]);
  assert.match(crowded.notes.map((note) => note.text).join(" "), /这个网站已经记住了 30 道题/);
});

test("applySiteSelection keeps only what the user reviewed and still matches the page", () => {
  const plan = planOf([web("是否有亲属在本公司工作", "否"), web("是否曾在本行实习", "是"), web("兴趣爱好", "摄影")], { site: siteOf() });
  const all = [...siteChoices(plan), { id: plan.filled[0].id, key: "兴趣爱好", kind: "filled", reviewedValue: "摄影" }];
  const outcome = profileApi.applySiteSelection(plan, all);
  assert.deepEqual(outcome.answers, [{ key: "是否有亲属在本公司工作", value: "否" }, { key: "是否曾在本行实习", value: "是" }]);
  assert.deepEqual(outcome.saved.map((item) => item.kind), ["site", "site"]);
  // 网页上的回答在核对之后改了。
  const changed = profileApi.applySiteSelection(plan, [{ ...siteChoices(plan)[0], reviewedValue: "是" }]);
  assert.deepEqual(changed.skipped.map((item) => item.reason), ["value-changed"]);
  // 桌面里刚有了一条（看的时候没有）；页面上已经没有这道题；看到的旧回答和现在的不一样。
  const later = planOf([web("是否有亲属在本公司工作", "否")], { site: siteOf([{ key: "是否有亲属在本公司工作", value: "是" }]) });
  assert.deepEqual(profileApi.applySiteSelection(later, siteChoices(plan)).skipped.map((item) => item.reason), ["conflict-unconfirmed", "gone"]);
  assert.deepEqual(profileApi.applySiteSelection(later, [{ ...siteChoices(later)[0], replaceOf: "别的" }]).skipped.map((item) => item.reason),
    ["existing-changed"]);
  // 补充字段那边照旧，不碰 site: 的项。
  const profileSide = profileApi.applyProfileSelection({}, plan, all.filter((item) => !item.id.startsWith("site:")));
  assert.deepEqual(profileSide.saved.map((item) => item.key), ["兴趣爱好"]);
  // 选择里混着网站回答（页面里旧按钮按默认勾选存）：补充字段那边不碰它们，也不报「找不到了」。
  const mixed = profileApi.applyProfileSelection({}, plan, profileApi.defaultProfileSelection(plan));
  assert.deepEqual([mixed.saved.map((item) => item.key), mixed.skipped], [["兴趣爱好"], []]);
  // 页面里旧按钮（没有勾选信息）按默认勾选存，网站回答也在里面。
  assert.deepEqual(profileApi.defaultProfileSelection(plan).map((item) => item.kind), ["filled", "site", "site"]);
});
