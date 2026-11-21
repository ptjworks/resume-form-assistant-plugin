import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReminderCapability, TodoView } from './api.ts';
import {
  describeRemindAt,
  shortDue,
  LIFECYCLE_STATES,
  QUIT_WARNING,
  bucketOf,
  describeCapability,
  describeDigest,
  describeDue,
  describeReminder,
  describeSave,
  describeStatusChange,
  localDay,
  buildCalendar,
  cellLabel,
  companyShort,
  dayHeading,
  daySummary,
  entryState,
  inferKind,
  monthGrid,
  monthOf,
  pillText,
  shiftDay,
  shiftMonth,
  summarizeOverdue,
  todoClock,
  todoDay,
  weekdayOf,
} from './todos.ts';

const AVAILABLE: ReminderCapability = { available: true, reason: null };
const BLOCKED: ReminderCapability = { available: false, reason: "系统通知未授权。" };

function todo(overrides: Partial<TodoView> = {}): TodoView {
  return {
    id: "t1",
    applicationId: "a1",
    title: "一面",
    duePrecision: "none",
    status: "open",
    reminderState: "none",
    company: "合成公司",
    position: "后端工程师",
    ...overrides,
  };
}

// 本地时区跑测试，用当天算相对日期，避免夏令时和跨日把断言弄脆。
const NOW = new Date(2026, 8, 13, 10, 0, 0); // 2026-09-13 10:00 本地
const TODAY = localDay(NOW);

function daysFromToday(count: number): string {
  const d = new Date(NOW);
  d.setDate(d.getDate() + count);
  return localDay(d);
}

test('只有日历日的待办永远不显示成 00:00', () => {
  const text = describeDue(todo({ duePrecision: "date", dueDate: "2026-09-20" }));

  assert.match(text, /2026-09-20/);
  assert.doesNotMatch(text, /00:00/, "「9 月 20 日截止」和「9 月 20 日 00:00 截止」是两句话");
  assert.match(text, /未定时间/);
});

test('精确到期显示到分钟，有时区就带上', () => {
  const withZone = describeDue(
    todo({ duePrecision: "datetime", dueAtUtc: "2026-09-14T02:00:00Z", timeZone: "Asia/Shanghai" }),
  );
  assert.match(withZone, /Asia\/Shanghai/);

  const broken = describeDue(todo({ duePrecision: "datetime", dueAtUtc: "不是时间" }));
  assert.match(broken, /读不出来/, "读不出来就说读不出来，不要显示 Invalid Date");
});

test('没有到期就说没有到期', () => {
  assert.equal(describeDue(todo()), "未设到期");
});

test('今天到期的日历日待办不算逾期', () => {
  assert.equal(bucketOf(todo({ duePrecision: "date", dueDate: TODAY }), NOW), "today");
  assert.equal(
    bucketOf(todo({ duePrecision: "date", dueDate: daysFromToday(-1) }), NOW),
    "overdue",
    "昨天才算逾期",
  );
});

test('分组按到期远近，没有到期的单独一组，结束的归到最后', () => {
  assert.equal(bucketOf(todo({ duePrecision: "date", dueDate: daysFromToday(3) }), NOW), "week");
  assert.equal(bucketOf(todo({ duePrecision: "date", dueDate: daysFromToday(30) }), NOW), "later");
  assert.equal(bucketOf(todo(), NOW), "someday");
  assert.equal(bucketOf(todo({ status: "done", duePrecision: "date", dueDate: daysFromToday(-9) }), NOW), "closed");
});

test('精确时刻按时刻比，不按日历日', () => {
  const earlierToday = new Date(NOW);
  earlierToday.setHours(8, 0, 0, 0);
  const laterToday = new Date(NOW);
  laterToday.setHours(23, 0, 0, 0);

  assert.equal(
    bucketOf(todo({ duePrecision: "datetime", dueAtUtc: earlierToday.toISOString() }), NOW),
    "overdue",
    "今天早上八点已经过去了",
  );
  assert.equal(
    bucketOf(todo({ duePrecision: "datetime", dueAtUtc: laterToday.toISOString() }), NOW),
    "today",
  );
});

test('五种提醒状态各有各的说法', () => {
  const scheduled = describeReminder(
    todo({ reminderState: "scheduled", reminderScheduledForUtc: "2026-09-14T02:00:00Z" }),
    AVAILABLE,
  );
  assert.equal(scheduled.tone, "success");
  assert.match(scheduled.text, /将在/);

  assert.match(describeReminder(todo({ reminderState: "fired" }), AVAILABLE).text, /已经提醒过/);
  assert.equal(describeReminder(todo({ reminderState: "missed" }), AVAILABLE).tone, "warn");

  // 这一条没登记上，原因跟着机器的能力走。
  const blocked = describeReminder(todo({ reminderState: "unsupported" }), BLOCKED);
  assert.equal(blocked.tone, "warn");
  assert.match(blocked.text, /未授权/);

  assert.match(describeReminder(todo({ status: "done" }), AVAILABLE).text, /不会再提醒/);
  assert.match(describeReminder(todo(), AVAILABLE).text, /没有到期/);
});

