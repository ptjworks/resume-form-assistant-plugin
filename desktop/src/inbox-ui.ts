import { mountAttachmentList } from "./attachment-list.ts";
import { openSettingsDialog, fragment, paragraph } from "./settings-dialog.ts";
// 「通知」视图（#552 改版）：左边一份按邮件流转顺序排的列表，右边读原文。
//
//   待处理 —— 邮箱发现的「新邮件」（只读了信头）+ 已存进本机、还没挂到投递的「待归档」
//   已处理 —— 已经关联到某条投递的
//   回收站 —— 删掉的，可恢复
//
// 这里不解析任何东西，也不碰路径：拿到的就是命令层已经清洗过的文本、`data:` 图片和说明。
// 正文、发件人一律经 escapeHtml 写入，邮件里的标签只会以字面文本出现。

import type {
  ApplicationSummary,
  AssociatedEvidence,
  EvidencePreview,
  EvidenceSummary,
  EvidencePurgePreview,
  EvidencePurgeResult,
  ImportReport,
  Invoke,
  Page,
} from "./api.ts";
import { maybe, must, select as selectEl, textarea } from "./dom.ts";
import { showStatus } from "./status-bar.ts";
import { stageLabel } from "./applications.ts";
import type { InboxRow, InboxTab, MailboxInboxState, Message } from "./inbox.ts";
import {
  EMPTY_INBOX,
  INBOX_TABS,
  PRIVACY_NOTE,
  STEP_LABEL,
  buildInboxRows,
  candidateSender,
  candidateTitle,
  describeAssociation,
  describeImport,
  describeUnassociation,
  duplicateNote,
  evidenceTitle,
  importedAtLabel,
  kindLabel,
  listTimeLabel,
  replyClassLabel,
  todoCount,
} from "./inbox.ts";

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function invokeError(error: unknown) {
  const detail = error as { message?: string; code?: string } | null;
  return detail?.message || detail?.code || "未知错误";
}

// 线条图标，只是装饰，读屏跳过。
const KIND_ICON: Record<string, string> = {
  eml: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></svg>',
  screenshot: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/></svg>',
  pdf: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>',
  text: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4h6v3H9zM9 12h6M9 16h4"/></svg>',
};
const ICON = {
  open: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  upload: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V4m-4.5 4.5L12 4l4.5 4.5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>',
  download: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m-4.5-4.5L12 15l4.5-4.5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>',
  paste: KIND_ICON.text,
  lock: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
};

/** 宿主注入的几件事：打开文件对话框、监听窗口拖放、挂 AI 整理面板。测试里换成假的。 */
export interface InboxHost {
  pickFiles?: (() => Promise<string[]>) | null;
  listenDrop?: ((handle: (paths: string[]) => void) => void) | null;
  /**
   * 把 AI 整理面板挂到右栏底部的挂载点上。真实实现是 React（`ai/mount.tsx`），
   * 这里只给容器和证据 id：**面板的状态不回流到这个旧视图**。
   */
  mountAi?:
    | ((
        container: Element,
        evidenceId: string,
        onConfirmed: (message: string, tone?: "success" | "warn") => void,
        options?: { compact?: boolean },
      ) => { unmount(): void })
    | null;
}

/** 从投递页点「N 封相关邮件」进来时，已处理只看这一条投递的。 */
interface DoneFilter {
  applicationId: string;
  label: string;
}

const TAB_IDS: Record<InboxTab, string> = { todo: "inbox-tab-todo", done: "inbox-tab-done", bin: "inbox-tab-bin" };

