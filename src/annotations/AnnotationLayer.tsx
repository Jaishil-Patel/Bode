import { useEffect, useMemo, useRef, useState } from "react";
import {
  useAnnotations,
  newId,
  type Annotation,
  type PenAnno,
  type RectAnno,
  type SignatureAnno,
  type Rect,
} from "./useAnnotations";

const EMPTY: Annotation[] = [];

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

// Whether the eraser at (px,py) should remove annotation `a`. `tol` is the hit slop in points.
function eraserHits(a: Annotation, px: number, py: number, tol: number): boolean {
  switch (a.type) {
    case "rect":
    case "ellipse":
    case "signature":
      return inBox(px, py, a.x, a.y, a.w, a.h, tol);
    case "highlight":
      return a.rects.some((r) => inBox(px, py, r.x, r.y, r.w, r.h, tol));
    case "text": {
      const lines = a.text.split("\n").length || 1;
      return inBox(px, py, a.x, a.y, a.w, a.fontSize * 1.25 * lines, tol);
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
  const all = useAnnotations((s) => s.byFile[filePath] ?? EMPTY);
  const tool = useAnnotations((s) => s.tool);
  const selectedId = useAnnotations((s) => s.selectedId);
  const strokeWidth = useAnnotations((s) => s.strokeWidth);
  const fontSize = useAnnotations((s) => s.fontSize);
  const fillShapes = useAnnotations((s) => s.fillShapes);
  const fillOpacity = useAnnotations((s) => s.fillOpacity);
  const { add, update, remove, setSelected, setTool, activeColor } = useAnnotations.getState();

  const pageAnnos = useMemo(
    () => all.filter((a) => a.pageIndex === pageIndex),
    [all, pageIndex]
  );

  const ref = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const erasing = useRef(false);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const [drag, setDrag] = useState<Drag>(null);

  // Tools that draw/place by interacting with the overlay directly. Highlight and edit are
  // NOT here — they work off the real text layer (handled in effects below), so the overlay
  // stays click-through to let the text layer receive the selection/click.
  const captureTool =
    tool === "text" ||
    tool === "rect" ||
    tool === "ellipse" ||
    tool === "pen" ||
    tool === "signature" ||
    tool === "eraser";

  const toPdf = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  };

  // Remove the topmost annotation under the eraser at point `p` (one per call).
  const eraseAt = (p: { x: number; y: number }) => {
    const tol = 5 / scale; // ~5px hit slop regardless of zoom
    for (let i = pageAnnos.length - 1; i >= 0; i--) {
      if (eraserHits(pageAnnos[i], p.x, p.y, tol)) {
        remove(filePath, pageAnnos[i].id);
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

    if (tool === "eraser") {
      (e.target as Element).setPointerCapture?.(e.pointerId);
      erasing.current = true;
      eraseAt(p); // erase on the initial click; keep erasing as the pointer drags
      return;
    }

    if (tool === "text") {
      const id = newId();
      add(filePath, { id, pageIndex, type: "text", x: p.x, y: p.y, w: 180, fontSize, color, text: "" });
      setTool("select");
      setSelected(id);
      return;
    }

    if (tool === "signature") {
      const { signatureDataUrl, setSignaturePadOpen } = useAnnotations.getState();
      if (!signatureDataUrl) {
        // No signature drawn yet — open the pad; the click that follows a save will place it.
        setSignaturePadOpen(true);
        return;
      }
      // Size to a default width, deriving height from the image's aspect ratio once loaded.
      const url = signatureDataUrl;
      const img = new Image();
      img.onload = () => {
        const w = 180;
        const h = img.width > 0 ? (w * img.height) / img.width : 80;
        const id = newId();
        add(filePath, {
          id,
          pageIndex,
          type: "signature",
          color: "#000000",
          x: p.x,
          y: p.y,
          w,
          h,
          dataUrl: url,
        });
        setTool("select");
        setSelected(id);
      };
      img.src = url;
      return;
    }

    (e.target as Element).setPointerCapture?.(e.pointerId);
    start.current = p;
    const id = newId();
    if (tool === "pen") {
      setDraft({ id, pageIndex, type: "pen", color, strokeWidth, points: [p] });
    } else {
      setDraft({
        id,
        pageIndex,
        type: tool as "rect" | "ellipse",
        color,
        strokeWidth,
        filled: fillShapes,
        fillOpacity,
        x: p.x,
        y: p.y,
        w: 0,
        h: 0,
      });
    }
  };

  // ---- Highlight by selecting text ----
  // When the highlight tool is active, let the user select text normally; on mouse-up
  // turn the selection's line rectangles into a highlight anchored to this page.
  useEffect(() => {
    if (tool !== "highlight") return;
    const onUp = () => {
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
          // The selection rect spans the whole line box (with leading above/below the
          // glyphs). Trim it so the highlight hugs the text — more off the top.
          const topInset = r.height * 0.24;
          const botInset = r.height * 0.06;
          rects.push({
            x: (r.left - pageRect.left) / scale,
            y: (r.top - pageRect.top + topInset) / scale,
            w: r.width / scale,
            h: (r.height - topInset - botInset) / scale,
          });
        }
      }
      if (rects.length) {
        add(filePath, { id: newId(), pageIndex, type: "highlight", color: activeColor(), rects });
        sel.removeAllRanges();
      }
    };
    document.addEventListener("mouseup", onUp);
    return () => document.removeEventListener("mouseup", onUp);
  }, [tool, scale, filePath, pageIndex, add, activeColor]);

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
      add(filePath, {
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
      add(filePath, {
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
      setTool("select");
      setSelected(id);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [tool, scale, filePath, pageIndex, add, setTool, setSelected]);

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
      setDraft({
        ...draft,
        x: Math.min(s.x, p.x),
        y: Math.min(s.y, p.y),
        w: Math.abs(p.x - s.x),
        h: Math.abs(p.y - s.y),
      } as Annotation);
    }
  };

  const onPointerUp = () => {
    if (!draft) return;
    const ok =
      draft.type === "pen"
        ? (draft as PenAnno).points.length > 1
        : (draft as { w: number; h: number }).w > 2 || (draft as { h: number }).h > 2;
    if (ok) add(filePath, draft);
    setDraft(null);
    start.current = null;
  };

  // ---- Moving existing annotations (select mode) ----
  const startMove = (e: React.PointerEvent, a: Annotation) => {
    if (tool !== "select") return;
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
    if (tool !== "select") return;
    e.stopPropagation();
    setSelected(a.id);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const ratio = a.w > 0 ? a.h / a.w : 1;
    const move = (ev: PointerEvent) => {
      const r = ref.current!.getBoundingClientRect();
      const w = Math.max(20, (ev.clientX - r.left) / scale - a.x);
      update(filePath, a.id, { w, h: w * ratio } as Partial<Annotation>);
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
      update(filePath, a.id, { points: a.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) });
    } else if (a.type === "highlight") {
      update(filePath, a.id, {
        rects: a.rects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy })),
      });
    } else {
      update(filePath, a.id, { x: a.x + dx, y: a.y + dy } as Partial<Annotation>);
    }
  };

  // Apply an in-progress drag offset for live rendering.
  const withDrag = (a: Annotation): Annotation => {
    if (!drag || drag.id !== a.id) return a;
    if (a.type === "pen")
      return { ...a, points: a.points.map((p) => ({ x: p.x + drag.dx, y: p.y + drag.dy })) };
    if (a.type === "highlight")
      return { ...a, rects: a.rects.map((r) => ({ ...r, x: r.x + drag.dx, y: r.y + drag.dy })) };
    return { ...a, x: a.x + drag.dx, y: a.y + drag.dy } as Annotation;
  };

  const annoPE = tool === "select" ? "auto" : "none"; // per-annotation pointer events

  const renderShape = (a: Annotation, isDraft: boolean) => {
    if (a.type === "text" || a.type === "signature") return null; // rendered as DOM, not svg
    const key = a.id + (isDraft ? "-draft" : "");
    const selected = !isDraft && a.id === selectedId;
    const common = {
      style: { pointerEvents: annoPE as React.CSSProperties["pointerEvents"], cursor: "move" },
      onPointerDown: (e: React.PointerEvent) => !isDraft && startMove(e, a),
    };
    if (a.type === "highlight") {
      // One group of line rectangles, multiplied to blend nicely over text.
      return (
        <g key={key} {...common} style={{ ...common.style, mixBlendMode: "multiply" }}>
          {a.rects.map((r, i) => (
            <rect
              key={i}
              x={r.x * scale}
              y={r.y * scale}
              width={r.w * scale}
              height={r.h * scale}
              fill={a.color}
              fillOpacity={0.35}
            />
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
    // No selection outline for text/signature (they have their own) or highlights (clutter).
    if (!base || base.type === "text" || base.type === "highlight" || base.type === "signature")
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
    } else if (a.type === "highlight") {
      const x0 = Math.min(...a.rects.map((r) => r.x));
      const y0 = Math.min(...a.rects.map((r) => r.y));
      const x1 = Math.max(...a.rects.map((r) => r.x + r.w));
      const y1 = Math.max(...a.rects.map((r) => r.y + r.h));
      x = x0;
      y = y0;
      w = x1 - x0;
      h = y1 - y0;
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
      className="absolute inset-0"
      style={{
        width,
        height,
        zIndex: 3,
        // Only capture pointer events for drag-drawing tools. Highlight & select stay
        // click-through so the text layer beneath can be selected.
        pointerEvents: captureTool ? "auto" : "none",
        cursor: captureTool ? "crosshair" : "default",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <svg width={width} height={height} style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "visible" }}>
        {pageAnnos
          .filter((a) => a.type !== "text" && a.type !== "signature")
          .map((a) => renderShape(withDrag(a), false))}
        {draft && draft.type !== "text" && renderShape(draft, true)}
        {selBox}
      </svg>

      {pageAnnos
        .filter((a): a is Extract<Annotation, { type: "text" }> => a.type === "text")
        .map((a) => {
          const d = withDrag(a) as typeof a;
          const selected = a.id === selectedId;
          const sx = a.scaleX ?? 1;
          return (
            <div
              key={a.id}
              onPointerDown={(e) => {
                // Drag from the box edge; let the textarea handle inner clicks.
                if (tool === "select" && (e.target as HTMLElement).dataset.handle) startMove(e, a);
              }}
              style={{
                position: "absolute",
                left: d.x * scale,
                top: d.y * scale,
                width: a.w * scale,
                pointerEvents: annoPE,
                outline: selected ? "1px dashed var(--accent)" : "none",
              }}
            >
              {selected && (
                <div
                  data-handle="1"
                  title="Drag to move"
                  style={{
                    position: "absolute",
                    top: -14,
                    left: 0,
                    height: 12,
                    width: "100%",
                    cursor: "move",
                    background: "var(--accent)",
                    opacity: 0.5,
                    borderRadius: 3,
                  }}
                />
              )}
              <textarea
                value={a.text}
                placeholder="Text…"
                onChange={(e) => update(filePath, a.id, { text: e.target.value })}
                onFocus={() => setSelected(a.id)}
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
                  height: Math.max(a.fontSize * scale * 1.3, (a.text.split("\n").length) * a.fontSize * scale * 1.3),
                }}
              />
            </div>
          );
        })}

      {pageAnnos
        .filter((a): a is SignatureAnno => a.type === "signature")
        .map((a) => {
          const d = withDrag(a) as SignatureAnno;
          const selected = a.id === selectedId;
          return (
            <div
              key={a.id}
              onPointerDown={(e) => {
                if (tool === "select" && !(e.target as HTMLElement).dataset.resize) startMove(e, a);
              }}
              style={{
                position: "absolute",
                left: d.x * scale,
                top: d.y * scale,
                width: a.w * scale,
                height: a.h * scale,
                pointerEvents: annoPE,
                cursor: tool === "select" ? "move" : "default",
                outline: selected ? "1px dashed var(--accent)" : "none",
              }}
            >
              <img
                src={a.dataUrl}
                alt="Signature"
                draggable={false}
                style={{ width: "100%", height: "100%", display: "block", pointerEvents: "none" }}
              />
              {selected && tool === "select" && (
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
