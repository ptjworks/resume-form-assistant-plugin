import { Editor, Node, type Content } from "@tiptap/core";
import { TableKit } from "@tiptap/extension-table";
import { FontSize, TextStyle } from "@tiptap/extension-text-style";
import StarterKit from "@tiptap/starter-kit";
import { TextSelection, type Transaction } from "@tiptap/pm/state";

export const attachmentType = "noteAttachment";

interface NotesEditorOptions {
  content: string;
  renderAttachment: (element: HTMLElement, id: string, remove: () => void) => void;
  onUpdate: () => void;
  onTransaction: (transaction: Transaction) => void;
  onPaste: (event: ClipboardEvent) => boolean;
}

export function createNotesEditor(options: NotesEditorOptions) {
  const attachment = Node.create({
    name: attachmentType,
    group: "block",
    atom: true,
    selectable: true,
    addAttributes() {
      return {
        fileId: {
          parseHTML: element => element.dataset.noteFile,
          renderHTML: attributes => ({ "data-note-file": attributes.fileId }),
        },
      };
    },
    parseHTML() {
      return [{ tag: "div[data-note-file]" }, { tag: "span[data-note-file]" }];
    },
    renderHTML({ HTMLAttributes }) {
      return ["div", HTMLAttributes];
    },
    addNodeView() {
      return ({ editor, node, getPos }) => {
        const dom = document.createElement("div");
        dom.dataset.noteFile = node.attrs.fileId;
        options.renderAttachment(dom, node.attrs.fileId, () => {
          const from = getPos();
          if (typeof from === "number") editor.chain().focus().deleteRange({ from, to: from + node.nodeSize }).run();
        });
        return {
          dom,
          stopEvent: event => event.target instanceof Element && Boolean(event.target.closest("button")),
          ignoreMutation: () => true,
        };
      };
    },
  });

  return new Editor({
    element: null,
    content: options.content,
    extensions: [
      StarterKit.configure({ link: false, trailingNode: { notAfter: ["paragraph"] } }),
      TextStyle,
      FontSize,
      TableKit,
      attachment,
    ],
    editorProps: {
      attributes: { class: "notes-editor notes-body", role: "textbox", "aria-label": "心得正文", "aria-multiline": "true" },
      handlePaste: (_view, event) => options.onPaste(event),
    },
    onUpdate: options.onUpdate,
    onTransaction: ({ transaction }) => options.onTransaction(transaction),
  });
}

export function insertOutline(editor: Editor, headings: string[]) {
  const content: Content = headings.flatMap(text => [
    { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text }] },
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph" }] }] },
  ]);
  const { $from } = editor.state.selection;
  const at = $from.depth ? $from.after(1) : $from.pos;
  const replace = $from.depth === 1 && $from.parent.type.name === "paragraph" && !$from.parent.content.size;
  const start = replace ? $from.before(1) : at;
  const template = editor.schema.nodeFromJSON({ type: "doc", content });
  editor.chain().focus().insertContentAt({ from: start, to: at }, content).command(({ tr }) => {
    const firstBullet = start + template.child(0).nodeSize + 3;
    tr.setSelection(TextSelection.create(tr.doc, firstBullet));
    return true;
  }).run();
}

/** Insert a separate example while keeping the current paragraph or list intact. */
export function insertCodeExample(editor: Editor) {
  const { $to, empty } = editor.state.selection;
  const end = $to.depth ? $to.after(1) : $to.pos;
  const replaceBlank = empty && $to.depth === 1 && $to.parent.type.name === "paragraph" && !$to.parent.content.size;
  const start = replaceBlank ? $to.before(1) : end;
  return editor.chain().focus().insertContentAt({ from: start, to: end }, { type: "codeBlock" }).command(({ tr }) => {
    tr.setSelection(TextSelection.create(tr.doc, start + 1));
    return true;
  }).run();
}
