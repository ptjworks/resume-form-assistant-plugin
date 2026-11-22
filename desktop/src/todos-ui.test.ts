import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TodoView } from './api.ts';
import { mountTodos } from './todos-ui.ts';

/** 与 inbox-ui.test.ts 同一套假 DOM：只有 id 查询、innerHTML 与监听器。 */
type InvokeHandler = (name: string, args?: Record<string, unknown>) => unknown;

class FakeNode {
  id: string;
  value = "";
  innerHTML = "";
  textContent = "";
  className = "";
  hidden = false;
  open = false;
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() {}
  querySelectorAll() { return []; }
  dataset: Record<string, string> = {};
  classes = new Set<string>();
  classList = {
    toggle: (name: string, on?: boolean) => {
      const next = on ?? !this.classes.has(name);
      if (next) this.classes.add(name);
      else this.classes.delete(name);
      return next;
    },
    contains: (name: string) => this.classes.has(name),
    add: (name: string) => void this.classes.add(name),
    remove: (name: string) => void this.classes.delete(name),
  };
  attributes: Record<string, string> = {};
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  removeAttribute(name: string) { delete this.attributes[name]; }
  querySelector() { return null; }
  insertAdjacentHTML(_where: string, html: string) { this.innerHTML += html; }
  disabled = false;
  readOnly = false;
  placeholder = "";
  listeners: Record<string, (event: unknown) => unknown> = {};

  constructor(id: string) {
    this.id = id;
  }

  addEventListener(type: string, fn: (event: unknown) => unknown) {
    this.listeners[type] = fn;
  }

  emit(type: string, event: Record<string, unknown> = {}) {
    return this.listeners[type]?.({ preventDefault() {}, ...event });
  }

  reset() {
    this.value = "";
  }

  /** 点月历里的某一天（日期数字、「+N」或格子空白处）。 */
  clickDay(day: string) {
    const target = {
      closest: (selector: string) =>
        selector.includes("[data-day]") && !selector.includes("[data-todo") ? { dataset: { day } } : null,
    };
    return this.emit("click", { target });
  }

  /** 点月历里的一条事件胶囊。 */
  clickPill(todoId: string, day: string) {
    const target = {
      closest: (selector: string) =>
        selector.includes("[data-todo]") ? { dataset: { todo: todoId, act: "select", day } } : null,
    };
    return this.emit("click", { target });
  }

  /** 点一个带 data-* 属性的普通按钮（跳到最早逾期、右栏「在当天添加」）。 */
  clickMarked(attr: string, dataset: Record<string, string> = {}) {
    const target = {
      closest: (selector: string) => (selector.includes(attr) ? { dataset } : null),
    };
    return this.emit("click", { target });
  }

  /** 从 innerHTML 里挑一个按钮，模拟点击它。 */
  clickButton(todoId: string, act: string) {
    const target = {
      closest: (selector: string) =>
        selector.includes("[data-todo]")
          ? { dataset: { todo: todoId, act } }
          : null,
    };
    return this.emit("click", { target });
  }
}

function harness(handler?: InvokeHandler, host: Parameters<typeof mountTodos>[2] = {}) {
  const nodes = new Map<string, FakeNode>();
  const calls: Array<{ name: string; args?: Record<string, unknown> }> = [];

  function el(id: string): FakeNode {
    if (!nodes.has(id)) nodes.set(id, new FakeNode(id));
    return nodes.get(id) as FakeNode;
  }
  globalThis.document = { getElementById: el, addEventListener() {} } as unknown as Document;

  const invoke = async <T,>(name: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ name, args });
    const custom = handler?.(name, args);
    if (custom !== undefined) return custom as T;
    if (name === "reminder_capability_cmd") return { available: true, reason: null } as T;
    if (name === "list_applications_cmd") {
      return { total: 1, items: [{ id: "a1", company: "合成公司", title: "后端工程师" }] } as T;
    }
    if (name === "overdue_digest_cmd") return { todos: [], more: 0 } as T;
    if (name === "list_todos_cmd") return [] as T;
    return {} as T;
  };

  const now = () => new Date(2026, 8, 13, 10, 0, 0);
  const show = mountTodos(invoke as never, now, host);
  return { el, calls, show, called: (name: string) => calls.filter((c) => c.name === name) };
}

