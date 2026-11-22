import { expect, test } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Invoke, SiteAnswerView } from "../api.ts";
import { InvokeProvider } from "../react/invoke.tsx";
import { SiteAnswers } from "./SiteAnswers.tsx";

const answer = (site: string, question: string, value: string): SiteAnswerView => ({
  site, question, answer: value, updatedAt: "2026-11-02T08:00:00Z",
});

function mount(
  handler: (command: string, args?: Record<string, unknown>) => unknown,
  { listen }: { listen?: (name: string, handler: () => void) => () => void } = {},
) {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invoke = (async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    return handler(command, args);
  }) as Invoke;
  const view = render(
    <InvokeProvider invoke={invoke}>
      <SiteAnswers listen={listen} />
    </InvokeProvider>,
  );
  return { calls, view, invoke };
}

const open = async () => {
  await userEvent.click(await screen.findByRole("button", { name: "查看" }));
  return screen.findByRole("dialog", { name: "按公司记住的回答" });
};

test("入口只有一行，说明有几家；点「查看」才弹出列表", async () => {
  mount(() => [
    answer("app.mokahr.com/example", "是否有亲属在本公司工作", "否"),
    answer("campus.example.com", "是否有亲属在本公司工作", "是"),
    answer("campus.example.com", "是否曾在本行实习", "否"),
  ]);
  const entry = await screen.findByRole("region", { name: "按公司记住的回答" });
  expect(await within(entry).findByText(/2 家/)).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  const dialog = await open();
  expect(within(dialog).getByText(/只在同一家公司的网申里自动填写/)).toBeTruthy();
});

test("按网站分组列出回答，删一道题只删这一道", async () => {
  let list = [
    answer("app.mokahr.com/example", "是否有亲属在本公司工作", "否"),
    answer("campus.example.com", "是否有亲属在本公司工作", "是"),
    answer("campus.example.com", "是否曾在本行实习", "否"),
  ];
  const { calls } = mount((command, args) => {
    if (command === "list_site_answers_cmd") return list;
    if (command === "delete_site_answers_cmd") {
      list = list.filter((item) => !(item.site === args?.site && item.question === args?.question));
      return list;
    }
    return null;
  });
  const dialog = await open();
  const site = within(dialog).getByRole("region", { name: "campus.example.com" });
  expect(within(site).getByText("是否曾在本行实习")).toBeTruthy();
  expect(within(dialog).getByRole("region", { name: "app.mokahr.com/example" })).toBeTruthy();
  await userEvent.click(within(site).getByRole("button", { name: "删除「是否曾在本行实习」" }));
  expect(await screen.findByText("已删除「是否曾在本行实习」。")).toBeTruthy();
  expect(calls.find((c) => c.command === "delete_site_answers_cmd")?.args).toEqual({ site: "campus.example.com", question: "是否曾在本行实习" });
  expect(within(site).queryByText("是否曾在本行实习")).toBeNull();
  expect(within(site).getByText("是否有亲属在本公司工作")).toBeTruthy();
});

test("删除整家公司要先确认，确认画面就在同一个弹窗里", async () => {
  let list = [answer("campus.example.com", "是否有亲属在本公司工作", "否"), answer("campus.example.com", "是否曾在本行实习", "否")];
  const { calls } = mount((command, args) => {
    if (command === "list_site_answers_cmd") return list;
    if (command === "delete_site_answers_cmd") {
      list = list.filter((item) => item.site !== args?.site);
      return list;
    }
    return null;
  });
  const dialog = await open();
  await userEvent.click(within(dialog).getByRole("button", { name: "删除这家公司" }));
  const confirm = await screen.findByRole("dialog", { name: "删除这家公司的回答？" });
  expect(within(confirm).getByText(/campus\.example\.com 的 2 个回答会删掉/)).toBeTruthy();
  expect(calls.some((c) => c.command === "delete_site_answers_cmd")).toBe(false);
  // 取消只回到列表，不关掉弹窗。
  await userEvent.click(within(confirm).getByRole("button", { name: "取消" }));
  expect(await screen.findByRole("dialog", { name: "按公司记住的回答" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "删除这家公司" }));
  await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "删除" }));
  expect(await screen.findByText("还没有记住任何公司的回答。")).toBeTruthy();
  expect(calls.find((c) => c.command === "delete_site_answers_cmd")?.args).toEqual({ site: "campus.example.com" });
});

