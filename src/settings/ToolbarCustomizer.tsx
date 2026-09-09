/*
 * Choosing which annotation tools appear on the bar, and in what order.
 *
 * The grid is deliberately a picture of the bar: the same icons with the same names under them,
 * in the order they will appear. That is what lets one control do two jobs without a legend —
 * you are not configuring an abstract list, you are looking at the thing you are changing.
 *
 * Each card carries both jobs, but on separate targets rather than on one target split by a slop
 * threshold: tapping the face switches the tool on or off, and a footer of ‹ grip › moves it. The
 * threshold version was smaller, but nothing on screen said either gesture existed, and a drag
 * showed you the grid reshuffling around a card that never moved — so you could not tell what you
 * had picked up or where it would land. The footer costs a row of card height and buys an
 * affordance for both jobs, plus one-tap moves for a thumb that does not want to drag at all.
 *
 * Nothing here can make a tool unreachable, which is why `select` is switchable like the rest:
 * a switched-off tool keeps its shortcut key, keeps its place in the command palette, and is one
 * tap away in the bar's ⋯ menu.
 */

import { useLayoutEffect, useRef, useState } from "react";
import { IconChevronLeft, IconChevronRight, IconGrip } from "../components/icons";
import { DEFAULT_TOOL_ORDER, normalizeToolbar, TOOLS, type ToolDef } from "../annotations/tools";
import type { Tool } from "../annotations/useAnnotations";
import { useSettings } from "./useSettings";
import { Hint, QuietButton, Section } from "./ui";

