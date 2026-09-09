/*
 * Our own text selection for the highlight tool on touch devices.
 *
 * The platform's selection is what draws the magnifier that sits under the thumb, and the OS owns
 * where that goes — so the only way to move it was to stop using the platform's selection here.
 * This replaces it: long-press to take a word, drag either handle to adjust, then commit from the
 * pill. See `pdf/textGeometry.ts` for the character maths and `SelectionLoupe` for the magnifier.
 *
 * Only mounted when the highlight tool is active on a touch device; everywhere else, and for every
 * other tool, native selection is untouched.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
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

interface Props {
  pageIndex: number;
  scale: number;
  width: number;
  height: number;
  /** The page container, whose `.textLayer` child carries the spans. */
  pageEl: HTMLElement | null;
  /** Colours offered on the confirm pill; tapping one commits in that colour. */
  presets: string[];
  activePreset: number;
  onPick: (index: number) => void;
  onCommit: (rects: Rect[], color: string) => void;
}

export default function TextSelectLayer({
  pageIndex,
  scale,
  width,
  height,
  pageEl,
  presets,
  activePreset,
  onPick,
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
    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      stopEdge();
      useTextSelection.getState().setDragging(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
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

  /** A tap that never armed and never travelled dismisses whatever is selected. */
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

  const handle = (end: DragEnd, pos: CharPos) => {
    const layer = textLayer();
    const c = layer && caretRect(pageGeom(layer, scale), pos);
    if (!c) return null;
    // The start handle hangs above the line and the end handle below, so neither sits on the
    // character it marks — the same shape the platform's handles use, for the same reason.
    const top = end === "anchor" ? c.y * scale : (c.y + c.h) * scale;
    return (
      <div
        key={end}
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          e.currentTarget.setPointerCapture?.(e.pointerId);
          beginDrag(end, e.clientX, e.clientY);
        }}
        style={{
          position: "absolute",
          left: c.x * scale,
          top,
          width: 28,
          height: 28,
          marginLeft: -14,
          marginTop: end === "anchor" ? -28 : 0,
          touchAction: "none",
          pointerEvents: "auto",
          display: "flex",
          alignItems: end === "anchor" ? "flex-end" : "flex-start",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            width: 14,
            height: 14,
            borderRadius: "50%",
            background: "var(--accent)",
            boxShadow: "0 1px 3px rgb(0 0 0 / 0.35)",
          }}
        />
      </div>
    );
  };

  // ---- The confirm pill ----
  // Committing on handle release is what the old 450ms settle timer effectively did, and its
  // failure mode was landing the mark before you had finished adjusting. An explicit tap is the
  // fix, and it doubles as the colour choice, so picking a colour costs no extra step.
  const bounds = boundsOf(rects);
  const pill =
    mine && !dragging && bounds && pageEl
      ? (() => {
          const r = pageEl.getBoundingClientRect();
          const below = r.top + (bounds.y + bounds.h) * scale + 10;
          const flip = below > window.innerHeight - 80;
          return createPortal(
            <div
              style={{
                position: "fixed",
                left: Math.min(
                  Math.max(r.left + (bounds.x + bounds.w / 2) * scale, 90),
                  window.innerWidth - 90,
                ),
                top: flip ? undefined : below,
                bottom: flip ? window.innerHeight - (r.top + bounds.y * scale) + 10 : undefined,
                transform: "translateX(-50%)",
                zIndex: 55,
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 10px",
                borderRadius: 999,
                background: "var(--surface)",
                border: "1px solid var(--border)",
                boxShadow: "0 6px 20px rgb(0 0 0 / 0.3)",
              }}
            >
              {presets.map((c, i) => (
                <button
                  key={i}
                  title={`Highlight in colour ${i + 1}`}
                  onClick={() => {
                    onPick(i);
                    onCommit(rects, c);
                  }}
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: "50%",
                    background: c,
                    border:
                      i === activePreset ? "2px solid var(--accent)" : "2px solid rgb(255 255 255 / 0.3)",
                  }}
                />
              ))}
              <span style={{ width: 1, height: 18, background: "var(--border)" }} />
              <button
                title="Copy text"
                onClick={() => {
                  const layer = textLayer();
                  if (!layer) return;
                  const [a, b] = order(mine.anchor, mine.focus);
                  navigator.clipboard?.writeText(rangeText(pageGeom(layer, scale), a, b));
                  useTextSelection.getState().clear();
                }}
                style={{ padding: "0 6px", fontSize: 12, color: "var(--text)" }}
              >
                Copy
              </button>
              <button
                title="Cancel"
                onClick={() => useTextSelection.getState().clear()}
                style={{ padding: "0 6px", fontSize: 12, color: "var(--muted)" }}
              >
                Cancel
              </button>
            </div>,
            document.body,
          );
        })()
      : null;

  return (
    <>
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
          zIndex: 4,
          // A plain swipe still scrolls and two fingers still pinch; only an armed drag takes
          // the gesture, and it does that through the non-passive listener above.
          touchAction: "pan-x pan-y pinch-zoom",
          // The handles re-enable pointer events for themselves.
          pointerEvents: "auto",
        }}
      >
        {mine && handle("anchor", order(mine.anchor, mine.focus)[0])}
        {mine && handle("focus", order(mine.anchor, mine.focus)[1])}
      </div>
      {pill}
      {phone && dragging && mine && (
        <SelectionLoupe
          ref={loupeRef}
          pageNumber={pageIndex + 1}
          rects={rects}
          scale={scale}
          color={presets[activePreset] ?? "#fff59d"}
        />
      )}
    </>
  );
}
