import { expect, test } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Invoke, ResumeOverview, ResumeTemplateView } from "../api.ts";
import { InvokeProvider } from "../react/invoke.tsx";
import type { DesktopEvent } from "./LegacyImport.tsx";
import { TemplateList } from "./TemplateList.tsx";

// #553：模板字段就地编辑（没有编辑模式、没有保存按钮）。数据全是虚构的。
const baseOverview: ResumeOverview = {
  templates: [
    { id: "t1", name: "校招简历", fieldCount: 3, updatedAt: "2026-10-01T00:00:00.000Z" },
    { id: "t2", name: "实习简历", fieldCount: 1, updatedAt: "2026-09-01T00:00:00.000Z" },
  ],
  activeTemplateId: "t1",
};

const original = (): ResumeTemplateView => ({
  id: "t1",
  name: "校招简历",
  updatedAt: "2026-10-01T00:00:00.000Z",
  contentSha256: "a".repeat(64),
  groups: [
    { name: "基本信息", fields: [{ key: "姓名", value: "测试用户" }, { key: "电话", value: "13800000000" }] },
    { name: "教育经历", fields: [{ key: "学校", value: "示例大学" }] },
  ],
});

type Handler = (command: string, args?: Record<string, unknown>) => unknown;
type User = ReturnType<typeof userEvent.setup>;

// 每次都回新对象，和真实的 invoke 一样（同一个引用 React 会当作没变）。
let overview: ResumeOverview = structuredClone(baseOverview);
let saveCount = 0;
let saveDelay = 0;

function mount(handler: Handler = () => undefined) {
  overview = structuredClone(baseOverview);
  saveCount = 0;
  saveDelay = 0;
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const listeners = new Map<string, (event?: DesktopEvent) => void>();
  let template = original();
  const invoke = (async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    const answer = handler(command, args);
    if (answer instanceof Error) throw answer;
    if (answer !== undefined) return answer;
    if (command === "resume_overview_cmd") return structuredClone(overview);
    if (command === "get_resume_template_cmd") return args?.id === "t1" ? structuredClone(template) : { ...original(), id: "t2", name: "实习简历" };
    if (command === "get_profile_cmd") return { profile: { values: {}, family: [], custom: [{ key: "电话", value: "13900000000" }] }, revision: 1 };
    if (command === "save_resume_template_fields_cmd") {
      if (saveDelay) await new Promise((resolve) => setTimeout(resolve, saveDelay));
      saveCount += 1;
      template = {
        ...template,
        groups: args?.groups as ResumeTemplateView["groups"],
        contentSha256: String(saveCount).repeat(64).slice(0, 64),
        updatedAt: `2026-10-12T00:00:0${saveCount}.000Z`,
      };
      return structuredClone(template);
    }
    return undefined;
  }) as Invoke;
  const view = (signal?: { token: number; select?: string | null }) => (
    <InvokeProvider invoke={invoke}>
      <TemplateList
        pickers={{ open: async () => null, save: async () => "/tmp/导出.xlsx" }}
        reloadSignal={signal}
        listen={(name, handler) => {
          listeners.set(name, handler);
          return () => listeners.delete(name);
        }}
      />
    </InvokeProvider>
  );
  const rendered = render(view());
  return {
    calls,
    listeners,
    setTemplate: (next: ResumeTemplateView) => { template = next; },
    signal: (token: number, select?: string | null) => rendered.rerender(view({ token, select })),
  };
}

const detail = () => screen.getByRole("region", { name: "模板详情" });
const row = (name: string) => within(detail()).getByRole("group", { name });
const saves = (calls: Array<{ command: string; args?: Record<string, unknown> }>) => calls.filter((call) => call.command === "save_resume_template_fields_cmd");
const status = () => within(detail()).getByRole("status");

async function ready() {
  await waitFor(() => expect(within(detail()).getByText("示例大学")).toBeTruthy());
}

/** 点内容，原地变成输入框，改成新的，回车。 */
async function setValue(user: User, field: string, text: string) {
  await user.click(within(row(field)).getByRole("button", { name: `修改「${field}」的内容` }));
  const box = within(row(field)).getByLabelText("内容");
  await user.clear(box);
  await user.type(box, `${text}{Enter}`);
}

test("字段直接显示在详情里，没有「编辑字段」「保存修改」，每个字段都能点着改", async () => {
  mount();
  await ready();
  expect(within(detail()).queryByRole("button", { name: "编辑字段" })).toBeNull();
  expect(within(detail()).queryByRole("button", { name: "保存修改" })).toBeNull();
  expect(within(row("姓名")).getByRole("button", { name: "修改「姓名」的内容" }).textContent).toBe("测试用户");
  expect(within(row("姓名")).getByRole("button", { name: "修改字段名「姓名」" })).toBeTruthy();
});

test("点内容原地改，回车就保存这一处；只改这份模板", async () => {
  const user = userEvent.setup();
  const { calls } = mount();
  await ready();
  await setValue(user, "姓名", "测试用户乙");
  await waitFor(() => expect(saves(calls)).toHaveLength(1));
  expect(saves(calls)[0].args).toEqual({
    id: "t1",
    baseSha256: "a".repeat(64),
    groups: [
      { name: "基本信息", fields: [{ key: "姓名", value: "测试用户乙" }, { key: "电话", value: "13800000000" }] },
      { name: "教育经历", fields: [{ key: "学校", value: "示例大学" }] },
    ],
  });
  await waitFor(() => expect(within(row("姓名")).getByRole("button", { name: "修改「姓名」的内容" }).textContent).toBe("测试用户乙"));
  expect(status().textContent).toMatch(/已保存/);
  // 保存后再改，用的是上一次保存返回的版本，不会误报冲突。
  await setValue(user, "电话", "13700000000");
  await waitFor(() => expect(saves(calls)).toHaveLength(2));
  expect(saves(calls)[1].args?.baseSha256).toBe("1".repeat(64));
});

test("点别处也算改完；按 Esc 放弃，不保存；没改动不保存", async () => {
  const user = userEvent.setup();
  const { calls } = mount();
  await ready();
  await user.click(within(row("姓名")).getByRole("button", { name: "修改「姓名」的内容" }));
  await user.type(within(row("姓名")).getByLabelText("内容"), "丙");
  await user.keyboard("{Escape}");
  expect(within(row("姓名")).getByRole("button", { name: "修改「姓名」的内容" }).textContent).toBe("测试用户");
  await user.click(within(row("电话")).getByRole("button", { name: "修改「电话」的内容" }));
  await user.click(document.body);
  expect(saves(calls)).toHaveLength(0);

  await user.click(within(row("姓名")).getByRole("button", { name: "修改「姓名」的内容" }));
  await user.type(within(row("姓名")).getByLabelText("内容"), "丁");
  await user.click(document.body);
  await waitFor(() => expect(saves(calls)).toHaveLength(1));
  expect((saves(calls)[0].args?.groups as Array<{ fields: Array<{ value: string }> }>)[0].fields[0].value).toBe("测试用户丁");
});

