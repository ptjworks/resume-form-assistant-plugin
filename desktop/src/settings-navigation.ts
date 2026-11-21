/** Keep every settings panel mounted, so switching categories never drops an unsaved draft. */
export function mountSettingsNavigation(root: HTMLElement, onSelect: (name: string) => void) {
  const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-settings-tab]"));
  const panels = root.querySelectorAll<HTMLElement>("[data-settings-panel]");
  /** 平台开关关着（data-platform-off）或被 hidden 的分类看不见，方向键和 select() 都不能落到它上面。 */
  const available = (tab: HTMLElement) => !tab.hidden && !tab.hasAttribute("data-platform-off");
  function select(name: string, focus = false) {
    const selected = tabs.find((tab) => tab.dataset.settingsTab === name);
    if (!selected || !available(selected)) return;
    tabs.forEach((tab) => {
      tab.setAttribute("aria-selected", String(tab === selected));
      tab.tabIndex = tab === selected ? 0 : -1;
    });
    panels.forEach((panel) => { panel.hidden = panel.dataset.settingsPanel !== name; });
    if (focus) selected.focus();
    onSelect(name);
  }
  /** 从 from 出发往 direction 方向找下一个看得见的分类；绕一圈都没有就返回 undefined。 */
  function step(from: number, direction: 1 | -1) {
    for (let i = 1; i <= tabs.length; i += 1) {
      const candidate = tabs[(from + direction * i + tabs.length * i) % tabs.length];
      if (available(candidate)) return candidate;
    }
    return undefined;
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => select(tab.dataset.settingsTab!));
    tab.addEventListener("keydown", (event) => {
      let next: HTMLButtonElement | undefined;
      if (event.key === "ArrowDown" || event.key === "ArrowRight") next = step(index, 1);
      else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = step(index, -1);
      else if (event.key === "Home") next = tabs.find(available);
      else if (event.key === "End") next = [...tabs].reverse().find(available);
      else return;
      event.preventDefault();
      if (next) select(next.dataset.settingsTab!, true);
    });
  });
  return { select };
}
