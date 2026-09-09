import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  useAnnotations,
  newId,
  DEFAULT_MARK_WEIGHT,
  HIGHLIGHT_OPACITY,
  isClosedShape,
  isMarkupTool,
  isRectsAnno,
  type Annotation,
  type MarkupAnno,
  type HighlightAnno,
  type PenAnno,
  type RectAnno,
  type SignatureAnno,
  type TextAnno,
  type Rect,
} from "./useAnnotations";

import { fitInside, SIGNATURE_CLICK_WIDTH, useSignatureAspect } from "./signature";
import { isTouchPrimary } from "../platform/device";
import { useSettings } from "../settings/useSettings";
import TextSelectLayer from "./TextSelectLayer";
import { useTextSelection } from "./useTextSelection";
import { usePortals } from "../portals/usePortals";
import { pageGeom, rangeRects } from "../pdf/textGeometry";

const EMPTY: Annotation[] = [];
const EMPTY_RECTS: Rect[] = [];
/** The pin tool's marquee colour. A literal, because a draft carries a colour and this one is
 *  never the user's — it marks a region rather than drawing anything. */
const PIN_MARQUEE = "#3b82f6";

// Highlight height as a fraction of the selection's line box. A hair under 1 so stacked lines get
// a faint separation instead of fusing into one block, while still reading as the full selection.
const HIGHLIGHT_LINE_SCALE = 0.94;

/*
 * Shrink a selection line box to the height a highlight is drawn at.
 *
 * Shared by both commit paths — the mouse one below and the touch one in TextSelectLayer — so the
 * mark cannot land in a different place depending on what you selected it with. Tracking the line
 * box rather than hugging the glyphs is deliberate: hugging left the committed highlight visibly
 * smaller than the preview you had just dragged over. The inset is split evenly to stay centred.
 */
export const insetLine = (r: Rect): Rect => {
  const i = (r.h * (1 - HIGHLIGHT_LINE_SCALE)) / 2;
  return { x: r.x, y: r.y + i, w: r.w, h: r.h - i * 2 };
};

// A line box as a multiple of the type size — the `lineHeight` text boxes render with, and so
// the ratio between a box's height and the size of writing that fills it.
const LINE_RATIO = 1.25;
const MIN_FONT = 4;
const MAX_FONT = 200;

// Reused canvas for measuring text width (so the edit box can be sized to match the original).
let measureCtx: CanvasRenderingContext2D | null = null;
function measureTextWidth(text: string, fontPx: number, fontFamily: string): number {
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
  if (!measureCtx) return 0;
  measureCtx.font = `${fontPx}px ${fontFamily}`;
  return measureCtx.measureText(text).width;
}

