import { beforeEach, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fireEvent, within, waitFor } from "@testing-library/dom";
import { mountApplications, type ApplicationsOptions } from "./applications-ui";
import type { Invoke } from "./api";

// #550 投递页：用真实的 index.html 结构跑分组、展开、行内改阶段、延迟提交与备注自动保存。
const NOW = new Date(2026, 10, 21, 10, 0, 0); // 2026-11-21 10:00（本地）

beforeEach(() => {
  window.localStorage.clear();
  document.body.innerHTML = readFileSync("index.html", "utf8")
    .split("<body>")[1].split("</body>")[0];
  // jsdom 没有 <dialog> 的 showModal / close。
  document.querySelectorAll("dialog").forEach((node) => {
    const dialog = node as HTMLDialogElement;
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; };
  });
});

type Row = Record<string, any>;
interface BackendOptions {
  apps: Row[];
  todos?: Row[];
  views?: Record<string, Row>;
  snapshotViews?: Record<string, Row>;
  total?: number;
  fail?: Record<string, unknown>;
}

const STAGE_OF_RECORD: Record<string, string> = {
  record_assessment_cmd: "assessment", record_interview_cmd: "interview", record_offer_cmd: "offer",
  record_rejected_cmd: "rejected", record_withdrawn_cmd: "withdrawn", record_closed_cmd: "closed",
};

function backend(options: BackendOptions) {
  const calls: Array<{ name: string; args?: Record<string, any> }> = [];
  const invoke: Invoke = async <T,>(name: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ name, args: args as Record<string, any> });
    if (options.fail?.[name]) throw options.fail[name];
    const inner = ((args as Record<string, any> | undefined)?.args ?? {}) as Record<string, any>;
    switch (name) {
      case "list_applications_cmd":
        return { total: options.total ?? options.apps.length, items: options.apps.map((app) => ({ ...app })) } as T;
      case "list_todos_cmd": return (options.todos ?? []) as T;
      case "get_application_cmd": {
        const id = String((args as Record<string, unknown>).id);
        const app = options.apps.find((item) => item.id === id)!;
        return (options.views?.[id] ?? { application: { ...app }, events: [], evidence: [], snapshots: [], snapshotStates: {}, todos: [] }) as T;
      }
      case "get_snapshot_cmd":
        return (options.snapshotViews?.[String((args as Record<string, unknown>).snapshotId)] ?? { groups: [] }) as T;
      case "confirm_submit_cmd": options.apps.find((item) => item.id === inner.id)!.current_stage = "submitted"; return {} as T;
      case "correct_stage_cmd": options.apps.find((item) => item.id === inner.id)!.current_stage = inner.to; return {} as T;
      case "set_recycle_cmd": options.apps.splice(options.apps.findIndex((item) => item.id === (args as Record<string, unknown>).id), 1); return {} as T;
      case "create_application_cmd": return (options.views?.__create ?? { created: true, application: { id: "NEW" } }) as T;
      default:
        if (STAGE_OF_RECORD[name]) {
          if (inner.updateProgress) options.apps.find((item) => item.id === inner.id)!.current_stage = STAGE_OF_RECORD[name];
          return {} as T;
        }
        return {} as T;
    }
  };
  return { invoke, calls, writes: () => calls.filter((c) => !["list_applications_cmd", "list_todos_cmd", "get_application_cmd", "get_snapshot_cmd"].includes(c.name)) };
}

async function mount(options: BackendOptions, extra: ApplicationsOptions = {}) {
  const b = backend(options);
  const ui = mountApplications(b.invoke, { undoMs: 40, now: () => NOW, coalesceMs: 0, ...extra });
  await ui.refreshList();
  return { ...b, ui, view: within(document.getElementById("view-applications")!) };
}

const app = (id: string, stage: string, over: Row = {}): Row => ({
  id, company: `公司${id}`, title: "工程师", current_stage: stage, updated_at: "2026-11-18T08:00:00Z", location: null, ...over,
});
const row = (id: string) => document.querySelector<HTMLElement>(`li[data-id="${id}"]`)!;
const group = (id: string) => document.querySelector<HTMLElement>(`[data-group="${id}"]`);
const groupIds = () => Array.from(document.querySelectorAll<HTMLElement>("[data-group]"), (node) => node.dataset.group);
const stageSelect = (id: string) => row(id).querySelector<HTMLSelectElement>("select[data-stage-select]")!;
const toggleRow = (id: string) => fireEvent.click(row(id).querySelector(".app-select")!);
const toast = () => document.getElementById("apps-undo")!;
const writeNames = (calls: Array<{ name: string }>) => calls.map((c) => c.name);
const today = "2026-11-21";

test("groups: six stages map to the agreed groups, empty groups are not drawn, ended group is folded", async () => {
  const { view } = await mount({ apps: [
    app("i1", "interview"), app("a1", "assessment"), app("s1", "submitted"), app("p1", "saved"), app("p2", "filling"),
    app("o1", "offer"), app("r1", "rejected"), app("w1", "withdrawn"), app("c1", "closed"),
  ] });
  expect(groupIds()).toEqual(["interview", "assessment", "submitted", "pending", "offer", "ended"]);
  const heads = Array.from(document.querySelectorAll(".app-group-toggle"), (node) => node.textContent?.trim());
  expect(heads).toEqual(["面试中1", "待测评1", "已投递1", "待投递2", "Offer1", "已结束 / 未通过3"]);
  // 组头显示数量；进行中的组展开、行默认收起；已结束组默认整组折叠，行不渲染。
  expect(document.querySelector('[data-group-toggle="interview"]')!.getAttribute("aria-expanded")).toBe("true");
  expect(document.querySelector('[data-group-toggle="ended"]')!.getAttribute("aria-expanded")).toBe("false");
  expect(group("ended")!.querySelectorAll("li[data-id]").length).toBe(0);
  expect(document.querySelectorAll(".app-expand:not([hidden])").length).toBe(0);
  expect(row("p1").closest('[data-group="pending"]')).toBeTruthy();
  expect(row("p2").closest('[data-group="pending"]')).toBeTruthy();
  expect(document.getElementById("apps-count")!.textContent).toBe("6 家进行中 · 3 家已结束");
  expect(view.getByRole("heading", { level: 1, name: "投递" })).toBeTruthy();
});

test("groups: an empty group is left out, and the group header folds and unfolds its rows", async () => {
  await mount({ apps: [app("s1", "submitted"), app("s2", "submitted")] });
  expect(groupIds()).toEqual(["submitted"]);
  const toggle = document.querySelector<HTMLElement>('[data-group-toggle="submitted"]')!;
  fireEvent.click(toggle);
  expect(document.querySelector('[data-group-toggle="submitted"]')!.getAttribute("aria-expanded")).toBe("false");
  expect(group("submitted")!.querySelectorAll("li[data-id]").length).toBe(0);
  fireEvent.click(document.querySelector('[data-group-toggle="submitted"]')!);
  expect(group("submitted")!.querySelectorAll("li[data-id]").length).toBe(2);
});

test("reads: one list read (limit 1000, all stages, active) and one open-todos read; nothing else on open", async () => {
  const { calls } = await mount({ apps: [app("A", "submitted")] });
  expect(calls.map((c) => c.name).sort()).toEqual(["list_applications_cmd", "list_todos_cmd"]);
  const list = calls.find((c) => c.name === "list_applications_cmd")!.args!.args;
  expect(list).toMatchObject({ stage: "all", recycle: "active", limit: 1000, offset: 0 });
  expect(calls.find((c) => c.name === "list_todos_cmd")!.args).toEqual({ applicationId: null, status: "open" });
});

