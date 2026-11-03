import { useCallback, useEffect, useState } from "react";
import type { ResumeFileKind, ResumeFileView, ResumeOverview, TemplateSummary } from "../api.ts";
import { formatSize } from "../backup.ts";
import { useInvoke } from "../react/invoke.tsx";
import { ResumeDialog } from "./ResumeDialog.tsx";
import type { Notice } from "./resume-text.ts";
import type { FilePickers } from "./TemplateList.tsx";

const KIND_NAMES: Record<ResumeFileKind, string> = {
  resume: "简历附件",
  photo: "证件照",
  transcript: "成绩单",
  other: "其他材料",
};

const TYPE_NAMES: Record<string, string> = {
  "application/pdf": "PDF",
  "application/msword": "DOC",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
  "image/jpeg": "JPG",
  "image/png": "PNG",
};

const GROUPS: Array<{ title: string; kinds: ResumeFileKind[]; empty: string }> = [
  { title: "简历附件", kinds: ["resume"], empty: "还没有简历附件。" },
  { title: "证件照", kinds: ["photo"], empty: "还没有证件照。" },
  { title: "其他材料", kinds: ["transcript", "other"], empty: "还没有成绩单或其他材料。" },
];

function describe(error: unknown): Notice {
  const err = error as { message?: string } | null;
  return { tone: "error", text: err?.message ?? "操作失败，请重试。" };
}

const opensHere = (file: ResumeFileView) => file.mime === "application/pdf" || file.mime.startsWith("image/");

interface Draft {
  file: ResumeFileView;
  name: string;
  label: string;
  isDefault: boolean;
  templateIds: string[];
}

/**
 * 网申时要上传的文件（#429）：简历附件、证件照、成绩单和其他材料。存在桌面档案里，跟着备份走。
 * 添加、替换只把选文件窗口给的路径交给桌面，由桌面读文件、按文件头核对类型。
 * 切到这一页时才读（简历页的几个视图一直挂着）。
 */
