import { useCallback, useEffect, useState } from "react";
import type { DamagedResumeFileView, ResumeFileDeleted, ResumeFileKind, ResumeFileListing, ResumeFileView, ResumeOverview, TemplateSummary } from "../api.ts";
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

/**
 * 删除的结果照实说：没删到记录的不说「已删除」；删了但没清干净的（这次的文件卡在 tmp/ 里、附件目录里还有会让
 * 备份停下的文件、没能核对）说出来，不说成已经清干净。
 */
function deletionNotice(result: ResumeFileDeleted, done: string, name: string): Notice {
  if (!result.deleted) return { tone: "warn", text: `没有找到「${name}」，可能已经删掉了。` };
  const notes: string[] = [];
  if (result.stuckInTmp) notes.push("附件文件还没从磁盘上删掉，可能正被别的程序占用；下次增删附件时会再删一次。");
  const leftovers = result.leftovers ?? [];
  if (result.unchecked) notes.push(`没能核对附件目录里还有没有残留（${result.unchecked}），备份可能仍会被挡住。`);
  else if (leftovers.length) notes.push(`附件目录里还有 ${leftovers.length} 个文件没清掉，备份可能仍会被这些残留挡住：${leftovers.join("、")}。`);
  return notes.length ? { tone: "warn", text: done + notes.join("") } : { tone: "ok", text: done };
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
  const [damaged, setDamaged] = useState<DamagedResumeFileView[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string; damaged: boolean } | null>(null);

  const show = useCallback((listing: ResumeFileListing) => {
    setFiles(listing.files);
    setDamaged(listing.damaged);
  }, []);

  const load = useCallback(async () => {
    if (!invoke) return;
    try {
      const [list, overview] = await Promise.all([
        invoke<ResumeFileListing>("list_resume_files_cmd"),
        invoke<ResumeOverview>("resume_overview_cmd"),
      ]);
      show(list);
      setTemplates(overview.templates);
    } catch (error) {
      setNotice(describe(error));
    }
  }, [invoke, show]);

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

  /** 成功返回 true；失败时原因在 notice 里，打开着的对话框不关，用户填的东西还在。 */
  const run = async <T extends ResumeFileListing>(work: () => Promise<T>, done: string | ((result: T) => Notice)): Promise<boolean> => {
    if (!invoke || busy) return false;
    setBusy(true);
    try {
      const result = await work();
      show(result);
      setNotice(typeof done === "string" ? { tone: "ok", text: done } : done(result));
      return true;
    } catch (error) {
      setNotice(describe(error));
      // 有的失败发生在改动之后（新文件换上了、旧文件没删掉）：列表按桌面现在的样子重读。
      if (invoke) {
        void invoke<ResumeFileListing>("list_resume_files_cmd").then(show, () => {});
      }
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async (kind: ResumeFileKind) => {
    const path = await pickers?.openResumeFile?.(kind);
    if (!path || !invoke) return;
    await run(() => invoke<ResumeFileListing>("add_resume_file_cmd", { kind, path }), `已添加${KIND_NAMES[kind]}。`);
  };

  const replace = async (file: ResumeFileView) => {
    const path = await pickers?.openResumeFile?.(file.kind);
    if (!path || !invoke) return;
    await run(() => invoke<ResumeFileListing>("replace_resume_file_cmd", { id: file.id, path }), `已替换「${file.name}」。`);
  };

  const save = async () => {
    if (!draft || !invoke) return;
    const { file, name, label, isDefault, templateIds } = draft;
    const saved = await run(
      () => invoke<ResumeFileListing>("update_resume_file_cmd", { id: file.id, patch: { name, label, isDefault, templateIds } }),
      `已保存「${name.trim()}」。`,
    );
    if (saved) setDraft(null);
  };

  const remove = async (target: { id: string; name: string; damaged: boolean }) => {
    if (!invoke) return;
    const done = target.damaged ? `已删除「${target.name}」这条读不出来的记录。` : `已删除「${target.name}」。`;
    const answered = await run(
      () => invoke<ResumeFileDeleted>("delete_resume_file_cmd", { id: target.id }),
      (result) => deletionNotice(result, done, target.name),
    );
    // 没删到的（已经不在了）也关掉对话框：列表已经按桌面现在的样子更新，没有可以再试的。
    if (answered) setConfirmDelete(null);
  };

  const openDialog = (open: () => void) => {
    setNotice(null);
    open();
  };
  // 对话框开着时报错显示在对话框里：页面上的提示被对话框挡着。
  const dialogError = notice?.tone === "error" ? <p className="note error" role="alert">{notice.text}</p> : null;

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
  // 删掉的模板的 id 留在绑定里：只绑了它的文件不用于别的模板，等用户重新选。
  const deletedTemplates = (file: ResumeFileView) => file.templateIds.filter((id) => !templateName(id));
  const usedBy = (file: ResumeFileView) => {
    if (!file.templateIds.length) return "用于所有模板";
    const names = file.templateIds.map(templateName).filter(Boolean);
    if (!names.length) return "模板已删除，暂不使用";
    return `用于：${[...names, ...(deletedTemplates(file).length ? ["模板已删除"] : [])].join("、")}`;
  };

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
                          onClick={() => openDialog(() => setDraft({ file, name: file.name, label: file.label, isDefault: file.isDefault, templateIds: file.templateIds }))}
                        >
                          编辑
                        </button>
                        <button type="button" disabled={busy} onClick={() => openDialog(() => setConfirmDelete({ id: file.id, name: file.name, damaged: false }))}>删除</button>
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
        {damaged.length ? (
          <section className="resume-files-group" aria-label="读不出来的记录">
            <div className="resume-files-group-head">
              <h3>读不出来的记录</h3>
            </div>
            <p className="note warn">有 {damaged.length} 个附件的记录读不出来，不会拿去上传。可以删掉这些记录。</p>
            <ul>
              {damaged.map((item) => (
                <li key={item.id}>
                  <div className="resume-files-main">
                    <p className="resume-files-name">{item.name}</p>
                    <p className="resume-files-meta">{item.reason}</p>
                  </div>
                  <div className="resume-files-actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => openDialog(() => setConfirmDelete({ id: item.id, name: item.name, damaged: true }))}
                    >
                      删除记录
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
      {notice && !draft && !confirmDelete ? <p className={`note ${notice.tone} resume-files-note`} role="status">{notice.text}</p> : null}
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
            {dialogError}
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
              {deletedTemplates(draft.file).length ? (
                <label className="resume-files-check">
                  <input
                    type="checkbox"
                    checked={deletedTemplates(draft.file).some((id) => draft.templateIds.includes(id))}
                    onChange={(event) => {
                      const gone = deletedTemplates(draft.file);
                      const rest = draft.templateIds.filter((id) => !gone.includes(id));
                      setDraft({ ...draft, templateIds: event.target.checked ? [...rest, ...gone] : rest });
                    }}
                  />
                  模板已删除
                </label>
              ) : null}
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
        {confirmDelete?.damaged ? (
          <p>「{confirmDelete.name}」这条记录读不出来。删掉记录时，能按它的哈希在附件目录里找到、又没有别的记录在用的那份文件会一起删掉，删了不能恢复。附件目录顶层没人用的残留会顺手清掉；清不掉的、子目录里的，删除之后会列出来。档案以外的文件不动。</p>
        ) : (
          <p>「{confirmDelete?.name}」会从桌面档案里删掉。你电脑上的原文件不受影响。</p>
        )}
        {dialogError}
      </ResumeDialog>
    </section>
  );
}