test("reads: each group shows 20 rows first and 再显示 20 条 adds the next batch; over 1000 gets a note", async () => {
  const apps = Array.from({ length: 45 }, (_, i) => app(`S${String(i).padStart(2, "0")}`, "submitted", { updated_at: `2026-11-${String(1 + (i % 20)).padStart(2, "0")}T00:00:00Z` }));
  await mount({ apps, total: 1203 });
  expect(group("submitted")!.querySelectorAll("li[data-id]").length).toBe(20);
  const more = () => document.querySelector<HTMLElement>('[data-more="submitted"]')!;
  expect(more().textContent).toContain("再显示 20 条");
  fireEvent.click(more());
  expect(group("submitted")!.querySelectorAll("li[data-id]").length).toBe(40);
  expect(more().textContent).toContain("再显示 5 条");
  fireEvent.click(more());
  expect(group("submitted")!.querySelectorAll("li[data-id]").length).toBe(45);
  expect(document.querySelector('[data-more="submitted"]')).toBeNull();
  const note = document.getElementById("apps-limit-note")!;
  expect(note.hidden).toBe(false);
  expect(note.textContent).toContain("1203");
});

test("search: hits inside the ended group unfold it for now; clearing the box folds it again; header counts do not change", async () => {
  const { view } = await mount({ apps: [
    app("A", "interview", { company: "字节跳动" }), app("B", "rejected", { company: "字节旗下" }), app("C", "closed", { company: "快手" }),
  ] });
  expect(group("ended")!.querySelectorAll("li[data-id]").length).toBe(0);
  const box = view.getByLabelText("搜索投递") as HTMLInputElement;
  fireEvent.input(box, { target: { value: "字节" } });
  expect(document.querySelector('[data-group-toggle="ended"]')!.getAttribute("aria-expanded")).toBe("true");
  expect(group("ended")!.querySelectorAll("li[data-id]").length).toBe(1);
  expect(row("B")).toBeTruthy();
  expect(row("C")).toBeNull();
  expect(document.querySelector("mark.search-match")).toBeTruthy();
  expect(document.getElementById("apps-count")!.textContent).toBe("1 家进行中 · 2 家已结束");
  // 搜索只命中进行中的记录：已结束组不画。
  fireEvent.input(box, { target: { value: "跳动" } });
  expect(group("ended")).toBeNull();
  fireEvent.input(box, { target: { value: "" } });
  expect(document.querySelector('[data-group-toggle="ended"]')!.getAttribute("aria-expanded")).toBe("false");
  expect(group("ended")!.querySelectorAll("li[data-id]").length).toBe(0);
});

test("search: no hits shows the no-results state, an empty archive shows the empty state", async () => {
  const { view } = await mount({ apps: [app("A", "interview")] });
  fireEvent.input(view.getByLabelText("搜索投递"), { target: { value: "不存在的公司" } });
  expect(document.getElementById("apps-no-results")!.classList.contains("hidden")).toBe(false);
  expect(document.getElementById("apps-layout")!.classList.contains("hidden")).toBe(true);
  expect(document.getElementById("apps-empty")!.classList.contains("hidden")).toBe(true);
  document.body.innerHTML = readFileSync("index.html", "utf8").split("<body>")[1].split("</body>")[0];
  await mount({ apps: [] });
  expect(document.getElementById("apps-empty")!.classList.contains("hidden")).toBe(false);
  expect(document.getElementById("apps-no-results")!.classList.contains("hidden")).toBe(true);
  expect(document.getElementById("apps-shell")!.classList.contains("is-empty")).toBe(true);
});

test("row: company · city, title, and the stage select are in four columns; hostile text stays text", async () => {
  await mount({ apps: [app("A", "submitted", { company: '<img src=x onerror=alert(1)>', title: '"><script>x</script>', location: "<b>北京</b>" })] });
  const li = row("A");
  expect(li.querySelector("img")).toBeNull();
  expect(li.querySelector("script")).toBeNull();
  expect(li.querySelector("b")).toBeNull();
  expect(li.querySelector(".app-cell-company")!.textContent).toContain("<img src=x onerror=alert(1)>");
  expect(li.querySelector(".app-cell-company")!.textContent).toContain(" · <b>北京</b>");
  expect(li.querySelectorAll(".app-row > .app-cell").length).toBe(4);
  expect(Array.from(stageSelect("A").options, (o) => o.value)).toEqual(
    ["saved", "filling", "submitted", "assessment", "interview", "offer", "rejected", "withdrawn", "closed"]);
  expect(stageSelect("A").value).toBe("submitted");
});

test("hint: nearest open todo with a time, a date-only todo without 00:00, else N 天前更新; clicking the todo only switches to the calendar page", async () => {
  const openTodos = vi.fn();
  await mount({
    apps: [app("T", "interview"), app("D", "assessment"), app("U", "submitted", { updated_at: new Date(2026, 10, 18, 9).toISOString() })],
    todos: [
      { id: "t1", applicationId: "T", title: "二面", status: "open", duePrecision: "datetime", dueAtUtc: "2026-11-22T06:30:00Z", timeZone: "Asia/Shanghai", reminderState: "none" },
      { id: "t2", applicationId: "D", title: "测评截止", status: "open", duePrecision: "date", dueDate: "2026-11-21", reminderState: "none" },
    ],
  }, { openTodos });
  expect(row("T").querySelector(".app-cell-hint")!.textContent).toBe("明天 14:30 二面");
  const dateOnly = row("D").querySelector(".app-cell-hint")!.textContent!;
  expect(dateOnly).toBe("今天 测评截止");
  expect(dateOnly).not.toMatch(/00:00/);
  expect(document.getElementById("apps-list")!.textContent).not.toMatch(/00:00/);
  expect(row("U").querySelector(".app-cell-hint")!.textContent).toBe("3 天前更新");
  expect(row("U").querySelector(".app-cell-hint")!.textContent).not.toContain("投递");
  fireEvent.click(row("T").querySelector<HTMLElement>("[data-go=todos]")!);
  expect(openTodos).toHaveBeenCalledTimes(1);
  // 只是切页：没有展开这一行。
  expect(row("T").classList.contains("is-expanded")).toBe(false);
});

test("expand: one row at a time, details are read on demand, and the two-column body is rendered", async () => {
  const { calls, view } = await mount({
    apps: [app("A", "interview"), app("B", "submitted")],
    views: {
      A: {
        application: { id: "A", company: "公司A", title: "工程师", current_stage: "interview", notes: "面试前复习" },
        events: [
          { id: "e1", event_type: "submit_confirmed", event_sequence: 1, occurred: { precision: "date", value: { date: "2026-11-10" } }, payload: {} },
          { id: "e2", event_type: "interview_recorded", event_sequence: 2, occurred: { precision: "date", value: { date: "2026-11-19" } }, payload: { round: 2 } },
        ],
        evidence: [{ id: "m1", subject: "面试通知" }, { id: "m2", subject: "感谢投递" }], snapshots: [], snapshotStates: {}, todos: [],
      },
    },
  });
  expect(calls.filter((c) => c.name === "get_application_cmd")).toHaveLength(0);
  toggleRow("A");
  await waitFor(() => expect(row("A").querySelector(".app-chain")).toBeTruthy());
  expect(calls.filter((c) => c.name === "get_application_cmd")).toHaveLength(1);
  expect(row("A").classList.contains("is-expanded")).toBe(true);
  expect(row("A").querySelector(".app-select")!.getAttribute("aria-expanded")).toBe("true");
  // 进度链：只有阶段变化，末项加粗。
  expect(row("A").querySelector(".app-chain")!.textContent!.replace(/\s+/g, " ")).toBe("11/10 投递 → 11/19 二面");
  expect(row("A").querySelector(".app-chain strong")!.textContent).toBe("11/19 二面");
  expect(within(row("A")).getByText("记进度")).toBeTruthy();
  expect(within(row("A")).getByText("展开完整时间线")).toBeTruthy();
  expect((row("A").querySelector(".app-note-input") as HTMLInputElement).value).toBe("面试前复习");
  expect(row("A").querySelector("[data-go=inbox]")!.textContent).toContain("2 封相关邮件");
  const side = row("A").querySelector(".app-expand-side")!;
  for (const label of ["当时交的简历", "编辑资料", "移入回收站"]) expect(within(side as HTMLElement).getByText(label)).toBeTruthy();
  // 同时只展开一行。
  toggleRow("B");
  await waitFor(() => expect(row("B").querySelector(".app-chain")).toBeTruthy());
  expect(row("A").classList.contains("is-expanded")).toBe(false);
  expect(document.querySelectorAll("li.is-expanded").length).toBe(1);
  // 再点一次收起。
  toggleRow("B");
  expect(document.querySelectorAll("li.is-expanded").length).toBe(0);
  void view;
});

