import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useViewer } from "../store/viewerStore";
import {
  IconChevronUp,
  IconChevronDown,
  IconDuplicate,
  IconRotateCw,
  IconRotateCcw,
  IconTrash,
  IconPages,
} from "./icons";

/**
 * Quick page actions for one thumbnail in the navigation rail — the few edits worth making without
 * switching into the organizer. Opened by right-click, or a long-press on touch.
 */
export default function PageMenu({
  pageId,
  at,
  onClose,
}: {
  pageId: string;
  /** Where it was opened, in viewport pixels. */
  at: { x: number; y: number };
  onClose: () => void;
}) {
  const pages = useViewer((s) => s.pages);
  const { movePagesBy, duplicatePages, rotatePages, removePages, setOrganizeOpen } = useViewer();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: at.x, top: at.y });

  const index = pages.findIndex((p) => p.id === pageId);

  // Keep the menu on screen: flip it up or left when it would overflow the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8)),
      top: at.y + r.height > window.innerHeight - 8 ? Math.max(8, at.y - r.height) : at.y,
    });
  }, [at.x, at.y]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  if (index < 0) return null;

  const items: { label: string; Icon: (p: { className?: string }) => JSX.Element; run: () => void; disabled?: boolean; danger?: boolean }[] = [
    { label: "Move up", Icon: IconChevronUp, run: () => movePagesBy([pageId], -1), disabled: index === 0 },
    { label: "Move down", Icon: IconChevronDown, run: () => movePagesBy([pageId], 1), disabled: index === pages.length - 1 },
    { label: "Rotate right", Icon: IconRotateCw, run: () => rotatePages([pageId], 90) },
    { label: "Rotate left", Icon: IconRotateCcw, run: () => rotatePages([pageId], -90) },
    { label: "Duplicate", Icon: IconDuplicate, run: () => duplicatePages([pageId]) },
    { label: "Delete page", Icon: IconTrash, run: () => removePages([pageId]), disabled: pages.length <= 1, danger: true },
  ];

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={pos}
      className="glass animate-fade-in fixed z-50 min-w-[11rem] overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-2xl"
    >
      <div className="px-3 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
        Page {index + 1}
      </div>
      {items.map((it) => (
        <button
          key={it.label}
          role="menuitem"
          disabled={it.disabled}
          onClick={() => {
            it.run();
            onClose();
          }}
          className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors ${
            it.disabled
              ? "cursor-default text-muted opacity-40"
              : it.danger
                ? "text-text hover:bg-surface-2 hover:text-red-500"
                : "text-text hover:bg-surface-2"
          }`}
        >
          <it.Icon />
          {it.label}
        </button>
      ))}
      <div className="my-1 h-px bg-border" />
      <button
        role="menuitem"
        onClick={() => {
          setOrganizeOpen(true);
          onClose();
        }}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-text transition-colors hover:bg-surface-2"
      >
        <IconPages />
        Organize pages…
      </button>
    </div>,
    document.body,
  );
}
