// #301 飞书招聘（字节校招）的教育经历：默认有一张空白卡片，「添加」按钮在最后一张卡片里面。
// AI 没有列出已有条目时，插件自己按页面结构数卡片，不能当成 0 条。
const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const agent = require("../extension/form-agent.js");

const card = (withAdd) => `<div class="apply-form-array-card"><div class="ud-formily-item"><label>学校名称</label><input></div>
  <div class="ud-formily-item"><label>专业</label><input></div>
  <div class="apply-form-array-card-operate"><button class="icon" type="button"></button>${withAdd ? '<button class="add" type="button">添加</button>' : ""}</div></div>`;
const page = (cards) => `<form><div class="module"><p>教育经历</p><div class="ud-formily-item"><div class="ud-formily-item-control"><div class="array">${cards.map((_, i) => card(i === cards.length - 1)).join("")}</div></div></div></div>
  <div class="module"><p>工作经历</p><div class="ud-formily-item"><button class="add2" type="button">添加</button></div></div></form>`;
const records = (n) => Array.from({ length: n }, (_, i) => ({ group: "教育背景", key: `学校${i}教育经历-学校`, value: `v${i}` }));
const visible = () => true;

function setup(cards) {
  const dom = new JSDOM(page(cards));
  const { document } = dom.window;
  const button = document.querySelector(".module .add");
  const group = { domain: "education", button, rows: [], others: [document.querySelector(".add2")] };
  return { dom, document, button, group };
}

test("#301 existing cards are counted by structure when the model lists none", (t) => {
  const { dom, group } = setup([1, 2]);
  t.after(() => dom.window.close());
  assert.deepEqual(agent.collectSpec([group], records(2), { isVisible: visible }).candidates, [], "two cards for two records: nothing to add");
  const three = agent.collectSpec([group], records(3), { isVisible: visible });
  assert.deepEqual(three.problems, []);
  assert.deepEqual(three.candidates.map(({ domain, current, target }) => [domain, current, target]), [["education", 2, 3]]);
});

test("#301 a single blank card holding the add button counts as one entry, not zero", (t) => {
  const { dom, group } = setup([1]);
  t.after(() => dom.window.close());
  const result = agent.collectSpec([group], records(2), { isVisible: visible });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.candidates.map(({ current, target }) => [current, target]), [[1, 2]]);
});

test("#301 the add click is followed to the new card even though the button sits inside the last card", async (t) => {
  const { dom, document, button, group } = setup([1]);
  t.after(() => dom.window.close());
  const snapshot = agent.collectSpec([group], records(2), { isVisible: visible });
  const array = document.querySelector(".array");
  let current = button;
  const addCard = () => {
    // 真站：新卡片加在最后，「添加」跟着挪到新卡片里。
    array.insertAdjacentHTML("beforeend", card(false));
    const fresh = array.lastElementChild;
    fresh.querySelector(".apply-form-array-card-operate").append(current);
  };
  button.addEventListener("click", addCard);
  const result = await agent.execute([{ id: "add-0", count: 1 }], snapshot, () => false, null, () => true);
  assert.equal(result.added, 1);
  assert.equal(array.children.length, 2);
  assert.equal(result.scopes.length, 1);
  assert.equal(result.scopes[0], array.lastElementChild);
});

test("#301 a lone group with no inputs anywhere near its button is still zero entries", (t) => {
  const { dom, document } = setup([1]);
  t.after(() => dom.window.close());
  const group = { domain: "work", button: document.querySelector(".add2"), rows: [], others: [document.querySelector(".module .add")] };
  const fields = [{ group: "工作经历", key: "公司", value: "x" }, { group: "工作经历", key: "公司2", value: "y" }];
  const result = agent.collectSpec([group], fields, { isVisible: visible });
  assert.equal(result.candidates[0]?.current, 0);
});

// #301 默认勾着「没有实习经历」的分组：简历里有实习经历时列一步取消勾选，用户确认后才执行。
const pageActions = require("../extension/page-actions.js");
const NONE = (text, checked = true) => `<div class="module"><p>${text.replace(/^没有/, "")}</p><label class="wrap"><span class="ud__checkbox"><input type="checkbox" role="checkbox"${checked ? " checked" : ""}></span><span>${text}</span></label></div>`;
const internFields = [
  { group: "实习经历", key: "药明康德实习经历-公司", value: "药明康德" }, { group: "实习经历", key: "药明康德实习经历-时间", value: "2023.01-2023.06" },
  { group: "实习经历", key: "万华化学实习经历-公司", value: "万华化学" }, { group: "实习经历", key: "万华化学实习经历-时间", value: "2023.07-2023.09" }
];