test("expand: no mail preview or unlink here, the company-experience link is gated off, mail count 0 shows no link", async () => {
  const openInbox = vi.fn();
  await mount({ apps: [app("A", "submitted")], views: {
    A: { application: { id: "A", company: "公司A", title: "工程师", current_stage: "submitted" }, events: [], evidence: [{ id: "m1", subject: "邮件" }], snapshots: [], snapshotStates: {}, todos: [] },
  } }, { openInbox });
  toggleRow("A");
  await waitFor(() => expect(row("A").querySelector("[data-go=inbox]")).toBeTruthy());
  fireEvent.click(row("A").querySelector("[data-go=inbox]")!);
  expect(openInbox).toHaveBeenCalledTimes(1);
  expect(row("A").textContent).not.toMatch(/取消关联|查看通知/);
  const community = row("A").querySelector<HTMLElement>('[data-go=community]')!;
  expect(community.getAttribute("data-platform")).toBe("community-remote");
  expect(community.hasAttribute("data-platform-off")).toBe(true);
  toggleRow("A");
  document.body.innerHTML = readFileSync("index.html", "utf8").split("<body>")[1].split("</body>")[0];
  await mount({ apps: [app("Z", "submitted")] });
  toggleRow("Z");
  await waitFor(() => expect(row("Z").querySelector(".app-expand-side")).toBeTruthy());
  expect(row("Z").querySelector("[data-go=inbox]")).toBeNull();
  expect(row("Z").textContent).toContain("暂无相关邮件");
});

test("stage change forward: the row moves at once, nothing is written until the bar times out, then it is recorded with today's date", async () => {
  const { calls, writes } = await mount({ apps: [app("A", "submitted")] }, { undoMs: 60 });
  fireEvent.change(stageSelect("A"), { target: { value: "interview" } });
  // 立即移到目标分组，提示条出现，库里还没有任何记录。
  await waitFor(() => expect(group("interview")!.contains(row("A"))).toBe(true));
  expect(toast().hidden).toBe(false);
  expect(document.getElementById("apps-undo-text")!.textContent).toBe("已记为「面试」，日期按今天记");
  expect(writes()).toHaveLength(0);
  await waitFor(() => expect(writeNames(writes())).toEqual(["record_interview_cmd"]));
  const args = writes()[0].args!.args;
  expect(args).toMatchObject({ id: "A", updateProgress: true });
  expect(args.occurred).toEqual({ precision: "date", value: { date: today, time_zone: null } });
  await waitFor(() => expect(toast().hidden).toBe(true));
  // 写完之后重读，行留在目标组里。
  await waitFor(() => expect(calls.filter((c) => c.name === "list_applications_cmd").length).toBeGreaterThan(1));
  expect(group("interview")!.contains(row("A"))).toBe(true);
});

test("stage change forward: 撤销 writes nothing and puts the row back", async () => {
  const { writes } = await mount({ apps: [app("A", "submitted")] }, { undoMs: 50 });
  fireEvent.change(stageSelect("A"), { target: { value: "offer" } });
  await waitFor(() => expect(group("offer")!.contains(row("A"))).toBe(true));
  fireEvent.click(document.getElementById("apps-undo-cancel")!);
  expect(toast().hidden).toBe(true);
  expect(group("submitted")!.contains(row("A"))).toBe(true);
  expect(group("offer")).toBeNull();
  expect(stageSelect("A").value).toBe("submitted");
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(writes()).toHaveLength(0);
});

test("stage change forward: undoing a move brings the row back even if its old group briefly shrank to one row", async () => {
  await mount({ apps: [app("A", "assessment"), app("B", "assessment"), app("C", "assessment")] }, { undoMs: 60_000 });
  fireEvent.change(stageSelect("B"), { target: { value: "interview" } });
  await waitFor(() => expect(group("interview")!.contains(row("B"))).toBe(true));
  fireEvent.change(stageSelect("C"), { target: { value: "interview" } });
  await waitFor(() => expect(group("interview")!.contains(row("C"))).toBe(true));
  expect(group("assessment")!.querySelectorAll("li[data-id]").length).toBe(1);
  fireEvent.click(document.getElementById("apps-undo-cancel")!);
  expect(group("assessment")!.querySelectorAll("li[data-id]").length).toBe(2);
  expect(group("assessment")!.contains(row("C"))).toBe(true);
});

test("stage change forward: 改日期 asks for a date, then writes with the chosen date and not before", async () => {
  const { writes } = await mount({ apps: [app("A", "submitted")] }, { undoMs: 30 });
  fireEvent.change(stageSelect("A"), { target: { value: "assessment" } });
  await waitFor(() => expect(toast().hidden).toBe(false));
  fireEvent.click(document.getElementById("apps-undo-date")!);
  expect(document.getElementById("apps-undo-dateform")!.hidden).toBe(false);
  // 选日期期间不会被 8 秒超时抢先写进去。
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(writes()).toHaveLength(0);
  fireEvent.change(document.getElementById("apps-undo-date-input")!, { target: { value: "2026-11-12" } });
  fireEvent.click(document.getElementById("apps-undo-date-ok")!);
  await waitFor(() => expect(writeNames(writes())).toEqual(["record_assessment_cmd"]));
  expect(writes()[0].args!.args.occurred).toEqual({ precision: "date", value: { date: "2026-11-12", time_zone: null } });
  expect(toast().hidden).toBe(true);
});

test("stage change forward: to 已投递 uses confirm_submit_cmd, which cannot take a date, so 改日期 is not offered", async () => {
  const { writes } = await mount({ apps: [app("A", "saved")] }, { undoMs: 30 });
  fireEvent.change(stageSelect("A"), { target: { value: "submitted" } });
  await waitFor(() => expect(toast().hidden).toBe(false));
  expect(document.getElementById("apps-undo-date")!.hidden).toBe(true);
  await waitFor(() => expect(writeNames(writes())).toEqual(["confirm_submit_cmd"]));
  expect(writes()[0].args).toEqual({ args: { id: "A" } });
});

test("stage change forward: clicking elsewhere, leaving the page or hiding the window all write the pending record", async () => {
  const outside = await mount({ apps: [app("A", "submitted")] }, { undoMs: 60_000 });
  fireEvent.change(stageSelect("A"), { target: { value: "interview" } });
  await waitFor(() => expect(toast().hidden).toBe(false));
  expect(outside.writes()).toHaveLength(0);
  fireEvent.click(document.body);
  await waitFor(() => expect(writeNames(outside.writes())).toEqual(["record_interview_cmd"]));

  document.body.innerHTML = readFileSync("index.html", "utf8").split("<body>")[1].split("</body>")[0];
  const leaving = await mount({ apps: [app("B", "submitted")] }, { undoMs: 60_000 });
  fireEvent.change(stageSelect("B"), { target: { value: "offer" } });
  await waitFor(() => expect(toast().hidden).toBe(false));
  await leaving.ui.flushPending();
  expect(writeNames(leaving.writes())).toEqual(["record_offer_cmd"]);

  document.body.innerHTML = readFileSync("index.html", "utf8").split("<body>")[1].split("</body>")[0];
  const closing = await mount({ apps: [app("C", "submitted")] }, { undoMs: 60_000 });
  fireEvent.change(stageSelect("C"), { target: { value: "rejected" } });
  await waitFor(() => expect(toast().hidden).toBe(false));
  window.dispatchEvent(new Event("pagehide"));
  await waitFor(() => expect(writeNames(closing.writes())).toEqual(["record_rejected_cmd"]));
});

