import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useViewer, displaySize } from "../store/viewerStore";
import { useAnnotations } from "../annotations/useAnnotations";
import { isTouchPrimary } from "../platform/device";
import PageThumb from "./PageThumb";
import { useGridDrag } from "./useGridDrag";
import {
  IconTrash,
  IconRotateCw,
  IconRotateCcw,
  IconDuplicate,
  IconExtract,
  IconUndo,
  IconRedo,
} from "./icons";

const SIZE_KEY = "bode.organizer.thumb";
const SIZE_MIN = 100;
const SIZE_MAX = 280;
const SIZE_DEFAULT = 160;
// Grid geometry, matching the classes below: grid padding (p-3), gap (gap-2), card padding (p-2).
const GRID_PAD = 12;
const GRID_GAP = 8;
const CARD_PAD = 8;
// Below this a page is too small to recognise; a phone still gets two across at this size.
const FIT_MIN = 90;
const GHOST_W = 72; // the floating preview that follows a drag
// The theme's colours are CSS variables, which Tailwind's `/15` opacity modifiers can't tint.
const SELECTED_BG = "color-mix(in srgb, var(--accent) 15%, transparent)";

const readSize = () => {
  try {
    const n = Number(localStorage.getItem(SIZE_KEY));
    return n >= SIZE_MIN && n <= SIZE_MAX ? n : SIZE_DEFAULT;
  } catch {
    return SIZE_DEFAULT;
  }
};

