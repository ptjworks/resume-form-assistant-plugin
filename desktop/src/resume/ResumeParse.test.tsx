import { StrictMode } from "react";
import { expect, test, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AiSettingsView, Invoke } from "../api.ts";
import { InvokeProvider } from "../react/invoke.tsx";
import { MAX_TEMPLATE_BYTES } from "./parse-limits.ts";
import { templateBytes } from "./parse-trim.ts";
import { ResumeParse } from "./ResumeParse.tsx";
import type { FilePickers } from "./TemplateList.tsx";

const settings: AiSettingsView = {
  providers: [{ id: "p1", name: "DeepSeek", apiUrl: "https://api.deepseek.com/v1/chat/completions", model: "deepseek-chat", host: "api.deepseek.com", keyConfigured: true }],
  activeProviderId: "p1",
  strongProviderId: null,
  credentialError: null,
};

const emptyOverview = { templates: [], activeTemplateId: null };

function mount(handler: (command: string, args?: Record<string, unknown>) => unknown, strict = false, pickers: FilePickers | null = null) {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invoke = (async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    return handler(command, args);
  }) as Invoke;
  const onCreated = vi.fn();
  const tree = (
    <InvokeProvider invoke={invoke}>
      <ResumeParse onCreated={onCreated} extract={async () => "张三\n某大学"} pickers={pickers} />
    </InvokeProvider>
  );
  // 桌面程序用 StrictMode 挂载（react/mount.tsx）：开发构建里 effect 会先卸一次再装一次。
  const { unmount } = render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  return { calls, onCreated, unmount };
}

const upload = async (user: ReturnType<typeof userEvent.setup>) =>
  user.upload(screen.getByLabelText(/上传简历/), new File(["x"], "张三简历.pdf"));

// 短暂让出宏任务队列：不依赖组件仍然挂载（unmount 之后 screen 查询会失败），
// 只用来确认「组件卸载后 promise 落地」这条分支已经跑完。
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("确认前说清楚发给谁、发多少字，确认后才发送", async () => {
  const user = userEvent.setup();
  const { calls, onCreated } = mount((command) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "resume_overview_cmd") return emptyOverview;
    if (command === "ai_complete_cmd") return '[{"group":"基本信息","key":"姓名","value":"张三"}]';
    if (command === "create_resume_template_cmd") {
      return { template: { id: "t1", name: "张三简历（AI 解析）", fieldCount: 1, updatedAt: "" }, previousFieldCount: null, skippedSecretFields: 0 };
    }
    return null;
  });
  await upload(user);
  const dialog = await screen.findByRole("dialog", { name: "发送简历给 AI 解析？" });
  expect(within(dialog).getByText("DeepSeek")).toBeTruthy();
  expect(within(dialog).getByText("api.deepseek.com")).toBeTruthy();
  expect(within(dialog).getByText("deepseek-chat")).toBeTruthy();
  expect(within(dialog).getByText(/《张三简历\.pdf》的全文（6 字）/)).toBeTruthy();
  expect(within(dialog).getByText(/对方可能留存这些内容。解析成功后会直接新建模板并设为当前/)).toBeTruthy();
  // 外发不是默认动作：焦点先落在「不发送」上。
  expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "不发送" }));
  expect(calls.some((c) => c.command === "ai_complete_cmd")).toBe(false);
  await user.click(within(dialog).getByRole("button", { name: "发送并解析" }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("t1"));
  expect(screen.getByText("已存为模板「张三简历（AI 解析）」并设为当前，共 1 个字段。")).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  const sent = calls.find((c) => c.command === "ai_complete_cmd")!;
  expect(sent.args?.providerId).toBe("p1");
  const created = calls.find((c) => c.command === "create_resume_template_cmd")!;
  expect(created.args).toEqual({ name: "张三简历（AI 解析）", groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "张三" }] }] });
});

test("确认之后服务商变了：后端拒绝时如实提示，得重新确认一次", async () => {
  const user = userEvent.setup();
  const { calls } = mount((command) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "resume_overview_cmd") return emptyOverview;
    if (command === "ai_complete_cmd") {
      throw { code: "AI_PROVIDER_CHANGED", message: "当前服务商在确认之后变了，请重新选择文件确认一次。" };
    }
    return null;
  });
  await upload(user);
  await user.click(await screen.findByRole("button", { name: "发送并解析" }));
  expect(await screen.findByText("当前服务商在确认之后变了，请重新选择文件确认一次。")).toBeTruthy();
  const sent = calls.find((c) => c.command === "ai_complete_cmd")!;
  expect(sent.args?.providerId).toBe("p1");
  expect(calls.some((c) => c.command === "create_resume_template_cmd")).toBe(false);
});

