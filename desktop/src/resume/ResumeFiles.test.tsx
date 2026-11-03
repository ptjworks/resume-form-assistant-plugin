import { expect, test } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Invoke, ResumeFileKind, ResumeFileView } from "../api.ts";
import { InvokeProvider } from "../react/invoke.tsx";
import { ResumeFiles } from "./ResumeFiles.tsx";
import type { FilePickers } from "./TemplateList.tsx";

const TEMPLATE = { id: "77777777-7777-4777-8777-777777777701", name: "互联网校招", fieldCount: 3 };

function file(id: string, kind: ResumeFileKind, name: string, mime: string, extra: Partial<ResumeFileView> = {}): ResumeFileView {
  return {
    id, kind, name, label: "", mime, byteSize: 1536, sha256: id.padEnd(64, "0").slice(0, 64), isDefault: false,
    templateIds: [], createdAt: "2026-11-03T08:00:00Z", updatedAt: "2026-11-03T08:00:00Z", ...extra,
  };
}

function mount(
  handler: (command: string, args?: Record<string, unknown>) => unknown,
  pick: (kind: ResumeFileKind) => string | null = () => null,
) {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invoke = (async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command === "resume_overview_cmd") return { templates: [TEMPLATE], activeTemplateId: TEMPLATE.id };
    const result = handler(command, args);
    if (result instanceof Error) throw result;
    // 桌面回的是「能用的文件 + 读不出来的记录」；用例里只给文件时补上空的后者。
    return Array.isArray(result) ? { files: result, damaged: [] } : result;
  }) as Invoke;
  const picked: ResumeFileKind[] = [];
  const pickers: FilePickers = {
    open: async () => null,
    save: async () => null,
    openResumeFile: async (kind) => {
      picked.push(kind);
      return pick(kind);
    },
  };
  render(
    <InvokeProvider invoke={invoke}>
      <ResumeFiles pickers={pickers} active />
    </InvokeProvider>,
  );
  return { calls, picked };
}