function todo(overrides: Partial<TodoView> = {}): TodoView {
  return {
    id: "t1",
    applicationId: "a1",
    title: "一面",
    duePrecision: "date",
    dueDate: "2026-09-20",
    status: "open",
    reminderState: "scheduled",
    reminderScheduledForUtc: "2026-09-20T01:00:00Z",
    company: "合成公司",
    position: "后端工程师",
    ...overrides,
  };
}

test('进入视图会问能力、申请和列表；月历标题是当月', async () => {
  const h = harness();
  await h.show();

  for (const name of ["reminder_capability_cmd", "list_applications_cmd", "list_todos_cmd"]) {
    assert.equal(h.called(name).length, 1, `没有调用 ${name}`);
  }
  assert.equal(h.el("cal-title").textContent, "2026年9月");
  assert.match(h.el("todo-detail").innerHTML, /9月13日 · 周日/, "右栏默认是今天");
  assert.match(h.el("todo-detail").innerHTML, /今天 · 没有日程/);
});

test('系统通知不可用时待办照常显示，并写明原因', async () => {
  const h = harness((name) => {
    if (name === "reminder_capability_cmd") {
      return { available: false, reason: "系统通知未授权。" };
    }
    if (name === "list_todos_cmd") return [todo({ reminderState: "unsupported" })];
    return undefined;
  });

  await h.show({ id: "t1" });

  assert.match(h.el("todo-list").innerHTML, /面试 · 合成/, "提醒没了不等于待办没了");
  assert.match(h.el("todo-reminder-note").textContent, /未授权/);
  assert.match(h.el("todo-reminder-note").textContent, /投递窗口/, "投递窗口要写清楚");
  assert.match(h.el("todo-detail").innerHTML, /未授权/, "这一条为什么不会响也要写出来");
  assert.match(h.el("todo-lifecycle").innerHTML, /关闭窗口/, "提醒什么时候会响的五种情况都在");
});

test('只有日历日的待办在月历和详情里都不带时刻', async () => {
  const h = harness((name) => (name === "list_todos_cmd" ? [todo()] : undefined));
  await h.show({ id: "t1" });

  const board = h.el("todo-list").innerHTML;
  assert.match(board, /data-day="2026-09-20"/);
  assert.doesNotMatch(board, /00:00/);
  assert.doesNotMatch(board, /\d{2}:\d{2}/, "仅日期的胶囊里没有任何时刻");
  assert.match(board, /合成/, "胶囊里写公司简称");
  const detail = h.el("todo-detail").innerHTML;
  assert.match(detail, /9月20日 · 周日/, "跳转后右栏就是这一天");
  assert.match(detail, /2026-09-20（未定时间）/, "详情里写完整日期");
  assert.doesNotMatch(detail, /00:00/);
});

test('精确时刻的待办胶囊写时刻，按待办自己的时区落在对应的一天', async () => {
  const h = harness((name) =>
    name === "list_todos_cmd"
      ? [todo({ duePrecision: "datetime", dueDate: null, dueAtUtc: "2026-09-19T23:30:00Z", timeZone: "Asia/Shanghai", interviewRound: 1 })]
      : undefined,
  );
  await h.show({ id: "t1" });

  assert.match(h.el("todo-list").innerHTML, /data-day="2026-09-20"[^>]*aria-label="9月20日 周日，1 项日程"/);
  assert.match(h.el("todo-list").innerHTML, />07:30 面试 · 合成</);
  assert.match(h.el("todo-detail").innerHTML, /第 1 轮/);
});