test("没有可用服务商时不让发送，并指向设置页", async () => {
  const user = userEvent.setup();
  mount((command) => {
    if (command === "get_ai_settings_cmd") return { providers: [], activeProviderId: null, credentialError: null };
    if (command === "resume_overview_cmd") return emptyOverview;
    return null;
  });
  await upload(user);
  expect(await screen.findByText(/先在「设置 → AI」添加服务商/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "发送并解析" })).toHaveProperty("disabled", true);
});

test("模板已经有 25 个时不让发送，并提示先删掉", async () => {
  const user = userEvent.setup();
  const templates = Array.from({ length: 25 }, (_, i) => ({ id: `t${i}`, name: `t${i}`, fieldCount: 1, updatedAt: "" }));
  mount((command) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "resume_overview_cmd") return { templates, activeTemplateId: null };
    return null;
  });
  await upload(user);
  expect(await screen.findByText(/模板已经有 25 个，先删掉用不上的再解析/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "发送并解析" })).toHaveProperty("disabled", true);
});

test("等待中可以取消，取消后如实显示已取消", async () => {
  const user = userEvent.setup();
  let reject: (reason?: unknown) => void = () => {};
  const { calls } = mount((command) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "resume_overview_cmd") return emptyOverview;
    if (command === "ai_complete_cmd") return new Promise((_resolve, rej) => { reject = rej; });
    if (command === "cancel_analysis_cmd") {
      reject({ code: "AI_CANCELLED", message: "已取消。取消不保证对方停止计算或停止计费。" });
      return true;
    }
    return null;
  });
  await upload(user);
  await user.click(await screen.findByRole("button", { name: "发送并解析" }));
  await user.click(await screen.findByRole("button", { name: "取消解析" }));
  const cancel = calls.find((c) => c.command === "cancel_analysis_cmd")!;
  const sent = calls.find((c) => c.command === "ai_complete_cmd")!;
  expect(cancel.args?.requestId).toBe(sent.args?.requestId);
  expect(await screen.findByText("已取消。取消不保证对方停止计算或停止计费。")).toBeTruthy();
});

test("模型返回乱码时如实提示，不建模板", async () => {
  const user = userEvent.setup();
  const { calls } = mount((command) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "resume_overview_cmd") return emptyOverview;
    if (command === "ai_complete_cmd") return "抱歉";
    return null;
  });
  await upload(user);
  await user.click(await screen.findByRole("button", { name: "发送并解析" }));
  expect(await screen.findByText(/AI 返回格式异常/)).toBeTruthy();
  expect(calls.some((c) => c.command === "create_resume_template_cmd")).toBe(false);
});

test("剔掉的密码类字段要说出来", async () => {
  const user = userEvent.setup();
  mount((command) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "resume_overview_cmd") return emptyOverview;
    if (command === "ai_complete_cmd") return '[{"group":"g","key":"k","value":"v"}]';
    if (command === "create_resume_template_cmd") {
      return { template: { id: "t1", name: "n", fieldCount: 1, updatedAt: "" }, previousFieldCount: null, skippedSecretFields: 2 };
    }
    return null;
  });
  await upload(user);
  await user.click(await screen.findByRole("button", { name: "发送并解析" }));
  expect(await screen.findByText(/另有 2 个像密码或验证码的字段没有存/)).toBeTruthy();
});

test("建模板失败时可以不重新调用 AI、直接重新保存", async () => {
  const user = userEvent.setup();
  let createCalls = 0;
  const { calls } = mount((command) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "resume_overview_cmd") return emptyOverview;
    if (command === "ai_complete_cmd") return '[{"group":"基本信息","key":"姓名","value":"张三"}]';
    if (command === "create_resume_template_cmd") {
      createCalls += 1;
      if (createCalls === 1) throw { code: "STORE_ERROR", message: "写不进去" };
      return { template: { id: "t1", name: "张三简历（AI 解析）", fieldCount: 1, updatedAt: "" }, previousFieldCount: null, skippedSecretFields: 0 };
    }
    return null;
  });
  await upload(user);
  await user.click(await screen.findByRole("button", { name: "发送并解析" }));
  expect(await screen.findByText("写不进去")).toBeTruthy();
  expect(screen.getByText(/保存时出错，新模板没有建成。可以重新保存/)).toBeTruthy();
  const retry = await screen.findByRole("button", { name: "重新保存" });
  await user.click(retry);
  await waitFor(() => expect(screen.getByText(/已存为模板/)).toBeTruthy());
  expect(calls.filter((c) => c.command === "ai_complete_cmd")).toHaveLength(1);
  expect(calls.filter((c) => c.command === "create_resume_template_cmd")).toHaveLength(2);
});