test('机器能弹但这一条没登记上，也要说得出来', () => {
  const message = describeReminder(todo({ reminderState: "unsupported" }), AVAILABLE);
  assert.equal(message.tone, "warn");
  assert.match(message.text, /没能登记/);
});

test('保存成功和提醒失败要同时说出来', () => {
  assert.deepEqual(describeSave("created"), { tone: "success", text: "已添加。" });

  const partial = describeSave("updated", "系统通知未授权。");
  assert.equal(partial.tone, "warn");
  assert.match(partial.text, /已保存/, "保存是成功了的，不能只说失败");
  assert.match(partial.text, /未授权/);

  assert.match(describeStatusChange("done").text, /已标记完成/);
  assert.match(describeStatusChange("open", "时区不认识").text, /重新打开/);
});

test('逾期汇总说的是「过了时间」，不是「提醒过了」', () => {
  assert.equal(describeDigest(0, 0), null);

  const some = describeDigest(3, 0);
  assert.match(some?.text ?? "", /3 条/);
  assert.doesNotMatch(
    some?.text ?? "",
    /提醒过|通知过/,
    "很可能一次都没弹过（电脑关着、未授权），别替系统吹牛",
  );
  assert.match(describeDigest(50, 1)?.text ?? "", /还有更多/);
});

test('设置页要说清关窗会响、退出不会响', () => {
  const on = describeCapability(AVAILABLE);
  assert.match(on.text, /窗口关着也会响/);
  assert.match(on.text, /退出应用.*不会响/);

  const off = describeCapability(BLOCKED);
  assert.equal(off.tone, "warn");
  assert.match(off.text, /未授权/);
  assert.match(off.text, /待办列表和逾期汇总照常可用/, "提醒没了不等于功能没了");
});

test('五种生命周期状态一条不少，且关窗与退出说的是相反的结果', () => {
  const when = LIFECYCLE_STATES.map((s) => s.when);
  assert.equal(LIFECYCLE_STATES.length, 5, "§5.4 列了五种，一条都不能省");

  const closed = LIFECYCLE_STATES.find((s) => s.when.includes("关闭窗口"));
  const quit = LIFECYCLE_STATES.find((s) => s.when.includes("退出"));
  assert.match(closed?.what ?? "", /照常提醒/);
  assert.match(quit?.what ?? "", /不再提醒/, "关窗和退出在用户眼里差不多，结果却相反");

  const denied = LIFECYCLE_STATES.find((s) => s.when.includes("权限"));
  assert.match(denied?.what ?? "", /照常可用/, "没权限不等于待办没了");

  const asleep = LIFECYCLE_STATES.find((s) => s.when.includes("休眠"));
  assert.match(asleep?.what ?? "", /汇总一次/);
  assert.doesNotMatch(asleep?.what ?? "", /一定|保证/, "不许承诺关机期间也送到");

  assert.equal(new Set(when).size, 5, "五条不能有重复");
});

test('退出前那句话要同时说清提醒会停、待办还在', () => {
  assert.match(QUIT_WARNING, /不会弹出提醒/);
  assert.match(QUIT_WARNING, /撤销/);
  assert.match(QUIT_WARNING, /待办本身都还在/, "别让用户以为退出会丢数据");
});

test('列表标签：只有日期的不带时刻，精确时刻按待办自己的时区写钟点', () => {
  const now = new Date(2026, 8, 13, 10, 0, 0);
  assert.deepEqual(shortDue(todo({ duePrecision: 'date', dueDate: '2026-09-13' }), now), { text: '今天', tone: 'today' });
  assert.deepEqual(shortDue(todo({ duePrecision: 'date', dueDate: '2026-09-14' }), now), { text: '明天', tone: 'normal' });
  assert.deepEqual(shortDue(todo({ duePrecision: 'date', dueDate: '2026-09-12' }), now), { text: '已逾期 · 昨天', tone: 'overdue' });
  assert.equal(shortDue(todo({ duePrecision: 'date', dueDate: '2026-10-02' }), now).text, '10月2日');
  assert.equal(shortDue(todo({ duePrecision: 'date', dueDate: '2027-01-02' }), now).text, '2027年1月2日');
  const zoned = shortDue(
    todo({ duePrecision: 'datetime', dueDate: null, dueAtUtc: '2026-09-20T06:30:00Z', timeZone: 'Asia/Shanghai' }),
    now,
  );
  assert.equal(zoned.text, '9月20日 14:30');
  assert.deepEqual(shortDue(todo({ duePrecision: 'none', dueDate: null }), now), { text: '无到期', tone: 'none' });
  assert.equal(shortDue(todo({ status: 'done', duePrecision: 'date', dueDate: '2026-09-12' }), now).tone, 'closed', '已完成的不再标逾期');
});

