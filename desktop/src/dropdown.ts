// 自绘下拉（#551）。
//
// 浏览器自带的 <select> 在桌面端会弹成一条盖住整个屏幕的长列表，位置和高度都管不了。
// 这里把 <select> 原样留着当数据来源（取值、选项、禁用、change 事件都照旧），在它旁边画
// 一个按钮和一张列表：列表紧贴在按钮正下方、和按钮一样宽、最多露出 6 行，多的在里面滚动。
//
// 所以页面上原有的读写 `select.value`、监听 `change`、用 innerHTML 重建选项的代码都不用改，
// 只要在程序改了值之后调一次 `sync()`（选项被重建时会自动同步）。

export interface Dropdown {
  /** 程序改了 select 的值或禁用状态之后，让按钮上的文字和可点状态跟上。 */
  sync(): void;
}

const ROW_HEIGHT = 32;
const VISIBLE_ROWS = 6;
const GAP = 3;

interface OpenState {
  close(): void;
}

let current: OpenState | null = null;
let lastEscapeClose = 0;

/** 关掉当前展开的下拉。返回有没有真的关掉一个。 */
export function closeOpenDropdown(): boolean {
  if (!current) return false;
  current.close();
  return true;
}

/**
 * 刚刚是不是因为按了 Esc 才关掉了一个下拉。弹窗自己也会响应 Esc，
 * 这时候那一下 Esc 已经属于下拉了，弹窗不该跟着关。
 */
export function justClosedByEscape(): boolean {
  return Date.now() - lastEscapeClose < 200;
}