test("解析中途离开页面：卸载时取消请求，回来的结果不再建模板或提示", async () => {
  const user = userEvent.setup();
  let resolveAi: (value: unknown) => void = () => {};
  const { calls, onCreated, unmount } = mount((command) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "resume_overview_cmd") return emptyOverview;
    if (command === "ai_complete_cmd") return new Promise((resolve) => { resolveAi = resolve; });
    if (command === "cancel_analysis_cmd") return true;
    if (command === "create_resume_template_cmd") {
      return { template: { id: "t1", name: "n", fieldCount: 1, updatedAt: "" }, previousFieldCount: null, skippedSecretFields: 0 };
    }
    return null;
  });
  await upload(user);
  await user.click(await screen.findByRole("button", { name: "发送并解析" }));
  expect(calls.some((c) => c.command === "ai_complete_cmd")).toBe(true);

  unmount();
  expect(calls.some((c) => c.command === "cancel_analysis_cmd")).toBe(true);

  resolveAi('[{"group":"g","key":"k","value":"v"}]');
  await flush();

  expect(calls.some((c) => c.command === "create_resume_template_cmd")).toBe(false);
  expect(onCreated).not.toHaveBeenCalled();
});

test("StrictMode 下挂载后仍能进入确认外发这一步", async () => {
  const user = userEvent.setup();
  mount((command) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "resume_overview_cmd") return emptyOverview;
    return null;
  }, true);
  await upload(user);
  expect(await screen.findByRole("button", { name: "发送并解析" })).toBeTruthy();
});

test("文字超过 6 万字时不让发送", async () => {
  const user = userEvent.setup();
  const onCreated = vi.fn();
  const invoke = (async (command: string) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "resume_overview_cmd") return emptyOverview;
    return null;
  }) as Invoke;
  render(
    <InvokeProvider invoke={invoke}>
      <ResumeParse onCreated={onCreated} extract={async () => "字".repeat(61_000)} />
    </InvokeProvider>,
  );
  await upload(user);
  expect(await screen.findByText(/超过 6 万字/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "发送并解析" })).toHaveProperty("disabled", true);
});

