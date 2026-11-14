export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_BATCH_BYTES = 30 * 1024 * 1024;
export const MAX_FILES = 30;
export const imageTypes = "image/png,image/jpeg,image/gif,image/webp";
export const fontSizes = ["12px", "14px", "16px", "18px", "20px", "24px", "28px", "32px"];
export const noteFonts = [
  ["", "默认字体"], ["sans-serif", "无衬线"], ["serif", "衬线"], ["monospace", "等宽"]
] as const;
export const noteAlignments = ["left", "center", "right", "justify"];
export const noteTextColors = [
  ["#000000", "黑色"], ["#d60024", "红色"], ["#d14900", "橙色"], ["#a36600", "金黄"],
  ["#00843d", "绿色"], ["#005bea", "蓝色"], ["#8a22c5", "紫色"], ["#c21875", "玫红"]
] as const;
export const noteHighlights = [
  ["#fff2a8", "黄色"], ["#ffe0bd", "橙色"], ["#f9dce9", "粉色"], ["#e8def9", "紫色"],
  ["#d8f0dc", "绿色"], ["#c6efec", "青色"], ["#d9eaff", "蓝色"], ["#e4e7ed", "浅灰"]
] as const;

// CSSOM stores solid colors as rgb(), even when the toolbar supplies hex.
export function noteColor(value: string) {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  const rgb = /^rgb\(\s*(\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})\s*\)$/i.exec(value);
  const channels = rgb?.slice(1).map(Number);
  return channels?.every(channel => channel <= 255)
    ? "#" + channels.map(channel => channel.toString(16).padStart(2, "0")).join("") : "";
}

const tags = new Set(["SPAN", "U", "S", "P", "DIV", "BR", "B", "STRONG", "I", "EM", "UL", "OL", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE", "CODE", "HR", "TABLE", "THEAD", "TBODY", "TR", "TD", "TH"]);
const hidden = new Set(["SCRIPT", "STYLE", "TEMPLATE", "IFRAME", "OBJECT", "SVG", "MATH"]);
const newlines = new Set(["P", "DIV", "BR", "LI", "PRE", "BLOCKQUOTE", "TR", "H1", "H2", "H3", "H4", "H5", "H6"]);

export interface StoredFile {
  id: string;
  name: string;
  mime: string;
  ocrText: string | null;
}

export interface FileContents {
  name: string;
  mime: string;
  base64: string;
}

export interface PendingFile extends FileContents { id: string; size: number }

export function fileMarker(id: string): HTMLDivElement {
  const marker = document.createElement("div");
  marker.dataset.noteFile = id;
  return marker;
}

/** Build a fresh DOM using only elements the editor supports. A template is inert,
 * so an image from an imported document cannot fetch its URL while we inspect it. */
export function safeBody(html: string, fileIds: ReadonlySet<string>, importImage?: (image: HTMLImageElement) => Node): DocumentFragment {
  const input = document.createElement("template");
  input.innerHTML = html;
  return copyBody(input.content.childNodes, fileIds, importImage);
}

function copyBody(nodes: NodeListOf<ChildNode>, fileIds: ReadonlySet<string>, importImage?: (image: HTMLImageElement) => Node) {
  const output = document.createDocumentFragment();
  function copy(source: Node, parent: Node) {
    if (source.nodeType === Node.TEXT_NODE) {
      parent.appendChild(document.createTextNode(source.textContent ?? ""));
      return;
    }
    if (!(source instanceof Element) || hidden.has(source.tagName.toUpperCase())) return;
    const id = source.getAttribute("data-note-file");
    if (id && fileIds.has(id)) {
      parent.appendChild(fileMarker(id));
      return;
    }
    if (source instanceof HTMLImageElement) {
      if (importImage) parent.appendChild(importImage(source));
      return;
    }
    const tag = source.tagName.toUpperCase();
    const destination = tags.has(tag) ? document.createElement(tag.toLowerCase()) : parent;
    if (tag === "SPAN" && source instanceof HTMLElement && destination instanceof HTMLElement) {
      const size = source.style.fontSize;
      if (fontSizes.includes(size)) destination.style.fontSize = size;
      const family = source.style.fontFamily;
      if (noteFonts.some(([value]) => value && family === value)) destination.style.fontFamily = family;
      const color = noteColor(source.style.color);
      if (color) destination.style.color = color;
      const highlight = noteColor(source.style.backgroundColor);
      if (highlight) destination.style.backgroundColor = highlight;
    }
    if ((tag === "P" || /^H[1-6]$/.test(tag)) && source instanceof HTMLElement && destination instanceof HTMLElement) {
      const alignment = source.style.textAlign;
      if (noteAlignments.includes(alignment)) destination.style.textAlign = alignment;
    }
    for (const child of source.childNodes) copy(child, destination);
    if (destination !== parent) parent.appendChild(destination);
  }
  for (const child of nodes) copy(child, output);
  return output;
}

export function serializeBody(html: string, ids: ReadonlySet<string>) {
  const clean = document.createElement("div");
  clean.append(safeBody(html, ids));
  const plain = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    const text = [...node.childNodes].map(plain).join("");
    return node instanceof Element && newlines.has(node.tagName) ? text + "\n" : text;
  };
  return {
    body: clean.innerHTML,
    plainText: plain(clean).trim(),
    fileIds: [...new Set([...clean.querySelectorAll<HTMLElement>("[data-note-file]")].map(node => node.dataset.noteFile!))],
  };
}

export function textFragment(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const line of text.split(/\r?\n/)) {
    const row = document.createElement("div");
    row.append(line || document.createElement("br"));
    fragment.append(row);
  }
  return fragment;
}