test("点字段名可以改名", async () => {
  const user = userEvent.setup();
  const { calls } = mount();
  await ready();
  await user.click(within(row("电话")).getByRole("button", { name: "修改字段名「电话」" }));
  const box = within(row("电话")).getByLabelText("字段名称");
  await user.clear(box);
  await user.type(box, "手机号{Enter}");
  await waitFor(() => expect(saves(calls)).toHaveLength(1));
  expect(within(detail()).getByRole("group", { name: "手机号" })).toBeTruthy();
});

test("字段名为空或像密码：就在那一行标红，不保存，输入还在", async () => {
  const user = userEvent.setup();
  const { calls } = mount();
  await ready();
  await user.click(within(row("电话")).getByRole("button", { name: "修改字段名「电话」" }));
  const box = within(row("电话")).getByLabelText("字段名称");
  await user.clear(box);
  await user.keyboard("{Enter}");
  expect(await within(row("电话")).findByText("字段名称不能为空。")).toBeTruthy();
  expect(box.getAttribute("aria-invalid")).toBe("true");
  await user.type(box, "邮箱密码{Enter}");
  expect(await within(row("电话")).findByText(/密码或验证码/)).toBeTruthy();
  expect(saves(calls)).toHaveLength(0);
});

test("删除不弹确认，直接删并给「撤销」；撤销后原样写回", async () => {
  const user = userEvent.setup();
  const { calls } = mount();
  await ready();
  await user.click(within(row("电话")).getByRole("button", { name: "删除「电话」" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(within(detail()).queryByRole("group", { name: "电话" })).toBeNull());
  expect(saves(calls)).toHaveLength(1);
  // 「我的信息」里有同名内容，要说出来。
  expect(await within(status()).findByText(/已删除「电话」。「我的信息」里还有同名内容，一键填写时仍可能用到/)).toBeTruthy();
  await user.click(within(status()).getByRole("button", { name: "撤销" }));
  await waitFor(() => expect(within(detail()).getByRole("group", { name: "电话" })).toBeTruthy());
  expect(saves(calls)).toHaveLength(2);
  expect(saves(calls)[1].args?.groups).toEqual(original().groups);
});

test("删到只剩最后一个字段时拦住：模板至少留一个字段", async () => {
  const user = userEvent.setup();
  const { calls } = mount((command, args) =>
    command === "get_resume_template_cmd" && args?.id === "t1"
      ? { ...original(), groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "测试用户" }] }] }
      : undefined,
  );
  await waitFor(() => expect(within(detail()).getByText("测试用户")).toBeTruthy());
  await user.click(within(row("姓名")).getByRole("button", { name: "删除「姓名」" }));
  expect(await within(status()).findByText(/模板至少要保留一个字段/)).toBeTruthy();
  expect(saves(calls)).toHaveLength(0);
  expect(within(detail()).getByRole("group", { name: "姓名" })).toBeTruthy();
});

test("每个分类里有一个「添加字段」按钮：名称回车到内容，再回车保存，并自动开下一行接着填", async () => {
  const user = userEvent.setup();
  const { calls } = mount();
  await ready();
  const basic = within(detail()).getByRole("region", { name: "分类：基本信息" });
  // 它是字段框里的最后一行，是个按钮，不是文字链接。
  const bar = within(basic).getByRole("button", { name: "在「基本信息」添加字段" });
  expect(bar.className).toContain("tpl-add-bar");
  await user.click(bar);
  const form = within(basic).getByRole("group", { name: "在「基本信息」添加字段" });
  expect(document.activeElement).toBe(within(form).getByLabelText("字段名称"));
  await user.type(within(form).getByLabelText("字段名称"), "邮箱{Enter}");
  expect(document.activeElement).toBe(within(form).getByLabelText("内容"));
  await user.type(within(form).getByLabelText("内容"), "a@example.test{Enter}");
  await waitFor(() => expect(saves(calls)).toHaveLength(1));
  expect((saves(calls)[0].args?.groups as Array<{ name: string; fields: unknown[] }>)[0].fields).toEqual([
    { key: "姓名", value: "测试用户" },
    { key: "电话", value: "13800000000" },
    { key: "邮箱", value: "a@example.test" },
  ]);
  await waitFor(() => expect(within(basic).getByRole("group", { name: "邮箱" })).toBeTruthy());
  // 保存后自动开了新的一行，光标已经在名称里，可以接着加。
  const next = await within(basic).findByRole("group", { name: "在「基本信息」添加字段" });
  await waitFor(() => expect(document.activeElement).toBe(within(next).getByLabelText("字段名称")));
  await user.type(within(next).getByLabelText("字段名称"), "民族{Enter}");
  await user.type(within(next).getByLabelText("内容"), "示例族{Enter}");
  await waitFor(() => expect(saves(calls)).toHaveLength(2));
  expect((saves(calls)[1].args?.groups as Array<{ fields: Array<{ key: string }> }>)[0].fields.map((f) => f.key)).toEqual(["姓名", "电话", "邮箱", "民族"]);
  // Esc 结束：空白行消失，按钮一直都在。
  const third = await within(basic).findByRole("group", { name: "在「基本信息」添加字段" });
  await waitFor(() => expect(document.activeElement).toBe(within(third).getByLabelText("字段名称")));
  await user.keyboard("{Escape}");
  expect(within(basic).queryByRole("group", { name: "在「基本信息」添加字段" })).toBeNull();
  expect(within(basic).getByRole("button", { name: "在「基本信息」添加字段" })).toBeTruthy();
  expect(saves(calls)).toHaveLength(2);
});

test("「添加字段」可以连着点好几下，摆好几行空白再逐个填；填好一行就保存一行", async () => {
  const user = userEvent.setup();
  const { calls } = mount();
  await ready();
  const basic = within(detail()).getByRole("region", { name: "分类：基本信息" });
  const bar = () => within(basic).getByRole("button", { name: "在「基本信息」添加字段" });
  await user.click(bar());
  await user.click(bar());
  await user.click(bar());
  // 按钮一直都在，每点一下多一行；空白行不会因为点了别处就消失。
  expect(within(basic).getAllByRole("group", { name: "在「基本信息」添加字段" })).toHaveLength(3);
  expect(saves(calls)).toHaveLength(0);
  const rows = () => within(basic).getAllByRole("group", { name: "在「基本信息」添加字段" });
  await user.type(within(rows()[0]).getByLabelText("字段名称"), "邮箱");
  await user.type(within(rows()[0]).getByLabelText("内容"), "a@example.test");
  await user.type(within(rows()[1]).getByLabelText("字段名称"), "民族");
  // 填完第一行点到第二行：第一行保存成正式字段，其余空白行还在。
  await waitFor(() => expect(saves(calls)).toHaveLength(1));
  await waitFor(() => expect(within(basic).getByRole("group", { name: "邮箱" })).toBeTruthy());
  expect(within(basic).getAllByRole("group", { name: "在「基本信息」添加字段" })).toHaveLength(2);
  // 不要的空白行用「×」去掉；点它的同时，光标离开了填着「民族」的那一行，那一行也就保存了。
  await user.click(within(rows()[1]).getByRole("button", { name: "去掉这一行" }));
  await waitFor(() => expect(saves(calls)).toHaveLength(2));
  await waitFor(() => expect(within(basic).getByRole("group", { name: "民族" })).toBeTruthy());
  expect(within(basic).queryByRole("group", { name: "在「基本信息」添加字段" })).toBeNull();
  // 只填了内容没填名称：提示要填名称，不保存；Esc 去掉这一行。
  await user.click(bar());
  await user.type(within(rows()[0]).getByLabelText("内容"), "只有内容");
  await user.click(document.body);
  expect(await within(basic).findByText("请填字段名称。")).toBeTruthy();
  expect(saves(calls)).toHaveLength(2);
  await user.click(within(rows()[0]).getByLabelText("内容"));
  await user.keyboard("{Escape}");
  expect(within(basic).queryByRole("group", { name: "在「基本信息」添加字段" })).toBeNull();
});