test("不发送就关掉确认，什么都不外发", async () => {
  const user = userEvent.setup();
  const { calls } = mount((command) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "resume_overview_cmd") return emptyOverview;
    return null;
  });
  await upload(user);
  await user.click(await screen.findByRole("button", { name: "不发送" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(calls.some((c) => c.command === "ai_complete_cmd")).toBe(false);
});

test("文件读不出文字时如实提示，不进入外发确认", async () => {
  const user = userEvent.setup();
  const invoke = (async (command: string) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "resume_overview_cmd") return emptyOverview;
    return null;
  }) as Invoke;
  render(
    <InvokeProvider invoke={invoke}>
      <ResumeParse onCreated={() => {}} extract={async () => { throw new Error("这份 PDF 没有可读取的文字，可能是扫描版。"); }} />
    </InvokeProvider>,
  );
  await upload(user);
  expect(await screen.findByText("这份 PDF 没有可读取的文字，可能是扫描版。")).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("等待时可以在后台继续，工作区里仍能查看进度和取消", async () => {
  const user = userEvent.setup();
  let reject: (reason?: unknown) => void = () => {};
  const { calls } = mount((command) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "resume_overview_cmd") return emptyOverview;
    if (command === "ai_complete_cmd") return new Promise((_resolve, rej) => { reject = rej; });
    if (command === "cancel_analysis_cmd") {
      reject({ code: "AI_CANCELLED", message: "已取消。取消不保证对方停止计算或停止计费。" });
      return true;
    }
    return null;
  });
  await upload(user);
  await user.click(await screen.findByRole("button", { name: "发送并解析" }));
  const waiting = await screen.findByRole("dialog", { name: "AI 正在解析" });
  expect(within(waiting).getByText(/不保证对方停止计算或计费/)).toBeTruthy();
  await user.click(within(waiting).getByRole("button", { name: "在后台继续" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  const progress = screen.getByRole("group", { name: "AI 解析进度" });
  expect(within(progress).getByText(/AI 正在解析《张三简历\.pdf》/)).toBeTruthy();
  await user.click(within(progress).getByRole("button", { name: "查看进度" }));
  expect(screen.getByRole("dialog", { name: "AI 正在解析" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "在后台继续" }));
  await user.click(within(screen.getByRole("group", { name: "AI 解析进度" })).getByRole("button", { name: "取消解析" }));
  expect(calls.some((c) => c.command === "cancel_analysis_cmd")).toBe(true);
  expect(await screen.findByText("已取消。取消不保证对方停止计算或停止计费。")).toBeTruthy();
  expect(screen.queryByRole("group", { name: "AI 解析进度" })).toBeNull();
  expect(calls.some((c) => c.command === "create_resume_template_cmd")).toBe(false);
});

test("后台保存失败时不自己弹窗，工作区里可以重新保存", async () => {
  const user = userEvent.setup();
  let resolveAi: (value: unknown) => void = () => {};
  let createCalls = 0;
  const { calls } = mount((command) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "resume_overview_cmd") return emptyOverview;
    if (command === "ai_complete_cmd") return new Promise((resolve) => { resolveAi = resolve; });
    if (command === "create_resume_template_cmd") {
      createCalls += 1;
      if (createCalls === 1) throw { code: "STORE_ERROR", message: "写不进去" };
      return { template: { id: "t1", name: "n", fieldCount: 1, updatedAt: "" }, previousFieldCount: null, skippedSecretFields: 0 };
    }
    return null;
  });
  await upload(user);
  await user.click(await screen.findByRole("button", { name: "发送并解析" }));
  await user.click(await screen.findByRole("button", { name: "在后台继续" }));
  resolveAi('[{"group":"g","key":"k","value":"v"}]');
  const progress = await screen.findByRole("group", { name: "AI 解析进度" });
  await waitFor(() => expect(within(progress).getByRole("button", { name: "重新保存" })).toBeTruthy());
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.click(within(progress).getByRole("button", { name: "重新保存" }));
  await waitFor(() => expect(screen.getByText(/已存为模板/)).toBeTruthy());
  expect(calls.filter((c) => c.command === "ai_complete_cmd")).toHaveLength(1);
});

test("读取文件时可以取消，晚到的读取结果作废", async () => {
  const user = userEvent.setup();
  let finish: (text: string) => void = () => {};
  const invoke = (async (command: string) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "resume_overview_cmd") return emptyOverview;
    return null;
  }) as Invoke;
  render(
    <InvokeProvider invoke={invoke}>
      <ResumeParse onCreated={() => {}} extract={() => new Promise((resolve) => { finish = resolve; })} />
    </InvokeProvider>,
  );
  await upload(user);
  const reading = await screen.findByRole("dialog", { name: "正在读取简历" });
  await user.click(within(reading).getByRole("button", { name: "取消" }));
  finish("张三");
  await flush();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("点了取消后 AI 仍成功返回：不建模板，如实说明没有保存", async () => {
  const user = userEvent.setup();
  let resolveAi: (value: unknown) => void = () => {};
  const { calls, onCreated } = mount((command) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "resume_overview_cmd") return emptyOverview;
    if (command === "ai_complete_cmd") return new Promise((resolve) => { resolveAi = resolve; });
    // 取消命令没来得及让请求失败：回复照常到达。
    if (command === "cancel_analysis_cmd") return true;
    return null;
  });
  await upload(user);
  await user.click(await screen.findByRole("button", { name: "发送并解析" }));
  await user.click(await screen.findByRole("button", { name: "取消解析" }));
  resolveAi('[{"group":"基本信息","key":"姓名","value":"张三"}]');
  expect(await screen.findByText(/已取消，AI 返回的结果没有保存/)).toBeTruthy();
  expect(calls.some((c) => c.command === "create_resume_template_cmd")).toBe(false);
  expect(onCreated).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
});

// AI 返回一份超过模板上限的结果：基本信息很小，项目经历 30 条、每条约 300 个汉字（约 27 KB）。
const bigFields = [
  { group: "基本信息", key: "姓名", value: "张三" },
  { group: "基本信息", key: "手机号码", value: "13800000000" },
  ...Array.from({ length: 30 }, (_, i) => ({ group: "项目经历", key: `项目${i + 1}`, value: "负责数据清洗与报表".repeat(33) + "汇报" })),
  { group: "自我评价", key: "评价", value: "认真负责" },
];
const bigReply = JSON.stringify(bigFields);

type Groups = Array<{ name: string; fields: Array<{ key: string; value: string }> }>;

