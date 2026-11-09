import type { Invoke } from "../api.ts";
import { describeDialogError, openSettingsDialog } from "../settings-dialog.ts";
import {
  dataUrl, fileMarker, imageTypes, importNoteFiles, loadImages, safeBody, serializeBody, textFragment,
  MAX_FILES, MAX_BATCH_BYTES,
} from "./content.ts";
import type { FileContents, PendingFile, StoredFile } from "./content.ts";

interface Folder {
  id: string;
  name: string;
  applicationId: string | null;
  company: string | null;
  position: string | null;
  applicationRecycled: boolean;
  recycled: boolean;
}
interface Note {
  id: string;
  folderId: string;
  title: string;
  recordDate: string;
  plainText: string;
  favorite: boolean;
  recycled: boolean;
  files: StoredFile[];
}
interface Index { epoch: string; folders: Folder[]; notes: Note[] }
export interface NotesApplication { id: string; company: string; title: string; created_at?: string; location?: string | null }
interface Edit {
  epoch: string;
  id: string;
  folder: Folder;
  editor: HTMLElement;
  title: HTMLInputElement;
  date: HTMLInputElement;
  revision: number;
  saved: number;
  committed: Set<string>;
  files: Map<string, StoredFile>;
  pending: Map<string, PendingFile>;
  loading: Promise<void>;
  error: string;
  selection?: Range;
}

const interviewOutline = "问到的问题\n\n我的回答和感受\n\n下次想改进的地方";
const assessmentOutline = "考到的内容\n\n我的作答情况\n\n下次要注意的地方";

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(label: string, action: () => void, className?: string) {
  const node = element("button", label, className);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}

function field(label: string, control: HTMLElement) {
  const node = element("label", label);
  node.append(control);
  return node;
}

function textInput(type: string, value = "") {
  const input = element("input");
  input.type = type;
  input.value = value;
  return input;
}

function fileInput(accept: string, handle: (files: File[]) => void) {
  const picker = textInput("file");
  picker.accept = accept;
  picker.multiple = true;
  picker.hidden = true;
  picker.addEventListener("change", () => {
    const files = Array.from(picker.files ?? []);
    picker.value = "";
    if (files.length) handle(files);
  });
  return picker;
}

function noteTitle(note: Note) {
  return note.title.trim() || note.plainText.split("\n")[0]?.trim().slice(0, 80)
    || (note.files.length ? (note.files.every(file => file.mime.startsWith("image/")) ? "图片心得" : "附件心得") : "未命名心得");
}

function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function readHistory<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? "null") as T ?? fallback; }
  catch { return fallback; }
}

function writeHistory(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Reading still works if local preferences cannot be saved. */ }
}