test("stage change forward: clicking the bar itself or the same row's select is not 'elsewhere'", async () => {
  const { writes } = await mount({ apps: [app("A", "submitted")] }, { undoMs: 60_000 });
  fireEvent.change(stageSelect("A"), { target: { value: "interview" } });
  await waitFor(() => expect(toast().hidden).toBe(false));
  fireEvent.click(document.getElementById("apps-undo-text")!);
  fireEvent.click(stageSelect("A"));
  expect(writes()).toHaveLength(0);
  fireEvent.click(document.getElementById("apps-undo-cancel")!);
});

test("stage change forward: starting a second change writes the first one first, so nothing is lost", async () => {
  const { writes } = await mount({ apps: [app("A", "submitted"), app("B", "submitted")] }, { undoMs: 60_000 });
  fireEvent.change(stageSelect("A"), { target: { value: "interview" } });
  await waitFor(() => expect(toast().hidden).toBe(false));
  fireEvent.change(stageSelect("B"), { target: { value: "assessment" } });
  await waitFor(() => expect(writeNames(writes())).toEqual(["record_interview_cmd"]));
  await waitFor(() => expect(document.getElementById("apps-undo-text")!.textContent).toContain("测评"));
  await waitFor(() => expect(group("assessment")!.contains(row("B"))).toBe(true));
  await window.dispatchEvent(new Event("pagehide"));
  await waitFor(() => expect(writeNames(writes())).toEqual(["record_interview_cmd", "record_assessment_cmd"]));
});

test("stage change forward: a failed write is reported and the row goes back to its real stage", async () => {
  const { ui, writes } = await mount({ apps: [app("A", "submitted")], fail: { record_offer_cmd: { code: "STORE", message: "磁盘已满" } } }, { undoMs: 60_000 });
  fireEvent.change(stageSelect("A"), { target: { value: "offer" } });
  await waitFor(() => expect(toast().hidden).toBe(false));
  await ui.flushPending();
  expect(writeNames(writes())).toEqual(["record_offer_cmd"]);
  expect(document.getElementById("apps-msg")!.textContent).toContain("磁盘已满");
  await waitFor(() => expect(group("submitted")!.contains(row("A"))).toBe(true));
});

test("stage change backward: takes effect at once through correct_stage_cmd with an automatic reason, no bar", async () => {
  const { writes } = await mount({ apps: [app("A", "interview")] });
  fireEvent.change(stageSelect("A"), { target: { value: "submitted" } });
  await waitFor(() => expect(writeNames(writes())).toEqual(["correct_stage_cmd"]));
  expect(writes()[0].args).toEqual({ args: { id: "A", from: "interview", to: "submitted", reason: "在投递页把阶段从「面试」改为「已投递」" } });
  expect(toast().hidden).toBe(true);
  await waitFor(() => expect(group("submitted")!.contains(row("A"))).toBe(true));
  expect(document.getElementById("apps-msg")!.textContent).toContain("已投递");
});

test("stage change: saved to filling has no record command, so it is a correction too; ended groups are reachable by select", async () => {
  const { writes } = await mount({ apps: [app("A", "saved"), app("B", "offer")] });
  fireEvent.change(stageSelect("A"), { target: { value: "filling" } });
  await waitFor(() => expect(writeNames(writes())).toEqual(["correct_stage_cmd"]));
  expect(writes()[0].args!.args).toMatchObject({ from: "saved", to: "filling" });
  expect(writes()[0].args!.args.reason).toBe("在投递页把阶段从「已保存」改为「填写中」");
  // 往前改到更早的阶段（offer → 测评）也是纠正，并且这一行立刻换组。
  fireEvent.change(stageSelect("B"), { target: { value: "assessment" } });
  await waitFor(() => expect(writes().filter((w) => w.name === "correct_stage_cmd")).toHaveLength(2));
  await waitFor(() => expect(group("assessment")!.contains(row("B"))).toBe(true));
});