const resultGroups = (): Groups => {
  const map = new Map<string, Array<{ key: string; value: string }>>();
  for (const f of bigFields) map.set(f.group, [...(map.get(f.group) ?? []), { key: f.key, value: f.value }]);
  return [...map].map(([name, fields]) => ({ name, fields }));
};

const fmt = (n: number) => `${new Intl.NumberFormat("zh-CN").format(n)} 字节`;

// 后端的大小检查：按 UTF-8 字节和上限比，超了返回 TEMPLATE_TOO_LARGE。
function sizedBackend(extra: (command: string, args?: Record<string, unknown>) => unknown = () => null) {
  return (command: string, args?: Record<string, unknown>) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "resume_overview_cmd") return emptyOverview;
    if (command === "ai_complete_cmd") return bigReply;
    if (command === "create_resume_template_cmd") {
      const groups = args?.groups as Groups;
      const bytes = templateBytes(groups);
      if (bytes > MAX_TEMPLATE_BYTES) throw { code: "TEMPLATE_TOO_LARGE", message: `模板太大：${bytes} 字节，上限 ${MAX_TEMPLATE_BYTES} 字节（24 KB）。` };
      const fieldCount = groups.reduce((sum, g) => sum + g.fields.length, 0);
      return { template: { id: "t1", name: "张三简历（AI 解析）", fieldCount, updatedAt: "" }, previousFieldCount: null, skippedSecretFields: 0 };
    }
    return extra(command, args);
  };
}

const reachTrim = async (user: ReturnType<typeof userEvent.setup>) => {
  await upload(user);
  await user.click(await screen.findByRole("button", { name: "发送并解析" }));
  return screen.findByRole("dialog", { name: "解析结果超过模板大小上限" });
};

test("解析结果超过上限：按字节说清大小，删掉一组后保存成功，不再调用 AI", async () => {
  const user = userEvent.setup();
  const { calls, onCreated } = mount(sizedBackend());
  const dialog = await reachTrim(user);
  const total = templateBytes(resultGroups());
  expect(total).toBeGreaterThan(MAX_TEMPLATE_BYTES);
  // 字符串长度远小于字节数：拿 length 比会以为没超。
  expect(JSON.stringify(resultGroups()).length).toBeLessThan(MAX_TEMPLATE_BYTES);
  expect(within(dialog).getByText(new RegExp(`AI 解析出 33 个字段，共 ${fmt(total)}`))).toBeTruthy();
  expect(within(dialog).getByText(/超过模板上限 24,576 字节（24 KB）/)).toBeTruthy();
  expect(within(dialog).getByText(new RegExp(`还要减少 ${fmt(total - MAX_TEMPLATE_BYTES)}`))).toBeTruthy();
  // 同一份数据再存一次不会成，不给「重新保存」。
  expect(within(dialog).queryByRole("button", { name: "重新保存" })).toBeNull();
  const save = within(dialog).getByRole("button", { name: "保存为模板" });
  expect(save).toHaveProperty("disabled", true);

  await user.click(within(dialog).getByRole("checkbox", { name: "项目经历" }));
  expect(within(dialog).getByText(/保留 3 个字段，.*可以保存/)).toBeTruthy();
  await user.click(save);
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("t1"));
  expect(screen.getByText("已存为模板「张三简历（AI 解析）」并设为当前，共 3 个字段。")).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  const creates = calls.filter((c) => c.command === "create_resume_template_cmd");
  expect(creates).toHaveLength(2);
  expect(creates[0].args?.groups).toEqual(resultGroups());
  expect(creates[1].args?.groups).toEqual([
    { name: "基本信息", fields: [{ key: "姓名", value: "张三" }, { key: "手机号码", value: "13800000000" }] },
    { name: "自我评价", fields: [{ key: "评价", value: "认真负责" }] },
  ]);
  expect(calls.filter((c) => c.command === "ai_complete_cmd")).toHaveLength(1);
});

