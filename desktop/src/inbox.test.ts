import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHOOSE_APPLICATION_HINT,
  EMPTY_INBOX,
  PRIVACY_NOTE,
  buildInboxRows,
  listTimeLabel,
  todoCount,
  describeAssociation,
  describeClassification,
  describeEvidenceMeta,
  describeImport,
  describeUnassociation,
  duplicateNote,
  evidenceTitle,
  importErrorText,
  importedAtLabel,
  replyClassLabel,
  sendModeLabel,
  sizeLabel,
} from './inbox.ts';

test('an import is reported per outcome, and a duplicate is not an error', () => {
  const ok = describeImport({ imported: [{ id: 'a' }], duplicates: [], failed: [] });
  assert.equal(ok.tone, 'success');
  assert.match(ok.text, /已导入 1 条，放在「待处理」里/);

  const mixed = describeImport({
    imported: [{ id: 'a' }],
    duplicates: [{ id: 'b' }],
    failed: [{ name: 'invite.msg', code: 'unsupported' }],
  });
  assert.equal(mixed.tone, 'warn');
  assert.match(mixed.text, /invite\.msg/);
  assert.match(mixed.text, /另存为 \.eml/);
  assert.match(mixed.text, /没有重复保存/);

  assert.equal(describeImport({ imported: [], duplicates: [], failed: [] }).tone, 'info');
});

test('every import failure has a sentence, including the ones we did not enumerate', () => {
  assert.match(importErrorText('too_large'), /25 MiB/);
  assert.match(importErrorText('source_unreadable'), /读不到/);
  assert.match(importErrorText('storage'), /什么都没有留下/);
  assert.match(importErrorText('too_many_files'), /20 个/);
  assert.match(importErrorText('something-new'), /没能导入/);
});

test('classification words never claim a human sent it', () => {
  assert.equal(replyClassLabel('interview_invite'), '面试邀请');
  assert.equal(sendModeLabel(undefined), '未知');
  assert.equal(sendModeLabel('automated'), '系统自动发送');
  const said = describeClassification({ replyClass: 'interview_invite', sendMode: 'automated' }).text;
  assert.match(said, /面试邀请/);
  assert.match(said, /系统自动发送/);
  assert.doesNotMatch(said, /人工/);
  assert.match(said, /不改变投递阶段/);
});

test('associating says what it did and what it did not do', () => {
  const said = describeAssociation({ id: 'e1' }, '星河科技').text;
  assert.match(said, /星河科技/);
  assert.match(said, /已移到「已处理」/, '关联之后材料去了哪儿要说出来');
  assert.match(said, /不会改变投递的阶段/);
  assert.doesNotMatch(said, /回复了/);
  assert.match(describeUnassociation().text, /已取消关联.*「待处理」/);
  assert.doesNotMatch(describeUnassociation().text, /回复证据|尚未导入/, '不推断投递是否还有其他材料');
});

test('a title falls back from subject to filename to kind', () => {
  assert.equal(evidenceTitle({ subject: '面试邀请', originalFilename: 'x.eml' }), '面试邀请');
  assert.equal(evidenceTitle({ subject: '   ', originalFilename: 'x.eml' }), 'x.eml');
  assert.equal(evidenceTitle({ kind: 'paste' }), '粘贴文本');
});

test('the meta line carries the sender and both times, and sizes read as sizes', () => {
  const meta = describeEvidenceMeta({
    kind: 'eml',
    fromAddr: 'hr@example.test',
    sentAt: '2026-09-12T08:00:00.000Z',
    importedAt: '2026-09-12T09:00:00.000Z',
    sizeBytes: 2048,
  });
  assert.match(meta, /邮件/);
  assert.match(meta, /hr@example\.test/);
  // 时间按本机时区写成「年-月-日 时:分」，不把 UTC 的 ISO 串直接丢给用户。
  assert.match(meta, new RegExp(`发送于 ${importedAtLabel('2026-09-12T08:00:00.000Z')}`));
  assert.match(meta, new RegExp(`导入于 ${importedAtLabel('2026-09-12T09:00:00.000Z')}`));
  assert.doesNotMatch(meta, /T08:00/);
  assert.match(meta, /2\.0 KiB/);
  assert.equal(sizeLabel(999), '999 B');
  assert.equal(sizeLabel(5 * 1024 * 1024), '5.0 MiB');
});

test('the duplicate hint counts the others and explains the single copy', () => {
  assert.equal(duplicateNote({ sameBytesAs: [] }), '');
  assert.match(duplicateNote({ sameBytesAs: ['a', 'b'] }), /另外 2 条/);
  assert.match(duplicateNote({ sameBytesAs: ['a'] }), /只存了一次/);
});

test('the empty inbox and the application hint say the honest thing', () => {
  assert.match(EMPTY_INBOX, /「已处理」/, '关联过的材料去了哪儿要说清楚');
  assert.match(PRIVACY_NOTE, /本机/);
  assert.match(PRIVACY_NOTE, /确认/);
  assert.doesNotMatch(PRIVACY_NOTE, /同步邮箱|自动收信/);
  assert.doesNotMatch(EMPTY_INBOX, /没有回复|未回复/);
  assert.match(CHOOSE_APPLICATION_HINT, /不会替你猜/);
});

// ---- #552 三态：待处理 / 已处理 / 回收站 ----

