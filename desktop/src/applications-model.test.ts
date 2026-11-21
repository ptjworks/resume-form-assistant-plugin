import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ApplicationSummary, StoredEvent, TodoView } from './api.ts';
import {
  GROUPS,
  autoCorrectReason,
  buildGroups,
  groupOf,
  headerSummary,
  matchesQuery,
  nearestTodoByApplication,
  pendingNotice,
  progressChain,
  recordCall,
  rowHint,
  safeHttpUrl,
  stageChangeKind,
  updatedLabel,
} from './applications-model.ts';

const NOW = new Date(2026, 10, 21, 10, 0, 0); // 2026-11-21 10:00 本地
const app = (id: string, stage: string, over: Partial<ApplicationSummary> = {}): ApplicationSummary =>
  ({ id, company: `公司${id}`, title: '工程师', current_stage: stage as ApplicationSummary['current_stage'], updated_at: '2026-11-18T08:00:00Z', ...over });
const todo = (id: string, applicationId: string, over: Partial<TodoView> = {}): TodoView => ({
  id, applicationId, title: '二面', status: 'open', duePrecision: 'datetime', reminderState: 'none', timeZone: 'Asia/Shanghai', ...over,
});

test('groups: six groups in the agreed order, 待投递 sits after 已投递 and holds saved + filling', () => {
  assert.deepEqual(GROUPS.map((g) => g.label), ['面试中', '待测评', '已投递', '待投递', 'Offer', '已结束 / 未通过']);
  assert.equal(groupOf('interview'), 'interview');
  assert.equal(groupOf('assessment'), 'assessment');
  assert.equal(groupOf('submitted'), 'submitted');
  assert.equal(groupOf('saved'), 'pending');
  assert.equal(groupOf('filling'), 'pending');
  assert.equal(groupOf('offer'), 'offer');
  for (const stage of ['rejected', 'withdrawn', 'closed']) assert.equal(groupOf(stage), 'ended');
  // 读不出阶段的记录不会从页面上消失。
  assert.equal(groupOf(undefined), 'pending');
  assert.equal(groupOf('mystery'), 'pending');
  // 只有「已结束」默认折叠。
  assert.deepEqual(GROUPS.filter((g) => g.collapsedByDefault).map((g) => g.id), ['ended']);
});

test('groups: every application lands in exactly one group and the header counts match', () => {
  const rows = ['interview', 'assessment', 'submitted', 'saved', 'filling', 'offer', 'rejected', 'withdrawn', 'closed'].map((s, i) => app(String(i), s));
  const groups = buildGroups(rows, null, new Map());
  assert.equal(groups.reduce((n, g) => n + g.items.length, 0), rows.length);
  assert.deepEqual(groups.map((g) => g.items.length), [1, 1, 1, 2, 1, 3]);
  assert.equal(headerSummary(rows), '6 家进行中 · 3 家已结束');
});

test('groups: sorted by the nearest open todo first, then by latest update', () => {
  const rows = [
    app('old', 'interview', { updated_at: '2026-11-01T00:00:00Z' }),
    app('new', 'interview', { updated_at: '2026-11-20T00:00:00Z' }),
    app('late', 'interview', { updated_at: '2026-10-01T00:00:00Z' }),
    app('soon', 'interview', { updated_at: '2026-09-01T00:00:00Z' }),
  ];
  const nearest = nearestTodoByApplication([
    todo('t1', 'late', { dueAtUtc: '2026-11-30T06:00:00Z' }),
    todo('t2', 'soon', { dueAtUtc: '2026-11-22T06:00:00Z' }),
  ], NOW);
  const ids = buildGroups(rows, null, nearest)[0].items.map((a) => a.id);
  assert.deepEqual(ids, ['soon', 'late', 'new', 'old']);
});

