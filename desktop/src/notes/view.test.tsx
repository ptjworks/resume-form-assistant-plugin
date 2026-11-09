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
      const change = args?.change as { kind: string; text: string };
      if (change.kind === "ocr") { ocrText = change.text; return null as T; }
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
  root.querySelector<HTMLTextAreaElement>(".notes-ocr-content textarea")!.value = "STAR";
  button("保存校正", root).click();
  await vi.waitFor(() => expect(root.querySelector(".notes-ocr-result")?.textContent).toBe("STAR"));
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
