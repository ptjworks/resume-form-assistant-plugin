import { useEffect, useMemo, useRef, useState } from "react";
import type { FocusEvent, KeyboardEvent, MutableRefObject, SyntheticEvent } from "react";
import type { ProfileRecordView, ResumeTemplateView } from "../api.ts";
import { useInvoke } from "../react/invoke.tsx";
import { profileApi } from "./profile.ts";
import { MoreMenu } from "./MoreMenu.tsx";
import { templateFields } from "./template-fields.ts";
import type { TemplateDraft } from "./template-fields.ts";

/** 编辑器向外报告的状态：有没有还没写进模板的输入（离开简历页、切换模板前要问）。 */
export interface TemplateEditorProbe {
  dirty(): boolean;
}

type Part = "key" | "value";
type Editing = { id: string; part: Part; text: string; error: string | null; busy?: boolean };
// 在已有分类里待添加的一行（还没写进模板）。同一个分类里可以同时摆好几行。
type PendingRow = { id: number; key: string; value: string; error: string | null; busy?: boolean };
type Adding = Record<string, PendingRow[]>;
type NewCategory = { name: string; rows: Array<{ key: string; value: string }>; error: string | null; busy?: boolean };
type Status = { tone: "ok" | "warn" | "error"; text: string };
// 只记被删的那一个字段和它原来的位置；撤销时把它加回「当前」的内容，不整份回写旧快照。
type Undo = { category: string; key: string; value: string; index: number; text: string };

const UNDO_MS = 8000;

async function baseOf(view: ResumeTemplateView): Promise<string> {
  // 旧宿主或测试替身没带 contentSha256 时自己算：两边是同一套规范 JSON（profile-sync.test.ts 锁住）。
  return view.contentSha256 || templateFields.contentSha256(view.groups);
}

function errorCode(error: unknown): string {
  return (error as { code?: string } | null)?.code ?? "";
}

function errorText(error: unknown): string {
  return (error as { message?: string } | null)?.message ?? "保存失败，请重试。";
}

// 没有字段的分类不会存进模板，界面上也不留空壳。
function prune(draft: TemplateDraft): TemplateDraft {
  const categories = draft.categories.filter((name) => draft.fields.some((field) => field.category === name));
  return categories.length === draft.categories.length ? draft : { ...draft, categories };
}

/**
 * 模板字段：看到什么就直接改什么，没有「编辑模式」和「保存」按钮。
 * 点字段名或内容原地改，回车或点别处就保存这一处；删除可以撤销；每个分类底部加字段，列表末尾新建分类。
 *
 * 每次改动都是「整份替换这份模板的字段」，并带上起点版本（baseSha256）：别处（插件、重新导入）
 * 改过就停下来，换成最新内容并说明，不会静默覆盖。改动按顺序一个一个保存，字段用草稿里的固定 id 认。
 */