test('search: matches company, title and city; counts in the header ignore the search', () => {
  const rows = [
    app('a', 'interview', { company: '字节跳动', title: '后端工程师', location: '北京' }),
    app('b', 'rejected', { company: '快手', title: '前端工程师', location: '杭州' }),
    app('c', 'submitted', { company: '美团', title: '算法', location: '上海' }),
  ];
  assert.equal(matchesQuery(rows[0], '字节'), true);
  assert.equal(matchesQuery(rows[0], '后端'), true);
  assert.equal(matchesQuery(rows[0], '北京'), true);
  assert.equal(matchesQuery(rows[0], '杭州'), false);
  const groups = buildGroups(rows, '工程师', new Map());
  assert.deepEqual(groups.map((g) => g.items.length), [1, 0, 0, 0, 0, 1]);
  // 总数不受搜索影响。
  assert.equal(groups.find((g) => g.def.id === 'ended')!.total, 1);
  assert.equal(headerSummary(rows), '2 家进行中 · 1 家已结束');
});

test('hint: a todo with a time shows the time; a date-only todo never shows 00:00', () => {
  const withTime = todo('t', 'A', { dueAtUtc: '2026-11-22T06:30:00Z' }); // 上海 14:30
  assert.equal(rowHint(app('A', 'interview'), withTime, NOW).text, '明天 14:30 二面');
  const dateOnly = todo('t', 'A', { duePrecision: 'date', dueAtUtc: null, dueDate: '2026-11-21', title: '测评截止' });
  const hint = rowHint(app('A', 'assessment'), dateOnly, NOW);
  assert.equal(hint.text, '今天 测评截止');
  assert.doesNotMatch(hint.text, /00:00|0:00/);
  assert.equal(hint.tone, 'today');
  const tomorrow = todo('t', 'A', { duePrecision: 'date', dueAtUtc: null, dueDate: '2026-11-22', title: '宣讲会' });
  assert.doesNotMatch(rowHint(app('A', 'submitted'), tomorrow, NOW).text, /\d:\d\d/);
});

test('hint: without a todo it says how long ago the record was updated, never "投递"', () => {
  const hint = rowHint(app('A', 'submitted', { updated_at: new Date(2026, 10, 18, 9, 0, 0).toISOString() }), undefined, NOW);
  assert.equal(hint.text, '3 天前更新');
  assert.equal(hint.kind, 'updated');
  assert.doesNotMatch(hint.text, /投递/);
  assert.equal(updatedLabel(new Date(2026, 10, 21, 1, 0, 0).toISOString(), NOW), '今天更新');
  assert.equal(updatedLabel(new Date(2026, 10, 20, 23, 0, 0).toISOString(), NOW), '昨天更新');
  assert.equal(updatedLabel(undefined, NOW), '');
  assert.equal(updatedLabel('not a date', NOW), '');
});

test('hint: finished todos and todos without a due time are not shown; the nearest upcoming one wins', () => {
  const nearest = nearestTodoByApplication([
    todo('done', 'A', { status: 'done', dueAtUtc: '2026-11-22T06:00:00Z' }),
    todo('none', 'A', { duePrecision: 'none', dueAtUtc: null }),
    todo('later', 'A', { dueAtUtc: '2026-11-28T06:00:00Z', title: '终面' }),
    todo('sooner', 'A', { dueAtUtc: '2026-11-23T06:00:00Z', title: '二面' }),
    todo('past', 'A', { dueAtUtc: '2026-11-10T06:00:00Z', title: '一面' }),
    todo('only-past', 'B', { dueAtUtc: '2026-11-10T06:00:00Z', title: '笔试' }),
  ], NOW);
  assert.equal(nearest.get('A')!.id, 'sooner');
  // 都过期了就取最近逾期的那条，并按逾期标。
  assert.equal(nearest.get('B')!.id, 'only-past');
  assert.equal(rowHint(app('B', 'assessment'), nearest.get('B'), NOW).tone, 'overdue');
});