test("待办只有日期或仅设置提醒时，详情显示自定义提醒时区", async () => {
  for (const duePrecision of ["date", "none"] as const) {
    const h = harness(name => name === "list_todos_cmd" ? [todo({
      duePrecision,
      dueDate: duePrecision === "date" ? "2026-09-20" : null,
      timeZone: "America/New_York",
      remindAtUtc: "2026-09-20T14:00:00Z",
      reminderScheduledForUtc: "2026-09-20T14:00:00Z",
    })] : undefined);
    await h.show({ id: "t1" });
    const detail = h.el("todo-detail").innerHTML;
    assert.match(detail, /将在 .* 10:00 提醒/);
    assert.match(detail, /提醒时区：America\/New_York/);
  }
});

test('五种提醒状态在详情卡里各说各的话', async () => {
  const says: Array<[Partial<TodoView>, RegExp]> = [
    [{ reminderState: "scheduled", reminderScheduledForUtc: "2026-09-20T01:00:00Z" }, /将在/],
    [{ reminderState: "fired" }, /已经提醒过/],
    [{ reminderState: "missed" }, /没能提醒/],
    [{ reminderState: "unsupported" }, /没能登记提醒/],
    [{ reminderState: "none" }, /到期已过，不再提醒|提醒/],
  ];
  for (const [overrides, expected] of says) {
    const h = harness((name) => (name === "list_todos_cmd" ? [todo(overrides)] : undefined));
    await h.show({ id: "t1" });
    assert.match(h.el("todo-detail").innerHTML, expected, JSON.stringify(overrides));
    assert.doesNotMatch(h.el("todo-detail").innerHTML, /已设提醒/, "不能糊成一句「已设提醒」");
  }
});

test('新增日程：日期预填为选中那天，时间留空就是「只有日期」，不出现「更多设置」', async () => {
  const h = harness();
  await h.show();

  await h.el("todo-new").emit("click");
  assert.equal(h.el("todo-dialog").open, true);
  assert.equal(h.el("todo-date").value, "2026-09-13", "没点过别的日子就是今天");
  assert.equal(h.el("todo-time").value, "");
  assert.equal(h.el("todo-more-toggle").hidden, true, "新增时没有折叠区或展开链接");
  assert.equal(h.el("todo-form-options").hidden, true);
  assert.match(h.el("todo-when-note").textContent, /按系统通知提醒/);

  h.el("todo-dialog").close();
  await h.el("todo-list").clickDay("2026-09-25");
  await h.el("todo-detail").clickMarked("data-add-day", { addDay: "2026-09-25" });
  assert.equal(h.el("todo-date").value, "2026-09-25", "右栏「在当天添加」用选中那天");
});

test('新建待办把当地时刻换算成 UTC 再交给命令层，保存后月历带到那一天', async () => {
  const h = harness();
  await h.show();

  h.el("todo-title").value = "二面";
  h.el("todo-date").value = "2026-10-14";
  h.el("todo-time").value = "10:00";
  h.el("todo-application").value = "a1";
  await h.el("todo-form").emit("submit");

  const created = h.called("create_todo_cmd").at(0);
  const args = created?.args?.args as Record<string, unknown>;
  assert.equal(args.duePrecision, "datetime");
  assert.equal(args.dueAtUtc, new Date("2026-10-14T10:00").toISOString());
  assert.equal(args.dueDate, null, "精确到期不该同时带一个日期");
  assert.match(h.el("todo-status").textContent, /已添加/);
});

test('保存成功但提醒没登记上，两件事都要说', async () => {
  const h = harness((name) =>
    name === "create_todo_cmd"
      ? { todo: todo({ reminderState: "unsupported" }), reminderProblem: "不认识的时区：Mars/Olympus_Mons" }
      : undefined,
  );
  await h.show();

  h.el("todo-title").value = "二面";
  h.el("todo-application").value = "a1";
  await h.el("todo-form").emit("submit");

  const said = h.el("todo-status").textContent;
  assert.match(said, /已添加/, "保存确实成功了");
  assert.match(said, /Mars/, "提醒为什么没登记上也要说");
  assert.equal(h.el("todo-status").className, "note warn");
});