test("列表最后「新建分类」：一个小表单，可以一次加好几个字段，点「创建分类」才保存", async () => {
  const user = userEvent.setup();
  const { calls } = mount();
  await ready();
  await user.click(within(detail()).getByRole("button", { name: "新建分类" }));
  const form = within(detail()).getByRole("group", { name: "新建分类" });
  expect(document.activeElement).toBe(within(form).getByLabelText("分类名称"));
  await user.type(within(form).getByLabelText("分类名称"), "求职意向{Enter}");
  const first = within(form).getByRole("group", { name: "新字段 1" });
  expect(document.activeElement).toBe(within(first).getByLabelText("字段名称"));
  await user.type(within(first).getByLabelText("字段名称"), "期望城市{Enter}");
  await user.type(within(first).getByLabelText("内容"), "示例城市");
  // 再加一个、再加一个；多余的空白行不会被保存。
  await user.click(within(form).getByRole("button", { name: "再添加一个字段" }));
  const second = within(form).getByRole("group", { name: "新字段 2" });
  await user.type(within(second).getByLabelText("字段名称"), "期望岗位");
  await user.type(within(second).getByLabelText("内容"), "示例岗位");
  await user.click(within(form).getByRole("button", { name: "再添加一个字段" }));
  expect(within(form).getByRole("group", { name: "新字段 3" })).toBeTruthy();
  // 点别处不会丢掉填了一半的表单，也不会保存。
  await user.click(document.body);
  expect(within(detail()).getByRole("group", { name: "新建分类" })).toBeTruthy();
  expect(saves(calls)).toHaveLength(0);
  await user.click(within(form).getByRole("button", { name: "创建分类" }));
  await waitFor(() => expect(saves(calls)).toHaveLength(1));
  expect(saves(calls)[0].args?.groups).toEqual([
    { name: "基本信息", fields: [{ key: "姓名", value: "测试用户" }, { key: "电话", value: "13800000000" }] },
    { name: "教育经历", fields: [{ key: "学校", value: "示例大学" }] },
    { name: "求职意向", fields: [{ key: "期望城市", value: "示例城市" }, { key: "期望岗位", value: "示例岗位" }] },
  ]);
  expect(await within(detail()).findByRole("region", { name: "分类：求职意向" })).toBeTruthy();
  expect(within(detail()).queryByRole("group", { name: "新建分类" })).toBeNull();
  expect(within(detail()).getByRole("button", { name: "新建分类" })).toBeTruthy();
});

test("新建分类：没填分类名、字段名，或只填了内容，会提示；「取消」「Esc」放弃", async () => {
  const user = userEvent.setup();
  const { calls } = mount();
  await ready();
  await user.click(within(detail()).getByRole("button", { name: "新建分类" }));
  const form = within(detail()).getByRole("group", { name: "新建分类" });
  await user.click(within(form).getByRole("button", { name: "创建分类" }));
  expect(await within(form).findByText("请填分类名称。")).toBeTruthy();
  await user.type(within(form).getByLabelText("分类名称"), "求职意向");
  await user.click(within(form).getByRole("button", { name: "创建分类" }));
  expect(await within(form).findByText("至少填一个字段。")).toBeTruthy();
  await user.type(within(form).getByLabelText("内容"), "只有内容");
  await user.click(within(form).getByRole("button", { name: "创建分类" }));
  expect(await within(form).findByText("有的字段只填了内容，请补上字段名称。")).toBeTruthy();
  expect(saves(calls)).toHaveLength(0);
  // 只有一行时没有「去掉」；有多行时每行都能去掉。
  expect(within(form).queryByRole("button", { name: /去掉新字段/ })).toBeNull();
  await user.click(within(form).getByRole("button", { name: "再添加一个字段" }));
  await user.click(within(form).getByRole("button", { name: "去掉新字段 2" }));
  expect(within(form).queryByRole("group", { name: "新字段 2" })).toBeNull();
  await user.click(within(form).getByRole("button", { name: "取消" }));
  expect(within(detail()).queryByRole("group", { name: "新建分类" })).toBeNull();
  await user.click(within(detail()).getByRole("button", { name: "新建分类" }));
  await user.keyboard("{Escape}");
  expect(within(detail()).queryByRole("group", { name: "新建分类" })).toBeNull();
});

test("每行的「⋯」把字段移到别的分类；删光一个分类的字段后它自己消失", async () => {
  const user = userEvent.setup();
  const { calls } = mount();
  await ready();
  expect(within(row("学校")).queryByLabelText("所属分类")).toBeNull();
  await user.click(within(row("学校")).getByRole("button", { name: "移动「学校」到其他分类" }));
  const menu = screen.getByRole("menu", { name: "移动「学校」到其他分类" });
  expect(within(menu).queryByRole("menuitem", { name: "移到「教育经历」" })).toBeNull();
  await user.click(within(menu).getByRole("menuitem", { name: "移到「基本信息」" }));
  await waitFor(() => expect(saves(calls)).toHaveLength(1));
  expect(saves(calls)[0].args?.groups).toEqual([
    { name: "基本信息", fields: [{ key: "姓名", value: "测试用户" }, { key: "电话", value: "13800000000" }, { key: "学校", value: "示例大学" }] },
  ]);
  await waitFor(() => expect(within(detail()).queryByRole("region", { name: "分类：教育经历" })).toBeNull());
});

test("每个分类可以单独收起、展开；没有「全部展开」", async () => {
  const user = userEvent.setup();
  mount();
  await ready();
  expect(within(detail()).queryByRole("button", { name: /全部(收起|展开)/ })).toBeNull();
  const basic = within(detail()).getByRole("region", { name: "分类：基本信息" });
  const toggle = within(basic).getByRole("button", { name: "基本信息" });
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  await user.click(toggle);
  expect(within(basic).queryByRole("group", { name: "姓名" })).toBeNull();
  expect(within(basic).getByText("2 个字段")).toBeTruthy();
  expect(within(basic).queryByRole("button", { name: /添加字段/ })).toBeNull();
  await user.click(toggle);
  expect(within(basic).getByRole("group", { name: "姓名" })).toBeTruthy();
});

