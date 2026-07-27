import { useEffect, useRef, useState } from "react";
import { useViewer } from "../store/viewerStore";
import PageThumb from "./PageThumb";
import { IconGrip, IconTrash, IconChevronUp, IconChevronDown, IconClose } from "./icons";

const THUMB_W = 120; // fits the 224px rail alongside the grip and page number

/** A compact icon button for the organizer's action row. */
function ActionBtn({
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
      onClick={onClick}
      disabled={disabled}
      className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
        disabled ? "cursor-default text-muted/40" : "text-text hover:bg-surface-2"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Page-organize mode for the sidebar: select pages, drag them into a new order, delete them.
 *
 * Edits are staged in the store's page manifest and only reach a file on Save, so everything here
 * is reversible and the document on disk is never touched.
 *
 * Dragging deliberately differs by input: a mouse can drag from anywhere on a card (after a small
 * threshold, so a click still selects), while touch and pen drag from the grip handle only. That
 * keeps a finger swipe over a card scrolling the rail instead of reordering it, and avoids
 * long-press heuristics competing with the scroll.
 */
export default function PageOrganizer() {
  const pages = useViewer((s) => s.pages);
  const currentPage = useViewer((s) => s.currentPage);
  const dirty = useViewer((s) => s.hasPageEdits());
  const { removePages, reorderPages, resetPageEdits, setOrganizeOpen, goToPage } = useViewer();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<{ ids: string[]; gap: number; top: number } | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const anchor = useRef<number | null>(null);
  const suppressClick = useRef(false);
  // Geometry captured when a drag starts: card midpoints in viewport space for hit-testing, and
  // gap offsets within the list for drawing the drop line. Both are re-measured if the rail scrolls.
  const press = useRef<null | {
    ids: string[];
    mids: number[];
    bounds: number[];
    scrollTop: number;
    live: boolean;
    y0: number;
  }>(null);

  // Drop any selection referring to pages that no longer exist.
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => pages.some((p) => p.id === id)));
      return next.size === prev.size ? prev : next;
    });
  }, [pages]);

  const orderedSelection = () => pages.filter((p) => selected.has(p.id)).map((p) => p.id);

  const measure = () => {
    const container = listRef.current;
    if (!container) return null;
    const cards = Array.from(container.querySelectorAll<HTMLElement>("[data-card]"));
    const mids = cards.map((c) => {
      const r = c.getBoundingClientRect();
      return r.top + r.height / 2;
    });
    const last = cards[cards.length - 1];
    const bounds = [
      ...cards.map((c) => c.offsetTop),
      last ? last.offsetTop + last.offsetHeight : 0,
    ];
    return { mids, bounds };
  };

  const gapAt = (y: number, mids: number[]) => mids.filter((m) => y > m).length;

  const beginPress = (e: React.PointerEvent, id: string, live: boolean) => {
    if (e.button !== 0) return;
    // A drag arms `suppressClick` to swallow its own trailing click. Touch doesn't always emit that
    // click, so clear it here too — otherwise the flag survives and eats the next tap's selection.
    suppressClick.current = false;
    const geo = measure();
    if (!geo) return;
    // Dragging a selected page brings the whole selection; dragging an unselected one moves just it.
    const ids = selected.has(id) && selected.size > 1 ? orderedSelection() : [id];
    press.current = {
      ids,
      ...geo,
      scrollTop: listRef.current?.parentElement?.scrollTop ?? 0,
      live,
      y0: e.clientY,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    if (live) {
      const gap = gapAt(e.clientY, geo.mids);
      setDrag({ ids, gap, top: geo.bounds[gap] ?? 0 });
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = press.current;
    if (!p) return;
    // A mouse press only becomes a drag once it actually moves, so a click still selects.
    if (!p.live) {
      if (Math.abs(e.clientY - p.y0) < 4) return;
      p.live = true;
    }
    // The rail may have scrolled since the press (wheel, or a second pointer) — re-measure if so.
    const scrollTop = listRef.current?.parentElement?.scrollTop ?? 0;
    if (scrollTop !== p.scrollTop) {
      const geo = measure();
      if (geo) Object.assign(p, geo, { scrollTop });
    }
    const gap = gapAt(e.clientY, p.mids);
    setDrag({ ids: p.ids, gap, top: p.bounds[gap] ?? 0 });
  };

  const endPress = () => {
    const p = press.current;
    const d = drag;
    press.current = null;
    setDrag(null);
    if (p?.live && d) {
      reorderPages(d.ids, d.gap);
      suppressClick.current = true; // the pointerup that ended the drag would otherwise select
    }
  };

  const onCardClick = (e: React.MouseEvent, id: string, index: number) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (e.shiftKey && anchor.current !== null) {
      const [from, to] = [anchor.current, index].sort((a, b) => a - b);
      setSelected(new Set(pages.slice(from, to + 1).map((p) => p.id)));
      return;
    }
    anchor.current = index;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    goToPage(index + 1); // show what was just picked
  };

  const deleteSelected = () => {
    removePages([...selected]);
    setSelected(new Set());
  };

  const count = selected.size;
  const allSelected = count > 0 && count === pages.length;

  return (
    <>
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">Organize</span>
        <button
          title="Done"
          onClick={() => setOrganizeOpen(false)}
          className="rounded p-1 text-muted hover:bg-surface-2"
        >
          <IconClose className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-auto p-3">
        <div ref={listRef} className="relative flex flex-col gap-2">
          {pages.map((p, i) => {
            const isSelected = selected.has(p.id);
            const isDragged = drag?.ids.includes(p.id) ?? false;
            return (
              <div
                key={p.id}
                data-card
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                onPointerDown={(e) => {
                  // Touch/pen drags start from the grip only — see the note on this component.
                  if (e.pointerType === "mouse") beginPress(e, p.id, false);
                }}
                onPointerMove={onPointerMove}
                onPointerUp={endPress}
                onPointerCancel={endPress}
                onClick={(e) => onCardClick(e, p.id, i)}
                className={`flex items-center gap-1.5 rounded p-1 transition-colors ${
                  isSelected ? "bg-surface-2" : "hover:bg-surface-2/60"
                } ${isDragged ? "opacity-40" : ""}`}
              >
                <span
                  title="Drag to reorder"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    beginPress(e, p.id, true);
                  }}
                  className="shrink-0 cursor-grab touch-none text-muted"
                >
                  <IconGrip />
                </span>

                <div className="relative">
                  <PageThumb
                    srcPage={p.srcPage}
                    width={THUMB_W}
                    className={`border-2 ${
                      currentPage === i + 1 ? "border-accent" : "border-transparent"
                    }`}
                  />
                  <span
                    className={`absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded border text-[10px] leading-none ${
                      isSelected
                        ? "border-accent bg-accent text-accent-fg"
                        : "border-border bg-surface/80 text-transparent"
                    }`}
                  >
                    ✓
                  </span>
                </div>

                <span className="w-4 shrink-0 text-right text-[11px] text-muted">{i + 1}</span>
              </div>
            );
          })}

          {drag && (
            <div
              className="pointer-events-none absolute left-0 right-0 h-0.5 rounded bg-accent"
              style={{ top: drag.top - 1 }}
            />
          )}
        </div>
      </div>

      <div className="border-t border-border px-3 py-2">
        {count > 0 ? (
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted">{count} selected</span>
            <div className="flex items-center">
              <ActionBtn
                title={allSelected ? "Can't delete every page" : `Delete ${count} page(s)`}
                onClick={deleteSelected}
                disabled={allSelected}
              >
                <IconTrash />
              </ActionBtn>
              <ActionBtn title="Move to top" onClick={() => reorderPages(orderedSelection(), 0)}>
                <IconChevronUp />
              </ActionBtn>
              <ActionBtn
                title="Move to bottom"
                onClick={() => reorderPages(orderedSelection(), pages.length)}
              >
                <IconChevronDown />
              </ActionBtn>
            </div>
          </div>
        ) : (
          <p className="text-[11px] leading-snug text-muted">
            Tap to select · drag the handle to reorder
          </p>
        )}

        {dirty && (
          <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
            <span className="text-[11px] text-muted">Unsaved page edits</span>
            <button
              onClick={resetPageEdits}
              className="rounded px-2 py-1 text-[11px] text-text transition-colors hover:bg-surface-2"
            >
              Reset
            </button>
          </div>
        )}
      </div>
    </>
  );
}