test('没有标题不发请求', async () => {
  const h = harness();
  await h.show();

  h.el("todo-title").value = "   ";
  await h.el("todo-form").emit("submit");

  h.el("todo-application").value = "a1";
  await h.el("todo-form").emit("submit");

  assert.equal(h.called("create_todo_cmd").length, 0);
  assert.match(h.el("todo-form-status").textContent, /标题/, "错误写在弹窗里，就近显示");
});

test('在右栏完成一条之后会重新拉列表，月历里那条变成已完成', async () => {
  let status: TodoView["status"] = "open";
  const h = harness((name) => {
    if (name === "set_todo_status_cmd") { status = "done"; return { todo: todo({ status: "done" }), reminderProblem: null }; }
    if (name === "list_todos_cmd") return [todo({ status })];
    return undefined;
  });
  await h.show({ id: "t1" });
  const before = h.called("list_todos_cmd").length;

  await h.el("todo-detail").clickButton("t1", "done");
  await new Promise((resolve) => setTimeout(resolve, 0)); // 点击处理函数不返回 Promise，等写入和重读走完

  const call = h.called("set_todo_status_cmd").at(0);
  assert.deepEqual(call?.args, { id: "t1", status: "done" });
  assert.ok(h.called("list_todos_cmd").length > before, "改完状态要刷新列表");
  assert.match(h.el("todo-status").textContent, /已标记完成/);
  assert.match(h.el("todo-list").innerHTML, /data-state="done"/, "已完成的照样显示在格子里");
  assert.match(h.el("todo-detail").innerHTML, /重新打开/, "详情还停在这一条上，可以直接重新打开");
});

test('已完成的待办给的是「重新打开」，已取消的不显示', async () => {
  const h = harness((name) =>
    name === "list_todos_cmd"
      ? [todo({ status: "done" }), todo({ id: "t2", status: "cancelled", title: "取消的笔试" })]
      : undefined,
  );
  await h.show({ id: "t1" });

  const html = h.el("todo-detail").innerHTML;
  assert.match(html, /重新打开/);
  assert.doesNotMatch(html, /data-act="done"/, "已经完成的不再给「完成」");
  assert.doesNotMatch(h.el("todo-list").innerHTML, /取消的笔试|data-todo="t2"/, "已取消的不显示");
  assert.doesNotMatch(h.el("todo-detail").innerHTML, /取消的笔试/);
});

test('逾期：月历上方一行写数量，点「跳到最早一天」切到那天并选中那条', async () => {
  const quiet = harness();
  await quiet.show();
  assert.equal(quiet.el("todo-digest").hidden, true);

  const loud = harness((name) =>
    name === "list_todos_cmd"
      ? [
          todo({ id: "newer", title: "较新的逾期", duePrecision: "date", dueDate: "2026-09-10" }),
          todo({ id: "older", title: "最早的逾期", duePrecision: "date", dueDate: "2026-08-30" }),
          todo({ id: "done", status: "done", duePrecision: "date", dueDate: "2026-08-01" }),
        ]
      : undefined,
  );
  await loud.show();
  assert.equal(loud.el("todo-digest").hidden, false);
  assert.match(loud.el("todo-digest").innerHTML, /2 条已逾期/);
  assert.match(loud.el("todo-digest").innerHTML, /跳到最早一天/);
  assert.doesNotMatch(loud.el("todo-digest").innerHTML, /提醒过/, "说的是到期没做，不是提醒过了");
  assert.equal(loud.called("overdue_digest_cmd").length, 0, "逾期数量在本地算，不去消费那条「只报一次」的汇总");

  await loud.el("todo-digest").clickMarked("data-jump-overdue");
  assert.equal(loud.el("cal-title").textContent, "2026年8月");
  assert.match(loud.el("todo-detail").innerHTML, /8月30日 · 周日/);
  assert.match(loud.el("todo-detail").innerHTML, /最早的逾期/);
  assert.match(loud.el("todo-detail").innerHTML, /已逾期/);
});