test("保存失败：输入原样留着，状态行说明原因，改好后再回车可以重试", async () => {
  const user = userEvent.setup();
  let fail = true;
  const { calls } = mount((command) => {
    if (command === "save_resume_template_fields_cmd" && fail) return Object.assign(new Error("档案正忙。"), { code: "INTERNAL" });
    return undefined;
  });
  await ready();
  await setValue(user, "姓名", "失败也不丢");
  expect(await within(status()).findByText(/档案正忙。 这处修改没有保存。/)).toBeTruthy();
  expect((within(row("姓名")).getByLabelText("内容") as HTMLTextAreaElement).value).toBe("失败也不丢");
  fail = false;
  await user.type(within(row("姓名")).getByLabelText("内容"), "{Enter}");
  await waitFor(() => expect(within(row("姓名")).getByRole("button", { name: "修改「姓名」的内容" }).textContent).toBe("失败也不丢"));
  expect(saves(calls)).toHaveLength(2);
});

test("别处改过时不覆盖：换成最新内容并说明，这次修改没有保存", async () => {
  const user = userEvent.setup();
  let conflict = true;
  const { calls, setTemplate } = mount((command) => {
    if (command === "save_resume_template_fields_cmd" && conflict) {
      conflict = false;
      setTemplate({ ...original(), contentSha256: "c".repeat(64), updatedAt: "2026-10-12T00:00:00.000Z", groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "插件端改的" }] }] });
      return Object.assign(new Error("这份模板已在别处修改，请先查看最新内容再保存。"), { code: "CONFLICT" });
    }
    return undefined;
  });
  await ready();
  await setValue(user, "姓名", "我的修改");
  expect(await within(status()).findByText(/已换成最新内容。你刚才的修改没有保存，请再改一次/)).toBeTruthy();
  await waitFor(() => expect(within(row("姓名")).getByRole("button", { name: "修改「姓名」的内容" }).textContent).toBe("插件端改的"));
  expect(saves(calls)).toHaveLength(1);
  // 再改一次，起点是最新版本，保存成功。
  await setValue(user, "姓名", "再改一次");
  await waitFor(() => expect(saves(calls)).toHaveLength(2));
  expect(saves(calls)[1].args?.baseSha256).toBe("c".repeat(64));
});

test("冲突后读不到最新内容：不当成已删除，输入留着，稍后可再试", async () => {
  const user = userEvent.setup();
  let conflict = true;
  let readFails = false;
  mount((command) => {
    if (command === "save_resume_template_fields_cmd" && conflict) {
      conflict = false;
      readFails = true;
      return Object.assign(new Error("这份模板已在别处修改，请先查看最新内容再保存。"), { code: "CONFLICT" });
    }
    if (command === "get_resume_template_cmd" && readFails) {
      readFails = false;
      return Object.assign(new Error("档案正忙"), { code: "INTERNAL" });
    }
    return undefined;
  });
  await ready();
  await setValue(user, "姓名", "输入还在");
  expect(await within(status()).findByText(/暂时读不到最新内容。你的输入还在，没有保存/)).toBeTruthy();
  expect((within(row("姓名")).getByLabelText("内容") as HTMLTextAreaElement).value).toBe("输入还在");
});

test("改的时候模板在别处被删：只说已删除，不把它当成冲突", async () => {
  const user = userEvent.setup();
  mount((command) => (command === "save_resume_template_fields_cmd" ? Object.assign(new Error("gone"), { code: "NOT_FOUND" }) : undefined));
  await ready();
  await setValue(user, "姓名", "！");
  expect(await within(status()).findByText("这份模板已在别处删除，修改没有保存。")).toBeTruthy();
});

test("插件保存后：没在改的话预览直接换成最新内容；正在改时先提示，输入不动", async () => {
  const user = userEvent.setup();
  const { calls, listeners, setTemplate } = mount();
  await waitFor(() => expect(listeners.has("resume-template-changed")).toBe(true));
  await ready();
  const before = calls.filter((call) => call.command === "resume_overview_cmd").length;
  setTemplate({ ...original(), contentSha256: "d".repeat(64), updatedAt: "2026-10-12T01:00:00.000Z", groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "插件端改的" }] }] });
  overview.templates[0] = { ...overview.templates[0], updatedAt: "2026-10-12T01:00:00.000Z", fieldCount: 1 };
  listeners.get("resume-template-changed")?.({ payload: { templateId: "t1", op: "saveTemplate", source: "plugin" } });
  await waitFor(() => expect(within(detail()).getByText("插件端改的")).toBeTruthy());
  expect(calls.filter((call) => call.command === "resume_overview_cmd").length).toBe(before + 1);
  expect(within(status()).getByText(/刚在别处更新过，已显示最新内容/)).toBeTruthy();

  await user.click(within(row("姓名")).getByRole("button", { name: "修改「姓名」的内容" }));
  await user.type(within(row("姓名")).getByLabelText("内容"), "（输入中）");
  setTemplate({ ...original(), contentSha256: "e".repeat(64), updatedAt: "2026-10-12T02:00:00.000Z", groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "插件端又改了" }] }] });
  overview.templates[0] = { ...overview.templates[0], updatedAt: "2026-10-12T02:00:00.000Z" };
  listeners.get("resume-template-changed")?.({ payload: { templateId: "t1", op: "saveTemplate", source: "plugin" } });
  await waitFor(() => expect(within(status()).getByText(/你正在改的内容保存前会先核对/)).toBeTruthy());
  expect((within(row("姓名")).getByLabelText("内容") as HTMLTextAreaElement).value).toBe("插件端改的（输入中）");
});

test("视图没带内容版本时，先算出起点再保存，不会误报冲突", async () => {
  const user = userEvent.setup();
  const { calls } = mount((command, args) => {
    if (command === "get_resume_template_cmd" && args?.id === "t1") {
      const { contentSha256: _omitted, ...withoutSha } = original();
      return withoutSha;
    }
    return undefined;
  });
  await ready();
  await setValue(user, "姓名", "！");
  await waitFor(() => expect(saves(calls)).toHaveLength(1));
  expect(saves(calls)[0].args?.baseSha256).toMatch(/^[0-9a-f]{64}$/);
  // 初始版本是自己算出来的，不会被当成别处的修改，也就没有「别处更新过」的提示。
  expect(within(detail()).queryByText(/刚在别处/)).toBeNull();
});

// —— 审核（#583）后补的：撤销、切换模板、重复提交、冲突、Esc、版本判断、孤儿行 ——

