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
  { active = true, listen }: { active?: boolean; listen?: (name: string, handler: () => void) => () => void } = {},
) {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invoke = (async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    return handler(command, args);
  }) as Invoke;
  const view = render(
    <InvokeProvider invoke={invoke}>
      <SiteAnswers active={active} listen={listen} />
    </InvokeProvider>,
  );
  return { calls, view, invoke };
}

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
  const site = await screen.findByRole("region", { name: "campus.example.com" });
  expect(within(site).getByText("是否曾在本行实习")).toBeTruthy();
  expect(screen.getByRole("region", { name: "app.mokahr.com/example" })).toBeTruthy();
  await userEvent.click(within(site).getByRole("button", { name: "删除「是否曾在本行实习」" }));
  expect(await screen.findByText("已删除「是否曾在本行实习」。")).toBeTruthy();
  expect(calls.find((c) => c.command === "delete_site_answers_cmd")?.args).toEqual({ site: "campus.example.com", question: "是否曾在本行实习" });
  expect(within(site).queryByText("是否曾在本行实习")).toBeNull();
  expect(within(site).getByText("是否有亲属在本公司工作")).toBeTruthy();
});

test("删除整个网站要先确认", async () => {
  let list = [answer("campus.example.com", "是否有亲属在本公司工作", "否"), answer("campus.example.com", "是否曾在本行实习", "否")];
  const { calls } = mount((command, args) => {
    if (command === "list_site_answers_cmd") return list;
    if (command === "delete_site_answers_cmd") {
      list = list.filter((item) => item.site !== args?.site);
      return list;
    }
    return null;
  });
  const site = await screen.findByRole("region", { name: "campus.example.com" });
  await userEvent.click(within(site).getByRole("button", { name: "删除这个网站" }));
  const dialog = screen.getByRole("dialog", { name: "删除这个网站的回答？" });
  expect(within(dialog).getByText(/campus\.example\.com 的 2 个回答会删掉/)).toBeTruthy();
  expect(calls.some((c) => c.command === "delete_site_answers_cmd")).toBe(false);
  await userEvent.click(within(dialog).getByRole("button", { name: "删除" }));
  expect(await screen.findByText("还没有记住任何网站的回答。")).toBeTruthy();
  expect(calls.find((c) => c.command === "delete_site_answers_cmd")?.args).toEqual({ site: "campus.example.com" });
});

test("切到这一页才读，插件存了新回答时重新读", async () => {
  let list: SiteAnswerView[] = [];
  let notify: (() => void) | null = null;
  const listen = (name: string, handler: () => void) => {
    if (name === "site-answers-changed") notify = handler;
    return () => { notify = null; };
  };
  const handler = (command: string) => (command === "list_site_answers_cmd" ? list : null);
  const { calls, view, invoke } = mount(handler, { active: false, listen });
  await act(async () => {});
  expect(calls).toHaveLength(0);
  view.rerender(
    <InvokeProvider invoke={invoke}>
      <SiteAnswers active listen={listen} />
    </InvokeProvider>,
  );
  expect(await screen.findByText("还没有记住任何网站的回答。")).toBeTruthy();
  list = [answer("campus.example.com", "是否有亲属在本公司工作", "否")];
  act(() => notify?.());
  expect(await screen.findByRole("region", { name: "campus.example.com" })).toBeTruthy();
  await waitFor(() => expect(calls.filter((c) => c.command === "list_site_answers_cmd")).toHaveLength(2));
});
