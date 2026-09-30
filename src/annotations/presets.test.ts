import { describe, expect, it } from "vitest";
import { upgradePresets } from "./useAnnotations";

describe("upgradePresets", () => {
  it("moves presets still on the old pastel defaults to the brighter ones", () => {
    expect(upgradePresets(["#fff59d", "#a7f3d0", "#a8dfff"])).toEqual(["#ffe135", "#5cf28c", "#4fc3ff"]);
  });

  it("keeps colours the reader picked, including an old default moved to another slot", () => {
    expect(upgradePresets(["#ff0000", "#A7F3D0", "#fff59d"])).toEqual(["#ff0000", "#5cf28c", "#fff59d"]);
  });

  it("falls back to the defaults for a missing or malformed list", () => {
    expect(upgradePresets(undefined)).toEqual(["#ffe135", "#5cf28c", "#4fc3ff"]);
    expect(upgradePresets(["#000000"])).toEqual(["#ffe135", "#5cf28c", "#4fc3ff"]);
  });
});