export function enhanceSelect(select: HTMLSelectElement): Dropdown {
  const parent = select.parentElement;
  // 没有真实的 DOM（单元测试里的假节点）就保持原样。
  if (!parent || typeof document.createElement !== "function") return { sync() {} };
  if (select.dataset.dropdown === "ready") return { sync() {} };

  const wrap = document.createElement("span");
  wrap.className = "dd";
  parent.insertBefore(wrap, select);
  wrap.appendChild(select);
  select.dataset.dropdown = "ready";
  select.classList.add("dd-native");
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");

  const labelText =
    select.getAttribute("aria-label") ||
    (select.closest("label")?.firstChild?.textContent ?? "").trim();

  const button = document.createElement("button");
  button.type = "button";
  button.className = "dd-btn";
  button.setAttribute("role", "combobox");
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  if (labelText) button.setAttribute("aria-label", labelText);
  button.innerHTML =
    '<span class="dd-value"></span><svg class="icon dd-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  const valueEl = button.querySelector(".dd-value") as HTMLElement;

  const list = document.createElement("ul");
  list.className = "dd-list";
  list.setAttribute("role", "listbox");
  list.hidden = true;
  if (labelText) list.setAttribute("aria-label", labelText);

  wrap.append(button, list);

  let active = -1;
  let typed = "";
  let typedAt = 0;

  function sync() {
    const option = select.options[select.selectedIndex];
    valueEl.textContent = option?.textContent ?? "";
    button.dataset.empty = option && option.value === "" ? "true" : "false";
    button.disabled = select.disabled;
  }

  function items(): HTMLElement[] {
    return Array.from(list.children) as HTMLElement[];
  }

  function paintActive(scroll: boolean) {
    items().forEach((item, index) => item.classList.toggle("is-active", index === active));
    const item = items()[active];
    if (item) button.setAttribute("aria-activedescendant", item.id);
    if (scroll && item) item.scrollIntoView?.({ block: "nearest" });
  }

  function place() {
    const rect = button.getBoundingClientRect();
    const wanted = Math.min(select.options.length, VISIBLE_ROWS) * ROW_HEIGHT + 8;
    const below = window.innerHeight - rect.bottom - GAP - 8;
    const above = rect.top - GAP - 8;
    const openUp = below < Math.min(wanted, 120) && above > below;
    const room = Math.max(96, openUp ? above : below);
    list.style.left = `${rect.left}px`;
    list.style.width = `${rect.width}px`;
    list.style.maxHeight = `${Math.min(wanted, room)}px`;
    if (openUp) {
      list.style.top = "auto";
      list.style.bottom = `${window.innerHeight - rect.top + GAP}px`;
    } else {
      list.style.bottom = "auto";
      list.style.top = `${rect.bottom + GAP}px`;
    }
  }

  const onPointerDown = (event: Event) => {
    if (!wrap.contains(event.target as Node)) close();
  };
  // 列表是 fixed 定位的：弹窗重新居中、里面滚动、窗口缩放时，框会动，列表要跟着贴住。
  let frame = 0;
  const follow = () => {
    if (list.hidden) return;
    place();
    frame = requestAnimationFrame(follow);
  };

  function open() {
    if (select.disabled || !list.hidden) return;
    closeOpenDropdown();
    const id = `dd-${Math.random().toString(36).slice(2, 8)}`;
    list.innerHTML = Array.from(select.options)
      .map(
        (option, index) =>
          `<li role="option" id="${id}-${index}" data-index="${index}" aria-selected="${index === select.selectedIndex}"${option.disabled ? ' aria-disabled="true"' : ""}></li>`,
      )
      .join("");
    items().forEach((item, index) => {
      item.textContent = select.options[index]?.textContent ?? "";
    });
    place();
    list.hidden = false;
    button.setAttribute("aria-expanded", "true");
    active = select.selectedIndex;
    paintActive(true);
    document.addEventListener("pointerdown", onPointerDown, true);
    if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(follow);
    current = { close };
  }

  function close() {
    if (list.hidden) return;
    list.hidden = true;
    button.setAttribute("aria-expanded", "false");
    button.removeAttribute("aria-activedescendant");
    document.removeEventListener("pointerdown", onPointerDown, true);
    if (frame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    frame = 0;
    if (current?.close === close) current = null;
  }

  function choose(index: number) {
    const option = select.options[index];
    if (!option || option.disabled) return;
    const changed = select.selectedIndex !== index;
    select.selectedIndex = index;
    sync();
    close();
    button.focus();
    if (changed) {
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function move(step: number) {
    const count = select.options.length;
    if (!count) return;
    let next = active;
    for (let tries = 0; tries < count; tries += 1) {
      next = (next + step + count) % count;
      if (!select.options[next]?.disabled) break;
    }
    active = next;
    paintActive(true);
  }

  button.addEventListener("click", () => {
    if (list.hidden) open();
    else close();
  });

  button.addEventListener("keydown", (event) => {
    const key = event.key;
    if (key === "Escape") {
      if (!list.hidden) {
        event.preventDefault();
        event.stopPropagation();
        lastEscapeClose = Date.now();
        close();
      }
      return;
    }
    if (key === "Tab") {
      close();
      return;
    }
    if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      if (list.hidden) open();
      else move(key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (key === "Home" || key === "End") {
      if (list.hidden) return;
      event.preventDefault();
      active = key === "Home" ? 0 : select.options.length - 1;
      paintActive(true);
      return;
    }
    if (key === "Enter" || key === " ") {
      event.preventDefault();
      if (list.hidden) open();
      else choose(active);
      return;
    }
    // 敲字跳到以它开头的那一项（「1」跳到「1 点」）。
    if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const nowAt = Date.now();
      typed = nowAt - typedAt > 700 ? key : typed + key;
      typedAt = nowAt;
      const found = Array.from(select.options).findIndex(
        (option) => !option.disabled && (option.textContent ?? "").trim().toLowerCase().startsWith(typed.toLowerCase()),
      );
      if (found >= 0) {
        if (list.hidden) choose(found);
        else {
          active = found;
          paintActive(true);
        }
      }
    }
  });

  // 选项用 mousedown 选而不是 click：避免先失焦、列表先被收起。
  list.addEventListener("mousedown", (event) => event.preventDefault());
  list.addEventListener("click", (event) => {
    const item = (event.target as HTMLElement | null)?.closest<HTMLElement>("li[data-index]");
    if (item) choose(Number(item.dataset.index));
  });
  list.addEventListener("mousemove", (event) => {
    const item = (event.target as HTMLElement | null)?.closest<HTMLElement>("li[data-index]");
    if (!item) return;
    const index = Number(item.dataset.index);
    if (index !== active && !select.options[index]?.disabled) {
      active = index;
      paintActive(false);
    }
  });

  select.addEventListener("change", sync);
  // 选项被整个重建（innerHTML）时按钮上的文字也要跟着变。
  if (typeof MutationObserver === "function") {
    new MutationObserver(sync).observe(select, { childList: true, subtree: true, characterData: true });
  }
  sync();
  return { sync };
}
