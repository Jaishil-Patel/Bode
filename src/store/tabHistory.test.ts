import { describe, expect, it } from "vitest";
import { stepIndex, switchOrder, touch } from "./tabHistory";

describe("touch", () => {
  it("moves a tab to the front without duplicating it", () => {
    expect(touch(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
    expect(touch([], "a")).toEqual(["a"]);
  });
});

describe("switchOrder", () => {
  it("puts recently used tabs first, then unvisited ones in strip order", () => {
    expect(switchOrder(["c", "a"], ["a", "b", "c", "d"])).toEqual(["c", "a", "b", "d"]);
  });

  it("drops tabs that have been closed", () => {
    expect(switchOrder(["x", "b", "a"], ["a", "b"])).toEqual(["b", "a"]);
  });
});

describe("stepIndex", () => {
  it("wraps both ways", () => {
    expect(stepIndex(2, 1, 3)).toBe(0);
    expect(stepIndex(0, -1, 3)).toBe(2);
    expect(stepIndex(1, 1, 3)).toBe(2);
  });
});
