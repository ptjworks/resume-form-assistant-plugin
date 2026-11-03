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
 * 按网站记住的回答（#429）。题目问到对方公司的（「是否有亲属在本公司工作」），回答换一家可能不同，
 * 插件在用户确认后按网站存到这里，只在同一个网站自动填。这里只看和删：
 * 答错了删掉，下次在那个网站填好后插件会再问要不要记住。
 *
 * 切到这一页时才读（简历页的几个视图一直挂着），插件存了新的回答时也重新读。
 */
export function SiteAnswers({ listen, active }: { listen?: Listen; active: boolean }) {
  const invoke = useInvoke();
  const [answers, setAnswers] = useState<SiteAnswerView[] | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmSite, setConfirmSite] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!invoke) return;
    try {
      setAnswers(await invoke<SiteAnswerView[]>("list_site_answers_cmd"));
    } catch (error) {
      setNotice(describe(error));
    }
  }, [invoke]);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

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

  if (!invoke) return <p className="muted resume-offline">没有连上桌面程序，网站回答要在桌面程序里查看。</p>;
  const sites = bySite(answers ?? []);
  const confirmCount = sites.find(([site]) => site === confirmSite)?.[1].length ?? 0;

  return (
    <section className="resume-card site-answers" aria-labelledby="site-answers-title">
      <div className="site-answers-head">
        <h2 id="site-answers-title">网站回答</h2>
        <p>题目问到对方公司的回答（比如「是否有亲属在本公司工作」）按网站记在这里，只在同一个网站自动填写。在插件里填好后点「记住」会存到这里。</p>
      </div>
      <div className="site-answers-body">
        {answers === null ? null : sites.length ? sites.map(([site, items]) => (
          <section key={site} className="site-answers-site" aria-label={site}>
            <div className="site-answers-site-head">
              <h3>{site}</h3>
              <button type="button" disabled={busy} onClick={() => setConfirmSite(site)}>删除这个网站</button>
            </div>
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
          </section>
        )) : <p className="muted">还没有记住任何网站的回答。</p>}
      </div>
      {notice ? <p className={`note ${notice.tone} site-answers-note`} role="status">{notice.text}</p> : null}
      <ResumeDialog
        open={confirmSite !== null}
        tone="danger"
        title="删除这个网站的回答？"
        onCancel={() => setConfirmSite(null)}
        footer={
          <>
            <button type="button" data-autofocus onClick={() => setConfirmSite(null)}>取消</button>
            <button type="button" className="danger" disabled={busy} onClick={() => void remove(confirmSite!)}>删除</button>
          </>
        }
      >
        <p>{confirmSite} 的 {confirmCount} 个回答会删掉。下次在这个网站要重新填写，填好后插件会再问要不要记住。</p>
      </ResumeDialog>
    </section>
  );
}
