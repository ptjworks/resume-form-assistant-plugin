import { beforeEach, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fireEvent, waitFor, within } from "@testing-library/dom";
import { mountInbox } from "./inbox-ui.ts";
import type { InboxHost } from "./inbox-ui.ts";
import type { MailboxInboxState } from "./inbox.ts";
import type { Invoke } from "./api.ts";

beforeEach(() => {
  document.body.innerHTML = readFileSync("index.html", "utf8").split("<body>")[1].split("</body>")[0];
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});

const el = (id: string) => document.getElementById(id)!;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const MAIL = {
  id: "e1", applicationId: null, kind: "eml", mime: "message/rfc822", sizeBytes: 2048, originalFilename: "面试邀请.eml",
  importedAt: "2026-09-12T09:00:00.000Z", subject: "面试邀请", fromAddr: "hr@example.test", sentAt: "2026-09-12T08:00:00.000Z",
  replyClass: null, sendMode: null, sameBytesAs: [], recycled: false,
};
const body = (item: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ ...item, bodyExtract: "正文", imageDataUrl: null, note: null, ...extra });
const candidate = (id: string, subject = "星河科技笔试通知", sentAt = "2026-10-25T02:08:00Z") => ({
  id, accountId: "acc", email: "me@example.test",
  header: { fromAddr: "hr@xinghe.test", fromName: "星河科技招聘", subject, sentAt }, reasons: ["匹配投递公司：星河科技", "标题包含：笔试"],
});
const APPS = { total: 2, items: [{ id: "app-1", company: "星河科技", title: "后端开发" }, { id: "app-2", company: "星河科技", title: "数据平台" }] };

type Handler = (args?: Record<string, unknown>) => unknown;
function setup(handlers: Record<string, Handler> = {}, host: InboxHost = {}) {
  const calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
  const invoke = (async (name: string, args?: Record<string, unknown>) => {
    calls.push({ name, args });
    if (handlers[name]) return handlers[name](args);
    if (name === "list_inbox_cmd" || name === "list_associated_evidence_cmd" || name === "list_recycled_evidence_cmd") return [];
    if (name === "list_applications_cmd") return { total: 0, items: [] };
    return {};
  }) as Invoke;
  const inbox = mountInbox(invoke, host);
  const called = (name: string) => calls.filter((call) => call.name === name);
  return { inbox, calls, called, list: within(el("inbox-list")), reader: within(el("inbox-preview")) };
}
function mailbox(items: ReturnType<typeof candidate>[], extra: Partial<MailboxInboxState> = {}): MailboxInboxState & { save: ReturnType<typeof vi.fn>; ignore: ReturnType<typeof vi.fn>; loadMore: ReturnType<typeof vi.fn> } {
  const save = vi.fn(), ignore = vi.fn(), loadMore = vi.fn();
  return {
    candidates: items as never, pendingCount: items.length, note: null, failures: {}, canLoadMore: false,
    actions: { save, ignore, loadMore }, save, ignore, loadMore, ...extra,
  };
}

test("an empty inbox explains itself without claiming nobody replied, and offers the import entry points", async () => {
  const h = setup();
  await h.inbox.refresh();
  expect(within(el("inbox-list")).getByRole("heading", { name: "没有待处理的通知" })).toBeTruthy();
  const page = el("inbox-preview");
  expect(page.querySelector('[data-empty-act="pick"]')).toBeTruthy();
  expect(page.querySelector('[data-empty-act="paste"]')).toBeTruthy();
  expect(page.textContent).toContain("保存在本机");
  expect(el("inbox-shell").textContent).not.toMatch(/未回复|没有回复|同步邮箱/);
  expect(el("inbox-count").textContent).toBe("0");
});