function highlight(node: HTMLElement, query: string) {
  if (!query) return;
  const blocks = "p, div, li, pre, blockquote, td, th, h1, h2, h3, h4, h5, h6";
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
    acceptNode: (text) => text.parentElement?.closest("[data-note-file]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const groups: Text[][] = [];
  let previous: Element | null | undefined;
  while (walker.nextNode()) {
    const text = walker.currentNode as Text;
    const block = text.parentElement?.closest(blocks);
    if (!groups.length || block !== previous) groups.push([]);
    groups.at(-1)!.push(text);
    previous = block;
  }
  // Match in the original text so an inline format change or different case mapping
  // doesn't send the highlight to the wrong character.
  const literal = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  for (const group of groups) {
    const matches = [...group.map(text => text.data).join("").matchAll(literal)];
    if (!matches.length) continue;
    let offset = 0;
    for (const text of group) {
      const fragment = document.createDocumentFragment();
      let cursor = 0;
      for (const match of matches) {
        const start = Math.max(match.index - offset, 0);
        const end = Math.min(match.index + match[0].length - offset, text.length);
        if (start >= end) continue;
        fragment.append(text.data.slice(cursor, start), element("mark", text.data.slice(start, end)));
        cursor = end;
      }
      offset += text.length;
      if (cursor) {
        fragment.append(text.data.slice(cursor));
        text.replaceWith(fragment);
      }
    }
  }
}

export function mountNotes(root: HTMLElement, invoke: Invoke, openApplication: (id: string, recycled: boolean) => void) {
  root.innerHTML = `
    <h1 class="sr-only">心得</h1>
    <div class="notes-shell">
      <aside class="notes-sidebar" aria-label="心得文件夹">
        <div class="notes-tools"></div>
        <div class="notes-list"></div>
      </aside>
      <article class="notes-detail" aria-label="心得正文" tabindex="-1"></article>
    </div>
    <p class="notes-status muted" role="status"></p>
  `;
  const detail = root.querySelector<HTMLElement>(".notes-detail")!;
  const list = root.querySelector<HTMLElement>(".notes-list")!;
  const tools = root.querySelector<HTMLElement>(".notes-tools")!;
  const status = root.querySelector<HTMLElement>(".notes-status")!;
  const search = textInput("search");
  search.placeholder = "搜索心得、岗位或图片文字";
  search.setAttribute("aria-label", "搜索心得");
  const expanded = new Set<string>();
  const fileCache = new Map<string, Promise<FileContents>>();
  const ocrFailures = new Map<string, string>();
  const ocrQueue = new Map<string, string>();
  let ocrRunning = false;
  let activeOcr: string | undefined;
  let index: Index = { epoch: "", folders: [], notes: [] };
  let selectedFolder: string | undefined;
  let selectedNote: string | undefined;
  let mode: "tree" | "favorites" | "recycled" = "tree";
  let edit: Edit | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let saving: Promise<boolean> | undefined;
  let transitioning = false;
  let detailRequest = 0;
  let indexRequest = 0;
  let appliedIndex = 0;
  let currentBody: string | undefined;
  let drag: { pointer: number; id: string; x: number; y: number; preview?: HTMLElement; target?: string } | undefined;
  let suppressNoteClick = false;
  let hover: ReturnType<typeof setTimeout> | undefined;
  const folder = (id: string | undefined) => index.folders.find(item => item.id === id);
  const note = (id: string | undefined) => index.notes.find(item => item.id === id);
  const query = () => search.value.trim().toLowerCase();
  const notify = (message: string, error = false) => {
    status.textContent = message;
    status.dataset.tone = error ? "error" : "";
  };
  const fail = (error: unknown) => notify(describeDialogError(error), true);
  const favoriteMode = button("收藏", () => { mode = mode === "favorites" ? "tree" : "favorites"; renderList(); });
  const recycleMode = button("回收站", () => { mode = mode === "recycled" ? "tree" : "recycled"; renderList(); });
  tools.append(search, button("新建文件夹", () => void openFolderForm(), "primary"), favoriteMode, recycleMode);

  search.addEventListener("input", renderList);

  async function refreshIndex() {
    const request = ++indexRequest;
    const result = await invoke<Index>("note_index_cmd");
    if (request < appliedIndex) return;
    appliedIndex = request;
    const previous = index.epoch;
    index = result;
    if (previous && previous !== index.epoch) {
      fileCache.clear();
      ocrFailures.clear();
      ocrQueue.clear();
    }
    renderList();
  }

  function change<T = string | null>(change: Record<string, unknown>, epoch = index.epoch) {
    return invoke<T>("change_note_cmd", { epoch, change });
  }

  function openStoredFile(id: string, epoch = index.epoch) {
    const key = `${epoch}/${id}`;
    let request = fileCache.get(key);
    if (!request) {
      request = invoke<FileContents>("read_note_file_cmd", { epoch, id }).catch(error => {
        fileCache.delete(key);
        throw error;
      });
      fileCache.set(key, request);
      if (fileCache.size > 12) fileCache.delete(fileCache.keys().next().value!);
    }
    return request;
  }

  function withTransition(task: () => Promise<void>) {
    if (transitioning) return;
    transitioning = true;
    void task().catch(fail).finally(() => { transitioning = false; });
  }

  function renderNoteItem(item: Note, snippet?: string) {
    const row = button(noteTitle(item), () => withTransition(async () => {
      if (await finishEdit()) await readNote(item.id, Boolean(query()));
    }), "notes-item");
    row.setAttribute("aria-current", String(selectedNote === item.id));
    const parent = folder(item.folderId);
    row.append(element("small", [item.recordDate, snippet === undefined ? "" : parent?.name, snippet].filter(Boolean).join(" · ")));
    if (!item.recycled && !parent?.recycled) {
      row.addEventListener("pointerdown", event => {
        if (event.button !== 0 || event.pointerType !== "mouse") return;
        drag = { pointer: event.pointerId, id: item.id, x: event.clientX, y: event.clientY };
      });
    }
    if (snippet) highlight(row, query());
    return row;
  }

  function clearDropHighlights() {
    for (const target of list.querySelectorAll(".notes-drop-target")) target.classList.remove("notes-drop-target");
  }

  function renderList() {
    favoriteMode.setAttribute("aria-pressed", String(mode === "favorites"));
    recycleMode.setAttribute("aria-pressed", String(mode === "recycled"));
    list.replaceChildren();
    const q = query();
    const notes = index.notes.filter(item => {
      const deleted = item.recycled || folder(item.folderId)?.recycled;
      return mode === "recycled" ? deleted : !deleted && (mode !== "favorites" || item.favorite);
    });
    if (q || mode === "favorites") {
      for (const item of notes) {
        const parent = folder(item.folderId);
        const fields = [noteTitle(item), item.plainText, parent?.name, parent?.company, parent?.position,
          ...item.files.flatMap(file => [file.ocrText, file.name])];
        const match = q ? fields.find(value => value?.toLowerCase().includes(q)) : "";
        if (q && !match) continue;
        const at = match?.toLowerCase().indexOf(q) ?? 0;
        const snippet = match ? match.slice(Math.max(0, at - 28), at + q.length + 48).replace(/\s+/g, " ") : "";
        list.append(renderNoteItem(item, snippet));
      }
      if (!list.childElementCount) list.append(element("p", q ? "没有匹配的心得。" : "还没有收藏。", "muted"));
      return;
    }
    for (const parent of index.folders) {
      const children = notes.filter(item => item.folderId === parent.id);
      if (mode === "recycled" ? !parent.recycled && !children.length : parent.recycled) continue;
      const group = element("section", undefined, "notes-folder");
      group.dataset.folderId = parent.id;
      const header = element("div", undefined, "notes-folder-header");
      const isOpen = expanded.has(parent.id) || mode === "recycled";
      const title = button(`${isOpen ? "▾" : "▸"} ${parent.name}`, () => {
        if (mode !== "recycled") {
          if (expanded.has(parent.id)) expanded.delete(parent.id);
          else expanded.add(parent.id);
        }
        if (!selectedNote && !edit) {
          selectedFolder = parent.id;
          renderEmpty();
        }
        renderList();
      });
      title.setAttribute("aria-expanded", String(isOpen));
      header.append(title);
      if (!parent.recycled && mode !== "recycled") {
        const menu = element("details", undefined, "notes-menu");
        const more = element("summary", "⋯");
        more.setAttribute("aria-label", `${parent.name}的文件夹菜单`);
        const actions = element("div");
        actions.append(
          button("写心得", () => { menu.open = false; void startNew(parent); }),
          button("重命名或关联申请", () => { menu.open = false; void openFolderForm(parent); }),
          button("移到回收站", () => { menu.open = false; void recycleFolder(parent, true); }),
        );
        appendImport(actions, parent, () => { menu.open = false; });
        menu.append(more, actions);
        header.append(menu);
      } else if (parent.recycled) {
        header.append(button("恢复", () => void recycleFolder(parent, false)));
      }
      group.append(header);
      if (isOpen) children.forEach(item => group.append(renderNoteItem(item)));
      header.title = [parent.company, parent.position].filter(Boolean).join(" · ") || parent.name;
      list.append(group);
    }
    if (!list.childElementCount) list.append(element("p", mode === "recycled" ? "回收站为空。" : "新建文件夹，开始记录笔面试心得。", "muted"));
  }

  // Tauri's native file drop owns Windows WebView2's OS drop target. A pointer gesture
  // keeps moving a note within the tree independent of the OS file-drop path.
  function cancelDrag() {
    drag?.preview?.remove();
    drag = undefined;
    clearTimeout(hover);
    clearDropHighlights();
  }

  root.addEventListener("click", event => {
    if (!suppressNoteClick) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { capture: true });
  window.addEventListener("pointermove", event => {
    if (!drag || event.pointerId !== drag.pointer) return;
    const item = note(drag.id);
    if (!item) { cancelDrag(); return; }
    if (!drag.preview) {
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 7) return;
      drag.preview = element("div", noteTitle(item), "notes-drag-preview");
      root.append(drag.preview);
      root.setPointerCapture?.(event.pointerId);
      suppressNoteClick = true;
    }
    event.preventDefault();
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".notes-folder-header");
    const candidate = target?.closest<HTMLElement>("[data-folder-id]")?.dataset.folderId;
    const destination = candidate !== item.folderId ? folder(candidate) : undefined;
    const accepted = destination && !destination.recycled && mode === "tree" ? destination : undefined;
    drag.preview.textContent = accepted
      ? `${noteTitle(item)} → ${[accepted.name, accepted.company, accepted.position].filter(Boolean).join(" · ")}`
      : noteTitle(item);
    drag.preview.style.left = `${Math.min(event.clientX + 12, window.innerWidth - 235)}px`;
    drag.preview.style.top = `${event.clientY + 14}px`;
    if (drag.target !== accepted?.id) {
      clearTimeout(hover);
      clearDropHighlights();
      drag.target = accepted?.id;
      if (accepted && !expanded.has(accepted.id)) {
        hover = setTimeout(() => { expanded.add(accepted.id); renderList(); }, 550);
      }
    }
    if (accepted) target?.classList.add("notes-drop-target");
  });
  function finishDrag(event: PointerEvent, dropped: boolean) {
    if (drag?.pointer !== event.pointerId) return;
    const item = note(drag.id);
    const target = drag.preview ? folder(drag.target) : undefined;
    cancelDrag();
    setTimeout(() => { suppressNoteClick = false; }, 0);
    if (dropped && item && target) {
      withTransition(async () => {
        if (!(await finishEdit())) return;
        try { await moveNote(item, target); }
        catch (error) {
          if (selectedNote) await readNote(selectedNote);
          throw error;
        }
      });
    }
  }
  window.addEventListener("pointerup", event => finishDrag(event, true));
  window.addEventListener("pointercancel", event => finishDrag(event, false));
  window.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !drag) return;
    const pointer = drag.pointer;
    cancelDrag();
    if (root.hasPointerCapture?.(pointer)) root.releasePointerCapture(pointer);
    suppressNoteClick = false;
  });

  function renderEmpty() {
    currentBody = undefined;
    const parent = folder(selectedFolder);
    detail.replaceChildren(element("h2", parent?.name || "笔面试心得"));
    if (parent) appendApplication(detail, parent);
    if (parent && !parent.recycled) {
      detail.append(button("写心得", () => void startNew(parent), "primary"));
      appendImport(detail, parent);
    } else {
      detail.append(element("p", "从左侧选择一篇心得，或新建文件夹来写心得。", "muted"));
    }
  }

  function appendApplication(container: HTMLElement, parent: Folder) {
    if (!parent.applicationId) return;
    const label = [parent.company, parent.position].filter(Boolean).join(" · ");
    container.append(button(`${label || "关联申请"}${parent.applicationRecycled ? "（已回收）" : ""}`,
      () => openApplication(parent.applicationId!, parent.applicationRecycled), "notes-link"));
  }

  async function readNote(id: string, find: boolean = false) {
    const item = note(id);
    if (!item) { selectedNote = undefined; renderEmpty(); return; }
    const request = ++detailRequest;
    selectedNote = id;
    selectedFolder = item.folderId;
    if (!find) expanded.add(item.folderId);
    renderList();
    detail.replaceChildren(element("p", "正在读取心得…", "muted"));
    currentBody = undefined;
    try {
      const body = await invoke<string>("note_body_cmd", { epoch: index.epoch, id });
      if (request !== detailRequest) return;
      currentBody = body;
      renderRead(item, body, find);
      queueOcr(item);
    } catch (error) {
      if (request !== detailRequest) return;
      detail.replaceChildren(element("p", "心得正文读取失败。"), button("重新读取", () => {
        withTransition(() => readNote(id, find));
      }));
      fail(error);
    }
  }

  function renderRead(item: Note, body: string, find: boolean) {
    const parent = folder(item.folderId);
    if (!parent) return;
    const heading = element("div", undefined, "notes-heading");
    heading.append(element("h2", noteTitle(item)), element("p", item.recordDate, "muted"));
    appendApplication(heading, parent);
    const actions = element("div", undefined, "notes-actions");
    if (item.recycled) {
      actions.append(button("恢复心得", () => withTransition(async () => {
        await change({ kind: "recycleNote", id: item.id, recycled: false });
        await refreshIndex();
        await readNote(item.id);
      })));
    } else if (!parent.recycled) {
      actions.append(
        button("编辑", () => showEditor(parent, item, body), "primary"),
        button(item.favorite ? "取消收藏" : "收藏", () => withTransition(async () => {
          await change({ kind: "favorite", id: item.id, favorite: !item.favorite });
          await refreshIndex();
          await readNote(item.id);
        })),
        button("移动到…", () => void openMove(item)),
        button("移到回收站", () => withTransition(async () => {
          const confirmed = await openSettingsDialog({
            title: "回收心得", intro: "可以从心得回收站恢复。", confirmLabel: "移到回收站",
            action: async () => { await change({ kind: "recycleNote", id: item.id, recycled: true }); },
          });
          if (!confirmed) return;
          selectedNote = undefined;
          await refreshIndex();
          renderEmpty();
        })),
      );
      appendImport(actions, parent);
    }
    const article = element("div", undefined, "notes-body");
    const fileById = new Map(item.files.map(file => [file.id, file]));
    article.append(safeBody(body, new Set(fileById.keys())));
    const loading = Array.from(article.querySelectorAll<HTMLElement>("[data-note-file]"), marker =>
      fillMarker(marker, fileById.get(marker.dataset.noteFile!)!, undefined, find ? query() : ""));
    if (find) highlight(article, query());
    detail.replaceChildren(heading, actions, article);
    const readingKey = `notes:reading:${item.id}`;
    detail.onscroll = null;
    const remembered = find ? 0 : readHistory(readingKey, 0);
    let scroll = 0;
    let scrolled = false;
    detail.onscroll = () => {
      if (detail.scrollTop !== scroll) scrolled = true;
      writeHistory(readingKey, detail.scrollTop);
    };
    writeHistory(`notes:last:${item.folderId}`, item.id);
    const hit = find ? article.querySelector("mark, [data-ocr-hit]") : null;
    function restorePosition() {
      if (find) (hit ?? heading).scrollIntoView?.({ block: "nearest" });
      else detail.scrollTop = remembered;
      scroll = detail.scrollTop;
    }
    restorePosition();
    void Promise.all(loading).then(() => {
      if (article.isConnected && !scrolled) restorePosition();
    });
    if (find && !hit && query()) {
      const label = element("p", "搜索词命中标题、附件名、文件夹或关联申请。", "muted");
      heading.append(label);
      highlight(heading, query());
    }
  }

  function previewImage(src: string, name: string) {
    const modal = element("dialog", undefined, "notes-image-dialog");
    const image = element("img");
    image.src = src;
    image.alt = name;
    modal.append(button("关闭", () => modal.close()), image);
    modal.addEventListener("close", () => modal.remove(), { once: true });
    root.append(modal);
    modal.showModal();
  }

  function fillMarker(marker: HTMLElement, file: StoredFile, editing?: Edit, q = "") {
    marker.className = "notes-attachment";
    marker.contentEditable = "false";
    let ready: Promise<void> | undefined;
    if (file.mime === "application/pdf") {
      if (editing && !editing.pending.has(file.id)) {
        void openStoredFile(file.id).then(contents => editing.pending.set(file.id, { ...contents,
          id: file.id, size: Math.floor(contents.base64.replace(/=+$/, "").length * 3 / 4) })).catch(fail);
      }
      marker.append(button(file.name || "打开 PDF", () => {
        void (async () => {
          if (editing && !(await flush(editing))) return;
          await invoke("open_note_pdf_cmd", { epoch: editing?.epoch ?? index.epoch, id: file.id });
        })().catch(fail);
      }));
    } else {
      const image = element("img");
      image.alt = file.name || "心得图片";
      const show = button("", () => { if (image.hasAttribute("src")) previewImage(image.src, image.alt); }, "notes-image");
      show.setAttribute("aria-label", `放大图片 ${image.alt}`);
      show.append(image);
      marker.append(show);
      const pending = editing?.pending.get(file.id);
      ready = (pending ? Promise.resolve(pending) : openStoredFile(file.id)).then(async contents => {
        if (editing && !editing.pending.has(file.id)) {
          editing.pending.set(file.id, { ...contents, id: file.id,
            size: Math.floor(contents.base64.replace(/=+$/, "").length * 3 / 4) });
        }
        image.src = dataUrl(contents);
        await image.decode?.();
      }).catch(error => {
        image.replaceWith(element("span", `图片读取失败：${describeDialogError(error)}`, "muted"));
      });
      if (!editing) appendOcr(marker, file, q);
    }
    if (editing) {
      marker.append(button("移除附件", () => {
        editing.editor.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNode(marker);
        selection?.removeAllRanges();
        selection?.addRange(range);
        if (!document.execCommand?.("delete")) marker.remove();
        preserveSelection(editing);
        changed(editing);
      }));
    }
    return ready;
  }

  function appendOcr(marker: HTMLElement, file: StoredFile, q: string) {
    const panel = element("details", undefined, "notes-ocr");
    const label = element("summary", file.ocrText ? "识别文字" : "图片文字识别");
    const result = element("p", file.ocrText || (file.ocrText === "" ? "未识别到文字。" :
      ocrFailures.get(file.id) || (activeOcr === file.id ? "正在识别…" : "等待识别。")));
    const hit = Boolean(q && file.ocrText?.toLowerCase().includes(q));
    if (hit) {
      marker.dataset.ocrHit = "true";
      panel.open = true;
      highlight(result, q);
    }
    panel.append(label, result);
    if (file.ocrText) {
      panel.append(button("复制文字", () => {
        void navigator.clipboard.writeText(file.ocrText!).then(() => notify("已复制图片文字。")).catch(fail);
      }));
    }
    const retry = button("重新识别", () => {
      ocrFailures.delete(file.id);
      ocrQueue.set(file.id, index.epoch);
      void runOcr();
    });
    retry.disabled = activeOcr === file.id || ocrQueue.has(file.id);
    panel.append(retry);
    if (file.ocrText !== null && !retry.disabled) {
      panel.append(button("校正识别文字", () => {
        const text = element("textarea");
        text.value = file.ocrText ?? "";
        void openSettingsDialog({
          title: "校正识别文字", body: field("图片中的文字", text), confirmLabel: "保存",
          action: async () => {
            await change({ kind: "ocr", id: file.id, text: text.value.trim() });
            await refreshIndex();
            refreshOcrPanels();
          },
        });
      }));
      const item = note(selectedNote);
      const parent = folder(item?.folderId);
      if (file.ocrText && item && parent && !item.recycled && !parent.recycled && currentBody !== undefined) {
        panel.append(button("插入正文", () => {
          showEditor(parent, item, currentBody!);
          if (edit) insert(edit, textFragment(file.ocrText!));
        }));
      }
    }
    marker.append(panel);
  }

  function refreshOcrPanels() {
    if (edit) return;
    const item = note(selectedNote);
    if (!item) return;
    for (const marker of detail.querySelectorAll<HTMLElement>("[data-note-file]")) {
      const file = item.files.find(entry => entry.id === marker.dataset.noteFile);
      if (!file?.mime.startsWith("image/")) continue;
      const open = marker.querySelector("details")?.open;
      marker.querySelector(".notes-ocr")?.remove();
      appendOcr(marker, file, query());
      if (open) marker.querySelector("details")!.open = true;
    }
  }

  function queueOcr(item: Note) {
    for (const file of item.files) {
      if (file.mime.startsWith("image/") && file.ocrText === null && !ocrFailures.has(file.id) && file.id !== activeOcr) {
        ocrQueue.set(file.id, index.epoch);
      }
    }
    void runOcr();
  }

  async function runOcr() {
    if (ocrRunning) return;
    ocrRunning = true;
    try {
      for (const [id, epoch] of ocrQueue) {
        ocrQueue.delete(id);
        activeOcr = id;
        refreshOcrPanels();
        try {
          const [file, { recognizeImage }] = await Promise.all([openStoredFile(id, epoch), import("./ocr.ts")]);
          const text = await recognizeImage(dataUrl(file));
          if (epoch === index.epoch) {
            await change({ kind: "ocr", id, text }, epoch);
            await refreshIndex();
          }
        } catch (error) {
          if (epoch === index.epoch) ocrFailures.set(id, `识别失败：${describeDialogError(error)}`);
        } finally {
          activeOcr = undefined;
          refreshOcrPanels();
        }
      }
    } finally { ocrRunning = false; }
  }

  function insert(session: Edit, fragment: DocumentFragment) {
    if (edit !== session) return;
    session.editor.focus();
    const selection = window.getSelection();
    const range = session.selection;
    if (selection && range && session.editor.contains(range.commonAncestorContainer)) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    const html = element("div");
    html.append(fragment);
    const result = document.execCommand?.("insertHTML", false, html.innerHTML);
    if (!result) {
      const current = selection?.rangeCount ? selection.getRangeAt(0) : null;
      if (current && session.editor.contains(current.commonAncestorContainer)) {
        current.deleteContents();
        const end = html.lastChild;
        current.insertNode(fragmentFrom(html));
        if (end) {
          current.setStartAfter(end);
          current.collapse(true);
          selection!.removeAllRanges();
          selection!.addRange(current);
        }
      } else session.editor.append(fragmentFrom(html));
    }
    for (const marker of session.editor.querySelectorAll<HTMLElement>("[data-note-file]:empty")) {
      const file = session.files.get(marker.dataset.noteFile!);
      if (file) fillMarker(marker, file, session);
    }
    changed(session);
  }

  function fragmentFrom(node: HTMLElement) {
    const fragment = document.createDocumentFragment();
    while (node.firstChild) fragment.append(node.firstChild);
    return fragment;
  }

  function preserveSelection(session: Edit) {
    const selection = window.getSelection();
    if (selection?.rangeCount && session.editor.contains(selection.getRangeAt(0).commonAncestorContainer)) {
      session.selection = selection.getRangeAt(0).cloneRange();
    }
  }

  function showEditor(parent: Folder, item?: Note, body = "", suggested = "", initial: PendingFile[] = []) {
    detail.onscroll = null;
    const editor = element("div", undefined, "notes-editor notes-body");
    editor.contentEditable = "true";
    editor.setAttribute("role", "textbox");
    editor.setAttribute("aria-multiline", "true");
    editor.setAttribute("aria-label", "心得正文");
    editor.dataset.placeholder = "写下题目、回答或感受。也可以粘贴、拖入图片。";
    const title = textInput("text", item?.title ?? suggested);
    title.maxLength = 200;
    title.placeholder = "可选，留空时显示正文摘要";
    const date = textInput("date", item?.recordDate ?? today());
    const files = new Map((item?.files ?? []).map(file => [file.id, file]));
    for (const file of initial) files.set(file.id, { id: file.id, name: file.name, mime: file.mime, ocrText: null });
    const session: Edit = {
      epoch: index.epoch, id: item?.id ?? crypto.randomUUID(), folder: parent, editor, title, date, revision: 0, saved: 0,
      committed: new Set(item?.files.map(file => file.id)), files, pending: new Map(initial.map(file => [file.id, file])),
      loading: Promise.resolve(), error: "",
    };
    edit = session;
    void invoke("set_note_editing_cmd", { editing: true }).catch(() => {});
    selectedNote = session.id;
    selectedFolder = parent.id;
    expanded.add(parent.id);
    renderList();
    editor.append(safeBody(body, new Set(files.keys())));
    for (const marker of editor.querySelectorAll<HTMLElement>("[data-note-file]")) {
      fillMarker(marker, files.get(marker.dataset.noteFile!)!, session);
    }
    const toolbar = element("div", undefined, "notes-actions");
    const imagePicker = fileInput(imageTypes, files => queueFiles(session, () => loadImages(files)));
    const imageButton = button("插入图片", () => { preserveSelection(session); imagePicker.click(); });
    function formatting(label: string, command: string) {
      const item = button(label, () => {
        editor.focus();
        if (session.selection && editor.contains(session.selection.commonAncestorContainer)) {
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(session.selection);
        }
        document.execCommand?.(command);
        changed(session);
      });
      item.addEventListener("mousedown", () => preserveSelection(session));
      return item;
    }
    const outline = element("select");
    outline.setAttribute("aria-label", "插入提纲");
    for (const [value, label] of [["", "插入提纲…"], ["interview", "面试心得"], ["assessment", "笔试心得"]]) {
      const option = element("option", label);
      option.value = value;
      outline.append(option);
    }
    outline.addEventListener("mousedown", () => preserveSelection(session));
    outline.addEventListener("change", () => {
      if (outline.value) insert(session, textFragment(outline.value === "interview" ? interviewOutline : assessmentOutline));
      outline.value = "";
    });
    toolbar.append(formatting("加粗", "bold"), formatting("项目列表", "insertUnorderedList"),
      formatting("编号列表", "insertOrderedList"), imageButton, imagePicker, outline);
    const actions = element("div", undefined, "notes-actions");
    actions.append(button("完成编辑", () => withTransition(async () => {
      if (await finishEdit()) await readNote(session.id);
    }), "primary"), button("立即保存 / 重试", () => void flush(session)));
    const heading = element("div", undefined, "notes-heading");
    heading.append(element("h2", parent.name));
    appendApplication(heading, parent);
    const metadata = element("div", undefined, "notes-fields");
    metadata.append(field("标题", title), field("记录日期", date));
    detail.replaceChildren(heading, metadata, toolbar, editor, actions);
    title.addEventListener("input", () => changed(session));
    date.addEventListener("input", () => changed(session));
    editor.addEventListener("input", () => { preserveSelection(session); changed(session); });
    editor.addEventListener("keyup", () => preserveSelection(session));
    editor.addEventListener("mouseup", () => preserveSelection(session));
    editor.addEventListener("paste", event => {
      event.preventDefault();
      preserveSelection(session);
      const clipboard = event.clipboardData;
      if (!clipboard) return;
      const files = Array.from(clipboard.files).filter(file => file.type.startsWith("image/"));
      if (files.length) {
        queueFiles(session, () => loadImages(files));
      } else {
        const html = clipboard.getData("text/html");
        const text = clipboard.getData("text/plain");
        if (html) {
          const uploads: PendingFile[] = [];
          const clean = safeBody(html, new Set(), image => {
            const src = image.getAttribute("src") ?? "";
            const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(src);
            if (!match || match[2].length > 14_000_000 || uploads.length >= MAX_FILES) {
              return document.createTextNode(image.alt || "[图片需单独粘贴]");
            }
            const file: PendingFile = { id: crypto.randomUUID(), name: image.alt || "粘贴的图片",
              mime: match[1], base64: match[2], size: Math.floor(match[2].replace(/=+$/, "").length * 3 / 4) };
            uploads.push(file);
            return fileMarker(file.id);
          });
          if (uploads.length) queueFiles(session, async () => uploads, clean);
          else if (clean.textContent?.trim() || clean.childElementCount) insert(session, clean);
          else if (text) insert(session, textFragment(text));
        } else if (text) insert(session, textFragment(text));
      }
    });
    editor.addEventListener("dragover", event => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
    });
    editor.addEventListener("drop", event => {
      if (!event.dataTransfer?.files.length) return;
      event.preventDefault();
      selectDropPoint(session, event.clientX, event.clientY);
      const files = Array.from(event.dataTransfer.files);
      queueFiles(session, () => loadImages(files));
    });
    editor.focus();
    const selection = window.getSelection();
    const end = document.createRange();
    end.selectNodeContents(editor);
    end.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(end);
    preserveSelection(session);
    if (!item) changed(session);
    else notify("已保存");
  }

  function selectDropPoint(session: Edit, x: number, y: number) {
    const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
    const range = doc.caretRangeFromPoint?.(x, y);
    if (range && session.editor.contains(range.commonAncestorContainer)) session.selection = range;
  }

  function queueFiles(session: Edit, load: () => Promise<PendingFile[]>, fragment?: DocumentFragment) {
    clearTimeout(saveTimer);
    const insertion = session.selection?.cloneRange();
    session.loading = session.loading.then(async () => {
      const files = await load();
      if (edit !== session) return;
      const present = serializeBody(session.editor, new Set(session.files.keys())).fileIds;
      const existingBytes = present.reduce((total, id) => total + (session.committed.has(id) ? 0 : session.pending.get(id)?.size ?? 0), 0);
      if (present.length + files.length > MAX_FILES || existingBytes + files.reduce((total, file) => total + file.size, 0) > MAX_BATCH_BYTES) {
        throw new Error("每篇最多 30 个附件，每次保存最多 30 MB 新附件。");
      }
      const body = fragment ?? document.createDocumentFragment();
      for (const file of files) {
        session.pending.set(file.id, file);
        session.files.set(file.id, { id: file.id, name: file.name, mime: file.mime, ocrText: null });
        if (!fragment) body.append(fileMarker(file.id));
      }
      if (insertion && session.editor.contains(insertion.commonAncestorContainer)) session.selection = insertion;
      insert(session, body);
    }).catch(error => {
      if (edit === session) {
        fail(error);
        if (session.revision !== session.saved) scheduleSave(session);
      }
    });
  }

  function scheduleSave(session: Edit) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void flush(session), 500);
  }

  function changed(session: Edit) {
    if (edit !== session) return;
    session.revision++;
    session.error = "";
    notify("等待保存…");
    scheduleSave(session);
  }

  function flush(session: Edit): Promise<boolean> {
    clearTimeout(saveTimer);
    if (saving) return saving;
    saving = (async () => {
      try {
        while (edit === session) {
          const loading = session.loading;
          await loading;
          if (loading !== session.loading) continue;
          if (session.saved === session.revision) return true;
          const revision = session.revision;
          const epoch = session.epoch;
          const body = serializeBody(session.editor, new Set(session.files.keys()));
          const uploads = [];
          for (const id of body.fileIds.filter(id => !session.committed.has(id))) {
            const file = session.pending.get(id) ?? await openStoredFile(id, epoch);
            uploads.push({ id, name: file.name, base64: file.base64 });
          }
          notify("保存中…");
          await invoke("save_note_cmd", {
            epoch, draft: { ...body, id: session.id, folderId: session.folder.id,
              title: session.title.value, recordDate: session.date.value }, uploads,
          });
          session.committed = new Set(body.fileIds);
          session.saved = revision;
          session.error = "";
          notify("已保存");
          try {
            await refreshIndex();
            const saved = note(session.id);
            if (saved) queueOcr(saved);
          } catch (error) { notify(`已保存，刷新列表失败：${describeDialogError(error)}`, true); }
        }
        return true;
      } catch (error) {
        session.error = describeDialogError(error);
        notify(`保存失败：${session.error}。内容仍在编辑器中，可以重试。`, true);
        return false;
      }
    })().finally(() => { saving = undefined; });
    return saving;
  }

  async function finishEdit() {
    const session = edit;
    if (!session) return true;
    if (!(await flush(session))) {
      const discard = await openSettingsDialog({
        title: "心得还有未保存的内容", intro: session.error, confirmLabel: "放弃未保存内容", cancelLabel: "继续编辑",
        tone: "danger",
      });
      if (!discard) return false;
    }
    clearTimeout(saveTimer);
    edit = undefined;
    await invoke("set_note_editing_cmd", { editing: false }).catch(() => {});
    return true;
  }

  async function confirmLeave() {
    if (transitioning) return false;
    const id = edit?.id;
    if (!(await finishEdit())) return false;
    if (id) {
      try { await readNote(id); }
      catch (error) { fail(error); renderEmpty(); }
    }
    return true;
  }

  function startNew(parent: Folder, title = "") {
    withTransition(async () => {
      if (!(await finishEdit())) return;
      mode = "tree";
      search.value = "";
      showEditor(parent, undefined, "", title);
    });
  }

  function appendImport(container: HTMLElement, parent: Folder, onPick?: () => void) {
    const picker = fileInput(`.md,.markdown,.txt,.pdf,${imageTypes}`, files => withTransition(async () => {
      if (!(await finishEdit())) return;
      const imported = await importNoteFiles(files);
      const description = element("div");
      description.append(element("p", `《${imported.title}》将导入「${parent.name}」。`));
      if (imported.missing.length) {
        description.append(element("p", "以下图片没有找到。可以取消，重新同时选中正文和图片。"));
        const missing = element("ul");
        imported.missing.forEach(name => missing.append(element("li", name)));
        description.append(missing);
      }
      const confirmed = await openSettingsDialog({
        title: "导入备忘录文件", confirmLabel: "导入为心得", body: description,
      });
      if (!confirmed) return;
      const buffer = element("div");
      buffer.append(imported.body);
      mode = "tree";
      search.value = "";
      showEditor(parent, undefined, buffer.innerHTML, imported.title, imported.uploads);
    }));
    container.append(button("导入备忘录文件", () => {
      onPick?.();
      picker.click();
    }), picker);
  }

  function openFolderForm(existing?: Folder, application?: NotesApplication, suggested?: string) {
    withTransition(async () => {
      if (!(await finishEdit())) return;
      await showFolderForm(existing, application, suggested);
    });
  }

  async function showFolderForm(existing?: Folder, application?: NotesApplication, suggested?: string) {
    const form = element("div", undefined, "notes-folder-form");
    const name = textInput("text", existing?.name ?? (application ? `${application.company} · ${application.title}` : ""));
    name.maxLength = 200;
    const appSearch = textInput("search");
    appSearch.placeholder = "按公司或岗位搜索";
    const apps = element("select");
    const include = (candidate: NotesApplication) => {
      const option = element("option", [candidate.company, candidate.title, candidate.location, candidate.created_at?.slice(0, 10)]
        .filter(Boolean).join(" · ") + ` · ${candidate.id.slice(-6)}`);
      option.value = candidate.id;
      return option;
    };
    const previous = application?.id ?? existing?.applicationId ?? "";
    const kept: NotesApplication | undefined = application ?? (existing?.applicationId ? {
      id: existing.applicationId, company: existing.company ?? "已关联申请", title: existing.position ?? "",
    } : undefined);
    let selected = kept ? include(kept) : undefined;
    let selectedValue = previous;
    if (selected) apps.append(selected);
    apps.addEventListener("change", () => {
      selectedValue = apps.value;
      selected = apps.value ? apps.selectedOptions[0].cloneNode(true) as HTMLOptionElement : undefined;
    });
    const hint = element("p", "同一申请对应一个活动文件夹。", "muted");
    let request = 0;
    async function searchApplications() {
      const token = ++request;
      try {
        const page = await invoke<{ items: NotesApplication[]; total: number }>("list_applications_cmd", {
          args: { limit: 100, offset: 0, query: appSearch.value.trim() },
        });
        if (token !== request) return;
        const value = selectedValue;
        apps.replaceChildren(element("option", "暂不关联"));
        apps.options[0].value = "";
        const available = page.items.filter(candidate => !index.folders.some(item =>
          !item.recycled && item.id !== existing?.id && item.applicationId === candidate.id));
        for (const candidate of available) apps.append(include(candidate));
        if (selected && !Array.from(apps.options).some(option => option.value === selected?.value)) apps.append(selected);
        apps.value = value;
        if (apps.selectedIndex < 0) apps.selectedIndex = 0;
        hint.textContent = page.total > page.items.length ? "仅显示前 100 条，输入公司或岗位缩小范围。" : "同一申请对应一个活动文件夹。";
      } catch (error) {
        hint.textContent = `申请列表读取失败：${describeDialogError(error)}`;
      }
    }
    if (!selected) {
      const empty = element("option", "暂不关联");
      empty.value = "";
      apps.append(empty);
    } else {
      const empty = element("option", "暂不关联");
      empty.value = "";
      apps.prepend(empty);
      apps.value = selected.value;
    }
    if (application) apps.disabled = true;
    appSearch.addEventListener("input", () => void searchApplications());
    form.append(field("文件夹名称", name));
    if (!application) form.append(field("搜索申请", appSearch));
    form.append(field("关联申请", apps), hint);
    if (!application) void searchApplications();
    let id: string | null = null;
    const ok = await openSettingsDialog({
      title: existing ? "编辑心得文件夹" : "新建心得文件夹", body: form, confirmLabel: existing ? "保存" : "创建",
      action: async () => {
        id = await change({ kind: "folder", id: existing?.id ?? null, name: name.value, applicationId: apps.value || null });
      },
    });
    if (!ok) {
      if (!edit && selectedNote) await readNote(selectedNote);
      return;
    }
    await refreshIndex();
    const created = folder(id ?? undefined);
    if (!created) return;
    mode = "tree";
    search.value = "";
    if (suggested !== undefined) {
      showEditor(created, undefined, "", suggested);
    } else {
      selectedFolder = created.id;
      expanded.add(created.id);
      if (existing && selectedNote && note(selectedNote)?.folderId === created.id) await readNote(selectedNote);
      else { selectedNote = undefined; renderList(); renderEmpty(); }
    }
  }

  function recycleFolder(parent: Folder, recycled: boolean) {
    withTransition(async () => {
      if (!(await finishEdit())) return;
      if (recycled) {
        const ok = await openSettingsDialog({
          title: `回收「${parent.name}」`, intro: "文件夹与其中的心得会一起保留在心得回收站。",
          confirmLabel: "移到回收站",
        });
        if (!ok) {
          if (selectedNote) await readNote(selectedNote);
          else renderEmpty();
          return;
        }
      }
      await change({ kind: "recycleFolder", id: parent.id, recycled });
      if (selectedFolder === parent.id) { selectedNote = undefined; selectedFolder = undefined; }
      await refreshIndex();
      renderEmpty();
      const restored = folder(parent.id);
      notify(recycled ? "文件夹已移到回收站。" :
        parent.applicationId && !restored?.applicationId ? "已恢复文件夹，原申请已有其他文件夹，关联已解除。" : "已恢复文件夹。");
    });
  }

  async function moveNote(item: Note, target: Folder, undo = false) {
    await change({ kind: "move", id: item.id, folderId: target.id });
    expanded.add(target.id);
    await refreshIndex();
    if (selectedNote) await readNote(selectedNote);
    notify(`已移到「${target.name}」`);
    const from = folder(item.folderId);
    if (!undo && from && !from.recycled) {
      const epoch = index.epoch;
      status.append(" ", button("撤销", () => withTransition(async () => {
        if (!(await finishEdit())) return;
        const moved = note(item.id);
        if (index.epoch !== epoch || moved?.folderId !== target.id) return;
        await moveNote(moved, from, true);
      })));
    }
  }

  function openMove(item: Note) {
    withTransition(async () => {
      const destinations = index.folders.filter(parent => !parent.recycled && parent.id !== item.folderId);
      if (!destinations.length) { notify("先新建一个目标文件夹。"); return; }
      const choices = element("select");
      for (const target of destinations) {
        const option = element("option", [target.name, target.company, target.position].filter(Boolean).join(" · "));
        option.value = target.id;
        choices.append(option);
      }
      await openSettingsDialog({
        title: "移动心得", body: field("目标文件夹", choices), confirmLabel: "移动",
        action: async () => { await moveNote(item, folder(choices.value)!); },
      });
    });
  }

  async function activate(application?: NotesApplication, suggested?: string) {
    if (transitioning) return;
    transitioning = true;
    try {
      if (!(await finishEdit())) return;
      await refreshIndex();
      if (!application) {
        if (selectedNote && note(selectedNote)) await readNote(selectedNote);
        else renderEmpty();
        return;
      }
      mode = "tree";
      search.value = "";
      const associated = index.folders.find(parent => parent.applicationId === application.id && !parent.recycled);
      if (!associated) {
        selectedNote = undefined;
        selectedFolder = undefined;
        renderEmpty();
        const candidates = index.folders.filter(parent => !parent.recycled && !parent.applicationId);
        if (candidates.length) {
          const picker = element("select");
          for (const [value, label] of [["", "新建文件夹"], ...candidates.map(parent => [parent.id, parent.name])]) {
            const option = element("option", label);
            option.value = value;
            picker.append(option);
          }
          const ok = await openSettingsDialog({
            title: "设置这条申请的心得文件夹", body: field("新建或选用已有文件夹", picker), confirmLabel: "继续",
          });
          if (!ok) return;
          await showFolderForm(folder(picker.value), application, suggested);
        } else await showFolderForm(undefined, application, suggested);
        return;
      }
      selectedFolder = associated.id;
      expanded.add(associated.id);
      if (suggested !== undefined) { showEditor(associated, undefined, "", suggested); return; }
      const children = index.notes.filter(item => item.folderId === associated.id && !item.recycled);
      const last = readHistory<string | null>(`notes:last:${associated.id}`, null);
      const item = children.find(item => item.id === last) ?? children[0];
      if (item) await readNote(item.id);
      else { selectedNote = undefined; renderList(); renderEmpty(); }
    } catch (error) { fail(error); }
    finally { transitioning = false; }
  }

  function nativeDrop(paths: string[], position?: { x: number; y: number }) {
    const session = edit;
    if (!session || root.classList.contains("hidden") || !paths.length) return;
    if (position) {
      const bounds = session.editor.getBoundingClientRect();
      if (position.x < bounds.left || position.x > bounds.right || position.y < bounds.top || position.y > bounds.bottom) return;
      selectDropPoint(session, position.x, position.y);
    }
    queueFiles(session, async () => {
      if (paths.length > MAX_FILES) throw new Error("一次最多拖入 30 张图片。");
      const files: PendingFile[] = [];
      let size = 0;
      for (const path of paths) {
        const file = await invoke<FileContents>("read_note_drop_cmd", { path });
        const bytes = Math.floor(file.base64.replace(/=+$/, "").length * 3 / 4);
        size += bytes;
        if (size > MAX_BATCH_BYTES) throw new Error("拖入的图片合计超过 30 MB。");
        files.push({ ...file, id: crypto.randomUUID(), size: bytes });
      }
      return files;
    });
  }

  function archiveReplaced() {
    ++detailRequest;
    appliedIndex = ++indexRequest;
    fileCache.clear();
    ocrFailures.clear();
    ocrQueue.clear();
    index = { epoch: "", notes: [], folders: [] };
    selectedFolder = selectedNote = undefined;
    expanded.clear();
    renderList();
    renderEmpty();
  }

  renderEmpty();
  return { activate, confirmLeave, archiveReplaced, nativeDrop, fail };
}
