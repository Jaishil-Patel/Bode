import { useEffect, useMemo, useRef, useState } from "react";
import {
  useAnnotations,
  newId,
  type Annotation,
  type PenAnno,
  type RectAnno,
  type Rect,
} from "./useAnnotations";

const EMPTY: Annotation[] = [];

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
  const { add, update, setSelected, setTool, activeColor } = useAnnotations.getState();

  const pageAnnos = useMemo(
    () => all.filter((a) => a.pageIndex === pageIndex),
    [all, pageIndex]
  );

  const ref = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const [drag, setDrag] = useState<Drag>(null);

  // Tools that draw by dragging a pointer on the overlay. Highlight is NOT here —
  // it works by selecting real text (handled in the effect below), so the overlay
  // stays click-through to let the text layer receive the selection.
  const captureTool = tool === "text" || tool === "rect" || tool === "ellipse" || tool === "pen";

  const toPdf = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  };

  // ---- Drawing new annotations ----
  const onPointerDown = (e: React.PointerEvent) => {
    if (!captureTool) return;
    e.preventDefault();
    const p = toPdf(e);
    const color = activeColor();

    if (tool === "text") {
      const id = newId();
      add(filePath, { id, pageIndex, type: "text", x: p.x, y: p.y, w: 180, fontSize, color, text: "" });
      setTool("select");
      setSelected(id);
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
          const topInset = r.height * 0.16;
          const botInset = r.height * 0.08;
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

  const onPointerMove = (e: React.PointerEvent) => {
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
    if (a.type === "text") return null; // text is rendered as a div, not in the svg
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
              fillOpacity={0.45}
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
    // No selection outline for text (it has its own) or highlights (visual clutter).
    if (!base || base.type === "text" || base.type === "highlight") return null;
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
        {pageAnnos.filter((a) => a.type !== "text").map((a) => renderShape(withDrag(a), false))}
        {draft && draft.type !== "text" && renderShape(draft, true)}
        {selBox}
      </svg>

      {pageAnnos
        .filter((a): a is Extract<Annotation, { type: "text" }> => a.type === "text")
        .map((a) => {
          const d = withDrag(a) as typeof a;
          const selected = a.id === selectedId;
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
                  width: "100%",
                  resize: "none",
                  border: "none",
                  outline: "none",
                  background: "transparent",
                  color: a.color,
                  fontSize: a.fontSize * scale,
                  lineHeight: 1.25,
                  fontFamily: "var(--font-ui)",
                  overflow: "hidden",
                  padding: 0,
                  height: Math.max(a.fontSize * scale * 1.3, (a.text.split("\n").length) * a.fontSize * scale * 1.3),
                }}
              />
            </div>
          );
        })}
    </div>
  );
}
