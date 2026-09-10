/*
 * Our own text selection on touch devices, for the two tools that select text.
 *
 * The platform's selection is what draws the magnifier that sits under the thumb, and the OS owns
 * where that goes — so the only way to move it was to stop using the platform's selection here.
 * Long-press takes the word under the finger and dragging extends it, in both modes; what happens
 * when you let go is what differs:
 *
 *   highlight — the mark lands immediately. Choosing a colour is something you do beforehand, on
 *               the bar, so there is nothing left to confirm and no reason to interrupt the
 *               gesture with a prompt.
 *   select    — the selection stays up with an actions pill: copy it, or take the whole page.
 *
 * See `pdf/textGeometry.ts` for the character maths and `SelectionLoupe` for the magnifier.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  allOf,
  boundsOf,
  caretRect,
  hitTest,
  order,
  pageGeom,
  rangeRects,
  rangeText,
  wordAt,
  type CharPos,
  type Rect,
} from "../pdf/textGeometry";
import { getViewport } from "../pdf/viewport";
import { isPhone } from "../platform/device";
import SelectionLoupe, { type LoupeHandle } from "./SelectionLoupe";
import { useTextSelection, type DragEnd } from "./useTextSelection";

/** Hold this long without moving to start selecting; below it, the gesture is a scroll. */
const LONG_PRESS_MS = 350;
/** Travel that cancels the pending long press. */
const MOVE_SLOP = 10;
/** Distance from the viewport edge at which a drag starts scrolling the document. */
const EDGE = 80;
const EDGE_SPEED = 12; // px per frame at the very edge

/** What letting go of a selection does. */
export type SelectMode = "mark" | "select";

interface Props {
  mode: SelectMode;
  pageIndex: number;
  scale: number;
  width: number;
  height: number;
  /** The page container, whose `.textLayer` child carries the spans. */
  pageEl: HTMLElement | null;
  /** The colour the mark will land in, previewed in the loupe's tint. */
  color: string;
  onCommit: (rects: Rect[]) => void;
}