test("stage change: choosing the current stage again changes nothing", async () => {
  const { writes } = await mount({ apps: [app("A", "interview")] });
  fireEvent.change(stageSelect("A"), { target: { value: "interview" } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(writes()).toHaveLength(0);
  expect(toast().hidden).toBe(true);
});

test("notes: blur saves only the notes field when it changed, and nothing when it did not", async () => {
  const { writes } = await mount({ apps: [app("A", "interview")], views: {
    A: { application: { id: "A", company: "公司A", title: "工程师", current_stage: "interview", notes: "旧备注" }, events: [], evidence: [], snapshots: [], snapshotStates: {}, todos: [] },
  } });
  toggleRow("A");
  await waitFor(() => expect(row("A").querySelector(".app-note-input")).toBeTruthy());
  const field = row("A").querySelector(".app-note-input") as HTMLInputElement;
  fireEvent.focusOut(field);
  expect(writes()).toHaveLength(0);
  fireEvent.change(field, { target: { value: "新备注：二面前补充项目细节" } });
  fireEvent.focusOut(field);
  await waitFor(() => expect(writeNames(writes())).toEqual(["update_application_cmd"]));
  expect(writes()[0].args).toEqual({ args: { id: "A", notes: "新备注：二面前补充项目细节" } });
  await waitFor(() => expect(row("A").querySelector(".app-note-status")!.textContent).toBe("已保存"));
  // 再失焦一次：没有新改动，不再写。
  fireEvent.focusOut(field);
  expect(writes()).toHaveLength(1);
});

test("notes: a failed save says so and keeps what was typed", async () => {
  const { writes } = await mount({ apps: [app("A", "interview")], fail: { update_application_cmd: { code: "STORE", message: "写入失败" } } });
  toggleRow("A");
  await waitFor(() => expect(row("A").querySelector(".app-note-input")).toBeTruthy());
  const field = row("A").querySelector(".app-note-input") as HTMLInputElement;
  fireEvent.change(field, { target: { value: "写了一半" } });
  fireEvent.focusOut(field);
  await waitFor(() => expect(document.getElementById("apps-msg")!.textContent).toContain("写入失败"));
  expect(field.value).toBe("写了一半");
  expect(writes()).toHaveLength(1);
});

test("记进度 menu: records through the existing dialog (history only by default, date may stay empty), and 记一条备注 writes a timeline note", async () => {
  const { writes } = await mount({ apps: [app("A", "interview")] });
  toggleRow("A");
  await waitFor(() => expect(row("A").querySelector(".app-progress-menu")).toBeTruthy());
  const menu = row("A").querySelector(".app-progress-menu")!;
  expect(Array.from(menu.querySelectorAll("button"), (b) => b.textContent)).toEqual(["面试", "测评", "Offer", "未通过", "撤回", "结束申请", "记一条备注"]);
  fireEvent.click(menu.querySelector('[data-act="interview"]')!);
  const dialog = document.getElementById("progress-dialog") as HTMLDialogElement;
  expect(dialog.open).toBe(true);
  expect((document.getElementById("progress-update") as HTMLInputElement).checked).toBe(false);
  expect((document.getElementById("progress-date") as HTMLInputElement).value).toBe("");
  fireEvent.submit(document.getElementById("progress-form")!);
  await waitFor(() => expect(writeNames(writes())).toEqual(["record_interview_cmd"]));
  const args = writes()[0].args!.args;
  expect(args.updateProgress).toBe(false);
  expect(args.occurred).toEqual({ precision: "unknown" });
  // 取消不写任何记录。
  await waitFor(() => expect(dialog.open).toBe(false));
  await waitFor(() => expect(document.getElementById("apps-msg")!.textContent).toBe("已保存记录。"));
  fireEvent.click(row("A").querySelector('[data-act="offer"]')!);
  fireEvent.click(document.getElementById("progress-cancel")!);
  expect(writes()).toHaveLength(1);
  // 记一条备注：在页内输入，不用 window.prompt。
  const prompt = vi.spyOn(window, "prompt");
  fireEvent.click(row("A").querySelector('[data-act="note"]')!);
  const noteForm = row("A").querySelector<HTMLFormElement>("[data-note-add]")!;
  expect(noteForm.hidden).toBe(false);
  fireEvent.change(noteForm.querySelector("input")!, { target: { value: "HR 说下周安排终面" } });
  fireEvent.submit(noteForm);
  await waitFor(() => expect(writeNames(writes())).toEqual(["record_interview_cmd", "add_note_cmd"]));
  expect(writes()[1].args).toEqual({ args: { id: "A", text: "HR 说下周安排终面" } });
  expect(prompt).not.toHaveBeenCalled();
});

test("timeline: folded by default, the full timeline still shows corrections and notes, and never says 简历快照", async () => {
  await mount({ apps: [app("A", "submitted")], views: { A: {
    application: { id: "A", company: "公司A", title: "工程师", current_stage: "submitted" },
    events: [
      { id: "e1", event_type: "application_created", event_sequence: 1, occurred: { precision: "unknown" }, payload: {} },
      { id: "e2", event_type: "stage_corrected", event_sequence: 2, occurred: { precision: "date", value: { date: "2026-11-20" } }, payload: { from: "interview", to: "submitted", reason: "在投递页把阶段从「面试」改为「已投递」" } },
      { id: "e3", event_type: "note_added", event_sequence: 3, occurred: { precision: "unknown" }, payload: { text: "HR 很友好" } },
      { id: "e4", event_type: "fill_completed", event_sequence: 4, occurred: { precision: "unknown" }, payload: { kind: "fill_event", outcome: "completed", snapshot_id: "S1", template_name: "校招模板" } },
    ],
    evidence: [], snapshots: [], snapshotStates: { S1: "stored" }, todos: [{ id: "t", applicationId: "A", title: "笔试", status: "open", duePrecision: "date", dueDate: "2026-11-25", reminderState: "none" }],
  } } });
  toggleRow("A");
  await waitFor(() => expect(row("A").querySelector(".app-timeline-fold")).toBeTruthy());
  const fold = row("A").querySelector<HTMLDetailsElement>(".app-timeline-fold")!;
  expect(fold.open).toBe(false);
  const body = fold.textContent!;
  expect(body).toContain("纠正阶段");
  expect(body).toContain("在投递页把阶段从「面试」改为「已投递」");
  expect(body).toContain("HR 很友好");
  expect(body).toContain("2026-11-25（未定时间）");
  expect(body).not.toContain("00:00");
  expect(within(fold).getByRole("button", { name: "查看当时交的简历" })).toBeTruthy();
  expect(row("A").textContent).not.toMatch(/简历快照|冻结字段|下载配方/);
  // 进度链只留阶段变化，备注和填写不进链。
  expect(row("A").querySelector(".app-chain")!.textContent!.replace(/\s+/g, " ")).toBe("11/20 改为已投递");
});

test("当时交的简历: opens a one-line summary per copy with the disclaimer, and the full fields in the existing dialog", async () => {
  await mount({
    apps: [app("A", "submitted")],
    views: { A: {
      application: { id: "A", company: "公司A", title: "工程师", current_stage: "submitted" }, events: [], evidence: [], todos: [],
      snapshots: [
        { snapshot_id: "S1", template_name: "校招模板", template_version: "v2", created_at: "2026-11-10T02:00:00Z", byte_size: 10 },
        { snapshot_id: "S2", template_name: "社招模板", created_at: "2026-11-12T02:00:00Z", byte_size: 10 },
      ],
      snapshotStates: { S1: "stored", S2: "stored" },
    } },
    snapshotViews: {
      S1: { snapshotId: "S1", templateName: "校招模板", templateVersion: "v2", createdAt: "2026-11-10T02:00:00Z", omittedFieldCount: 0, groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "张三" }, { key: "手机", value: "138" }] }, { name: "教育", fields: [{ key: "学校", value: "某大学" }] }] },
      S2: { snapshotId: "S2", templateName: "社招模板", createdAt: "2026-11-12T02:00:00Z", omittedFieldCount: 0, groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "张三" }] }] },
    },
  });
  toggleRow("A");
  await waitFor(() => expect(row("A").querySelector('[data-act="snapshots"]')).toBeTruthy());
  const button = row("A").querySelector<HTMLElement>('[data-act="snapshots"]')!;
  expect(button.textContent).toBe("当时交的简历");
  fireEvent.click(button);
  const summary = () => row("A").querySelector<HTMLElement>("[data-snapshots]")!;
  expect(summary().hidden).toBe(false);
  await waitFor(() => expect(summary().textContent).toContain("3 个字段"));
  expect(summary().textContent).toContain("校招模板（v2）");
  expect(summary().textContent).toContain("社招模板");
  expect(summary().textContent).toContain("1 个字段");
  expect(summary().textContent).toContain("留档于");
  // 投过多次就列出每一次。
  expect(summary().querySelectorAll("li").length).toBe(2);
  expect(summary().textContent).toContain("不能证明网站最终收到或保存了这些内容");
  expect(summary().textContent).not.toMatch(/简历快照|冻结字段/);
  fireEvent.click(summary().querySelector('[data-act="snapshot"]')!);
  const dialog = document.getElementById("snapshot-dialog") as HTMLDialogElement;
  await waitFor(() => expect(document.getElementById("snapshot-body")!.textContent).toContain("基本信息"));
  expect(dialog.open).toBe(true);
  expect(document.getElementById("snapshot-body")!.textContent).toContain("不能证明网站最终收到或保存了这些内容");
  expect(dialog.textContent).toContain("当时交的简历");
  expect(dialog.textContent).not.toContain("简历快照");
  // 再点一次收起。
  fireEvent.click(row("A").querySelector('[data-act="snapshots"]')!);
  expect(summary().hidden).toBe(true);
});

test("当时交的简历: none yet says how to get one; an unavailable copy is described, not offered", async () => {
  await mount({ apps: [app("A", "submitted"), app("B", "submitted")], views: {
    B: { application: { id: "B", company: "公司B", title: "工程师", current_stage: "submitted" }, events: [], evidence: [], todos: [],
      snapshots: [{ snapshot_id: "X", template_name: "校招模板", created_at: "2026-11-10T02:00:00Z", byte_size: 1 }], snapshotStates: { X: "missing" } },
  } });
  toggleRow("A");
  await waitFor(() => expect(row("A").querySelector('[data-act="snapshots"]')).toBeTruthy());
  fireEvent.click(row("A").querySelector('[data-act="snapshots"]')!);
  expect(row("A").querySelector("[data-snapshots]")!.textContent).toContain("还没有当时交的简历");
  toggleRow("B");
  await waitFor(() => expect(row("B").querySelector('[data-act="snapshots"]')).toBeTruthy());
  fireEvent.click(row("B").querySelector('[data-act="snapshots"]')!);
  const text = row("B").querySelector("[data-snapshots]")!.textContent!;
  expect(text).toContain("当时交的简历不可用");
  expect(row("B").querySelector('[data-snapshots] [data-act="snapshot"]')).toBeNull();
});