export default function ToolbarCustomizer() {
  const layout = useSettings((s) => s.layout);
  const updateLayout = useSettings((s) => s.updateLayout);
  const saved = normalizeToolbar(layout.toolOrder, layout.toolsHidden);

  const dragRef = useRef<Tool | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  /** Where each card was on the previous render, for the FLIP animation below. */
  const prevRects = useRef(new Map<Tool, DOMRect>());
  const cards = useRef(new Map<Tool, HTMLElement>());
  /** The order as it would land if the drag ended now. Cleared on drop, so nothing sticks. */
  const [preview, setPreview] = useState<Tool[] | null>(null);
  const [draggingId, setDraggingId] = useState<Tool | null>(null);

  const order = preview ?? saved.order;
  const hidden = new Set(saved.hidden);
  const shownCount = order.length - hidden.size;

  const setOrder = (next: Tool[]) => updateLayout({ toolOrder: next });

  /*
   * Slide the cards between positions instead of letting them cut to the new slot.
   *
   * The grid gives no transition of its own — reordering the array just repaints every card in a
   * different cell, so a move read as two cards blinking rather than as one thing going somewhere.
   * This is the standard FLIP: having rendered the new layout, measure how far each card moved,
   * offset it back to where it was, and let the browser animate the offset away. The paint the
   * user sees starts from the old position, so nothing ever appears to jump.
   */
  useLayoutEffect(() => {
    // Clear any in-flight slide first. Each one holds a transform, and measuring through that
    // would read where a card is passing rather than the slot it now occupies — the error would
    // then compound into the next animation.
    cards.current.forEach((el) => el.getAnimations().forEach((a) => a.cancel()));

    const next = new Map<Tool, DOMRect>();
    cards.current.forEach((el, id) => next.set(id, el.getBoundingClientRect()));

    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
      next.forEach((now, id) => {
        // Not the card under the finger: that one has to sit in its new slot at once, or it
        // trails the pointer that put it there.
        if (id === dragRef.current) return;
        const was = prevRects.current.get(id);
        const el = cards.current.get(id);
        if (!was || !el) return;
        const dx = was.left - now.left;
        const dy = was.top - now.top;
        if (!dx && !dy) return;
        el.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
          { duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)" },
        );
      });
    }
    prevRects.current = next;
  }, [order.join(",")]);

  const toggle = (id: Tool) => {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    updateLayout({ toolsHidden: saved.order.filter((t) => next.has(t)) });
  };

  const moveTo = (list: Tool[], id: Tool, to: number): Tool[] => {
    const from = list.indexOf(id);
    if (from < 0 || to < 0 || to >= list.length || to === from) return list;
    const next = [...list];
    next.splice(from, 1);
    next.splice(to, 0, id);
    return next;
  };

  /**
   * The centre of every grid slot, measured relative to the grid itself.
   *
   * Snapshotted once when a drag starts, and deliberately not re-measured: the slots are fixed
   * cells, and it is only which card sits in which that changes. Measuring the cards live instead
   * meant reading positions while the reorder animation was still moving them, so the drop target
   * was computed from where the cards had been rather than where the slots are, and the drag
   * fought itself. Grid-relative so scrolling the settings pane mid-drag cannot skew it.
   */
  const slotCentres = () => {
    const grid = gridRef.current;
    if (!grid) return [];
    const gr = grid.getBoundingClientRect();
    return saved.order.map((id) => {
      const el = cards.current.get(id);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2 - gr.left, y: r.top + r.height / 2 - gr.top };
    });
  };

  /**
   * Which slot the pointer is over.
   *
   * Nearest slot centre rather than an x comparison, because the grid wraps: a pointer below the
   * first row is nearer the cards on the second, and "past the midpoint" has no meaning across a
   * line break.
   */
  const slotAt = (centres: ({ x: number; y: number } | null)[], x: number, y: number) => {
    let best = -1;
    let bestDist = Infinity;
    centres.forEach((c, i) => {
      if (!c) return;
      const dx = x - c.x;
      const dy = y - c.y;
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    return best;
  };

  /** Starts on the grip only, so a press here is unambiguously a drag — no slop threshold. */
  const startDrag = (e: React.PointerEvent, id: Tool) => {
    if (e.button !== 0) return;
    e.preventDefault(); // the grip must not take focus away from the card
    // No setPointerCapture: the listeners below are on `window`, and capturing to the grip only
    // adds a node whose retargeting has to survive React moving it to another grid cell mid-drag.
    dragRef.current = id;
    setDraggingId(id);
    let live = saved.order;
    const centres = slotCentres();

    const onMove = (ev: PointerEvent) => {
      const held = dragRef.current;
      const grid = gridRef.current;
      if (!held || !grid) return;
      const gr = grid.getBoundingClientRect();
      const to = slotAt(centres, ev.clientX - gr.left, ev.clientY - gr.top);
      if (to >= 0) {
        live = moveTo(live, held, to);
        setPreview(live);
      }
    };

    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      const id = dragRef.current;
      dragRef.current = null;
      setPreview(null);
      setDraggingId(null);
      // A cancelled pointer has no trustworthy end position, so the drag is abandoned.
      if (commit && id) setOrder(live);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  const move = (id: Tool, to: number) => setOrder(moveTo(saved.order, id, to));

  // Arrow keys move a focused card, so rearranging never requires a pointer. Space and Enter
  // toggle, which is what `role="switch"` promises.
  const onKeyDown = (e: React.KeyboardEvent, id: Tool, index: number) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      move(id, index - 1);
    } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      move(id, index + 1);
    } else if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      toggle(id);
    }
  };

  const arrowCls =
    "hover-tint flex h-6 w-6 items-center justify-center rounded text-muted transition-colors hover:text-text disabled:pointer-events-none disabled:opacity-25";

  const card = (t: ToolDef, index: number) => {
    const on = !hidden.has(t.id);
    const dragging = draggingId === t.id;
    return (
      <div
        key={t.id}
        ref={(el) => {
          if (el) cards.current.set(t.id, el);
          else cards.current.delete(t.id);
        }}
        className={`flex select-none flex-col items-center rounded-lg border transition-colors ${
          on ? "tint-accent border-transparent text-text" : "border-dashed border-border text-muted"
        } ${dragging ? "opacity-60 ring-1 ring-accent" : ""}`}
      >
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={`${t.name} — ${on ? "on the bar" : "in the ⋯ menu"}`}
          title={t.title}
          onClick={() => toggle(t.id)}
          onKeyDown={(e) => onKeyDown(e, t.id, index)}
          className="no-press flex w-full flex-col items-center gap-1.5 px-1 pb-1 pt-2.5"
        >
          <t.Icon className={on ? "text-accent" : undefined} />
          <span className="w-full truncate text-center text-[10px] leading-none">{t.name}</span>
        </button>
        {/* Move controls. The arrows are the whole point — a thumb can reorder without ever
            holding a drag — and the grip is there for anyone who would rather place it directly. */}
        <div className="flex w-full items-center justify-center pb-1">
          <button
            type="button"
            aria-label={`Move ${t.name} earlier`}
            title="Move earlier"
            disabled={index === 0}
            onClick={() => move(t.id, index - 1)}
            className={arrowCls}
          >
            <IconChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span
            aria-hidden
            title="Drag to move"
            onPointerDown={(e) => startDrag(e, t.id)}
            // Without this the WebView claims the gesture for scrolling the settings pane a few
            // pixels in, and a touch drag dies before it starts.
            style={{ touchAction: "none" }}
            className="hover-tint flex h-6 w-7 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted active:cursor-grabbing"
          >
            <IconGrip className="h-3.5 w-3.5" />
          </span>
          <button
            type="button"
            aria-label={`Move ${t.name} later`}
            title="Move later"
            disabled={index === order.length - 1}
            onClick={() => move(t.id, index + 1)}
            className={arrowCls}
          >
            <IconChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    );
  };

  return (
    <Section title="Tools on the bar">
      <div ref={gridRef} className="grid grid-cols-4 gap-1.5 px-2 pt-1">
        {order.map((id, i) => {
          const def = TOOLS.find((t) => t.id === id);
          return def ? card(def, i) : null;
        })}
      </div>
      <Hint>
        Tap a tool to put it on the bar or take it off. Use ‹ › to move it, or drag it by the grip.
        Anything you take off stays a tap away in the bar’s ⋯ menu, and keeps its shortcut key.
      </Hint>
      <div className="flex items-center justify-between px-2 pt-1">
        <span className="text-xs text-muted">
          {shownCount === 0
            ? "No tools on the bar — all of them are in the ⋯ menu."
            : `${shownCount} of ${order.length} on the bar`}
        </span>
        <QuietButton
          onClick={() => updateLayout({ toolOrder: DEFAULT_TOOL_ORDER, toolsHidden: [] })}
        >
          Reset to default
        </QuietButton>
      </div>
    </Section>
  );
}
