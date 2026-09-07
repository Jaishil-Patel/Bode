import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useViewer, type TabMeta } from "../store/viewerStore";
import { useSettings } from "../settings/useSettings";
import { useFormValues } from "../forms/useFormValues";
import { isAndroid } from "../platform/files";
import {
  closeIfSpawnedWindow,
  handOffToWindowAt,
  isSpawnedWindow,
  openInNewWindow,
} from "../platform/window";
import { IconClose } from "./icons";

/** Pointer travel before a press on a tab counts as a drag rather than a click. */
const DRAG_SLOP = 5;
/** How far outside the strip the pointer has to go before the tab is being pulled out of it. */
const TEAR_OFF = 36;

interface Drag {
  id: string;
  path: string;
  /** The tab's own label, for the ghost that follows the pointer out of the strip. */
  name: string;
  /** Client coordinates: where the press started, where the pointer is now. */
  startX: number;
  x: number;
  y: number;
  /** Where inside the tab it was grabbed, so the ghost keeps hanging off the same spot. */
  grabDX: number;
  grabDY: number;
  /** Screen coordinates, which is the space the backend hit-tests window frames in. */
  screenX: number;
  screenY: number;
  /** Where the tab would land in the strip: an index in [0, tabs.length], "before tab n". */
  insertAt: number;
  /** True once the pointer has left the strip — the drop detaches instead of reordering. */
  out: boolean;
  /** True once the pointer has moved past the slop; a press that never does is just a click. */
  active: boolean;
}

/**
 * Strip of open-document tabs. Click to switch, middle-click or the × to close, and drag to
 * rearrange them, pull one out into a window of its own, or drop one onto another Bode window
 * to merge the two.
 *
 * Tearing a tab out is the only way to get a second window, so there is no setting for it: every
 * document opens here, and windows are something you make by hand when you want one.
 */