/** An icon button for the organizer's toolbar; the label shows beside the icon on wide screens. */
function ToolBtn({
  title,
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  title: string;
  label?: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm transition-colors ${
        disabled
          ? "cursor-default text-muted opacity-40"
          : danger
            ? "text-text hover:bg-red-500/15 hover:text-red-500"
            : "text-text hover:bg-surface-2"
      }`}
    >
      {children}
      {label && <span className="hidden lg:inline">{label}</span>}
    </button>
  );
}

/** A small round button floating on a card. Stops the press so it never starts a drag or toggles selection. */
function CardBtn({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      disabled={disabled}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`glass flex h-7 w-7 items-center justify-center rounded-full border border-border bg-surface shadow ${
        disabled ? "text-muted opacity-40" : "text-text hover:bg-surface-2"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Page-organize mode: the document's pages as a grid, in place of the viewer.
 *
 * Select pages by clicking them (each click toggles one; Shift picks a range), then act on the selection
 * from the toolbar, or act on one page from the buttons on its card. Pages are dragged into a new
 * order anywhere in the grid — with a mouse straight away, on touch after a long-press.
 *
 * Every edit is staged in the store's page manifest and only reaches a file on Save, and every edit
 * is one step on the app's undo stack, so nothing here can lose work.
 */
export default function PageOrganizer() {
  const pages = useViewer((s) => s.pages);
  const currentPage = useViewer((s) => s.currentPage);
  const baseSize = useViewer((s) => s.baseSize);
  const dirty = useViewer((s) => s.hasPageEdits());
  const {
    removePages,
    reorderPages,
    movePagesBy,
    duplicatePages,
    rotatePages,
    extractPages,
    resetPageEdits,
    setOrganizeOpen,
    goToPage,
  } = useViewer();
  const canUndo = useAnnotations((s) => s.past.length > 0);
  const canRedo = useAnnotations((s) => s.future.length > 0);
  const { undo, redo } = useAnnotations();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [thumbW, setThumbW] = useState(readSize);
  const anchor = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const touch = useMemo(isTouchPrimary, []);
  const [gridW, setGridW] = useState(0);

  // The grid's width decides how many columns fit; the thumbnails then grow to fill them exactly.
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setGridW(el.clientWidth));
    ro.observe(el);
    setGridW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Drop any selection referring to pages that no longer exist (deleted, or undone away).
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => pages.some((p) => p.id === id)));
      return next.size === prev.size ? prev : next;
    });
  }, [pages]);

  const orderedSelection = () => pages.filter((p) => selected.has(p.id)).map((p) => p.id);

  const { drag, cardHandlers, consumeClick } = useGridDrag({
    gridRef,
    scrollRef,
    // Dragging a selected page brings the whole selection; dragging an unselected one moves just it.
    dragIdsFor: (id) => (selected.has(id) && selected.size > 1 ? orderedSelection() : [id]),
    onDrop: reorderPages,
  });

  const count = selected.size;
  const allSelected = count > 0 && count === pages.length;
  const only = pages.length <= 1;

  const close = () => setOrganizeOpen(false);

  const onCardClick = (e: React.MouseEvent, id: string, index: number) => {
    if (consumeClick()) return;
    if (e.shiftKey && anchor.current !== null) {
      const [from, to] = [anchor.current, index].sort((a, b) => a - b);
      setSelected(new Set(pages.slice(from, to + 1).map((p) => p.id)));
      return;
    }
    anchor.current = index;
    // Cards behave like checkboxes: a click toggles, so building a selection needs no modifier keys.
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openPage = (index: number) => {
    close(); // first: closing re-anchors the viewer on the current page, and this jump must win
    goToPage(index + 1);
  };

  const deleteSelected = () => {
    if (count === 0 || allSelected) return;
    removePages([...selected]);
  };

  const setSize = (n: number) => {
    setThumbW(n);
    try {
      localStorage.setItem(SIZE_KEY, String(n));
    } catch {
      // A per-viewer nicety; fine to lose.
    }
  };

  // Keyboard, while the organizer is up. Captured ahead of App's global handler, which would
  // otherwise read Delete as "delete the selected annotation" and the arrows as scrolling.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey;
      const ids = orderedSelection();
      const back = e.key === "ArrowUp" || e.key === "ArrowLeft";
      const on = e.key === "ArrowDown" || e.key === "ArrowRight";
      let handled = true;
      if (e.key === "Delete" || e.key === "Backspace") deleteSelected();
      else if (mod && e.key.toLowerCase() === "a") setSelected(new Set(pages.map((p) => p.id)));
      else if (mod && e.key.toLowerCase() === "d") {
        if (ids.length) duplicatePages(ids);
      } else if (e.altKey && (back || on)) {
        if (ids.length) movePagesBy(ids, back ? -1 : 1);
      } else if (e.key === "Escape") {
        if (count) setSelected(new Set());
        else close();
      } else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const ids = orderedSelection();
  const need = count === 0 ? "Select pages first" : undefined;
  /*
   * The slider sets a target size; the columns are then sized to fill the row, and each thumbnail
   * fills its column. A phone always gets at least two across, which the target alone would not
   * give it at the default size.
   */
  const inner = Math.max(0, gridW - GRID_PAD * 2);
  let cols = Math.max(1, Math.floor((inner + GRID_GAP) / (thumbW + CARD_PAD * 2 + GRID_GAP)));
  if (cols < 2 && inner >= 2 * (FIT_MIN + CARD_PAD * 2) + GRID_GAP) cols = 2;
  const fitW = Math.max(
    FIT_MIN,
    Math.floor((inner - GRID_GAP * (cols - 1)) / cols - CARD_PAD * 2),
  );
  // Every card gets the same box, in the document's own shape. A turned page is fitted inside it,
  // and the card's controls sit on the box — so they stay put whichever way the page is turned.
  const boxH = Math.round(fitW * (baseSize.height / baseSize.width));
  const thumbWidthFor = (rotation: (typeof pages)[number]["rotation"]) => {
    const shown = displaySize(baseSize, rotation);
    return Math.floor(Math.min(fitW, boxH * (shown.width / shown.height)));
  };
  const dragged = drag ? pages.find((p) => p.id === drag.ids[0]) : undefined;

  return (
    <div className="flex h-full flex-col">
      {/* On a phone this wraps: title and Done on top, the actions on a scrollable row beneath. */}
      <div className="glass glass-flat flex shrink-0 flex-wrap items-center gap-x-1 gap-y-1 border-b border-border bg-surface px-3 py-1.5">
        <div className="order-1 mr-2 flex shrink-0 flex-col leading-tight">
          <span className="text-sm font-semibold text-text">Organize pages</span>
          <span className="text-[11px] text-muted">
            {count > 0 ? `${count} of ${pages.length} selected` : `${pages.length} pages`}
          </span>
        </div>

        <div className="order-3 -mx-1 flex w-full items-center gap-1 overflow-x-auto px-1 sm:order-2 sm:mx-0 sm:w-auto sm:flex-1 sm:px-0">
          <ToolBtn
            title={allSelected ? "Select none" : "Select all (Ctrl+A)"}
            onClick={() => setSelected(allSelected ? new Set() : new Set(pages.map((p) => p.id)))}
          >
            <span className="text-xs">{allSelected ? "Select none" : "Select all"}</span>
          </ToolBtn>
          <div className="mx-1 h-5 w-px shrink-0 bg-border" />
          <ToolBtn title={need ?? "Rotate left"} label="Left" disabled={!count} onClick={() => rotatePages(ids, -90)}>
            <IconRotateCcw />
          </ToolBtn>
          <ToolBtn title={need ?? "Rotate right"} label="Right" disabled={!count} onClick={() => rotatePages(ids, 90)}>
            <IconRotateCw />
          </ToolBtn>
          <ToolBtn title={need ?? "Duplicate (Ctrl+D)"} label="Duplicate" disabled={!count} onClick={() => duplicatePages(ids)}>
            <IconDuplicate />
          </ToolBtn>
          <ToolBtn
            title={need ?? "Save the selected pages as a new PDF"}
            label="Extract"
            disabled={!count}
            onClick={() => void extractPages(ids)}
          >
            <IconExtract />
          </ToolBtn>
          <ToolBtn
            title={need ?? (allSelected ? "A PDF needs at least one page" : "Delete (Del)")}
            label="Delete"
            danger
            disabled={!count || allSelected}
            onClick={deleteSelected}
          >
            <IconTrash />
          </ToolBtn>
          <div className="mx-1 h-5 w-px shrink-0 bg-border" />
          <ToolBtn title="Undo (Ctrl+Z)" onClick={undo} disabled={!canUndo}>
            <IconUndo />
          </ToolBtn>
          <ToolBtn title="Redo (Ctrl+Y)" onClick={redo} disabled={!canRedo}>
            <IconRedo />
          </ToolBtn>
        </div>

        <div className="order-2 ml-auto flex shrink-0 items-center gap-1 sm:order-3">
          <input
            type="range"
            title="Thumbnail size"
            min={SIZE_MIN}
            max={SIZE_MAX}
            step={10}
            value={thumbW}
            onChange={(e) => setSize(Number(e.target.value))}
            className="hidden w-24 shrink-0 accent-[var(--accent)] sm:block"
          />
          {dirty && (
            <button
              title="Undo every page change since the file was opened"
              onClick={resetPageEdits}
              className="shrink-0 rounded-md px-2 py-1 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-text"
            >
              Reset
            </button>
          )}
          <button
            onClick={close}
            className="glass glass-cta ml-1 shrink-0 rounded-md bg-accent px-3 py-1 text-sm font-medium text-accent-fg transition-opacity hover:opacity-90"
          >
            Done
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="no-select flex-1 overflow-auto"
        onClick={(e) => {
          if (e.target === e.currentTarget || e.target === gridRef.current) setSelected(new Set());
        }}
      >
        <p className="px-4 pt-3 text-xs text-muted">
          {touch
            ? "Tap pages to select · hold and drag to move"
            : "Click to select (Shift for a range) · drag to move · double-click to open"}
          {dirty && " · changes apply when you save"}
        </p>
        <div
          ref={gridRef}
          className="relative grid gap-2 p-3"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {pages.map((p, i) => {
            const isSelected = selected.has(p.id);
            const isDragged = drag?.ids.includes(p.id) ?? false;
            const showActions = touch ? isSelected && count === 1 : true;
            return (
              <div
                key={p.id}
                data-card
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                aria-label={`Page ${i + 1}`}
                {...cardHandlers(p.id)}
                onClick={(e) => onCardClick(e, p.id, i)}
                onDoubleClick={() => openPage(i)}
                style={isSelected ? { background: SELECTED_BG } : undefined}
                className={`group relative flex cursor-default flex-col items-center gap-1.5 rounded-lg p-2 transition-[background-color,opacity] ${
                  isSelected ? "" : "hover:bg-surface-2"
                } ${isDragged ? "opacity-30" : ""}`}
              >
                <div className="relative flex items-center justify-center" style={{ width: fitW, height: boxH }}>
                  <PageThumb
                    srcPage={p.srcPage}
                    rotation={p.rotation}
                    width={thumbWidthFor(p.rotation)}
                    className={`shadow-md ring-2 ${
                      isSelected ? "ring-accent" : currentPage === i + 1 ? "ring-border" : "ring-transparent"
                    }`}
                  />
                  <span
                    className={`absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full border text-[11px] leading-none ${
                      isSelected
                        ? "border-accent bg-accent text-accent-fg"
                        : "border-border bg-surface text-transparent group-hover:text-muted"
                    }`}
                  >
                    ✓
                  </span>
                  {showActions && !drag && (
                    <div
                      className={`absolute right-1.5 top-1.5 flex flex-col gap-1 transition-opacity ${
                        touch ? "" : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
                      }`}
                    >
                      <CardBtn title="Rotate right" onClick={() => rotatePages([p.id], 90)}>
                        <IconRotateCw className="!h-4 !w-4" />
                      </CardBtn>
                      <CardBtn title="Duplicate" onClick={() => duplicatePages([p.id])}>
                        <IconDuplicate className="!h-4 !w-4" />
                      </CardBtn>
                      <CardBtn
                        title={only ? "A PDF needs at least one page" : "Delete page"}
                        disabled={only}
                        onClick={() => removePages([p.id])}
                      >
                        <IconTrash className="!h-4 !w-4" />
                      </CardBtn>
                    </div>
                  )}
                </div>
                <span className={`text-xs ${isSelected ? "font-medium text-accent" : "text-muted"}`}>
                  {i + 1}
                </span>
              </div>
            );
          })}

          {drag?.bar && (
            <div
              className="pointer-events-none absolute w-1 rounded-full bg-accent"
              style={{ left: drag.bar.left - 2, top: drag.bar.top, height: drag.bar.height }}
            />
          )}
        </div>
      </div>

      {drag && dragged && (
        <div
          className="pointer-events-none fixed z-50"
          // Beside the pointer, but kept inside the window — near the right edge of a phone it
          // would otherwise slide off screen.
          style={{
            left: Math.min(drag.x + 14, window.innerWidth - GHOST_W - 12),
            top: Math.min(drag.y + 14, window.innerHeight - GHOST_W * 1.5 - 12),
          }}
        >
          {drag.ids.length > 1 && (
            <div className="absolute left-1.5 top-1.5 h-full w-full rounded bg-surface-2 shadow-lg" />
          )}
          <PageThumb srcPage={dragged.srcPage} rotation={dragged.rotation} width={GHOST_W} className="relative shadow-xl" />
          {drag.ids.length > 1 && (
            <span className="absolute -right-2 -top-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-[11px] font-semibold text-accent-fg">
              {drag.ids.length}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
