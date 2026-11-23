import { useCallback, useEffect, useState } from "react";
import type { SiteAnswerView } from "../api.ts";
import { useInvoke } from "../react/invoke.tsx";
import type { Listen } from "./LegacyImport.tsx";
import { ResumeDialog } from "./ResumeDialog.tsx";
import type { Notice } from "./resume-text.ts";

function describe(error: unknown): Notice {
  const err = error as { message?: string } | null;
  return { tone: "error", text: err?.message ?? "操作失败，请重试。" };
}

function bySite(answers: SiteAnswerView[]): Array<[string, SiteAnswerView[]]> {
  const groups = new Map<string, SiteAnswerView[]>();
  answers.forEach((answer) => {
    groups.set(answer.site, [...(groups.get(answer.site) ?? []), answer]);
  });
  return [...groups];
}

/**
 * 按公司记住的回答（#429）。题目问到对方公司的（「是否有亲属在本公司工作」），回答换一家可能不同，
 * 插件在用户确认后按网站存到这里，只在同一家公司的网申里自动填。
 *
 * 界面上只是「我的信息」下面的一行小入口；点「查看」才弹出完整列表，能删单条或删整家。
 * 答错了删掉，下次在那个网站填好后插件会再问要不要记住。
 *
 * 入口要显示数量，所以挂上就读；插件存了新的回答时也重新读。读取失败时入口不显示数量，
 * 打开列表才把原因说出来。
 */