export function TemplateFields({
  template,
  probe,
  onSaved,
  onReplaced,
}: {
  /** 外面最近一次读到的这份模板。插件保存、重新导入后会换成新的。 */
  template: ResumeTemplateView;
  probe?: MutableRefObject<TemplateEditorProbe | null>;
  /** 这一处改动已经写进模板。 */
  onSaved(view: ResumeTemplateView): void;
  /** 发现别处改过，已换成最新内容（或模板已不在）；外面要跟着刷新。 */
  onReplaced(view: ResumeTemplateView | null): void;
}) {
  const invoke = useInvoke();
  const [draft, setDraftState] = useState<TemplateDraft>(() => templateFields.createDraft(template));
  const draftRef = useRef(draft);
  const baseRef = useRef<string>(template.contentSha256 ?? "");
  // 自己读到、保存过的版本（内容哈希）。外面读到的版本只要在这里面，就是自己的，不当成别处的修改。
  const knownShas = useRef<Set<string>>(new Set(template.contentSha256 ? [template.contentSha256] : []));
  const templateRef = useRef(template);
  templateRef.current = template;
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [editing, setEditingState] = useState<Editing | null>(null);
  const editingRef = useRef<Editing | null>(null);
  const [adding, setAddingState] = useState<Adding>({});
  const addingRef = useRef<Adding>({});
  const [newCat, setNewCat] = useState<NewCategory | null>(null);
  const newCatRef = useRef<NewCategory | null>(null);
  newCatRef.current = newCat;
  const addSeq = useRef(0);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [profileFields, setProfileFields] = useState<Array<{ key: string; value: string }>>([]);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const listRef = useRef<HTMLDivElement>(null);
  const cancelBlur = useRef(false);

  const setDraft = (next: TemplateDraft) => {
    draftRef.current = next;
    setDraftState(next);
  };
  const setEditing = (next: Editing | null | ((current: Editing | null) => Editing | null)) => {
    const value = typeof next === "function" ? next(editingRef.current) : next;
    editingRef.current = value;
    setEditingState(value);
  };
  const setAdding = (next: Adding | ((current: Adding) => Adding)) => {
    const value = typeof next === "function" ? next(addingRef.current) : next;
    addingRef.current = value;
    setAddingState(value);
  };

  useEffect(() => {
    if (!template.contentSha256) {
      void baseOf(template).then((sha) => {
        if (!baseRef.current) baseRef.current = sha;
        if (!knownShas.current.size) knownShas.current.add(sha);
      });
    }
  }, [template]);

  // 「我的信息」只用来提示：删掉的字段在那里还有同名内容时，填写仍可能用到它。
  useEffect(() => {
    if (!invoke) return undefined;
    let cancelled = false;
    invoke<ProfileRecordView>("get_profile_cmd").then(
      (record) => {
        if (!cancelled) setProfileFields(profileApi.profileToResumeFields(record.profile));
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [invoke]);

  useEffect(() => {
    if (!probe) return undefined;
    probe.current = {
      dirty: () => {
        const e = editingRef.current;
        if (e) {
          const field = draftRef.current.fields.find((item) => item.id === e.id);
          if (field && e.text !== (e.part === "key" ? field.key : field.value)) return true;
        }
        const pending = Object.values(addingRef.current).some((rows) => rows.some((row) => row.key.trim() || row.value.trim()));
        const n = newCatRef.current;
        return pending || Boolean(n && (n.name.trim() || n.rows.some((r) => r.key.trim() || r.value.trim()))) || savingRef.current;
      },
    };
    return () => {
      probe.current = null;
    };
  }, [probe]);

  // 外面读到更新的版本（插件刚保存过、重新导入了）：没在改东西就直接换成最新内容；
  // 正在改时先提示，保存时会先核对版本，不会覆盖。是自己读到或保存过的版本就不理会，
  // 这样「自己保存之前发出的旧读取」晚到，也不会把界面顶回旧内容。
  useEffect(() => {
    let cancelled = false;
    void baseOf(template).then((sha) => {
      if (cancelled || sha === baseRef.current || knownShas.current.has(sha)) return;
      const busy =
        savingRef.current ||
        editingRef.current ||
        newCatRef.current ||
        Object.values(addingRef.current).some((rows) => rows.some((row) => row.key.trim() || row.value.trim()));
      if (busy) {
        setStatus({ tone: "warn", text: "这份模板刚在别处（例如插件侧边栏）更新过。你正在改的内容保存前会先核对，不会覆盖别处的修改。" });
        return;
      }
      knownShas.current.add(sha);
      baseRef.current = sha;
      setDraft(templateFields.createDraft(template));
      setUndo(null);
      setStatus({ tone: "warn", text: "这份模板刚在别处更新过，已显示最新内容。" });
    });
    return () => {
      cancelled = true;
    };
  }, [template]);

  // 「已保存」只闪一下；出错和提醒留着，直到下一次操作。
  useEffect(() => {
    if (status?.tone !== "ok") return undefined;
    const timer = window.setTimeout(() => setStatus(null), 2500);
    return () => window.clearTimeout(timer);
  }, [status]);

  useEffect(() => {
    if (!undo) return undefined;
    const timer = window.setTimeout(() => setUndo(null), UNDO_MS);
    return () => window.clearTimeout(timer);
  }, [undo]);

  const inProfile = (key: string) => {
    const wanted = profileApi.normalizeKey(key);
    return Boolean(wanted) && profileFields.some((field) => profileApi.normalizeKey(field.key) === wanted && field.value);
  };

  const reveal = (...categories: string[]) => setCollapsed((current) => current.filter((name) => !categories.includes(name)));

  const fetchLatest = async (): Promise<{ view: ResumeTemplateView } | { gone: true } | { failed: true }> => {
    if (!invoke) return { failed: true };
    try {
      return { view: await invoke<ResumeTemplateView>("get_resume_template_cmd", { id: template.id }) };
    } catch (error) {
      return errorCode(error) === "NOT_FOUND" ? { gone: true } : { failed: true };
    }
  };

  /**
   * 把一处改动写进模板。按顺序一个一个来；op 在轮到它时才拿最新草稿去算。
   * 返回有没有写成功；没写成功时界面上的输入原样留着，原因写在状态行里。
   */
  const apply = (
    op: (current: TemplateDraft) => TemplateDraft,
    options: { onInvalid?: (message: string) => void; onApplied?: (before: TemplateDraft) => void; onFailed?: () => void; done?: string } = {},
  ): Promise<boolean> => {
    const task = async (): Promise<boolean> => {
      if (!invoke) return false;
      const before = draftRef.current;
      const next = prune(op(before));
      if (next === before) return true;
      const check = templateFields.validateDraft(next);
      if (!check.ok) {
        const firstField = Object.values(check.fieldErrors)[0];
        const message = firstField ?? check.problems[0] ?? "这处改动存不进模板。";
        if (options.onInvalid) options.onInvalid(message);
        else setStatus({ tone: "error", text: message });
        options.onFailed?.();
        return false;
      }
      savingRef.current = true;
      setSaving(true);
      try {
        const base = baseRef.current || (await baseOf(templateRef.current));
        const saved = await invoke<ResumeTemplateView>("save_resume_template_fields_cmd", {
          id: template.id,
          groups: templateFields.toGroups(next),
          baseSha256: base,
        });
        baseRef.current = await baseOf(saved);
        knownShas.current.add(baseRef.current);
        setDraft(next);
        setStatus({ tone: "ok", text: options.done ?? "已保存" });
        options.onApplied?.(before);
        onSaved(saved);
        return true;
      } catch (error) {
        const code = errorCode(error);
        if (code === "CONFLICT") {
          const latest = await fetchLatest();
          if ("view" in latest) {
            baseRef.current = await baseOf(latest.view);
            knownShas.current.add(baseRef.current);
            setDraft(templateFields.createDraft(latest.view));
            // 只清掉正在改的那一处（字段编号换了）；还没写完的空白行和新建分类表单原样留着。
            setEditing(null);
            setUndo(null);
            setStatus({ tone: "error", text: "这份模板刚在别处（例如插件侧边栏，或重新导入）改过，已换成最新内容。你刚才的修改没有保存，请再改一次。" });
            onReplaced(latest.view);
          } else if ("gone" in latest) {
            setStatus({ tone: "error", text: "这份模板已在别处删除，修改没有保存。" });
            onReplaced(null);
          } else {
            setStatus({ tone: "error", text: "这份模板已在别处修改，但暂时读不到最新内容。你的输入还在，没有保存；请稍后再试。" });
          }
        } else if (code === "NOT_FOUND") {
          setStatus({ tone: "error", text: "这份模板已在别处删除，修改没有保存。" });
          onReplaced(null);
        } else {
          setStatus({ tone: "error", text: `${errorText(error)} 这处修改没有保存。` });
        }
        options.onFailed?.();
        return false;
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    };
    const run = chain.current.then(task, task);
    chain.current = run.catch(() => undefined);
    setUndo(null);
    return run;
  };

  // —— 改已有字段的名称或内容 ——
  const startEdit = (id: string, part: Part) => {
    const field = draftRef.current.fields.find((item) => item.id === id);
    if (!field) return;
    cancelBlur.current = false;
    setEditing({ id, part, text: part === "key" ? field.key : field.value, error: null });
  };

  const commitEdit = () => {
    const current = editingRef.current;
    if (!current || current.busy) return;
    const { id, part, text } = current;
    const field = draftRef.current.fields.find((item) => item.id === id);
    if (!field) {
      setEditing(null);
      return;
    }
    const original = part === "key" ? field.key : field.value;
    if (text === original || (part === "key" && text.trim() === original)) {
      setEditing(null);
      return;
    }
    // 保存期间标「忙」：回车后紧接着点别处，不会把同一处再保存一遍。
    setEditing({ ...current, busy: true });
    void apply((d) => templateFields.updateField(d, id, { [part]: text }), {
      onInvalid: (message) => setEditing((c) => (c && c.id === id && c.part === part ? { ...c, error: message } : c)),
      onFailed: () => setEditing((c) => (c && c.id === id && c.part === part ? { ...c, busy: false } : c)),
    }).then((ok) => {
      if (ok) setEditing((c) => (c && c.id === id && c.part === part ? null : c));
    });
  };

  const onEditKey = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>, multiline: boolean) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelBlur.current = true;
      // 这个标志只管 Esc 引起的那一次失焦；马上清掉，不留给后面别的输入框。
      window.setTimeout(() => { cancelBlur.current = false; }, 0);
      setEditing(null);
      return;
    }
    if (event.key === "Enter" && !event.nativeEvent.isComposing && !(multiline && event.shiftKey)) {
      event.preventDefault();
      commitEdit();
    }
  };

  const onEditBlur = () => {
    if (cancelBlur.current) {
      cancelBlur.current = false;
      return;
    }
    commitEdit();
  };

  // —— 删除（可撤销）和换分类 ——
  const removeField = (id: string) => {
    const field = draftRef.current.fields.find((item) => item.id === id);
    if (!field) return;
    const label = field.key.trim() || "未命名字段";
    const { category, key, value } = field;
    void apply((d) => templateFields.removeField(d, id), {
      done: "已删除",
      onApplied: (before) => {
        const fallback = inProfile(key) ? "「我的信息」里还有同名内容，一键填写时仍可能用到。" : "";
        setUndo({ category, key, value, index: before.fields.findIndex((item) => item.id === id), text: `已删除「${label}」。${fallback}` });
      },
    });
  };

  // 撤销：只把被删的这一个字段加回当前的内容（尽量放回原来的位置）。
  // 这 8 秒里别处改过模板的话，撤销条会先消失，不会拿旧内容盖掉别处的修改。
  const undoRemove = () => {
    if (!undo) return;
    const { category, key, value, index } = undo;
    void apply(
      (d) => {
        const added = templateFields.addField(d, { category, key, value });
        const fields = added.draft.fields.slice(0, -1);
        const restored = added.draft.fields[added.draft.fields.length - 1];
        fields.splice(Math.max(0, Math.min(index, fields.length)), 0, restored);
        return { ...added.draft, fields };
      },
      { done: "已撤销删除" },
    );
  };

  const moveField = (id: string, category: string) => {
    reveal(category);
    void apply((d) => templateFields.updateField(d, id, { category }), { done: `已移到「${category}」` });
  };

  // —— 添加字段（分类里）：「添加字段」每点一下多一行空白，可以摆好几行再一起填 ——
  const startAdd = (category: string) => {
    cancelBlur.current = false;
    reveal(category);
    addSeq.current += 1;
    const id = addSeq.current;
    setAdding((cur) => ({ ...cur, [category]: [...(cur[category] ?? []), { id, key: "", value: "", error: null }] }));
  };

  const patchRow = (category: string, id: number, patch: Partial<PendingRow>) =>
    setAdding((cur) => ({ ...cur, [category]: (cur[category] ?? []).map((row) => (row.id === id ? { ...row, ...patch } : row)) }));

  const dropRow = (category: string, id: number) =>
    setAdding((cur) => {
      const rows = (cur[category] ?? []).filter((row) => row.id !== id);
      const next = { ...cur };
      if (rows.length) next[category] = rows;
      else delete next[category];
      return next;
    });

  // 名称填了才保存；空白行留着（可以点「×」去掉），不会因为点了别处就消失。
  // chain：回车提交、保存成功后，如果已经没有空白行了，就再补一行，方便接着填。
  const commitRow = (category: string, id: number, chain = false) => {
    const row = (addingRef.current[category] ?? []).find((item) => item.id === id);
    if (!row || row.busy) return;
    if (!row.key.trim()) {
      if (row.value.trim()) patchRow(category, id, { error: "请填字段名称。" });
      return;
    }
    // 保存期间标「忙」：回车后紧接着点别处，同一行不会被存两次。
    patchRow(category, id, { busy: true });
    void apply(
      (d) => templateFields.addField(d, { category, key: row.key, value: row.value }).draft,
      {
        onInvalid: (message) => patchRow(category, id, { error: message }),
        onFailed: () => patchRow(category, id, { busy: false }),
      },
    ).then((ok) => {
      if (!ok) return;
      const stillBlank = (addingRef.current[category] ?? []).some((item) => item.id !== id && !item.key.trim() && !item.value.trim());
      dropRow(category, id);
      if (chain && !stillBlank) startAdd(category);
    });
  };

  const onAddKey = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>, category: string, id: number, next?: () => void, multiline = false) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelBlur.current = true;
      window.setTimeout(() => { cancelBlur.current = false; }, 0);
      dropRow(category, id);
      return;
    }
    if (event.key === "Enter" && !event.nativeEvent.isComposing && !(multiline && event.shiftKey)) {
      event.preventDefault();
      if (next) next();
      else commitRow(category, id, true);
    }
  };

  // 光标离开这一行才算填完；在这一行的输入框之间切换不算。
  const onAddBlur = (event: FocusEvent<HTMLElement>, category: string, id: number) => {
    if (cancelBlur.current) {
      cancelBlur.current = false;
      return;
    }
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    commitRow(category, id, false);
  };

  const focusIn = (selector: string) => (event: SyntheticEvent<HTMLElement>) => {
    event.currentTarget.closest("[data-add-scope]")?.querySelector<HTMLElement>(selector)?.focus();
  };

  // —— 新建分类：一个小表单，可以一次加好几个字段，点「创建分类」才保存 ——
  const startNewCategory = () => setNewCat({ name: "", rows: [{ key: "", value: "" }], error: null });

  const setNewRow = (index: number, patch: Partial<{ key: string; value: string }>) =>
    setNewCat((cur) => (cur ? { ...cur, error: null, rows: cur.rows.map((row, i) => (i === index ? { ...row, ...patch } : row)) } : cur));

  const createCategory = () => {
    const current = newCatRef.current;
    if (!current || current.busy) return;
    const rows = current.rows.filter((row) => row.key.trim() || row.value.trim());
    if (!current.name.trim()) {
      setNewCat({ ...current, error: "请填分类名称。" });
      return;
    }
    if (rows.some((row) => !row.key.trim())) {
      setNewCat({ ...current, error: "有的字段只填了内容，请补上字段名称。" });
      return;
    }
    if (!rows.length) {
      setNewCat({ ...current, error: "至少填一个字段。" });
      return;
    }
    const created = templateFields.addCategory(draftRef.current, current.name);
    if (created.error || !created.category) {
      setNewCat({ ...current, error: created.error ?? "请填分类名称。" });
      return;
    }
    const category = created.category;
    setNewCat({ ...current, busy: true });
    void apply(
      (d) => rows.reduce((acc, row) => templateFields.addField(acc, { category, key: row.key, value: row.value }).draft, templateFields.addCategory(d, current.name).draft),
      {
        onInvalid: (message) => setNewCat((cur) => (cur ? { ...cur, error: message } : cur)),
        onFailed: () => setNewCat((cur) => (cur ? { ...cur, busy: false } : cur)),
        done: `已新建分类「${category}」`,
      },
    ).then((ok) => {
      if (ok) {
        reveal(category);
        setNewCat(null);
      }
    });
  };

  const onNewCatKey = (event: KeyboardEvent<HTMLElement>, lastValue = false) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setNewCat(null);
      return;
    }
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    if ((event.target as HTMLElement).tagName === "TEXTAREA" && event.shiftKey) return;
    event.preventDefault();
    const form = event.currentTarget.closest("[data-newcat]");
    const inputs = [...(form?.querySelectorAll<HTMLElement>("input, textarea") ?? [])];
    const at = inputs.indexOf(event.target as HTMLElement);
    if (lastValue) {
      setNewCat((cur) => (cur ? { ...cur, rows: [...cur.rows, { key: "", value: "" }] } : cur));
      window.setTimeout(() => {
        const fresh = [...(form?.querySelectorAll<HTMLElement>('input[aria-label="字段名称"]') ?? [])];
        fresh[fresh.length - 1]?.focus();
      }, 0);
    } else inputs[at + 1]?.focus();
  };

  const warnings = useMemo(() => templateFields.validateDraft(draft).warnings, [draft]);
  const categories = draft.categories;
  // 已保存字段删光的分类会从草稿里消失；但它里面还有没写完的空白行时，仍要显示，不能让那几行看不见。
  const shownCategories = [...categories, ...Object.keys(adding).filter((name) => !categories.includes(name))];

  const addRows = (category: string) =>
    (adding[category] ?? []).map((row) => (
      <div
        key={row.id}
        className="tpl-field is-adding"
        role="group"
        aria-label={`在「${category}」添加字段`}
        data-add-scope
        onBlur={(event) => onAddBlur(event, category, row.id)}
      >
        <input
          className="tpl-add-input"
          aria-label="字段名称"
          placeholder="字段名称"
          autoFocus
          value={row.key}
          onChange={(event) => patchRow(category, row.id, { key: event.target.value, error: null })}
          onKeyDown={(event) => onAddKey(event, category, row.id, () => focusIn('[aria-label="内容"]')(event))}
        />
        <textarea
          className="tpl-add-input"
          aria-label="内容"
          placeholder="内容（回车保存，Shift+回车换行）"
          rows={1}
          value={row.value}
          onChange={(event) => patchRow(category, row.id, { value: event.target.value, error: null })}
          onKeyDown={(event) => onAddKey(event, category, row.id, undefined, true)}
        />
        <button type="button" className="tpl-remove tpl-add-drop" aria-label="去掉这一行" onClick={() => dropRow(category, row.id)}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
        {row.error ? <p className="note error tpl-field-error" role="alert">{row.error}</p> : null}
      </div>
    ));

  return (
    <div className="tpl-fields-wrap">
      {saving || status || undo ? (
        // 浮在列表上方，不占版面：出现和消失时下面的字段不会跟着跳。
        <div className="tpl-toast">
          <p className={status ? `tpl-status is-${status.tone}` : "tpl-status"} role="status">
            {saving ? "正在保存…" : undo ? "" : status?.text ?? ""}
            {undo && !saving ? (
              <>
                <span className="tpl-undo-text">{undo.text}</span>{" "}
                <button type="button" className="linkish" onClick={undoRemove}>撤销</button>
              </>
            ) : null}
          </p>
        </div>
      ) : null}
      {warnings.length ? <p className="resume-hint warn">{warnings.join(" ")}</p> : null}
      <div className="template-preview template-edit-groups" ref={listRef}>
        {shownCategories.map((category) => {
          const rows = draft.fields.filter((field) => field.category === category);
          const open = !collapsed.includes(category);
          return (
            <section key={category} aria-label={`分类：${category}`}>
              <div className="template-group-head">
                <h3>
                  <button
                    type="button"
                    className="template-group-toggle"
                    aria-expanded={open}
                    onClick={() => setCollapsed(open ? [...collapsed, category] : collapsed.filter((name) => name !== category))}
                  >
                    <span className={`template-group-chevron${open ? " is-open" : ""}`} aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M9 6l6 6-6 6" />
                      </svg>
                    </span>
                    {category}
                  </button>
                </h3>
                <span className="muted">{rows.length} 个字段</span>
              </div>
              {open ? (
                <>
                  <div className="tpl-fields">
                    {rows.map((field) => {
                      const label = field.key.trim() || "未命名字段";
                      const editKey = editing?.id === field.id && editing.part === "key" ? editing : null;
                      const editValue = editing?.id === field.id && editing.part === "value" ? editing : null;
                      const error = editKey?.error ?? editValue?.error ?? null;
                      const others = categories.filter((name) => name !== category);
                      return (
                        <div key={field.id} role="group" aria-label={label} className="tpl-field" data-field-id={field.id}>
                          {editKey ? (
                            <input
                              className="tpl-edit-input tpl-key"
                              aria-label="字段名称"
                              aria-invalid={error ? true : undefined}
                              autoFocus
                              value={editKey.text}
                              onChange={(event) => setEditing({ ...editKey, text: event.target.value, error: null })}
                              onKeyDown={(event) => onEditKey(event, false)}
                              onBlur={onEditBlur}
                            />
                          ) : (
                            <button type="button" className="tpl-key" aria-label={`修改字段名「${label}」`} onClick={() => startEdit(field.id, "key")}>
                              {label}
                            </button>
                          )}
                          {editValue ? (
                            <textarea
                              className="tpl-edit-input tpl-value"
                              aria-label="内容"
                              aria-invalid={error ? true : undefined}
                              autoFocus
                              rows={Math.min(6, Math.max(1, editValue.text.split("\n").length))}
                              value={editValue.text}
                              onChange={(event) => setEditing({ ...editValue, text: event.target.value, error: null })}
                              onKeyDown={(event) => onEditKey(event, true)}
                              onBlur={onEditBlur}
                            />
                          ) : (
                            <button
                              type="button"
                              className={`tpl-value${field.value ? "" : " is-empty"}`}
                              aria-label={`修改「${label}」的内容`}
                              onClick={() => startEdit(field.id, "value")}
                            >
                              {field.value || "点击填写"}
                            </button>
                          )}
                          <div className="tpl-field-actions">
                            {others.length ? (
                              <MoreMenu
                                label={`移动「${label}」到其他分类`}
                                align="right"
                                items={others.map((name) => ({ label: `移到「${name}」`, onSelect: () => moveField(field.id, name) }))}
                              />
                            ) : null}
                            <button type="button" className="tpl-remove" aria-label={`删除「${label}」`} onClick={() => removeField(field.id)}>
                              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
                                <path d="M6 6l12 12M18 6L6 18" />
                              </svg>
                            </button>
                          </div>
                          {error ? <p className="note error tpl-field-error" role="alert">{error}</p> : null}
                        </div>
                      );
                    })}
                    {addRows(category)}
                    <button type="button" className="tpl-add-bar" aria-label={`在「${category}」添加字段`} onClick={() => startAdd(category)}>
                      添加字段
                    </button>
                  </div>
                </>
              ) : null}
            </section>
          );
        })}
        {newCat ? (
          <div className="tpl-newcat-form" role="group" aria-label="新建分类" data-newcat onKeyDown={(event) => { if (event.key === "Escape") onNewCatKey(event); }}>
            <label className="tpl-newcat-name">
              <span>分类名称</span>
              <input
                className="tpl-add-input"
                aria-label="分类名称"
                autoFocus
                value={newCat.name}
                onChange={(event) => setNewCat({ ...newCat, name: event.target.value, error: null })}
                onKeyDown={(event) => onNewCatKey(event)}
              />
            </label>
            {newCat.rows.map((row, index) => (
              <div key={index} className="tpl-newcat-row" role="group" aria-label={`新字段 ${index + 1}`}>
                <input
                  className="tpl-add-input"
                  aria-label="字段名称"
                  placeholder="字段名称"
                  value={row.key}
                  onChange={(event) => setNewRow(index, { key: event.target.value })}
                  onKeyDown={(event) => onNewCatKey(event)}
                />
                <textarea
                  className="tpl-add-input"
                  aria-label="内容"
                  placeholder="内容"
                  rows={1}
                  value={row.value}
                  onChange={(event) => setNewRow(index, { value: event.target.value })}
                  onKeyDown={(event) => onNewCatKey(event, index === newCat.rows.length - 1)}
                />
                {newCat.rows.length > 1 ? (
                  <button
                    type="button"
                    className="tpl-remove"
                    aria-label={`去掉新字段 ${index + 1}`}
                    onClick={() => setNewCat({ ...newCat, rows: newCat.rows.filter((_, i) => i !== index) })}
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                ) : (
                  <span />
                )}
              </div>
            ))}
            <button type="button" className="tpl-add-bar" onClick={() => setNewCat({ ...newCat, rows: [...newCat.rows, { key: "", value: "" }] })}>
              再添加一个字段
            </button>
            {newCat.error ? <p className="note error tpl-field-error" role="alert">{newCat.error}</p> : null}
            <div className="tpl-newcat-actions">
              <button type="button" onClick={() => setNewCat(null)}>取消</button>
              <button type="button" className="primary" disabled={saving || newCat.busy} onClick={createCategory}>创建分类</button>
            </div>
          </div>
        ) : (
          <button type="button" className="template-edit-newcat" onClick={startNewCategory}>
            新建分类
          </button>
        )}
      </div>
    </div>
  );
}