test("删除后别处又改了模板：撤销条消失，撤销不会拿旧内容盖掉别处的修改", async () => {
  const user = userEvent.setup();
  const { calls, listeners, setTemplate } = mount();
  await waitFor(() => expect(listeners.has("resume-template-changed")).toBe(true));
  await ready();
  await user.click(within(row("电话")).getByRole("button", { name: "删除「电话」" }));
  await waitFor(() => expect(within(status()).getByRole("button", { name: "撤销" })).toBeTruthy());
  // 8 秒内插件把「姓名」改成了别的。
  setTemplate({
    ...original(),
    contentSha256: "d".repeat(64),
    updatedAt: "2026-10-12T05:00:00.000Z",
    groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "插件端改的" }] }, { name: "教育经历", fields: [{ key: "学校", value: "示例大学" }] }],
  });
  overview.templates[0] = { ...overview.templates[0], updatedAt: "2026-10-12T05:00:00.000Z" };
  listeners.get("resume-template-changed")?.({ payload: { templateId: "t1", op: "saveTemplate", source: "plugin" } });
  await waitFor(() => expect(within(detail()).getByText("插件端改的")).toBeTruthy());
  expect(within(status()).queryByRole("button", { name: "撤销" })).toBeNull();
  expect(within(status()).getByText(/刚在别处更新过，已显示最新内容/)).toBeTruthy();
  expect(saves(calls)).toHaveLength(1);
});

test("撤销只把被删的字段放回原来的位置", async () => {
  const user = userEvent.setup();
  const { calls } = mount();
  await ready();
  await user.click(within(row("姓名")).getByRole("button", { name: "删除「姓名」" }));
  await waitFor(() => expect(within(detail()).queryByRole("group", { name: "姓名" })).toBeNull());
  await user.click(within(status()).getByRole("button", { name: "撤销" }));
  await waitFor(() => expect(saves(calls)).toHaveLength(2));
  expect(saves(calls)[1].args?.groups).toEqual(original().groups);
});

test("删光一个分类的字段后，它里面还没写完的空白行仍然看得见", async () => {
  const user = userEvent.setup();
  mount();
  await ready();
  const edu = within(detail()).getByRole("region", { name: "分类：教育经历" });
  await user.click(within(edu).getByRole("button", { name: "在「教育经历」添加字段" }));
  await user.click(within(row("学校")).getByRole("button", { name: "删除「学校」" }));
  await waitFor(() => expect(within(detail()).queryByRole("group", { name: "学校" })).toBeNull());
  const after = within(detail()).getByRole("region", { name: "分类：教育经历" });
  expect(within(after).getByRole("group", { name: "在「教育经历」添加字段" })).toBeTruthy();
});

test("有填到一半的内容时换模板要先问：继续填写就留下，放弃并切换才换", async () => {
  const user = userEvent.setup();
  mount();
  await ready();
  const other = () => within(screen.getByRole("listitem", { name: "实习简历" })).getAllByRole("button")[0];
  // 什么都没填：直接换，不打扰。
  await user.click(other());
  await waitFor(() => expect(within(detail()).getByRole("heading", { name: "实习简历", level: 2 })).toBeTruthy());
  await user.click(within(screen.getByRole("listitem", { name: "校招简历" })).getAllByRole("button")[0]);
  await waitFor(() => expect(within(detail()).getByRole("heading", { name: "校招简历", level: 2 })).toBeTruthy());
  await ready();

  await user.click(within(detail()).getByRole("button", { name: "新建分类" }));
  await user.type(within(detail()).getByLabelText("分类名称"), "求职意向");
  await user.click(other());
  const dialog = await screen.findByRole("dialog", { name: "放弃填到一半的内容？" });
  await user.click(within(dialog).getByRole("button", { name: "继续填写" }));
  expect(within(detail()).getByRole("heading", { name: "校招简历", level: 2 })).toBeTruthy();
  expect((within(detail()).getByLabelText("分类名称") as HTMLInputElement).value).toBe("求职意向");
  await user.click(other());
  await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "放弃并切换" }));
  await waitFor(() => expect(within(detail()).getByRole("heading", { name: "实习简历", level: 2 })).toBeTruthy());
});

test("回车后马上点别处，同一行只保存一次", async () => {
  const user = userEvent.setup();
  const { calls } = mount();
  await ready();
  saveDelay = 80;
  const basic = within(detail()).getByRole("region", { name: "分类：基本信息" });
  await user.click(within(basic).getByRole("button", { name: "在「基本信息」添加字段" }));
  const form = within(basic).getByRole("group", { name: "在「基本信息」添加字段" });
  await user.type(within(form).getByLabelText("字段名称"), "邮箱");
  await user.type(within(form).getByLabelText("内容"), "a@example.test{Enter}");
  await user.click(document.body);
  await waitFor(() => expect(within(basic).getByRole("group", { name: "邮箱" })).toBeTruthy());
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(saves(calls)).toHaveLength(1);
  expect(within(basic).getAllByRole("group", { name: "邮箱" })).toHaveLength(1);
});

test("「创建分类」连点两下，只建一个分类", async () => {
  const user = userEvent.setup();
  const { calls } = mount();
  await ready();
  saveDelay = 80;
  await user.click(within(detail()).getByRole("button", { name: "新建分类" }));
  const form = within(detail()).getByRole("group", { name: "新建分类" });
  await user.type(within(form).getByLabelText("分类名称"), "求职意向");
  await user.type(within(form).getByLabelText("字段名称"), "期望城市");
  const create = within(form).getByRole("button", { name: "创建分类" });
  await user.dblClick(create);
  await waitFor(() => expect(within(detail()).getByRole("region", { name: "分类：求职意向" })).toBeTruthy());
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(saves(calls)).toHaveLength(1);
  const created = (saves(calls)[0].args?.groups as Array<{ name: string; fields: unknown[] }>).find((g) => g.name === "求职意向");
  expect(created?.fields).toHaveLength(1);
});

test("撞上别处的修改换成最新内容时，没写完的新建分类表单和空白行还在", async () => {
  const user = userEvent.setup();
  let conflict = true;
  const { setTemplate } = mount((command) => {
    if (command === "save_resume_template_fields_cmd" && conflict) {
      conflict = false;
      setTemplate({ ...original(), contentSha256: "c".repeat(64), updatedAt: "2026-10-12T00:00:00.000Z", groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "插件端改的" }] }] });
      return Object.assign(new Error("conflict"), { code: "CONFLICT" });
    }
    return undefined;
  });
  await ready();
  await user.click(within(detail()).getByRole("button", { name: "新建分类" }));
  await user.type(within(detail()).getByLabelText("分类名称"), "求职意向");
  const basic = within(detail()).getByRole("region", { name: "分类：基本信息" });
  await user.click(within(basic).getByRole("button", { name: "在「基本信息」添加字段" }));
  await user.type(within(basic).getByLabelText("内容"), "只有内容");
  await setValue(user, "姓名", "我的修改");
  expect(await within(status()).findByText(/已换成最新内容。你刚才的修改没有保存/)).toBeTruthy();
  await waitFor(() => expect(within(row("姓名")).getByRole("button", { name: "修改「姓名」的内容" }).textContent).toBe("插件端改的"));
  expect((within(detail()).getByLabelText("分类名称") as HTMLInputElement).value).toBe("求职意向");
  expect(within(detail()).getByRole("group", { name: "在「基本信息」添加字段" })).toBeTruthy();
});