test('同一天三条以上：格内只画两条，其余收进「+N」，点格子选中那天', async () => {
  const h = harness((name) =>
    name === "list_todos_cmd"
      ? ["a", "b", "c", "d"].map((id) => todo({ id, title: `${id}面`, duePrecision: "date", dueDate: "2026-09-18" }))
      : undefined,
  );
  await h.show();
  const board = h.el("todo-list").innerHTML;
  assert.equal(board.match(/class="cal-pill"/g)?.length, 2);
  assert.match(board, /class="cal-more"[^>]*>\+2</);

  await h.el("todo-list").clickDay("2026-09-18");
  const detail = h.el("todo-detail").innerHTML;
  assert.match(detail, /9月18日 · 周五/);
  assert.match(detail, /共 4 项/);
  assert.equal(detail.match(/<article class="cal-card"/g)?.length, 4, "右栏列出当天全部");
});

test('切月：本月回到今天，其他月看 1 号；「今天」回到今天', async () => {
  const h = harness();
  await h.show();
  await h.el("cal-next").emit("click");
  assert.equal(h.el("cal-title").textContent, "2026年10月");
  assert.match(h.el("todo-detail").innerHTML, /10月1日 · 周四/);
  await h.el("cal-prev").emit("click");
  assert.match(h.el("todo-detail").innerHTML, /9月13日/);
  await h.el("cal-next").emit("click");
  await h.el("cal-today").emit("click");
  assert.equal(h.el("cal-title").textContent, "2026年9月");
  assert.match(h.el("todo-detail").innerHTML, /今天 · /);
});

test('未设具体日期的待办：折叠条一直带数量，点一条在右栏显示它', async () => {
  const h = harness((name) =>
    name === "list_todos_cmd"
      ? [
          todo({ id: "u1", title: "整理作品集", duePrecision: "none", dueDate: null }),
          todo({ id: "u2", title: "跟进结果", duePrecision: "none", dueDate: null, status: "done" }),
          todo({ id: "u3", title: "取消的事", duePrecision: "none", dueDate: null, status: "cancelled" }),
          todo({ id: "d1", title: "有日期的" , duePrecision: "date", dueDate: "2026-09-20" }),
        ]
      : undefined,
  );
  await h.show();
  assert.match(h.el("todo-undated-summary").innerHTML, /未设具体日期的待办 <span class="cal-count">\(2\)<\/span>/);
  assert.equal(h.el("todo-undated").open, false, "默认收起");
  assert.match(h.el("todo-undated-list").innerHTML, /整理作品集/);
  assert.match(h.el("todo-undated-list").innerHTML, /跟进结果/);
  assert.doesNotMatch(h.el("todo-undated-list").innerHTML, /取消的事|有日期的/);
  assert.doesNotMatch(h.el("todo-list").innerHTML, /整理作品集/, "无日期的不进月历");

  await h.el("todo-undated-list").clickButton("u1", "select-undated");
  assert.match(h.el("todo-detail").innerHTML, /未设具体日期/);
  assert.match(h.el("todo-detail").innerHTML, /整理作品集/);
  assert.doesNotMatch(h.el("todo-detail").innerHTML, /在当天添加日程/);
});

test('「查看对应投递 →」把申请 id 交给宿主；没接宿主就不显示', async () => {
  const opened: string[] = [];
  const h = harness((name) => (name === "list_todos_cmd" ? [todo({ applicationId: "app-9" })] : undefined), {
    openApplication: (id) => opened.push(id),
  });
  await h.show({ id: "t1" });
  assert.match(h.el("todo-detail").innerHTML, /查看对应投递 →/);
  await h.el("todo-detail").clickButton("t1", "go-application");
  assert.deepEqual(opened, ["app-9"]);

  const bare = harness((name) => (name === "list_todos_cmd" ? [todo()] : undefined));
  await bare.show({ id: "t1" });
  assert.doesNotMatch(bare.el("todo-detail").innerHTML, /查看对应投递/);
});