test("the three tabs follow a mail's journey: 待处理, 已处理, 回收站", () => {
  const tabs = [...document.querySelectorAll("#view-inbox [role=tab]")].map((tab) => tab.textContent!.trim());
  expect(tabs).toEqual(["待处理", "已处理", "回收站"]);
  expect(el("view-inbox").textContent).not.toMatch(/待确认|待关联/);
});

test("待处理 lists new mail and filed mail together, newest first, each tagged with its step", async () => {
  const filed = { ...MAIL, id: "s1", subject: "已存的一封", importedAt: "2026-10-26T01:00:00Z", sentAt: null };
  const h = setup({ list_inbox_cmd: () => [filed] });
  h.inbox.setMailbox(mailbox([candidate("c1")]));
  await h.inbox.refresh();
  const rows = [...document.querySelectorAll("#inbox-list ul.inbox-rows li")].map((li) => li.textContent!);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toContain("已存的一封");
  expect(rows[0]).toContain("待归档");
  expect(rows[1]).toContain("星河科技笔试通知");
  expect(rows[1]).toContain("新邮件");
  expect(rows[1]).toContain("星河科技招聘");
  expect(el("inbox-count").textContent).toBe("2");
  // 列表里没有未读 / 未分类圆点。
  expect(document.querySelector("#inbox-list .evidence-dot, #inbox-list .unread-dot")).toBeNull();
});

test("a new mail shows only its header, with just keep and ignore and no explanations", async () => {
  const h = setup();
  const mail = mailbox([candidate("c1")]);
  h.inbox.setMailbox(mail);
  await h.inbox.refresh();
  fireEvent.click(h.list.getByRole("button", { name: /星河科技笔试通知/ }));
  const buttons = [...el("inbox-preview").querySelectorAll(".mail-actions button")].map((button) => button.textContent);
  expect(buttons).toEqual(["留下", "忽略"]);
  expect(el("inbox-preview").textContent).toContain("原文还没有下载");
  expect(el("inbox-preview").textContent).not.toMatch(/匹配投递公司|为什么出现在这里/);
  expect(el("inbox-preview").querySelector(".evidence-body, #inbox-ai, select")).toBeNull();
  fireEvent.click(h.reader.getByRole("button", { name: "留下" }));
  expect(mail.save).toHaveBeenCalledWith(["c1"]);
  fireEvent.click(h.reader.getByRole("button", { name: "忽略" }));
  expect(mail.ignore).toHaveBeenCalledWith(["c1"]);
});

test("server-controlled sender, subject and reasons render as text", async () => {
  const h = setup();
  const item = candidate("c1", '<img src=x onerror="steal()">');
  item.header.fromName = "<b>伪装</b>"; item.reasons = ["<script>steal()</script>"];
  h.inbox.setMailbox(mailbox([item]));
  await h.inbox.refresh();
  fireEvent.click(h.list.getAllByRole("button")[0]!);
  expect(el("view-inbox").querySelector("img, script, b")).toBeNull();
  expect(el("inbox-preview").textContent).toContain('<img src=x onerror="steal()">');
  expect(el("inbox-list").textContent).toContain("<b>伪装</b>");
});

test("a failed keep shows the reason on that mail and the mail stays to retry", async () => {
  const h = setup();
  h.inbox.setMailbox(mailbox([candidate("c1")], { failures: { c1: "下载失败：邮箱暂时连不上" } }));
  await h.inbox.refresh();
  fireEvent.click(h.list.getAllByRole("button")[0]!);
  expect(el("inbox-preview").textContent).toContain("下载失败：邮箱暂时连不上");
  expect(h.reader.getByRole("button", { name: "留下" })).toBeTruthy();
});

