import { describe, expect, it } from "vitest";
import { rotateAnnotation } from "./rotate";
import type { Annotation } from "./useAnnotations";

// A portrait page: 600 wide, 800 tall. After a quarter turn it is 800 wide, 600 tall.
const W = 600;
const H = 800;

const base = { id: "a", pageIndex: 0, color: "#000" };

/** Turn four times, swapping the page size each time, as the viewer would. */
function fullCircle(a: Annotation, delta: 90 | -90): Annotation {
  let out = a;
  let [w, h] = [W, H];
  for (let i = 0; i < 4; i++) {
    out = rotateAnnotation(out, w, h, delta);
    [w, h] = [h, w];
  }
  return out;
}

describe("rotateAnnotation", () => {
  it("carries the top-left corner to the top-right on a clockwise turn", () => {
    const pen = { ...base, type: "pen", strokeWidth: 2, points: [{ x: 0, y: 0 }] } as Annotation;
    const out = rotateAnnotation(pen, W, H, 90);
    expect(out.type === "pen" && out.points[0]).toEqual({ x: H, y: 0 });
  });

  it("carries the top-left corner to the bottom-left on a counter-clockwise turn", () => {
    const pen = { ...base, type: "pen", strokeWidth: 2, points: [{ x: 0, y: 0 }] } as Annotation;
    const out = rotateAnnotation(pen, W, H, -90);
    expect(out.type === "pen" && out.points[0]).toEqual({ x: 0, y: W });
  });

  it("swaps a shape's width and height and keeps it on the page", () => {
    const rect = {
      ...base,
      type: "rect",
      x: 10,
      y: 20,
      w: 100,
      h: 50,
      strokeWidth: 1,
      filled: false,
      fillOpacity: 0,
    } as Annotation;
    const out = rotateAnnotation(rect, W, H, 90);
    expect(out).toMatchObject({ x: H - 70, y: 10, w: 50, h: 100 });
  });

  it("keeps a line's direction", () => {
    const line = { ...base, type: "line", x: 0, y: 0, w: 100, h: 0, strokeWidth: 1 } as Annotation;
    const out = rotateAnnotation(line, W, H, 90);
    // Left-to-right along the top becomes top-to-bottom down the right edge.
    expect(out).toMatchObject({ x: H, y: 0, w: 0, h: 100 });
  });

  it("moves a text box but keeps it upright", () => {
    const text = { ...base, type: "text", x: 0, y: 0, w: 200, h: 40, fontSize: 12, text: "hi" } as Annotation;
    const out = rotateAnnotation(text, W, H, 90);
    expect(out).toMatchObject({ w: 200, h: 40 });
    // Centre (100, 20) turns to (780, 100).
    expect(out).toMatchObject({ x: 680, y: 80 });
  });

  it("returns every kind to where it started after four turns either way", () => {
    const annos: Annotation[] = [
      { ...base, type: "highlight", rects: [{ x: 5, y: 6, w: 70, h: 12 }] } as Annotation,
      { ...base, type: "arrow", x: 50, y: 60, w: -30, h: 40, strokeWidth: 2 } as Annotation,
      { ...base, type: "pen", strokeWidth: 2, points: [{ x: 1, y: 2 }, { x: 300, y: 700 }] } as Annotation,
      { ...base, type: "signature", x: 40, y: 500, w: 120, h: 40, dataUrl: "" } as Annotation,
      { ...base, type: "text", x: 40, y: 50, w: 120, fontSize: 10, text: "x" } as Annotation,
    ];
    for (const a of annos) {
      expect(fullCircle(a, 90)).toEqual(a);
      expect(fullCircle(a, -90)).toEqual(a);
    }
  });
});