test('从别的页面带着待办 id 进来：切到那天并高亮那一条；id 找不到就按日期', async () => {
  const h = harness((name) =>
    name === "list_todos_cmd"
      ? [todo({ id: "t1", duePrecision: "date", dueDate: "2026-10-08" }), todo({ id: "t2", title: "另一条", duePrecision: "date", dueDate: "2026-10-08" })]
      : undefined,
  );
  await h.show({ id: "t2", day: "2026-10-08" });
  assert.equal(h.el("cal-title").textContent, "2026年10月");
  assert.match(h.el("todo-detail").innerHTML, /10月8日 · 周四/);
  assert.match(h.el("todo-detail").innerHTML, /data-todo-card="t2"[^>]*aria-current="true"/);
  assert.match(h.el("todo-detail").innerHTML, /data-todo-card="t1"[^>]*aria-current="false"/);

  await h.show({ id: "gone", day: "2026-11-02" });
  assert.equal(h.el("cal-title").textContent, "2026年11月");
  assert.match(h.el("todo-detail").innerHTML, /11月2日/);

  await h.show();
  assert.equal(h.el("cal-title").textContent, "2026年11月", "不带定位再进来，停在原来看的那一天");
});

test('读列表失败时说出来，不是留一片空白', async () => {
  const h = harness((name) => {
    if (name === "list_todos_cmd") throw { code: "STORE_ERROR", message: "数据库打不开" };
    return undefined;
  });
  await h.show();

  assert.match(h.el("todo-status").textContent, /数据库打不开/);
  assert.match(h.el("todo-list").innerHTML, /数据库打不开/);
  assert.match(h.el("todo-list").innerHTML, /cal-grid/, "月历框架还在");
});

test('编辑时清空提醒、时区和轮次，会显式发 null 让命令层清空', async () => {
  const h = harness((name) =>
    name === "list_todos_cmd"
      ? [todo({ duePrecision: "datetime", dueDate: null, dueAtUtc: "2026-09-20T06:00:00Z", timeZone: "Asia/Shanghai", remindAtUtc: "2026-09-20T05:00:00Z", interviewRound: 2 })]
      : undefined,
  );
  await h.show({ id: "t1" });
  await h.el("todo-detail").clickButton("t1", "edit");

  assert.equal(h.el("todo-dialog").open, true);
  assert.equal(h.el("todo-date").value, "2026-09-20", "按待办自己的时区回填墙钟");
  assert.equal(h.el("todo-time").value, "14:00");
  assert.equal(h.el("todo-more-toggle").hidden, false, "编辑时留一个「更多设置」链接");
  assert.equal(h.el("todo-form-options").hidden, false, "设过提醒、时区、轮次的自动展开");
  assert.equal(h.el("todo-remind").value, "2026-09-20T13:00");
  assert.equal(h.el("todo-round").value, "2");
  assert.equal(h.el("todo-application").disabled, true, "编辑时关联申请只读");

  h.el("todo-timezone").value = "";
  h.el("todo-remind").value = "";
  h.el("todo-round").value = "";
  await h.el("todo-form").emit("submit");

  const args = h.called("edit_todo_cmd").at(0)?.args?.args as Record<string, unknown>;
  assert.equal(args.id, "t1");
  assert.ok("timeZone" in args && args.timeZone === null);
  assert.ok("remindAtUtc" in args && args.remindAtUtc === null);
  assert.ok("interviewRound" in args && args.interviewRound === null);
  assert.equal(args.applicationId, undefined, "编辑不换申请");
});

test('只有时间没有日期、时区写错、轮次不是整数，都不发请求并就近说明', async () => {
  const h = harness();
  await h.show();
  h.el("todo-title").value = "测评";
  h.el("todo-application").value = "a1";

  h.el("todo-date").value = "";
  h.el("todo-time").value = "10:00";
  await h.el("todo-form").emit("submit");
  assert.match(h.el("todo-form-status").textContent, /也选一个日期/);

  h.el("todo-date").value = "2026-09-14";
  h.el("todo-timezone").value = "Mars/Olympus";
  await h.el("todo-form").emit("submit");
  assert.match(h.el("todo-form-status").textContent, /时区/);

  h.el("todo-timezone").value = "";
  h.el("todo-round").value = "1.5";
  await h.el("todo-form").emit("submit");
  assert.match(h.el("todo-form-status").textContent, /轮次/);
  assert.equal(h.called("create_todo_cmd").length, 0);
});