test("逐个字段删减和缩短内容；恢复原结果回到 AI 返回的样子", async () => {
  const user = userEvent.setup();
  const { calls } = mount(sizedBackend());
  const dialog = await reachTrim(user);
  const list = within(dialog).getByRole("list", { name: "解析出的分组" });
  const projects = within(list).getAllByRole("listitem").find((item) => item.textContent?.startsWith("项目经历"))!;
  await user.click(within(projects).getByRole("button", { name: "逐个字段" }));
  const save = () => within(dialog).getByRole("button", { name: "保存为模板" });
  const trimProjects = async () => {
    // 超出约 3.4 KB：去掉前 3 条还差一点，再把第 4 条缩短到几个字。
    for (let i = 1; i <= 3; i += 1) await user.click(within(projects).getByRole("checkbox", { name: `项目${i}` }));
    expect(save()).toHaveProperty("disabled", true);
    const fourth = within(projects).getByRole("textbox", { name: "项目经历 · 项目4" });
    await user.clear(fourth);
    await user.paste("做过报表");
    expect(save()).toHaveProperty("disabled", false);
  };
  await trimProjects();

  await user.click(within(dialog).getByRole("button", { name: "恢复原结果" }));
  expect(save()).toHaveProperty("disabled", true);
  expect((within(projects).getByRole("textbox", { name: "项目经历 · 项目4" }) as HTMLTextAreaElement).value).toBe(resultGroups()[1].fields[3].value);

  await trimProjects();
  await user.click(save());
  await waitFor(() => expect(screen.getByText(/已存为模板/)).toBeTruthy());
  const saved = calls.filter((c) => c.command === "create_resume_template_cmd")[1].args?.groups as Groups;
  const savedProjects = saved.find((g) => g.name === "项目经历")!;
  expect(savedProjects.fields.map((f) => f.key)).toEqual(Array.from({ length: 27 }, (_, i) => `项目${i + 4}`));
  expect(savedProjects.fields[0].value).toBe("做过报表");
  expect(templateBytes(saved)).toBeLessThanOrEqual(MAX_TEMPLATE_BYTES);
  expect(calls.filter((c) => c.command === "ai_complete_cmd")).toHaveLength(1);
  // 30 个长文本框、来回点十几下，jsdom 里单跑约 2 秒；和别的测试文件并发时留足余量。
}, 15_000);

test("像密码的字段不存，也不算进大小：删到存得下就能保存", async () => {
  const user = userEvent.setup();
  const backend = sizedBackend();
  const withSecret = JSON.stringify([...bigFields, { group: "账号", key: "邮箱密码", value: "x".repeat(3000) }]);
  const { calls } = mount((command, args) => (command === "ai_complete_cmd" ? withSecret : backend(command, args)));
  const dialog = await reachTrim(user);
  expect(within(dialog).getByText(new RegExp(`还要减少 ${fmt(templateBytes(resultGroups()) - MAX_TEMPLATE_BYTES)}。另有 1 个像密码或验证码的字段不会存，没算在内。`))).toBeTruthy();
  const list = within(dialog).getByRole("list", { name: "解析出的分组" });
  const projects = within(list).getAllByRole("listitem").find((item) => item.textContent?.startsWith("项目经历"))!;
  await user.click(within(projects).getByRole("button", { name: "逐个字段" }));
  // 不算密码那 3 KB 时，去掉 4 条项目就存得下；算上的话还差得远。
  for (let i = 1; i <= 4; i += 1) await user.click(within(projects).getByRole("checkbox", { name: `项目${i}` }));
  expect(within(dialog).getByText(/保留 29 个字段，.*可以保存。另有 1 个/)).toBeTruthy();
  await user.click(within(dialog).getByRole("button", { name: "保存为模板" }));
  await waitFor(() => expect(screen.getByText(/已存为模板/)).toBeTruthy());
  expect(calls.filter((c) => c.command === "ai_complete_cmd")).toHaveLength(1);
}, 15_000);

test("超限的结果可以导出成 Excel，导出的是 AI 返回的结果，不是删减后的草稿", async () => {
  const user = userEvent.setup();
  const save = vi.fn(async (suggested: string) => `/tmp/${suggested}`);
  const { calls } = mount(sizedBackend(), false, { open: async () => null, save });
  const dialog = await reachTrim(user);
  // 先删一组：导出不受草稿影响。
  await user.click(within(dialog).getByRole("checkbox", { name: "自我评价" }));
  await user.click(within(dialog).getByRole("button", { name: "导出解析结果" }));
  expect(await within(dialog).findByText(/已导出。在 Excel 里改完后，可以在模板列表用「导入」读回/)).toBeTruthy();
  expect(save).toHaveBeenCalledWith("张三简历（AI 解析）.xlsx");
  const exported = calls.find((c) => c.command === "export_resume_groups_cmd")!;
  expect(exported.args).toEqual({ groups: resultGroups(), path: "/tmp/张三简历（AI 解析）.xlsx" });
  // 导出不建模板，弹窗和草稿都还在。
  expect(calls.filter((c) => c.command === "create_resume_template_cmd")).toHaveLength(1);
  expect(within(dialog).getByRole("checkbox", { name: "自我评价" })).toHaveProperty("checked", false);
});