test('提醒时刻：没单独设就说按到期提醒，不编一个时刻', () => {
  assert.match(describeRemindAt(todo({ duePrecision: 'date', dueDate: '2026-09-20', remindAtUtc: null })), /按到期时间/);
  assert.equal(describeRemindAt(todo({ duePrecision: 'none', dueDate: null, remindAtUtc: null })), '未设');
  assert.match(describeRemindAt(todo({ remindAtUtc: '2026-09-20T01:00:00Z', timeZone: 'Asia/Shanghai' })), /09:00/);
});

// --- 日历页（#551） ---------------------------------------------------------------------

test('类型按轮次与标题关键词推断：面试 > 测评 > 笔试 > 其他', () => {
  assert.equal(inferKind(todo({ title: '一面', interviewRound: null })), 'interview');
  assert.equal(inferKind(todo({ title: '准备材料', interviewRound: 2 })), 'interview', '有轮次就是面试');
  assert.equal(inferKind(todo({ title: '在线测评' })), 'assessment');
  assert.equal(inferKind(todo({ title: '技术笔试' })), 'written');
  assert.equal(inferKind(todo({ title: '跟进结果' })), 'other');
  assert.equal(inferKind(todo({ title: '笔试后面试', interviewRound: null })), 'interview', '先看面试');
});

test('仅日历日的待办在日历里没有时刻，绝不出现 00:00', () => {
  const entry = buildCalendar([todo({ duePrecision: 'date', dueDate: '2026-11-19', title: '一面' })], NOW)
    .byDay.get('2026-11-19')?.[0];
  assert.ok(entry);
  assert.equal(entry.clock, null);
  assert.doesNotMatch(pillText(entry), /00:00|\d{2}:\d{2}/, '胶囊里不写时刻');
  assert.equal(todoClock(todo({ duePrecision: 'date', dueDate: '2026-11-19' })), null);
  // 仍有 dueAtUtc 残留也不能把日历日当成零点。
  assert.equal(
    todoClock(todo({ duePrecision: 'date', dueDate: '2026-11-19', dueAtUtc: '2026-11-19T00:00:00Z' })),
    null,
  );
});

test('精确时刻按待办自己的时区落在哪一天、写什么钟点', () => {
  // 北京时间 11-19 07:30 = UTC 11-18 23:30：在上海属于 19 日，在 UTC 属于 18 日。
  const shanghai = todo({ duePrecision: 'datetime', dueAtUtc: '2026-11-18T23:30:00Z', timeZone: 'Asia/Shanghai' });
  assert.equal(todoDay(shanghai), '2026-11-19');
  assert.equal(todoClock(shanghai), '07:30');
  const utc = todo({ duePrecision: 'datetime', dueAtUtc: '2026-11-18T23:30:00Z', timeZone: 'UTC' });
  assert.equal(todoDay(utc), '2026-11-18');
  assert.equal(todoClock(utc), '23:30');
  const entry = buildCalendar([shanghai], NOW).byDay.get('2026-11-19')?.[0];
  assert.equal(pillText(entry!), '07:30 面试 · 合成');
});

test('读不出日期的待办进「未设具体日期」，不丢；已取消的不显示', () => {
  const model = buildCalendar(
    [
      todo({ id: 'none' }),
      todo({ id: 'broken', duePrecision: 'datetime', dueAtUtc: '不是时间' }),
      todo({ id: 'badDate', duePrecision: 'date', dueDate: '明天' }),
      todo({ id: 'cancelled', status: 'cancelled', duePrecision: 'date', dueDate: '2026-11-19' }),
      todo({ id: 'cancelledUndated', status: 'cancelled' }),
      todo({ id: 'done', status: 'done', duePrecision: 'date', dueDate: '2026-11-19' }),
    ],
    NOW,
  );
  assert.deepEqual(model.undated.map((t) => t.id), ['none', 'broken', 'badDate']);
  assert.deepEqual(model.byDay.get('2026-11-19')?.map((e) => e.todo.id), ['done'], '已完成照样显示');
});

