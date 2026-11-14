import type { Editor } from "@tiptap/core";
import { attachmentType, createNotesEditor, insertCodeExample } from "./editor.ts";
import type { Invoke } from "../api.ts";
import { describeDialogError, openSettingsDialog } from "../settings-dialog.ts";
import {
  dataUrl, fileMarker, fileMimeFromHeader, fontSizes, imageTypes, importNoteFiles, loadImages, safeBody, serializeBody, textFragment,
  noteColor, noteFonts, noteHighlights, noteTextColors,
  MAX_FILES, MAX_BATCH_BYTES, MAX_FILE_BYTES,
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
  editor: Editor;
  host: HTMLElement;
  title: HTMLInputElement;
  date: HTMLInputElement;
  revision: number;
  saved: number;
  committed: Set<string>;
  files: Map<string, StoredFile>;
  pending: Map<string, PendingFile>;
  loading: Promise<void>;
  error: string;
  insertions: Set<{ from: number; to: number }>;
  pasteNotice: HTMLElement;
}

interface PasteInsertion {
  fragment: DocumentFragment;
  oversize: number;
  capacity: number;
  unreadable: number;
}

interface OcrJob { epoch: string; previous: string | null }
interface OcrCandidate { previous: string; text: string; saving: boolean }

const MAX_NOTE_NAME = 200;

function suggestedFolderName(application: NotesApplication) {
  const company = Array.from(application.company.trim());
  const title = Array.from(application.title.trim());
  if (!company.length || !title.length) return [...company, ...title].slice(0, MAX_NOTE_NAME).join("");
  const separator = " · ";
  const budget = MAX_NOTE_NAME - separator.length;
  const companyLimit = Math.min(company.length, Math.max(Math.ceil(budget / 2), budget - title.length));
  return company.slice(0, companyLimit).join("") + separator + title.slice(0, budget - companyLimit).join("");
}

const notesIcons = {
  book: '<path d="M5 19V6a2 2 0 0 1 2-2h12v16H7a2 2 0 0 1 0-4h12M9 8h6m-6 4h4"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  document: '<path d="M7 3h7l4 4v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm7 0v5h4m-9 4h5m-5 4h5"/>',
  calendar: '<rect x="4" y="6" width="16" height="14" rx="2"/><path d="M8 4v4m8-4v4M4 10h16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3m8 0h3a1 1 0 0 1 1 1v3m0 8v3a1 1 0 0 1-1 1h-3m-8 0H5a1 1 0 0 1-1-1v-3M8 9h8m-8 3h8m-8 3h5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  edit: '<path d="m14 6 4 4m-13 9 4-1L20 7a1.4 1.4 0 0 0 0-2l-1-1a1.4 1.4 0 0 0-2 0L6 15l-1 4Z"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  chevron: '<path d="m7 10 5 5 5-5"/>',
  expand: '<path d="M14 5h5v5m0-5-7 7M10 19H5v-5m0 5 7-7"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  undo: '<path d="m8 5-5 5 5 5m-5-5h11a5 5 0 0 1 5 5v3"/>',
  redo: '<path d="m16 5 5 5-5 5m5-5H10a5 5 0 0 0-5 5v3"/>',
  bullet: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
  numbered: '<path d="M10 6h10M10 12h10M10 18h10M3 4h1v4m-1 0h2m-2 5a1.4 1.4 0 1 1 2.2 1L3 17h3"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.3"/><path d="m3 16 5-4 4 3 4-5 5 6"/>',
  highlight: '<path d="m6 16-2 4 4-1 11-11a2 2 0 0 0-4-4L6 16Zm6-6 4 4"/>',
};

function notesIcon(name: keyof typeof notesIcons) {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("class", "icon");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = notesIcons[name];
  return icon;
}

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

