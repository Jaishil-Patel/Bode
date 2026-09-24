import { useEffect, useRef, useState } from "react";

/** Where a drag would drop, and where to draw the insertion bar (in grid coordinates). */
export interface GridDrag {
  ids: string[];
  /** Gap index in the page list: 0 is before the first card, `count` after the last. */
  gap: number;
  /** Pointer position in the viewport, for the floating preview. */
  x: number;
  y: number;
  bar: { left: number; top: number; height: number } | null;
}

const MOUSE_SLOP = 4; // px a mouse must travel before a press becomes a drag
const TOUCH_SLOP = 8; // px a finger may wander during a long-press before it counts as a scroll
const LONG_PRESS_MS = 350;
const EDGE = 56; // px from the scroller's top/bottom where dragging auto-scrolls
const MAX_SPEED = 18; // px per frame at the very edge

type Box = { left: number; top: number; right: number; bottom: number };

/**
 * Drag-to-reorder for a wrapping grid of cards.
 *
 * A mouse drags from anywhere on a card once it has moved a few pixels, so a click still selects.
 * Touch and pen need a long-press first: a plain swipe over the grid has to keep scrolling it, and
 * a held finger is the one gesture that never means "scroll". Once a touch drag is live, the
 * grid's touchmove is cancelled so the page stays put under the finger.
 *
 * Card boxes are measured relative to the grid element, which scrolls with its content, so they
 * stay valid however far the scroller moves during the drag — only the grid's own offset on
 * screen is re-read per move.
 */
