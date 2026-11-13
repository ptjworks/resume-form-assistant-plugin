import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Invoke } from "../api.ts";
import { mountNotes } from "./view.ts";

const { recognizeImage } = vi.hoisted(() => ({ recognizeImage: vi.fn<(image: string) => Promise<string>>() }));
vi.mock("./ocr.ts", () => ({ recognizeImage }));

const source = { id: "source", name: "复盘", recycled: false };
const target = { id: "target", name: "下一轮", recycled: false };
const file = { id: "image", name: "截图.png", mime: "image/png", base64: "AA==" };

beforeEach(() => {
  localStorage.clear();
  recognizeImage.mockReset();
});

afterEach(() => { document.body.replaceChildren(); });

function button(label: string, parent: ParentNode = document) {
  const found = [...parent.querySelectorAll("button")].find(node => node.textContent === label);
  expect(found).toBeDefined();
  return found!;
}

test("folder application results are visible, and only an explicit selection is saved", async () => {
  const applications = [
    { id: "available", company: "示例科技", title: "工程师" },
    { id: "linked", company: "另一家公司", title: "设计师" }
  ];
  const invoke = vi.fn<Invoke>().mockImplementation(async <T,>(command: string, args?: Record<string, unknown>) => {
    if (command === "note_index_cmd") return {
      epoch: "archive", folders: [{ ...source, applicationId: "linked" }], notes: []
    } as T;
    if (command === "list_applications_cmd") {
      const { query } = args?.args as { query: string };
      const items = applications.filter(app => app.company.includes(query));
      return { items, total: items.length } as T;
    }
    if (command === "change_note_cmd") return "created" as T;
    throw new Error(`Unexpected command ${command}`);
  });
  const root = document.createElement("div");
  document.body.append(root);
  await mountNotes(root, invoke as Invoke, () => {}).activate();
  root.querySelector<HTMLButtonElement>('[aria-label="新建文件夹"]')!.click();
  const dialog = await vi.waitFor(() => {
    const result = document.querySelector("dialog");
    expect(result).not.toBeNull();
    return result!;
  });
  const search = dialog.querySelector<HTMLInputElement>('input[type="search"]')!;
  const results = dialog.querySelector(".notes-application-results")!;
  const status = dialog.querySelector('[role="status"]')!;
  const query = (value: string) => {
    search.value = value;
    search.dispatchEvent(new Event("input"));
  };
  query("另一家");
  await vi.waitFor(() => expect(status.textContent).toBe("没有其他可关联的投递记录。"));
  expect(results.childElementCount).toBe(0);
  query("无结果");
  await vi.waitFor(() => expect(status.textContent).toBe("没有找到匹配的投递记录。"));
  query("示例");
  const match = await vi.waitFor(() => {
    const result = results.querySelector("button");
    expect(result?.textContent).toContain("示例科技");
    return result!;
  });
  search.focus();
  search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(match);
  expect(dialog.querySelector(".notes-application-selection")?.hasAttribute("hidden")).toBe(true);
  match.click();
  const selection = dialog.querySelector(".notes-application-selection")!;
  expect(selection.textContent).toContain("示例科技");
  expect(selection.hasAttribute("hidden")).toBe(false);
  button("更换", selection).click();
  expect(document.activeElement).toBe(search);
  button("取消关联", selection).click();
  expect(selection.hasAttribute("hidden")).toBe(true);
  query("示例");
  await vi.waitFor(() => expect(results.querySelector("button")).not.toBeNull());
  results.querySelector("button")!.click();
  expect(invoke.mock.calls.some(([command]) => command === "change_note_cmd")).toBe(false);
  dialog.querySelector<HTMLInputElement>('input[type="text"]')!.value = "面试复盘";
  button("创建", dialog).click();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("change_note_cmd", expect.objectContaining({
    change: expect.objectContaining({ name: "面试复盘", applicationId: "available" })
  })));
});

async function openNote(initialText: string | null) {
  let ocrText = initialText;
  let folders = [source, target];
  const invoke = vi.fn<Invoke>().mockImplementation(async <T,>(command: string, args?: Record<string, unknown>) => {
    if (command === "note_index_cmd") return {
      epoch: "archive",
      folders,
      notes: [{
        id: "note", folderId: source.id, title: "面试", recordDate: "2026-11-09", plainText: "",
        favorite: false, recycled: false, files: [{ ...file, ocrText }],
      }],
    } as T;
    if (command === "note_body_cmd") return '<div data-note-file="image"></div>' as T;
    if (command === "read_note_file_cmd") return file as T;
    if (command === "change_note_cmd") {
      const change = args?.change as { kind: string; id: string; text: string; recycled: boolean };
      if (change.kind === "ocr") { ocrText = change.text; return null as T; }
      if (change.kind === "recycleFolder") {
        folders = folders.map(folder => folder.id === change.id ? { ...folder, recycled: change.recycled } : folder);
        return null as T;
      }
    }
    throw new Error(`Unexpected command ${command}`);
  });
  const root = document.createElement("div");
  document.body.append(root);
  const notes = mountNotes(root, invoke as Invoke, () => {});
  await notes.activate();
  root.querySelector<HTMLButtonElement>('[data-folder-id="source"] .notes-folder-header > button')!.click();
  root.querySelector<HTMLButtonElement>(".notes-item")!.click();
  await vi.waitFor(() => expect(root.querySelector(".notes-ocr-toggle")).not.toBeNull());
  return { root, invoke, removeTarget: () => { folders = [source]; } };
}