test("site, edit and recycle: only http(s) opens, edit uses the existing dialog, recycling asks first and removes the row", async () => {
  const { writes } = await mount({ apps: [app("A", "submitted", { source_url: "https://jobs.example.com/a" }), app("B", "submitted", { source_url: "javascript:alert(1)" }), app("C", "submitted")], views: {
    A: { application: { id: "A", company: "公司A", title: "工程师", current_stage: "submitted", source_url: "https://jobs.example.com/a", notes: "n", location: "上海" }, events: [], evidence: [], snapshots: [], snapshotStates: {}, todos: [] },
  } });
  toggleRow("A");
  await waitFor(() => expect(row("A").querySelector('[data-act="site"]')).toBeTruthy());
  const link = row("A").querySelector<HTMLAnchorElement>('[data-act="site"]')!;
  expect(link.href).toBe("https://jobs.example.com/a");
  expect(link.getAttribute("rel")).toContain("noopener");
  expect(link.textContent).toBe("打开官网 ↗");
  toggleRow("B");
  await waitFor(() => expect(row("B").querySelector(".app-expand-side")).toBeTruthy());
  expect(row("B").querySelector("a[href]")).toBeNull();
  expect(row("B").querySelector(".is-disabled")).toBeTruthy();
  toggleRow("C");
  await waitFor(() => expect(row("C").querySelector(".app-expand-side")).toBeTruthy());
  expect(row("C").textContent).not.toContain("打开官网");
  toggleRow("A");
  await waitFor(() => expect(row("A").querySelector('[data-act="edit"]')).toBeTruthy());
  fireEvent.click(row("A").querySelector('[data-act="edit"]')!);
  expect((document.getElementById("app-form-dialog") as HTMLDialogElement).open).toBe(true);
  expect((document.getElementById("f-company") as HTMLInputElement).value).toBe("公司A");
  expect((document.getElementById("f-url") as HTMLInputElement).value).toBe("https://jobs.example.com/a");
  fireEvent.change(document.getElementById("f-title")!, { target: { value: "后端工程师" } });
  fireEvent.submit(document.getElementById("app-form")!);
  await waitFor(() => expect(writeNames(writes())).toEqual(["update_application_cmd"]));
  expect(writes()[0].args!.args).toMatchObject({ id: "A", company: "公司A", title: "后端工程师", sourceUrl: "https://jobs.example.com/a", location: "上海", notes: "n" });
  await waitFor(() => expect((document.getElementById("btn-save-app") as HTMLButtonElement).disabled).toBe(false));
  // 移入回收站：先确认，再调 set_recycle_cmd，行从列表里消失，并说明去哪里恢复。
  const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
  await waitFor(() => expect(row("A").querySelector('[data-act="recycle"]')).toBeTruthy());
  fireEvent.click(row("A").querySelector('[data-act="recycle"]')!);
  expect(writes().filter((w) => w.name === "set_recycle_cmd")).toHaveLength(0);
  fireEvent.click(row("A").querySelector('[data-act="recycle"]')!);
  await waitFor(() => expect(writes().filter((w) => w.name === "set_recycle_cmd")).toHaveLength(1));
  expect(writes().find((w) => w.name === "set_recycle_cmd")!.args).toEqual({ id: "A", recycled: true });
  await waitFor(() => expect(row("A")).toBeNull());
  expect(document.getElementById("apps-msg")!.textContent).toContain("设置 → 数据与备份 → 回收站");
  confirm.mockRestore();
});