export function mountInbox(
  invoke: Invoke,
  { pickFiles = null, listenDrop = null, mountAi = null }: InboxHost = {},
) {
  const list = must("inbox-list");
  const preview = must("inbox-preview");
  const status = must("inbox-status");
  const count = maybe("inbox-count");
  const batch = maybe("inbox-batch");
  const filterBar = maybe("inbox-filter");
  const pasteBox = textarea("inbox-paste");
  const pasteDialog = maybe<HTMLDialogElement>("inbox-paste-dialog");
  const pasteStatus = maybe("inbox-paste-status");
  const associateDialog = maybe<HTMLDialogElement>("inbox-associate-dialog");

  let tab: InboxTab = "todo";
  const data: { todo: EvidenceSummary[]; done: AssociatedEvidence[]; bin: EvidenceSummary[] } = { todo: [], done: [], bin: [] };
  const loaded: Record<InboxTab, boolean> = { todo: false, done: false, bin: false };
  /** 待归档的条数，用来给「待处理」标签数数；没读到就是 null，不显示一个假的 0。 */
  let storedCount: number | null = null;
  let mail: MailboxInboxState | null = null;
  let mailBusy = false;
  let doneFilter: DoneFilter | null = null;
  let refreshRevision = 0;
  let countRevision = 0;
  let aiPanel: { unmount(): void } | null = null;
  let selectedKey: string | null = null;
  let previewToken = 0;
  let clearAttachments: (() => void) | null = null;
  let applications: ApplicationSummary[] = [];
  let applicationsTruncated = false;
  /** 导入正在进行：再点一次导入或再拖一批进来，等这一批说完结果再说。 */
  let importing = false;
  /** 关联 / 分类 / 删除正在路上：同一个按钮连点只发一次。 */
  let acting = false;
  let pasteOpener: HTMLElement | null = null;
  let associating: EvidencePreview | null = null;
  let associateOpener: HTMLElement | null = null;

  const promptByTab: Record<InboxTab, string> = {
    todo: '<div class="pane-empty"><h2>选择一封通知</h2><p>点左边的一封，在这里看原文，再决定留下、关联到投递，或删除。</p></div>',
    done: '<div class="pane-empty"><h2>选择一封通知</h2><p>已经关联到投递的邮件。可以查看原文，或取消关联。</p></div>',
    bin: '<div class="pane-empty"><h2>选择一封通知</h2><p>可查看原文和附件、恢复到原位置，或彻底删除。</p></div>',
  };

  /** 重画预览之前先把上一块 React 卸掉，不然它会跟着 innerHTML 一起被丢掉却没收工。 */
  function clearAiPanel() {
    aiPanel?.unmount();
    aiPanel = null;
  }

  function resetPreview(html: string) {
    previewToken += 1;
    clearAiPanel();
    clearAttachments?.(); clearAttachments = null;
    preview.innerHTML = html;
  }

  function say(message: Message | null) {
    showStatus(status, message?.text ?? "", {
      tone: message?.tone ?? "info",
      transient: message?.tone === "success" || message?.tone === "info",
    });
  }

  function currentRows(): InboxRow[] {
    return buildInboxRows({
      tab,
      candidates: mail?.candidates ?? [],
      stored: data.todo,
      done: data.done,
      bin: data.bin,
    });
  }

  function renderCount() {
    if (count) count.textContent = todoCount(storedCount, mail?.candidates.length ?? 0);
  }

  function renderTabs() {
    for (const entry of INBOX_TABS) {
      const node = maybe(TAB_IDS[entry.id]);
      if (!node) continue;
      node.setAttribute("aria-selected", String(entry.id === tab));
      node.tabIndex = entry.id === tab ? 0 : -1;
    }
    if (filterBar) {
      const filter = tab === "done" ? doneFilter : null;
      filterBar.hidden = !filter;
      const label = maybe("inbox-filter-label");
      if (label) label.textContent = filter ? `${filter.label} 的邮件` : "";
    }
  }

  /** 读失败不等于没有通知：已经显示的列表原样留着；从没读成功过就如实说读不出来。 */
  async function refresh(): Promise<boolean | null> {
    const current = tab;
    const revision = ++refreshRevision;
    const countTick = ++countRevision;
    // 「待处理」的数字属于待归档那份列表，即使正开着别的标签也要更新；它的请求不挡别的列表。
    const stored = invoke<EvidenceSummary[]>("list_inbox_cmd");
    void stored.then((next) => {
      if (countTick !== countRevision) return;
      storedCount = next.length;
      renderCount();
    }, () => {
      if (countTick !== countRevision) return;
      storedCount = null;
      renderCount();
    });
    let changed = true;
    try {
      const request: Promise<EvidenceSummary[] | AssociatedEvidence[]> =
        current === "todo"
          ? stored
          : current === "done"
            ? invoke<AssociatedEvidence[]>("list_associated_evidence_cmd", { applicationId: doneFilter?.applicationId ?? null })
            : invoke<EvidenceSummary[]>("list_recycled_evidence_cmd");
      const next = await request;
      if (revision !== refreshRevision || current !== tab) return null;
      changed = !loaded[current] || JSON.stringify(data[current]) !== JSON.stringify(next);
      (data as Record<InboxTab, unknown>)[current] = next;
    } catch (error) {
      if (revision !== refreshRevision || current !== tab) return null;
      say({ tone: "warn", text: `读不到通知：${invokeError(error)}` });
      if (!loaded[current]) {
        list.innerHTML = `<div class="pane-empty"><h3>${current === "bin" ? "读不到回收站" : "读不到通知"}</h3><p>请检查本机档案后重试。</p><button type="button" data-inbox-act="retry-read">重新读取</button></div>`;
        preview.innerHTML = '<div class="pane-empty" data-read-error><h2>暂时无法读取通知</h2><p>请点击列表中的「重新读取」重试。</p></div>';
      }
      return false;
    }
    loaded[current] = true;
    if (changed) renderList(); // 前台反复检查时，不必要的重画会夺走列表里的焦点。
    reconcile();
    return true;
  }

  /** 列表变了之后，右栏要跟上：选中的那封不见了就回到提示，整页没有一封就给空状态。 */
  function reconcile() {
    if (!loaded[tab]) return;
    const rows = currentRows();
    const gone = selectedKey !== null && !rows.some((row) => row.key === selectedKey);
    if (gone) {
      selectedKey = null;
      resetPreview(rows.length ? promptByTab[tab] : emptyState());
      renderList();
      return;
    }
    if (!rows.length) {
      if (selectedKey === null) { clearAiPanel(); preview.innerHTML = emptyState(); }
      return;
    }
    if (!selectedKey && preview.querySelector?.(".workspace-empty, [data-read-error], [data-list-loading]")) {
      preview.innerHTML = promptByTab[tab];
    }
  }

  /** 一封都没有：整页给空状态，导入入口就在眼前。 */
  function emptyState() {
    if (tab === "bin") return '<div class="workspace-empty"><h2>回收站为空</h2><p>删除的通知会保留原件、附件和关联，可以在这里恢复。</p></div>';
    if (tab === "done") {
      return doneFilter
        ? `<div class="workspace-empty"><h2>${escapeHtml(doneFilter.label)} 还没有邮件</h2><p>把「待处理」里的邮件关联到这条投递后，会出现在这里。</p></div>`
        : '<div class="workspace-empty"><h2>还没有处理过的通知</h2><p>把「待处理」里的邮件关联到投递后，会出现在这里。</p></div>';
    }
    return `
      <div class="workspace-empty inbox-empty">
        <span class="workspace-empty-icon">${ICON.upload}</span>
        <h2>没有待处理的通知</h2>
        <p>${escapeHtml(EMPTY_INBOX)}</p>
        <div class="workspace-empty-actions">
          <button type="button" class="primary" data-empty-act="connect">连接邮箱</button>
          <button type="button" data-empty-act="pick">${ICON.download}导入文件</button>
          <button type="button" data-empty-act="paste">${ICON.paste}粘贴文本</button>
        </div>
        <ul class="format-chips" aria-label="支持的格式">
          <li>${KIND_ICON.eml}.eml 邮件</li><li>${KIND_ICON.screenshot}PNG / JPEG 截图</li><li>${KIND_ICON.pdf}PDF 文档</li><li>${KIND_ICON.text}文本（.txt）或粘贴</li>
        </ul>
        <p class="privacy-note">${ICON.lock}<span>${escapeHtml(PRIVACY_NOTE)}</span></p>
      </div>`;
  }

  function renderBatch() {
    if (!batch) return;
    const candidates = tab === "todo" ? mail?.candidates ?? [] : [];
    batch.hidden = candidates.length < 2;
    if (batch.hidden) { batch.innerHTML = ""; return; }
    batch.innerHTML = `<span>${candidates.length} 封新邮件</span><span class="inbox-batch-actions"><button type="button" data-batch="save">全部留下</button><button type="button" data-batch="ignore">全部忽略</button></span>`;
    applyBusy();
  }

  /** 重画列表时记住键盘停在哪一行、滚到哪儿，画完还原，免得后台刷新把人的操作位置弄丢。 */
  function renderList() {
    const active = document.activeElement;
    const focusedRow = active instanceof HTMLElement && list.contains(active) ? active.dataset.row ?? null : null;
    const scrollTop = list.scrollTop;
    paintList();
    if (list.scrollTop !== scrollTop) list.scrollTop = scrollTop;
    if (focusedRow) {
      const again = [...list.querySelectorAll<HTMLElement>("button[data-row]")].find((node) => node.dataset.row === focusedRow);
      again?.focus();
    }
  }

  function paintList() {
    renderTabs();
    renderBatch();
    if (!loaded[tab]) {
      list.innerHTML = '<p class="todo-list-note muted">正在读取…</p>';
      return;
    }
    const rows = currentRows();
    const notes = tab === "todo" && mail?.note ? `<p class="inbox-list-note">${escapeHtml(mail.note)}</p>` : "";
    if (!rows.length) {
      const text = tab === "bin"
        ? '<h3>回收站为空</h3><p>删除的通知会在这里保留，可随时恢复。</p>'
        : tab === "done"
          ? `<h3>${doneFilter ? "这条投递还没有邮件" : "还没有处理过的通知"}</h3><p>关联到投递的邮件会出现在这里。</p>`
          : `<h3>没有待处理的通知</h3><p>${escapeHtml(EMPTY_INBOX)}</p>`;
      list.innerHTML = `${notes}<div class="pane-empty">${text}</div>`;
      return;
    }
    const more = tab === "todo" && mail?.canLoadMore
      ? `<button type="button" class="inbox-more" data-inbox-act="load-more">显示更多新邮件（还有 ${Math.max(0, mail.pendingCount - mail.candidates.length)} 封）</button>`
      : "";
    list.innerHTML = `${notes}<ul class="inbox-rows">${rows
      .map((row) => {
        const active = row.key === selectedKey;
        const tag = tab === "todo" ? `<span class="step-tag" data-step="${row.step}">${STEP_LABEL[row.step]}</span>` : "";
        const dup = row.duplicate ? '<span class="step-tag" data-step="dup">内容重复</span>' : "";
        const sub = row.sub ? `<span class="row-sub">${escapeHtml(row.sub)}</span>` : "";
        const meta = tag || dup || sub ? `<span class="row-meta">${tag}${dup}${sub}</span>` : "";
        return `<li${active ? ' class="active"' : ""}>
          <button type="button" data-row="${escapeHtml(row.key)}" aria-current="${active}">
            <span class="row-top"><span class="row-sender">${escapeHtml(row.sender)}</span><time>${escapeHtml(listTimeLabel(row.time))}</time></span>
            <span class="row-title">${escapeHtml(row.title)}</span>${meta}
          </button>
        </li>`;
      })
      .join("")}</ul>${more}`;
  }

  function applyBusy() {
    document.querySelectorAll<HTMLButtonElement>("#inbox-preview [data-mail-act], #inbox-batch [data-batch]").forEach((button) => {
      button.disabled = mailBusy;
    });
  }

  async function showTab(next: InboxTab, force = false) {
    if (next === tab && loaded[tab] && !force) {
      renderTabs();
      return;
    }
    // 投递页带来的筛选只管那一次跳转：离开「已处理」就清掉，回来看到的是全部。
    if (next !== "done") doneFilter = null;
    tab = next;
    selectedKey = null;
    data[next] = [];
    loaded[next] = false;
    resetPreview('<p class="pane-loading muted" data-list-loading>正在读取通知…</p>');
    renderList();
    await refresh();
  }

  /** 邮件换了位置（关联了、取消关联了）：跟着它走，在新位置上继续显示这封，别让它凭空消失。 */
  async function reveal(next: InboxTab, evidenceId: string) {
    if (next === "done") doneFilter = null;
    await showTab(next, true);
    const row = currentRows().find((entry) => entry.kind === "evidence" && entry.id === evidenceId);
    if (row) await selectRow(row.key);
  }

  /** 从投递页点「N 封相关邮件」进来：已处理里只看这一条投递的邮件。 */
  async function showApplication(applicationId: string, label: string) {
    doneFilter = { applicationId, label: label || "这条投递" };
    tab = "done";
    selectedKey = null;
    data.done = []; loaded.done = false;
    resetPreview('<p class="pane-loading muted" data-list-loading>正在读取通知…</p>');
    renderList();
    await refresh();
  }

  async function clearFilter() {
    if (!doneFilter) return;
    doneFilter = null;
    selectedKey = null;
    data.done = []; loaded.done = false;
    resetPreview('<p class="pane-loading muted" data-list-loading>正在读取通知…</p>');
    renderList();
    await refresh();
  }

  async function selectRow(key: string) {
    const row = currentRows().find((entry) => entry.key === key);
    if (!row) return;
    selectedKey = key;
    if (row.kind === "candidate") {
      showCandidate(row.id);
      renderList();
      return;
    }
    await selectEvidence(row);
  }

  async function selectEvidence(row: InboxRow) {
    selectedKey = row.key;
    const token = ++previewToken;
    clearAiPanel();
    clearAttachments?.(); clearAttachments = null;
    preview.innerHTML = '<p class="pane-loading muted" role="status">正在读取这封通知…</p>';
    renderList();
    let item: EvidencePreview;
    try {
      item = await invoke<EvidencePreview>("get_evidence_preview_cmd", { evidenceId: row.id });
    } catch (error) {
      if (token !== previewToken) return;
      preview.innerHTML = `<div class="pane-error"><p class="banner">${escapeHtml(`读不出这封通知：${invokeError(error)}`)}</p><button type="button" data-act="retry-preview">再读一次</button></div>`;
      preview.querySelector<HTMLElement>('[data-act="retry-preview"]')?.addEventListener("click", () => void selectEvidence(row));
      return;
    }
    if (token !== previewToken) return;
    renderPreview(item, row);
  }

  async function loadApplications() {
    try {
      const page = await invoke<Page<ApplicationSummary>>("list_applications_cmd", {
        args: { stage: "all", recycle: "active", desc: true, limit: 500, offset: 0 },
      });
      applications = page?.items ?? [];
      applicationsTruncated = (page?.total ?? applications.length) > applications.length;
    } catch {
      applications = [];
      applicationsTruncated = false;
    }
  }

  /** 新邮件：邮箱里发现的，只读了信头。右栏只能看信头和入选原因，要么留下要么忽略。 */
  function showCandidate(id: string) {
    previewToken += 1;
    clearAiPanel();
    clearAttachments?.(); clearAttachments = null;
    const candidate = mail?.candidates.find((entry) => entry.id === id);
    if (!candidate) {
      preview.innerHTML = promptByTab.todo;
      return;
    }
    const sender = [candidate.header.fromName, candidate.header.fromAddr].filter(Boolean).join(" · ") || "未知发件人";
    const sentAt = candidate.header.sentAt ? importedAtLabel(candidate.header.sentAt) : "发送时间未知";
    const failure = mail?.failures[candidate.id];
    preview.innerHTML = `
      <article class="mail-view pending-mail-preview" data-state="new">
        <header class="mail-head">
          <div class="mail-head-top">
            <h2>${escapeHtml(candidateTitle(candidate))}</h2>
            <div class="mail-actions">
              <button type="button" class="primary" data-mail-act="keep">留下</button>
              <button type="button" data-mail-act="ignore">忽略</button>
            </div>
          </div>
          <p class="mail-meta"><span class="mail-from">${escapeHtml(sender)}</span><span>${escapeHtml(sentAt)}</span></p>
          <p class="mail-link">新邮件 · 来自 ${escapeHtml(candidate.email)} · 只读取了信头，原文还没有下载</p>
        </header>
        <div class="mail-scroll pending-mail-scroll">
          <section class="pending-mail-content" aria-label="新邮件">
            ${failure ? `<p class="note warn" role="alert">${escapeHtml(failure)}</p>` : ""}
          </section>
        </div>
      </article>`;
    preview.querySelector<HTMLButtonElement>('[data-mail-act="keep"]')?.addEventListener("click", () => void mail?.actions.save([candidate.id]));
    preview.querySelector<HTMLButtonElement>('[data-mail-act="ignore"]')?.addEventListener("click", () => void mail?.actions.ignore([candidate.id]));
    applyBusy();
  }

  function actionButtons(state: "archive" | "done" | "bin") {
    // 「AI 整理」按钮由 React 挂在这个位置，紧挨着「关联到投递」。
    const ai = '<span id="inbox-ai" class="mail-ai-slot"></span>';
    if (state === "bin") return '<button type="button" class="primary" data-act="restore">恢复</button><button type="button" class="evidence-recycle-button" data-act="purge">彻底删除</button>';
    const remove = '<button type="button" class="evidence-recycle-button" data-act="recycle" title="移到回收站，之后还能恢复">删除</button>';
    return state === "done"
      ? `${ai}<button type="button" data-act="unassociate">取消关联</button>${remove}`
      : `${ai}<button type="button" class="primary" data-act="associate">关联到投递</button>${remove}`;
  }

  function renderPreview(item: EvidencePreview, row: InboxRow) {
    clearAttachments?.(); clearAttachments = null;
    // 谁调 renderPreview 都先把上一块 React 卸掉：漏掉这一步，旧面板的清理
    // （取消进行中的请求）就永远不会跑。
    clearAiPanel();
    const recycled = Boolean(item.recycled || tab === "bin");
    const state: "archive" | "done" | "bin" = recycled ? "bin" : item.applicationId ? "done" : "archive";
    const duplicate = duplicateNote(item);
    // 正文经过转义写入：邮件里的 <script> 只会作为字面文本出现。
    const body = item.bodyExtract ? `<pre class="evidence-body">${escapeHtml(item.bodyExtract)}</pre>` : "";
    const image = item.imageDataUrl
      ? `<img class="evidence-image" alt="导入的截图" src="${escapeHtml(item.imageDataUrl)}">`
      : "";
    const note = item.note ? `<p class="evidence-note">${escapeHtml(item.note)}</p>` : "";
    const openable = item.kind === "pdf" || (item.kind === "screenshot" && !item.imageDataUrl);
    const nothing = !body && !image && !note && !openable
      ? '<p class="evidence-note">这条材料没有可以在应用里显示的正文。</p>'
      : "";
    const sender = (item.fromAddr || "").trim() || kindLabel(item.kind);
    const when = item.sentAt ? importedAtLabel(item.sentAt) : `导入于 ${importedAtLabel(item.importedAt)}`;
    const linkedTo = state === "done" ? row.sub || "所选投递" : "";
    // 分类不再是要用户操心的一步：AI 整理确认时会记下，这里只在有的时候显示成一个小标签。
    const tags = item.replyClass && item.replyClass !== "unknown"
      ? `<span class="tag-pill is-static">${escapeHtml(replyClassLabel(item.replyClass))}</span>`
      : "";

    preview.innerHTML = `
      <article class="mail-view" data-state="${state}" data-kind="${escapeHtml(item.kind)}">
        <header class="mail-head">
          <div class="mail-head-top">
            <h2>${escapeHtml(evidenceTitle(item))}</h2>
            <div class="mail-actions">${actionButtons(state)}</div>
          </div>
          <p class="mail-meta"><span class="mail-from">${escapeHtml(sender)}</span><span>${escapeHtml(when)}</span></p>
          ${linkedTo ? `<p class="mail-link">已关联「${escapeHtml(linkedTo)}」</p>` : ""}
          <div class="mail-tags">${tags}</div>
        </header>
        <div class="mail-scroll evidence-reader-scroll">
          <section class="evidence-original" aria-label="${item.kind === "eml" ? "邮件正文" : "原文"}">
            ${item.kind === "eml" ? '<div id="inbox-mail-attachments"></div>' : ""}
            ${duplicate ? `<p class="evidence-duplicate-note">${escapeHtml(duplicate)}</p>` : ""}
            ${recycled ? '<p class="evidence-note evidence-recycled-note">这封通知在回收站中。原件、附件及原关联均保留，恢复后回到原位置。</p>' : ""}
            ${note}
            ${openable ? `<p class="evidence-open"><button type="button" data-act="open">${ICON.open}用系统程序打开</button></p>` : ""}
            ${image}
            ${item.kind === "eml" ? `<div data-mail-body>${body}</div>` : body}
            ${nothing}
          </section>
        </div>
      </article>
    `;
    const slot = maybe("inbox-ai");
    // 只有截图和 PDF 目前读不了正文（导入的 .txt 记成「未知类型」，但后端读得了），这两类才不摆 AI 整理。
    if (mountAi && slot && !recycled && item.kind !== "screenshot" && item.kind !== "pdf") {
      // 确认成功那句话由状态栏说：面板本身马上会随着重画被卸掉。
      aiPanel = mountAi(slot as unknown as Element, item.id, (message, tone) => {
        say({ tone: tone ?? "success", text: message });
        // 确认会把这封关联到投递上：跟过去，在「已处理」里继续显示它。
        void reveal("done", item.id);
      }, { compact: true });
    }
    const attachmentRoot = preview.querySelector<HTMLElement>("#inbox-mail-attachments");
    if (attachmentRoot) clearAttachments = mountAttachmentList(attachmentRoot, invoke, item.id, evidenceTitle(item), preview.querySelector<HTMLElement>("[data-mail-body]"), { hideEmpty: true });
    preview.querySelectorAll<HTMLElement>("button[data-act]").forEach((button) => {
      button.addEventListener("click", () => {
        const action = button.dataset.act;
        if (action) void act(action, item, row);
      });
    });
    // 保存期间切换通知或重画详情，新按钮也必须遵守同一个操作锁。
    setActing(acting);
  }

  function setActing(busy: boolean) {
    acting = busy;
    preview.querySelectorAll<HTMLButtonElement>(".mail-view button[data-act]").forEach((control) => {
      control.disabled = busy;
    });
  }

  async function act(action: string, item: EvidencePreview, row: InboxRow) {
    if (acting) return;
    const selectionToken = previewToken;
    try {
      if (action === "purge") {
        setActing(true);
        const confirmation = await invoke<EvidencePurgePreview>("preview_evidence_purge_cmd", { evidenceId: item.id });
        if (selectionToken !== previewToken || selectedKey !== row.key || tab !== "bin") return;
        let result: EvidencePurgeResult | null = null;
        const confirmed = await openSettingsDialog({
          title: "彻底删除这封通知？",
          intro: confirmation.title,
          body: fragment(
            paragraph("将删除这封通知的正文、关联和 AI 整理建议，并清理不再被其他通知引用的原件及内嵌附件。投递、已记录的进度和待办保留。"),
            confirmation.originalShared && paragraph("这份原件目前还被其他通知使用；只有删除时已无人引用的原件才会清理。"),
            paragraph("删除后无法在回收站恢复。已有备份不会一并删除；邮箱中的邮件不受影响。", "settings-dialog-warn"),
          ),
          confirmLabel: "彻底删除", busyLabel: "正在删除…", tone: "danger", size: "md",
          action: async () => { result = await invoke<EvidencePurgeResult>("purge_recycled_evidence_cmd", { target: confirmation.target }); },
          describeError: error => `删除失败：${invokeError(error)}`,
        });
        if (!confirmed || !result) return;
        const done = result as EvidencePurgeResult;
        const message = done.cleanupPending
          ? "通知已彻底删除，但原件文件尚未清理完成。可到设置中的附件检查重试清理。"
          : `通知已彻底删除。${done.originalShared ? "其他通知仍在使用的共用原件已保留。" : "不再被引用的原件及内嵌附件已清理。"}`;
        // 即使重新读列表失败，也先把已删掉那封的正文从界面上拿掉。
        data.bin = data.bin.filter(entry => entry.id !== item.id);
        renderList();
        if (selectedKey === row.key) {
          selectedKey = null;
          resetPreview(data.bin.length ? promptByTab.bin : emptyState());
        }
        say({ tone: done.cleanupPending ? "warn" : "success", text: message });
        if (await refresh() === false) say({ tone: "warn", text: `${message}列表暂时无法刷新，请稍后重新读取。` });
        return;
      }
      if (action === "recycle" || action === "restore") {
        setActing(true);
        await invoke("set_evidence_recycled_cmd", { evidenceId: item.id, recycled: action === "recycle" });
        say({
          tone: "success",
          text: action === "recycle"
            ? "已移到回收站，原件和附件保留，可在那里恢复。"
            : item.applicationId ? "已恢复到「已处理」。" : "已恢复到「待处理」。",
        });
        await refresh();
        return;
      }
      if (action === "open") {
        setActing(true);
        await invoke("open_evidence_cmd", { evidenceId: item.id });
        say({ tone: "info", text: "已交给系统默认程序打开本机副本——那会离开这个应用。" });
        return;
      }
      if (action === "associate") {
        setActing(true);
        await openAssociate(item);
        return;
      }
      if (action === "unassociate") {
        setActing(true);
        await invoke("unassociate_evidence_cmd", { evidenceId: item.id });
        say(describeUnassociation());
        await reveal("todo", item.id);
        return;
      }
    } catch (error) {
      say({ tone: "warn", text: `没能完成这一步：${invokeError(error)}` });
    } finally {
      if (acting && !associating) setActing(false);
    }
  }

  // ---- 关联到投递：弹窗里一个可搜索的投递列表，点哪条就关联到哪条 ----

  let associateBusy = false;

  function sayInAssociate(text: string) {
    const node = maybe("inbox-associate-status");
    if (!node) return;
    node.textContent = text;
    node.className = text ? "note warn" : "note";
  }

  function renderAssociateList() {
    const list = maybe("inbox-associate-list");
    if (!list) return;
    const query = (maybe<HTMLInputElement>("inbox-associate-search")?.value ?? "").trim().toLowerCase();
    const shown = applications.filter((app) => !query || `${app.company} ${app.title}`.toLowerCase().includes(query));
    list.innerHTML = shown.length
      ? shown
          .map((app) => `<li><button type="button" data-app="${escapeHtml(app.id)}"${associateBusy ? " disabled" : ""}><span class="assoc-name"><strong>${escapeHtml(app.company)}</strong><span>${escapeHtml(app.title)}</span></span>${app.current_stage ? `<small>${escapeHtml(stageLabel(app.current_stage))}</small>` : ""}</button></li>`)
          .join("")
      : `<li class="assoc-empty">${applications.length ? "没有匹配的投递" : "还没有在办的投递"}</li>`;
  }

  async function openAssociate(item: EvidencePreview) {
    if (!associateDialog) return;
    await loadApplications();
    associateBusy = false;
    const search = maybe<HTMLInputElement>("inbox-associate-search");
    if (search) search.value = "";
    renderAssociateList();
    // 只在有话非说不可时才出现：没有投递可选，或投递太多没列全。
    const hint = maybe("inbox-associate-hint");
    if (hint) {
      hint.textContent = !applications.length
        ? "先到「投递」页新增一条，再回来关联。"
        : applicationsTruncated ? "投递太多，这里只列出了最近 500 条。" : "";
    }
    sayInAssociate("");
    associating = item;
    const active = document.activeElement;
    associateOpener = active && "focus" in active ? (active as HTMLElement) : null;
    if (!associateDialog.open) associateDialog.showModal();
    search?.focus();
  }

  function closeAssociate() {
    associateDialog?.close();
    associating = null;
    sayInAssociate("");
    setActing(false);
    if (associateOpener?.isConnected) associateOpener.focus();
    associateOpener = null;
  }

  async function associateTo(applicationId: string) {
    const item = associating;
    if (!item || associateBusy) return;
    associateBusy = true;
    renderAssociateList();
    const cancelButton = maybe<HTMLButtonElement>("inbox-associate-cancel");
    if (cancelButton) cancelButton.disabled = true;
    const chosen = applications.find((app) => app.id === applicationId);
    try {
      await invoke("associate_evidence_cmd", { evidenceId: item.id, applicationId });
    } catch (error) {
      associateBusy = false;
      if (cancelButton) cancelButton.disabled = false;
      renderAssociateList();
      sayInAssociate(`没能关联：${invokeError(error)}`);
      return;
    }
    associateBusy = false;
    if (cancelButton) cancelButton.disabled = false;
    closeAssociate();
    say(describeAssociation({ id: item.id }, chosen ? `${chosen.company} · ${chosen.title}` : undefined));
    await reveal("done", item.id);
  }

  // ---- 导入 ----

  async function importPaths(paths: string[] | null | undefined) {
    if (!paths?.length) return;
    await runImport({ paths });
  }

  /** 返回内容是否已保存或确认已存在；收到失败报告不等于导入成功。 */
  async function runImport(args: { paths?: string[]; text?: string }): Promise<boolean> {
    if (importing) {
      say({ tone: "warn", text: "上一批还在导入，等它完成再导入下一批。" });
      return false;
    }
    importing = true;
    say({ tone: "pending", text: "正在导入…" });
    try {
      const report = await invoke<ImportReport>("import_evidence_cmd", { args });
      const message = describeImport(report);
      const stored = (report?.imported?.length ?? 0) + (report?.duplicates?.length ?? 0) > 0;
      say(message);
      // 新导入的在「待处理」里：正看着别的标签就先回来。
      if (stored && tab !== "todo") await showTab("todo");
      const refreshed = await refresh();
      if (refreshed === false) {
        say({ tone: "warn", text: `${message.text}列表刷新失败，${stored ? "材料已保存，无需重复导入。" : "内容仍保留，可重试导入。"}` });
      }
      // 只导入了一条新的：直接打开它，省得再去列表里找。
      const fresh = report?.imported ?? [];
      const row = fresh.length === 1 && fresh[0] ? currentRows().find((entry) => entry.kind === "evidence" && entry.id === fresh[0]!.id) : null;
      if (refreshed && row) await selectRow(row.key);
      return stored;
    } catch (error) {
      say({ tone: "warn", text: `导入失败：${invokeError(error)}` });
      return false;
    } finally {
      importing = false;
    }
  }

  async function pick() {
    if (!pickFiles) {
      say({ tone: "warn", text: "这个环境里打不开文件选择框，可以把文件拖进窗口。" });
      return;
    }
    let paths: string[] = [];
    try {
      paths = await pickFiles();
    } catch (error) {
      say({ tone: "warn", text: `打不开文件选择框：${invokeError(error)}` });
      return;
    }
    await importPaths(paths);
  }

  function sayInPaste(text: string) {
    if (!pasteStatus) return;
    pasteStatus.textContent = text;
    pasteStatus.className = text ? "note warn" : "note";
  }

  function openPaste() {
    sayInPaste("");
    const active = document.activeElement;
    pasteOpener = active && "focus" in active ? (active as HTMLElement) : null;
    if (pasteDialog && !pasteDialog.open) pasteDialog.showModal();
    pasteBox.focus();
  }

  function closePaste() {
    pasteDialog?.close();
    sayInPaste("");
    if (pasteOpener?.isConnected) pasteOpener.focus();
    pasteOpener = null;
  }

  async function submitPaste() {
    const text = pasteBox.value ?? "";
    if (!text.trim()) {
      sayInPaste("先粘贴一段文本再导入。");
      say({ tone: "warn", text: "先粘贴一段文本再导入。" });
      pasteBox.focus();
      return;
    }
    const save = maybe<HTMLButtonElement>("inbox-paste-save");
    if (save) {
      save.disabled = true;
      save.textContent = "正在导入…";
    }
    pasteBox.readOnly = true;
    const ok = await runImport({ text });
    pasteBox.readOnly = false;
    if (save) {
      save.disabled = false;
      save.textContent = "导入这段文本";
    }
    if (ok) {
      // 成功才清空：失败时用户粘贴的那一大段还在框里，改一改就能再导入。
      pasteBox.value = "";
      closePaste();
    } else {
      sayInPaste(status.textContent || "导入失败，内容还在框里，可以再试一次。");
    }
  }

  // ---- 邮箱「新邮件」：由 mailbox-ui 整理好交过来 ----

  let mailSignature = "";
  function setMailbox(next: MailboxInboxState) {
    const signature = JSON.stringify({ c: next.candidates, p: next.pendingCount, n: next.note, f: next.failures, m: next.canLoadMore });
    mail = next;
    renderCount();
    if (signature === mailSignature) return;
    mailSignature = signature;
    if (tab !== "todo") return;
    renderList();
    // 正看着的新邮件被处理掉了，或它的失败原因变了：右栏跟上。
    if (selectedKey?.startsWith("c:")) {
      if (next.candidates.some((entry) => `c:${entry.id}` === selectedKey)) showCandidate(selectedKey.slice(2));
      else reconcile();
    } else if (!selectedKey) reconcile();
  }

  function setMailboxBusy(busy: boolean) {
    mailBusy = busy;
    applyBusy();
  }

  // ---- 事件 ----

  list.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const row = target?.closest?.<HTMLElement>("button[data-row]");
    if (row?.dataset.row) { void selectRow(row.dataset.row); return; }
    const control = target?.closest?.<HTMLElement>("[data-inbox-act]");
    if (control?.dataset.inboxAct === "retry-read") { say(null); void refresh(); }
    else if (control?.dataset.inboxAct === "load-more") mail?.actions.loadMore();
  });
  batch?.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement | null)?.closest?.<HTMLElement>("button[data-batch]");
    const candidates = mail?.candidates ?? [];
    if (!button || !mail || candidates.length < 2) return;
    const ids = candidates.map((entry) => entry.id);
    if (button.dataset.batch === "save") { void mail.actions.save(ids); return; }
    const actions = mail.actions;
    void openSettingsDialog({
      title: `忽略这 ${ids.length} 封新邮件？`,
      body: paragraph("忽略后不会再提示这些邮件；邮箱里的原件保持原样，不受影响。"),
      confirmLabel: "全部忽略",
      action: async () => { await actions.ignore(ids); },
    });
  });
  const tabNodes = INBOX_TABS.map((entry) => ({ id: entry.id, node: maybe(TAB_IDS[entry.id]) }));
  tabNodes.forEach(({ id, node }, index) => {
    node?.addEventListener("click", () => void showTab(id));
    node?.addEventListener("keydown", (event) => {
      const move = ({ ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabNodes.length - 1 } as Record<string, number>)[(event as KeyboardEvent).key];
      if (move === undefined) return;
      event.preventDefault();
      const target = tabNodes[(move + tabNodes.length) % tabNodes.length]!;
      target.node?.click();
      target.node?.focus();
    });
  });
  maybe("inbox-filter-clear")?.addEventListener("click", () => void clearFilter());
  maybe("inbox-pick")?.addEventListener("click", () => void pick());
  maybe("inbox-paste-open")?.addEventListener("click", openPaste);
  maybe("inbox-paste-cancel")?.addEventListener("click", () => {
    if (importing) return;
    closePaste();
  });
  pasteDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (importing) return;
    closePaste();
  });
  maybe<HTMLFormElement>("inbox-paste-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitPaste();
  });
  // 点了某条投递、请求还在路上时，「取消」和 Esc 不响应：否则界面说取消了，后台其实已经关联。
  maybe("inbox-associate-cancel")?.addEventListener("click", () => { if (!associateBusy) closeAssociate(); });
  associateDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (!associateBusy) closeAssociate();
  });
  maybe<HTMLFormElement>("inbox-associate-form")?.addEventListener("submit", (event) => event.preventDefault());
  maybe("inbox-associate-search")?.addEventListener("input", renderAssociateList);
  maybe("inbox-associate-list")?.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement | null)?.closest?.<HTMLElement>("button[data-app]");
    if (button?.dataset.app) void associateTo(button.dataset.app);
  });
  preview.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement | null)?.closest?.<HTMLElement>("button[data-empty-act]");
    if (!button) return;
    if (button.dataset.emptyAct === "pick") void pick();
    else if (button.dataset.emptyAct === "paste") openPaste();
  });

  if (listenDrop) listenDrop((paths) => void importPaths(paths));
  renderTabs();

  return { refresh, importPaths, submitPaste, setMailbox, setMailboxBusy, showTab, showApplication };
}