export function SiteAnswers({ listen }: { listen?: Listen }) {
  const invoke = useInvoke();
  const [answers, setAnswers] = useState<SiteAnswerView[] | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [confirmSite, setConfirmSite] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // 手动展开或收起过的公司；没动过的按默认：公司不多（3 家以内）全部展开，更多就先收起，只看公司名。
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    if (!invoke) return;
    try {
      setAnswers(await invoke<SiteAnswerView[]>("list_site_answers_cmd"));
      setNotice((current) => (current?.tone === "error" ? null : current));
    } catch (error) {
      setNotice(describe(error));
    }
  }, [invoke]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!listen) return;
    let alive = true;
    let unlisten: (() => void) | undefined;
    void Promise.resolve(listen("site-answers-changed", () => { if (alive) void load(); })).then((stop) => {
      if (!stop) return;
      if (alive) unlisten = stop;
      else stop();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [listen, load]);

  const remove = async (site: string, question?: string) => {
    if (!invoke || busy) return;
    setBusy(true);
    try {
      setAnswers(await invoke<SiteAnswerView[]>("delete_site_answers_cmd", question === undefined ? { site } : { site, question }));
      setNotice({ tone: "ok", text: question === undefined ? `已删除 ${site} 的全部回答。` : `已删除「${question}」。` });
    } catch (error) {
      setNotice(describe(error));
    } finally {
      setBusy(false);
      setConfirmSite(null);
    }
  };

  const close = () => {
    setOpen(false);
    setConfirmSite(null);
    setQuery("");
  };

  if (!invoke) return <p className="site-answers-entry muted">没有连上桌面程序，按公司记住的回答要在桌面程序里查看。</p>;
  const allSites = bySite(answers ?? []);
  const needle = query.trim().toLowerCase();
  // 搜公司名、题目或回答；公司名对上就整家都留着。
  const sites = needle
    ? allSites.flatMap(([site, items]): Array<[string, SiteAnswerView[]]> => {
        if (site.toLowerCase().includes(needle)) return [[site, items]];
        const hits = items.filter((item) => item.question.toLowerCase().includes(needle) || item.answer.toLowerCase().includes(needle));
        return hits.length ? [[site, hits]] : [];
      })
    : allSites;
  const isExpanded = (site: string) => (needle ? true : toggled[site] ?? allSites.length <= 3);
  const confirmCount = allSites.find(([site]) => site === confirmSite)?.[1].length ?? 0;
  const summary = answers === null ? "" : allSites.length ? ` · ${allSites.length} 家` : " · 还没有";

  return (
    <section className="site-answers-entry" aria-label="按公司记住的回答">
      <p>
        <span>按公司记住的回答</span>
        {summary}
      </p>
      <button
        type="button"
        className="link-button"
        onClick={() => {
          setNotice((current) => (current?.tone === "ok" ? null : current));
          setOpen(true);
        }}
      >
        查看
      </button>
      <ResumeDialog
        open={open}
        className={confirmSite === null ? "site-answers-dialog" : undefined}
        tone={confirmSite !== null ? "danger" : "default"}
        title={confirmSite !== null ? "删除这家公司的回答？" : "按公司记住的回答"}
        focusKey={confirmSite !== null ? "confirm" : "list"}
        onCancel={() => (confirmSite !== null ? setConfirmSite(null) : close())}
        cancelDisabled={busy}
        footer={
          confirmSite !== null ? (
            <>
              <button type="button" data-autofocus disabled={busy} onClick={() => setConfirmSite(null)}>取消</button>
              <button type="button" className="danger-solid" disabled={busy} onClick={() => void remove(confirmSite)}>删除</button>
            </>
          ) : (
            <button type="button" data-autofocus onClick={close}>关闭</button>
          )
        }
      >
        {confirmSite !== null ? (
          <p>{confirmSite} 的 {confirmCount} 个回答会删掉。下次在这家公司的网申里要重新填写，填好后插件会再问要不要记住。</p>
        ) : (
          <div className="site-answers">
            <p className="muted">只在同一家公司的网申里自动填写，不会带到别家。在插件里填好后点「记住」会存到这里。</p>
            {allSites.length ? (
              <div className="site-answers-search">
                <input
                  type="search"
                  aria-label="搜索公司或题目"
                  placeholder="搜公司、题目或回答"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
            ) : null}
            {answers === null ? null : sites.length ? sites.map(([site, items]) => {
              const expanded = isExpanded(site);
              const total = allSites.find(([name]) => name === site)?.[1].length ?? items.length;
              return (
                <section key={site} className="site-answers-site" aria-label={site}>
                  <div className="site-answers-site-head">
                    <h3 className="site-answers-heading">
                    <button
                      type="button"
                      className="site-answers-toggle"
                      aria-expanded={expanded}
                      // 搜索时命中的公司一律展开，点箭头不做事，也不记成「手动收起」。
                      onClick={() => { if (!needle) setToggled((current) => ({ ...current, [site]: !expanded })); }}
                    >
                      <span className={`template-group-chevron${expanded ? " is-open" : ""}`} aria-hidden="true">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M9 6l6 6-6 6" />
                        </svg>
                      </span>
                      <span className="site-answers-name">{site}</span>
                      <span className="muted">{needle ? `命中 ${items.length} 条（共 ${total} 条）` : `${total} 条`}</span>
                    </button>
                    </h3>
                    <button type="button" disabled={busy} onClick={() => setConfirmSite(site)}>删除这家公司</button>
                  </div>
                  {expanded ? (
                    <ul>
                      {items.map((item) => (
                        <li key={item.question}>
                          <div>
                            <p className="site-answers-question">{item.question}</p>
                            <p className="site-answers-answer">{item.answer}</p>
                          </div>
                          <span className="muted">{item.updatedAt.slice(0, 10)}</span>
                          <button type="button" aria-label={`删除「${item.question}」`} disabled={busy} onClick={() => void remove(site, item.question)}>
                            删除
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </section>
              );
            }) : <p>{allSites.length ? "没有找到匹配的公司或题目。" : "还没有记住任何公司的回答。"}</p>}
            {notice ? <p className={`note ${notice.tone}`} role="status">{notice.text}</p> : null}
          </div>
        )}
      </ResumeDialog>
    </section>
  );
}