test("re-recognition keeps corrected text searchable until a replacement is confirmed", async () => {
  const { root, invoke } = await openNote("5TAR");
  button("识别文字", root).click();
  button("校正", root).click();
  const corrected = "    STAR\n";
  root.querySelector<HTMLTextAreaElement>(".notes-ocr-content textarea")!.value = corrected;
  button("保存校正", root).click();
  await vi.waitFor(() => expect(root.querySelector(".notes-ocr-result")?.textContent).toBe(corrected));
  const search = root.querySelector<HTMLInputElement>('input[aria-label="搜索心得"]')!;
  const hits = (query: string) => {
    search.value = query;
    search.dispatchEvent(new Event("input"));
    return root.querySelectorAll(".notes-item").length;
  };

  recognizeImage.mockRejectedValueOnce(new Error("识别不可用"));
  button("重新识别", root).click();
  await vi.waitFor(() => expect(root.querySelector(".notes-ocr-state")?.textContent).toContain("识别不可用"));
  expect(hits("STAR")).toBe(1);

  recognizeImage.mockResolvedValue("new result");
  button("重新识别", root).click();
  await vi.waitFor(() => expect(root.querySelector(".notes-ocr-candidate")?.textContent).toContain("new result"));
  expect(hits("new result")).toBe(0);
  expect(hits("STAR")).toBe(1);
  button("保留当前文字", root).click();
  expect(root.querySelector(".notes-ocr-candidate")).toBeNull();
  expect(invoke.mock.calls.filter(([name]) => name === "change_note_cmd")).toHaveLength(1);

  button("重新识别", root).click();
  await vi.waitFor(() => expect(root.querySelector(".notes-ocr-candidate")).not.toBeNull());
  button("替换为新结果", root).click();
  await vi.waitFor(() => expect(root.querySelector(".notes-ocr-result")?.textContent).toBe("new result"));
  expect(hits("STAR")).toBe(0);
  expect(hits("new result")).toBe(1);
});

test("the move dialog reports a destination removed during a background index refresh", async () => {
  let complete!: (text: string) => void;
  recognizeImage.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const { root, invoke, removeTarget } = await openNote(null);
  await vi.waitFor(() => expect(recognizeImage).toHaveBeenCalledOnce());
  button("移动到…", root).click();
  removeTarget();
  complete("首次识别结果");
  await vi.waitFor(() => expect(root.querySelector('[data-folder-id="target"]')).toBeNull());

  const dialog = document.querySelector("dialog")!;
  button("移动", dialog).click();
  await vi.waitFor(() => expect(dialog.querySelector('[role="alert"]')?.textContent).toBe("目标文件夹已不可用，请重新选择。"));
  expect(root.querySelector('[data-folder-id="source"] .notes-item')).not.toBeNull();
  expect(invoke.mock.calls.filter(([name]) => name === "change_note_cmd")).toHaveLength(1);
});

test("recycling a different folder keeps the current note and reading position", async () => {
  const { root, invoke } = await openNote("STAR");
  const reader = root.querySelector<HTMLElement>(".notes-document-scroll")!;
  reader.scrollTop = 120;
  reader.dispatchEvent(new Event("scroll"));
  const recycle = async (folderId: string) => {
    const group = root.querySelector(`[data-folder-id="${folderId}"]`)!;
    button("移到回收站", group).click();
    button("移到回收站", await vi.waitFor(() => {
      const dialog = document.querySelector("dialog");
      expect(dialog).not.toBeNull();
      return dialog!;
    })).click();
    await vi.waitFor(() => expect(root.querySelector(`[data-folder-id="${folderId}"]`)).toBeNull());
  };

  await recycle(target.id);
  expect(root.querySelector(".notes-document-scroll")).toBe(reader);
  expect(reader.scrollTop).toBe(120);
  expect(invoke.mock.calls.filter(([name]) => name === "note_body_cmd")).toHaveLength(1);

  await recycle(source.id);
  expect(root.querySelector(".notes-document-scroll")).toBeNull();
  expect(root.querySelector(".notes-empty h2")?.textContent).toBe("打开一篇心得");
});