const evidence = (id: string, extra: Record<string, unknown> = {}) => ({
  id, applicationId: null, kind: 'eml', mime: null, sizeBytes: 10, originalFilename: null,
  importedAt: '2026-10-01T10:00:00Z', subject: `信 ${id}`, fromAddr: `${id}@example.test`, sentAt: null,
  replyClass: null, sendMode: null, sameBytesAs: [], ...extra,
}) as never;
const candidate = (id: string, sentAt: string | null, extra: Record<string, unknown> = {}) => ({
  id, accountId: 'acc', email: 'me@example.test',
  header: { fromAddr: `${id}@corp.test`, fromName: `公司${id}`, subject: `候选 ${id}`, sentAt, ...extra },
  reasons: ['标题包含：面试'],
}) as never;

test('待处理 puts new mail and filed-but-unlinked mail in one list, newest first, each with its step', () => {
  const rows = buildInboxRows({
    tab: 'todo',
    candidates: [candidate('c1', '2026-10-03T08:00:00Z'), candidate('c2', '2026-10-01T08:00:00Z')],
    stored: [evidence('s1', { sentAt: '2026-10-02T08:00:00Z' }), evidence('s2', { importedAt: '2026-10-04T08:00:00Z' })],
    done: [evidence('d1')], bin: [evidence('b1')],
  });
  assert.deepEqual(rows.map((row) => row.key), ['e:s2', 'c:c1', 'e:s1', 'c:c2']);
  assert.deepEqual(rows.map((row) => row.step), ['archive', 'new', 'archive', 'new']);
  assert.equal(rows[1]!.sender, '公司c1', '新邮件显示发件人名字');
  assert.equal(rows[0]!.sender, 's2@example.test');
  assert.equal(rows.some((row) => row.id === 'd1' || row.id === 'b1'), false, '已处理和回收站的不混进来');
});

test('a candidate and an evidence with the same id stay two different rows', () => {
  const rows = buildInboxRows({ tab: 'todo', candidates: [candidate('x', '2026-10-01T00:00:00Z')], stored: [evidence('x')], done: [], bin: [] });
  assert.equal(new Set(rows.map((row) => row.key)).size, 2);
});

test('mail without any time sorts last and keeps new mail ahead of filed mail on a tie', () => {
  const rows = buildInboxRows({
    tab: 'todo',
    candidates: [candidate('c1', null)],
    stored: [evidence('s1', { importedAt: '' })],
    done: [], bin: [],
  });
  assert.deepEqual(rows.map((row) => row.key), ['c:c1', 'e:s1']);
});

test('已处理 shows the company and job it is linked to; 回收站 keeps the order the host gave', () => {
  const done = buildInboxRows({
    tab: 'done', candidates: [], stored: [], bin: [],
    done: [evidence('d1', { company: '星河科技', title: '后端工程师', importedAt: '2026-10-01T00:00:00Z' }), evidence('d2', { company: '极光', title: '', importedAt: '2026-10-05T00:00:00Z' })],
  });
  assert.deepEqual(done.map((row) => [row.id, row.sub, row.step]), [['d2', '极光', 'done'], ['d1', '星河科技 · 后端工程师', 'done']]);
  const bin = buildInboxRows({ tab: 'bin', candidates: [], stored: [], done: [], bin: [evidence('b2', { importedAt: '2026-01-01T00:00:00Z' }), evidence('b1', { importedAt: '2026-09-01T00:00:00Z' })] });
  assert.deepEqual(bin.map((row) => row.id), ['b2', 'b1']);
});

test('duplicate content is flagged and untitled mail still has a title and a sender', () => {
  const [row] = buildInboxRows({
    tab: 'todo', candidates: [], done: [], bin: [],
    stored: [evidence('s1', { subject: null, originalFilename: null, fromAddr: null, kind: 'paste', sameBytesAs: ['z'] })],
  });
  assert.equal(row!.duplicate, true);
  assert.equal(row!.title, '粘贴文本');
  assert.equal(row!.sender, '粘贴文本');
  const [none] = buildInboxRows({ tab: 'todo', done: [], bin: [], stored: [], candidates: [candidate('n', null, { subject: null, fromName: null, fromAddr: null })] });
  assert.equal(none!.title, '无主题邮件');
  assert.equal(none!.sender, '未知发件人');
});

test('list times read short: clock today, month-day this year, full date before that', () => {
  const now = new Date(2026, 9, 20, 15, 0, 0);
  assert.equal(listTimeLabel(new Date(2026, 9, 20, 9, 5).toISOString(), now), '09:05');
  assert.equal(listTimeLabel('2026-10-20', now), '今天');
  assert.equal(listTimeLabel(new Date(2026, 2, 3, 12, 0).toISOString(), now), '3月3日');
  assert.equal(listTimeLabel(new Date(2025, 11, 31, 12, 0).toISOString(), now), '2025-12-31');
  assert.equal(listTimeLabel(null, now), '');
  assert.equal(listTimeLabel('not a date at all', now), 'not a date');
});

test('the 待处理 badge adds new mail to filed mail and never shows a made-up zero', () => {
  assert.equal(todoCount(2, 3), '5');
  assert.equal(todoCount(0, 0), '0');
  assert.equal(todoCount(null, 4), '', '读不到待归档时不报数');
});