export function fileMimeFromHeader(header: string) {
  if (header.startsWith("\x89PNG\r\n\x1a\n")) return "image/png";
  if (header.startsWith("\xff\xd8\xff")) return "image/jpeg";
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) return "image/gif";
  if (header.startsWith("RIFF") && header.slice(8) === "WEBP") return "image/webp";
  if (header.startsWith("%PDF-")) return "application/pdf";
  return null;
}

export async function loadFile(file: File): Promise<PendingFile> {
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} 超过 10 MB。`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = fileMimeFromHeader(String.fromCharCode(...bytes.subarray(0, 12)));
  if (!mime) throw new Error(`${file.name} 不是支持的图片或 PDF。`);
  // Avoid spreading a whole screenshot onto the JS stack.
  let binary = "";
  for (let at = 0; at < bytes.length; at += 8192) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
  }
  return { id: crypto.randomUUID(), name: file.name, mime, size: bytes.length, base64: btoa(binary) };
}

export async function loadImages(files: File[]) {
  if (files.length > MAX_FILES || files.reduce((total, file) => total + file.size, 0) > MAX_BATCH_BYTES) {
    throw new Error("一次最多添加 30 张图片，合计不超过 30 MB。");
  }
  const images = await Promise.all(files.map(loadFile));
  if (images.some(file => !file.mime.startsWith("image/"))) throw new Error("请选择图片文件。");
  return images;
}

export function dataUrl(file: FileContents): string {
  return `data:${file.mime};base64,${file.base64}`;
}

export async function importNoteFiles(files: File[]) {
  const docs = files.filter(file => /\.(md|markdown|txt|pdf)$/i.test(file.name));
  if (docs.length !== 1) throw new Error("请选择一份 Markdown、TXT 或 PDF，可同时选中 Markdown 引用的图片。");
  const [doc] = docs;
  const attachments = files.filter(file => file !== doc);
  if (attachments.length > MAX_FILES || attachments.reduce((total, file) => total + file.size, 0) > MAX_BATCH_BYTES) {
    throw new Error("最多导入 30 个图片附件，合计不超过 30 MB。");
  }
  const title = Array.from(doc.name.replace(/\.[^.]+$/, "")).slice(0, 200).join("");
  const uploads: PendingFile[] = [];
  const missing = new Set<string>();
  const skipped: string[] = [];
  const body = document.createDocumentFragment();
  const isPdf = /\.pdf$/i.test(doc.name);
  const isText = /\.txt$/i.test(doc.name);
  if (isPdf || isText) {
    for (const file of attachments) skipped.push(`${file.name}（只有 Markdown 可以同时导入图片）`);
  }
  if (isPdf) {
    const file = await loadFile(doc);
    if (file.mime !== "application/pdf") throw new Error("所选文件不是 PDF。");
    uploads.push(file);
    body.append(fileMarker(file.id));
  } else {
    if (doc.size > 1024 * 1024) throw new Error("导入的正文最多 1 MB。");
    const text = await doc.text();
    if (isText) {
      body.append(textFragment(text));
    } else {
      const localFiles = new Map<string, PendingFile[]>();
      for (const attachment of attachments) {
        if (attachment.size > MAX_FILE_BYTES) {
          skipped.push(`${attachment.name}（超过 10 MB）`);
          continue;
        }
        let file: PendingFile;
        try { file = await loadFile(attachment); }
        catch {
          skipped.push(`${attachment.name}（不是支持的图片或无法读取）`);
          continue;
        }
        if (!file.mime.startsWith("image/")) {
          skipped.push(`${attachment.name}（只支持图片附件）`);
          continue;
        }
        const sameName = localFiles.get(file.name);
        if (sameName) sameName.push(file);
        else localFiles.set(file.name, [file]);
      }
      const { marked } = await import("marked");
      body.append(safeBody(await marked.parse(text, { async: false }), new Set(), image => {
        const href = image.getAttribute("src") ?? "";
        let candidates: PendingFile[] | undefined;
        if (!/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(href)) {
          try { candidates = localFiles.get(decodeURIComponent(href.split(/[?#]/)[0]).split("/").at(-1)!); }
          catch { /* An invalid URL is shown as a missing image. */ }
        }
        if (candidates?.length === 1) {
          const [file] = candidates;
          if (!uploads.includes(file)) uploads.push(file);
          return fileMarker(file.id);
        }
        const label = image.alt || href || "未命名图片";
        missing.add(label);
        return document.createTextNode(`[缺少图片：${label}]`);
      }));
      for (const candidates of localFiles.values()) {
        for (const file of candidates) {
          if (uploads.includes(file)) continue;
          const reason = candidates.length > 1 ? "有同名图片，无法匹配" : "正文未引用";
          skipped.push(`${file.name}（${reason}）`);
        }
      }
    }
  }
  return { title, uploads, body, missing: [...missing], skipped };
}
