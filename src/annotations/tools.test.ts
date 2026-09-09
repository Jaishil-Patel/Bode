import { describe, expect, it } from "vitest";
import {
  barTools,
  DEFAULT_TOOL_ORDER,
  menuTools,
  normalizeToolbar,
  TOOLS,
  toolForKey,
} from "./tools";
import type { Tool } from "./useAnnotations";

/*
 * The toolbar's saved order is the one piece of settings that has to survive Bode changing shape
 * underneath it. A saved order is a list of tool names written by whatever version last ran, so it
 * can be missing tools added since and can name tools removed since — and getting either wrong is
 * a tool the user cannot reach and cannot switch back on, because the Settings grid is built from
 * the same list. Hence a pure function, and hence these.
 */

const ids = (list: { id: Tool }[]) => list.map((t) => t.id);

describe("normalizeToolbar", () => {
  it("keeps a complete saved order exactly as it was", () => {
    const saved: Tool[] = [...DEFAULT_TOOL_ORDER].reverse();
    expect(normalizeToolbar(saved, []).order).toEqual(saved);
  });

  it("appends tools the saved order has never heard of", () => {
    // What a settings file written before the form tool existed looks like.
    const saved = DEFAULT_TOOL_ORDER.filter((id) => id !== "form" && id !== "signature");
    const { order } = normalizeToolbar(saved, []);

    expect(order).toHaveLength(TOOLS.length);
    expect(order.slice(0, saved.length)).toEqual(saved); // the user's arrangement is untouched
    expect(order.slice(saved.length).sort()).toEqual(["form", "signature"]); // and the new ones follow
  });

  it("switches new tools on rather than hiding them", () => {
    const saved = DEFAULT_TOOL_ORDER.filter((id) => id !== "form");
    expect(normalizeToolbar(saved, ["pen"]).hidden).toEqual(["pen"]);
  });

  it("drops tools that no longer exist", () => {
    const saved = ["stamp", "select", "lasso"] as unknown as Tool[];
    const { order } = normalizeToolbar(saved, ["stamp"] as unknown as Tool[]);

    expect(order).not.toContain("stamp");
    expect(order).not.toContain("lasso");
    expect(order[0]).toBe("select");
    expect(order).toHaveLength(TOOLS.length);
  });

  it("drops a duplicated id rather than rendering the tool twice", () => {
    const { order } = normalizeToolbar(["pen", "pen", "select"], []);
    expect(order.filter((id) => id === "pen")).toHaveLength(1);
    expect(order).toHaveLength(TOOLS.length);
  });

  it("falls back to the shipped order when nothing is saved", () => {
    expect(normalizeToolbar(undefined, undefined)).toEqual({ order: DEFAULT_TOOL_ORDER, hidden: [] });
    expect(normalizeToolbar([], []).order).toEqual(DEFAULT_TOOL_ORDER);
  });

  it("reports hidden tools in bar order, whatever order they were saved in", () => {
    const { hidden } = normalizeToolbar(["pen", "select", "text"], ["text", "pen"]);
    expect(hidden).toEqual(["pen", "text"]);
  });

  it("is idempotent", () => {
    const once = normalizeToolbar(["form", "pen"], ["pen"]);
    expect(normalizeToolbar(once.order, once.hidden)).toEqual(once);
  });
});

describe("barTools / menuTools", () => {
  const layout = normalizeToolbar(DEFAULT_TOOL_ORDER, ["eraser", "form"]);

  it("shows what is switched on, in the saved order", () => {
    expect(ids(barTools(layout, "select"))).toEqual(
      DEFAULT_TOOL_ORDER.filter((id) => id !== "eraser" && id !== "form"),
    );
  });

  it("shows a switched-off tool while it is the active one", () => {
    // Picking the eraser out of the More menu has to visibly do something to the bar.
    const shown = ids(barTools(layout, "eraser"));
    expect(shown).toContain("eraser");
    expect(shown).not.toContain("form");
    // In its own place, not appended: it still sits where the saved order puts it.
    const expected = DEFAULT_TOOL_ORDER.filter((id) => id !== "form").indexOf("eraser");
    expect(shown.indexOf("eraser")).toBe(expected);
    expect(shown.indexOf("eraser")).toBeLessThan(shown.length - 1);
  });

  it("offers the rest in the More menu, minus whatever the bar is already showing", () => {
    expect(ids(menuTools(layout, "select"))).toEqual(["eraser", "form"]);
    expect(ids(menuTools(layout, "eraser"))).toEqual(["form"]);
  });

  it("leaves the menu empty when nothing is switched off", () => {
    expect(menuTools(normalizeToolbar(DEFAULT_TOOL_ORDER, []), "select")).toEqual([]);
  });

  it("never loses a tool between the bar and the menu", () => {
    for (const active of DEFAULT_TOOL_ORDER) {
      const total = barTools(layout, active).length + menuTools(layout, active).length;
      expect(total).toBe(TOOLS.length);
    }
  });
});

describe("the registry itself", () => {
  it("gives every tool a distinct shortcut key", () => {
    expect(new Set(TOOLS.map((t) => t.key)).size).toBe(TOOLS.length);
  });

  it("looks a tool up by key regardless of case", () => {
    expect(toolForKey("H")?.id).toBe("highlight");
    expect(toolForKey("h")?.id).toBe("highlight");
    expect(toolForKey("9")).toBeUndefined();
  });

  it("names every tool briefly enough to sit under an icon", () => {
    for (const t of TOOLS) expect(t.name.length).toBeLessThanOrEqual(9);
  });
});