test("with two or more new mails a one-line bar keeps or ignores them all; ignoring all asks first", async () => {
  const h = setup();
  const mail = mailbox([candidate("c1"), candidate("c2", "第二封")]);
  h.inbox.setMailbox(mail);
  await h.inbox.refresh();
  const bar = within(el("inbox-batch"));
  expect(el("inbox-batch").hidden).toBe(false);
  expect(el("inbox-batch").textContent).toContain("2 封新邮件");
  fireEvent.click(bar.getByRole("button", { name: "全部留下" }));
  expect(mail.save).toHaveBeenCalledWith(["c1", "c2"]);
  fireEvent.click(bar.getByRole("button", { name: "全部忽略" }));
  expect(mail.ignore).not.toHaveBeenCalled();
  const dialog = await waitFor(() => { const open = document.querySelector<HTMLDialogElement>("dialog.settings-dialog[open]"); expect(open).toBeTruthy(); return open!; });
  expect(dialog.textContent).toContain("忽略这 2 封新邮件");
  fireEvent.click(within(dialog).getByRole("button", { name: "全部忽略" }));
  await waitFor(() => expect(mail.ignore).toHaveBeenCalledWith(["c1", "c2"]));
  // 只剩一封时不显示批量条。
  h.inbox.setMailbox(mailbox([candidate("c1")]));
  expect(el("inbox-batch").hidden).toBe(true);
});

test("the mailbox note and 'show more' appear in the list only while 待处理 is open", async () => {
  const h = setup();
  const mail = mailbox([candidate("c1")], { note: "1 个邮箱检查异常，请到「设置 → 邮箱」查看原因。", canLoadMore: true, pendingCount: 5 });
  h.inbox.setMailbox(mail);
  await h.inbox.refresh();
  expect(el("inbox-list").textContent).toContain("1 个邮箱检查异常");
  fireEvent.click(h.list.getByRole("button", { name: /显示更多新邮件（还有 4 封）/ }));
  expect(mail.loadMore).toHaveBeenCalledOnce();
  fireEvent.click(el("inbox-tab-bin"));
  await waitFor(() => expect(el("inbox-tab-bin").getAttribute("aria-selected")).toBe("true"));
  expect(el("inbox-list").textContent).not.toContain("检查异常");
});