export default function TextSelectLayer({
  mode,
  pageIndex,
  scale,
  width,
  height,
  pageEl,
  color,
  onCommit,
}: Props) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const loupeRef = useRef<LoupeHandle>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const startPt = useRef<{ x: number; y: number } | null>(null);
  const edgeRaf = useRef(0);
  const edgeDir = useRef(0);
  const [phone] = useState(isPhone);

  const sel = useTextSelection((s) => s.sel);
  const dragging = useTextSelection((s) => s.dragging);
  const mine = sel && sel.pageIndex === pageIndex ? sel : null;

  const textLayer = () => pageEl?.querySelector<HTMLElement>(".textLayer") ?? null;

  /** Client point → page space (PDF points), the space everything here works in. */
  const toPage = (clientX: number, clientY: number) => {
    const r = pageEl?.getBoundingClientRect();
    if (!r) return null;
    return { x: (clientX - r.left) / scale, y: (clientY - r.top) / scale };
  };

  const posAt = (clientX: number, clientY: number): CharPos | null => {
    const layer = textLayer();
    const p = toPage(clientX, clientY);
    if (!layer || !p) return null;
    return hitTest(pageGeom(layer, scale), p.x, p.y);
  };

  const rects = (() => {
    const layer = textLayer();
    if (!mine || !layer) return [];
    return rangeRects(pageGeom(layer, scale), mine.anchor, mine.focus);
  })();

  // ---- Edge auto-scroll: without it a selection cannot be extended past one screenful. ----
  const stopEdge = () => {
    cancelAnimationFrame(edgeRaf.current);
    edgeRaf.current = 0;
    edgeDir.current = 0;
  };

  const runEdge = () => {
    edgeRaf.current = requestAnimationFrame(runEdge);
    if (edgeDir.current) getViewport()?.scrollBy(0, edgeDir.current);
  };

  const updateEdge = (clientY: number) => {
    const vp = getViewport();
    if (!vp) return;
    const r = vp.getBoundingClientRect();
    const top = clientY - r.top;
    const bottom = r.bottom - clientY;
    edgeDir.current =
      top < EDGE
        ? -Math.ceil(((EDGE - top) / EDGE) * EDGE_SPEED)
        : bottom < EDGE
          ? Math.ceil(((EDGE - bottom) / EDGE) * EDGE_SPEED)
          : 0;
    if (edgeDir.current && !edgeRaf.current) runEdge();
    else if (!edgeDir.current) stopEdge();
  };

  // ---- Dragging an end of the selection ----
  const beginDrag = (end: DragEnd, clientX: number, clientY: number) => {
    useTextSelection.getState().setDragging(end);
    loupeRef.current?.aim(clientX, clientY);

    const onMove = (ev: PointerEvent) => {
      const p = posAt(ev.clientX, ev.clientY);
      if (p) useTextSelection.getState().moveEnd(p);
      loupeRef.current?.aim(ev.clientX, ev.clientY);
      updateEdge(ev.clientY);
    };
    /*
     * Letting go. In mark mode this is the commit — the selection you are looking at when you
     * lift is the mark you get, and the selection is then done with. In select mode the selection
     * survives instead, because the pill's actions are the point of having made it.
     *
     * The rects are recomputed from the store rather than closed over, since `onMove` has been
     * moving the selection ever since this closure was made.
     */
    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      stopEdge();
      const store = useTextSelection.getState();
      const s = store.sel;
      const layer = textLayer();
      // A cancelled pointer is the system taking the gesture away rather than a deliberate
      // release, so it drops the selection instead of acting on it.
      if (!commit) {
        store.clear();
        return;
      }
      if (mode === "select") {
        store.setDragging(null);
        return;
      }
      if (s && s.pageIndex === pageIndex && layer) {
        const marked = rangeRects(pageGeom(layer, scale), s.anchor, s.focus);
        if (marked.length) onCommit(marked);
      }
      store.clear();
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  /*
   * A press on the page arms a selection only after a still 350ms hold. That is what keeps a
   * one-finger swipe scrolling the document while the highlight tool is on — the same bargain
   * native selection made, so the gesture feels unchanged.
   */
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // A second finger means a pinch; get out of its way.
    if (armTimer.current) clearTimeout(armTimer.current);
    startPt.current = { x: e.clientX, y: e.clientY };
    const { clientX, clientY } = e;
    armTimer.current = setTimeout(() => {
      armTimer.current = undefined;
      const p = posAt(clientX, clientY);
      const layer = textLayer();
      if (!p || !layer) return;
      const [a, b] = wordAt(pageGeom(layer, scale), p);
      useTextSelection.getState().setSel({ pageIndex, anchor: a, focus: b });
      navigator.vibrate?.(10);
      beginDrag("focus", clientX, clientY);
    }, LONG_PRESS_MS);
  };

  const cancelArm = () => {
    clearTimeout(armTimer.current);
    armTimer.current = undefined;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const s = startPt.current;
    if (!armTimer.current || !s) return;
    if (Math.abs(e.clientX - s.x) > MOVE_SLOP || Math.abs(e.clientY - s.y) > MOVE_SLOP) cancelArm();
  };

  /**
   * A tap that never armed and never travelled puts the selection away. Only reachable in select
   * mode, since a highlight clears its own selection the moment it lands.
   */
  const onPointerUp = (e: React.PointerEvent) => {
    const s = startPt.current;
    const tapped =
      !!armTimer.current &&
      !!s &&
      Math.abs(e.clientX - s.x) <= MOVE_SLOP &&
      Math.abs(e.clientY - s.y) <= MOVE_SLOP;
    cancelArm();
    startPt.current = null;
    if (tapped && mine) useTextSelection.getState().clear();
  };

  /*
   * Once armed, the page must stop scrolling under the drag. `touch-action` cannot do this — the
   * compositor latches its value at touchstart — so the only way to take the gesture back is a
   * non-passive touchmove listener. Legitimate here precisely because arming required a still
   * finger, so no scroll has begun to fight with.
   */
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el || !dragging) return;
    const block = (e: TouchEvent) => {
      if (e.touches.length === 1) e.preventDefault();
    };
    el.addEventListener("touchmove", block, { passive: false });
    return () => el.removeEventListener("touchmove", block);
  }, [dragging]);

  useEffect(
    () => () => {
      clearTimeout(armTimer.current);
      cancelAnimationFrame(edgeRaf.current);
      // Scrolled out of the virtualization window, or the tool changed. Only drop the selection
      // if it is this page's — every visible page mounts one of these, and the others must not
      // clear a selection they do not own.
      const s = useTextSelection.getState();
      if (s.sel?.pageIndex === pageIndex) s.clear();
    },
    [pageIndex],
  );

  /*
   * The ends of the selection.
   *
   * Grabbable in select mode, where the selection outlives the gesture and adjusting it is worth
   * doing. In highlight mode the mark lands on release and nothing survives to take hold of, so
   * they are feedback only and stay out of the way of the next press.
   */
  const grabbable = mode === "select";
  const handle = (end: DragEnd, pos: CharPos) => {
    const layer = textLayer();
    const c = layer && caretRect(pageGeom(layer, scale), pos);
    if (!c) return null;
    // The start marker sits above the line and the end marker below, so neither covers the
    // character it points at.
    const top = end === "anchor" ? c.y * scale : (c.y + c.h) * scale;
    const dot = grabbable ? 14 : 12;
    return (
      <div
        key={end}
        onPointerDown={
          grabbable
            ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                beginDrag(end, e.clientX, e.clientY);
              }
            : undefined
        }
        style={{
          position: "absolute",
          left: c.x * scale,
          top,
          width: grabbable ? 28 : dot,
          height: grabbable ? 28 : dot,
          marginLeft: grabbable ? -14 : -6,
          marginTop: end === "anchor" ? (grabbable ? -28 : -12) : 0,
          touchAction: "none",
          pointerEvents: grabbable ? "auto" : "none",
          display: "flex",
          alignItems: end === "anchor" ? "flex-end" : "flex-start",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            width: dot,
            height: dot,
            borderRadius: "50%",
            background: "var(--accent-ink)",
            boxShadow: "0 1px 3px rgb(0 0 0 / 0.35)",
          }}
        />
      </div>
    );
  };

  /*
   * The actions pill, select mode only.
   *
   * Text actions and nothing else: choosing a highlight colour used to live here, and having to
   * answer a colour prompt before a highlight would land is exactly what made highlighting feel
   * like a form to fill in. That is the gesture's job now, and this is left to do what a text
   * selection is actually for.
   */
  const bounds = mode === "select" ? boundsOf(rects) : null;
  const pill =
    mine && !dragging && bounds && pageEl
      ? (() => {
          const r = pageEl.getBoundingClientRect();
          const below = r.top + (bounds.y + bounds.h) * scale + 12;
          // Flip above the selection when there is no room under it, so it never sits off-screen.
          const flip = below > window.innerHeight - 72;
          const layer = textLayer();
          const act = (fn: () => void) => (e: React.PointerEvent) => {
            e.preventDefault();
            e.stopPropagation();
            fn();
          };
          const btn = {
            padding: "6px 10px",
            fontSize: 13,
            color: "var(--text)",
            whiteSpace: "nowrap" as const,
          };
          return createPortal(
            <div
              style={{
                position: "fixed",
                left: Math.min(
                  Math.max(r.left + (bounds.x + bounds.w / 2) * scale, 100),
                  window.innerWidth - 100,
                ),
                top: flip ? undefined : below,
                bottom: flip ? window.innerHeight - (r.top + bounds.y * scale) + 12 : undefined,
                transform: "translateX(-50%)",
                zIndex: 55,
                display: "flex",
                alignItems: "center",
                gap: 2,
                padding: 4,
                borderRadius: 999,
                background: "var(--surface)",
                border: "1px solid var(--border)",
                boxShadow: "0 6px 20px rgb(0 0 0 / 0.3)",
              }}
            >
              <button
                style={btn}
                onPointerDown={act(() => {
                  if (!layer) return;
                  const [a, b] = order(mine.anchor, mine.focus);
                  navigator.clipboard?.writeText(rangeText(pageGeom(layer, scale), a, b));
                  useTextSelection.getState().clear();
                })}
              >
                Copy
              </button>
              <span style={{ width: 1, height: 18, background: "var(--border)" }} />
              <button
                style={btn}
                onPointerDown={act(() => {
                  if (!layer) return;
                  const whole = allOf(pageGeom(layer, scale));
                  if (whole) {
                    useTextSelection
                      .getState()
                      .setSel({ pageIndex, anchor: whole[0], focus: whole[1] });
                  }
                })}
              >
                Select all
              </button>
              <span style={{ width: 1, height: 18, background: "var(--border)" }} />
              <button
                style={{ ...btn, color: "var(--muted)" }}
                onPointerDown={act(() => useTextSelection.getState().clear())}
              >
                Done
              </button>
            </div>,
            document.body,
          );
        })()
      : null;

  /*
   * Portalled into the page rather than rendered inside the annotation overlay, and sitting below
   * it at z-index 2.
   *
   * Two reasons, both about not stealing gestures in select mode. The overlay sets
   * `touch-action: none` so a half-drawn shape is not cut short by the page scrolling, and the
   * browser intersects that down the whole ancestor chain — inside it, this surface could never
   * let a swipe scroll. And the overlay is where draggable annotations live, so anything above it
   * would take the taps meant for them. Under it, they get first refusal and this catches the rest.
   *
   * z-index 1 specifically: it has to stay under the link and form layers at 2 as well, or a tap
   * on a link would land here instead of following it. That leaves it below the text layer too,
   * which is why `.bode-nonative` makes that layer non-interactive — with our own selection the
   * spans are hit-tested geometrically and never need to receive a pointer event.
   */
  const surface = pageEl
    ? createPortal(
        <div
          ref={surfaceRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={cancelArm}
          style={{
            position: "absolute",
            inset: 0,
            width,
            height,
            zIndex: 1,
            // A plain swipe still scrolls and two fingers still pinch; only an armed drag takes
            // the gesture, and it does that through the non-passive listener above.
            touchAction: "pan-x pan-y pinch-zoom",
            pointerEvents: "auto",
          }}
        >
          {mine && handle("anchor", order(mine.anchor, mine.focus)[0])}
          {mine && handle("focus", order(mine.anchor, mine.focus)[1])}
        </div>,
        pageEl,
      )
    : null;

  return (
    <>
      {surface}
      {pill}
      {phone && dragging && mine && (
        <SelectionLoupe
          ref={loupeRef}
          pageNumber={pageIndex + 1}
          rects={rects}
          scale={scale}
          color={color}
        />
      )}
    </>
  );
}
