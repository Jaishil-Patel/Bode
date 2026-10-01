/*
 * Bode's own right-click menu, in place of the browser's.
 *
 * The webview's menu offered Back, Refresh, Save as and Inspect — things about a web page, nothing
 * about the document. This draws a menu in the app's own glass and colours instead, and lets the
 * caller fill it with whatever is useful where it was opened (see `DocumentMenu.tsx`).
 *
 * One menu at a time, held in a tiny store so anything can open one — a page, a note, a frame
 * that forwards its right-clicks — and `ContextMenuHost` in App draws it.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";

export type MenuItem =
  | {
      kind?: "item";
      label: string;
      icon?: ReactNode;
      /** A keyboard shortcut for the same thing, shown at the right as a reminder. */
      hint?: string;
      run: () => void;
      disabled?: boolean;
      danger?: boolean;
    }
  | { kind: "separator" }
  | { kind: "header"; label: string }
  | {
      /** A row of colours: picking one runs `pick` and closes the menu, like any item. */
      kind: "swatches";
      label: string;
      icon?: ReactNode;
      colors: string[];
      /** The colour already in use, ringed. */
      active?: string;
      pick: (color: string) => void;
    };

interface MenuState {
  menu: { x: number; y: number; items: MenuItem[] } | null;
  open: (x: number, y: number, items: MenuItem[]) => void;
  close: () => void;
}

export const useContextMenu = create<MenuState>((set) => ({
  menu: null,
  open: (x, y, items) => set({ menu: { x, y, items: tidy(items) } }),
  close: () => set({ menu: null }),
}));

/** Drop separators that would lead, trail or double up once optional items have been left out. */
function tidy(items: MenuItem[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const it of items) {
    if (it.kind === "separator" && (out.length === 0 || out[out.length - 1].kind === "separator"))
      continue;
    out.push(it);
  }
  while (out.length && out[out.length - 1].kind === "separator") out.pop();
  return out;
}

export function ContextMenuHost() {
  const menu = useContextMenu((s) => s.menu);
  const close = useContextMenu((s) => s.close);
  if (!menu) return null;
  // Keyed by where it opened, so a second right-click elsewhere draws a fresh menu there.
  return <Menu key={`${menu.x},${menu.y}`} {...menu} onClose={close} />;
}

function Menu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // On screen whatever the corner: flipped up or left where it would run off the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    setPos({
      left: x + r.width > vw - 8 ? Math.max(8, x - r.width) : x,
      top: y + r.height > vh - 8 ? Math.max(8, Math.min(y - r.height, vh - r.height - 8)) : y,
    });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const buttons = () =>
      Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Closing the menu, not also leaving fullscreen behind it.
        e.stopPropagation();
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        const all = buttons();
        if (!all.length) return;
        const i = all.indexOf(document.activeElement as HTMLButtonElement);
        const step = e.key === "ArrowDown" ? 1 : -1;
        all[(i + step + all.length) % all.length].focus();
      }
    };
    // Anything that moves the document under the menu leaves it pointing at the wrong thing.
    const onScroll = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("wheel", onClose, { passive: true });
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("wheel", onClose);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const run = (fn: () => void) => {
    onClose();
    fn();
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
      style={{ left: pos?.left ?? x, top: pos?.top ?? y, visibility: pos ? undefined : "hidden" }}
      className="glass glass-flat glass-menu animate-fade-in no-select fixed z-[60] min-w-[13rem] max-w-[20rem] overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-2xl"
    >
      {items.map((it, i) => {
        if (it.kind === "separator") return <div key={i} className="menu-sep mx-2 my-1 h-px bg-border" />;
        if (it.kind === "header")
          return (
            <div
              key={i}
              className="truncate px-3 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-muted"
            >
              {it.label}
            </div>
          );
        if (it.kind === "swatches")
          return (
            <div key={i} className="flex items-center gap-2.5 px-3 py-1.5 text-sm text-text">
              <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-muted">
                {it.icon}
              </span>
              <span className="min-w-0 flex-1 truncate">{it.label}</span>
              <span className="flex shrink-0 items-center gap-1">
                {it.colors.map((c) => (
                  <button
                    key={c}
                    role="menuitemradio"
                    aria-checked={c === it.active}
                    aria-label={`${it.label} ${c}`}
                    title={c}
                    onClick={() => run(() => it.pick(c))}
                    className="no-press flex h-6 w-6 items-center justify-center rounded-full outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-[var(--accent-ink)]"
                  >
                    <span
                      className="block h-4 w-4 rounded-full"
                      style={{
                        background: c,
                        boxShadow:
                          c === it.active
                            ? "0 0 0 2px var(--surface), 0 0 0 3.5px var(--accent-ink)"
                            : "inset 0 0 0 1px rgb(0 0 0 / 0.18)",
                      }}
                    />
                  </button>
                ))}
              </span>
            </div>
          );
        return (
          <button
            key={i}
            role="menuitem"
            disabled={it.disabled}
            onClick={() => run(it.run)}
            className={`no-press flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm outline-none transition-colors focus-visible:bg-surface-2 ${
              it.disabled
                ? "cursor-default text-muted opacity-40"
                : it.danger
                  ? "text-text hover:bg-surface-2 hover:text-red-500 focus-visible:text-red-500"
                  : "text-text hover:bg-surface-2"
            }`}
          >
            <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-muted">
              {it.icon}
            </span>
            <span className="min-w-0 flex-1 truncate">{it.label}</span>
            {it.hint && <span className="shrink-0 pl-4 text-xs text-muted">{it.hint}</span>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