test("a filed mail offers only 关联到投递 and 删除, shows who sent it, and escapes its body", async () => {
  const h = setup({
    list_inbox_cmd: () => [MAIL],
    get_evidence_preview_cmd: () => body(MAIL, { bodyExtract: "请点击 <img src=x onerror=alert(1)> 这里 <https://tracker.example.test/x>" }),
  });
  await h.inbox.refresh();
  fireEvent.click(h.list.getByRole("button", { name: /面试邀请/ }));
  await h.reader.findByRole("heading", { name: "面试邀请" });
  expect([...el("inbox-preview").querySelectorAll(".mail-actions button")].map((button) => button.textContent)).toEqual(["关联到投递", "删除"]);
  expect(el("inbox-preview").textContent).toContain("hr@example.test");
  expect(el("inbox-preview").querySelector(".evidence-body img")).toBeNull();
  expect(el("inbox-preview").querySelector(".evidence-body")!.textContent).toContain("<img src=x onerror=alert(1)>");
  expect(el("inbox-preview").innerHTML).not.toMatch(/src="http/);
  expect(el("inbox-preview").querySelectorAll("select")).toHaveLength(0);
});

test("the AI button is not offered for a screenshot or a PDF, which AI cannot read yet", async () => {
  const shot = { ...MAIL, id: "e2", kind: "screenshot", subject: null, originalFilename: "shot.png" };
  const mountAi = vi.fn(() => ({ unmount() {} }));
  const h = setup({ list_inbox_cmd: () => [shot], get_evidence_preview_cmd: () => body(shot, { bodyExtract: null, imageDataUrl: "data:image/png;base64,AAAA" }) }, { mountAi });
  await h.inbox.refresh();
  fireEvent.click(h.list.getByRole("button", { name: /shot\.png/ }));
  await waitFor(() => expect(el("inbox-preview").querySelector("img.evidence-image")).toBeTruthy());
  expect(mountAi).not.toHaveBeenCalled();
});

test("a screenshot is shown from a data URL, a PDF offers the system viewer instead", async () => {
  const shot = { ...MAIL, id: "e2", kind: "screenshot", subject: null, originalFilename: "shot.png" };
  const pdf = { ...MAIL, id: "e3", kind: "pdf", subject: null, originalFilename: "offer.pdf" };
  const h = setup({
    list_inbox_cmd: () => [shot, pdf],
    get_evidence_preview_cmd: (args) => args?.evidenceId === "e2"
      ? body(shot, { bodyExtract: null, imageDataUrl: "data:image/png;base64,AAAA" })
      : body(pdf, { bodyExtract: null, note: "PDF 不在应用内渲染。" }),
  });
  await h.inbox.refresh();
  fireEvent.click(h.list.getByRole("button", { name: /shot\.png/ }));
  await waitFor(() => expect(el("inbox-preview").querySelector("img.evidence-image")?.getAttribute("src")).toBe("data:image/png;base64,AAAA"));
  fireEvent.click(h.list.getByRole("button", { name: /offer\.pdf/ }));
  await h.reader.findByText("PDF 不在应用内渲染。");
  fireEvent.click(h.reader.getByRole("button", { name: "用系统程序打开" }));
  await waitFor(() => expect(h.called("open_evidence_cmd")).toHaveLength(1));
});

test("associating opens a searchable list of jobs; a click on one links it, nothing is preselected", async () => {
  let filed = [MAIL] as unknown[];
  let linked = [] as unknown[];
  const h = setup({
    list_inbox_cmd: () => filed,
    list_associated_evidence_cmd: () => linked,
    get_evidence_preview_cmd: () => body(linked.length ? { ...MAIL, applicationId: "app-2" } : MAIL),
    list_applications_cmd: () => APPS,
    associate_evidence_cmd: () => { filed = []; linked = [{ ...MAIL, applicationId: "app-2", company: "星河科技", title: "数据平台" }]; return {}; },
  });
  await h.inbox.refresh();
  fireEvent.click(h.list.getByRole("button", { name: /面试邀请/ }));
  fireEvent.click(await h.reader.findByRole("button", { name: "关联到投递" }));
  const dialog = el("inbox-associate-dialog") as HTMLDialogElement;
  await waitFor(() => expect(dialog.open).toBe(true));
  const rows = [...el("inbox-associate-list").querySelectorAll("button")].map((button) => button.textContent);
  expect(rows).toEqual(["星河科技后端开发", "星河科技数据平台"]);
  expect(el("inbox-associate-hint").textContent).toBe("");
  expect(dialog.querySelector("select")).toBeNull();
  expect(h.called("associate_evidence_cmd")).toHaveLength(0);
  // 搜一搜。
  fireEvent.input(el("inbox-associate-search"), { target: { value: "数据" } });
  expect([...el("inbox-associate-list").querySelectorAll("button")]).toHaveLength(1);
  fireEvent.input(el("inbox-associate-search"), { target: { value: "没有这家" } });
  expect(el("inbox-associate-list").textContent).toContain("没有匹配的投递");
  fireEvent.input(el("inbox-associate-search"), { target: { value: "数据" } });
  // 点哪条就关联到哪条。
  fireEvent.click(within(el("inbox-associate-list")).getByRole("button", { name: /数据平台/ }));
  await waitFor(() => expect(h.called("associate_evidence_cmd")[0]?.args).toEqual({ evidenceId: "e1", applicationId: "app-2" }));
  await waitFor(() => expect(dialog.open).toBe(false));
  expect(h.called("classify_evidence_cmd")).toHaveLength(0);
  expect(el("inbox-status").textContent).toContain("已关联到「星河科技 · 数据平台」");
  expect(el("inbox-status").textContent).toContain("已处理");
  // 邮件跟着去了「已处理」，右边继续显示它，不会凭空消失。
  await waitFor(() => expect(el("inbox-tab-done").getAttribute("aria-selected")).toBe("true"));
  await h.reader.findByText("已关联「星河科技 · 数据平台」");
  expect(el("inbox-preview").textContent).toContain("面试邀请");
});

test("a failed association keeps the dialog open with the reason, and cancel writes nothing", async () => {
  const h = setup({
    list_inbox_cmd: () => [MAIL], get_evidence_preview_cmd: () => body(MAIL), list_applications_cmd: () => APPS,
    associate_evidence_cmd: () => { throw { message: "这条投递已被删除" }; },
  });
  await h.inbox.refresh();
  fireEvent.click(h.list.getByRole("button", { name: /面试邀请/ }));
  fireEvent.click(await h.reader.findByRole("button", { name: "关联到投递" }));
  await waitFor(() => expect((el("inbox-associate-dialog") as HTMLDialogElement).open).toBe(true));
  fireEvent.click(within(el("inbox-associate-list")).getByRole("button", { name: /后端开发/ }));
  await waitFor(() => expect(el("inbox-associate-status").textContent).toContain("这条投递已被删除"));
  expect((el("inbox-associate-dialog") as HTMLDialogElement).open).toBe(true);
  await waitFor(() => expect((el("inbox-associate-list").querySelector("button") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(el("inbox-associate-cancel"));
  expect((el("inbox-associate-dialog") as HTMLDialogElement).open).toBe(false);
  expect(h.reader.getByRole("button", { name: "关联到投递" }).hasAttribute("disabled")).toBe(false);
});

test("without any job the dialog says where to add one", async () => {
  const h = setup({ list_inbox_cmd: () => [MAIL], get_evidence_preview_cmd: () => body(MAIL) });
  await h.inbox.refresh();
  fireEvent.click(h.list.getByRole("button", { name: /面试邀请/ }));
  fireEvent.click(await h.reader.findByRole("button", { name: "关联到投递" }));
  await waitFor(() => expect((el("inbox-associate-dialog") as HTMLDialogElement).open).toBe(true));
  expect(el("inbox-associate-hint").textContent).toContain("先到「投递」页新增一条");
  expect(el("inbox-associate-list").textContent).toContain("还没有在办的投递");
  expect(h.called("associate_evidence_cmd")).toHaveLength(0);
});

test("there are no classification controls to operate; a known class only shows as a plain label", async () => {
  const classified = { ...MAIL, replyClass: "interview_invite", sendMode: "human" };
  const h = setup({ list_inbox_cmd: () => [classified], get_evidence_preview_cmd: () => body(classified) });
  await h.inbox.refresh();
  fireEvent.click(h.list.getByRole("button", { name: /面试邀请/ }));
  await h.reader.findByRole("heading", { name: "面试邀请" });
  expect(el("inbox-preview").querySelector("select")).toBeNull();
  expect(el("inbox-preview").querySelector(".mail-tags")!.textContent).toBe("面试邀请");
});

test("已处理 lists linked mail with company and job; it can be unlinked or deleted, nothing else", async () => {
  const linked = { ...MAIL, id: "d1", applicationId: "app-1", company: "星河科技", title: "后端开发", replyClass: "interview_invite" };
  let done = [linked] as unknown[];
  let todo = [] as unknown[];
  const h = setup({
    list_associated_evidence_cmd: () => done, list_inbox_cmd: () => todo, get_evidence_preview_cmd: () => body(done.length ? linked : { ...linked, applicationId: null }),
    unassociate_evidence_cmd: () => { done = []; todo = [{ ...linked, applicationId: null }]; return {}; },
  });
  await h.inbox.refresh();
  fireEvent.click(el("inbox-tab-done"));
  await h.list.findByRole("button", { name: /星河科技 · 后端开发/ });
  expect(h.called("list_associated_evidence_cmd")[0]?.args).toEqual({ applicationId: null });
  fireEvent.click(h.list.getByRole("button", { name: /面试邀请/ }));
  await h.reader.findByText("已关联「星河科技 · 后端开发」");
  expect([...el("inbox-preview").querySelectorAll(".mail-actions button")].map((button) => button.textContent)).toEqual(["取消关联", "删除"]);
  expect(el("inbox-preview").querySelector(".mail-tags")!.textContent).toBe("面试邀请");
  fireEvent.click(h.reader.getByRole("button", { name: "取消关联" }));
  await waitFor(() => expect(h.called("unassociate_evidence_cmd")).toHaveLength(1));
  await waitFor(() => expect(el("inbox-status").textContent).toContain("回到了「待处理」"));
  // 邮件跟着回到「待处理」，右边继续显示它。
  await waitFor(() => expect(el("inbox-tab-todo").getAttribute("aria-selected")).toBe("true"));
  await h.reader.findByRole("button", { name: "关联到投递" });
  expect(el("inbox-preview").textContent).toContain("面试邀请");
});

test("jumping in from a job shows only its mail with a removable filter; clearing shows all processed mail", async () => {
  const one = { ...MAIL, id: "d1", applicationId: "app-1", company: "星河科技", title: "后端开发", subject: "一面邀请" };
  const two = { ...MAIL, id: "d2", applicationId: "app-2", company: "远山", title: "设计", subject: "笔试邀请" };
  const h = setup({ list_associated_evidence_cmd: (args) => [one, two].filter((item) => !args?.applicationId || item.applicationId === args.applicationId) });
  await h.inbox.showApplication("app-1", "星河科技 · 后端开发");
  expect(h.called("list_associated_evidence_cmd")[0]?.args).toEqual({ applicationId: "app-1" });
  expect(el("inbox-tab-done").getAttribute("aria-selected")).toBe("true");
  expect(el("inbox-filter").hidden).toBe(false);
  expect(el("inbox-filter").textContent).toContain("星河科技 · 后端开发 的邮件");
  expect(el("inbox-list").textContent).toContain("一面邀请");
  expect(el("inbox-list").textContent).not.toContain("笔试邀请");
  fireEvent.click(within(el("inbox-filter")).getByRole("button", { name: "显示全部已处理" }));
  await waitFor(() => expect(el("inbox-list").textContent).toContain("笔试邀请"));
  expect(el("inbox-filter").hidden).toBe(true);
  expect(h.called("list_associated_evidence_cmd").at(-1)?.args).toEqual({ applicationId: null });
});

test("a job with no mail says so instead of showing someone else's", async () => {
  const h = setup({ list_associated_evidence_cmd: () => [] });
  await h.inbox.showApplication("app-9", "远山 · 设计");
  expect(el("inbox-list").textContent).toContain("这条投递还没有邮件");
  expect(el("inbox-preview").textContent).toContain("远山 · 设计 还没有邮件");
});

test("the AI button is mounted compactly next to 关联到投递 for each mail that is not in the recycle bin", async () => {
  const mounted: Array<{ id: string; options?: { compact?: boolean }; report: (message: string) => void }> = [];
  const unmount = vi.fn();
  const h = setup({ list_inbox_cmd: () => [MAIL], get_evidence_preview_cmd: () => body(MAIL) }, {
    mountAi: (container, id, report, options) => { mounted.push({ id, options, report }); expect(container.id).toBe("inbox-ai"); return { unmount }; },
  });
  await h.inbox.refresh();
  fireEvent.click(h.list.getByRole("button", { name: /面试邀请/ }));
  await waitFor(() => expect(mounted).toHaveLength(1));
  expect(mounted[0]).toMatchObject({ id: "e1", options: { compact: true } });
  expect(el("inbox-ai").closest(".mail-view")).toBeTruthy();
  expect(el("inbox-ai").parentElement?.classList.contains("mail-actions")).toBe(true);
  expect(el("inbox-ai").nextElementSibling?.textContent).toBe("关联到投递");
  // 面板确认完以后那句话由状态栏说；确认会把它关联走，状态栏还要说去了哪儿。
  mounted[0]!.report("已确认。分类、时间线和 1 条待办都写好了。");
  expect(el("inbox-status").textContent).toContain("已确认");
});

test("the AI bar never appears for a new mail or a mail in the recycle bin", async () => {
  const mountAi = vi.fn(() => ({ unmount() {} }));
  const binned = { ...MAIL, id: "b1", recycled: true };
  const h = setup({ list_recycled_evidence_cmd: () => [binned], get_evidence_preview_cmd: () => body(binned, { recycled: true }) }, { mountAi });
  h.inbox.setMailbox(mailbox([candidate("c1")]));
  await h.inbox.refresh();
  fireEvent.click(h.list.getAllByRole("button")[0]!);
  fireEvent.click(el("inbox-tab-bin"));
  fireEvent.click(await h.list.findByRole("button", { name: /面试邀请/ }));
  await h.reader.findByRole("button", { name: "恢复" });
  expect(mountAi).not.toHaveBeenCalled();
  expect(el("inbox-ai")).toBeNull();
});

test("a preview that answers late cannot replace the one selected after it", async () => {
  let releaseFirst!: () => void;
  const second = { ...MAIL, id: "e9", subject: "第二封" };
  const h = setup({
    list_inbox_cmd: () => [MAIL, second],
    get_evidence_preview_cmd: (args) => args?.evidenceId === "e1"
      ? new Promise((resolve) => { releaseFirst = () => resolve(body(MAIL, { bodyExtract: "第一封的正文" })); })
      : body(second, { bodyExtract: "第二封的正文" }),
  });
  await h.inbox.refresh();
  fireEvent.click(h.list.getByRole("button", { name: /面试邀请/ }));
  fireEvent.click(h.list.getByRole("button", { name: /第二封/ }));
  await h.reader.findByText("第二封的正文");
  releaseFirst(); await tick();
  expect(el("inbox-preview").textContent).toContain("第二封的正文");
  expect(el("inbox-preview").textContent).not.toContain("第一封的正文");
});

test("a refresh that cannot read the list keeps the list, and a first failed read never shows the empty state", async () => {
  let fail = false;
  const h = setup({ list_inbox_cmd: () => { if (fail) throw { message: "数据库打不开" }; return [MAIL]; } });
  await h.inbox.refresh();
  expect(el("inbox-list").textContent).toContain("面试邀请");
  fail = true;
  expect(await h.inbox.refresh()).toBe(false);
  expect(el("inbox-status").textContent).toContain("读不到通知：数据库打不开");
  expect(el("inbox-list").textContent).toContain("面试邀请");

  document.body.innerHTML = readFileSync("index.html", "utf8").split("<body>")[1].split("</body>")[0];
  const first = setup({ list_inbox_cmd: () => { throw { message: "数据库打不开" }; } });
  expect(await first.inbox.refresh()).toBe(false);
  expect(el("inbox-list").textContent).toContain("读不到通知");
  expect(el("inbox-preview").textContent).not.toContain("没有待处理");
  expect(el("inbox-count").textContent).toBe("");
});

test("dropped files are imported by path; the result is reported and a single new mail opens", async () => {
  const drop: { handle: ((paths: string[]) => void) | null } = { handle: null };
  let filed = [] as unknown[];
  const h = setup({
    import_evidence_cmd: () => { filed = [MAIL]; return { imported: [MAIL], duplicates: [], failed: [{ name: "invite.msg", code: "unsupported" }] }; },
    list_inbox_cmd: () => filed, get_evidence_preview_cmd: () => body(MAIL),
  }, { listenDrop: (fn) => { drop.handle = fn; } });
  drop.handle?.(["C:/Users/me/面试邀请.eml", "C:/Users/me/invite.msg"]);
  await waitFor(() => expect(h.called("import_evidence_cmd")).toHaveLength(1));
  expect(h.called("import_evidence_cmd")[0]!.args).toEqual({ args: { paths: ["C:/Users/me/面试邀请.eml", "C:/Users/me/invite.msg"] } });
  await waitFor(() => expect(el("inbox-status").textContent).toContain("已导入 1 条，放在「待处理」里"));
  expect(el("inbox-status").textContent).toContain("invite.msg");
  await h.reader.findByRole("heading", { name: "面试邀请" });
});

test("tabs support arrow-key navigation", async () => {
  const h = setup();
  await h.inbox.refresh();
  fireEvent.keyDown(el("inbox-tab-todo"), { key: "ArrowRight" });
  await waitFor(() => expect(el("inbox-tab-done").getAttribute("aria-selected")).toBe("true"));
  expect(document.activeElement).toBe(el("inbox-tab-done"));
  fireEvent.keyDown(el("inbox-tab-done"), { key: "End" });
  await waitFor(() => expect(el("inbox-tab-bin").getAttribute("aria-selected")).toBe("true"));
  fireEvent.keyDown(el("inbox-tab-bin"), { key: "ArrowRight" });
  await waitFor(() => expect(el("inbox-tab-todo").getAttribute("aria-selected")).toBe("true"));
});

test("a new mail that has just been kept leaves the list and the reader goes back to the prompt", async () => {
  const h = setup();
  h.inbox.setMailbox(mailbox([candidate("c1")]));
  await h.inbox.refresh();
  fireEvent.click(h.list.getAllByRole("button")[0]!);
  expect(el("inbox-preview").textContent).toContain("原文还没有下载");
  h.inbox.setMailbox(mailbox([]));
  expect(el("inbox-list").querySelector("[data-row]")).toBeNull();
  expect(el("inbox-preview").textContent).not.toContain("原文还没有下载");
});

test("a mail without file attachments shows its body straight away, no empty attachment box", async () => {
  const h = setup({
    list_inbox_cmd: () => [MAIL], get_evidence_preview_cmd: () => body(MAIL),
    list_evidence_attachments_cmd: () => ({ sourceSha256: "x", items: [] }),
  });
  await h.inbox.refresh();
  fireEvent.click(h.list.getByRole("button", { name: /面试邀请/ }));
  await waitFor(() => expect(h.called("list_evidence_attachments_cmd")).toHaveLength(1));
  await waitFor(() => expect((el("inbox-mail-attachments") as HTMLElement).hidden).toBe(true));
});

test("a finished action's notice fades by itself; a problem stays until closed with ×", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  try {
    let fail = false;
    const h = setup({
      list_inbox_cmd: () => [MAIL], get_evidence_preview_cmd: () => body(MAIL),
      set_evidence_recycled_cmd: () => { if (fail) throw { message: "磁盘暂时不可写" }; return {}; },
    });
    await h.inbox.refresh();
    fireEvent.click(h.list.getByRole("button", { name: /面试邀请/ }));
    fireEvent.click(await h.reader.findByRole("button", { name: "删除" }));
    await vi.waitFor(() => expect(el("inbox-status").textContent).toContain("已移到回收站"));
    expect(el("inbox-status").querySelector(".status-close")).toBeNull();
    vi.advanceTimersByTime(3100);
    expect(el("inbox-status").textContent).toBe("");
    // 出问题的不会自己消失，能关。
    fail = true;
    fireEvent.click(await h.reader.findByRole("button", { name: "删除" }));
    await vi.waitFor(() => expect(el("inbox-status").textContent).toContain("磁盘暂时不可写"));
    vi.advanceTimersByTime(10000);
    expect(el("inbox-status").textContent).toContain("磁盘暂时不可写");
    fireEvent.click(within(el("inbox-status")).getByRole("button", { name: "关闭提示" }));
    expect(el("inbox-status").textContent).toBe("");
  } finally { vi.useRealTimers(); }
});
