import { beforeEach, describe, expect, it, vi } from "vitest";

// No Tauri here: the store runs on in-memory state, which is what these tests are about.
vi.mock("@tauri-apps/plugin-store", () => ({ load: () => Promise.reject(new Error("no store")) }));
// Tests run in node; a new note is placed against the window's size.
vi.stubGlobal("window", { innerWidth: 1000, innerHeight: 800 });

const { mergeNotes, placeNew, useNotes } = await import("./useNotes");
type DocNotes = import("./useNotes").DocNotes;

const doc = (at: number, ids: string[]): DocNotes => ({
  at,
  notes: ids.map((id, z) => ({
    id,
    text: id,
    x: 0,
    y: 0,
    w: 240,
    h: 200,
    z,
    folded: false,
    color: "yellow",
  })),
});

describe("mergeNotes", () => {
  it("keeps the more recently changed copy of each document", () => {
    const merged = mergeNotes({ a: doc(1, ["x"]), b: doc(5, ["y"]) }, { a: doc(2, ["x", "z"]), b: doc(3, []) });
    expect(merged.a.notes.map((n) => n.id)).toEqual(["x", "z"]);
    expect(merged.b.notes.map((n) => n.id)).toEqual(["y"]);
  });

  it("lets a deletion win when it is newer", () => {
    expect(mergeNotes({ a: doc(1, ["x"]) }, { a: doc(2, []) }).a.notes).toEqual([]);
  });

  it("keeps documents only one side knows about", () => {
    expect(Object.keys(mergeNotes({ a: doc(1, []) }, { b: doc(1, []) })).sort()).toEqual(["a", "b"]);
  });
});

describe("placeNew", () => {
  it("centres the first note and steps each following one", () => {
    const first = placeNew(0, { w: 1000, h: 800 });
    const second = placeNew(1, { w: 1000, h: 800 });
    expect(first).toEqual({ x: 380, y: 300 });
    expect(second.x - first.x).toBe(24);
    expect(second.y - first.y).toBe(24);
  });

  it("never places a note off the top-left of a tiny window", () => {
    expect(placeNew(0, { w: 100, h: 100 })).toEqual({ x: 8, y: 8 });
  });
});

describe("useNotes", () => {
  beforeEach(() => useNotes.setState({ byDoc: {}, fresh: null }));
  const notes = (key: string) => useNotes.getState().byDoc[key]?.notes ?? [];

  it("keeps each document's notes apart", () => {
    useNotes.getState().add("a");
    useNotes.getState().add("a");
    useNotes.getState().add("b");
    expect(notes("a")).toHaveLength(2);
    expect(notes("b")).toHaveLength(1);
  });

  it("marks a new note fresh so its pane can focus it", () => {
    useNotes.getState().add("a");
    expect(useNotes.getState().fresh).toBe(notes("a")[0].id);
  });

  it("updates, raises and removes", () => {
    const s = useNotes.getState();
    s.add("a");
    s.add("a");
    const [first, second] = notes("a");
    expect(second.z).toBeGreaterThan(first.z);

    s.update("a", first.id, { text: "hello" });
    expect(notes("a").find((n) => n.id === first.id)?.text).toBe("hello");

    s.raise("a", first.id);
    const raised = notes("a").find((n) => n.id === first.id)!;
    expect(raised.z).toBeGreaterThan(second.z);

    s.remove("a", first.id);
    expect(notes("a").map((n) => n.id)).toEqual([second.id]);
  });

});
