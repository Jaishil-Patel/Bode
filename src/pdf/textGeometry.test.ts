import { describe, expect, it } from "vitest";
import {
  allOf,
  boundsOf,
  caretRect,
  hitTest,
  order,
  rangeRects,
  rangeText,
  wordAt,
  type PageGeom,
  type Rect,
  type SpanGeom,
} from "./textGeometry";

/*
 * These run without a DOM: `buildPageGeom` is the only part that measures anything, and everything
 * downstream of it is arithmetic over the struct it produces. So the fixtures below hand-build that
 * struct with evenly spaced characters, which keeps every expected coordinate something you can
 * verify by reading it rather than by trusting a font metric.
 */

/**
 * Prefix ratios live in a Float32Array, so a coordinate that is exact in the fixture comes back a
 * few millionths off. Round before comparing rather than reaching for toBeCloseTo on every field.
 */
const round = <T extends Rect | null>(r: T): T =>
  (r && {
    x: Math.round(r.x * 1e4) / 1e4,
    y: Math.round(r.y * 1e4) / 1e4,
    w: Math.round(r.w * 1e4) / 1e4,
    h: Math.round(r.h * 1e4) / 1e4,
  }) as T;

const rounded = (rects: Rect[]) => rects.map((r) => round(r));

/** A span whose characters are all the same width, so prefix ratios are i/len. */
const span = (text: string, x: number, y: number, w: number, h = 10, line = 0): SpanGeom => {
  const prefix = new Float32Array(text.length + 1);
  for (let i = 0; i <= text.length; i++) prefix[i] = i / text.length;
  return { text, x, y, w, h, line, prefix, rotated: false };
};

/** Two lines: "Hello" + "World" on the first, "Second" on the next. */
const geom = (): PageGeom => {
  const spans = [
    span("Hello", 0, 0, 50), // chars 10 wide
    span("World", 60, 0, 50),
    span("Second", 0, 20, 60, 10, 1),
  ];
  return { scale: 1, spans, lines: [[0, 1], [2]], first: null };
};

describe("order", () => {
  it("leaves a forward pair alone and flips a backward one", () => {
    const a = { span: 0, ch: 1 };
    const b = { span: 1, ch: 2 };
    expect(order(a, b)).toEqual([a, b]);
    expect(order(b, a)).toEqual([a, b]);
  });

  it("orders within a single span by character", () => {
    expect(order({ span: 0, ch: 4 }, { span: 0, ch: 2 })).toEqual([
      { span: 0, ch: 2 },
      { span: 0, ch: 4 },
    ]);
  });
});

describe("hitTest", () => {
  const g = geom();

  it("snaps to the nearest character boundary, not always the one before", () => {
    // Character 0 spans x 0..10, so its midpoint is the boundary between ch 0 and ch 1.
    expect(hitTest(g, 4, 5)).toEqual({ span: 0, ch: 0 });
    expect(hitTest(g, 6, 5)).toEqual({ span: 0, ch: 1 });
    expect(hitTest(g, 25, 5)).toEqual({ span: 0, ch: 2 });
  });

  it("clamps to the start of a line when left of it", () => {
    expect(hitTest(g, -40, 5)).toEqual({ span: 0, ch: 0 });
  });

  it("clamps to the end of a line when right of it", () => {
    expect(hitTest(g, 500, 5)).toEqual({ span: 1, ch: 5 });
  });

  it("picks the vertically nearest line when the point is off the text", () => {
    // Well below everything: should land on the second line, not the first.
    expect(hitTest(g, 0, 400)?.span).toBe(2);
    // Well above everything: the first.
    expect(hitTest(g, 0, -400)?.span).toBe(0);
  });

  it("lands in the gap between two spans on the nearer of them", () => {
    // The gap runs x 50..60; 52 is nearer Hello's end than World's start.
    expect(hitTest(g, 52, 5)).toEqual({ span: 0, ch: 5 });
    expect(hitTest(g, 58, 5)).toEqual({ span: 1, ch: 0 });
  });

  it("gives a rotated span whole-span granularity", () => {
    const rot: PageGeom = {
      scale: 1,
      spans: [{ ...span("slanted", 0, 0, 70), rotated: true }],
      lines: [[0]],
      first: null,
    };
    expect(hitTest(rot, 10, 5)).toEqual({ span: 0, ch: 0 });
    expect(hitTest(rot, 60, 5)).toEqual({ span: 0, ch: 7 });
  });

  it("returns null for an empty page", () => {
    expect(hitTest({ scale: 1, spans: [], lines: [], first: null }, 0, 0)).toBeNull();
  });
});