function formatNoteDate(date: string, withYear = false) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const [, year, month, day] = match;
  return `${withYear ? `${year} 年 ` : ""}${Number(month)} 月 ${Number(day)} 日`;
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
  const skipAttachments = !node.closest("[data-note-file]");
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
    acceptNode: text => skipAttachments && text.parentElement?.closest("[data-note-file]")
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
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
    <div class="notes-workspace-heading">
      <span class="notes-workspace-icon"></span>
      <div>
        <h1 class="notes-workspace-title">笔面试心得</h1>
        <p>记录遇到的问题、自己的作答和下次想改进的地方</p>
      </div>
    </div>
    <div class="notes-shell">
      <aside class="notes-sidebar" aria-label="心得文件夹">
        <div class="notes-tools"></div>
        <div class="notes-list"></div>
      </aside>
      <article class="notes-detail" aria-label="心得正文" tabindex="-1"></article>
    </div>
    <p class="notes-status muted" role="status"></p>
  `;
  root.querySelector(".notes-workspace-icon")?.append(notesIcon("book"));
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
  const ocrQueue = new Map<string, OcrJob>();
  const ocrCandidates = new Map<string, OcrCandidate>();
  let ocrRunning = false;
  let activeOcr: { id: string; epoch: string } | undefined;
  let index: Index = { epoch: "", folders: [], notes: [] };
  let selectedFolder: string | undefined;
  let selectedNote: string | undefined;
  let mode: "tree" | "favorites" | "recycled" = "tree";
  let edit: Edit | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let saving: Promise<boolean> | undefined;
  let transitioning = false;
  let replacingArchive = false;
  let detailRequest = 0;
  let indexRequest = 0;
  let appliedIndex = 0;
  let currentBody: string | undefined;
  let readerQuery = "";
  let syncImageMatches: (() => void) | undefined;
  let drag: { pointer: number; id: string; x: number; y: number; preview?: HTMLElement; target?: string } | undefined;
  let dropIndicator: HTMLElement | undefined;
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
  const favoriteMode = button("☆ 收藏", () => {
    mode = mode === "favorites" ? "tree" : "favorites";
    search.value = "";
    search.dispatchEvent(new Event("input"));
  });
  favoriteMode.setAttribute("aria-label", "收藏");
  const recycleMode = button("回收站", () => { mode = mode === "recycled" ? "tree" : "recycled"; renderList(); });
  const allMode = button("全部", () => {
    mode = "tree";
    search.value = "";
    search.dispatchEvent(new Event("input"));
  });
  const toolsHeading = element("div", undefined, "notes-sidebar-heading");
  const newFolder = button("新建", () => void openFolderForm(), "notes-new-folder");
  newFolder.setAttribute("aria-label", "新建文件夹");
  newFolder.prepend(notesIcon("plus"));
  toolsHeading.append(element("strong", "心得文件夹"), newFolder);
  const filters = element("div", undefined, "notes-filters");
  filters.append(allMode, favoriteMode, recycleMode);
  const searchBox = element("label", undefined, "notes-search");
  searchBox.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>';
  searchBox.append(search);
  tools.append(toolsHeading, searchBox, filters);

  search.addEventListener("input", () => {
    renderList();
    const item = note(selectedNote);
    if (readerQuery && readerQuery !== query() && !edit && item && currentBody !== undefined) {
      renderRead(item, currentBody, false);
    }
  });

  async function refreshIndex() {
    const request = ++indexRequest;
    const result = await invoke<Index>("note_index_cmd");
    if (request < appliedIndex) return;
    appliedIndex = request;
    const previous = index.epoch;
    index = result;
    if (previous !== index.epoch) {
      expanded.clear();
      const prefs = readHistory<{ expanded?: string[]; selected?: string }>(`notes:workspace:${index.epoch}`, {});
      if (Array.isArray(prefs.expanded)) {
        for (const id of prefs.expanded) if (folder(id) && !folder(id)?.recycled) expanded.add(id);
      }
      const remembered = note(prefs.selected);
      selectedNote = remembered && !remembered.recycled && !folder(remembered.folderId)?.recycled ? remembered.id : undefined;
      selectedFolder = note(selectedNote)?.folderId;
    }
    if (previous && previous !== index.epoch) {
      fileCache.clear();
      ocrFailures.clear();
      ocrQueue.clear();
      ocrCandidates.clear();
    }
    renderList();
  }

  function rememberWorkspace() {
    if (index.epoch) writeHistory(`notes:workspace:${index.epoch}`, { expanded: [...expanded], selected: selectedNote });
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

  function renderNoteItem(item: Note, snippet?: string, imageHits = 0) {
    const row = button("", () => withTransition(async () => {
      if (await finishEdit()) await readNote(item.id, Boolean(query()));
    }), "notes-item");
    row.setAttribute("aria-current", String(selectedNote === item.id));
    const parent = folder(item.folderId);
    const imageCount = item.files.filter(file => file.mime.startsWith("image/")).length;
    const title = element("span", undefined, "notes-item-title");
    title.append(element("strong", noteTitle(item)));
    if (item.favorite) {
      const star = element("span", "★", "notes-favorite-star");
      star.setAttribute("role", "img");
      star.setAttribute("aria-label", "已收藏");
      star.title = "已收藏";
      title.append(star);
    }
    const icon = element("span", undefined, "notes-item-icon");
    icon.append(notesIcon("document"));
    const summary = element("span", undefined, "notes-item-summary");
    summary.append(title, element("small", [formatNoteDate(item.recordDate), snippet === undefined ? "" : parent?.name,
      snippet === undefined && imageCount ? `${imageCount} 张图片` : ""].filter(Boolean).join(" · ")));
    if (imageHits) summary.append(element("span", `图片命中 · ${imageHits} 张`, "notes-match-tag"));
    if (snippet) summary.append(element("small", snippet));
    row.append(icon, summary);
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
    allMode.setAttribute("aria-pressed", String(mode === "tree"));
    favoriteMode.setAttribute("aria-pressed", String(mode === "favorites"));
    recycleMode.setAttribute("aria-pressed", String(mode === "recycled"));
    list.replaceChildren();
    const q = query();
    const isRecycled = (item: Note) => item.recycled || folder(item.folderId)?.recycled;
    const favorites = index.notes.filter(item => item.favorite && !isRecycled(item));
    favoriteMode.textContent = favorites.length ? `☆ 收藏 ${favorites.length}` : "☆ 收藏";
    favoriteMode.title = `${favorites.length} 篇收藏`;
    const notes = mode === "favorites" ? favorites
      : index.notes.filter(item => Boolean(isRecycled(item)) === (mode === "recycled"));
    if (q || mode === "favorites") {
      const rows = document.createDocumentFragment();
      for (const item of notes) {
        const parent = folder(item.folderId);
        const imageMatches = q ? item.files.filter(file => file.mime.startsWith("image/") && file.ocrText?.toLowerCase().includes(q)) : [];
        const fields = [noteTitle(item), item.plainText, parent?.name, parent?.company, parent?.position, ...item.files.map(file => file.name)];
        const match = q ? imageMatches[0]?.ocrText ?? fields.find(value => value?.toLowerCase().includes(q)) : "";
        if (q && !match) continue;
        const at = match?.toLowerCase().indexOf(q) ?? 0;
        const snippet = match ? match.slice(Math.max(0, at - 28), at + q.length + 48).replace(/\s+/g, " ") : "";
        rows.append(renderNoteItem(item, snippet, imageMatches.length));
      }
      const count = rows.childElementCount;
      if (q && count) list.append(element("p", `找到 ${count} 篇心得`, "notes-result-count"));
      list.append(rows);
      if (!count) list.append(element("p", q ? "没有匹配的心得。" : "还没有收藏。", "muted"));
      return;
    }
    for (const parent of index.folders) {
      const children = notes.filter(item => item.folderId === parent.id);
      if (mode === "recycled" ? !parent.recycled && !children.length : parent.recycled) continue;
      const group = element("section", undefined, "notes-folder");
      group.dataset.folderId = parent.id;
      const header = element("div", undefined, "notes-folder-header");
      if (selectedFolder === parent.id) header.dataset.current = "true";
      const isOpen = expanded.has(parent.id) || mode === "recycled";
      const title = button("", () => {
        if (mode !== "recycled") {
          if (expanded.has(parent.id)) expanded.delete(parent.id);
          else expanded.add(parent.id);
          rememberWorkspace();
        }
        if (!selectedNote && !edit) {
          selectedFolder = parent.id;
          renderEmpty();
        }
        renderList();
      });
      title.setAttribute("aria-expanded", String(isOpen));
      const chevron = element("span", "▸", "notes-folder-chevron");
      chevron.setAttribute("aria-hidden", "true");
      title.append(chevron, notesIcon("folder"), element("span", parent.name));
      header.append(title, element("span", String(children.length), "notes-folder-count"));
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
        hover = setTimeout(() => { expanded.add(accepted.id); rememberWorkspace(); renderList(); }, 550);
      }
    }
    if (accepted) target?.classList.add("notes-drop-target");
  });
  function finishDrag(event: PointerEvent, dropped: boolean) {
    if (drag?.pointer !== event.pointerId) return;
    const item = note(drag.id);
    const target = drag.preview ? folder(drag.target) : undefined;
    const epoch = index.epoch;
    cancelDrag();
    setTimeout(() => { suppressNoteClick = false; }, 0);
    if (dropped && item && target) {
      withTransition(async () => {
        if (!(await finishEdit())) return;
        try { await moveNote(item.id, target.id, epoch); }
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

  function notesDocument(content: HTMLElement) {
    const scroll = element("div", undefined, "notes-document-scroll");
    scroll.append(content);
    return scroll;
  }

  function notesBreadcrumb(parent: Folder) {
    const crumb = element("p", parent.name, "notes-breadcrumb");
    crumb.prepend(notesIcon("folder"));
    return crumb;
  }

  function renderEmpty() {
    root.append(status);
    readerQuery = "";
    syncImageMatches = undefined;
    currentBody = undefined;
    const parent = folder(selectedFolder);
    const empty = element("div", undefined, "notes-empty");
    const icon = element("span", undefined, "notes-empty-icon");
    icon.append(notesIcon("book"));
    empty.append(icon, element("h2", parent?.name || "打开一篇心得"));
    if (parent) appendApplication(empty, parent);
    if (parent && !parent.recycled) {
      empty.append(element("p", "选择已有心得，也可以为这次笔面试写一篇新的。"));
      const actions = element("div", undefined, "notes-actions");
      const write = button("写心得", () => void startNew(parent), "primary");
      write.prepend(notesIcon("plus"));
      actions.append(write);
      appendImport(actions, parent);
      empty.append(actions);
    } else {
      empty.append(element("p", "从左侧选择一篇心得，或新建文件夹开始记录。"));
    }
    detail.replaceChildren(empty);
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
    if (!item.recycled && !folder(item.folderId)?.recycled) rememberWorkspace();
    renderList();
    root.append(status);
    readerQuery = "";
    syncImageMatches = undefined;
    detail.replaceChildren(element("p", "正在读取心得…", "muted"));
    currentBody = undefined;
    try {
      const body = await invoke<string>("note_body_cmd", { epoch: index.epoch, id });
      if (request !== detailRequest) return;
      currentBody = body;
      const current = note(id) ?? item;
      renderRead(current, body, find);
      queueOcr(current);
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
    root.append(status);
    readerQuery = find ? query() : "";
    const q = readerQuery;
    const head = element("div", undefined, "notes-read-header");
    const heading = element("div", undefined, "notes-heading");
    const context = element("div");
    const metadata = element("div", undefined, "notes-meta");
    const date = element("time", formatNoteDate(item.recordDate, true));
    date.dateTime = item.recordDate;
    metadata.append(notesIcon("calendar"), date);
    appendApplication(metadata, parent);
    context.append(notesBreadcrumb(parent), element("h2", noteTitle(item)), metadata);
    const actions = element("div", undefined, "notes-actions");
    if (item.recycled) {
      actions.append(button("恢复心得", () => withTransition(async () => {
        await change({ kind: "recycleNote", id: item.id, recycled: false });
        await refreshIndex();
        await readNote(item.id);
      })));
    } else if (!parent.recycled) {
      const favorite = button(item.favorite ? "★" : "☆", () => withTransition(async () => {
        await change({ kind: "favorite", id: item.id, favorite: !item.favorite });
        await refreshIndex();
        await readNote(item.id, Boolean(q));
      }));
      favorite.title = item.favorite ? "取消收藏" : "收藏";
      favorite.setAttribute("aria-label", favorite.title);
      favorite.setAttribute("aria-pressed", String(item.favorite));
      const more = element("details", undefined, "notes-menu notes-reader-menu");
      const menuLabel = element("summary", "⋯");
      menuLabel.setAttribute("aria-label", "更多心得操作");
      const menu = element("div");
      menu.append(
        button("移动到…", () => { more.open = false; void openMove(item); }),
        button("移到回收站", () => {
          more.open = false;
          withTransition(async () => {
            const confirmed = await openSettingsDialog({
              title: "回收心得", intro: "可以从心得回收站恢复。", confirmLabel: "移到回收站",
              action: async () => { await change({ kind: "recycleNote", id: item.id, recycled: true }); },
            });
            if (!confirmed) return;
            selectedNote = undefined;
            rememberWorkspace();
            await refreshIndex();
            renderEmpty();
          });
        }),
      );
      appendImport(menu, parent, () => { more.open = false; });
      more.append(menuLabel, menu);
      const editNote = button("编辑", () => showEditor(parent, item, body), "primary");
      editNote.prepend(notesIcon("edit"));
      actions.append(favorite, more, editNote);
    }
    heading.append(context, actions);
    head.append(heading);
    const article = element("div", undefined, "notes-body notes-article");
    const fileById = new Map(item.files.map(file => [file.id, file]));
    article.append(safeBody(body, new Set(fileById.keys())));
    const loading = Array.from(article.querySelectorAll<HTMLElement>("[data-note-file]"), marker =>
      fillMarker(marker, fileById.get(marker.dataset.noteFile!)!));
    if (q) highlight(article, q);
    const hitBar = element("div", undefined, "notes-hit-bar");
    const hitCount = element("strong", "", "notes-hit-count");
    const hitNav = element("div");
    let hits: HTMLElement[] = [];
    let active = 0;
    function selectHit(next: number, scrollToImage: boolean) {
      active = next;
      for (const marker of article.querySelectorAll("[data-ocr-hit]")) marker.removeAttribute("data-ocr-hit");
      const target = hits[active];
      if (target) {
        target.dataset.ocrHit = "true";
        if (scrollToImage) target.scrollIntoView({ block: "nearest" });
      }
      hitCount.textContent = hits.length ? `图片 ${active + 1} / ${hits.length}` : "";
      hitNav.hidden = !hits.length;
      previousHit.disabled = active === 0;
      nextHit.disabled = active >= hits.length - 1;
    }
    const previousHit = button("↑", () => selectHit(active - 1, true));
    const nextHit = button("↓", () => selectHit(active + 1, true));
    previousHit.setAttribute("aria-label", "上一张命中图片");
    nextHit.setAttribute("aria-label", "下一张命中图片");
    hitNav.append(previousHit, hitCount, nextHit);
    if (q) {
      hitBar.append(element("span", `搜索定位 · ${q}`), hitNav);
      head.append(hitBar);
    }
    syncImageMatches = q ? () => {
      const files = note(item.id)?.files ?? item.files;
      const matchingIds = new Set(files.filter(file => file.ocrText?.toLowerCase().includes(q)).map(file => file.id));
      const previous = hits[active];
      hits = Array.from(article.querySelectorAll<HTMLElement>("[data-note-file]")).filter(marker => matchingIds.has(marker.dataset.noteFile!));
      selectHit(Math.max(0, hits.indexOf(previous)), false);
    } : undefined;
    const scrollPane = notesDocument(article);
    detail.replaceChildren(head, scrollPane);
    if (q) detail.append(element("p", "可点击原图下方的「识别文字」查看和校正。", "notes-document-footer"));
    syncImageMatches?.();
    const readingKey = `notes:reading:${item.id}`;
    const remembered = q ? 0 : readHistory(readingKey, 0);
    let scroll = 0;
    let scrolled = false;
    scrollPane.onscroll = () => {
      if (scrollPane.scrollTop !== scroll) scrolled = true;
      if (!q) writeHistory(readingKey, scrollPane.scrollTop);
    };
    writeHistory(`notes:last:${item.folderId}`, item.id);
    const textHit = article.querySelector("mark");
    function restorePosition() {
      if (hits.length) selectHit(active, true);
      else if (textHit) textHit.scrollIntoView({ block: "nearest" });
      else scrollPane.scrollTop = remembered;
      scroll = scrollPane.scrollTop;
    }
    restorePosition();
    void Promise.all(loading).then(() => {
      if (article.isConnected && !scrolled) restorePosition();
    });
    if (q && !hits.length && !textHit) highlight(context, q);
  }

  function previewImage(src: string, name: string) {
    const modal = element("dialog", undefined, "notes-image-dialog");
    modal.setAttribute("aria-label", `原图预览 ${name}`);
    const tools = element("div", undefined, "notes-zoom-tools");
    const viewport = element("div", undefined, "notes-zoom-viewport");
    const image = element("img");
    image.alt = name;
    image.draggable = false;
    const scale = element("span", "适应窗口");
    let zoom = 1;
    function resize(value: number) {
      if (!image.naturalWidth || !image.naturalHeight) return;
      zoom = Math.min(4, Math.max(0.01, value));
      image.style.width = `${image.naturalWidth * zoom}px`;
      scale.textContent = `${Math.round(zoom * 100)}%`;
    }
    function fit() {
      resize(Math.min(1, (viewport.clientWidth - 32) / image.naturalWidth, (viewport.clientHeight - 32) / image.naturalHeight));
      viewport.scrollTo(0, 0);
    }
    const less = button("−", () => resize(zoom / 1.25));
    const more = button("＋", () => resize(zoom * 1.25));
    less.setAttribute("aria-label", "缩小");
    more.setAttribute("aria-label", "放大");
    tools.append(less, scale, more, button("适应窗口", fit), button("原始大小", () => resize(1)), button("关闭", () => modal.close()));
    let pan: { id: number; x: number; y: number; left: number; top: number } | undefined;
    viewport.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      pan = { id: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
      viewport.setPointerCapture(event.pointerId);
    });
    viewport.addEventListener("pointermove", event => {
      if (event.pointerId === pan?.id) viewport.scrollTo(pan.left + pan.x - event.clientX, pan.top + pan.y - event.clientY);
    });
    viewport.addEventListener("lostpointercapture", () => { pan = undefined; });
    viewport.append(image);
    modal.append(tools, viewport);
    modal.addEventListener("close", () => modal.remove(), { once: true });
    image.addEventListener("load", fit, { once: true });
    root.append(modal);
    modal.showModal();
    image.src = src;
  }

  function fillMarker(marker: HTMLElement, file: StoredFile, editing?: Edit, remove?: () => void) {
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
      if (!editing) appendOcr(marker, file);
      else {
        const caption = element("div", undefined, "notes-attachment-caption");
        caption.append(element("span", file.name, "notes-file-caption"), button("查看原图 ↗", () => show.click()));
        if (remove) caption.append(button("移除附件", remove));
        marker.append(caption);
      }
    }
    if (remove && file.mime === "application/pdf") marker.append(button("移除附件", remove));
    return ready;
  }

  function appendOcr(marker: HTMLElement, file: StoredFile, open = false) {
    const caption = element("div", undefined, "notes-attachment-caption notes-ocr-caption");
    const content = element("div", undefined, "notes-ocr-content");
    content.hidden = !open;
    caption.dataset.expanded = String(open);
    const label = button("识别文字", () => {
      content.hidden = !content.hidden;
      caption.dataset.expanded = String(!content.hidden);
      label.setAttribute("aria-expanded", String(!content.hidden));
    }, "notes-ocr-toggle");
    label.prepend(notesIcon("scan"));
    label.append(notesIcon("chevron"));
    label.setAttribute("aria-expanded", String(open));
    const original = button("查看原图", () => marker.querySelector<HTMLButtonElement>(".notes-image")?.click());
    original.append(notesIcon("expand"));
    caption.append(element("span", file.name, "notes-file-caption"), label, original);

    const epoch = index.epoch;
    const busy = isRecognizing(file.id);
    const failure = ocrFailures.get(file.id);
    const candidate = ocrCandidates.get(file.id);
    const result = element("p", file.ocrText ?? "", "notes-ocr-result");
    result.hidden = !file.ocrText;
    if (readerQuery) highlight(result, readerQuery);
    const state = candidate?.saving ? "正在替换…"
      : busy ? (file.ocrText ? "正在重新识别…" : "正在识别…")
      : failure ?? (file.ocrText === "" ? "未识别到文字。" : file.ocrText === null ? "等待识别。" : "");
    const stateLine = element("p", state, "notes-ocr-state");
    stateLine.hidden = !state;
    if (!busy && failure) stateLine.dataset.tone = "error";
    stateLine.setAttribute("role", "status");

    const read = element("div");
    const head = element("div", undefined, "notes-ocr-header");
    const title = element("h4", "识别结果", "notes-ocr-title");
    title.prepend(notesIcon("scan"));
    const actions = element("div", undefined, "notes-ocr-actions");
    head.append(title, actions);
    read.append(head, stateLine, result);
    content.append(read);

    if (file.ocrText) {
      const copy = button("复制文字", () => {
        void navigator.clipboard.writeText(file.ocrText!).then(() => {
          copy.replaceChildren(notesIcon("check"), "已复制");
          notify("已复制图片文字。");
          window.setTimeout(() => copy.replaceChildren(notesIcon("copy"), "复制文字"), 1600);
        }).catch(fail);
      }, "primary notes-ocr-copy");
      copy.prepend(notesIcon("copy"));
      actions.append(copy);
    }

    if (candidate) {
      const review = element("div", undefined, "notes-ocr-candidate");
      const keep = button("保留当前文字", () => {
        ocrCandidates.delete(file.id);
        ocrFailures.delete(file.id);
        refreshOcrPanels();
        marker.querySelector<HTMLElement>(".notes-ocr-toggle")?.focus();
      });
      const replace = button("替换为新结果", () => {
        if (candidate.saving || ocrCandidates.get(file.id) !== candidate || epoch !== index.epoch) return;
        const latest = note(selectedNote)?.files.find(entry => entry.id === file.id);
        if (!latest || latest.ocrText !== candidate.previous) {
          ocrCandidates.delete(file.id);
          ocrFailures.set(file.id, "当前文字已更新，请重新识别。");
          refreshOcrPanels();
          return;
        }
        candidate.saving = true;
        ocrFailures.delete(file.id);
        refreshOcrPanels();
        void (async () => {
          try {
            await change({ kind: "ocr", id: file.id, text: candidate.text }, epoch);
            if (ocrCandidates.get(file.id) === candidate) {
              ocrCandidates.delete(file.id);
              await refreshIndex();
            }
          } catch (error) {
            if (epoch === index.epoch) ocrFailures.set(file.id, describeDialogError(error));
          } finally {
            candidate.saving = false;
            refreshOcrPanels();
          }
        })();
      }, "primary");
      keep.disabled = replace.disabled = candidate.saving;
      const controls = element("div", undefined, "notes-ocr-edit-actions");
      controls.append(keep, replace);
      review.append(
        element("h4", "本次识别结果", "notes-ocr-title"),
        element("p", candidate.text || "本次未识别到文字，替换会清空当前结果。", "notes-ocr-result"),
        controls,
      );
      read.append(review);
      marker.append(caption, content);
      return;
    }

    const retry = button("重新识别", () => {
      ocrFailures.delete(file.id);
      ocrQueue.set(file.id, { epoch, previous: file.ocrText });
      void runOcr();
    });
    retry.disabled = busy;
    if (file.ocrText !== null && !busy) {
      const correct = button("校正", () => {
        const epoch = index.epoch;
        const text = element("textarea");
        text.value = file.ocrText ?? "";
        text.setAttribute("aria-label", "校正图片中的文字");
        text.rows = Math.max(4, Math.min(14, text.value.split("\n").length + 1));
        const editStatus = element("span", "", "notes-ocr-edit-status");
        editStatus.setAttribute("role", "status");
        const cancel = button("取消", () => {
          delete marker.dataset.ocrEditing;
          content.replaceChildren(read);
          correct.focus();
        });
        const save = button("保存校正", () => {
          save.disabled = cancel.disabled = true;
          text.readOnly = true;
          editStatus.textContent = "正在保存…";
          const corrected = text.value;
          void change({ kind: "ocr", id: file.id, text: corrected.trim() ? corrected : "" }, epoch).then(async () => {
            delete marker.dataset.ocrEditing;
            await refreshIndex();
            refreshOcrPanels();
            marker.querySelector<HTMLElement>(".notes-ocr-toggle")?.focus();
            notify("图片文字已校正");
          }).catch(error => {
            marker.dataset.ocrEditing = "true";
            editStatus.textContent = describeDialogError(error);
            text.readOnly = false;
            save.disabled = cancel.disabled = false;
          });
        }, "primary");
        marker.dataset.ocrEditing = "true";
        const editTitle = element("h4", "校正识别文字", "notes-ocr-title");
        editTitle.prepend(notesIcon("edit"));
        const controls = element("div", undefined, "notes-ocr-edit-actions");
        controls.append(editStatus, cancel, save);
        content.replaceChildren(editTitle, text, controls);
        text.focus();
      }, "notes-ocr-secondary");
      correct.prepend(notesIcon("edit"));
      correct.setAttribute("aria-label", "校正识别文字");
      actions.append(correct);
    }

    if (file.ocrText) {
      const more = element("details", undefined, "notes-menu notes-ocr-menu");
      const summary = element("summary");
      summary.setAttribute("aria-label", "更多识别操作");
      summary.title = "更多识别操作";
      summary.append(notesIcon("more"));
      const menu = element("div");
      const item = note(selectedNote);
      const parent = folder(item?.folderId);
      if (item && parent && !item.recycled && !parent.recycled && currentBody !== undefined) {
        menu.append(button("插入正文", () => {
          showEditor(parent, item, currentBody!);
          if (edit) edit.editor.chain().focus().insertContent(textFragmentHtml(file.ocrText!)).run();
        }));
      }
      menu.append(retry);
      more.append(summary, menu);
      actions.append(more);
    } else if (!busy) {
      actions.append(retry);
    }
    marker.append(caption, content);
  }

  function refreshOcrPanels() {
    if (edit) return;
    const item = note(selectedNote);
    if (!item) return;
    for (const marker of detail.querySelectorAll<HTMLElement>("[data-note-file]")) {
      const file = item.files.find(entry => entry.id === marker.dataset.noteFile);
      if (!file?.mime.startsWith("image/") || marker.dataset.ocrEditing) continue;
      const previous = marker.querySelector<HTMLElement>(".notes-ocr-content");
      const open = Boolean(previous && !previous.hidden);
      previous?.remove();
      marker.querySelector(".notes-attachment-caption")?.remove();
      appendOcr(marker, file, open);
    }
    syncImageMatches?.();
  }

  function queueOcr(item: Note) {
    for (const file of item.files) {
      if (file.mime.startsWith("image/") && file.ocrText === null && !ocrFailures.has(file.id) && !isRecognizing(file.id)) {
        ocrQueue.set(file.id, { epoch: index.epoch, previous: null });
      }
    }
    void runOcr();
  }

  function isRecognizing(id: string) {
    return (activeOcr?.id === id && activeOcr.epoch === index.epoch) || ocrQueue.has(id);
  }

  async function runOcr() {
    if (ocrRunning) return;
    ocrRunning = true;
    try {
      for (const [id, { epoch, previous }] of ocrQueue) {
        ocrQueue.delete(id);
        activeOcr = { id, epoch };
        refreshOcrPanels();
        try {
          const [file, { recognizeImage }] = await Promise.all([openStoredFile(id, epoch), import("./ocr.ts")]);
          const text = await recognizeImage(dataUrl(file));
          if (epoch !== index.epoch) continue;
          if (previous === null) {
            await change({ kind: "ocr", id, text }, epoch);
            await refreshIndex();
          } else {
            ocrCandidates.set(id, { previous, text, saving: false });
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

  function pasteNote(session: Edit, event: ClipboardEvent) {
    const clipboard = event.clipboardData;
    if (!clipboard) return false;
    const files = Array.from(clipboard.files).filter(file => file.type.startsWith("image/"));
    const html = clipboard.getData("text/html");
    if (!html && !files.length) {
      session.pasteNotice.textContent = "";
      return false;
    }

    const paste: PasteInsertion = { fragment: document.createDocumentFragment(), oversize: 0, capacity: 0, unreadable: 0 };
    const uploads: PendingFile[] = [];
    let embedded = false;
    let bytes = 0;
    paste.fragment = safeBody(html, new Set(), image => {
      const src = image.getAttribute("src") ?? "";
      const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(src);
      if (!match || match[2].length % 4) {
        paste.unreadable++;
        return document.createDocumentFragment();
      }
      const [, mime, base64] = match;
      embedded = true;
      const size = Math.floor(base64.replace(/=+$/, "").length * 3 / 4);
      if (size > MAX_FILE_BYTES) {
        paste.oversize++;
        return document.createDocumentFragment();
      }
      if (uploads.length >= MAX_FILES || bytes + size > MAX_BATCH_BYTES) {
        paste.capacity++;
        return document.createDocumentFragment();
      }
      // Check the file signature and the last Base64 quantum without decoding
      // the full clipboard image just to validate it.
      const tail = base64.slice(-4);
      if (fileMimeFromHeader(atob(base64.slice(0, 16))) !== mime || btoa(atob(tail)) !== tail) {
        paste.unreadable++;
        return document.createDocumentFragment();
      }
      const file: PendingFile = { id: crypto.randomUUID(), name: image.alt || "粘贴的图片", mime, base64, size };
      uploads.push(file);
      bytes += size;
      return fileMarker(file.id);
    });

    if (files.length && !embedded) {
      // Some pasteboards provide HTML for the text and a separate file list for
      // the images. Keep the text and use those files instead of HTML URLs.
      paste.unreadable = 0;
      queueFiles(session, async () => {
        const images: PendingFile[] = [];
        let total = 0;
        for (const file of files) {
          if (file.size > MAX_FILE_BYTES) { paste.oversize++; continue; }
          if (images.length >= MAX_FILES || total + file.size > MAX_BATCH_BYTES) { paste.capacity++; continue; }
          try {
            const [image] = await loadImages([file]);
            images.push(image);
            total += image.size;
            paste.fragment.append(fileMarker(image.id));
          } catch {
            paste.unreadable++;
          }
        }
        return images;
      }, undefined, paste);
    } else {
      if (!paste.fragment.childElementCount && !paste.fragment.textContent?.trim()) {
        const plain = clipboard.getData("text/plain");
        if (plain) paste.fragment.append(textFragment(plain));
      }
      queueFiles(session, async () => uploads, undefined, paste);
    }
    return true;
  }

  function textFragmentHtml(text: string) {
    const buffer = element("div");
    buffer.append(textFragment(text));
    return buffer.innerHTML;
  }

  function editorToolbar(session: Edit) {
    const { editor } = session;
    const toolbar = element("div", undefined, "notes-format-toolbar");
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "正文排版");
    const controls: (() => void)[] = [];

    function tool(label: string, run: () => unknown, icon: string | SVGSVGElement, active?: () => boolean, enabled?: () => boolean) {
      const control = button("", () => { more.open = false; run(); });
      control.append(icon);
      control.title = label;
      control.setAttribute("aria-label", label);
      // Keep the document selection while clicking a format command.
      control.addEventListener("mousedown", event => event.preventDefault());
      controls.push(() => {
        if (active) control.setAttribute("aria-pressed", String(active()));
        if (enabled) control.disabled = !enabled();
      });
      return control;
    }

    function choose(label: string, values: [string, string][], apply: (value: string) => void) {
      const select = element("select");
      select.setAttribute("aria-label", label);
      select.title = label;
      for (const [value, caption] of values) select.append(new Option(caption, value));
      select.addEventListener("change", () => { more.open = false; apply(select.value); });
      return select;
    }

    function palette(label: string, icon: string | SVGSVGElement, colors: readonly (readonly [string, string])[],
      attribute: "color" | "backgroundColor", apply: (color: string) => void) {
      const menu = element("details", undefined, "notes-menu notes-format-palette");
      const trigger = element("summary");
      trigger.append(icon, notesIcon("chevron"));
      trigger.setAttribute("aria-label", label);
      trigger.title = label;
      const options = element("div", undefined, "notes-format-palette-options");
      const swatches = element("div", undefined, "notes-format-swatches");
      const current = () => noteColor(editor.getAttributes("textStyle")[attribute] || "");
      for (const [color, name] of colors) {
        const swatch = button("", () => {
          menu.open = false;
          apply(color);
        });
        swatch.title = name;
        swatch.setAttribute("aria-label", name);
        swatch.style.setProperty("--swatch", color);
        controls.push(() => swatch.setAttribute("aria-pressed", String(current() === color)));
        swatches.append(swatch);
      }
      options.append(swatches, button(attribute === "color" ? "默认颜色" : "清除高亮", () => {
        menu.open = false;
        apply("");
      }));
      menu.append(trigger, options);
      menu.addEventListener("keydown", event => {
        if (event.key !== "Escape" || !menu.open) return;
        event.preventDefault();
        menu.open = false;
        trigger.focus();
      });
      controls.push(() => trigger.style.setProperty("--swatch", current() || colors[0][0]));
      return menu;
    }

    type ToolbarItem = { id: string; label: string; control: HTMLElement };
    const groups: { element: HTMLElement; items: ToolbarItem[] }[] = [];
    const item = (id: string, label: string, control: HTMLElement): ToolbarItem => ({ id, label, control });
    function group(...items: ToolbarItem[]) {
      const container = element("div", undefined, "notes-format-group");
      container.append(...items.map(entry => entry.control));
      toolbar.append(container);
      groups.push({ element: container, items });
    }

    group(
      item("undo", "撤销", tool("撤销", () => editor.chain().focus().undo().run(), notesIcon("undo"), undefined, () => editor.can().undo())),
      item("redo", "重做", tool("重做", () => editor.chain().focus().redo().run(), notesIcon("redo"), undefined, () => editor.can().redo())),
    );
    const style = choose("段落样式", [["p", "正文"], ["h1", "标题 1"], ["h2", "标题 2"], ["h3", "标题 3"]], value => {
      if (value === "h1" || value === "h2" || value === "h3") {
        editor.chain().focus().setHeading({ level: value === "h1" ? 1 : value === "h2" ? 2 : 3 }).run();
      } else editor.chain().focus().setParagraph().run();
    });
    const font = choose("字体", noteFonts.map(([value, label]) => [value, label]), value => {
      const command = editor.chain().focus();
      if (value) command.setFontFamily(value).run();
      else command.unsetFontFamily().run();
    });
    const size = choose("文字字号", fontSizes.map(value => [value, value.replace("px", " px")]), value => {
      editor.chain().focus().setFontSize(value).run();
    });
    controls.push(() => {
      const level = editor.getAttributes("heading").level;
      const textStyle = editor.getAttributes("textStyle");
      style.value = level ? `h${level}` : "p";
      font.value = textStyle.fontFamily || "";
      size.value = textStyle.fontSize || (level === 1 ? "28px" : level === 2 ? "24px" : level ? "18px" : "16px");
    });
    group(item("style", "段落样式", style), item("font", "字体", font), item("size", "文字字号", size));
    const color = palette("字体颜色", "A", noteTextColors, "color", value => {
      const command = editor.chain().focus();
      if (value) command.setColor(value).run();
      else command.unsetColor().run();
    });
    const highlight = palette("文字高亮", notesIcon("highlight"), noteHighlights, "backgroundColor", value => {
      const command = editor.chain().focus();
      if (value) command.setBackgroundColor(value).run();
      else command.unsetBackgroundColor().run();
    });
    group(
      item("bold", "加粗", tool("加粗", () => editor.chain().focus().toggleBold().run(), "B", () => editor.isActive("bold"))),
      item("italic", "斜体", tool("斜体", () => editor.chain().focus().toggleItalic().run(), "I", () => editor.isActive("italic"))),
      item("underline", "下划线", tool("下划线", () => editor.chain().focus().toggleUnderline().run(), "U", () => editor.isActive("underline"))),
      item("strike", "删除线", tool("删除线", () => editor.chain().focus().toggleStrike().run(), "S", () => editor.isActive("strike"))),
      item("color", "字体颜色", color),
      item("highlight", "文字高亮", highlight),
    );
    const align = choose("段落对齐", [["left", "左对齐"], ["center", "居中"], ["right", "右对齐"], ["justify", "两端对齐"]], value => {
      const command = editor.chain().focus();
      for (const type of ["paragraph", "heading"]) command.updateAttributes(type, { textAlign: value === "left" ? null : value });
      command.run();
    });
    controls.push(() => {
      align.value = editor.getAttributes(editor.isActive("heading") ? "heading" : "paragraph").textAlign || "left";
    });
    group(
      item("align", "段落对齐", align),
      item("bullet", "项目列表", tool("项目列表", () => editor.chain().focus().toggleBulletList().run(), notesIcon("bullet"), () => editor.isActive("bulletList"))),
      item("ordered", "编号列表", tool("编号列表", () => editor.chain().focus().toggleOrderedList().run(), notesIcon("numbered"), () => editor.isActive("orderedList"))),
    );
    const imagePicker = fileInput(imageTypes, files => queueFiles(session, () => loadImages(files)));
    group(
      item("image", "插入图片", tool("插入图片", () => imagePicker.click(), notesIcon("image"))),
      item("code", "插入代码示例", tool("插入代码示例", () => {
        if (!insertCodeExample(editor)) notify("无法插入代码示例，请换一个位置重试。", true);
      }, "代码示例")),
    );
    toolbar.append(imagePicker);

    const more = element("details", undefined, "notes-menu notes-toolbar-menu");
    const summary = element("summary", "更多");
    summary.setAttribute("aria-label", "更多编辑工具");
    const chooser = element("div", undefined, "notes-tool-picker");
    chooser.append(element("strong", "编辑工具"), element("p", "勾选要显示在工具栏里的功能。", "muted"));
    const checks = element("div", undefined, "notes-tool-checks");
    chooser.append(checks);
    const newTools = ["font", "underline", "color", "highlight", "align"];
    const defaults = ["undo", "redo", "style", "size", "bold", "italic", "bullet", "ordered", "image", ...newTools];
    const prefKey = "notes:toolbar:v2";
    const previous = readHistory<unknown>("notes:toolbar", defaults);
    const stored = readHistory<unknown>(prefKey, Array.isArray(previous) ? [...previous, ...newTools] : defaults);
    let pinned = new Set(Array.isArray(stored) ? stored : defaults);
    const checkboxes = new Map<string, HTMLInputElement>();
    function updatePinned() {
      for (const group of groups) {
        for (const entry of group.items) {
          const visible = pinned.has(entry.id);
          entry.control.hidden = !visible;
          checkboxes.get(entry.id)!.checked = visible;
        }
        group.element.hidden = group.items.every(entry => entry.control.hidden);
      }
    }
    for (const entry of groups.flatMap(group => group.items)) {
      const checkbox = textInput("checkbox");
      checkboxes.set(entry.id, checkbox);
      const option = element("label", undefined, "notes-tool-option");
      option.append(checkbox, element("span", entry.label));
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) pinned.add(entry.id);
        else pinned.delete(entry.id);
        writeHistory(prefKey, [...pinned]);
        updatePinned();
      });
      checks.append(option);
    }
    chooser.append(button("恢复默认", () => {
      pinned = new Set(defaults);
      writeHistory(prefKey, defaults);
      updatePinned();
    }, "notes-tool-reset"));
    more.append(summary, chooser);
    toolbar.addEventListener("toggle", event => {
      if (!(event.target instanceof HTMLDetailsElement) || !event.target.open) return;
      for (const menu of toolbar.querySelectorAll("details[open]")) {
        if (menu !== event.target) (menu as HTMLDetailsElement).open = false;
      }
    }, true);
    more.addEventListener("toggle", () => {
      if (!more.open) return;
      const bottom = Math.min(detail.getBoundingClientRect().bottom, window.innerHeight);
      chooser.style.maxHeight = `${Math.max(80, bottom - chooser.getBoundingClientRect().top - 6)}px`;
    });
    more.addEventListener("keydown", event => {
      if (event.key !== "Escape" || !more.open) return;
      event.preventDefault();
      more.open = false;
      summary.focus();
    });
    toolbar.append(more);
    updatePinned();
    const update = () => controls.forEach(control => control());
    editor.on("transaction", update);
    update();
    return toolbar;
  }

  function showEditor(parent: Folder, item?: Note, body = "", suggested = "", initial: PendingFile[] = []) {
    if (replacingArchive) {
      notify("正在替换档案，请完成后再编辑心得。", true);
      return;
    }
    readerQuery = "";
    syncImageMatches = undefined;
    const host = element("div", undefined, "notes-editor-host");
    const pasteNotice = element("span", undefined, "notes-paste-notice");
    pasteNotice.setAttribute("role", "status");
    const title = textInput("text", item?.title ?? Array.from(suggested).slice(0, MAX_NOTE_NAME).join(""));
    title.maxLength = MAX_NOTE_NAME;
    title.placeholder = "心得标题（可选）";
    const date = textInput("date", item?.recordDate ?? today());
    const files = new Map((item?.files ?? []).map(file => [file.id, file]));
    for (const file of initial) files.set(file.id, { id: file.id, name: file.name, mime: file.mime, ocrText: null });
    const initialBody = element("div");
    initialBody.append(safeBody(body, new Set(files.keys())));
    const editor = createNotesEditor({
      content: initialBody.innerHTML,
      renderAttachment: (marker, id, remove) => {
        const file = files.get(id);
        if (file) fillMarker(marker, file, session, remove);
      },
      onUpdate: () => changed(session),
      onTransaction: transaction => {
        if (!transaction.docChanged) return;
        for (const point of session.insertions) {
          const { from, to } = point;
          point.from = transaction.mapping.map(from, 1);
          point.to = Math.max(point.from, transaction.mapping.map(to, -1));
        }
      },
      onPaste: event => pasteNote(session, event),
    });
    const session: Edit = {
      epoch: index.epoch, id: item?.id ?? crypto.randomUUID(), folder: parent, editor, host, title, date, revision: 0, saved: 0,
      committed: new Set(item?.files.map(file => file.id)), files, pending: new Map(initial.map(file => [file.id, file])),
      loading: Promise.resolve(), error: "", insertions: new Set(), pasteNotice,
    };
    edit = session;
    void invoke("set_note_editing_cmd", { editing: true }).catch(() => {});
    selectedNote = session.id;
    selectedFolder = parent.id;
    expanded.add(parent.id);
    rememberWorkspace();
    renderList();
    const actions = element("div", undefined, "notes-actions");
    const favorite = button(item?.favorite ? "★" : "☆", () => withTransition(async () => {
      if (!(await flush(session))) return;
      const current = note(session.id);
      if (!current) return;
      await change({ kind: "favorite", id: current.id, favorite: !current.favorite }, session.epoch);
      await refreshIndex();
      updateFavorite(!current.favorite);
    }));
    function updateFavorite(active: boolean) {
      favorite.textContent = active ? "★" : "☆";
      favorite.title = active ? "取消收藏" : "收藏";
      favorite.setAttribute("aria-label", favorite.title);
      favorite.setAttribute("aria-pressed", String(active));
    }
    updateFavorite(Boolean(item?.favorite));
    const more = element("details", undefined, "notes-menu notes-reader-menu");
    const moreLabel = element("summary", "⋯");
    moreLabel.setAttribute("aria-label", "更多心得操作");
    const menu = element("div");
    menu.append(button("立即保存", () => { more.open = false; void flush(session); }));
    more.append(moreLabel, menu);
    const done = button("完成编辑", () => withTransition(async () => {
      if (await finishEdit()) await readNote(session.id);
    }), "primary");
    done.prepend(notesIcon("check"));
    actions.append(status, favorite, more, done);
    const header = element("div", undefined, "notes-edit-header");
    const heading = element("div", undefined, "notes-heading");
    const context = element("div", undefined, "notes-edit-context");
    title.className = "notes-title-input";
    title.setAttribute("aria-label", "标题");
    date.setAttribute("aria-label", "记录日期");
    const metadata = element("div", undefined, "notes-meta");
    metadata.append(notesBreadcrumb(parent), notesIcon("calendar"), date);
    appendApplication(metadata, parent);
    context.append(title, metadata);
    heading.append(context, actions);
    header.append(heading, editorToolbar(session));
    const footer = element("p", "正文自动保存 · 可粘贴或把截图拖入正文", "notes-document-footer");
    footer.append(pasteNotice);
    const paper = notesDocument(host);
    paper.classList.add("notes-edit-surface");
    detail.replaceChildren(header, paper, footer);
    editor.mount(host);
    title.addEventListener("input", () => changed(session));
    date.addEventListener("input", () => changed(session));
    host.addEventListener("dragover", event => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      showDropIndicator(session, { x: event.clientX, y: event.clientY });
    });
    host.addEventListener("dragleave", event => {
      if (!(event.relatedTarget instanceof Node && host.contains(event.relatedTarget))) clearDropIndicator();
    });
    host.addEventListener("drop", event => {
      if (!event.dataTransfer?.files.length) return;
      event.preventDefault();
      event.stopPropagation();
      clearDropIndicator();
      const at = dropPoint(session, { x: event.clientX, y: event.clientY });
      const files = Array.from(event.dataTransfer.files);
      queueFiles(session, () => loadImages(files), at);
    }, { capture: true });
    editor.commands.focus("end");
    if (!item) changed(session);
    else notify("已保存");
  }

  function queueFiles(
    session: Edit,
    load: () => Promise<PendingFile[]>,
    at?: number,
    paste?: PasteInsertion,
  ) {
    clearTimeout(saveTimer);
    const selection = session.editor.state.selection;
    const insertion = { from: at ?? selection.from, to: at ?? selection.to };
    session.insertions.add(insertion);
    session.loading = session.loading.then(async () => {
      const files = await load();
      if (edit !== session) return;
      const present = serializeBody(session.editor.getHTML(), new Set(session.files.keys())).fileIds;
      let availableBytes = MAX_BATCH_BYTES - present.reduce((total, id) =>
        total + (session.committed.has(id) ? 0 : session.pending.get(id)?.size ?? 0), 0);
      let availableSlots = MAX_FILES - present.length;
      const accepted: PendingFile[] = [];
      for (const file of files) {
        if (availableSlots <= 0 || file.size > availableBytes) {
          if (!paste) throw new Error("每篇最多 30 个附件，每次保存最多 30 MB 新附件。");
          paste.capacity++;
          paste.fragment.querySelector(`[data-note-file="${file.id}"]`)?.remove();
          continue;
        }
        availableSlots--;
        availableBytes -= file.size;
        accepted.push(file);
      }
      for (const file of accepted) {
        session.pending.set(file.id, file);
        session.files.set(file.id, { id: file.id, name: file.name, mime: file.mime, ocrText: null });
      }
      session.insertions.delete(insertion);
      const chain = session.editor.chain().focus();
      if (paste) {
        const buffer = element("div");
        buffer.append(paste.fragment);
        if (buffer.childElementCount || buffer.textContent?.trim()) chain.insertContentAt(insertion, buffer.innerHTML).run();
        session.pasteNotice.textContent = [
          paste.oversize ? `${paste.oversize} 张图片超过 10 MB，未插入。` : "",
          paste.capacity ? `${paste.capacity} 张图片因附件数量或总大小超限，未插入。` : "",
          paste.unreadable ? `${paste.unreadable} 张图片无法直接粘贴，请单独插入。` : "",
        ].filter(Boolean).join(" ");
      } else {
        chain.insertContentAt(insertion, [
          ...accepted.map(file => ({ type: attachmentType, attrs: { fileId: file.id } })),
          { type: "paragraph" },
        ]).run();
      }
    }).catch(error => {
      if (edit === session) {
        fail(error);
        if (session.revision !== session.saved) scheduleSave(session);
      }
    }).finally(() => session.insertions.delete(insertion));
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
          const body = serializeBody(session.editor.getHTML(), new Set(session.files.keys()));
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
        notify(`保存失败：${session.error}。内容仍在编辑器中。`, true);
        status.append(" ", button("重试", () => void flush(session)));
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
    clearDropIndicator();
    session.editor.destroy();
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
        description.append(element("p", "正文里的这些图片未能匹配。可以取消，检查文件名后重新选择。"));
        const missing = element("ul");
        imported.missing.forEach(name => missing.append(element("li", name)));
        description.append(missing);
      }
      if (imported.skipped.length) {
        description.append(element("p", "以下已选文件不会导入："));
        const skipped = element("ul");
        imported.skipped.forEach(file => skipped.append(element("li", file)));
        description.append(skipped);
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
    const name = textInput("text", existing?.name ?? (application ? suggestedFolderName(application) : ""));
    name.maxLength = MAX_NOTE_NAME;
    const appSearch = textInput("search");
    appSearch.placeholder = "搜索公司、岗位或地点";
    const association = element("section", undefined, "notes-application-picker");
    const selection = element("div", undefined, "notes-application-selection");
    const searchArea = element("div", undefined, "notes-application-search");
    const results = element("ul", undefined, "notes-application-results");
    const status = element("p", undefined, "muted");
    status.setAttribute("role", "status");
    appSearch.setAttribute("aria-label", "查找投递记录");
    searchArea.append(appSearch, status, results);
    association.append(element("h3", application ? "关联到投递记录" : "关联到投递记录（可选）"), selection, searchArea);
    let selected = application ?? (existing?.applicationId ? {
      id: existing.applicationId, company: existing.company ?? "已关联申请", title: existing.position ?? "",
    } : undefined);
    let request = 0;

    function applicationDetails(candidate: NotesApplication, disambiguator = "") {
      const text = element("span", undefined, "notes-application-details");
      text.append(element("strong", candidate.company || candidate.title || "未命名投递"));
      const detail = [candidate.company && candidate.title, candidate.location, candidate.created_at?.slice(0, 10), disambiguator]
        .filter(Boolean).join(" · ");
      if (detail) text.append(element("span", detail, "muted"));
      return text;
    }

    function applicationLabel(candidate: NotesApplication) {
      return [candidate.company, candidate.title, candidate.location, candidate.created_at?.slice(0, 10)]
        .filter(Boolean).join(" · ");
    }

    function showSearch() {
      searchArea.hidden = false;
      appSearch.focus();
      void searchApplications();
    }

    function renderSelection(focusChange = false) {
      selection.replaceChildren();
      selection.hidden = !selected;
      searchArea.hidden = Boolean(selected);
      if (!selected) return;
      selection.append(notesIcon("check"), applicationDetails(selected));
      if (application) return;
      const changeApplication = button("更换", showSearch);
      const removeApplication = button("取消关联", () => {
        selected = undefined;
        appSearch.value = "";
        renderSelection();
        showSearch();
      });
      selection.append(changeApplication, removeApplication);
      if (focusChange) changeApplication.focus();
    }

    async function searchApplications(focusResults = false) {
      const token = ++request;
      const query = appSearch.value.trim();
      results.replaceChildren();
      status.textContent = query ? "正在搜索投递记录…" : "正在读取投递记录…";
      try {
        const page = await invoke<{ items: NotesApplication[]; total: number }>("list_applications_cmd", {
          args: { limit: 100, offset: 0, query },
        });
        if (token !== request) return;
        const available = page.items.filter(candidate => !index.folders.some(item =>
          !item.recycled && item.id !== existing?.id && item.applicationId === candidate.id)
          && candidate.id !== selected?.id);
        const truncated = page.total > page.items.length;
        if (available.length) {
          const counts = new Map<string, number>();
          for (const candidate of available) {
            const key = applicationLabel(candidate);
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
          for (const candidate of available) {
            const item = element("li");
            const choose = button("", () => {
              selected = candidate;
              appSearch.value = "";
              renderSelection(true);
            }, "notes-application-result");
            choose.append(applicationDetails(candidate, counts.get(applicationLabel(candidate)) === 1 ? "" : candidate.id.slice(-6)));
            item.append(choose);
            results.append(item);
          }
          status.textContent = truncated ? "显示前 100 条中的可关联记录，可继续缩小范围。" : "";
          if (focusResults && document.activeElement === appSearch) results.querySelector("button")?.focus();
        } else if (truncated) {
          status.textContent = "前 100 条中没有可选记录，请缩小搜索范围。";
        } else {
          status.textContent = page.total ? "没有其他可关联的投递记录。"
            : query ? "没有找到匹配的投递记录。" : "暂无可关联的投递记录。";
        }
      } catch (error) {
        if (token !== request) return;
        status.textContent = `投递记录读取失败：${describeDialogError(error)}`;
      }
    }

    appSearch.addEventListener("input", () => void searchApplications());
    appSearch.addEventListener("keydown", event => {
      if (!["Enter", "ArrowDown"].includes(event.key) || event.isComposing) return;
      event.preventDefault();
      const firstResult = results.querySelector("button");
      if (firstResult) firstResult.focus();
      else if (event.key === "Enter") void searchApplications(true);
    });
    results.addEventListener("keydown", event => {
      if (!(event.target instanceof HTMLButtonElement)) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        event.target.parentElement?.nextElementSibling?.querySelector("button")?.focus();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        (event.target.parentElement?.previousElementSibling?.querySelector("button") ?? appSearch).focus();
      }
    });
    form.append(field("文件夹名称", name), association);
    renderSelection();
    if (!selected) void searchApplications();
    let id: string | null = null;
    const dialog = openSettingsDialog({
      title: existing ? "编辑心得文件夹" : "新建心得文件夹", body: form, confirmLabel: existing ? "保存" : "创建",
      action: async () => {
        id = await change({ kind: "folder", id: existing?.id ?? null, name: name.value, applicationId: selected?.id ?? null });
      },
    });
    name.focus();
    const ok = await dialog;
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
      rememberWorkspace();
      if (existing && selectedNote && note(selectedNote)?.folderId === created.id) await readNote(selectedNote);
      else { selectedNote = undefined; renderList(); renderEmpty(); }
    }
  }

  function recycleFolder(parent: Folder, recycled: boolean) {
    withTransition(async () => {
      const editingId = edit?.id;
      if (!(await finishEdit())) return;
      if (editingId) await readNote(editingId);
      if (recycled) {
        const ok = await openSettingsDialog({
          title: `回收「${parent.name}」`, intro: "文件夹与其中的心得会一起保留在心得回收站。",
          confirmLabel: "移到回收站",
        });
        if (!ok) return;
      }
      await change({ kind: "recycleFolder", id: parent.id, recycled });
      const affectsSelection = selectedFolder === parent.id;
      if (affectsSelection) { selectedNote = undefined; selectedFolder = undefined; }
      if (recycled) expanded.delete(parent.id);
      rememberWorkspace();
      await refreshIndex();
      if (affectsSelection) renderEmpty();
      const restored = folder(parent.id);
      notify(recycled ? "文件夹已移到回收站。" :
        parent.applicationId && !restored?.applicationId ? "已恢复文件夹，原申请已有其他文件夹，关联已解除。" : "已恢复文件夹。");
    });
  }

  async function moveNote(id: string, targetId: string, epoch: string, undo = false) {
    if (epoch !== index.epoch) throw new Error("当前档案已切换，请重新选择心得。");
    const item = note(id);
    if (!item || item.recycled || folder(item.folderId)?.recycled) throw new Error("这篇心得已不可用，请重新选择。");
    const target = folder(targetId);
    if (!target || target.recycled) throw new Error("目标文件夹已不可用，请重新选择。");
    await change({ kind: "move", id: item.id, folderId: target.id }, epoch);
    if (epoch !== index.epoch) return;
    expanded.add(target.id);
    rememberWorkspace();
    await refreshIndex();
    if (epoch !== index.epoch) return;
    if (selectedNote) await readNote(selectedNote);
    notify(`已移到「${target.name}」`);
    const from = folder(item.folderId);
    if (!undo && from && !from.recycled) {
      status.append(" ", button("撤销", () => withTransition(async () => {
        if (!(await finishEdit())) return;
        const moved = note(item.id);
        if (index.epoch !== epoch || moved?.folderId !== target.id) return;
        await moveNote(moved.id, from.id, epoch, true);
      })));
    }
  }

  function openMove(item: Note) {
    withTransition(async () => {
      const epoch = index.epoch;
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
        action: () => moveNote(item.id, choices.value, epoch),
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
      rememberWorkspace();
      if (suggested !== undefined) { showEditor(associated, undefined, "", suggested); return; }
      const children = index.notes.filter(item => item.folderId === associated.id && !item.recycled);
      const last = readHistory<string | null>(`notes:last:${associated.id}`, null);
      const item = children.find(item => item.id === last) ?? children[0];
      if (item) await readNote(item.id);
      else { selectedNote = undefined; renderList(); renderEmpty(); }
    } catch (error) { fail(error); }
    finally { transitioning = false; }
  }

  type DropPosition = { x: number; y: number };

  function dropLocation(session: Edit, position: DropPosition) {
    const bounds = session.host.getBoundingClientRect();
    if (position.x < bounds.left || position.x > bounds.right || position.y < bounds.top || position.y > bounds.bottom) return;
    const { view } = session.editor;
    const target = view.posAtCoords({ left: position.x, top: position.y });
    const doc = view.state.doc;
    if (!target) {
      const bottom = view.dom.lastElementChild?.getBoundingClientRect().bottom ?? bounds.top;
      return { at: doc.content.size, y: Math.min(bottom, bounds.bottom) };
    }
    const resolved = doc.resolve(target.pos);
    const start = resolved.depth ? resolved.before(1) : resolved.pos;
    const node = view.nodeDOM(start);
    if (!(node instanceof Element)) return { at: start, y: position.y };
    const rect = node.getBoundingClientRect();
    const after = position.y > rect.top + rect.height / 2;
    return { at: after ? start + (doc.nodeAt(start)?.nodeSize ?? 0) : start, y: after ? rect.bottom : rect.top };
  }

  function dropPoint(session: Edit, position: DropPosition) {
    return dropLocation(session, position)?.at;
  }

  function clearDropIndicator() {
    dropIndicator?.remove();
    dropIndicator = undefined;
  }

  function showDropIndicator(session: Edit, position: DropPosition) {
    const location = dropLocation(session, position);
    if (!location) { clearDropIndicator(); return; }
    if (!dropIndicator) {
      dropIndicator = element("div", "松开插入图片", "notes-insert-line");
      dropIndicator.setAttribute("aria-hidden", "true");
      root.append(dropIndicator);
    }
    const rect = session.host.getBoundingClientRect();
    dropIndicator.style.left = `${rect.left}px`;
    dropIndicator.style.width = `${rect.width}px`;
    dropIndicator.style.top = `${location.y}px`;
  }

  function nativeDrag(position?: DropPosition) {
    if (!edit || !position || root.classList.contains("hidden")) { clearDropIndicator(); return; }
    showDropIndicator(edit, position);
  }

  function nativeDrop(token?: string, position?: DropPosition, error?: string) {
    clearDropIndicator();
    if (root.classList.contains("hidden")) return;
    const session = edit;
    if (!session) { notify("请先进入编辑，再把图片拖入正文。", true); return; }
    if (error) { notify(error, true); return; }
    if (!token) return;
    const at = position ? dropPoint(session, position) : undefined;
    if (position && at === undefined) { notify("请将图片拖到心得正文区域。", true); return; }
    // Claim immediately, before waiting for earlier insertions in the editor queue.
    const dropped = invoke<FileContents[]>("read_note_drop_cmd", { token });
    void dropped.catch(() => {});
    queueFiles(session, async () => (await dropped).map(file => ({
      ...file, id: crypto.randomUUID(), size: Math.floor(file.base64.replace(/=+$/, "").length * 3 / 4),
    })), at);
  }

  async function runArchiveReplacement<T>(replace: () => Promise<T>): Promise<T> {
    if (edit || transitioning) {
      throw Object.assign(new Error("请先结束心得编辑或操作，再替换档案。"), { code: "NOTE_ARCHIVE_EDITING" });
    }
    if (replacingArchive) {
      throw Object.assign(new Error("正在替换档案，请等待完成。"), { code: "NOTE_ARCHIVE_REPLACING" });
    }
    replacingArchive = true;
    try {
      return await replace();
    } finally {
      replacingArchive = false;
    }
  }

  function archiveReplaced() {
    ++detailRequest;
    appliedIndex = ++indexRequest;
    fileCache.clear();
    ocrFailures.clear();
    ocrQueue.clear();
    ocrCandidates.clear();
    index = { epoch: "", notes: [], folders: [] };
    selectedFolder = selectedNote = undefined;
    expanded.clear();
    renderList();
    if (edit) notify("档案已切换。请先复制编辑器中的内容，再结束编辑。", true);
    else renderEmpty();
  }

  renderEmpty();
  return { activate, confirmLeave, runArchiveReplacement, archiveReplaced, nativeDrop, nativeDrag, fail };
}
