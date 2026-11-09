export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_BATCH_BYTES = 30 * 1024 * 1024;
export const MAX_FILES = 30;
export const imageTypes = "image/png,image/jpeg,image/gif,image/webp";
const tags = new Set(["P", "DIV", "BR", "B", "STRONG", "I", "EM", "UL", "OL", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE", "CODE", "HR", "TABLE", "THEAD", "TBODY", "TR", "TD", "TH"]);
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

export function fileMarker(id: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.dataset.noteFile = id;
  return span;
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
    for (const child of source.childNodes) copy(child, destination);
    if (destination !== parent) parent.appendChild(destination);
  }
  for (const child of nodes) copy(child, output);
  return output;
}

export function serializeBody(editor: HTMLElement, ids: ReadonlySet<string>) {
  const clean = document.createElement("div");
  clean.append(copyBody(editor.childNodes, ids));
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

export async function loadFile(file: File): Promise<PendingFile> {
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} 超过 10 MB。`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const header = String.fromCharCode(...bytes.subarray(0, 12));
  let mime: string;
  if (header.startsWith("\x89PNG\r\n\x1a\n")) mime = "image/png";
  else if (header.startsWith("\xff\xd8\xff")) mime = "image/jpeg";
  else if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) mime = "image/gif";
  else if (header.startsWith("RIFF") && header.slice(8) === "WEBP") mime = "image/webp";
  else if (header.startsWith("%PDF-")) mime = "application/pdf";
  else throw new Error(`${file.name} 不是支持的图片或 PDF。`);
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
  const body = document.createDocumentFragment();
  if (/\.pdf$/i.test(doc.name)) {
    const file = await loadFile(doc);
    if (file.mime !== "application/pdf") throw new Error("所选文件不是 PDF。");
    uploads.push(file);
    body.append(fileMarker(file.id));
  } else {
    if (doc.size > 1024 * 1024) throw new Error("导入的正文最多 1 MB。");
    const text = await doc.text();
    if (/\.txt$/i.test(doc.name)) {
      body.append(textFragment(text));
    } else {
      const localFiles = new Map<string, PendingFile | null>();
      for (const attachment of attachments) {
        const file = await loadFile(attachment);
        if (!file.mime.startsWith("image/")) continue;
        localFiles.set(attachment.name, localFiles.has(attachment.name) ? null : file);
      }
      const { marked } = await import("marked");
      body.append(safeBody(await marked.parse(text, { async: false }), new Set(), image => {
        const href = image.getAttribute("src") ?? "";
        let file: PendingFile | null | undefined;
        if (!/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(href)) {
          try { file = localFiles.get(decodeURIComponent(href.split(/[?#]/)[0]).split("/").at(-1)!); }
          catch { /* An invalid URL is shown as a missing image. */ }
        }
        if (file) {
          if (!uploads.includes(file)) uploads.push(file);
          return fileMarker(file.id);
        }
        const label = image.alt || href || "未命名图片";
        missing.add(label);
        return document.createTextNode(`[缺少图片：${label}]`);
      }));
    }
  }
  return { title, uploads, body, missing: [...missing] };
}