describe("rangeRects", () => {
  const g = geom();

  it("covers part of a single span", () => {
    expect(rounded(rangeRects(g, { span: 0, ch: 1 }, { span: 0, ch: 3 }))).toEqual([
      { x: 10, y: 0, w: 20, h: 10 },
    ]);
  });

  it("emits one rect per span across a multi-span selection", () => {
    expect(rounded(rangeRects(g, { span: 0, ch: 3 }, { span: 1, ch: 2 }))).toEqual([
      { x: 30, y: 0, w: 20, h: 10 }, // tail of Hello
      { x: 60, y: 0, w: 20, h: 10 }, // head of World
    ]);
  });

  it("spans lines, giving the middle span in full", () => {
    const rects = rangeRects(g, { span: 0, ch: 4 }, { span: 2, ch: 3 });
    expect(rounded(rects)).toEqual([
      { x: 40, y: 0, w: 10, h: 10 },
      { x: 60, y: 0, w: 50, h: 10 },
      { x: 0, y: 20, w: 30, h: 10 },
    ]);
  });

  it("is unaffected by the drag direction", () => {
    const fwd = rangeRects(g, { span: 0, ch: 1 }, { span: 1, ch: 4 });
    const back = rangeRects(g, { span: 1, ch: 4 }, { span: 0, ch: 1 });
    expect(back).toEqual(fwd);
    expect(fwd).toHaveLength(2);
  });

  it("yields nothing for a collapsed selection", () => {
    expect(rangeRects(g, { span: 0, ch: 2 }, { span: 0, ch: 2 })).toEqual([]);
  });
});

describe("rangeText", () => {
  const g = geom();

  it("returns the slice within one span", () => {
    expect(rangeText(g, { span: 0, ch: 1 }, { span: 0, ch: 4 })).toBe("ell");
  });

  it("puts a space in the gap between spans on a line", () => {
    // Gap is 10 wide against a 10pt line height, comfortably over the 0.2 threshold.
    expect(rangeText(g, { span: 0, ch: 0 }, { span: 1, ch: 5 })).toBe("Hello World");
  });

  it("breaks the line between spans on different lines", () => {
    expect(rangeText(g, { span: 1, ch: 0 }, { span: 2, ch: 6 })).toBe("World\nSecond");
  });

  it("reads the same dragged backwards", () => {
    expect(rangeText(g, { span: 1, ch: 5 }, { span: 0, ch: 0 })).toBe("Hello World");
  });
});

describe("caretRect", () => {
  it("is a zero-width rect at the character boundary", () => {
    expect(round(caretRect(geom(), { span: 0, ch: 2 }))).toEqual({ x: 20, y: 0, w: 0, h: 10 });
  });

  it("sits at the far edge at the end of a span", () => {
    expect(round(caretRect(geom(), { span: 0, ch: 5 }))).toEqual({ x: 50, y: 0, w: 0, h: 10 });
  });

  it("is null for a span that no longer exists", () => {
    expect(caretRect(geom(), { span: 99, ch: 0 })).toBeNull();
  });
});

describe("wordAt", () => {
  const g: PageGeom = {
    scale: 1,
    spans: [span("one two", 0, 0, 70)],
    lines: [[0]],
    first: null,
  };

  it("expands to the word under the caret", () => {
    expect(wordAt(g, { span: 0, ch: 1 })).toEqual([
      { span: 0, ch: 0 },
      { span: 0, ch: 3 },
    ]);
    expect(wordAt(g, { span: 0, ch: 5 })).toEqual([
      { span: 0, ch: 4 },
      { span: 0, ch: 7 },
    ]);
  });

  it("prefers the word to the left when the caret is on a boundary", () => {
    // ch 3 sits between "one" and the space, so it takes "one" rather than selecting nothing.
    expect(wordAt(g, { span: 0, ch: 3 })).toEqual([
      { span: 0, ch: 0 },
      { span: 0, ch: 3 },
    ]);
  });

  it("takes the whole of a rotated span", () => {
    const rot: PageGeom = {
      scale: 1,
      spans: [{ ...span("one two", 0, 0, 70), rotated: true }],
      lines: [[0]],
      first: null,
    };
    expect(wordAt(rot, { span: 0, ch: 2 })).toEqual([
      { span: 0, ch: 0 },
      { span: 0, ch: 7 },
    ]);
  });
});

describe("allOf", () => {
  it("runs from the first character to the last", () => {
    expect(allOf(geom())).toEqual([
      { span: 0, ch: 0 },
      { span: 2, ch: 6 },
    ]);
  });

  it("is null for a page with no text", () => {
    expect(allOf({ scale: 1, spans: [], lines: [], first: null })).toBeNull();
  });
});

describe("boundsOf", () => {
  it("unions the rects", () => {
    expect(
      boundsOf([
        { x: 10, y: 0, w: 20, h: 10 },
        { x: 0, y: 20, w: 30, h: 10 },
      ]),
    ).toEqual({ x: 0, y: 0, w: 30, h: 30 });
  });

  it("is null for none", () => {
    expect(boundsOf([])).toBeNull();
  });
});
