/*
 * Annotation work driven from outside a page's own layer — the right-click menu, which has a text
 * selection and a point on screen but none of the per-page state the drawing layer keeps.
 */
import { useViewer } from "../store/viewerStore";
import { insetLine } from "./AnnotationLayer";
import {
  newId,
  useAnnotations,
  type Annotation,
  type MarkupAnno,
  type Rect,
} from "./useAnnotations";

export type MarkType = "highlight" | MarkupAnno["type"];

/**
 * The selection's line boxes, per page, in unzoomed page points — the same measurements the
 * drawing layer takes when a selection is made with a marking tool, so a mark made from the menu
 * lands exactly where one made by the tool would.
 */
export function selectionRectsByPage(sel: Selection): Map<number, Rect[]> {
  const out = new Map<number, Rect[]>();
  const scale = useViewer.getState().scale;
  const pages = Array.from(document.querySelectorAll<HTMLElement>("[data-page]")).map((el) => ({
    index: Number(el.dataset.page) - 1,
    r: el.getBoundingClientRect(),
  }));
  for (let i = 0; i < sel.rangeCount; i++) {
    for (const r of Array.from(sel.getRangeAt(i).getClientRects())) {
      if (r.width < 1 || r.height < 1) continue;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const page = pages.find(
        (p) => cx >= p.r.left && cx <= p.r.right && cy >= p.r.top && cy <= p.r.bottom,
      );
      if (!page) continue;
      const rects = out.get(page.index) ?? [];
      rects.push({
        x: (r.left - page.r.left) / scale,
        y: (r.top - page.r.top) / scale,
        w: r.width / scale,
        h: r.height / scale,
      });
      out.set(page.index, rects);
    }
  }
  return out;
}

/** Mark the current text selection on every page it covers. Returns whether anything was marked. */
export function markSelection(docKey: string, type: MarkType, color: string): boolean {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return false;
  const { add, markWeight } = useAnnotations.getState();
  let marked = false;
  for (const [pageIndex, rects] of selectionRectsByPage(sel)) {
    add(docKey, {
      id: newId(),
      pageIndex,
      type,
      color,
      ...(type === "highlight" ? null : { weight: markWeight }),
      // Only a highlight is inset, as with the tool: a line is drawn at an edge of the line box.
      rects: type === "highlight" ? rects.map(insetLine) : rects,
    } as Annotation);
    marked = true;
  }
  if (marked) sel.removeAllRanges();
  return marked;
}

/** An annotation's bounding box in page points, for finding what is under the pointer. */
function bounds(a: Annotation): Rect[] {
  switch (a.type) {
    case "highlight":
    case "underline":
    case "strikeout":
    case "squiggly":
      return a.rects;
    case "pen": {
      const xs = a.points.map((p) => p.x);
      const ys = a.points.map((p) => p.y);
      const pad = a.strokeWidth / 2 + 3;
      const x = Math.min(...xs) - pad;
      const y = Math.min(...ys) - pad;
      return [{ x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y }];
    }
    case "text": {
      // Auto-height boxes have no stored height: estimate it from the lines they hold.
      const lines = Math.max(1, a.text.split("\n").length);
      return [{ x: a.x, y: a.y, w: a.w, h: Math.max(a.h ?? 0, lines * a.fontSize * 1.3) }];
    }
    default: {
      // Shapes and signatures. A line or arrow can be drawn in any direction, so w/h may be negative.
      const b = a as { x: number; y: number; w: number; h: number };
      const pad = 4;
      return [
        {
          x: Math.min(b.x, b.x + b.w) - pad,
          y: Math.min(b.y, b.y + b.h) - pad,
          w: Math.abs(b.w) + pad * 2,
          h: Math.abs(b.h) + pad * 2,
        },
      ];
    }
  }
}

/** The topmost annotation at a point on a page (in page points), if any. */
export function annotationAt(
  docKey: string,
  pageIndex: number,
  x: number,
  y: number,
): Annotation | null {
  const all = useAnnotations.getState().byFile[docKey] ?? [];
  for (let i = all.length - 1; i >= 0; i--) {
    const a = all[i];
    if (a.pageIndex !== pageIndex) continue;
    if (bounds(a).some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)) return a;
  }
  return null;
}