test("在一行空白里按 Esc 去掉它，不会让下一行的「点别处就保存」失效", async () => {
  const user = userEvent.setup();
  const { calls } = mount();
  await ready();
  const basic = within(detail()).getByRole("region", { name: "分类：基本信息" });
  const bar = () => within(basic).getByRole("button", { name: "在「基本信息」添加字段" });
  await user.click(bar());
  await user.click(bar());
  const rows = () => within(basic).getAllByRole("group", { name: "在「基本信息」添加字段" });
  await user.click(within(rows()[0]).getByLabelText("字段名称"));
  await user.keyboard("{Escape}");
  expect(rows()).toHaveLength(1);
  await user.type(within(rows()[0]).getByLabelText("字段名称"), "邮箱");
  await user.click(document.body);
  await waitFor(() => expect(saves(calls)).toHaveLength(1));
});

test("自己保存之前发出的旧读取晚到，不会把界面顶回旧内容；别处的新版本才会刷新", async () => {
  const user = userEvent.setup();
  const { listeners, setTemplate } = mount();
  await waitFor(() => expect(listeners.has("resume-template-changed")).toBeTruthy());
  await ready();
  await setValue(user, "姓名", "新名字");
  await waitFor(() => expect(within(row("姓名")).getByRole("button", { name: "修改「姓名」的内容" }).textContent).toBe("新名字"));
  // 一个旧版本（初始版本）的读取晚到：更新时间不比已知的新，不理会。
  setTemplate({ ...original(), updatedAt: "2026-10-01T00:00:00.000Z" });
  overview.templates[0] = { ...overview.templates[0], updatedAt: "2026-10-12T00:00:05.000Z" };
  listeners.get("resume-template-changed")?.({ payload: { templateId: "t1", op: "saveTemplate", source: "plugin" } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(within(row("姓名")).getByRole("button", { name: "修改「姓名」的内容" }).textContent).toBe("新名字");
});

// —— 第二轮审核（#583）后补的 ——

test("只是点开了字段、什么都没改时，别处的更新照样显示；退出后也会补上之前错过的", async () => {
  const user = userEvent.setup();
  const { listeners, setTemplate } = mount();
  await waitFor(() => expect(listeners.has("resume-template-changed")).toBe(true));
  await ready();
  await user.click(within(row("姓名")).getByRole("button", { name: "修改「姓名」的内容" }));
  setTemplate({ ...original(), contentSha256: "d".repeat(64), updatedAt: "2026-10-12T05:00:00.000Z", groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "插件端改的" }] }] });
  overview.templates[0] = { ...overview.templates[0], updatedAt: "2026-10-12T05:00:00.000Z" };
  listeners.get("resume-template-changed")?.({ payload: { templateId: "t1", op: "saveTemplate", source: "plugin" } });
  // 没改过一个字，不算「正在改」：直接换成最新内容，输入框也收起。
  await waitFor(() => expect(within(row("姓名")).getByRole("button", { name: "修改「姓名」的内容" }).textContent).toBe("插件端改的"));
  expect(within(status()).getByText(/已显示最新内容/)).toBeTruthy();

  // 真的输入了东西时先不换；输入框退出（没有未写入的内容了）后补上。
  await user.click(within(row("姓名")).getByRole("button", { name: "修改「姓名」的内容" }));
  await user.type(within(row("姓名")).getByLabelText("内容"), "（草稿）");
  setTemplate({ ...original(), contentSha256: "e".repeat(64), updatedAt: "2026-10-12T06:00:00.000Z", groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "插件端又改了" }] }] });
  overview.templates[0] = { ...overview.templates[0], updatedAt: "2026-10-12T06:00:00.000Z" };
  listeners.get("resume-template-changed")?.({ payload: { templateId: "t1", op: "saveTemplate", source: "plugin" } });
  await waitFor(() => expect(within(status()).getByText(/保存前会先核对/)).toBeTruthy());
  await user.keyboard("{Escape}");
  await waitFor(() => expect(within(row("姓名")).getByRole("button", { name: "修改「姓名」的内容" }).textContent).toBe("插件端又改了"));
});

test("连着删两个字段，可以从后往前一个一个撤销", async () => {
  const user = userEvent.setup();
  const { calls } = mount();
  await ready();
  await user.click(within(row("电话")).getByRole("button", { name: "删除「电话」" }));
  await waitFor(() => expect(within(detail()).queryByRole("group", { name: "电话" })).toBeNull());
  await user.click(within(row("姓名")).getByRole("button", { name: "删除「姓名」" }));
  await waitFor(() => expect(within(detail()).queryByRole("group", { name: "姓名" })).toBeNull());
  expect(within(status()).getByText(/已删除「姓名」.*还可撤销 1 项/)).toBeTruthy();
  await user.click(within(status()).getByRole("button", { name: "撤销" }));
  await waitFor(() => expect(within(detail()).getByRole("group", { name: "姓名" })).toBeTruthy());
  expect(within(detail()).queryByRole("group", { name: "电话" })).toBeNull();
  expect(within(status()).getByText(/已删除「电话」/)).toBeTruthy();
  await user.click(within(status()).getByRole("button", { name: "撤销" }));
  await waitFor(() => expect(within(detail()).getByRole("group", { name: "电话" })).toBeTruthy());
  expect(saves(calls)[saves(calls).length - 1].args?.groups).toEqual(original().groups);
});

test("删除后做了一个被拦住的操作，撤销还在", async () => {
  const user = userEvent.setup();
  const { calls } = mount();
  await ready();
  await user.click(within(row("电话")).getByRole("button", { name: "删除「电话」" }));
  await waitFor(() => expect(within(status()).getByRole("button", { name: "撤销" })).toBeTruthy());
  await user.click(within(row("姓名")).getByRole("button", { name: "修改字段名「姓名」" }));
  await user.clear(within(row("姓名")).getByLabelText("字段名称"));
  await user.keyboard("{Enter}");
  expect(await within(row("姓名")).findByText("字段名称不能为空。")).toBeTruthy();
  expect(saves(calls)).toHaveLength(1);
  expect(within(status()).getByRole("button", { name: "撤销" })).toBeTruthy();
});

test("删光一个分类唯一的字段后撤销：字段和分类一起回来", async () => {
  const user = userEvent.setup();
  mount();
  await ready();
  await user.click(within(row("学校")).getByRole("button", { name: "删除「学校」" }));
  await waitFor(() => expect(within(detail()).queryByRole("region", { name: "分类：教育经历" })).toBeNull());
  await user.click(within(status()).getByRole("button", { name: "撤销" }));
  const edu = await within(detail()).findByRole("region", { name: "分类：教育经历" });
  expect(within(edu).getByRole("group", { name: "学校" })).toBeTruthy();
});

