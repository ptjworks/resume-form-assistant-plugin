import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

export interface MoreMenuItem {
  label: string;
  onSelect(): void;
  disabled?: boolean;
  /** 删除这类要小心的项，用红色字。 */
  danger?: boolean;
}

/**
 * 「…」菜单：把不常用的操作收进一个按钮里。点外面、按 Esc、选了某一项都会收起；
 * 上下键在项目间移动，收起后焦点回到「…」按钮。
 */
export function MoreMenu({ label, items, disabled = false, align = "left" }: { label: string; items: MoreMenuItem[]; disabled?: boolean; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: Event) => {
      if (root.current && event.target instanceof Node && !root.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  useEffect(() => {
    if (open) root.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
  }, [open]);

  // 按钮被禁用（正在执行别的操作）时菜单也跟着收起。
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const entries = [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])];
    if (!entries.length) return;
    const at = entries.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1 : (at + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length;
    entries[next].focus();
  };

  return (
    <div className="more-menu" ref={root} onKeyDown={onKeyDown}>
      <button
        ref={trigger}
        type="button"
        className="more-menu-trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="19" cy="12" r="1.6" />
        </svg>
      </button>
      {open ? (
        <div className={`more-menu-list${align === "right" ? " align-right" : ""}`} role="menu" id={menuId} aria-label={label}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={item.danger ? "is-danger" : undefined}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
