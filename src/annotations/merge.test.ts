import { describe, expect, it } from "vitest";
import { mergeAnnotationSets, pruneTombstones, TOMBSTONE_TTL_MS, type AnnotationSet } from "./merge";
import type { Annotation } from "./useAnnotations";

/*
 * The merge is the one piece of Nearby where a subtle bug loses work silently — a dropped annotation
 * looks like the user never drew it. These tests are the reason this module is pure and takes `now`
 * as a parameter rather than reading the clock.
 */

/**
 * A fixed "now", with fixture times expressed as seconds before it. Timestamps have to be realistic
 * wall-clock values, not small integers: the merge prunes tombstones by age, so a fixture dated 1970
 * would be discarded as ancient and the test would be asserting the wrong thing.
 */
const NOW = 1_700_000_000_000;
const ago = (seconds: number) => NOW - seconds * 1000;

const note = (id: string, updatedAt: number, extra: Partial<Annotation> = {}): Annotation =>
  ({
    id,
    type: "rect",
    pageIndex: 0,
    color: "#ef4444",
    x: 0,
    y: 0,
    w: 10,
    h: 10,
    strokeWidth: 2,
    filled: false,
    fillOpacity: 0.35,
    updatedAt,
    ...extra,
  }) as Annotation;

const set = (annotations: Annotation[], deleted: Record<string, number> = {}): AnnotationSet => ({
  annotations,
  deleted,
});

const ids = (s: AnnotationSet) => s.annotations.map((a) => a.id).sort();

describe("mergeAnnotationSets", () => {
  it("keeps annotations only one side has", () => {
    const merged = mergeAnnotationSets(set([note("a", ago(60))]), set([note("b", ago(60))]), NOW);
    expect(ids(merged)).toEqual(["a", "b"]);
  });

  it("takes the newer copy when both sides changed the same annotation", () => {
    const merged = mergeAnnotationSets(
      set([note("a", ago(60), { color: "#old" })]),
      set([note("a", ago(30), { color: "#new" })]),
      NOW,
    );
    expect(merged.annotations).toHaveLength(1);
    expect(merged.annotations[0].color).toBe("#new");
  });

  it("keeps the local copy on an exact tie, so the merge is stable", () => {
    const merged = mergeAnnotationSets(
      set([note("a", ago(60), { color: "#local" })]),
      set([note("a", ago(60), { color: "#remote" })]),
      NOW,
    );
    expect(merged.annotations[0].color).toBe("#local");
  });

  it("does not resurrect an annotation the other device deleted", () => {
    // The whole point of tombstones: without one, 'a' is simply "present on my side, absent on
    // theirs" and the union brings it straight back.
    const merged = mergeAnnotationSets(set([note("a", ago(60))]), set([], { a: ago(30) }), NOW);
    expect(ids(merged)).toEqual([]);
    expect(merged.deleted.a).toBe(ago(30));
  });

  it("keeps an annotation that was edited after it was deleted elsewhere", () => {
    const merged = mergeAnnotationSets(set([note("a", ago(10))]), set([], { a: ago(30) }), NOW);
    expect(ids(merged)).toEqual(["a"]);
    // The tombstone is spent — leaving it would delete the annotation again on the next merge.
    expect(merged.deleted.a).toBeUndefined();
  });

  it("lets a delete win a race against an edit at the same instant", () => {
    const merged = mergeAnnotationSets(set([note("a", ago(30))]), set([], { a: ago(30) }), NOW);
    expect(ids(merged)).toEqual([]);
  });

  it("treats annotations with no timestamp as oldest", () => {
    const legacy = note("a", 0);
    delete (legacy as { updatedAt?: number }).updatedAt;
    const merged = mergeAnnotationSets(
      set([legacy]),
      set([note("a", ago(60), { color: "#new" })]),
      NOW,
    );
    expect(merged.annotations[0].color).toBe("#new");
  });

  it("unions tombstones, keeping the later time", () => {
    const merged = mergeAnnotationSets(
      set([], { a: ago(90) }),
      set([], { a: ago(30), b: ago(120) }),
      NOW,
    );
    expect(merged.deleted).toEqual({ a: ago(30), b: ago(120) });
  });

  it("is idempotent — merging twice equals merging once", () => {
    const local = set([note("a", ago(90)), note("b", ago(30))], { c: ago(20) });
    const remote = set([note("b", ago(60)), note("d", ago(10))], { a: ago(45) });
    const once = mergeAnnotationSets(local, remote, NOW);
    const twice = mergeAnnotationSets(once, remote, NOW);
    expect(twice).toEqual(once);
  });

  it("converges regardless of which device merges first", () => {
    const local = set([note("a", ago(90)), note("b", ago(30))], { c: ago(20) });
    const remote = set([note("b", ago(60)), note("d", ago(10))], { a: ago(45) });
    expect(mergeAnnotationSets(local, remote, NOW)).toEqual(
      mergeAnnotationSets(remote, local, NOW),
    );
  });

  it("orders output by page then age, not by insertion", () => {
    const merged = mergeAnnotationSets(
      set([note("z", ago(10), { pageIndex: 1 }), note("y", ago(90), { pageIndex: 0 })]),
      set([note("x", ago(50), { pageIndex: 0 })]),
      NOW,
    );
    expect(merged.annotations.map((a) => a.id)).toEqual(["y", "x", "z"]);
  });

  it("survives empty and missing sides", () => {
    const merged = mergeAnnotationSets(
      set([]),
      { annotations: undefined, deleted: undefined } as unknown as AnnotationSet,
      NOW,
    );
    expect(merged.annotations).toEqual([]);
    expect(merged.deleted).toEqual({});
  });
});

describe("pruneTombstones", () => {
  it("drops entries past the TTL and keeps the rest", () => {
    const now = 1_000_000_000_000;
    const kept = pruneTombstones({ old: now - TOMBSTONE_TTL_MS - 1, fresh: now - 1000 }, now);
    expect(kept).toEqual({ fresh: now - 1000 });
  });

  it("prunes during a merge, so the record cannot grow without bound", () => {
    const now = 1_000_000_000_000;
    const merged = mergeAnnotationSets(
      set([], { ancient: now - TOMBSTONE_TTL_MS - 1 }),
      set([], { recent: now }),
      now,
    );
    expect(Object.keys(merged.deleted)).toEqual(["recent"]);
  });
});