test('一条申请都没有时，新增日程先领去建申请，不让提交', async () => {
  const nodes = harness((name) => (name === "list_applications_cmd" ? { total: 0, items: [] } : undefined));
  await nodes.show();
  assert.match(nodes.el("todo-detail").innerHTML, /去新增申请/, "空状态直接给入口");
  assert.match(nodes.el("todo-detail").innerHTML, /还没有申请记录/);
  await nodes.el("todo-new").emit("click");
  assert.equal(nodes.el("todo-no-apps").hidden, false);
  assert.equal(nodes.el("todo-submit").disabled, true);
});

test('日期清空就是「未设具体日期」，只有日期时不带时刻', async () => {
  const h = harness();
  await h.show();
  h.el("todo-title").value = "整理作品集";
  h.el("todo-application").value = "a1";
  h.el("todo-date").value = "";
  h.el("todo-time").value = "";
  await h.el("todo-form").emit("submit");
  let args = h.called("create_todo_cmd").at(0)?.args?.args as Record<string, unknown>;
  assert.equal(args.duePrecision, "none");
  assert.equal(args.dueDate, null);
  assert.equal(args.dueAtUtc, null);

  h.el("todo-title").value = "交材料";
  h.el("todo-date").value = "2026-09-30";
  await h.el("todo-form").emit("submit");
  args = h.called("create_todo_cmd").at(1)?.args?.args as Record<string, unknown>;
  assert.equal(args.duePrecision, "date");
  assert.equal(args.dueDate, "2026-09-30");
  assert.equal(args.dueAtUtc, null, "没填时间就不会编出一个 00:00");
});

test('「面试 / 测评 / 笔试」按钮往标题里填词，不覆盖用户写的字', async () => {
  const h = harness();
  await h.show();
  const click = (word: string) => h.el("todo-form").emit("click", {
    target: { closest: (selector: string) => (selector.includes("data-kind-fill") ? { dataset: { kindFill: word } } : null) },
  });
  h.el("todo-title").value = "";
  await click("面试");
  assert.equal(h.el("todo-title").value, "面试");
  await click("笔试");
  assert.equal(h.el("todo-title").value, "笔试", "只是上一次点的词，直接换");
  h.el("todo-title").value = "星河 二面";
  await click("面试");
  assert.equal(h.el("todo-title").value, "面试 星河 二面");
});

test('弹窗小字如实说提醒会不会响', async () => {
  const blocked = harness((name) =>
    name === "reminder_capability_cmd" ? { available: false, reason: "系统通知未授权。" } : undefined,
  );
  await blocked.show();
  await blocked.el("todo-new").emit("click");
  assert.match(blocked.el("todo-when-note").textContent, /系统通知未授权，到期时不会弹提醒/);
  blocked.el("todo-date").value = "";
  await blocked.el("todo-date").emit("input");
  assert.match(blocked.el("todo-when-note").textContent, /未设具体日期/);
});

test('编辑只设过时区的待办：「更多设置」收着，保存时时区原样带回，不被清掉', async () => {
  const h = harness((name) =>
    name === "list_todos_cmd"
      ? [todo({ duePrecision: "datetime", dueDate: null, dueAtUtc: "2026-09-20T06:00:00Z", timeZone: "Asia/Shanghai" })]
      : undefined,
  );
  await h.show({ id: "t1" });
  await h.el("todo-detail").clickButton("t1", "edit");
  assert.equal(h.el("todo-more-toggle").hidden, false);
  assert.equal(h.el("todo-form-options").hidden, true, "只有时区不用展开");
  assert.match(h.el("todo-when-note").textContent, /Asia\/Shanghai 时区/);
  await h.el("todo-form").emit("submit");
  const args = h.called("edit_todo_cmd").at(0)?.args?.args as Record<string, unknown>;
  assert.equal(args.timeZone, "Asia/Shanghai");
  assert.equal(args.dueAtUtc, "2026-09-20T06:00:00.000Z", "按同一个时区换回去，时刻不平移");
});
