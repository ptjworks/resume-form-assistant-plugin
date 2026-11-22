// 通知页顶上的操作提示：做成了就几秒后自己消失，出问题的才留着，并且能点 × 关掉。
const timers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();
const TRANSIENT_MS = 3000;

export function showStatus(el: HTMLElement, text: string, options: { tone: string; transient: boolean }) {
  const pending = timers.get(el);
  if (pending) clearTimeout(pending);
  timers.delete(el);
  el.textContent = text;
  el.dataset.tone = options.tone;
  if (!text) return;
  if (options.transient) {
    timers.set(el, setTimeout(() => { if (el.textContent === text) el.textContent = ""; timers.delete(el); }, TRANSIENT_MS));
    return;
  }
  // 进行中的提示不用关；只有出问题的（warn / error）留着并带 ×。
  if (options.tone !== "warn" && options.tone !== "error") return;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "status-close";
  close.setAttribute("aria-label", "关闭提示");
  close.textContent = "×";
  close.addEventListener("click", () => { el.textContent = ""; });
  el.append(close);
}