test("导出时剔掉的密码类字段要说出来", async () => {
  const user = userEvent.setup();
  mount(sizedBackend((command) => (command === "export_resume_groups_cmd" ? 2 : null)), false, { open: async () => null, save: async (s) => `/tmp/${s}` });
  const dialog = await reachTrim(user);
  await user.click(within(dialog).getByRole("button", { name: "导出解析结果" }));
  expect(await within(dialog).findByText(/已导出，2 个像密码或验证码的字段没有导出。/)).toBeTruthy();
});

test("保存框还开着就放弃、又解析了一份：选好位置后不写旧结果，提示也不出现", async () => {
  const user = userEvent.setup();
  let finish: (path: string | null) => void = () => {};
  const save = vi.fn(() => new Promise<string | null>((resolve) => { finish = resolve; }));
  const { calls } = mount(sizedBackend(), false, { open: async () => null, save });
  const first = await reachTrim(user);
  await user.click(within(first).getByRole("button", { name: "导出解析结果" }));
  await user.click(within(first).getByRole("button", { name: "稍后处理" }));
  await user.click(within(screen.getByRole("group", { name: "AI 解析进度" })).getByRole("button", { name: "放弃这次结果" }));
  const second = await reachTrim(user);
  await act(async () => {
    finish("/tmp/张三简历（AI 解析）.xlsx");
    await flush();
  });
  expect(calls.some((c) => c.command === "export_resume_groups_cmd")).toBe(false);
  expect(within(second).queryByText(/已导出/)).toBeNull();
  // 旧的那次作废后，新结果照样能导出。
  await waitFor(() => expect(within(second).getByRole("button", { name: "导出解析结果" })).toHaveProperty("disabled", false));
});

test("文件已经在写时放弃、又解析了一份：写完的提示不出现在新结果里", async () => {
  const user = userEvent.setup();
  let written: (skipped: number) => void = () => {};
  const backend = sizedBackend((command) =>
    command === "export_resume_groups_cmd" ? new Promise<number>((resolve) => { written = resolve; }) : null);
  const { calls } = mount(backend, false, { open: async () => null, save: async (s) => `/tmp/${s}` });
  const first = await reachTrim(user);
  await user.click(within(first).getByRole("button", { name: "导出解析结果" }));
  await waitFor(() => expect(calls.some((c) => c.command === "export_resume_groups_cmd")).toBe(true));
  await user.click(within(first).getByRole("button", { name: "稍后处理" }));
  await user.click(within(screen.getByRole("group", { name: "AI 解析进度" })).getByRole("button", { name: "放弃这次结果" }));
  const second = await reachTrim(user);
  await act(async () => {
    written(0);
    await flush();
  });
  expect(within(second).queryByText(/已导出/)).toBeNull();
});

test("前端算着存得下、后端仍判超限：显示后端的数字，再删一些就能存", async () => {
  const user = userEvent.setup();
  // 模拟两边规则没对齐：后端比前端多算 600 字节。
  const backend = sizedBackend();
  const { calls } = mount((command, args) => {
    if (command === "create_resume_template_cmd") {
      const bytes = templateBytes(args?.groups as Groups) + 600;
      if (bytes > MAX_TEMPLATE_BYTES) throw { code: "TEMPLATE_TOO_LARGE", message: `模板太大：${bytes} 字节，上限 ${MAX_TEMPLATE_BYTES} 字节（24 KB）。请删掉一些内容或拆成几个模板。` };
    }
    return backend(command, args);
  });
  const dialog = await reachTrim(user);
  const list = within(dialog).getByRole("list", { name: "解析出的分组" });
  const projects = within(list).getAllByRole("listitem").find((item) => item.textContent?.startsWith("项目经历"))!;
  await user.click(within(projects).getByRole("button", { name: "逐个字段" }));
  for (let i = 1; i <= 4; i += 1) await user.click(within(projects).getByRole("checkbox", { name: `项目${i}` }));
  const save = () => within(dialog).getByRole("button", { name: "保存为模板" });
  const bytes = templateBytes(resultGroups().map((g) => (g.name === "项目经历" ? { ...g, fields: g.fields.slice(4) } : g)));
  expect(within(dialog).getByText(/可以保存/)).toBeTruthy();
  await user.click(save());
  expect(await within(dialog).findByText(new RegExp(`模板太大：${bytes + 600} 字节`))).toBeTruthy();
  expect(save()).toHaveProperty("disabled", true);
  // 再去掉一条，后端那边也降到上限内。
  await user.click(within(projects).getByRole("checkbox", { name: "项目5" }));
  expect(save()).toHaveProperty("disabled", false);
  await user.click(save());
  await waitFor(() => expect(screen.getByText(/已存为模板/)).toBeTruthy());
  expect(calls.filter((c) => c.command === "ai_complete_cmd")).toHaveLength(1);
}, 15_000);

