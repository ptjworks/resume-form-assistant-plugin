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
function mount(handler: Handler, onConfirmed?: (message: string, tone?: "success" | "warn") => void) {
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

test("空闲时只有一个「AI 整理」按钮，没有长篇说明", async () => {
  mount(base(suggestion()));
  expect(await screen.findByRole("button", { name: "AI 整理" })).toBeTruthy();
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

async function analyse(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "AI 整理" }));
  await user.click(await screen.findByRole("button", { name: "发送" }));
}

test("整理完弹出一个简单的结果窗：列出日程和属于哪条投递，点「加入日历」才写入", async () => {
  const user = userEvent.setup();
  const onConfirmed = vi.fn();
  const calls = mount(base(suggestion()), onConfirmed);
  await analyse(user);
  expect(await screen.findByText("AI 识别结果")).toBeTruthy();
  expect(screen.getByText("后端实习二面")).toBeTruthy();
  expect(screen.getByText("9月22日 10:00")).toBeTruthy();
  expect(screen.getByText("合成科技 · 后端实习")).toBeTruthy();
  // 没有任何要自己填的东西：阶段、轮次、时区、分类都不出现。
  expect(document.querySelector("dialog select, dialog input")).toBeNull();
  expect(calls.some((call) => call.command === "confirm_suggestion_cmd")).toBe(false);
  await user.click(screen.getByRole("button", { name: "加入日历" }));
  await waitFor(() => expect(calls.find((call) => call.command === "confirm_suggestion_cmd")?.args).toMatchObject({ args: { suggestionId: "sug-1", applicationId: "app-a" } }));
  await waitFor(() => expect(onConfirmed).toHaveBeenCalledWith(expect.stringContaining("1 条待办"), "success"));
});

test("确认成功但提醒没登记上时，以 warn 语气通知宿主留在状态栏", async () => {
  const user = userEvent.setup();
  const onConfirmed = vi.fn();
  const answer = suggestion();
  mount((command, args) => {
    if (command === "confirm_suggestion_cmd") {
      return {
        suggestion: { ...answer, status: "confirmed" },
        alreadyConfirmed: false,
        events: [],
        todos: [{ id: "t" }],
        reminderProblems: ["系统通知权限未开启"],
      };
    }
    return base(answer)(command, args);
  }, onConfirmed);
  await analyse(user);
  await user.click(await screen.findByRole("button", { name: "加入日历" }));
  await waitFor(() =>
    expect(onConfirmed).toHaveBeenCalledWith(expect.stringContaining("提醒没登记上：系统通知权限未开启"), "warn"),
  );
});

test("没识别到日程时如实说识别到的分类，按钮是「确认」", async () => {
  const user = userEvent.setup();
  mount(base(suggestion({ todos: [], replyClass: "reject" })));
  await analyse(user);
  expect(await screen.findByText("识别为「未通过」，没有日程。")).toBeTruthy();
  expect(screen.getByRole("button", { name: "确认" })).toBeTruthy();
});

