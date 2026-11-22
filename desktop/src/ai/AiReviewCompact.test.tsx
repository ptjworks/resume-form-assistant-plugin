import { expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AiSuggestion, Invoke, OutboundPreview } from "../api.ts";
import { InvokeProvider } from "../react/invoke.tsx";
import { AiReview } from "./AiReview.tsx";

// 通知页底栏用的紧凑模式（#552）：一个「AI 整理」按钮，整理完收成一行「识别到 N 个日程 · 确认 · 修改」。
// 发送前的脱敏预览、确认走的命令都和完整面板是同一份。

const preview: OutboundPreview = {
  host: "api.example.test", model: "fake-model", bodyChars: 120, truncated: false, hasSubject: true, hasFrom: true,
  candidates: [{ label: "c1", company: "合成科技", title: "后端实习", stage: "submitted" }],
  bodyPreview: "您好，时间定在下周二上午十点。", summary: "发往 api.example.test · 模型 fake-model · 正文 120 字 · 候选 1 条",
  slowHintSeconds: 15, timeoutSeconds: 60, maxCandidates: 8,
};
const todo = { title: "后端实习二面", duePrecision: "datetime" as const, dueAtUtc: "2026-09-22T02:00:00Z", timeZone: "Asia/Shanghai", interviewRound: 2 };
const suggestion = (extra: Partial<AiSuggestion> = {}): AiSuggestion => ({
  id: "sug-1", evidenceId: "ev-1", status: "pending",
  candidates: [{ id: "app-a", company: "合成科技", title: "后端实习", stage: "submitted" }],
  stage: "interview", round: 2, replyClass: "interview_invite", sendMode: "automated", todos: [todo] as never,
  excerpts: ["下周二上午十点"], uncertainties: [], modelLabel: "fake-model", promptScope: "发往 api.example.test",
  createdAt: "2026-09-16T02:00:00Z", ...extra,
});
const apps = { items: [{ id: "app-a", company: "合成科技", title: "后端实习" }, { id: "app-b", company: "别家", title: "前端" }], total: 2 };

type Handler = (command: string, args?: Record<string, unknown>) => unknown;
function mount(handler: Handler, onConfirmed?: (message: string) => void) {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invoke = (async (command: string, args?: Record<string, unknown>) => { calls.push({ command, args }); return handler(command, args); }) as Invoke;
  render(<InvokeProvider invoke={invoke}><AiReview evidenceId="ev-1" onConfirmed={onConfirmed} compact /></InvokeProvider>);
  return calls;
}
const base = (answer: AiSuggestion): Handler => (command) => {
  if (command === "list_suggestions_cmd") return [];
  if (command === "preview_analysis_cmd") return preview;
  if (command === "analyze_evidence_cmd") return answer;
  if (command === "list_applications_cmd") return apps;
  if (command === "get_evidence_preview_cmd") return { bodyExtract: "您好，时间定在下周二上午十点。" };
  if (command === "confirm_suggestion_cmd") return { suggestion: { ...answer, status: "confirmed" }, alreadyConfirmed: false, events: [], todos: [{ id: "t" }], reminderProblems: [] };
  return null;
};

test("空闲时底栏只有一个「AI 整理」按钮，没有长篇说明", async () => {
  mount(base(suggestion()));
  const button = await screen.findByRole("button", { name: "AI 整理" });
  expect(button).toBeTruthy();
  expect(screen.getAllByRole("button")).toHaveLength(1);
  expect(document.querySelector(".ai-intro")).toBeNull();
});

test("点了先弹出将发送的内容，只有一个「发送」；发送之前不会分析", async () => {
  const user = userEvent.setup();
  const calls = mount(base(suggestion()));
  await user.click(await screen.findByRole("button", { name: "AI 整理" }));
  expect(await screen.findByText("api.example.test")).toBeTruthy();
  expect(screen.getByRole("button", { name: "发送" })).toBeTruthy();
  expect(calls.some((call) => call.command === "analyze_evidence_cmd")).toBe(false);
});

