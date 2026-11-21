/**
 * 展开区里「+ 记进度」这类小菜单的开合：同时只开一个，Esc 或点选项后收起并把焦点还回去，
 * 点菜单外面也收起。只管显示；写库的命令都在 applications-ui.ts。
 */
let outsideClickBound = false;

export function bindDetailControls(root: HTMLElement) {
  const menus = root.querySelectorAll<HTMLDetailsElement>(".action-menu");
  menus.forEach((menu) => {
    menu.addEventListener("toggle", () => {
      if (menu.open) menus.forEach((other) => { if (other !== menu) other.open = false; });
    });
    menu.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      menu.open = false;
      menu.querySelector("summary")?.focus();
    });
    menu.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => { menu.open = false; });
    });
  });
  if (outsideClickBound) return;
  outsideClickBound = true;
  document.addEventListener("click", (event) => {
    document.querySelectorAll<HTMLDetailsElement>("details.action-menu[open]").forEach((menu) => {
      if (!menu.contains(event.target as Node)) menu.open = false;
    });
  });
}