test("对应哪条投递没法确定时不替用户挑：列出候选，点一条之前「加入日历」是灰的", async () => {
  const user = userEvent.setup();
  const two = suggestion({ candidates: [{ id: "app-a", company: "合成科技", title: "后端实习", stage: "submitted" }, { id: "app-b", company: "别家", title: "前端", stage: "submitted" }] as never });
  const calls = mount(base(two));
  await analyse(user);
  await screen.findByText("属于哪条投递？");
  expect((screen.getByRole("button", { name: "加入日历" }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole("button", { name: "别家 · 前端" }));
  expect((screen.getByRole("button", { name: "加入日历" }) as HTMLButtonElement).disabled).toBe(false);
  await user.click(screen.getByRole("button", { name: "加入日历" }));
  await waitFor(() => expect(calls.find((call) => call.command === "confirm_suggestion_cmd")?.args).toMatchObject({ args: { applicationId: "app-b" } }));
});

test("「先不处理」什么都不写；再点「AI 整理」直接拿出上次的结果，不重新分析", async () => {
  const user = userEvent.setup();
  const calls = mount(base(suggestion()));
  await analyse(user);
  await user.click(await screen.findByRole("button", { name: "先不处理" }));
  await waitFor(() => expect(screen.queryByText("AI 识别结果")).toBeNull());
  expect(calls.some((call) => call.command === "confirm_suggestion_cmd")).toBe(false);
  await user.click(screen.getByRole("button", { name: "AI 整理" }));
  expect(await screen.findByText("AI 识别结果")).toBeTruthy();
  expect(calls.filter((call) => call.command === "analyze_evidence_cmd")).toHaveLength(1);
});

test("以前留下的待确认建议：点「AI 整理」直接显示，不用再花一次钱", async () => {
  const user = userEvent.setup();
  const calls = mount((command, args) => command === "list_suggestions_cmd" ? [suggestion()] : base(suggestion())(command, args));
  await waitFor(() => expect((screen.getByRole("button", { name: "AI 整理" }) as HTMLButtonElement).disabled).toBe(false));
  await user.click(screen.getByRole("button", { name: "AI 整理" }));
  expect(await screen.findByText("AI 识别结果")).toBeTruthy();
  expect(calls.some((call) => call.command === "analyze_evidence_cmd" || call.command === "preview_analysis_cmd")).toBe(false);
});

test("已经确认过的通知不再摆「AI 整理」", async () => {
  mount((command, args) => command === "list_suggestions_cmd" ? [suggestion({ status: "confirmed" })] : base(suggestion())(command, args));
  await waitFor(() => expect(screen.queryByRole("button", { name: "AI 整理" })).toBeNull());
});

test("出错时在一个小弹窗里说清楚，不挤在标题栏", async () => {
  const user = userEvent.setup();
  mount((command, args) => {
    if (command === "analyze_evidence_cmd") throw { code: "AI_NOT_CONFIGURED", message: "还没有配置 AI Key。" };
    return base(suggestion())(command, args);
  });
  await analyse(user);
  expect(await screen.findByText("AI 整理没能完成")).toBeTruthy();
  expect(screen.getByText(/还没有配置 AI Key/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "知道了" }));
  await waitFor(() => expect(screen.queryByText("AI 整理没能完成")).toBeNull());
});

test("出错窗里同一句话只说一次，也没有「关掉」和「知道了」两个意思一样的按钮", async () => {
  const user = userEvent.setup();
  mount((command, args) => {
    if (command === "analyze_evidence_cmd") throw { code: "AI_UNSUPPORTED_KIND", message: "这类证据还不能 AI 整理。可以把正文复制出来，用「粘贴文本」再导入一次。" };
    return base(suggestion())(command, args);
  });
  await analyse(user);
  await screen.findByText("AI 整理没能完成");
  expect(screen.getAllByText(/粘贴文本/)).toHaveLength(1);
  expect(screen.queryByText(/手动分类/)).toBeNull();
  expect(screen.queryByRole("button", { name: "关掉" })).toBeNull();
  expect(screen.getByRole("button", { name: "知道了" })).toBeTruthy();
});

test("模型没认出是哪条投递时，邮件里提到的公司排在最前面并标出来", async () => {
  const user = userEvent.setup();
  const none = suggestion({ candidates: [] });
  mount((command, args) => {
    if (command === "list_applications_cmd") return { total: 3, items: [{ id: "x1", company: "山海游戏", title: "客户端" }, { id: "x2", company: "云杉数据", title: "分析" }, { id: "x3", company: "星河科技", title: "前端" }] };
    if (command === "get_evidence_preview_cmd") return { subject: "【星河科技】笔试", bodyExtract: "请参加星河科技的在线笔试" };
    return base(none)(command, args);
  });
  await analyse(user);
  await screen.findByText("AI 没认出是哪条投递，请点选一条：");
  await waitFor(() => expect(screen.getByText("邮件里提到")).toBeTruthy());
  const rows = screen.getAllByRole("button").filter((b) => b.closest(".ai-pick-list")).map((b) => b.textContent);
  expect(rows[0]).toContain("星河科技 · 前端");
});

test("AI 没认出而你只有一条投递时不替用户选：显示成一行可点的列表，点了才亮", async () => {
  const user = userEvent.setup();
  const none = suggestion({ candidates: [] });
  const calls = mount((command, args) => {
    if (command === "list_applications_cmd") return { total: 1, items: [{ id: "only-1", company: "孤星科技", title: "全栈" }] };
    return base(none)(command, args);
  });
  await analyse(user);
  await screen.findByText("AI 没认出是哪条投递，请点选一条：");
  const confirmBtn = screen.getByRole("button", { name: "加入日历" }) as HTMLButtonElement;
  expect(confirmBtn.disabled).toBe(true);
  await user.click(await screen.findByRole("button", { name: "孤星科技 · 全栈" }));
  await waitFor(() => expect(confirmBtn.disabled).toBe(false));
  await user.click(confirmBtn);
  await waitFor(() =>
    expect(calls.find((call) => call.command === "confirm_suggestion_cmd")?.args).toMatchObject({ args: { applicationId: "only-1" } }),
  );
});

test("模型认出唯一候选但还有其他在办投递时，可点「不是这条？换一条」展开全部投递改选", async () => {
  const user = userEvent.setup();
  const calls = mount(base(suggestion()));
  await analyse(user);
  await screen.findByText("合成科技 · 后端实习");
  await user.click(await screen.findByRole("button", { name: "不是这条？换一条" }));
  await screen.findByText("换成哪条投递？");
  await user.click(screen.getByRole("button", { name: "别家 · 前端" }));
  await user.click(screen.getByRole("button", { name: "加入日历" }));
  await waitFor(() =>
    expect(calls.find((call) => call.command === "confirm_suggestion_cmd")?.args).toMatchObject({
      args: { applicationId: "app-b" },
    }),
  );
});

test("没有任何可关联的在办投递时提示先去新增，且确认按钮禁用", async () => {
  const user = userEvent.setup();
  const none = suggestion({ candidates: [] });
  mount((command, args) => {
    if (command === "list_applications_cmd") return { total: 0, items: [] };
    return base(none)(command, args);
  });
  await analyse(user);
  expect(await screen.findByText("还没有可以关联的投递。先到「投递」页新增一条，再回来整理。")).toBeTruthy();
  expect((screen.getByRole("button", { name: "加入日历" }) as HTMLButtonElement).disabled).toBe(true);
});

test("结果窗点「不准？重新整理」回到外发预览，发送前不多花一次分析调用", async () => {
  const user = userEvent.setup();
  const calls = mount(base(suggestion()));
  await analyse(user);
  await screen.findByText("AI 识别结果");
  expect(calls.filter((call) => call.command === "preview_analysis_cmd")).toHaveLength(1);
  expect(calls.filter((call) => call.command === "analyze_evidence_cmd")).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "不准？重新整理" }));
  expect(await screen.findByRole("button", { name: "发送" })).toBeTruthy();
  expect(calls.filter((call) => call.command === "preview_analysis_cmd")).toHaveLength(2);
  expect(calls.filter((call) => call.command === "analyze_evidence_cmd")).toHaveLength(1);
});

