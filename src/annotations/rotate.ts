import type { Annotation, Rect } from "./useAnnotations";

/*
 * Turning a page turns the space its annotations are stored in.
 *
 * Geometry lives in display space — PDF points, top-left origin, with the page's rotation already
 * applied — so when a page gains a quarter turn, everything on it has to be carried into the new
 * display space or it would stay put while the page turned underneath it. `w`/`h` below are the
 * page's display size *before* the turn.
 *
 * Drawn geometry (ink, lines, shapes, text marks) turns exactly with the page. Boxes whose content
 * has to stay readable — text and signatures — move with the page but stay upright, the way a
 * sticky note stays upright when you turn the paper it is stuck to.
 */

type Pt = { x: number; y: number };

const turnPoint = (p: Pt, w: number, h: number, delta: 90 | -90): Pt =>
  delta === 90 ? { x: h - p.y, y: p.x } : { x: p.y, y: w - p.x };

const turnRect = (r: Rect, w: number, h: number, delta: 90 | -90): Rect =>
  delta === 90
    ? { x: h - (r.y + r.h), y: r.x, w: r.h, h: r.w }
    : { x: r.y, y: w - (r.x + r.w), w: r.h, h: r.w };

/** Keep a box's size and orientation, and move its centre with the page. */
function carryUpright<T extends Rect>(box: T, w: number, h: number, delta: 90 | -90): T {
  const c = turnPoint({ x: box.x + box.w / 2, y: box.y + box.h / 2 }, w, h, delta);
  return { ...box, x: c.x - box.w / 2, y: c.y - box.h / 2 };
}

export function rotateAnnotation(
  a: Annotation,
  w: number,
  h: number,
  delta: 90 | -90,
): Annotation {
  switch (a.type) {
    case "highlight":
    case "underline":
    case "strikeout":
    case "squiggly":
      return { ...a, rects: a.rects.map((r) => turnRect(r, w, h, delta)) };
    case "rect":
    case "ellipse":
    case "triangle":
      return { ...a, ...turnRect(a, w, h, delta) };
    case "line":
    case "arrow": {
      // (x, y) is where the stroke started and (x + w, y + h) where it ended; keep that direction.
      const s = turnPoint({ x: a.x, y: a.y }, w, h, delta);
      const e = turnPoint({ x: a.x + a.w, y: a.y + a.h }, w, h, delta);
      return { ...a, x: s.x, y: s.y, w: e.x - s.x, h: e.y - s.y };
    }
    case "pen":
      return { ...a, points: a.points.map((p) => turnPoint(p, w, h, delta)) };
    case "text": {
      // An auto-height box has no stored height; its first line is close enough to centre on.
      const boxH = a.h ?? a.fontSize * 1.4;
      const moved = carryUpright({ x: a.x, y: a.y, w: a.w, h: boxH }, w, h, delta);
      return { ...a, x: moved.x, y: moved.y };
    }
    case "signature":
      return carryUpright(a, w, h, delta);
  }
}