test("整理完收成一行「识别到 N 个日程」，「确认」直接走确认并把结果交给宿主", async () => {
  const user = userEvent.setup();
  const onConfirmed = vi.fn();
  const calls = mount(base(suggestion()), onConfirmed);
  await user.click(await screen.findByRole("button", { name: "AI 整理" }));
  await user.click(await screen.findByRole("button", { name: "发送" }));
  expect(await screen.findByText("识别到 1 个日程")).toBeTruthy();
  expect(screen.getByRole("button", { name: "确认" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "修改" })).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(calls.some((call) => call.command === "confirm_suggestion_cmd")).toBe(false);
  await user.click(screen.getByRole("button", { name: "确认" }));
  await waitFor(() => expect(calls.find((call) => call.command === "confirm_suggestion_cmd")?.args).toMatchObject({ args: { suggestionId: "sug-1", applicationId: "app-a" } }));
  await waitFor(() => expect(onConfirmed).toHaveBeenCalledWith(expect.stringContaining("1 条待办")));
});

test("「修改」展开完整审核面板，草稿和原来的审核一样", async () => {
  const user = userEvent.setup();
  mount(base(suggestion()));
  await user.click(await screen.findByRole("button", { name: "AI 整理" }));
  await user.click(await screen.findByRole("button", { name: "发送" }));
  await user.click(await screen.findByRole("button", { name: "修改" }));
  expect(await screen.findByRole("dialog")).toBeTruthy();
  expect(screen.getByRole("button", { name: "确认" })).toBeTruthy();
});

test("没识别到日程时如实说识别到的分类，同样可以确认或修改", async () => {
  const user = userEvent.setup();
  mount(base(suggestion({ todos: [], replyClass: "reject" })));
  await user.click(await screen.findByRole("button", { name: "AI 整理" }));
  await user.click(await screen.findByRole("button", { name: "发送" }));
  expect(await screen.findByText("识别为「未通过」，没有识别到日程")).toBeTruthy();
  expect(screen.getByRole("button", { name: "确认" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "修改" })).toBeTruthy();
});

test("对应哪条投递没法确定时，不替用户挑：确认置灰并说明，改在「修改」里选", async () => {
  const user = userEvent.setup();
  const two = suggestion({ candidates: [{ id: "app-a", company: "合成科技", title: "后端实习", stage: "submitted" }, { id: "app-b", company: "别家", title: "前端", stage: "submitted" }] as never });
  const calls = mount(base(two));
  await user.click(await screen.findByRole("button", { name: "AI 整理" }));
  await user.click(await screen.findByRole("button", { name: "发送" }));
  await screen.findByText("识别到 1 个日程");
  expect((screen.getByRole("button", { name: "确认" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("这封通知对应哪一条申请还没选。")).toBeTruthy();
  expect(calls.some((call) => call.command === "confirm_suggestion_cmd")).toBe(false);
});

test("以前留下的待确认建议直接收成一行，不用再花一次钱重新分析", async () => {
  const user = userEvent.setup();
  const calls = mount((command, args) => command === "list_suggestions_cmd" ? [suggestion()] : base(suggestion())(command, args));
  expect(await screen.findByText("识别到 1 个日程")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "AI 整理" })).toBeNull();
  expect(calls.some((call) => call.command === "analyze_evidence_cmd")).toBe(false);
  await user.click(screen.getByRole("button", { name: "修改" }));
  expect(await screen.findByRole("dialog")).toBeTruthy();
});

test("拒绝过的建议不自动展开，只留一个轻量入口，按钮仍是「AI 整理」", async () => {
  mount((command, args) => command === "list_suggestions_cmd" ? [suggestion({ status: "rejected" })] : base(suggestion())(command, args));
  expect(await screen.findByRole("button", { name: "AI 整理" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "看看拒绝过的建议" })).toBeTruthy();
  expect(screen.queryByText(/识别到/)).toBeNull();
});