test("Escape 关掉列表", async () => {
  mount(() => [answer("campus.example.com", "是否有亲属在本公司工作", "否")]);
  await open();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("插件存了新回答时入口的数量跟着变", async () => {
  let list: SiteAnswerView[] = [];
  let notify: (() => void) | null = null;
  const listen = (name: string, handler: () => void) => {
    if (name === "site-answers-changed") notify = handler;
    return () => { notify = null; };
  };
  const { calls } = mount((command) => (command === "list_site_answers_cmd" ? list : null), { listen });
  const entry = await screen.findByRole("region", { name: "按公司记住的回答" });
  expect(await within(entry).findByText(/还没有/)).toBeTruthy();
  list = [answer("campus.example.com", "是否有亲属在本公司工作", "否")];
  act(() => notify?.());
  expect(await within(entry).findByText(/1 家/)).toBeTruthy();
  await waitFor(() => expect(calls.filter((c) => c.command === "list_site_answers_cmd")).toHaveLength(2));
});

const many = () =>
  ["甲", "乙", "丙", "丁", "戊"].flatMap((name) => [
    answer(`jobs.${name}.example.com`, "是否有亲属在本公司工作", "否"),
    answer(`jobs.${name}.example.com`, `${name}公司专属题`, `${name}的回答`),
  ]);

test("公司多（超过 3 家）时先收起，只看公司名和条数，点开才看题目", async () => {
  mount(() => many());
  const dialog = await open();
  const site = within(dialog).getByRole("region", { name: "jobs.甲.example.com" });
  expect(within(site).getByText("2 条")).toBeTruthy();
  expect(within(site).queryByText("甲公司专属题")).toBeNull();
  const toggle = within(site).getByRole("button", { name: /jobs\.甲\.example\.com/ });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  await userEvent.click(toggle);
  expect(within(site).getByText("甲公司专属题")).toBeTruthy();
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  await userEvent.click(toggle);
  expect(within(site).queryByText("甲公司专属题")).toBeNull();
});

test("公司不多（3 家以内）时默认全部展开", async () => {
  mount(() => many().slice(0, 6));
  const dialog = await open();
  expect(within(dialog).getByText("甲公司专属题")).toBeTruthy();
  expect(within(dialog).getByText("丙公司专属题")).toBeTruthy();
});

test("搜索按公司、题目或回答找，命中的公司自动展开，其他的隐藏；清空后恢复", async () => {
  mount(() => many());
  const dialog = await open();
  const search = within(dialog).getByRole("searchbox", { name: "搜索公司或题目" });
  await userEvent.type(search, "丁的回答");
  expect(within(dialog).getByRole("region", { name: "jobs.丁.example.com" })).toBeTruthy();
  expect(within(dialog).getByText("丁公司专属题")).toBeTruthy();
  // 只留命中的那一条，同公司的另一道题不显示。
  expect(within(dialog).queryByText("是否有亲属在本公司工作")).toBeNull();
  expect(within(dialog).queryByRole("region", { name: "jobs.甲.example.com" })).toBeNull();
  await userEvent.clear(search);
  await userEvent.type(search, "jobs.乙");
  expect(within(dialog).getByRole("region", { name: "jobs.乙.example.com" })).toBeTruthy();
  expect(within(dialog).getAllByText("是否有亲属在本公司工作")).toHaveLength(1);
  await userEvent.clear(search);
  await userEvent.type(search, "不存在的内容");
  expect(within(dialog).getByText("没有找到匹配的公司或题目。")).toBeTruthy();
  await userEvent.clear(search);
  expect(within(dialog).getAllByRole("region")).toHaveLength(5);
});