test("保存还没返回时，输入框先只读，保存的就是看到的内容", async () => {
  const user = userEvent.setup();
  const { calls } = mount();
  await ready();
  saveDelay = 150;
  const basic = within(detail()).getByRole("region", { name: "分类：基本信息" });
  await user.click(within(basic).getByRole("button", { name: "在「基本信息」添加字段" }));
  const form = within(basic).getByRole("group", { name: "在「基本信息」添加字段" });
  await user.type(within(form).getByLabelText("字段名称"), "邮箱");
  await user.type(within(form).getByLabelText("内容"), "a@example.test{Enter}");
  await waitFor(() => expect((within(form).getByLabelText("内容") as HTMLTextAreaElement).readOnly).toBe(true));
  expect((within(form).getByLabelText("字段名称") as HTMLInputElement).readOnly).toBe(true);
  await waitFor(() => expect(saves(calls)).toHaveLength(1));
  // 等这一处完整保存完（行变成正式字段，并补好下一行空白），再测下一段。
  await waitFor(() => expect(within(basic).getByRole("group", { name: "邮箱" })).toBeTruthy());
  await user.keyboard("{Escape}");
  saveDelay = 150;

  // 改已有字段同理：回车后输入框只读，直到保存完。
  await user.click(within(row("姓名")).getByRole("button", { name: "修改「姓名」的内容" }));
  const box = within(row("姓名")).getByLabelText("内容") as HTMLTextAreaElement;
  await user.clear(box);
  await user.type(box, "新名字{Enter}");
  await waitFor(() => expect(box.readOnly).toBe(true));
  await waitFor(() => expect(within(row("姓名")).getByRole("button", { name: "修改「姓名」的内容" }).textContent).toBe("新名字"));
});

test("「创建分类」两次点击来得比页面刷新还快，也只建一份", async () => {
  const user = userEvent.setup();
  const { calls } = mount();
  await ready();
  saveDelay = 80;
  await user.click(within(detail()).getByRole("button", { name: "新建分类" }));
  const form = within(detail()).getByRole("group", { name: "新建分类" });
  await user.type(within(form).getByLabelText("分类名称"), "求职意向");
  await user.type(within(form).getByLabelText("字段名称"), "期望城市");
  const create = within(form).getByRole("button", { name: "创建分类" });
  // 同步连点两次，中间没有页面刷新。
  fireEvent.click(create);
  fireEvent.click(create);
  await waitFor(() => expect(within(detail()).getByRole("region", { name: "分类：求职意向" })).toBeTruthy());
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(saves(calls)).toHaveLength(1);
});

// —— 第三轮审核（#583）后补的 ——

test("别处把模板改回自己见过的旧内容（更新时间更新）：照样刷新，不当成旧读取", async () => {
  const user = userEvent.setup();
  const { listeners, setTemplate } = mount();
  await waitFor(() => expect(listeners.has("resume-template-changed")).toBe(true));
  await ready();
  await setValue(user, "姓名", "新名字");
  await waitFor(() => expect(within(row("姓名")).getByRole("button", { name: "修改「姓名」的内容" }).textContent).toBe("新名字"));
  // 插件把模板改回最初那一版（内容和版本号都和一开始一样），更新时间是现在。
  setTemplate({ ...original(), updatedAt: "2026-10-12T09:00:00.000Z" });
  overview.templates[0] = { ...overview.templates[0], updatedAt: "2026-10-12T09:00:00.000Z" };
  listeners.get("resume-template-changed")?.({ payload: { templateId: "t1", op: "saveTemplate", source: "plugin" } });
  await waitFor(() => expect(within(row("姓名")).getByRole("button", { name: "修改「姓名」的内容" }).textContent).toBe("测试用户"));
});

test("改了内容保存还没返回就点删除：撤销恢复的是删除前最后保存的内容", async () => {
  const user = userEvent.setup();
  const { calls } = mount();
  await ready();
  saveDelay = 100;
  await user.click(within(row("电话")).getByRole("button", { name: "修改「电话」的内容" }));
  const box = within(row("电话")).getByLabelText("内容");
  await user.clear(box);
  await user.type(box, "13700000000{Enter}");
  await user.click(within(row("电话")).getByRole("button", { name: "删除「电话」" }));
  await waitFor(() => expect(within(detail()).queryByRole("group", { name: "电话" })).toBeNull());
  await user.click(within(status()).getByRole("button", { name: "撤销" }));
  await waitFor(() => expect(within(row("电话")).getByRole("button", { name: "修改「电话」的内容" }).textContent).toBe("13700000000"));
  const last = saves(calls)[saves(calls).length - 1].args?.groups as Array<{ fields: Array<{ key: string; value: string }> }>;
  expect(last[0].fields.find((f) => f.key === "电话")?.value).toBe("13700000000");
});

test("撤销两次点击来得比保存还快，同一个字段只加回一个", async () => {
  const user = userEvent.setup();
  const { calls } = mount();
  await ready();
  await user.click(within(row("电话")).getByRole("button", { name: "删除「电话」" }));
  const undo = await within(status()).findByRole("button", { name: "撤销" });
  saveDelay = 80;
  fireEvent.click(undo);
  fireEvent.click(undo);
  await waitFor(() => expect(within(detail()).getByRole("group", { name: "电话" })).toBeTruthy());
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(saves(calls)).toHaveLength(2);
  expect(within(detail()).getAllByRole("group", { name: "电话" })).toHaveLength(1);
});

test("新建分类正在保存时，「取消」、去掉行、Esc 都不能再取消它", async () => {
  const user = userEvent.setup();
  const { calls } = mount();
  await ready();
  await user.click(within(detail()).getByRole("button", { name: "新建分类" }));
  const form = within(detail()).getByRole("group", { name: "新建分类" });
  await user.type(within(form).getByLabelText("分类名称"), "求职意向");
  await user.type(within(form).getByLabelText("字段名称"), "期望城市");
  await user.click(within(form).getByRole("button", { name: "再添加一个字段" }));
  saveDelay = 120;
  await user.click(within(form).getByRole("button", { name: "创建分类" }));
  await waitFor(() => expect((within(form).getByRole("button", { name: "取消" }) as HTMLButtonElement).disabled).toBe(true));
  expect((within(form).getByRole("button", { name: "去掉新字段 2" }) as HTMLButtonElement).disabled).toBe(true);
  await user.keyboard("{Escape}");
  expect(within(detail()).getByRole("group", { name: "新建分类" })).toBeTruthy();
  await waitFor(() => expect(within(detail()).getByRole("region", { name: "分类：求职意向" })).toBeTruthy());
  expect(saves(calls)).toHaveLength(1);
});

