import { describe, expect, it } from "vitest";
import {
  duplicateIds,
  indexRemap,
  initialManifest,
  isPristine,
  moveBy,
  movePages,
  rotateIds,
  subsetManifest,
  type PageRef,
} from "./pageOps";

const order = (pages: PageRef[]) => pages.map((p) => p.srcPage);
const idsOf = (pages: PageRef[], ...src: number[]) =>
  new Set(pages.filter((p) => src.includes(p.srcPage)).map((p) => p.id));

describe("movePages", () => {
  const pages = initialManifest(5);

  it("moves a page up to a gap", () => {
    expect(order(movePages(pages, idsOf(pages, 4), 1))).toEqual([1, 4, 2, 3, 5]);
  });

  it("moves a page down without landing one slot short", () => {
    expect(order(movePages(pages, idsOf(pages, 2), 4))).toEqual([1, 3, 4, 2, 5]);
  });

  it("keeps several pages in their relative order", () => {
    expect(order(movePages(pages, idsOf(pages, 1, 3), 5))).toEqual([2, 4, 5, 1, 3]);
  });
});

describe("moveBy", () => {
  const pages = initialManifest(4);

  it("steps a page up and down by one", () => {
    expect(order(moveBy(pages, idsOf(pages, 3), -1))).toEqual([1, 3, 2, 4]);
    expect(order(moveBy(pages, idsOf(pages, 2), 1))).toEqual([1, 3, 2, 4]);
  });

  it("is a no-op at either end", () => {
    expect(moveBy(pages, idsOf(pages, 1), -1)).toBe(pages);
    expect(moveBy(pages, idsOf(pages, 4), 1)).toBe(pages);
  });
});

describe("duplicateIds", () => {
  it("puts each copy after its original with a fresh id", () => {
    const pages = initialManifest(3);
    const next = duplicateIds(pages, idsOf(pages, 2));
    expect(order(next)).toEqual([1, 2, 2, 3]);
    expect(next[2].id).not.toBe(next[1].id);
    expect(isPristine(next, 3)).toBe(false);
  });

  it("lets annotations follow the original, not the copy", () => {
    const pages = initialManifest(3);
    const next = duplicateIds(pages, idsOf(pages, 1));
    expect([...indexRemap(pages, next)]).toEqual([
      [0, 0],
      [1, 2],
      [2, 3],
    ]);
  });
});

describe("rotateIds", () => {
  it("wraps around in both directions", () => {
    const pages = initialManifest(1);
    const ids = idsOf(pages, 1);
    expect(rotateIds(pages, ids, -90)[0].rotation).toBe(270);
    let p = pages;
    for (let i = 0; i < 4; i++) p = rotateIds(p, ids, 90);
    expect(p[0].rotation).toBe(0);
    expect(isPristine(rotateIds(pages, ids, 90), 1)).toBe(false);
  });
});

describe("subsetManifest", () => {
  it("keeps the chosen pages in visible order and remaps their indexes", () => {
    const pages = initialManifest(4);
    const reordered = movePages(pages, idsOf(pages, 4), 0); // 4 1 2 3
    const sub = subsetManifest(reordered, idsOf(reordered, 4, 2));
    expect(order(sub)).toEqual([4, 2]);
    expect([...indexRemap(reordered, sub)]).toEqual([
      [0, 0],
      [2, 1],
    ]);
  });
});