export function ResumeFiles({ pickers, active }: { pickers: FilePickers | null; active: boolean }) {
  const invoke = useInvoke();
  const [files, setFiles] = useState<ResumeFileView[] | null>(null);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [previews, setPreviews] = useState<Record<string, string | null>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ResumeFileView | null>(null);

  const load = useCallback(async () => {
    if (!invoke) return;
    try {
      const [list, overview] = await Promise.all([
        invoke<ResumeFileView[]>("list_resume_files_cmd"),
        invoke<ResumeOverview>("resume_overview_cmd"),
      ]);
      setFiles(list);
      setTemplates(overview.templates);
    } catch (error) {
      setNotice(describe(error));
    }
  }, [invoke]);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  // 照片的缩略图：按内容的哈希缓存，换了文件才重新读。
  useEffect(() => {
    if (!invoke || !files) return;
    for (const file of files) {
      if (!file.mime.startsWith("image/") || file.sha256 in previews) continue;
      setPreviews((current) => ({ ...current, [file.sha256]: null }));
      void invoke<string | null>("preview_resume_file_cmd", { id: file.id }).then(
        (url) => setPreviews((current) => ({ ...current, [file.sha256]: url })),
        () => {},
      );
    }
  }, [files, invoke, previews]);

  const run = async (work: () => Promise<ResumeFileView[]>, done: string) => {
    if (!invoke || busy) return;
    setBusy(true);
    try {
      setFiles(await work());
      setNotice({ tone: "ok", text: done });
    } catch (error) {
      setNotice(describe(error));
    } finally {
      setBusy(false);
    }
  };

  const add = async (kind: ResumeFileKind) => {
    const path = await pickers?.openResumeFile?.(kind);
    if (!path || !invoke) return;
    await run(() => invoke<ResumeFileView[]>("add_resume_file_cmd", { kind, path }), `已添加${KIND_NAMES[kind]}。`);
  };

  const replace = async (file: ResumeFileView) => {
    const path = await pickers?.openResumeFile?.(file.kind);
    if (!path || !invoke) return;
    await run(() => invoke<ResumeFileView[]>("replace_resume_file_cmd", { id: file.id, path }), `已替换「${file.name}」。`);
  };

  const save = async () => {
    if (!draft || !invoke) return;
    const { file, name, label, isDefault, templateIds } = draft;
    await run(
      () => invoke<ResumeFileView[]>("update_resume_file_cmd", { id: file.id, patch: { name, label, isDefault, templateIds } }),
      `已保存「${name.trim()}」。`,
    );
    setDraft(null);
  };

  const remove = async (file: ResumeFileView) => {
    if (!invoke) return;
    await run(() => invoke<ResumeFileView[]>("delete_resume_file_cmd", { id: file.id }), `已删除「${file.name}」。`);
    setConfirmDelete(null);
  };

  const open = async (file: ResumeFileView) => {
    if (!invoke) return;
    try {
      await invoke("open_resume_file_cmd", { id: file.id });
    } catch (error) {
      setNotice(describe(error));
    }
  };

  if (!invoke) return <p className="muted resume-offline">没有连上桌面程序，附件要在桌面程序里管理。</p>;
  const canPick = Boolean(pickers?.openResumeFile);
  const templateName = (id: string) => templates.find((t) => t.id === id)?.name ?? "";
  const usedBy = (file: ResumeFileView) =>
    file.templateIds.length ? `用于：${file.templateIds.map(templateName).filter(Boolean).join("、")}` : "用于所有模板";

  return (
    <section className="resume-card resume-files" aria-labelledby="resume-files-title">
      <div className="resume-files-head">
        <h2 id="resume-files-title">附件</h2>
        <p>网申时要上传的简历附件、证件照和其他材料，存在桌面档案里，跟着备份走。每个文件不超过 10 MB，只收 PDF、DOC、DOCX、JPG、PNG。</p>
      </div>
      <div className="resume-files-body">
        {GROUPS.map((group) => {
          const items = (files ?? []).filter((file) => group.kinds.includes(file.kind));
          return (
            <section key={group.title} className="resume-files-group" aria-label={group.title}>
              <div className="resume-files-group-head">
                <h3>{group.title}</h3>
                <div className="resume-files-actions">
                  {group.kinds.map((kind) => (
                    <button key={kind} type="button" disabled={busy || !canPick} onClick={() => void add(kind)}>
                      添加{KIND_NAMES[kind]}
                    </button>
                  ))}
                </div>
              </div>
              {files === null ? null : items.length ? (
                <ul>
                  {items.map((file) => (
                    <li key={file.id}>
                      {file.mime.startsWith("image/") ? (
                        previews[file.sha256] ? <img className="resume-files-thumb" src={previews[file.sha256]!} alt="" /> : <span className="resume-files-thumb" />
                      ) : null}
                      <div className="resume-files-main">
                        <p className="resume-files-name">
                          {file.name}
                          {file.isDefault ? <span className="chip">默认</span> : null}
                        </p>
                        <p className="resume-files-meta">
                          {[group.kinds.length > 1 ? KIND_NAMES[file.kind] : "", TYPE_NAMES[file.mime] ?? "", formatSize(file.byteSize), file.label, usedBy(file)]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      </div>
                      <div className="resume-files-actions">
                        {opensHere(file) ? <button type="button" disabled={busy} onClick={() => void open(file)}>打开</button> : null}
                        <button type="button" disabled={busy || !canPick} onClick={() => void replace(file)}>替换</button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setDraft({ file, name: file.name, label: file.label, isDefault: file.isDefault, templateIds: file.templateIds })}
                        >
                          编辑
                        </button>
                        <button type="button" disabled={busy} onClick={() => setConfirmDelete(file)}>删除</button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">{group.empty}</p>
              )}
            </section>
          );
        })}
      </div>
      {notice ? <p className={`note ${notice.tone} resume-files-note`} role="status">{notice.text}</p> : null}
      <ResumeDialog
        open={draft !== null}
        title="编辑附件"
        onCancel={() => setDraft(null)}
        footer={
          <>
            <button type="button" onClick={() => setDraft(null)}>取消</button>
            <button type="button" className="primary" disabled={busy || !draft?.name.trim()} onClick={() => void save()}>保存</button>
          </>
        }
      >
        {draft ? (
          <div className="resume-files-form">
            <label>
              文件名
              <input data-autofocus value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </label>
            <label>
              说明
              <input
                value={draft.label}
                maxLength={30}
                placeholder="比如：英文简历、蓝底一寸"
                onChange={(event) => setDraft({ ...draft, label: event.target.value })}
              />
            </label>
            <label className="resume-files-check">
              <input type="checkbox" checked={draft.isDefault} onChange={(event) => setDraft({ ...draft, isDefault: event.target.checked })} />
              设为这一类的默认文件
            </label>
            <fieldset>
              <legend>用于哪些模板（都不选就是所有模板）</legend>
              {templates.length ? templates.map((template) => (
                <label key={template.id} className="resume-files-check">
                  <input
                    type="checkbox"
                    checked={draft.templateIds.includes(template.id)}
                    onChange={(event) => setDraft({
                      ...draft,
                      templateIds: event.target.checked
                        ? [...draft.templateIds, template.id]
                        : draft.templateIds.filter((id) => id !== template.id),
                    })}
                  />
                  {template.name}
                </label>
              )) : <p className="muted">还没有简历模板。</p>}
            </fieldset>
          </div>
        ) : null}
      </ResumeDialog>
      <ResumeDialog
        open={confirmDelete !== null}
        tone="danger"
        title="删除这个附件？"
        onCancel={() => setConfirmDelete(null)}
        footer={
          <>
            <button type="button" data-autofocus onClick={() => setConfirmDelete(null)}>取消</button>
            <button type="button" className="danger" disabled={busy} onClick={() => void remove(confirmDelete!)}>删除</button>
          </>
        }
      >
        <p>「{confirmDelete?.name}」会从桌面档案里删掉。你电脑上的原文件不受影响。</p>
      </ResumeDialog>
    </section>
  );
}