export default function TabBar() {
  const tabs = useViewer((s) => s.tabs);
  const activeTabId = useViewer((s) => s.activeTabId);
  const switchTab = useViewer((s) => s.switchTab);
  const closeTab = useViewer((s) => s.closeTab);
  const moveTab = useViewer((s) => s.moveTab);
  // A tab whose form has answers that have not been written out to a PDF yet.
  const docKeyFor = useSettings((s) => s.docKey);
  const formsByFile = useFormValues((s) => s.byFile);
  const formsSavedAt = useFormValues((s) => s.savedAt);
  const hasUnsavedForm = (path: string) => {
    const key = docKeyFor(path);
    const values = formsByFile[key];
    return !!values && Object.keys(values).length > 0 && formsSavedAt[key] === undefined;
  };

  const barRef = useRef<HTMLDivElement>(null);
  const tabEls = useRef(new Map<string, HTMLElement>());
  const dragRef = useRef<Drag | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);

  // A window holding a single document normally needs no strip. A torn-off one is the exception:
  // the strip is the only handle for dragging that document back into another window, and without
  // it a document pulled out could never be put back. Android has no second window either way.
  const alwaysShow = isSpawnedWindow() && !isAndroid();
  if (tabs.length === 0 || (tabs.length < 2 && !alwaysShow)) return null;

  /** Which slot the pointer is over: the index of the tab it would be inserted before. */
  const insertionAt = (clientX: number) => {
    for (let i = 0; i < tabs.length; i++) {
      const r = tabEls.current.get(tabs[i].id)?.getBoundingClientRect();
      if (r && clientX < r.left + r.width / 2) return i;
    }
    return tabs.length;
  };

  /** Whether a point is far enough outside the strip to count as pulling the tab out of it. */
  const outsideStrip = (clientX: number, clientY: number) => {
    const bar = barRef.current?.getBoundingClientRect();
    if (!bar) return true;
    return (
      clientY < bar.top - TEAR_OFF ||
      clientY > bar.bottom + TEAR_OFF ||
      clientX < bar.left - TEAR_OFF ||
      clientX > bar.right + TEAR_OFF
    );
  };

  const detach = async (d: Drag) => {
    const moved = await handOffToWindowAt(d.path, d.screenX, d.screenY);
    if (!moved) {
      // Dropped on bare desktop. Pulling a window's only tab out of it would just rebuild the
      // same window somewhere else, so that gesture is left to do nothing.
      if (useViewer.getState().tabs.length < 2) return;
      const at = { x: Math.round(d.screenX - 80), y: Math.round(d.screenY - 24) };
      if (!(await openInNewWindow(d.path, at))) return;
    }
    closeTab(d.id);
    if (useViewer.getState().tabs.length === 0) await closeIfSpawnedWindow();
  };

  const onPointerDown = (e: React.PointerEvent, t: TabMeta, index: number) => {
    // Left button only, and never from the × — clicking that shouldn't first switch to the tab.
    if (e.button !== 0 || (e.target as HTMLElement).closest("[data-tab-close]")) return;
    switchTab(t.id);
    const rect = e.currentTarget.getBoundingClientRect();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = {
      id: t.id,
      path: t.filePath,
      name: t.fileName,
      startX: e.clientX,
      x: e.clientX,
      y: e.clientY,
      grabDX: e.clientX - rect.left,
      grabDY: e.clientY - rect.top,
      screenX: e.screenX,
      screenY: e.screenY,
      insertAt: index,
      out: false,
      active: false,
    };

    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      // A press only becomes a drag once it travels sideways, or leaves the strip outright —
      // otherwise a slightly unsteady click would start rearranging tabs.
      if (!d.active && Math.abs(ev.clientX - d.startX) < DRAG_SLOP && !outsideStrip(ev.clientX, ev.clientY))
        return;
      d.active = true;
      d.x = ev.clientX;
      d.y = ev.clientY;
      d.screenX = ev.screenX;
      d.screenY = ev.screenY;
      d.out = outsideStrip(ev.clientX, ev.clientY);
      if (!d.out) d.insertAt = insertionAt(ev.clientX);
      setDrag({ ...d });
    };

    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      // A cancelled pointer (the WebView deciding mid-gesture that this was a scroll, say) has no
      // trustworthy end position, so the drag is abandoned rather than acted on.
      if (!commit || !d?.active) return; // also the plain-click case; switchTab ran on the way down
      if (d.out) {
        void detach(d);
        return;
      }
      // `insertAt` counts slots in the strip as it stands, so pulling the tab out of the list
      // first shifts every slot after it down one.
      const from = tabs.findIndex((x) => x.id === d.id);
      moveTab(d.id, d.insertAt > from ? d.insertAt - 1 : d.insertAt);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  const dragging = drag?.active ? drag : null;

  // The accent line marking where a reordered tab would land: the leading edge of the slot being
  // pointed at, measured against the strip so it survives a horizontally scrolled bar.
  const markerX = (() => {
    if (!dragging || dragging.out) return null;
    const bar = barRef.current?.getBoundingClientRect();
    if (!bar) return null;
    const at = dragging.insertAt;
    const r = tabEls.current
      .get(tabs[Math.min(at, tabs.length - 1)]?.id ?? "")
      ?.getBoundingClientRect();
    if (!r) return null;
    return (at >= tabs.length ? r.right : r.left) - bar.left + (barRef.current?.scrollLeft ?? 0);
  })();

  // A tab pulled out of the strip cannot simply be moved: the strip scrolls horizontally, which
  // clips anything leaving it. So the tab stays put and fades, and a copy of it flies free.
  const dragStyle = (): React.CSSProperties | undefined => {
    if (!dragging) return undefined;
    return {
      transform: dragging.out ? undefined : `translateX(${dragging.x - dragging.startX}px)`,
      position: "relative",
      zIndex: 10,
      opacity: dragging.out ? 0.3 : 0.9,
    };
  };

  const ghost =
    dragging?.out &&
    createPortal(
      <div
        className="no-select pointer-events-none fixed z-50 max-w-[200px] truncate rounded-md border border-border bg-surface-2 px-3 py-1.5 text-sm text-text shadow-2xl"
        style={{ left: dragging.x - dragging.grabDX, top: dragging.y - dragging.grabDY }}
      >
        {dragging.name}
      </div>,
      document.body,
    );

  return (
    <div
      ref={barRef}
      className="no-select relative flex shrink-0 items-stretch gap-1 overflow-x-auto border-b border-border bg-surface px-2 py-1"
    >
      {markerX !== null && (
        <div
          className="pointer-events-none absolute bottom-1 top-1 w-0.5 rounded-full bg-accent"
          style={{ left: markerX }}
        />
      )}
      {tabs.map((t, i) => {
        const active = t.id === activeTabId;
        const isDragged = dragging?.id === t.id;
        return (
          <div
            key={t.id}
            ref={(el) => {
              if (el) tabEls.current.set(t.id, el);
              else tabEls.current.delete(t.id);
            }}
            onPointerDown={(e) => onPointerDown(e, t, i)}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                closeTab(t.id);
              }
            }}
            title={t.filePath}
            className={`group flex max-w-[200px] shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm ${
              isDragged ? "cursor-grabbing" : "cursor-pointer transition-colors"
            } ${active ? "bg-surface-2 text-text" : "text-muted hover:bg-surface-2/60"}`}
            style={isDragged ? dragStyle() : undefined}
          >
            <span className="truncate">{t.fileName}</span>
            {hasUnsavedForm(t.filePath) && (
              <span title="Form answers not saved into a PDF yet" className="shrink-0 text-accent">
                •
              </span>
            )}
            <button
              data-tab-close="1"
              title="Close tab"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.id);
              }}
              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded transition-opacity hover:bg-border ${
                active ? "opacity-70" : "opacity-0 group-hover:opacity-70"
              }`}
            >
              <IconClose className="h-3 w-3" />
            </button>
          </div>
        );
      })}
      {ghost}
    </div>
  );
}