test("添加字段的行正在保存时，不能再去掉它", async () => {
  const user = userEvent.setup();
  mount();
  await ready();
  saveDelay = 120;
  const basic = within(detail()).getByRole("region", { name: "分类：基本信息" });
  await user.click(within(basic).getByRole("button", { name: "在「基本信息」添加字段" }));
  const form = within(basic).getByRole("group", { name: "在「基本信息」添加字段" });
  await user.type(within(form).getByLabelText("字段名称"), "邮箱");
  await user.type(within(form).getByLabelText("内容"), "a@example.test{Enter}");
  await waitFor(() => expect((within(form).getByRole("button", { name: "去掉这一行" }) as HTMLButtonElement).disabled).toBe(true));
  await user.keyboard("{Escape}");
  expect(within(basic).getAllByRole("group", { name: "在「基本信息」添加字段" }).length).toBeGreaterThan(0);
  await waitFor(() => expect(within(basic).getByRole("group", { name: "邮箱" })).toBeTruthy());
});

test("有撤销条时，被拦下的操作也能看到原因，撤销仍在", async () => {
  const user = userEvent.setup();
  mount((command, args) =>
    command === "get_resume_template_cmd" && args?.id === "t1"
      ? { ...original(), groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "测试用户" }, { key: "电话", value: "13800000000" }] }] }
      : undefined,
  );
  await waitFor(() => expect(within(detail()).getByText("测试用户")).toBeTruthy());
  await user.click(within(row("电话")).getByRole("button", { name: "删除「电话」" }));
  await waitFor(() => expect(within(status()).getByRole("button", { name: "撤销" })).toBeTruthy());
  await user.click(within(row("姓名")).getByRole("button", { name: "删除「姓名」" }));
  expect(await within(status()).findByText(/模板至少要保留一个字段/)).toBeTruthy();
  expect(within(status()).getByRole("button", { name: "撤销" })).toBeTruthy();
});

test("在已被清空的分类里，没写完的空白行填好后照样保存，分类一起建出来", async () => {
  const user = userEvent.setup();
  const { calls } = mount();
  await ready();
  const edu = within(detail()).getByRole("region", { name: "分类：教育经历" });
  await user.click(within(edu).getByRole("button", { name: "在「教育经历」添加字段" }));
  await user.click(within(row("学校")).getByRole("button", { name: "删除「学校」" }));
  await waitFor(() => expect(within(detail()).queryByRole("group", { name: "学校" })).toBeNull());
  const pending = within(detail()).getByRole("group", { name: "在「教育经历」添加字段" });
  await user.type(within(pending).getByLabelText("字段名称"), "专业");
  await user.type(within(pending).getByLabelText("内容"), "示例专业{Enter}");
  await waitFor(() => expect(saves(calls)).toHaveLength(2));
  expect(saves(calls)[1].args?.groups).toEqual([
    { name: "基本信息", fields: [{ key: "姓名", value: "测试用户" }, { key: "电话", value: "13800000000" }] },
    { name: "教育经历", fields: [{ key: "专业", value: "示例专业" }] },
  ]);
});

test("填到一半时点「导入 Excel」，先问是否放弃；没填东西时直接导入", async () => {
  const user = userEvent.setup();
  mount();
  await ready();
  await user.click(within(detail()).getByRole("button", { name: "新建分类" }));
  await user.type(within(detail()).getByLabelText("分类名称"), "求职意向");
  await user.click(screen.getByRole("button", { name: "导入 Excel" }));
  const dialog = await screen.findByRole("dialog", { name: "放弃填到一半的内容？" });
  expect(within(dialog).getByText(/导入完会自动切到新模板/)).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "放弃并导入" })).toBeTruthy();
  await user.click(within(dialog).getByRole("button", { name: "继续填写" }));
  expect((within(detail()).getByLabelText("分类名称") as HTMLInputElement).value).toBe("求职意向");
});

test("AI 解析出了新模板、要自动选中它时，如果正有填到一半的内容，不替人切过去，只提示", async () => {
  const user = userEvent.setup();
  const { signal } = mount();
  await ready();
  await user.click(within(detail()).getByRole("button", { name: "新建分类" }));
  await user.type(within(detail()).getByLabelText("分类名称"), "求职意向");
  signal(1, "t2");
  expect(await screen.findByText(/已生成新模板，在左边列表里点它查看/)).toBeTruthy();
  expect(within(detail()).getByRole("heading", { name: "校招简历", level: 2 })).toBeTruthy();
  expect((within(detail()).getByLabelText("分类名称") as HTMLInputElement).value).toBe("求职意向");
  // 没有填到一半的内容时，照常选中新模板。
  await user.click(within(detail()).getByRole("button", { name: "取消" }));
  signal(2, "t2");
  await waitFor(() => expect(within(detail()).getByRole("heading", { name: "实习简历", level: 2 })).toBeTruthy());
});

test("回车保存还没返回时你已经去改别的字段：不会把光标抢回新开的空白行", async () => {
  const user = userEvent.setup();
  mount();
  await ready();
  saveDelay = 120;
  const basic = within(detail()).getByRole("region", { name: "分类：基本信息" });
  await user.click(within(basic).getByRole("button", { name: "在「基本信息」添加字段" }));
  const form = within(basic).getByRole("group", { name: "在「基本信息」添加字段" });
  await user.type(within(form).getByLabelText("字段名称"), "邮箱");
  await user.type(within(form).getByLabelText("内容"), "a@example.test{Enter}");
  // 保存还没返回，去点另一个字段开始改。
  await user.click(within(row("姓名")).getByRole("button", { name: "修改「姓名」的内容" }));
  const box = within(row("姓名")).getByLabelText("内容") as HTMLTextAreaElement;
  await waitFor(() => expect(within(basic).getByRole("group", { name: "邮箱" })).toBeTruthy());
  await new Promise((resolve) => setTimeout(resolve, 50));
  // 光标仍在正在改的那个字段上，没有多出抢焦点的空白行。
  expect(document.activeElement).toBe(box);
  expect(within(basic).queryByRole("group", { name: "在「基本信息」添加字段" })).toBeNull();
});

test("填到一半时点「重新导入」「删除」，也先确认是否放弃", async () => {
  const user = userEvent.setup();
  mount();
  await ready();
  await user.click(within(detail()).getByRole("button", { name: "新建分类" }));
  await user.type(within(detail()).getByLabelText("分类名称"), "求职意向");
  for (const [item, verb, next] of [["重新导入", "放弃并重新导入", "覆盖这份模板？"], ["删除", "放弃并删除", "删除「校招简历」？"]] as const) {
    await user.click(within(detail()).getByRole("button", { name: "更多操作" }));
    await user.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: item }));
    const ask = await screen.findByRole("dialog", { name: "放弃填到一半的内容？" });
    // 先选「继续填写」：什么都不发生，表单还在。
    await user.click(within(ask).getByRole("button", { name: "继续填写" }));
    expect((within(detail()).getByLabelText("分类名称") as HTMLInputElement).value).toBe("求职意向");
    await user.click(within(detail()).getByRole("button", { name: "更多操作" }));
    await user.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: item }));
    await user.click(within(await screen.findByRole("dialog", { name: "放弃填到一半的内容？" })).getByRole("button", { name: verb }));
    // 确认放弃后，才进入原来的确认。
    const original = await screen.findByRole("dialog", { name: next });
    await user.click(within(original).getByRole("button", { name: "取消" }));
  }
});