test("new bar: + 新增 toggles an inline bar; saving creates, closes the bar and expands the new row", async () => {
  const apps = [app("A", "submitted")];
  const b = backend({ apps, views: { __create: { created: true, application: { id: "NEW" } } } });
  const created = { id: "NEW", company: "新公司", title: "产品经理", current_stage: "saved", location: "深圳" };
  const realInvoke = b.invoke;
  const invoke: Invoke = async <T,>(name: string, args?: Record<string, unknown>) => {
    if (name === "create_application_cmd") { apps.push(created); }
    return realInvoke<T>(name, args);
  };
  const ui = mountApplications(invoke, { now: () => NOW });
  await ui.refreshList();
  const bar = document.getElementById("new-job-bar") as HTMLFormElement;
  const button = document.getElementById("btn-new-app")!;
  expect(bar.hidden).toBe(true);
  fireEvent.click(button);
  expect(bar.hidden).toBe(false);
  expect(button.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(button);
  expect(bar.hidden).toBe(true);
  fireEvent.click(button);
  fireEvent.change(document.getElementById("nb-company")!, { target: { value: "新公司" } });
  fireEvent.change(document.getElementById("nb-title")!, { target: { value: "产品经理" } });
  fireEvent.change(document.getElementById("nb-location")!, { target: { value: "深圳" } });
  fireEvent.change(document.getElementById("nb-url")!, { target: { value: "https://new.example.com" } });
  fireEvent.submit(bar);
  await waitFor(() => expect(b.calls.some((c) => c.name === "create_application_cmd")).toBe(true));
  const call = b.calls.find((c) => c.name === "create_application_cmd")!;
  expect(call.args!.args).toEqual({ company: "新公司", title: "产品经理", sourceUrl: "https://new.example.com", location: "深圳", notes: null, confirmDuplicate: false });
  await waitFor(() => expect(row("NEW")).toBeTruthy());
  await waitFor(() => expect(row("NEW").classList.contains("is-expanded")).toBe(true));
  expect(bar.hidden).toBe(true);
  expect((document.getElementById("nb-company") as HTMLInputElement).value).toBe("");
});

test("new bar: possible duplicates ask first; declining keeps the input and creates nothing, accepting sends confirmDuplicate", async () => {
  const creates: Array<Record<string, any>> = [];
  const invoke: Invoke = async <T,>(name: string, args?: Record<string, unknown>): Promise<T> => {
    if (name === "list_applications_cmd") return { total: 1, items: [app("A", "submitted")] } as T;
    if (name === "list_todos_cmd") return [] as T;
    if (name === "create_application_cmd") {
      const inner = (args as Record<string, any>).args;
      creates.push(inner);
      return (inner.confirmDuplicate
        ? { created: true, application: { id: "A2" } }
        : { created: false, candidates: { exact: [{ company: "公司A", title: "工程师" }], sameCompany: [] } }) as T;
    }
    return {} as T;
  };
  const ui = mountApplications(invoke, { now: () => NOW });
  await ui.refreshList();
  fireEvent.click(document.getElementById("btn-new-app")!);
  fireEvent.change(document.getElementById("nb-company")!, { target: { value: "公司A" } });
  fireEvent.change(document.getElementById("nb-title")!, { target: { value: "工程师" } });
  const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
  fireEvent.submit(document.getElementById("new-job-bar")!);
  await waitFor(() => expect(document.getElementById("nb-msg")!.textContent).toContain("已取消"));
  expect(creates).toHaveLength(1);
  expect(confirm.mock.calls[0][0]).toContain("公司A / 工程师");
  expect((document.getElementById("nb-company") as HTMLInputElement).value).toBe("公司A");
  expect((document.getElementById("new-job-bar") as HTMLFormElement).hidden).toBe(false);
  fireEvent.submit(document.getElementById("new-job-bar")!);
  await waitFor(() => expect(creates).toHaveLength(3));
  expect(creates[2].confirmDuplicate).toBe(true);
  confirm.mockRestore();
});

test("a half-written timeline note survives a full redraw of the list", async () => {
  const { ui } = await mount({ apps: [app("A", "interview"), app("B", "submitted")] });
  toggleRow("A");
  await waitFor(() => expect(row("A").querySelector('[data-act="note"]')).toBeTruthy());
  fireEvent.click(row("A").querySelector('[data-act="note"]')!);
  const field = () => row("A").querySelector<HTMLInputElement>("[data-note-add] input")!;
  fireEvent.change(field(), { target: { value: "HR 说周五给回复" } });
  // 别处改阶段、或插件提交，都会让列表整体重画。
  await ui.refreshView();
  expect(row("A").querySelector<HTMLFormElement>("[data-note-add]")!.hidden).toBe(false);
  expect(field().value).toBe("HR 说周五给回复");
  // 另一行的阶段提示条超时写库后的重画也一样。
  fireEvent.change(stageSelect("B"), { target: { value: "interview" } });
  await waitFor(() => expect(toast().hidden).toBe(false));
  await ui.flushPending();
  await waitFor(() => expect(group("interview")!.contains(row("B"))).toBe(true));
  expect(field().value).toBe("HR 说周五给回复");
});

test("notes: text typed in the notes field but not yet saved survives a background refresh, and keeps the cursor in it", async () => {
  const { ui, writes } = await mount({ apps: [app("A", "interview")], views: {
    A: { application: { id: "A", company: "公司A", title: "工程师", current_stage: "interview", notes: "旧备注" }, events: [], evidence: [], snapshots: [], snapshotStates: {}, todos: [] },
  } });
  toggleRow("A");
  await waitFor(() => expect(row("A").querySelector(".app-note-input")).toBeTruthy());
  const field = () => row("A").querySelector<HTMLInputElement>(".app-note-input")!;
  field().focus();
  fireEvent.change(field(), { target: { value: "旧备注，另外二面前要准备项目细节" } });
  await ui.refreshView();
  expect(field().value).toBe("旧备注，另外二面前要准备项目细节");
  expect(document.activeElement).toBe(field());
  expect(writes()).toHaveLength(0);
  // 没改过的备注框，照常用服务端的新值。
  fireEvent.change(field(), { target: { value: "旧备注" } });
  await ui.refreshView();
  expect(field().value).toBe("旧备注");
});

test("notes: hiding the window or leaving the page saves a note that is still being typed", async () => {
  const { writes } = await mount({ apps: [app("A", "interview")], views: {
    A: { application: { id: "A", company: "公司A", title: "工程师", current_stage: "interview", notes: "" }, events: [], evidence: [], snapshots: [], snapshotStates: {}, todos: [] },
  } });
  toggleRow("A");
  await waitFor(() => expect(row("A").querySelector(".app-note-input")).toBeTruthy());
  const field = row("A").querySelector<HTMLInputElement>(".app-note-input")!;
  field.focus();
  fireEvent.change(field, { target: { value: "还没点别处就关窗口了" } });
  window.dispatchEvent(new Event("pagehide"));
  await waitFor(() => expect(writeNames(writes())).toEqual(["update_application_cmd"]));
  expect(writes()[0].args).toEqual({ args: { id: "A", notes: "还没点别处就关窗口了" } });
});

test("notes: autosave also works when the detail wraps the application in a summary", async () => {
  const { writes } = await mount({ apps: [app("A", "interview")], views: {
    A: { application: { summary: { id: "A", company: "公司A", title: "工程师", current_stage: "interview" }, notes: "" }, events: [], evidence: [], snapshots: [], snapshotStates: {}, todos: [] },
  } });
  toggleRow("A");
  await waitFor(() => expect(row("A").querySelector(".app-note-input")).toBeTruthy());
  const field = row("A").querySelector<HTMLInputElement>(".app-note-input")!;
  fireEvent.change(field, { target: { value: "包了一层也能存" } });
  fireEvent.focusOut(field);
  await waitFor(() => expect(writeNames(writes())).toEqual(["update_application_cmd"]));
});

test("opening an application that sits in the folded ended group unfolds that group and expands the row", async () => {
  const { ui } = await mount({ apps: [app("A", "interview"), app("R", "rejected")] });
  expect(group("ended")!.querySelectorAll("li[data-id]").length).toBe(0);
  await ui.openFromNotes("R", false);
  await waitFor(() => expect(row("R")?.classList.contains("is-expanded")).toBe(true));
  expect(document.querySelector('[data-group-toggle="ended"]')!.getAttribute("aria-expanded")).toBe("true");
  expect(row("R").querySelector(".app-chain")).toBeTruthy();
});

test("a newly created application expands even when its group was folded by hand", async () => {
  const apps = [app("A", "saved"), app("B", "saved")];
  const b = backend({ apps });
  const invoke: Invoke = async <T,>(name: string, args?: Record<string, unknown>) => {
    if (name === "create_application_cmd") { apps.push(app("NEW", "saved", { company: "新公司" })); return { created: true, application: { id: "NEW" } } as T; }
    return b.invoke<T>(name, args);
  };
  const ui = mountApplications(invoke, { now: () => NOW });
  await ui.refreshList();
  fireEvent.click(document.querySelector('[data-group-toggle="pending"]')!);
  expect(group("pending")!.querySelectorAll("li[data-id]").length).toBe(0);
  fireEvent.click(document.getElementById("btn-new-app")!);
  fireEvent.change(document.getElementById("nb-company")!, { target: { value: "新公司" } });
  fireEvent.change(document.getElementById("nb-title")!, { target: { value: "工程师" } });
  fireEvent.submit(document.getElementById("new-job-bar")!);
  await waitFor(() => expect(row("NEW")?.classList.contains("is-expanded")).toBe(true));
});

test("if the open-todos read fails the list still shows, and the page says the schedule column is a fallback", async () => {
  const { view } = await mount({ apps: [app("A", "interview", { updated_at: new Date(2026, 10, 18, 9).toISOString() })], fail: { list_todos_cmd: { code: "STORE", message: "读不到" } } });
  expect(row("A")).toBeTruthy();
  expect(row("A").querySelector(".app-cell-hint")!.textContent).toBe("3 天前更新");
  expect(document.getElementById("apps-msg")!.textContent).toContain("日程没读到");
  void view;
});

test("a committed change from the plugin refreshes the list and the expanded row", async () => {
  let changed: ((event: { payload?: unknown }) => void) | undefined;
  const state = { notes: "旧备注" };
  const apps = [app("A", "saved")];
  const invoke: Invoke = async <T,>(name: string): Promise<T> => {
    if (name === "list_applications_cmd") return { total: 1, items: apps } as T;
    if (name === "list_todos_cmd") return [] as T;
    if (name === "get_application_cmd") return { application: { ...apps[0], notes: state.notes }, events: [], evidence: [], snapshots: [], snapshotStates: {}, todos: [] } as T;
    return {} as T;
  };
  const ui = mountApplications(invoke, { coalesceMs: 0, now: () => NOW, listen: (_event, handler) => { changed = handler; } });
  await ui.refreshList();
  toggleRow("A");
  await waitFor(() => expect((row("A").querySelector(".app-note-input") as HTMLInputElement)?.value).toBe("旧备注"));
  state.notes = "新备注";
  apps[0] = { ...apps[0], current_stage: "submitted" };
  changed!({ payload: { reason: "committed" } });
  await waitFor(() => expect(group("submitted")!.contains(row("A"))).toBe(true));
  await waitFor(() => expect((row("A").querySelector(".app-note-input") as HTMLInputElement).value).toBe("新备注"));
  expect(row("A").classList.contains("is-expanded")).toBe(true);
});

test("a new plugin-saved application hidden by the search shows the hint, and the hint clears the search", async () => {
  let changed: ((event: { payload?: unknown }) => void) | undefined;
  const apps = [app("A", "interview", { company: "甲公司" })];
  const invoke: Invoke = async <T,>(name: string): Promise<T> => {
    if (name === "list_applications_cmd") return { total: apps.length, items: apps } as T;
    if (name === "list_todos_cmd") return [] as T;
    return {} as T;
  };
  const ui = mountApplications(invoke, { coalesceMs: 0, now: () => NOW, listen: (_e, handler) => { changed = handler; } });
  await ui.refreshList();
  fireEvent.input(document.getElementById("app-search")!, { target: { value: "甲" } });
  apps.push(app("B", "saved", { company: "乙公司" }));
  changed!({ payload: { reason: "committed", messageType: "job.save", stage: "saved", applicationId: "B", company: "乙公司" } });
  await waitFor(() => expect(document.getElementById("apps-fresh")!.hidden).toBe(false));
  expect(row("B")).toBeNull();
  fireEvent.click(document.getElementById("apps-fresh-clear")!);
  expect((document.getElementById("app-search") as HTMLInputElement).value).toBe("");
  expect(row("B")).toBeTruthy();
  expect(document.getElementById("apps-fresh")!.hidden).toBe(true);
});

test("opening from the notes page expands that application, and a recycled one says where to restore it", async () => {
  const { ui } = await mount({ apps: [app("A", "interview")] });
  await ui.openFromNotes("A", false);
  await waitFor(() => expect(row("A").classList.contains("is-expanded")).toBe(true));
  await ui.openFromNotes("GONE", true);
  expect(document.getElementById("apps-msg")!.textContent).toContain("回收站");
});

test("the page text never says 简历快照 / 冻结字段 / 下载配方, and has no emoji", async () => {
  await mount({ apps: [app("A", "submitted")], views: { A: {
    application: { id: "A", company: "公司A", title: "工程师", current_stage: "submitted" },
    events: [{ id: "e", event_type: "fill_completed", event_sequence: 1, occurred: { precision: "unknown" }, payload: { kind: "fill_event", outcome: "completed", snapshot_id: "S", template_name: "模板" } }],
    evidence: [], snapshots: [{ snapshot_id: "S", template_name: "模板", created_at: "2026-11-10T02:00:00Z", byte_size: 1 }], snapshotStates: { S: "uploading" }, todos: [],
  } } });
  toggleRow("A");
  await waitFor(() => expect(row("A").querySelector(".app-expand-side")).toBeTruthy());
  fireEvent.click(row("A").querySelector('[data-act="snapshots"]')!);
  const text = document.getElementById("view-applications")!.textContent ?? "";
  expect(text).not.toMatch(/简历快照|冻结字段|下载配方/);
  expect(text).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  expect(text).toContain("当时交的简历");
});

test("the top bar shows the five tabs, the status button and the settings gear", () => {
  const routes = Array.from(document.querySelectorAll<HTMLElement>(".topbar [data-route]"), (node) => node.getAttribute("aria-label") ?? node.textContent?.trim());
  expect(routes).toEqual(["投递", "日历", "通知", "简历", "心得", "设置"]);
  // 内部 route 名不变，只换界面文字。
  expect(Array.from(document.querySelectorAll<HTMLElement>(".topbar [data-route]"), (node) => node.dataset.route))
    .toEqual(["applications", "todos", "inbox", "resume", "notes", "settings"]);
  expect(document.getElementById("nav-support")).toBeNull();
  expect(document.getElementById("view-support")).toBeNull();
  expect(document.getElementById("nav-install-extension")).toBeNull();
  expect(document.getElementById("runtime-pill")!.tagName).toBe("BUTTON");
  expect(document.querySelector(".topbar [data-inbox-dot]")!.hasAttribute("hidden")).toBe(true);
  expect(document.querySelector(".topbar [data-route=settings] [data-update-dot]")).toBeTruthy();
  // 支持开发的支付卡片并入「设置 → 关于」，发布者小字也搬到那里。
  expect(document.querySelector("#settings-about .support-card")).toBeTruthy();
  expect(document.querySelector("#settings-about .about-publisher")?.textContent?.trim()).toBe("PTJ Works");
  expect(document.querySelector(".brand-publisher")).toBeNull();
  const version = document.getElementById("app-version")!;
  expect(version.hidden).toBe(true);
  expect(version.textContent).toBe("");
  expect(document.querySelector(".topbar")!.textContent).not.toMatch(/已连接|v\d/);
});

// #554：本机的「该公司心得 N 篇」。数据来自心得页的索引，只在展开一行时读一次，读失败就不显示。
test("company notes: shows 该公司心得 N 篇 on expand, opens the notes page for that company, keeps the hidden 面经 entry", async () => {
  const companyNoteCount = vi.fn(async (_company: string) => 3);
  const openCompanyNotes = vi.fn();
  await mount({ apps: [app("A", "interview", { company: "星河科技" })] }, { companyNoteCount, openCompanyNotes });
  // 列表上不读：展开前一次都没调。
  expect(companyNoteCount).not.toHaveBeenCalled();
  toggleRow("A");
  const link = await waitFor(() => {
    const node = row("A").querySelector<HTMLElement>("[data-go=company-notes]");
    expect(node).toBeTruthy();
    return node!;
  });
  expect(link.textContent).toContain("该公司心得 3 篇");
  expect(link.hasAttribute("data-platform")).toBe(false);
  expect(companyNoteCount).toHaveBeenCalledWith("星河科技");
  fireEvent.click(link);
  expect(openCompanyNotes).toHaveBeenCalledWith("星河科技");
  // 社区的「该公司面经」仍在，仍然隐藏。
  const community = row("A").querySelector<HTMLElement>("[data-go=community]")!;
  expect(community.hasAttribute("data-platform-off")).toBe(true);
});

test("company notes: no entry when the company has no notes, when the read fails, or when the options are absent", async () => {
  for (const reader of [async () => 0, async () => { throw new Error("读不出来"); }]) {
    document.body.innerHTML = readFileSync("index.html", "utf8").split("<body>")[1].split("</body>")[0];
    const companyNoteCount = vi.fn(reader);
    await mount({ apps: [app("A", "interview", { company: "星河科技" })] }, { companyNoteCount, openCompanyNotes: vi.fn(), openNotes: vi.fn() });
    toggleRow("A");
    await waitFor(() => expect(row("A").querySelector(".app-chain")).toBeTruthy());
    await waitFor(() => expect(companyNoteCount).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(row("A").querySelector("[data-go=company-notes]")).toBeNull();
    // 「写心得」还在。
    expect(within(row("A")).getByText("写心得")).toBeTruthy();
  }
  document.body.innerHTML = readFileSync("index.html", "utf8").split("<body>")[1].split("</body>")[0];
  await mount({ apps: [app("A", "interview")] });
  toggleRow("A");
  await waitFor(() => expect(row("A").querySelector(".app-chain")).toBeTruthy());
  expect(row("A").querySelector("[data-go=company-notes]")).toBeNull();
});

test("company notes: a late answer for a row that was collapsed does not draw the entry", async () => {
  const releases: Array<(count: number) => void> = [];
  const companyNoteCount = vi.fn(() => new Promise<number>((resolve) => { releases.push(resolve); }));
  await mount({ apps: [app("A", "interview"), app("B", "submitted")] }, { companyNoteCount, openCompanyNotes: vi.fn() });
  toggleRow("A");
  await waitFor(() => expect(companyNoteCount).toHaveBeenCalledTimes(1));
  toggleRow("B");
  await waitFor(() => expect(row("B").querySelector(".app-chain")).toBeTruthy());
  // 先答的是已经收起的 A：不能画到 B 上。
  releases[0](5);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(document.querySelector("[data-go=company-notes]")).toBeNull();
  // B 自己的答案到了才显示。
  releases[1](2);
  await waitFor(() => expect(row("B").querySelector("[data-go=company-notes]")!.textContent).toContain("2 篇"));
});
