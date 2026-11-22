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
  return { root, invoke };
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

// #554：心得页的新外框、三个切换、按公司筛选，以及预留的发布位。
const star = { company: "星河科技", recycled: false, applicationRecycled: false };
const library = () => ({
  epoch: "library",
  folders: [
    { id: "xh-fe", name: "星河科技 · 前端", applicationId: "a1", position: "前端工程师", ...star },
    { id: "xh-be", name: "星河科技 · 后端", applicationId: "a2", position: "后端工程师", ...star },
    { id: "ys", name: "云杉数据 · 分析", applicationId: "a3", company: "云杉数据", position: "数据分析师", recycled: false, applicationRecycled: false },
    { id: "loose", name: "没关联的", applicationId: null, company: null, position: null, recycled: false, applicationRecycled: false },
  ],
  notes: [
    { id: "n1", folderId: "xh-fe", title: "一面", recordDate: "2026-11-09", plainText: "", favorite: true, recycled: false, files: [] },
    { id: "n2", folderId: "xh-be", title: "二面", recordDate: "2026-11-12", plainText: "", favorite: false, recycled: false, files: [] },
    { id: "n3", folderId: "ys", title: "笔试", recordDate: "2026-11-10", plainText: "", favorite: true, recycled: false, files: [] },
    { id: "n4", folderId: "loose", title: "随手记", recordDate: "2026-11-11", plainText: "", favorite: false, recycled: false, files: [] },
    { id: "n5", folderId: "xh-fe", title: "旧的一面", recordDate: "2026-10-01", plainText: "", favorite: false, recycled: true, files: [] },
  ],
});

async function mountLibrary() {
  const invoke = vi.fn<Invoke>().mockImplementation(async <T,>(command: string) => {
    if (command === "note_index_cmd") return library() as T;
    if (command === "note_body_cmd") return "<p>正文</p>" as T;
    throw new Error(`Unexpected command ${command}`);
  });
  const root = document.createElement("div");
  document.body.append(root);
  const notes = mountNotes(root, invoke as Invoke, () => {});
  await notes.activate();
  return { root, notes, invoke };
}

const folderNames = (root: HTMLElement) =>
  [...root.querySelectorAll(".notes-folder-header > button:first-child > span:last-child")].map(node => node.textContent);