test('stage change: forward with a record command is deferred, everything else is a correction', () => {
  assert.equal(stageChangeKind('submitted', 'interview'), 'record');
  assert.equal(stageChangeKind('saved', 'submitted'), 'record');
  assert.equal(stageChangeKind('interview', 'offer'), 'record');
  assert.equal(stageChangeKind('interview', 'rejected'), 'record');
  assert.equal(stageChangeKind('submitted', 'closed'), 'record');
  // 往前：纠正。
  assert.equal(stageChangeKind('interview', 'submitted'), 'correct');
  assert.equal(stageChangeKind('offer', 'assessment'), 'correct');
  assert.equal(stageChangeKind('rejected', 'interview'), 'correct');
  // 没有对应记录命令的目标：纠正。
  assert.equal(stageChangeKind('saved', 'filling'), 'correct');
  assert.equal(stageChangeKind('filling', 'saved'), 'correct');
  // 终态之间互换：同级，走纠正。
  assert.equal(stageChangeKind('rejected', 'withdrawn'), 'correct');
  assert.equal(stageChangeKind('interview', 'interview'), 'none');
  assert.equal(stageChangeKind(undefined, 'submitted'), 'record');
});

test('stage change: the correction reason is written for the user, in the agreed wording', () => {
  assert.equal(autoCorrectReason('interview', 'submitted'), '在投递页把阶段从「面试」改为「已投递」');
  assert.ok(autoCorrectReason('saved', 'filling').trim().length > 0);
});

test('record call: submitted uses confirm_submit_cmd (no date); the rest use record_*_cmd with the chosen or today date', () => {
  const submitted = recordCall('A', 'submitted', '2026-11-01', NOW);
  assert.equal(submitted.command, 'confirm_submit_cmd');
  assert.deepEqual(submitted.args, { id: 'A' });
  assert.equal(submitted.supportsDate, false);
  for (const stage of ['assessment', 'interview', 'offer', 'rejected', 'withdrawn', 'closed']) {
    const today = recordCall('A', stage, null, NOW);
    assert.equal(today.command, `record_${stage}_cmd`);
    assert.equal(today.args.updateProgress, true);
    assert.deepEqual(today.args.occurred, { precision: 'date', value: { date: '2026-11-21', time_zone: null } });
    assert.equal(today.supportsDate, true);
  }
  const picked = recordCall('A', 'interview', '2026-11-12', NOW);
  assert.deepEqual(picked.args.occurred, { precision: 'date', value: { date: '2026-11-12', time_zone: null } });
});

test('notice: says the date follows today unless one was picked', () => {
  assert.equal(pendingNotice('interview', null, NOW), '已记为「面试」，日期按今天记');
  assert.match(pendingNotice('interview', '2026-11-12', NOW), /11月12日/);
});

test('progress chain: condenses stage-change events only, bold-last is left to the view, unknown dates stay unknown', () => {
  const ev = (type: string, date: string | null, payload: Record<string, unknown> = {}, seq = 1): StoredEvent => ({
    id: `${type}${seq}`, event_type: type, event_sequence: seq, payload,
    occurred: date ? { precision: 'date', value: { date } } : { precision: 'unknown' },
  });
  const chain = progressChain([
    ev('application_created', '2026-11-08', {}, 1),
    ev('submit_confirmed', '2026-11-10', {}, 2),
    ev('note_added', '2026-11-11', { text: '随手记' }, 3),
    ev('fill_completed', '2026-11-10', {}, 4),
    ev('interview_recorded', '2026-11-12', { round: 1 }, 5),
    ev('interview_recorded', null, { round: 2 }, 6),
    ev('stage_corrected', '2026-11-20', { from: 'interview', to: 'submitted', reason: 'x' }, 7),
  ]);
  assert.deepEqual(chain.map((c) => `${c.date}|${c.label}`), ['11/10|投递', '11/12|一面', '|二面', '11/20|改为已投递']);
  // 只有创建事件时，用「创建」兜底，进度链不是空的。
  assert.deepEqual(progressChain([ev('application_created', '2026-11-08')]).map((c) => c.label), ['创建']);
  assert.deepEqual(progressChain([]), []);
});

test('safe url: only http(s) may be opened', () => {
  assert.equal(safeHttpUrl('https://jobs.example.com/a?b=1'), 'https://jobs.example.com/a?b=1');
  assert.equal(safeHttpUrl(' http://example.com '), 'http://example.com/');
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<b>', 'ftp://x.test', 'example.com', '', null, undefined]) {
    assert.equal(safeHttpUrl(bad as string), null, String(bad));
  }
});