export function useGridDrag({
  gridRef,
  scrollRef,
  dragIdsFor,
  onDrop,
}: {
  gridRef: React.RefObject<HTMLElement | null>;
  scrollRef: React.RefObject<HTMLElement | null>;
  /** The pages that move when the press starts on `id` (the whole selection, or just it). */
  dragIdsFor: (id: string) => string[];
  onDrop: (ids: string[], gap: number) => void;
}) {
  const [drag, setDrag] = useState<GridDrag | null>(null);
  const suppressClick = useRef(false);
  const press = useRef<null | {
    ids: string[];
    pointerId: number;
    x0: number;
    y0: number;
    x: number;
    y: number;
    touch: boolean;
    live: boolean;
    timer?: ReturnType<typeof setTimeout>;
    boxes: Box[];
  }>(null);
  const raf = useRef(0);
  // Latest drag state for the pointerup handler, which must not wait on a re-render.
  const dragRef = useRef<GridDrag | null>(null);
  dragRef.current = drag;

  const measure = (): Box[] => {
    const grid = gridRef.current;
    if (!grid) return [];
    const g = grid.getBoundingClientRect();
    return Array.from(grid.querySelectorAll<HTMLElement>("[data-card]")).map((c) => {
      const r = c.getBoundingClientRect();
      return { left: r.left - g.left, top: r.top - g.top, right: r.right - g.left, bottom: r.bottom - g.top };
    });
  };

  /** Resolve the drop gap for a pointer, from the nearest card and which half of it is under the pointer. */
  const resolve = (clientX: number, clientY: number): GridDrag | null => {
    const p = press.current;
    const grid = gridRef.current;
    if (!p || !grid || p.boxes.length === 0) return null;
    const g = grid.getBoundingClientRect();
    const x = clientX - g.left;
    const y = clientY - g.top;
    let best = 0;
    let bestD = Infinity;
    p.boxes.forEach((b, i) => {
      const dx = x < b.left ? b.left - x : x > b.right ? x - b.right : 0;
      const dy = y < b.top ? b.top - y : y > b.bottom ? y - b.bottom : 0;
      // Rows first: being in the right row matters far more than the column.
      const d = dy * 4 + dx;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    const b = p.boxes[best];
    const after = x > (b.left + b.right) / 2;
    const gap = best + (after ? 1 : 0);
    // Draw the bar against the card that was hit, so the end of a row shows at its right edge
    // rather than jumping to the start of the next row.
    const next = p.boxes[best + 1];
    const prev = p.boxes[best - 1];
    const left = after
      ? next && next.top === b.top
        ? (b.right + next.left) / 2
        : b.right + 4
      : prev && prev.top === b.top
        ? (prev.right + b.left) / 2
        : b.left - 4;
    return {
      ids: p.ids,
      gap,
      x: clientX,
      y: clientY,
      bar: { left, top: b.top, height: b.bottom - b.top },
    };
  };

  const stopAutoScroll = () => {
    cancelAnimationFrame(raf.current);
    raf.current = 0;
  };

  // While a drag is held near the top or bottom edge, keep scrolling and keep re-resolving the gap.
  const autoScroll = () => {
    const p = press.current;
    const el = scrollRef.current;
    if (!p?.live || !el) return stopAutoScroll();
    const r = el.getBoundingClientRect();
    const speed =
      p.y < r.top + EDGE
        ? -MAX_SPEED * Math.min(1, (r.top + EDGE - p.y) / EDGE)
        : p.y > r.bottom - EDGE
          ? MAX_SPEED * Math.min(1, (p.y - (r.bottom - EDGE)) / EDGE)
          : 0;
    if (speed === 0) return stopAutoScroll();
    el.scrollTop += speed;
    setDrag(resolve(p.x, p.y));
    raf.current = requestAnimationFrame(autoScroll);
  };

  const goLive = () => {
    const p = press.current;
    if (!p) return;
    p.live = true;
    p.boxes = measure();
    if (p.touch) navigator.vibrate?.(10);
    setDrag(resolve(p.x, p.y));
  };

  const end = (commit: boolean) => {
    const p = press.current;
    const d = dragRef.current;
    if (p?.timer) clearTimeout(p.timer);
    press.current = null;
    stopAutoScroll();
    setDrag(null);
    if (p?.live) {
      suppressClick.current = true; // the release that ended the drag would otherwise select
      if (commit && d) onDrop(d.ids, d.gap);
    }
  };

  // A live touch drag must not scroll the grid underneath it. This has to be a non-passive native
  // listener: React's touch handlers are passive and cannot cancel the scroll.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onTouchMove = (e: TouchEvent) => {
      if (press.current?.live) e.preventDefault();
    };
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => el.removeEventListener("touchmove", onTouchMove);
  }, [scrollRef]);

  useEffect(() => () => end(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  const onPointerDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    // Touch doesn't always emit the click that follows a drag, so a stale flag is cleared here —
    // otherwise it would eat the next tap's selection.
    suppressClick.current = false;
    const touch = e.pointerType !== "mouse";
    press.current = {
      ids: dragIdsFor(id),
      pointerId: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      x: e.clientX,
      y: e.clientY,
      touch,
      live: false,
      boxes: [],
    };
    if (touch) press.current.timer = setTimeout(goLive, LONG_PRESS_MS);
    else e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = press.current;
    if (!p || e.pointerId !== p.pointerId) return;
    p.x = e.clientX;
    p.y = e.clientY;
    const moved = Math.hypot(e.clientX - p.x0, e.clientY - p.y0);
    if (!p.live) {
      if (p.touch) {
        // Moved before the long-press fired: that's a scroll, not a drag.
        if (moved > TOUCH_SLOP) end(false);
        return;
      }
      if (moved < MOUSE_SLOP) return;
      goLive();
      return;
    }
    setDrag(resolve(e.clientX, e.clientY));
    if (!raf.current) raf.current = requestAnimationFrame(autoScroll);
  };

  const cardHandlers = (id: string) => ({
    onPointerDown: (e: React.PointerEvent) => onPointerDown(e, id),
    onPointerMove,
    onPointerUp: () => end(true),
    onPointerCancel: () => end(false),
    // A long-press on touch would otherwise open the platform's context menu over the drag.
    onContextMenu: (e: React.MouseEvent) => {
      if (press.current?.touch) e.preventDefault();
    },
  });

  /** Call from a card's click handler: true when the click is the tail of a drag and should be ignored. */
  const consumeClick = () => {
    if (!suppressClick.current) return false;
    suppressClick.current = false;
    return true;
  };

  return { drag, cardHandlers, consumeClick };
}