test('同一天：仅日期的在前，再按时刻', () => {
  const day = '2026-11-19';
  const at = (id: string, clock: string) =>
    todo({ id, duePrecision: 'datetime', dueAtUtc: new Date(`${day}T${clock}:00`).toISOString() });
  const model = buildCalendar(
    [at('late', '16:00'), todo({ id: 'allday', duePrecision: 'date', dueDate: day }), at('early', '09:30')],
    NOW,
  );
  assert.deepEqual(model.byDay.get(day)?.map((e) => e.todo.id), ['allday', 'early', 'late']);
});

test('状态：已完成、过时未完成标红，今天才到期的日期待办不算逾期', () => {
  assert.equal(entryState(todo({ status: 'done', duePrecision: 'date', dueDate: daysFromToday(-3) }), NOW), 'done');
  assert.equal(entryState(todo({ duePrecision: 'date', dueDate: daysFromToday(-1) }), NOW), 'overdue');
  assert.equal(entryState(todo({ duePrecision: 'date', dueDate: TODAY }), NOW), 'open');
  assert.equal(entryState(todo({ duePrecision: 'date', dueDate: daysFromToday(2) }), NOW), 'open');
});

test('月历 35 或 42 格，周一起，前后补相邻月份且标为非本月', () => {
  // 2026 年 11 月：1 日是周日 → 前面补 6 天，30 天共 36 格 → 6 行。
  const nov = monthGrid({ year: 2026, month: 11 });
  assert.equal(nov.length, 42);
  assert.equal(nov[0]?.day, '2026-10-26');
  assert.equal(weekdayOf(nov[0]!.day), 1, '第一列是周一');
  assert.equal(nov.filter((cell) => cell.inMonth).length, 30);
  assert.equal(nov[6]?.day, '2026-11-01');
  // 2026 年 2 月：1 日是周日，但只有 28 天，仍需 6 行；2027 年 2 月 1 日周一 28 天 → 4 行补到 35。
  assert.equal(monthGrid({ year: 2026, month: 2 }).length, 35, '2 月：周日起 6 + 28 = 34 → 35');
  assert.equal(monthGrid({ year: 2027, month: 2 }).length, 35);
  assert.equal(monthGrid({ year: 2026, month: 9 }).length, 35, '9 月 1 日周二，30 天 → 35');
  for (const cells of [nov, monthGrid({ year: 2026, month: 9 })]) {
    assert.equal(cells.length % 7, 0);
  }
});

test('切月跨年，天数加减不受夏令时影响', () => {
  assert.deepEqual(shiftMonth({ year: 2026, month: 12 }, 1), { year: 2027, month: 1 });
  assert.deepEqual(shiftMonth({ year: 2026, month: 1 }, -1), { year: 2025, month: 12 });
  assert.deepEqual(monthOf('2026-11-19'), { year: 2026, month: 11 });
  assert.equal(shiftDay('2026-03-08', 1), '2026-03-09');
  assert.equal(shiftDay('2026-12-31', 1), '2027-01-01');
});

test('逾期汇总：数量与最早一天；已完成、没到点的不算', () => {
  const summary = summarizeOverdue(
    [
      todo({ id: 'a', duePrecision: 'date', dueDate: daysFromToday(-2) }),
      todo({ id: 'b', duePrecision: 'date', dueDate: daysFromToday(-9) }),
      todo({ id: 'done', status: 'done', duePrecision: 'date', dueDate: daysFromToday(-20) }),
      todo({ id: 'today', duePrecision: 'date', dueDate: TODAY }),
      todo({ id: 'future', duePrecision: 'date', dueDate: daysFromToday(3) }),
    ],
    NOW,
  );
  assert.equal(summary.count, 2);
  assert.deepEqual(summary.earliest, { day: daysFromToday(-9), id: 'b' });
  assert.deepEqual(summarizeOverdue([], NOW), { count: 0, earliest: null });
});

test('右栏标题与副标题', () => {
  assert.equal(dayHeading('2026-11-19'), '11月19日 · 周四');
  assert.equal(daySummary('2026-11-20', '2026-11-19', 2), '明天 · 共 2 项');
  assert.equal(daySummary('2026-11-19', '2026-11-19', 1), '今天 · 共 1 项');
  assert.equal(daySummary('2026-12-01', '2026-11-19', 0), '没有日程');
  assert.match(cellLabel('2026-11-19', 3), /11月19日 周四，3 项日程/);
});

test('公司简称：去掉有限公司和括号，过长截断', () => {
  assert.equal(companyShort('星河科技有限公司'), '星河科技');
  assert.equal(companyShort('远山（中国）有限公司'), '远山');
  assert.equal(companyShort('北京字节跳动网络技术有限公司'), '北京字节跳动');
  assert.equal(companyShort('有限公司'), '有限公司', '去空了就用原名');
  assert.equal(companyShort(null), '');
});