test("#301 a checked '没有实习经历' switch is offered only when the resume has internships", (t) => {
  const { window } = new JSDOM(`<form>${NONE("没有实习经历")}${NONE("没有工作经历")}${NONE("没有项目经历", false)}</form>`);
  t.after(() => window.close());
  const found = agent.emptyToggles(window.document, internFields, visible);
  assert.deepEqual(found.map(({ domain, text }) => [domain, text]), [["internship", "没有实习经历"]], "no work or project records, and the unchecked one is not a switch to flip");
  assert.deepEqual(agent.emptyToggles(window.document, [], visible), []);
});

test("#301 a lone '没有工作经历' switch counts internship records as work when the page has no separate internship group", (t) => {
  const { window } = new JSDOM(`<form>${NONE("没有工作经历")}</form>`);
  t.after(() => window.close());
  assert.deepEqual(agent.emptyToggles(window.document, internFields, visible).map(({ domain }) => domain), ["work"]);
});

test("#301 executing the toggle step unchecks it, and nothing but the switch changes", async (t) => {
  const { window } = new JSDOM(`<form>${NONE("没有实习经历")}<input class="name" value="用户已填"></form>`);
  const { document } = window;
  t.after(() => window.close());
  const [toggle] = agent.emptyToggles(document, internFields, visible);
  const box = toggle.box;
  // 取消勾选后网页画出一张空白条目。
  box.addEventListener("change", () => { if (!box.checked) document.querySelector("form").insertAdjacentHTML("beforeend", `<input class="fresh">`); });
  const item = { kind: "expand", ref: "", toggle: { box, text: toggle.text }, element: toggle.element, label: "取消勾选「没有实习经历」" };
  const plan = { items: [item], manual: [], blocked: [], adds: null };
  assert.equal(pageActions.planStillValid(plan, { doc: document, isVisible: visible }), true);
  const result = await pageActions.executePlan(plan, { doc: document, isVisible: visible, stopped: () => "", formAgent: agent,
    timing: { quietMs: 30, maxMs: 1500, pollMs: 10 } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.done.expand, 1);
  assert.equal(box.checked, false);
  assert.equal(document.querySelector(".name").value, "用户已填");
  assert.equal(pageActions.planStillValid(plan, { doc: document, isVisible: visible }), false, "once unchecked, the step is no longer valid");
});

test("#301 a toggle whose text changed after the preview is not clicked", async (t) => {
  const { window } = new JSDOM(`<form>${NONE("没有实习经历")}</form>`);
  const { document } = window;
  t.after(() => window.close());
  const [toggle] = agent.emptyToggles(document, internFields, visible);
  toggle.element.querySelector("span:last-child").textContent = "提交简历";
  const item = { kind: "expand", ref: "", toggle: { box: toggle.box, text: toggle.text }, element: toggle.element, label: "x" };
  const result = await pageActions.executePlan({ items: [item], manual: [], blocked: [], adds: null }, { doc: document, isVisible: visible, stopped: () => "", formAgent: agent });
  assert.equal(result.ok, false);
  assert.equal(result.code, "target_changed");
  assert.equal(toggle.box.checked, true);
});

test("#301 work and internship groups on one page are counted separately; a single group takes both", (t) => {
  const fields = [...internFields, { group: "工作经历", key: "某公司工作经历-公司", value: "某公司" }];
  const { window } = new JSDOM(`<form>
    <div class="m"><p>实习经历</p><div class="ud-formily-item"><button class="addi" type="button">添加</button></div></div>
    <div class="m"><p>工作经历</p><div class="ud-formily-item"><button class="addw" type="button">添加</button></div></div></form>`);
  t.after(() => window.close());
  const { document } = window;
  const intern = { domain: "internship", button: document.querySelector(".addi"), rows: [], others: [document.querySelector(".addw")] };
  const work = { domain: "work", button: document.querySelector(".addw"), rows: [], others: [document.querySelector(".addi")] };
  const split = agent.collectSpec([intern, work], fields, { isVisible: visible });
  assert.deepEqual(split.problems, []);
  assert.deepEqual(split.candidates.map(({ domain, target }) => [domain, target]).sort(), [["internship", 2], ["work", 1]]);
  const solo = new JSDOM(`<form><div class="m"><p>工作经历</p><div class="ud-formily-item"><button class="addw" type="button">添加</button></div></div></form>`);
  t.after(() => solo.window.close());
  const alone = agent.collectSpec([{ domain: "work", button: solo.window.document.querySelector(".addw"), rows: [], others: [] }], internFields, { isVisible: visible });
  assert.deepEqual(alone.candidates.map(({ domain, target }) => [domain, target]), [["work", 2]], "no work records: the internships stand in for them");
});

// #301 新增没认出新条目时：诊断写停止细分码；点击后页面多出了输入框，如实说「可能已经新增」，不只报完成 0。
test("#301 an add whose new card is not recognised reports the stop detail and that the page grew", async (t) => {
  const { dom, document, button, group } = setup([1]);
  t.after(() => dom.window.close());
  const snapshot = agent.collectSpec([group], records(2), { isVisible: visible });
  // 新卡片加在分组范围之外（旧版就是这样数错的）：插件在范围里看不到变化。
  button.addEventListener("click", () => document.body.insertAdjacentHTML("beforeend", `<input class="outside">`));
  const plan = { items: [], manual: [], blocked: [], adds: { snapshot, plan: [{ id: "add-0", count: 1 }] } };
  const result = await pageActions.executePlan(plan, { doc: document, isVisible: visible, stopped: () => "", formAgent: agent,
    timing: { add: { maxMs: 200, settleMs: 20, pollMs: 10 } } });
  assert.equal(result.ok, false);
  assert.equal(result.code, "add_failed");
  assert.equal(result.detail, "no_new_row");
  assert.equal(result.grew, 1);
  assert.match(result.message, /多出了 1 个输入框/);
});

// #301 小米：每组经历只有一条，「添加」在这一条最下面；AI 指出了已有的那一条。按整条来数，不因按钮在条目里就数不清。
// 实习经历一栏是空的、只有「添加」：往上找会碰到整张表，不能把整张表当成一条。
test("#301 an existing entry the model points at is counted as a whole when the add button sits inside it, and an empty section stays at zero", (t) => {
  const { window } = new JSDOM(`<form>
    <div class="sec"><p>教育经历</p><div class="item"><div class="col"><input class="school"></div><div class="col"><input class="major"></div>
      <div class="col"><div class="period"><input class="hidden"></div></div><div class="op"><div class="addBtn" id="edu-add"><span>添加</span></div></div></div></div>
    <div class="sec" id="intern"><p>实习经历</p><div class="addBtn" id="intern-add"><span>添加</span></div></div>
    <div class="sec"><p>项目经历</p><div class="addBtn" id="proj-add"><span>添加</span></div></div></form>`);
  t.after(() => window.close());
  const doc = window.document;
  const edu = { domain: "education", button: doc.getElementById("edu-add"), rows: [doc.querySelector(".school")], others: [] };
  const fields = [...records(2)];
  const counted = agent.collectSpec([edu], fields, { isVisible: visible });
  assert.deepEqual(counted.problems, []);
  assert.deepEqual(counted.candidates.map(({ current, target }) => [current, target]), [[1, 2]]);
  const intern = { domain: "internship", button: doc.getElementById("intern-add"), rows: [], others: [] };
  const internships = [{ group: "实习经历", key: "A实习经历-公司", value: "a" }, { group: "实习经历", key: "B实习经历-公司", value: "b" }];
  const empty = agent.collectSpec([intern], internships, { isVisible: visible });
  assert.deepEqual(empty.candidates.map(({ current, target }) => [current, target]), [[0, 2]]);
});

// #301 小米：网页上有单独的实习经历一栏（空栏也算）时，工作经历只按真正的工作经历数，不拿实习凑数。
test("#301 a work group is not filled up with internships when the page has its own internship section", (t) => {
  const { window } = new JSDOM(`<form><div class="sec"><p>工作经历</p><div class="addw"><span>添加</span></div></div>
    <div class="sec"><p>实习经历</p><div class="addi"><span>添加</span></div></div></form>`);
  t.after(() => window.close());
  const doc = window.document;
  assert.deepEqual(agent.pageSections(doc, visible).sort(), ["employment", "internship"]);
  const work = { domain: "work", button: doc.querySelector(".addw"), rows: [], others: [doc.querySelector(".addi")] };
  const internships = [{ group: "实习经历", key: "A实习经历-公司", value: "a" }, { group: "实习经历", key: "B实习经历-公司", value: "b" }];
  assert.deepEqual(agent.collectSpec([work], internships, { isVisible: visible, pageSections: ["employment", "internship"] }).candidates, []);
  assert.deepEqual(agent.collectSpec([work], internships, { isVisible: visible, pageSections: ["employment"] }).candidates.map(({ target }) => target), [2]);
});

// PR #543 审查（A3/C2）：左边的步骤导航、标签页也写着「实习经历」，表单里却只有一栏工作经历（实习也填在这里）。
// 只认真正当栏目标题的那一个，导航里的不算，不然实习资料会被当成「填错栏」，一条都填不进去。
test("#543 a step list or tab that names 实习经历 is not taken as a separate internship section", (t) => {
  const form = `<form><div class="sec"><p>工作经历</p><div class="row"><label>公司</label><input></div><div class="addw"><span>添加</span></div></div></form>`;
  const { window } = new JSDOM(`<div class="steps"><div class="step">基本信息</div><div class="step">教育经历</div><div class="step">实习经历</div><div class="step">工作经历</div></div>
    <ul role="tablist"><li role="tab"><span>实习经历</span></li></ul><nav><span>实习经历</span></nav>${form}`);
  t.after(() => window.close());
  assert.deepEqual(agent.pageSections(window.document, visible), ["employment"]);
});

test("#543 an empty internship section with only an add button still counts", (t) => {
  const { window } = new JSDOM(`<form><div class="sec"><p>工作经历</p><div class="row"><input></div></div>
    <div class="sec"><div class="head"><h3>实习经历</h3></div><div class="body"><div class="addBtn"><i></i><span>添加</span></div></div></div></form>`);
  t.after(() => window.close());
  assert.deepEqual(agent.pageSections(window.document, visible).sort(), ["employment", "internship"]);
});

// PR #543 审查（B5）：卡片的标题常写在 <header> 里，后面跟着输入框。header 不是导航，不能因此认不出这一栏。
test("#543 a section title written inside a card <header> is still a section, a title inside the site's <nav> is not", (t) => {
  const { window } = new JSDOM(`<header class="site"><nav><span>实习经历</span></nav></header>
    <form><div class="card"><header class="card-header"><h3>实习经历</h3></header><div class="row"><label>公司</label><input></div></div></form>`);
  t.after(() => window.close());
  assert.deepEqual(agent.pageSections(window.document, visible), ["internship"]);
  const navOnly = new JSDOM(`<header class="site"><nav><span>实习经历</span></nav></header><form><div class="card"><p>基本信息</p><input></div></form>`);
  t.after(() => navOnly.window.close());
  assert.deepEqual(agent.pageSections(navOnly.window.document, visible), []);
});

// PR #543 审查（B6/C7）：卡片里有字段自己的「添加附件」按钮，不能因此认不出已有几张卡片、退回当成 0 条。
// 别的分组的「添加」（新增一条经历）照旧拦住。
test("#543 an 添加附件 button inside a card does not stop the cards from being counted, another section's 添加 still does", (t) => {
  const dom = new JSDOM(page([0, 1]).replace(/<input><\/div>\s*<div class="ud-formily-item"><label>专业/g, '<input><button class="upload" type="button">添加附件</button></div><div class="ud-formily-item"><label>专业'));
  t.after(() => dom.window.close());
  const { document } = dom.window;
  assert.ok(document.querySelector(".upload"), "the attachment button is on the card");
  const group = { domain: "education", button: document.querySelector(".module .add"), rows: [], others: [document.querySelector(".add2")] };
  const counted = agent.collectSpec([group], records(3), { isVisible: visible });
  assert.deepEqual(counted.problems, []);
  assert.deepEqual(counted.candidates.map(({ current, target }) => [current, target]), [[2, 3]]);

  // 空的实习经历一栏往上就是整张表（里面有教育经历的输入框和它的「添加」）：不能把整张表当成一条，照旧算 0 条。
  const { window } = new JSDOM(`<form><div class="all"><div class="sec"><p>教育经历</p><div class="item"><input class="school"><div class="addBtn" id="edu-add"><span>添加</span></div></div></div>
    <div class="sec2"><p>实习经历</p><div class="addBtn" id="intern-add"><span>添加实习经历</span></div></div></div></form>`);
  t.after(() => window.close());
  const intern = { domain: "internship", button: window.document.getElementById("intern-add"), rows: [], others: [] };
  const internships = [{ group: "实习经历", key: "A实习经历-公司", value: "a" }, { group: "实习经历", key: "B实习经历-公司", value: "b" }];
  const crossed = agent.collectSpec([intern], internships, { isVisible: visible });
  assert.deepEqual(crossed.candidates.map(({ current, target }) => [current, target]), [[0, 2]]);
});