test("按简历附件、证件照、其他材料分组，照片有缩略图，只有 PDF 和图片能打开", async () => {
  const list = [
    file("a1", "resume", "测试用户_简历.pdf", "application/pdf", { isDefault: true, templateIds: [TEMPLATE.id] }),
    file("a2", "resume", "英文简历.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", { label: "英文" }),
    file("b1", "photo", "证件照.jpg", "image/jpeg", { isDefault: true }),
    file("c1", "transcript", "成绩单.pdf", "application/pdf"),
  ];
  const { calls } = mount((command) => {
    if (command === "list_resume_files_cmd") return list;
    if (command === "preview_resume_file_cmd") return "data:image/jpeg;base64,AAAA";
    return null;
  });
  const resumes = await screen.findByRole("region", { name: "简历附件" });
  expect(within(resumes).getByText("测试用户_简历.pdf")).toBeTruthy();
  expect(within(resumes).getByText("默认")).toBeTruthy();
  expect(within(resumes).getByText("PDF · 1.5 KB · 用于：互联网校招")).toBeTruthy();
  expect(within(resumes).getByText("DOCX · 1.5 KB · 英文 · 用于所有模板")).toBeTruthy();
  // Word 文件不经桌面打开。
  expect(within(resumes).getAllByRole("button", { name: "打开" })).toHaveLength(1);
  const photos = screen.getByRole("region", { name: "证件照" });
  await waitFor(() => expect(photos.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,AAAA"));
  expect(calls.filter((c) => c.command === "preview_resume_file_cmd").map((c) => c.args)).toEqual([{ id: "b1" }]);
  const others = screen.getByRole("region", { name: "其他材料" });
  expect(within(others).getByText("成绩单 · PDF · 1.5 KB · 用于所有模板")).toBeTruthy();
});

test("添加时按种类选文件，把路径交给桌面；取消选择什么都不做，报错照实显示", async () => {
  let list: ResumeFileView[] = [];
  let answer: string | null = "C:\\材料\\测试用户_简历.pdf";
  const { calls, picked } = mount((command, args) => {
    if (command === "list_resume_files_cmd") return list;
    if (command === "add_resume_file_cmd") {
      if (String(args?.path).endsWith(".png")) return new Error("简历附件只收 PDF、DOC、DOCX，这个文件是PNG 图片。");
      list = [file("a1", "resume", "测试用户_简历.pdf", "application/pdf", { isDefault: true })];
      return list;
    }
    return null;
  }, () => answer);
  const resumes = await screen.findByRole("region", { name: "简历附件" });
  expect(within(resumes).getByText("还没有简历附件。")).toBeTruthy();
  await userEvent.click(within(resumes).getByRole("button", { name: "添加简历附件" }));
  expect(await within(resumes).findByText("测试用户_简历.pdf")).toBeTruthy();
  expect(picked).toEqual(["resume"]);
  expect(calls.find((c) => c.command === "add_resume_file_cmd")?.args).toEqual({ kind: "resume", path: "C:\\材料\\测试用户_简历.pdf" });
  expect(screen.getByRole("status").textContent).toBe("已添加简历附件。");

  answer = null;
  await userEvent.click(screen.getByRole("button", { name: "添加证件照" }));
  expect(calls.filter((c) => c.command === "add_resume_file_cmd")).toHaveLength(1);

  answer = "C:\\材料\\照片.png";
  await userEvent.click(within(resumes).getByRole("button", { name: "添加简历附件" }));
  expect(await screen.findByText("简历附件只收 PDF、DOC、DOCX，这个文件是PNG 图片。")).toBeTruthy();
  const others = screen.getByRole("region", { name: "其他材料" });
  await userEvent.click(within(others).getByRole("button", { name: "添加成绩单" }));
  expect(picked.at(-1)).toBe("transcript");
});

test("编辑文件名、说明、默认和模板，一次保存", async () => {
  let list = [file("a1", "resume", "简历.pdf", "application/pdf"), file("a2", "resume", "英文简历.pdf", "application/pdf", { isDefault: true })];
  const { calls } = mount((command, args) => {
    if (command === "list_resume_files_cmd") return list;
    if (command === "update_resume_file_cmd") {
      const patch = args?.patch as { name: string; label: string; isDefault: boolean; templateIds: string[] };
      list = list.map((f) => (f.id === args?.id ? { ...f, ...patch } : { ...f, isDefault: patch.isDefault ? false : f.isDefault }));
      return list;
    }
    return null;
  });
  const resumes = await screen.findByRole("region", { name: "简历附件" });
  const row = within(resumes).getByText("简历.pdf").closest("li")!;
  await userEvent.click(within(row as HTMLElement).getByRole("button", { name: "编辑" }));
  const dialog = await screen.findByRole("dialog");
  const name = within(dialog).getByLabelText("文件名");
  await userEvent.clear(name);
  await userEvent.type(name, "测试用户-简历.pdf");
  await userEvent.type(within(dialog).getByLabelText("说明"), "中文");
  await userEvent.click(within(dialog).getByLabelText("设为这一类的默认文件"));
  await userEvent.click(within(dialog).getByLabelText("互联网校招"));
  await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(calls.find((c) => c.command === "update_resume_file_cmd")?.args).toEqual({
    id: "a1",
    patch: { name: "测试用户-简历.pdf", label: "中文", isDefault: true, templateIds: [TEMPLATE.id] },
  });
  expect(within(resumes).getByText("测试用户-简历.pdf").closest("li")?.textContent).toContain("默认");
});

test("绑定的模板删掉了不当成所有模板：标「模板已删除」，用户取消了才是所有模板", async () => {
  const gone = "77777777-7777-4777-8777-777777777799";
  let list = [
    file("a1", "resume", "简历.pdf", "application/pdf", { isDefault: true, templateIds: [gone] }),
    file("a2", "resume", "英文简历.pdf", "application/pdf", { templateIds: [TEMPLATE.id, gone] }),
  ];
  const { calls } = mount((command, args) => {
    if (command === "list_resume_files_cmd") return list;
    if (command === "update_resume_file_cmd") {
      const patch = args?.patch as { templateIds: string[] };
      list = list.map((f) => (f.id === args?.id ? { ...f, ...patch } : f));
      return list;
    }
    return null;
  });
  const resumes = await screen.findByRole("region", { name: "简历附件" });
  expect(within(resumes).getByText("PDF · 1.5 KB · 模板已删除，暂不使用")).toBeTruthy();
  expect(within(resumes).getByText("PDF · 1.5 KB · 用于：互联网校招、模板已删除")).toBeTruthy();
  expect(within(resumes).queryByText(/用于所有模板/)).toBeNull();

  // 只改说明：已删除的模板照样带着，不变成空的。
  const row = within(resumes).getByText("简历.pdf").closest("li")! as HTMLElement;
  await userEvent.click(within(row).getByRole("button", { name: "编辑" }));
  let dialog = await screen.findByRole("dialog");
  expect((within(dialog).getByLabelText("模板已删除") as HTMLInputElement).checked).toBe(true);
  await userEvent.type(within(dialog).getByLabelText("说明"), "中文");
  await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(calls.filter((c) => c.command === "update_resume_file_cmd").at(-1)?.args).toMatchObject({ id: "a1", patch: { templateIds: [gone] } });

  // 用户自己取消它，才是所有模板。
  await userEvent.click(within(row).getByRole("button", { name: "编辑" }));
  dialog = await screen.findByRole("dialog");
  await userEvent.click(within(dialog).getByLabelText("模板已删除"));
  await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(calls.filter((c) => c.command === "update_resume_file_cmd").at(-1)?.args).toMatchObject({ id: "a1", patch: { templateIds: [] } });
  expect(within(row).getByText(/用于所有模板/)).toBeTruthy();
});

test("删除要先确认，替换按原来的种类选文件", async () => {
  let list = [file("b1", "photo", "证件照.jpg", "image/jpeg", { isDefault: true })];
  const { calls, picked } = mount((command, args) => {
    if (command === "list_resume_files_cmd") return list;
    if (command === "preview_resume_file_cmd") return null;
    if (command === "replace_resume_file_cmd") return list;
    if (command === "delete_resume_file_cmd") {
      list = list.filter((f) => f.id !== args?.id);
      return list;
    }
    return null;
  }, () => "C:\\材料\\新照片.png");
  const photos = await screen.findByRole("region", { name: "证件照" });
  await userEvent.click(within(photos).getByRole("button", { name: "替换" }));
  expect(picked).toEqual(["photo"]);
  expect(calls.find((c) => c.command === "replace_resume_file_cmd")?.args).toEqual({ id: "b1", path: "C:\\材料\\新照片.png" });
  await userEvent.click(within(photos).getByRole("button", { name: "删除" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain("「证件照.jpg」会从桌面档案里删掉");
  expect(calls.some((c) => c.command === "delete_resume_file_cmd")).toBe(false);
  await userEvent.click(within(dialog).getByRole("button", { name: "删除" }));
  expect(await within(photos).findByText("还没有证件照。")).toBeTruthy();
});

test("保存或删除没成功时对话框留着，填的内容还在，原因写在对话框里", async () => {
  const list = [file("a1", "resume", "简历.pdf", "application/pdf", { isDefault: true })];
  const { calls } = mount((command) => {
    if (command === "list_resume_files_cmd") return list;
    if (command === "update_resume_file_cmd") return new Error("文件内容是PDF，文件名要以 .pdf 结尾。");
    if (command === "delete_resume_file_cmd") return new Error("桌面暂时无法删除，请重试。");
    return null;
  });
  const resumes = await screen.findByRole("region", { name: "简历附件" });
  await userEvent.click(within(resumes).getByRole("button", { name: "编辑" }));
  let dialog = await screen.findByRole("dialog");
  const name = within(dialog).getByLabelText("文件名");
  await userEvent.clear(name);
  await userEvent.type(name, "简历.docx");
  await userEvent.type(within(dialog).getByLabelText("说明"), "中文");
  await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  expect(await within(dialog).findByRole("alert")).toHaveProperty("textContent", "文件内容是PDF，文件名要以 .pdf 结尾。");
  expect(screen.getByRole("dialog")).toBe(dialog);
  expect((within(dialog).getByLabelText("文件名") as HTMLInputElement).value).toBe("简历.docx");
  expect((within(dialog).getByLabelText("说明") as HTMLInputElement).value).toBe("中文");
  await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  // 再打开时不带着上一次的报错。
  await userEvent.click(within(resumes).getByRole("button", { name: "删除" }));
  dialog = await screen.findByRole("dialog");
  expect(within(dialog).queryByRole("alert")).toBeNull();
  await userEvent.click(within(dialog).getByRole("button", { name: "删除" }));
  expect(await within(dialog).findByRole("alert")).toHaveProperty("textContent", "桌面暂时无法删除，请重试。");
  expect(screen.getByRole("dialog")).toBe(dialog);
  expect(within(resumes).getByText("简历.pdf")).toBeTruthy();
  expect(calls.filter((c) => c.command === "delete_resume_file_cmd")).toHaveLength(1);
});

test("读不出来的记录单独列出，可以删掉", async () => {
  let listing = {
    files: [file("a1", "resume", "简历.pdf", "application/pdf", { isDefault: true })],
    damaged: [{ id: "x1", name: "旧简历.pdf", reason: "存储位置不对" }],
  };
  const { calls } = mount((command, args) => {
    if (command === "list_resume_files_cmd") return listing;
    if (command === "delete_resume_file_cmd") {
      listing = { ...listing, damaged: listing.damaged.filter((d) => d.id !== args?.id) };
      return listing;
    }
    return null;
  });
  const broken = await screen.findByRole("region", { name: "读不出来的记录" });
  expect(within(broken).getByText("有 1 个附件的记录读不出来，不会拿去上传。可以删掉这些记录。")).toBeTruthy();
  expect(within(broken).getByText("旧简历.pdf")).toBeTruthy();
  expect(within(broken).getByText("存储位置不对")).toBeTruthy();
  // 能用的文件照常列出。
  expect(within(screen.getByRole("region", { name: "简历附件" })).getByText("简历.pdf")).toBeTruthy();
  await userEvent.click(within(broken).getByRole("button", { name: "删除记录" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain("删掉后，它在档案里留下的那份文件一起清掉，档案以外的文件不动");
  await userEvent.click(within(dialog).getByRole("button", { name: "删除" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "读不出来的记录" })).toBeNull());
  expect(calls.find((c) => c.command === "delete_resume_file_cmd")?.args).toEqual({ id: "x1" });
  expect(screen.getByRole("status").textContent).toBe("已删除「旧简历.pdf」这条读不出来的记录。");
});

test("没有连上桌面程序时只说明", () => {
  render(
    <InvokeProvider invoke={null}>
      <ResumeFiles pickers={null} active />
    </InvokeProvider>,
  );
  expect(screen.getByText("没有连上桌面程序，附件要在桌面程序里管理。")).toBeTruthy();
});