const tab = (root: HTMLElement, label: string) =>
  [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(node => node.textContent?.startsWith(label))!;

test("the page is 心得 with one short line, and 全部 / 收藏 / 回收站 are tabs with line-icon stars", async () => {
  const { root } = await mountLibrary();
  expect(root.querySelector("h1")?.textContent).toBe("心得");
  expect(root.textContent).not.toContain("笔面试心得");
  expect(root.querySelector(".notes-subtitle")?.textContent?.length).toBeLessThan(24);
  const tabs = [...root.querySelectorAll('[role="tablist"] [role="tab"]')];
  expect(tabs.map(node => node.textContent?.replace(/\s+/g, ""))).toEqual(["全部", "收藏2", "回收站"]);
  expect(tab(root, "全部").getAttribute("aria-selected")).toBe("true");
  expect(root.textContent).not.toMatch(/[★☆]/);

  tab(root, "收藏").click();
  expect(tab(root, "收藏").getAttribute("aria-selected")).toBe("true");
  expect(tab(root, "全部").getAttribute("aria-selected")).toBe("false");
  expect([...root.querySelectorAll(".notes-item strong")].map(node => node.textContent)).toEqual(["一面", "笔试"]);
  expect(root.querySelectorAll(".notes-item .notes-favorite-star svg.notes-star.is-filled")).toHaveLength(2);

  tab(root, "回收站").click();
  expect(tab(root, "回收站").getAttribute("aria-selected")).toBe("true");
  expect([...root.querySelectorAll(".notes-item strong")].map(node => node.textContent)).toEqual(["旧的一面"]);

  tab(root, "全部").click();
  expect(folderNames(root)).toEqual(["星河科技 · 前端", "星河科技 · 后端", "云杉数据 · 分析", "没关联的"]);
});

test("the favorite button in the reader is a line star, filled only when favorited", async () => {
  const { root } = await mountLibrary();
  root.querySelector<HTMLButtonElement>('[data-folder-id="xh-fe"] .notes-folder-header > button')!.click();
  root.querySelector<HTMLButtonElement>(".notes-item")!.click();
  const favorite = await vi.waitFor(() => {
    const node = root.querySelector<HTMLButtonElement>(".notes-favorite-button");
    expect(node).not.toBeNull();
    return node!;
  });
  expect(favorite.textContent).toBe("");
  expect(favorite.getAttribute("aria-pressed")).toBe("true");
  expect(favorite.querySelector("svg.notes-star.is-filled")).not.toBeNull();
  expect(root.textContent).not.toMatch(/[★☆]/);
});

test("showCompany keeps only that company's linked folders (all positions); × shows everything again", async () => {
  const { root, notes } = await mountLibrary();
  await notes.showCompany(" 星河科技 ");
  const bar = root.querySelector<HTMLElement>(".notes-company-filter")!;
  expect(bar.hidden).toBe(false);
  expect(bar.textContent).toContain("星河科技 的心得");
  expect(folderNames(root)).toEqual(["星河科技 · 前端", "星河科技 · 后端"]);
  // 两个岗位的文件夹都展开着，回收的那篇不显示。
  expect([...root.querySelectorAll(".notes-item strong")].map(node => node.textContent)).toEqual(["一面", "二面"]);
  // 收藏页签的数字也只数这家公司的。
  expect(tab(root, "收藏").textContent?.replace(/\s+/g, "")).toBe("收藏1");
  tab(root, "收藏").click();
  expect([...root.querySelectorAll(".notes-item strong")].map(node => node.textContent)).toEqual(["一面"]);
  tab(root, "全部").click();
  expect(bar.hidden).toBe(false);

  root.querySelector<HTMLButtonElement>('.notes-company-filter button[aria-label="显示全部心得"]')!.click();
  expect(bar.hidden).toBe(true);
  expect(folderNames(root)).toEqual(["星河科技 · 前端", "星河科技 · 后端", "云杉数据 · 分析", "没关联的"]);
  expect(tab(root, "收藏").textContent?.replace(/\s+/g, "")).toBe("收藏2");
});

test("the temporary company filter is dropped when the notes page is opened again", async () => {
  const { root, notes } = await mountLibrary();
  await notes.showCompany("云杉数据");
  expect(folderNames(root)).toEqual(["云杉数据 · 分析"]);
  await notes.activate();
  expect(root.querySelector<HTMLElement>(".notes-company-filter")!.hidden).toBe(true);
  expect(folderNames(root)).toHaveLength(4);
});

test("the publish-to-square slot exists but stays hidden and never calls the platform in phase 1", async () => {
  const { configurePlatformServices, getPlatformServices } = await import("../platform/registry.ts");
  const original = getPlatformServices();
  const preview = vi.fn(async () => { throw new Error("不该被调用"); });
  configurePlatformServices({ ...original, community: { ...original.community, previewDesensitizedNote: preview } });
  try {
    const { root } = await mountLibrary();
    root.querySelector<HTMLButtonElement>('[data-folder-id="xh-fe"] .notes-folder-header > button')!.click();
    root.querySelector<HTMLButtonElement>(".notes-item")!.click();
    const slot = await vi.waitFor(() => {
      const node = root.querySelector<HTMLButtonElement>('[data-platform="community-remote"]');
      expect(node).not.toBeNull();
      return node!;
    });
    expect(slot.hasAttribute("data-platform-off")).toBe(true);
    expect(slot.textContent).toContain("脱敏发布到广场");
    slot.click();
    expect(preview).not.toHaveBeenCalled();
    // 开关打开后才会走 previewDesensitizedNote（预览窗口留给社区实现）。
    configurePlatformServices({
      ...original,
      capabilities: { ...original.capabilities, communityRemoteEnabled: true },
      community: { ...original.community, previewDesensitizedNote: preview },
    });
    slot.click();
    await vi.waitFor(() => expect(preview).toHaveBeenCalledWith("n1"));
    // 页面上没有任何别的广场入口。
    expect(root.querySelectorAll('[data-platform]:not([data-platform="community-remote"])')).toHaveLength(0);
  } finally {
    configurePlatformServices(original);
  }
});

async function openFirstNote(root: HTMLElement) {
  root.querySelector<HTMLButtonElement>('[data-folder-id="xh-fe"] .notes-folder-header > button')!.click();
  root.querySelector<HTMLButtonElement>(".notes-item")!.click();
  await vi.waitFor(() => expect(root.querySelector(".notes-read-header")).not.toBeNull());
}

test("the reader has 编辑 and a plain 删除 button, no ⋯ menu and no 移动到…; 删除 recycles after confirming", async () => {
  const invoke = vi.fn<Invoke>().mockImplementation(async <T,>(command: string) => {
    if (command === "note_index_cmd") return library() as T;
    if (command === "note_body_cmd") return "<p>正文</p>" as T;
    if (command === "change_note_cmd") return null as T;
    throw new Error(`Unexpected command ${command}`);
  });
  const root = document.createElement("div");
  document.body.append(root);
  await mountNotes(root, invoke as Invoke, () => {}).activate();
  await openFirstNote(root);
  const actions = root.querySelector<HTMLElement>(".notes-read-header .notes-actions")!;
  expect(actions.querySelector("details")).toBeNull();
  expect([...actions.querySelectorAll("button")].map(node => node.textContent?.trim()).filter(Boolean)).toEqual(["脱敏发布到广场", "编辑", "删除"]);
  expect(root.textContent).not.toContain("移动到");

  button("删除", actions).click();
  const dialog = await vi.waitFor(() => {
    const found = document.querySelector("dialog");
    expect(found).not.toBeNull();
    return found!;
  });
  expect(invoke.mock.calls.some(([command]) => command === "change_note_cmd")).toBe(false);
  button("删除", dialog).click();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("change_note_cmd", expect.objectContaining({
    change: { kind: "recycleNote", id: "n1", recycled: true },
  })));
});

