import { describe, expect, it } from "vitest";
import { detectSlots, slotKey, type PathRect, type TextBox } from "./detectFields";

/*
 * The flat-form heuristics.
 *
 * These are guesses by construction, so what is worth pinning down is not "does it find every
 * blank" — it will not — but the two things that make the feature usable rather than annoying:
 * the shapes people actually write blanks with are found, and the page furniture that merely
 * looks like a blank is left alone.
 *
 * Coordinates are display space: points at scale 1, top-left origin, y down. A4-ish page.
 */

const PAGE = { w: 612, h: 792 };

const text = (str: string, x: number, y: number, w: number, h = 10): TextBox => ({ str, x, y, w, h });
const path = (x: number, y: number, w: number, h: number): PathRect => ({ x, y, w, h });

describe("slot keys", () => {
  it("is stable across repeated detection of the same spot", () => {
    const rect = { x: 10, y: 20, w: 30, h: 40 };
    expect(slotKey(0, rect)).toBe(slotKey(0, { ...rect }));
  });

  it("separates slots that differ only by page, position or size", () => {
    const rect = { x: 10, y: 20, w: 30, h: 40 };
    const keys = new Set([
      slotKey(0, rect),
      slotKey(1, rect),
      slotKey(0, { ...rect, x: 11 }),
      slotKey(0, { ...rect, w: 31 }),
    ]);
    expect(keys.size).toBe(4);
  });
});

describe("detectSlots", () => {
  it("finds an underscore blank after a label", () => {
    const slots = detectSlots([text("Name: ____________", 72, 100, 180)], [], PAGE, 0);
    expect(slots).toHaveLength(1);
    expect(slots[0].source).toBe("leader");
    // The blank starts after "Name: ", not at the label.
    expect(slots[0].rect.x).toBeGreaterThan(100);
    expect(slots[0].rect.w).toBeGreaterThan(24);
  });

  it("labels a blank with the text that precedes it", () => {
    const slots = detectSlots(
      [text("Date of birth:", 72, 200, 70), text("__________", 150, 200, 60)],
      [],
      PAGE,
      0,
    );
    expect(slots).toHaveLength(1);
    expect(slots[0].label).toBe("Date of birth");
  });

  it("ignores a short run of punctuation", () => {
    // An ellipsis and a two-character rule are writing, not a blank.
    expect(detectSlots([text("wait... really", 72, 100, 90)], [], PAGE, 0)).toHaveLength(0);
    expect(detectSlots([text("a__b", 72, 100, 40)], [], PAGE, 0)).toHaveLength(0);
  });

  it("finds the gap left after a label with a colon", () => {
    const slots = detectSlots([text("Signature:", 72, 300, 60)], [], PAGE, 0);
    expect(slots).toHaveLength(1);
    expect(slots[0].source).toBe("gap");
    expect(slots[0].rect.x).toBeGreaterThanOrEqual(132);
  });

  it("does not propose a gap when the line is already full", () => {
    const slots = detectSlots(
      [text("Total:", 72, 300, 40), text("$1,240.00", 118, 300, 60)],
      [],
      PAGE,
      0,
    );
    expect(slots).toHaveLength(0);
  });

  it("finds a ruled line to write on, above the rule", () => {
    const slots = detectSlots([], [path(72, 400, 200, 1)], PAGE, 0);
    expect(slots).toHaveLength(1);
    expect(slots[0].source).toBe("rule");
    // The slot sits on the rule, so its bottom edge is the rule's top edge.
    expect(slots[0].rect.y + slots[0].rect.h).toBeCloseTo(400, 5);
  });

  it("rejects a rule that spans the page as a divider", () => {
    expect(detectSlots([], [path(40, 400, 532, 1)], PAGE, 0)).toHaveLength(0);
  });

  it("rejects a rule that is underlining a heading", () => {
    const heading = text("Part 1 — Your details", 72, 388, 160, 11);
    const underline = path(72, 400, 160, 1);
    expect(detectSlots([heading], [underline], PAGE, 0)).toHaveLength(0);
  });

  it("finds an empty drawn box but not one with text in it", () => {
    const empty = detectSlots([], [path(72, 500, 200, 18)], PAGE, 0);
    expect(empty).toHaveLength(1);
    expect(empty[0].source).toBe("box");

    const filled = detectSlots([text("already printed", 76, 503, 90)], [path(72, 500, 200, 18)], PAGE, 0);
    expect(filled).toHaveLength(0);
  });

  it("calls a small square a tick box", () => {
    const slots = detectSlots([], [path(72, 600, 12, 12)], PAGE, 0);
    expect(slots).toHaveLength(1);
    expect(slots[0].kind).toBe("checkbox");
  });

  it("ignores panels and regions that are too tall to be a field", () => {
    expect(detectSlots([], [path(72, 500, 300, 200)], PAGE, 0)).toHaveLength(0);
  });

  it("merges a ruled line with the label gap that sits on it", () => {
    // "Name:" leaves a gap, and a rule is drawn under that same gap. One blank, not two.
    const slots = detectSlots([text("Name:", 72, 396, 40, 11)], [path(115, 408, 200, 1)], PAGE, 0);
    expect(slots).toHaveLength(1);
  });

  it("drops anything that falls outside the page", () => {
    expect(detectSlots([], [path(-50, 400, 200, 1)], PAGE, 0)).toHaveLength(0);
    expect(detectSlots([], [path(72, 900, 200, 1)], PAGE, 0)).toHaveLength(0);
  });

  it("returns slots in reading order", () => {
    const slots = detectSlots(
      [text("B: ______", 72, 300, 90), text("A: ______", 72, 100, 90)],
      [],
      PAGE,
      0,
    );
    expect(slots.map((s) => s.rect.y)).toEqual([...slots.map((s) => s.rect.y)].sort((a, b) => a - b));
  });
});