test("导出时取消选择位置：什么都不写", async () => {
  const user = userEvent.setup();
  const { calls } = mount(sizedBackend(), false, { open: async () => null, save: async () => null });
  const dialog = await reachTrim(user);
  await user.click(within(dialog).getByRole("button", { name: "导出解析结果" }));
  await flush();
  expect(calls.some((c) => c.command === "export_resume_groups_cmd")).toBe(false);
  expect(within(dialog).getByRole("button", { name: "导出解析结果" })).toHaveProperty("disabled", false);
});

test("没有系统文件窗口时不显示导出", async () => {
  const user = userEvent.setup();
  mount(sizedBackend());
  const dialog = await reachTrim(user);
  expect(within(dialog).queryByRole("button", { name: "导出解析结果" })).toBeNull();
});

test("超限后稍后处理：工作区里能回到删减，也能放弃", async () => {
  const user = userEvent.setup();
  mount(sizedBackend());
  const dialog = await reachTrim(user);
  await user.click(within(dialog).getByRole("checkbox", { name: "项目经历" }));
  await user.click(within(dialog).getByRole("button", { name: "稍后处理" }));
  const progress = screen.getByRole("group", { name: "AI 解析进度" });
  expect(within(progress).getByText(/超过模板大小上限，还没存成模板/)).toBeTruthy();
  expect(within(progress).queryByRole("button", { name: "重新保存" })).toBeNull();
  await user.click(within(progress).getByRole("button", { name: "删减后保存" }));
  // 回来时删减还在。
  const reopened = screen.getByRole("dialog", { name: "解析结果超过模板大小上限" });
  expect(within(reopened).getByRole("checkbox", { name: "项目经历" })).toHaveProperty("checked", false);
  await user.click(within(reopened).getByRole("button", { name: "稍后处理" }));
  await user.click(within(screen.getByRole("group", { name: "AI 解析进度" })).getByRole("button", { name: "放弃这次结果" }));
  expect(screen.queryByRole("group", { name: "AI 解析进度" })).toBeNull();
});

test("删减后保存遇到存储出错：停在删减界面，草稿还在，可以再存", async () => {
  const user = userEvent.setup();
  let failNext = true;
  const backend = sizedBackend();
  const { calls } = mount((command, args) => {
    if (command === "create_resume_template_cmd" && templateBytes(args?.groups as Groups) <= MAX_TEMPLATE_BYTES && failNext) {
      failNext = false;
      throw { code: "STORE_ERROR", message: "写不进去" };
    }
    return backend(command, args);
  });
  const dialog = await reachTrim(user);
  await user.click(within(dialog).getByRole("checkbox", { name: "项目经历" }));
  await user.click(within(dialog).getByRole("button", { name: "保存为模板" }));
  expect((await within(dialog).findByRole("alert")).textContent).toBe("写不进去");
  expect(within(dialog).getByRole("checkbox", { name: "项目经历" })).toHaveProperty("checked", false);
  await user.click(within(dialog).getByRole("button", { name: "保存为模板" }));
  await waitFor(() => expect(screen.getByText(/已存为模板/)).toBeTruthy());
  expect(calls.filter((c) => c.command === "ai_complete_cmd")).toHaveLength(1);
});

test("校验没过（比如模板满了）和临时出错分开说", async () => {
  const user = userEvent.setup();
  mount((command) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "resume_overview_cmd") return emptyOverview;
    if (command === "ai_complete_cmd") return '[{"group":"g","key":"k","value":"v"}]';
    if (command === "create_resume_template_cmd") throw { code: "VALIDATION", message: "模板已经有 25 个，先删掉用不上的。" };
    return null;
  });
  await upload(user);
  await user.click(await screen.findByRole("button", { name: "发送并解析" }));
  const dialog = await screen.findByRole("dialog", { name: "解析结果未能保存" });
  expect(within(dialog).getByText(/处理好下面的问题后再保存/)).toBeTruthy();
  expect(within(dialog).getByRole("alert").textContent).toBe("模板已经有 25 个，先删掉用不上的。");
  expect(within(dialog).getByRole("button", { name: "重新保存" })).toBeTruthy();
});