test("一条投递都没有时说明去哪新增，按钮保持灰", async () => {
  const user = userEvent.setup();
  mount((command, args) => command === "list_applications_cmd" ? { total: 0, items: [] } : base(suggestion({ candidates: [] }))(command, args));
  await analyse(user);
  expect(await screen.findByText(/先到「投递」页新增一条/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "加入日历" }) as HTMLButtonElement).disabled).toBe(true);
});

test("AI 只认出一条时可以「换一条」，展开全部投递再选", async () => {
  const user = userEvent.setup();
  const calls = mount(base(suggestion()));
  await analyse(user);
  await user.click(await screen.findByRole("button", { name: "不是这条？换一条" }));
  await user.click(await screen.findByRole("button", { name: "别家 · 前端" }));
  await user.click(screen.getByRole("button", { name: "加入日历" }));
  await waitFor(() => expect(calls.find((call) => call.command === "confirm_suggestion_cmd")?.args).toMatchObject({ args: { applicationId: "app-b" } }));
});

test("「不准？重新整理」回到发送前的确认，不直接发送", async () => {
  const user = userEvent.setup();
  const calls = mount(base(suggestion()));
  await analyse(user);
  await user.click(await screen.findByRole("button", { name: "不准？重新整理" }));
  expect(await screen.findByText("api.example.test")).toBeTruthy();
  expect(screen.getByRole("button", { name: "发送" })).toBeTruthy();
  expect(calls.filter((call) => call.command === "analyze_evidence_cmd")).toHaveLength(1);
});

test("确认时提醒没登记上：把「warn」告诉宿主，让它留在状态栏", async () => {
  const user = userEvent.setup();
  const onConfirmed = vi.fn();
  mount((command, args) => command === "confirm_suggestion_cmd"
    ? { suggestion: { ...suggestion(), status: "confirmed" }, alreadyConfirmed: false, events: [], todos: [{ id: "t" }], reminderProblems: ["这台机器上的提醒不可用"] }
    : base(suggestion())(command, args), onConfirmed);
  await analyse(user);
  await user.click(await screen.findByRole("button", { name: "加入日历" }));
  await waitFor(() => expect(onConfirmed).toHaveBeenCalledWith(expect.stringContaining("提醒没登记上"), "warn"));
});

test("按钮就是面板根节点的直接子元素：通知页的样式选择器靠这个结构命中它", async () => {
  mount(base(suggestion()));
  const button = await screen.findByRole("button", { name: "AI 整理" });
  expect(button.parentElement?.matches("section.ai-panel.is-compact")).toBe(true);
  expect(button.classList.contains("ai-start")).toBe(true);
});

test("AI 明确认出了唯一一条投递：直接选上，按钮可点", async () => {
  const user = userEvent.setup();
  const calls = mount(base(suggestion()));
  await analyse(user);
  await screen.findByText("合成科技 · 后端实习");
  expect((screen.getByRole("button", { name: "加入日历" }) as HTMLButtonElement).disabled).toBe(false);
  await user.click(screen.getByRole("button", { name: "加入日历" }));
  await waitFor(() => expect(calls.find((c) => c.command === "confirm_suggestion_cmd")?.args).toMatchObject({ args: { applicationId: "app-a" } }));
});
