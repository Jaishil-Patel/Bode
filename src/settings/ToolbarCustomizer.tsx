/*
 * Choosing which annotation tools appear on the bar, and in what order.
 *
 * The grid is deliberately a picture of the bar: the same icons with the same names under them,
 * in the order they will appear. That is what lets one control do two jobs without a legend —
 * you are not configuring an abstract list, you are looking at the thing you are changing.
 *
 * Tap toggles and drag reorders, told apart by a slop threshold, the same way the tab strip and
 * the bar's own dock drag already do it. The alternative — a separate grip on each card — would
 * cost a third of the card's width on a phone to disambiguate a gesture that is not actually
 * ambiguous once a few pixels of travel have happened.
 *
 * Nothing here can make a tool unreachable, which is why `select` is switchable like the rest:
 * a switched-off tool keeps its shortcut key, keeps its place in the command palette, and is one
 * tap away in the bar's ⋯ menu.
 */

import { useRef, useState } from "react";
import { DEFAULT_TOOL_ORDER, normalizeToolbar, TOOLS, type ToolDef } from "../annotations/tools";
import type { Tool } from "../annotations/useAnnotations";
import { useSettings } from "./useSettings";
import { Hint, QuietButton, Section } from "./ui";

/** Travel, in px, before a press on a card counts as a drag rather than a tap. */
const DRAG_SLOP = 5;

interface Drag {
  id: Tool;
  startX: number;
  startY: number;
  active: boolean;
}

export default function ToolbarCustomizer() {
  const layout = useSettings((s) => s.layout);
  const updateLayout = useSettings((s) => s.updateLayout);
  const saved = normalizeToolbar(layout.toolOrder, layout.toolsHidden);

  const dragRef = useRef<Drag | null>(null);
  const cards = useRef(new Map<Tool, HTMLElement>());
  /** The order as it would land if the drag ended now. Cleared on drop, so nothing sticks. */
  const [preview, setPreview] = useState<Tool[] | null>(null);
  const [draggingId, setDraggingId] = useState<Tool | null>(null);

  const order = preview ?? saved.order;
  const hidden = new Set(saved.hidden);
  const shownCount = order.length - hidden.size;

  const setOrder = (next: Tool[]) => updateLayout({ toolOrder: next });

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
   * Which slot the pointer is over.
   *
   * Nearest card centre rather than an x comparison, because the grid wraps: a pointer below the
   * first row is nearer the cards on the second, and "past the midpoint" has no meaning across a
   * line break.
   */
  const slotAt = (list: Tool[], x: number, y: number) => {
    let best = -1;
    let bestDist = Infinity;
    list.forEach((id, i) => {
      const el = cards.current.get(id);
      if (!el) return;
      const r = el.getBoundingClientRect();
      const dx = x - (r.left + r.width / 2);
      const dy = y - (r.top + r.height / 2);
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    return best;
  };

  const onPointerDown = (e: React.PointerEvent, id: Tool) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = { id, startX: e.clientX, startY: e.clientY, active: false };
    let live = saved.order;

    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (
        !d.active &&
        Math.abs(ev.clientX - d.startX) < DRAG_SLOP &&
        Math.abs(ev.clientY - d.startY) < DRAG_SLOP
      )
        return;
      if (!d.active) {
        d.active = true;
        setDraggingId(d.id);
      }
      const to = slotAt(live, ev.clientX, ev.clientY);
      if (to >= 0) {
        live = moveTo(live, d.id, to);
        setPreview(live);
      }
    };

    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      const d = dragRef.current;
      dragRef.current = null;
      setPreview(null);
      setDraggingId(null);
      if (!d) return;
      // A cancelled pointer has no trustworthy end position, so the drag is abandoned. A press
      // that never travelled was a tap, and taps toggle.
      if (!commit) return;
      if (!d.active) toggle(d.id);
      else setOrder(live);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  // Arrow keys move a focused card, so rearranging never requires a pointer. Space and Enter
  // toggle, which is what `role="switch"` promises.
  const onKeyDown = (e: React.KeyboardEvent, id: Tool, index: number) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      setOrder(moveTo(saved.order, id, index - 1));
    } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      setOrder(moveTo(saved.order, id, index + 1));
    } else if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      toggle(id);
    }
  };

  const card = (t: ToolDef, index: number) => {
    const on = !hidden.has(t.id);
    const dragging = draggingId === t.id;
    return (
      <button
        key={t.id}
        ref={(el) => {
          if (el) cards.current.set(t.id, el);
          else cards.current.delete(t.id);
        }}
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={`${t.name} — ${on ? "on the bar" : "in the ⋯ menu"}. Arrow keys to reorder.`}
        title={t.title}
        onPointerDown={(e) => onPointerDown(e, t.id)}
        onKeyDown={(e) => onKeyDown(e, t.id, index)}
        // Without this the WebView claims the gesture for scrolling the settings pane a few
        // pixels in, and a touch drag dies before it starts.
        style={{ touchAction: "none" }}
        className={`no-press flex select-none flex-col items-center gap-1.5 rounded-lg border px-1 py-2.5 transition-colors ${
          on ? "tint-accent border-transparent text-text" : "border-dashed border-border text-muted"
        } ${dragging ? "opacity-60 ring-1 ring-accent" : "cursor-grab"}`}
      >
        <t.Icon className={on ? "text-accent" : undefined} />
        <span className="w-full truncate text-center text-[10px] leading-none">{t.name}</span>
      </button>
    );
  };

  return (
    <Section title="Tools on the bar">
      <div className="grid grid-cols-5 gap-1.5 px-2 pt-1">
        {order.map((id, i) => {
          const def = TOOLS.find((t) => t.id === id);
          return def ? card(def, i) : null;
        })}
      </div>
      <Hint>
        Tap a tool to put it on the bar or take it off. Drag one to reorder. Anything you take off
        stays a tap away in the bar’s ⋯ menu, and keeps its shortcut key.
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