test("the editor has no ⋯ menu", async () => {
  const invoke = vi.fn<Invoke>().mockImplementation(async <T,>(command: string) => {
    if (command === "note_index_cmd") return library() as T;
    if (command === "note_body_cmd") return "<p>正文</p>" as T;
    if (command === "set_note_editing_cmd") return null as T;
    throw new Error(`Unexpected command ${command}`);
  });
  const root = document.createElement("div");
  document.body.append(root);
  await mountNotes(root, invoke as Invoke, () => {}).activate();
  await openFirstNote(root);
  button("编辑", root).click();
  const header = await vi.waitFor(() => {
    const found = root.querySelector<HTMLElement>(".notes-edit-header");
    expect(found).not.toBeNull();
    return found!;
  });
  expect(header.querySelector('summary[aria-label="更多心得操作"]')).toBeNull();
  expect(button("完成编辑", header)).toBeDefined();
});

test("a folder ⋯ menu closes on a click elsewhere and on Escape, and opening another closes the first", async () => {
  const { root } = await mountLibrary();
  const menus = () => [...root.querySelectorAll<HTMLDetailsElement>(".notes-folder-header > details.notes-menu")];
  expect(menus()).toHaveLength(4);
  const [first, second] = menus();
  first.open = true;
  document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  expect(first.open).toBe(false);

  first.open = true;
  first.querySelector("summary")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  expect(first.open).toBe(true);
  second.open = true;
  second.querySelector("summary")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  expect(first.open).toBe(false);
  expect(second.open).toBe(true);

  second.querySelector("summary")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(second.open).toBe(false);
});