// Distance from point (px,py) to segment (x1,y1)-(x2,y2), all in PDF points.
function pointSegDist(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

const inBox = (px: number, py: number, x: number, y: number, w: number, h: number, tol: number) =>
  px >= x - tol && px <= x + w + tol && py >= y - tol && py <= y + h + tol;

// Screen-space rects for one highlight (one per selected line). Shared by the visual layer and the
// invisible hit proxy so the thing you see and the thing you can grab can never drift apart.
/** Stroke weight for a text mark, proportional to the line it marks. */
const markWeight = (lineHeight: number, mult = 1) => Math.max(0.25, lineHeight * 0.075 * mult);

/*
 * Where a mark sits inside the line box, as a fraction of its height.
 *
 * A selection rectangle spans the whole line box — the top of the ascenders to the bottom of the
 * descenders — so the baseline is not its middle. It sits around 0.8 down, which is why splitting
 * the box in half puts a strikethrough above the middle of the letters rather than through them,
 * and why an underline placed inside the box rides up into them.
 */
const UNDERLINE_Y = 1.02; // just clear of the descenders
const STRIKE_Y = 0.66; // through the middle of the x-height, not of the box

/**
 * A wave along a line, for the squiggle. Alternating quadratic humps rather than a sine path:
 * two control points per period is the cheapest thing that still reads as a wave at any zoom.
 */
function squigglePath(x0: number, x1: number, y: number, amp: number): string {
  const step = Math.max(2, amp * 2.4);
  let d = `M ${x0} ${y}`;
  let up = true;
  for (let x = x0; x < x1 - 0.01; x += step) {
    const nx = Math.min(x + step, x1);
    d += ` Q ${(x + nx) / 2} ${y + (up ? -amp : amp)} ${nx} ${y}`;
    up = !up;
  }
  return d;
}

/** A triangle's three corners from its box: apex centred on top, base along the bottom. */
const trianglePoints = (x: number, y: number, w: number, h: number, scale: number) =>
  `${(x + w / 2) * scale},${y * scale} ${x * scale},${(y + h) * scale} ${(x + w) * scale},${(y + h) * scale}`;

/** The two barbs of an arrowhead at (x2,y2), coming from (x1,y1). In page space. */
function arrowHead(x1: number, y1: number, x2: number, y2: number, size: number) {
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const spread = Math.PI / 7;
  return [
    { x: x2 - size * Math.cos(ang - spread), y: y2 - size * Math.sin(ang - spread) },
    { x: x2 - size * Math.cos(ang + spread), y: y2 - size * Math.sin(ang + spread) },
  ];
}

const highlightRects = (a: HighlightAnno, scale: number) =>
  a.rects.map((r) => ({
    x: r.x * scale,
    y: r.y * scale,
    width: r.w * scale,
    height: r.h * scale,
  }));

// Whether the eraser at (px,py) should remove annotation `a`. `tol` is the hit slop in points.
function eraserHits(a: Annotation, px: number, py: number, tol: number): boolean {
  switch (a.type) {
    case "rect":
    case "ellipse":
    case "triangle":
    case "signature":
      return inBox(px, py, a.x, a.y, a.w, a.h, tol);
    // Open shapes are a stroke, so the hit is against the segment rather than its bounding box —
    // otherwise a diagonal arrow would erase from anywhere in the large empty square around it.
    case "line":
    case "arrow":
      return pointSegDist(px, py, a.x, a.y, a.x + a.w, a.y + a.h) <= a.strokeWidth / 2 + tol;
    case "highlight":
    case "underline":
    case "strikeout":
    case "squiggly":
      return a.rects.some((r) => inBox(px, py, r.x, r.y, r.w, r.h, tol));
    case "text": {
      const lines = a.text.split("\n").length || 1;
      const h = Math.max(a.fontSize * 1.25 * lines, a.h ?? 0);
      return inBox(px, py, a.x, a.y, a.w, h, tol);
    }
    case "pen": {
      const t = a.strokeWidth / 2 + tol;
      if (a.points.length === 1)
        return Math.hypot(px - a.points[0].x, py - a.points[0].y) <= t;
      for (let i = 1; i < a.points.length; i++) {
        const p0 = a.points[i - 1];
        const p1 = a.points[i];
        if (pointSegDist(px, py, p0.x, p0.y, p1.x, p1.y) <= t) return true;
      }
      return false;
    }
  }
  return false;
}

interface Props {
  filePath: string;
  pageIndex: number;
  scale: number;
  width: number;
  height: number;
}

type Drag = { id: string; dx: number; dy: number } | null;

export default function AnnotationLayer({ filePath, pageIndex, scale, width, height }: Props) {
  // Annotations are filed under a cross-device doc key, not this device's path — so a highlight made
  // on the desktop is found again when the same PDF is opened from the phone. For a document nobody
  // shares, the key IS the path, and nothing changes.
  const docKey = useSettings((s) => s.docKey(filePath));
  const all = useAnnotations((s) => s.byFile[docKey] ?? EMPTY);
  const tool = useAnnotations((s) => s.tool);
  const selectedId = useAnnotations((s) => s.selectedId);
  const strokeWidth = useAnnotations((s) => s.strokeWidth);
  const fontSize = useAnnotations((s) => s.fontSize);
  const fillShapes = useAnnotations((s) => s.fillShapes);
  const fillOpacity = useAnnotations((s) => s.fillOpacity);
  const signatureDataUrl = useAnnotations((s) => s.signatureDataUrl);
  const signatureAspect = useSignatureAspect(signatureDataUrl);
  // Subscribed rather than read through activeColor(): this one is a prop, so it has to re-render
  // the loupe when the preset changes. The commit path still calls activeColor() for the value
  // that is live at the moment the mark lands.
  const highlightColor = useAnnotations((a) => a.highlightPresets[a.activePreset]);
  const { add, update, remove, setSelected, setEditingId, setTool, activeColor } =
    useAnnotations.getState();

  /*
   * Tools under which existing annotations can be picked up rather than drawn over.
   *
   * The form tool belongs here as much as select does: a blank filled in on a flat form becomes an
   * ordinary text box, and it would be strange to have to leave form mode to move, resize or
   * delete the thing form mode just made.
   */
  const selectMode = tool === "select" || tool === "form";

  const pageAnnos = useMemo(
    () => all.filter((a) => a.pageIndex === pageIndex),
    [all, pageIndex]
  );

  const ref = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const erasing = useRef(false);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const [drag, setDrag] = useState<Drag>(null);
  // Which text box is in edit mode (caret active). Double-click to enter; blur/deselect to exit.
  // Kept in the store so the form layer can hand a newly filled blank straight to the caret.
  const editingId = useAnnotations((s) => s.editingId);
  // The page container (our own parent), used as the portal target for the highlight layer.
  const shapeKind = useAnnotations((s) => s.shapeKind);
  const openPortal = usePortals((s) => s.open);
  const [pageEl, setPageEl] = useState<HTMLElement | null>(null);
  useEffect(() => setPageEl(ref.current?.parentElement ?? null), []);

  // Leave edit mode if the tool changes to one that draws, or another annotation is selected.
  useEffect(() => {
    if (editingId && (!selectMode || (selectedId && selectedId !== editingId)))
      setEditingId(null);
  }, [selectMode, selectedId, editingId, setEditingId]);

  // Tools that draw/place by interacting with the overlay directly. Highlight and edit are
  // NOT here — they work off the real text layer (handled in effects below), so the overlay
  // stays click-through to let the text layer receive the selection/click.
  const captureTool =
    tool === "text" ||
    tool === "shape" ||
    tool === "pen" ||
    tool === "signature" ||
    tool === "pin" ||
    tool === "eraser";

  const toPdf = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  };

  // Remove the topmost annotation under the eraser at point `p` (one per call). Text boxes are
  // immune — the eraser passes through them and removes the next thing underneath instead.
  const eraseAt = (p: { x: number; y: number }) => {
    const tol = 5 / scale; // ~5px hit slop regardless of zoom
    for (let i = pageAnnos.length - 1; i >= 0; i--) {
      if (pageAnnos[i].type === "text") continue;
      if (eraserHits(pageAnnos[i], p.x, p.y, tol)) {
        remove(docKey,pageAnnos[i].id);
        break;
      }
    }
  };

  // ---- Drawing new annotations ----
  const onPointerDown = (e: React.PointerEvent) => {
    if (!captureTool) return;
    e.preventDefault();
    const p = toPdf(e);
    const color = activeColor();
    erasing.current = false; // any prior erase stroke is over; the eraser branch re-arms it below

    if (tool === "eraser") {
      (e.target as Element).setPointerCapture?.(e.pointerId);
      erasing.current = true;
      eraseAt(p); // erase on the initial click; keep erasing as the pointer drags
      return;
    }

    if (tool === "signature" && !signatureDataUrl) {
      // No signature drawn yet — open the pad; the drag that follows a save will place it.
      useAnnotations.getState().setSignaturePadOpen(true);
      return;
    }

    (e.target as Element).setPointerCapture?.(e.pointerId);
    start.current = p;
    const id = newId();
    if (tool === "pen") {
      setDraft({ id, pageIndex, type: "pen", color, strokeWidth, points: [p] });
    } else if (tool === "text") {
      setDraft({ id, pageIndex, type: "text", color, x: p.x, y: p.y, w: 0, h: 0, fontSize, text: "" });
    } else if (tool === "signature") {
      // Drag out the space to sign in, exactly the way a text box is drawn; the signature is
      // then fitted to whatever box the drag ends up describing.
      setDraft({
        id,
        pageIndex,
        type: "signature",
        color: "#000000",
        x: p.x,
        y: p.y,
        w: 0,
        h: 0,
        dataUrl: signatureDataUrl as string,
      });
    } else {
      // The pin marquee borrows the rectangle draft but never the rectangle tool's appearance:
      // it is a region being chosen, not a shape being drawn, so it stays a thin outline in the
      // accent colour whatever the shape settings happen to be.
      const marquee = tool === "pin";
      const kind = marquee ? "rect" : shapeKind;
      setDraft({
        id,
        pageIndex,
        // The pin marquee is always a rectangle; a real shape is whichever the picker is on.
        type: kind,
        color: marquee ? PIN_MARQUEE : color,
        strokeWidth: marquee ? 1 : strokeWidth,
        // Fill belongs to the closed shapes only — a line has no inside to fill.
        ...(isClosedShape(kind)
          ? { filled: marquee ? false : fillShapes, fillOpacity }
          : null),
        x: p.x,
        y: p.y,
        w: 0,
        h: 0,
      } as Annotation);
    }
  };

  // ---- Highlight by selecting text ----
  /*
   * Two selections, one commit.
   *
   * With a mouse the platform's own text selection is exactly right, and this is unchanged: select,
   * let go, and the line rectangles become a highlight anchored to this page.
   *
   * Touch is where it had to change. The platform selection draws a magnifier the OS pins under
   * the finger — unmovable from a web page, and squarely under the thumb — so on a touch device
   * `TextSelectLayer` runs a selection of our own instead and commits through `commitRects` below.
   * That also retires the old trick of waiting 450ms for `selectionchange` to settle, which was
   * only ever needed because the platform's drag handles are not DOM elements and never fire a
   * mouseup to commit on.
   */
  const customSelect = isTouchPrimary();
  /** The two tools that select text. Both replace the platform selection on a touch device. */
  const selectsText = isMarkupTool(tool) || tool === "select";

  const commitRects = (rects: Rect[]) => {
    if (!rects.length || !isMarkupTool(tool)) return;
    add(docKey, {
      id: newId(),
      pageIndex,
      // The tool decides which of the four marks this is; the rectangles are the same either way.
      type: tool as MarkupAnno["type"] | "highlight",
      color: activeColor(),
      /*
       * Read at the moment of the commit, not captured with the component.
       *
       * The desktop path commits from a `mouseup` listener whose effect does not depend on this
       * value, so a subscribed copy would be whatever it was when the tool was picked — setting
       * the thickness and *then* marking did nothing, and the only slider that appeared to work
       * was the one retuning a mark already made. `activeColor()` is read live for the same
       * reason, which is why the colour never had this problem.
       */
      ...(tool === "highlight" ? null : { weight: useAnnotations.getState().markWeight }),
      // Only a highlight is inset. A line is drawn *at* an edge of the line box rather than
      // filling it, so trimming the box would lift an underline into the glyphs above it.
      rects: tool === "highlight" ? rects.map(insetLine) : rects,
    } as Annotation);
  };

  /*
   * The live selection, painted through the same portal as the committed highlights below rather
   * than by the layer that handles the gesture. That portal sits under .textLayer and blends with
   * multiply, which is the only place a tint can go without washing out the glyphs — and it means
   * the preview and the mark it turns into are composited identically.
   */
  const liveSel = useTextSelection((s) => s.sel);
  const previewRects = useMemo(() => {
    if (!customSelect || !selectsText || !liveSel || liveSel.pageIndex !== pageIndex || !pageEl)
      return EMPTY_RECTS;
    const layer = pageEl.querySelector<HTMLElement>(".textLayer");
    if (!layer) return EMPTY_RECTS;
    return rangeRects(pageGeom(layer, scale), liveSel.anchor, liveSel.focus);
  }, [customSelect, selectsText, liveSel, pageIndex, pageEl, scale]);

  useEffect(() => {
    if (!isMarkupTool(tool) || customSelect) return;
    const commit = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const pageRect = ref.current?.getBoundingClientRect();
      if (!pageRect) return;
      const rects: Rect[] = [];
      for (let i = 0; i < sel.rangeCount; i++) {
        for (const r of Array.from(sel.getRangeAt(i).getClientRects())) {
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          // Only keep line-boxes whose centre lies on this page.
          if (cx < pageRect.left || cx > pageRect.right || cy < pageRect.top || cy > pageRect.bottom)
            continue;
          if (r.width < 1 || r.height < 1) continue;
          // Raw line boxes: `commitRects` decides what to do with them, and it is the only
          // place that decides, so the two selection paths cannot drift apart.
          rects.push({
            x: (r.left - pageRect.left) / scale,
            y: (r.top - pageRect.top) / scale,
            w: r.width / scale,
            h: r.height / scale,
          });
        }
      }
      if (rects.length) {
        commitRects(rects);
        sel.removeAllRanges();
      }
    };

    // A drag-select ends with a mouseup, so commit there.
    document.addEventListener("mouseup", commit);
    return () => document.removeEventListener("mouseup", commit);
  }, [tool, scale, docKey, pageIndex, add, activeColor, customSelect]);

  // ---- Edit existing text (whiteout + retype) ----
  // With the edit tool the overlay stays click-through so the click lands on a text-layer
  // span. We cover that span with a white rectangle and drop an editable text box pre-filled
  // with the original text at the same position and size, ready to retype.
  useEffect(() => {
    if (tool !== "edit") return;
    const onClick = (e: MouseEvent) => {
      const pageRect = ref.current?.getBoundingClientRect();
      if (!pageRect) return;
      // Only the page under the cursor handles the click.
      if (
        e.clientX < pageRect.left ||
        e.clientX > pageRect.right ||
        e.clientY < pageRect.top ||
        e.clientY > pageRect.bottom
      )
        return;
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      if (!el) return;
      const textLayerEl = el.closest(".textLayer");
      if (!textLayerEl) return;
      // Walk up to the direct child span of the text layer (search matches nest inner spans).
      let span: HTMLElement = el;
      while (span.parentElement && span.parentElement !== textLayerEl) span = span.parentElement;
      if (span.tagName !== "SPAN" || !span.textContent) return;

      const r = span.getBoundingClientRect();
      const x = (r.left - pageRect.left) / scale;
      const y = (r.top - pageRect.top) / scale;
      const w = r.width / scale;
      const h = r.height / scale;
      const text = span.textContent;
      // Reuse the original glyph font so the replacement looks the same, not the UI sans-serif.
      const fontFamily = span.style.fontFamily || undefined;
      // The span's CSS font-size is in scaled px; convert back to PDF points. This IS the glyph
      // height — using it directly keeps the replacement the same size as the original.
      const cssFs = parseFloat(span.style.fontSize) || h * scale * 0.8;
      const fontSize = cssFs / scale;
      // pdf.js stretches each span horizontally (scaleX) to hit the PDF's exact advance width.
      // Replicate that factor so the replacement matches the width WITHOUT inflating the size:
      // compare the original text's natural width in this font against its real on-page width.
      const natural = measureTextWidth(text, cssFs, fontFamily ?? "sans-serif");
      const scaleX = natural > 0 && r.width > 0 ? r.width / natural : 1;

      // White cover over the original glyphs (no border).
      add(docKey,{
        id: newId(),
        pageIndex,
        type: "rect",
        color: "#ffffff",
        x,
        y,
        w,
        h,
        strokeWidth: 0,
        filled: true,
        fillOpacity: 1,
      });
      // Editable replacement text, pre-filled with the original.
      const id = newId();
      add(docKey,{
        id,
        pageIndex,
        type: "text",
        color: "#000000",
        x,
        y,
        w: Math.max(w, 40),
        fontSize,
        text,
        fontFamily,
        fitText: text,
        fitWidth: w,
        scaleX,
      });
      // One of the two places the tool does have to change: `setEditingId` puts a caret in the
      // box, and a caret only survives in select mode — the effect above clears it otherwise.
      // Staying on the edit tool would also make the next tap white out another word.
      setTool("select");
      setSelected(id);
      setEditingId(id);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [tool, scale, docKey, pageIndex, add, setTool, setSelected]);

  const onPointerMove = (e: React.PointerEvent) => {
    if (erasing.current) {
      eraseAt(toPdf(e));
      return;
    }
    if (!draft) return;
    const p = toPdf(e);
    if (draft.type === "pen") {
      setDraft({ ...draft, points: [...(draft as PenAnno).points, p] });
    } else if (start.current) {
      const s = start.current;
      // A line or an arrow keeps the drag's own start and end, signs included: normalising the
      // box the way the closed shapes do would point every arrow down and to the right.
      const directional = draft.type === "line" || draft.type === "arrow";
      setDraft({
        ...draft,
        x: directional ? s.x : Math.min(s.x, p.x),
        y: directional ? s.y : Math.min(s.y, p.y),
        w: directional ? p.x - s.x : Math.abs(p.x - s.x),
        h: directional ? p.y - s.y : Math.abs(p.y - s.y),
      } as Annotation);
    }
  };

  const onPointerUp = () => {
    erasing.current = false; // end an erase stroke (the eraser never sets a draft)
    if (!draft) return;
    if (draft.type === "text") {
      const t = draft as TextAnno & { h: number };
      // A tiny drag is really a click → default-width auto-height box at the tool's own size.
      // A real drag keeps the dragged width, and a dragged *height* also sets the type size, so
      // one line of writing fills the box that was drawn. That is what makes dragging a box over
      // a blank on a form worth doing: the box is the size of the answer, not a container the
      // answer sits small inside. Boxes only ever grow downwards to fit what is typed, so a tall
      // one is always something the reader asked for rather than something they ended up with —
      // and resizing afterwards keeps the same ratio.
      const sized = t.w >= 5;
      const dragged = sized && t.h > 5;
      const anno: TextAnno = sized
        ? {
            ...t,
            w: t.w,
            h: dragged ? t.h : undefined,
            fontSize: dragged ? fitFont(t.h) : t.fontSize,
          }
        : { ...t, w: 180, h: undefined };
      add(docKey,anno);
      // As with the edit tool: the box is handed straight to the caret, and typing needs select
      // mode. Every other tool now stays picked until you pick another one.
      setTool("select");
      setSelected(anno.id);
      setEditingId(anno.id); // ready to type immediately
      setDraft(null);
      start.current = null;
      return;
    }
    if (draft.type === "signature") {
      const sig = draft as SignatureAnno;
      // A tiny drag is really a click, and gets a sensible default width; a real drag hands the
      // signature the box that was drawn, scaled to fill it without distorting the writing.
      const box = sig.w >= 5 ? sig : { x: sig.x, y: sig.y, w: SIGNATURE_CLICK_WIDTH, h: 0 };
      add(docKey, { ...sig, ...fitInside(box, signatureAspect) });
      setSelected(sig.id);
      setDraft(null);
      start.current = null;
      return;
    }
    const ok =
      draft.type === "pen"
        ? (draft as PenAnno).points.length > 1
        : // Magnitude, not sign: a line dragged up-left has negative w and h and is still a line.
          Math.abs((draft as { w: number }).w) > 2 || Math.abs((draft as { h: number }).h) > 2;

    /*
     * The pin tool borrows the rectangle drag but does not keep the rectangle: the box describes
     * a region to lift out of the page, and the result is a floating pane rather than anything
     * written into the document. It opens beside the region it came from, not on top of it.
     */
    if (tool === "pin") {
      const box = draft as unknown as { x: number; y: number; w: number; h: number };
      if (ok && box.w > 8 && box.h > 8) {
        const pr = ref.current?.getBoundingClientRect();
        openPortal(
          docKey,
          pageIndex,
          { x: box.x, y: box.y, w: box.w, h: box.h },
          {
            x: (pr?.left ?? 0) + (box.x + box.w) * scale + 16,
            y: (pr?.top ?? 0) + box.y * scale,
          },
        );
      }
      setDraft(null);
      start.current = null;
      return;
    }

    if (ok) add(docKey,draft);
    setDraft(null);
    start.current = null;
  };

  // ---- Moving existing annotations (select mode) ----
  const startMove = (e: React.PointerEvent, a: Annotation) => {
    if (!selectMode) return;
    e.stopPropagation();
    setSelected(a.id);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const origin = toPdf(e);
    setDrag({ id: a.id, dx: 0, dy: 0 });
    const move = (ev: PointerEvent) => {
      const r = ref.current!.getBoundingClientRect();
      setDrag({
        id: a.id,
        dx: (ev.clientX - r.left) / scale - origin.x,
        dy: (ev.clientY - r.top) / scale - origin.y,
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag((d) => {
        if (d && (d.dx !== 0 || d.dy !== 0)) translate(a, d.dx, d.dy);
        return null;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Resize a signature from its bottom-right corner, preserving aspect ratio.
  const startResize = (e: React.PointerEvent, a: SignatureAnno) => {
    if (!selectMode) return;
    e.stopPropagation();
    setSelected(a.id);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const ratio = a.w > 0 ? a.h / a.w : 1;
    const move = (ev: PointerEvent) => {
      const r = ref.current!.getBoundingClientRect();
      const w = Math.max(20, (ev.clientX - r.left) / scale - a.x);
      update(docKey,a.id, { w, h: w * ratio } as Partial<Annotation>);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** The type size at which a single line of writing fills a box `h` points tall. */
  const fitFont = (h: number) => Math.min(MAX_FONT, Math.max(MIN_FONT, Math.round(h / LINE_RATIO)));

  /*
   * Resize a text box from its bottom-right corner.
   *
   * Width is free — it decides where the text wraps and nothing else. Height carries the type
   * size with it: dragging the box to twice the height gives text twice as big, in the same
   * proportion it had when the drag started, so a box stretched to fill a blank on a form fills
   * it with writing rather than with empty space. Scaling from the size at the start of the drag
   * (rather than compounding each move) means dragging back to where you began gives back exactly
   * the size you began with.
   */
  const startResizeText = (e: React.PointerEvent, a: TextAnno) => {
    if (!selectMode) return;
    e.stopPropagation();
    setSelected(a.id);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    // The rendered height, which for a box that has grown to fit its text is taller than `a.h`
    // and for a fresh one is set by the font alone. Read off the box itself so both cases agree.
    const box = (e.currentTarget as HTMLElement).parentElement;
    const startH = Math.max(
      1,
      box ? box.getBoundingClientRect().height / scale : (a.h ?? a.fontSize * LINE_RATIO),
    );
    const startFont = a.fontSize;
    const move = (ev: PointerEvent) => {
      const r = ref.current!.getBoundingClientRect();
      const w = Math.max(40, (ev.clientX - r.left) / scale - a.x);
      const h = Math.max(4, (ev.clientY - r.top) / scale - a.y);
      const fontSize = Math.min(MAX_FONT, Math.max(MIN_FONT, Math.round((startFont * h) / startH)));
      update(docKey,a.id, { w, h, fontSize } as Partial<Annotation>);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const translate = (a: Annotation, dx: number, dy: number) => {
    if (a.type === "pen") {
      update(docKey,a.id, { points: a.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) });
    } else if (isRectsAnno(a)) {
      update(docKey,a.id, {
        rects: a.rects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy })),
      });
    } else {
      update(docKey,a.id, { x: a.x + dx, y: a.y + dy } as Partial<Annotation>);
    }
  };

  /*
   * The visible highlights, portalled out of this overlay and into the page container.
   *
   * They cannot be drawn in the overlay's own svg: the overlay sets `zIndex: 3`, and a positioned
   * element with a non-auto z-index forms a stacking context, which clips a descendant's blend
   * backdrop to that (empty) subtree. `mix-blend-mode: multiply` there is a silent no-op and the
   * fill composites normally over the canvas, washing out the text beneath it — the whole reason
   * this layer exists. Blending has to happen against the page canvas, so the svg is mounted as a
   * sibling of it, under the page div (position: relative, z-index: auto — not a stacking context,
   * so the canvas is genuinely in the backdrop). z-index 1 puts it above the canvas and below
   * .textLayer, and creating a stacking context here is harmless: only ancestors clip the backdrop.
   *
   * It stays part of this component so drag previews, selection and colors keep flowing from local
   * state — React events propagate through the React tree, not the DOM tree, so a portal changes
   * nothing about behaviour.
   */
  const renderHighlight = (a: HighlightAnno, isDraft: boolean) => (
    <g key={a.id + (isDraft ? "-draft" : "")}>
      {highlightRects(a, scale).map((r, i) => (
        <rect key={i} {...r} fill={a.color} fillOpacity={HIGHLIGHT_OPACITY} />
      ))}
    </g>
  );

  // Apply an in-progress drag offset for live rendering.
  const withDrag = (a: Annotation): Annotation => {
    if (!drag || drag.id !== a.id) return a;
    if (a.type === "pen")
      return { ...a, points: a.points.map((p) => ({ x: p.x + drag.dx, y: p.y + drag.dy })) };
    if (isRectsAnno(a))
      return { ...a, rects: a.rects.map((r) => ({ ...r, x: r.x + drag.dx, y: r.y + drag.dy })) };
    return { ...a, x: a.x + drag.dx, y: a.y + drag.dy } as Annotation;
  };

  const highlightLayer =
    pageEl &&
    createPortal(
      <svg
        width={width}
        height={height}
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 1,
          pointerEvents: "none",
          mixBlendMode: "multiply",
          overflow: "visible",
        }}
      >
        {pageAnnos
          .filter((a): a is HighlightAnno => a.type === "highlight")
          .map((a) => renderHighlight(withDrag(a) as HighlightAnno, false))}
        {draft?.type === "highlight" && renderHighlight(draft, true)}
        {/* Same pastel as .textLayer span::selection, so a touch selection looks like the
            platform one it replaced. Uninset: the mark insets on commit, matching what the
            native path has always done. */}
        {previewRects.map((r, i) => (
          <rect
            key={i}
            x={r.x * scale}
            y={r.y * scale}
            width={r.w * scale}
            height={r.h * scale}
            fill="#c7d2fe"
          />
        ))}
      </svg>,
      pageEl,
    );

  const annoPE = selectMode ? "auto" : "none"; // per-annotation pointer events

  const renderShape = (a: Annotation, isDraft: boolean) => {
    if (a.type === "text" || a.type === "signature") return null; // rendered as DOM, not svg
    const key = a.id + (isDraft ? "-draft" : "");
    const selected = !isDraft && a.id === selectedId;
    const common = {
      style: { pointerEvents: annoPE as React.CSSProperties["pointerEvents"], cursor: "move" },
      onPointerDown: (e: React.PointerEvent) => !isDraft && startMove(e, a),
    };
    if (a.type === "underline" || a.type === "strikeout" || a.type === "squiggly") {
      const m = a as MarkupAnno;
      return (
        <g key={key} {...common} opacity={selected ? 0.7 : 1}>
          {m.rects.map((r, i) => {
            const x0 = r.x * scale;
            const x1 = (r.x + r.w) * scale;
            const w = markWeight(r.h, m.weight ?? DEFAULT_MARK_WEIGHT) * scale;
            const y = (r.y + r.h * (m.type === "strikeout" ? STRIKE_Y : UNDERLINE_Y)) * scale;
            const stroke = { stroke: m.color, strokeWidth: w, strokeLinecap: "round" as const };
            return m.type === "squiggly" ? (
              <path key={i} d={squigglePath(x0, x1, y, r.h * 0.11 * scale)} fill="none" {...stroke} />
            ) : (
              <line key={i} x1={x0} y1={y} x2={x1} y2={y} {...stroke} />
            );
          })}
        </g>
      );
    }
    if (a.type === "highlight") {
      // Invisible stand-in. The visible highlight is painted by `highlightLayer` below, which sits
      // under .textLayer so it can blend against the page canvas — too low to ever be clicked,
      // since the text layer's spans are hit-testable. This group keeps drag-to-move working.
      // `pointerEvents: "all"` rather than "auto": the latter resolves to `visiblePainted`, which
      // is not reliably hit-testable at zero fill-opacity.
      return (
        <g
          key={key}
          onPointerDown={common.onPointerDown}
          style={{ pointerEvents: selectMode ? "all" : "none", cursor: "move" }}
        >
          {highlightRects(a, scale).map((r, i) => (
            <rect key={i} {...r} fill={a.color} fillOpacity={0} />
          ))}
        </g>
      );
    }
    if (a.type === "rect") {
      return (
        <rect
          key={key}
          x={a.x * scale}
          y={a.y * scale}
          width={a.w * scale}
          height={a.h * scale}
          fill={a.filled ? a.color : "none"}
          fillOpacity={a.filled ? a.fillOpacity : 0}
          stroke={a.color}
          strokeWidth={a.strokeWidth * scale}
          {...common}
        />
      );
    }
    if (a.type === "triangle") {
      return (
        <polygon
          key={key}
          points={trianglePoints(a.x, a.y, a.w, a.h, scale)}
          fill={a.filled ? a.color : "none"}
          fillOpacity={a.filled ? a.fillOpacity : 0}
          stroke={a.color}
          strokeWidth={a.strokeWidth * scale}
          strokeLinejoin="round"
          {...common}
        />
      );
    }
    if (a.type === "line" || a.type === "arrow") {
      // Drawn from the drag's own start and end, which is why these two do not normalise their
      // box: the direction is the shape.
      const x1 = a.x * scale;
      const y1 = a.y * scale;
      const x2 = (a.x + a.w) * scale;
      const y2 = (a.y + a.h) * scale;
      const head =
        a.type === "arrow"
          ? arrowHead(a.x, a.y, a.x + a.w, a.y + a.h, Math.max(6, a.strokeWidth * 4))
          : null;
      return (
        <g key={key} {...common} opacity={selected ? 0.85 : 1}>
          <line
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke={a.color}
            strokeWidth={a.strokeWidth * scale}
            strokeLinecap="round"
          />
          {head && (
            <polyline
              points={`${head[0].x * scale},${head[0].y * scale} ${x2},${y2} ${head[1].x * scale},${head[1].y * scale}`}
              fill="none"
              stroke={a.color}
              strokeWidth={a.strokeWidth * scale}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
        </g>
      );
    }
    if (a.type === "ellipse") {
      return (
        <ellipse
          key={key}
          cx={(a.x + a.w / 2) * scale}
          cy={(a.y + a.h / 2) * scale}
          rx={(a.w / 2) * scale}
          ry={(a.h / 2) * scale}
          fill={a.filled ? a.color : "none"}
          fillOpacity={a.filled ? a.fillOpacity : 0}
          stroke={a.color}
          strokeWidth={a.strokeWidth * scale}
          {...common}
        />
      );
    }
    // pen
    return (
      <polyline
        key={key}
        points={a.points.map((p) => `${p.x * scale},${p.y * scale}`).join(" ")}
        fill="none"
        stroke={a.color}
        strokeWidth={a.strokeWidth * scale}
        strokeLinejoin="round"
        strokeLinecap="round"
        {...common}
        style={{ ...common.style }}
        opacity={selected ? 0.85 : 1}
      />
    );
  };

  const selBox = (() => {
    const base = pageAnnos.find((x) => x.id === selectedId);
    // No selection outline for text/signature (they have their own), or for anything drawn from
    // a text selection — a dashed box round every marked line is clutter, not information.
    if (!base || base.type === "text" || isRectsAnno(base) || base.type === "signature")
      return null;
    const a = withDrag(base); // includes any live drag offset
    let x: number, y: number, w: number, h: number;
    if (a.type === "pen") {
      const xs = a.points.map((p) => p.x);
      const ys = a.points.map((p) => p.y);
      x = Math.min(...xs);
      y = Math.min(...ys);
      w = Math.max(...xs) - x;
      h = Math.max(...ys) - y;
    } else if (isRectsAnno(a)) {
      const x0 = Math.min(...a.rects.map((r) => r.x));
      const y0 = Math.min(...a.rects.map((r) => r.y));
      const x1 = Math.max(...a.rects.map((r) => r.x + r.w));
      const y1 = Math.max(...a.rects.map((r) => r.y + r.h));
      x = x0;
      y = y0;
      w = x1 - x0;
      h = y1 - y0;
    } else if (a.type === "line" || a.type === "arrow") {
      x = Math.min(a.x, a.x + a.w);
      y = Math.min(a.y, a.y + a.h);
      w = Math.abs(a.w);
      h = Math.abs(a.h);
    } else {
      ({ x, y, w, h } = a as RectAnno);
    }
    return (
      <rect
        x={x * scale - 3}
        y={y * scale - 3}
        width={w * scale + 6}
        height={h * scale + 6}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={1}
        strokeDasharray="4 3"
        style={{ pointerEvents: "none" }}
      />
    );
  })();

  return (
    <div
      ref={ref}
      className={`absolute inset-0 ${tool === "eraser" ? "cursor-eraser" : ""}`}
      style={{
        width,
        height,
        zIndex: 3,
        // Only capture pointer events for drag-drawing tools. Highlight & select stay
        // click-through so the text layer beneath can be selected.
        pointerEvents: captureTool ? "auto" : "none",
        // On touch devices the WebView otherwise claims the gesture for scrolling after a few
        // pixels of movement, firing pointercancel and aborting it ("draws a small line then
        // stops"; dragging a placed signature/text box jumps around). Opt out of native panning
        // so the full pointermove stream reaches us. Unconditional because this overlay is the
        // common ancestor of every draggable child (shapes, signatures, text boxes) and the
        // browser intersects touch-action down the ancestor chain, covering select-mode drags too.
        // TextSelectLayer's surface is deliberately portalled outside this element so that
        // intersection cannot reach it and stop a swipe from scrolling the page.
        touchAction: "none",
        // The eraser gets a real eraser-shaped cursor (via .cursor-eraser); other drawing tools
        // use a crosshair. Leave cursor unset for the eraser so the class takes effect.
        cursor: tool === "eraser" ? undefined : captureTool ? "crosshair" : "default",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {selectsText && customSelect && (
        <TextSelectLayer
          mode={tool === "select" ? "select" : "mark"}
          pageIndex={pageIndex}
          scale={scale}
          width={width}
          height={height}
          pageEl={pageEl}
          color={highlightColor}
          onCommit={commitRects}
        />
      )}
      {highlightLayer}
      <svg width={width} height={height} style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "visible" }}>
        {pageAnnos
          .filter((a) => a.type !== "text" && a.type !== "signature")
          .map((a) => renderShape(withDrag(a), false))}
        {draft && draft.type !== "text" && renderShape(draft, true)}
        {draft && (draft.type === "text" || draft.type === "signature") && (
          <rect
            x={(draft as TextAnno).x * scale}
            y={(draft as TextAnno).y * scale}
            width={(draft as TextAnno & { w: number }).w * scale}
            height={(draft as TextAnno & { h: number }).h * scale}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={1}
            strokeDasharray="4 3"
          />
        )}
        {selBox}
      </svg>

      {pageAnnos
        .filter((a): a is TextAnno => a.type === "text")
        .map((a) => (
          <TextBox
            key={a.id}
            anno={withDrag(a) as TextAnno}
            scale={scale}
            selected={a.id === selectedId}
            editing={editingId === a.id}
            interactive={selectMode}
            pe={annoPE}
            onChangeText={(text) => update(docKey,a.id, { text })}
            onSelect={() => setSelected(a.id)}
            onStartMove={(e) => startMove(e, a)}
            onStartResize={(e) => startResizeText(e, a)}
            onDelete={() => remove(docKey,a.id)}
            onBeginEdit={() => {
              setSelected(a.id);
              setEditingId(a.id);
            }}
            onEndEdit={() => {
              if (useAnnotations.getState().editingId === a.id) setEditingId(null);
            }}
          />
        ))}

      {/* What the signature will look like in the box being dragged, at the size it will land. */}
      {draft?.type === "signature" &&
        (() => {
          const f = fitInside(draft, signatureAspect);
          if (f.w < 2) return null;
          return (
            <img
              src={draft.dataUrl}
              alt=""
              draggable={false}
              style={{
                position: "absolute",
                left: f.x * scale,
                top: f.y * scale,
                width: f.w * scale,
                height: f.h * scale,
                opacity: 0.7,
                pointerEvents: "none",
              }}
            />
          );
        })()}

      {pageAnnos
        .filter((a): a is SignatureAnno => a.type === "signature")
        .map((a) => {
          const d = withDrag(a) as SignatureAnno;
          const selected = a.id === selectedId;
          return (
            <div
              key={a.id}
              onPointerDown={(e) => {
                if (selectMode && !(e.target as HTMLElement).dataset.resize) startMove(e, a);
              }}
              style={{
                position: "absolute",
                left: d.x * scale,
                top: d.y * scale,
                width: a.w * scale,
                height: a.h * scale,
                pointerEvents: annoPE,
                touchAction: "none", // hold-and-drag on touch; don't let the WebView pan instead
                cursor: selectMode ? "move" : "default",
                outline: selected ? "1px dashed var(--accent)" : "none",
              }}
            >
              <img
                src={a.dataUrl}
                alt="Signature"
                draggable={false}
                style={{ width: "100%", height: "100%", display: "block", pointerEvents: "none" }}
              />
              {selected && selectMode && (
                <div
                  data-resize="1"
                  title="Drag to resize"
                  onPointerDown={(e) => startResize(e, a)}
                  style={{
                    position: "absolute",
                    right: -5,
                    bottom: -5,
                    height: 10,
                    width: 10,
                    cursor: "nwse-resize",
                    background: "var(--accent)",
                    borderRadius: 2,
                  }}
                />
              )}
            </div>
          );
        })}
    </div>
  );
}

interface TextBoxProps {
  anno: TextAnno; // already includes any live drag offset
  scale: number;
  selected: boolean;
  editing: boolean;
  interactive: boolean; // select tool active → movable/editable
  pe: React.CSSProperties["pointerEvents"];
  onChangeText: (text: string) => void;
  onSelect: () => void;
  onStartMove: (e: React.PointerEvent) => void;
  onStartResize: (e: React.PointerEvent) => void;
  onBeginEdit: () => void;
  onEndEdit: () => void;
  onDelete: () => void;
}

function TextBox({
  anno: a,
  scale,
  selected,
  editing,
  interactive,
  pe,
  onChangeText,
  onSelect,
  onStartMove,
  onStartResize,
  onBeginEdit,
  onEndEdit,
  onDelete,
}: TextBoxProps) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const sx = a.scaleX ?? 1;
  const lineH = a.fontSize * scale * 1.25;

  // Grow the textarea to fit wrapped content while honoring the dragged/resized minimum height.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "0px"; // reset so scrollHeight reflects content, not the prior height
    const minH = Math.max(lineH, (a.h ?? 0) * scale);
    ta.style.height = `${Math.max(ta.scrollHeight, minH)}px`;
  }, [a.text, a.w, a.h, a.fontSize, scale, sx, lineH]);

  // Focus when entering edit mode.
  useEffect(() => {
    if (editing) taRef.current?.focus();
  }, [editing]);

  return (
    <div
      onPointerDown={(e) => {
        // While editing, let the textarea handle clicks/caret. Otherwise drag moves the box
        // (but not when grabbing the resize handle).
        if (!interactive || editing) return;
        if ((e.target as HTMLElement).dataset.resize) return;
        onStartMove(e);
      }}
      onDoubleClick={() => interactive && onBeginEdit()}
      style={{
        position: "absolute",
        left: a.x * scale,
        top: a.y * scale,
        width: a.w * scale,
        pointerEvents: pe,
        touchAction: "none", // hold-and-drag on touch; don't let the WebView pan instead
        outline: selected ? "1px dashed var(--accent)" : "none",
        cursor: interactive && !editing ? "move" : "default",
      }}
    >
      <textarea
        ref={taRef}
        value={a.text}
        placeholder="Text…"
        readOnly={!editing}
        onChange={(e) => onChangeText(e.target.value)}
        onFocus={onSelect}
        onBlur={onEndEdit}
        spellCheck={false}
        style={{
          // Stretch horizontally to the original width (sx) while keeping glyph height
          // at the font size, so the box's visible width stays a.w * scale.
          width: (a.w * scale) / sx,
          transform: sx !== 1 ? `scaleX(${sx})` : undefined,
          transformOrigin: "0 0",
          resize: "none",
          border: "none",
          outline: "none",
          background: "transparent",
          color: a.color,
          fontSize: a.fontSize * scale,
          lineHeight: 1.25,
          fontFamily: a.fontFamily ?? "var(--font-ui)",
          overflow: "hidden",
          padding: 0,
          // When not editing, clicks should fall through to the wrapper so dragging moves the box.
          pointerEvents: editing ? "auto" : "none",
          cursor: editing ? "text" : "move",
        }}
      />
      {selected && interactive && !editing && (
        <>
          <div
            data-delete="1"
            title="Delete text box"
            onPointerDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              onDelete();
            }}
            style={{
              position: "absolute",
              top: -8,
              right: -8,
              height: 16,
              width: 16,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              color: "#fff",
              background: "var(--accent)",
              borderRadius: "50%",
              userSelect: "none",
            }}
          >
            {/* Inline rather than <IconClose/>: at 10px inside a 16px badge the shared icon's
                1.8 stroke scales down to a hairline, so this one needs a heavier weight. */}
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={3}
              strokeLinecap="round"
              aria-hidden
            >
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </div>
          <div
            data-resize="1"
            title="Drag to resize"
            onPointerDown={onStartResize}
            style={{
              position: "absolute",
              right: -5,
              bottom: -5,
              height: 10,
              width: 10,
              cursor: "nwse-resize",
              background: "var(--accent)",
              borderRadius: 2,
            }}
          />
        </>
      )}
    </div>
  );
}
