import { Editor, Extension, Node } from "@tiptap/core";
import { TableKit } from "@tiptap/extension-table";
import { BackgroundColor, Color, FontFamily, FontSize, TextStyle } from "@tiptap/extension-text-style";
import StarterKit from "@tiptap/starter-kit";
import { TextSelection, type Transaction } from "@tiptap/pm/state";
import { noteAlignments } from "./content.ts";

export const attachmentType = "noteAttachment";

const paragraphAlignment = Extension.create({
  name: "noteParagraphAlignment",
  addGlobalAttributes() {
    return [{
      types: ["paragraph", "heading"],
      attributes: {
        textAlign: {
          default: null,
          parseHTML: element => noteAlignments.includes(element.style.textAlign) ? element.style.textAlign : null,
          renderHTML: attributes => noteAlignments.includes(attributes.textAlign)
            ? { style: `text-align: ${attributes.textAlign}` } : {},
        },
      },
    }];
  },
});

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
      FontFamily,
      Color,
      BackgroundColor,
      paragraphAlignment,
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
