import { describe, expect, it } from "vitest";
import { safeBody, serializeBody } from "./content.ts";
import { createNotesEditor, insertCodeExample } from "./editor.ts";

describe("Tiptap notes", () => {
  it("round-trips legacy HTML with a table, inline image and PDF attachment", () => {
    const ids = new Set(["legacy-image", "legacy-pdf"]);
    const body = document.createElement("div");
    body.append(safeBody(
      '<h2>旧心得</h2><p>图前<span data-note-file="legacy-image"></span>图后</p>'
        + '<table><thead><tr><th>轮次</th></tr></thead><tbody><tr><td>一面</td></tr></tbody></table>'
        + '<span data-note-file="legacy-pdf"></span>',
      ids,
    ));
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createNotesEditor({
      content: body.innerHTML,
      renderAttachment: () => {},
      onUpdate: () => {},
      onTransaction: () => {},
      onPaste: () => false,
    });
    try {
      editor.mount(host);
      editor.commands.insertContentAt(editor.state.doc.content.size, "<p>新增复盘</p>");
      const saved = serializeBody(editor.getHTML(), ids);
      expect(saved.fileIds).toEqual(["legacy-image", "legacy-pdf"]);
      expect(saved.body).toContain("<table>");
      expect(saved.plainText).toMatch(/图前\n+图后/);
      expect(saved.plainText).toContain("一面");
      expect(saved.plainText).toContain("新增复盘");
    } finally {
      editor.destroy();
      host.remove();
    }
  });

  it("inserts a code example after the current list and focuses it without changing the list", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createNotesEditor({
      content: "<ul><li><p>原来的列表</p></li></ul><p>后续内容</p>",
      renderAttachment: () => {},
      onUpdate: () => {},
      onTransaction: () => {},
      onPaste: () => false,
    });
    try {
      editor.mount(host);
      editor.commands.setTextSelection(3);
      expect(insertCodeExample(editor)).toBe(true);
      expect(editor.state.selection.$from.parent.type.name).toBe("codeBlock");
      editor.commands.insertContent("SELECT id");
      expect(editor.getHTML()).toContain("<ul><li><p>原来的列表</p></li></ul><pre><code>SELECT id</code></pre><p>后续内容</p>");
    } finally {
      editor.destroy();
      host.remove();
    }
  });

  it("preserves supported font sizes while removing unrelated pasted styling", () => {
    const saved = serializeBody(
      '<p><span style="font-size:24px;color:red" onclick="alert(1)">大字</span>'
        + '<span style="font-size:999px">正文</span><img src="https://example.com/img.png"></p>',
      new Set(),
    );
    expect(saved.body).toBe('<p><span style="font-size: 24px;">大字</span><span>正文</span></p>');
    expect(saved.plainText).toBe("大字正文");
  });
});
