import type { Annotation } from "./useAnnotations";

/*
 * Merging one document's annotations from two devices.
 *
 * Annotations already carry UUIDs, which is what makes this tractable without a CRDT or an operation
 * log: identity is stable across devices, so a merge is a union by id rather than a diff of two
 * lists that happen to look similar. Each side is a set of annotations plus a set of tombstones, and
 * everything reduces to comparing two timestamps.
 *
 * What this deliberately does NOT attempt: real-time collaboration, merging two edits to the same
 * pen stroke, or vector clocks. Two devices editing the same annotation while disconnected resolves
 * last-write-wins. For a reader that is the right trade — the case that actually happens is two
 * devices editing DIFFERENT annotations, and that case loses nothing.
 */

export interface AnnotationSet {
  annotations: Annotation[];
  /** Annotation id → when it was deleted. */
  deleted: Record<string, number>;
}

/**
 * How long a tombstone is kept. Long enough that a device left in a drawer for a season still learns
 * about deletions when it comes back; short enough that the record does not grow without bound.
 */
export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** A missing timestamp is data from before sync existed, so it sorts oldest and loses every race. */
const stamp = (a: Annotation): number => a.updatedAt ?? 0;

/**
 * Union by id. Where both sides have an annotation, the later `updatedAt` wins; where a tombstone is
 * at least as new as the annotation, it stays deleted.
 *
 * The tie-break on equal timestamps is `local`, which matters more than it looks: it makes the
 * function deterministic, so merging twice gives the same answer as merging once, and two devices
 * that sync in either order converge instead of flip-flopping.
 */
export function mergeAnnotationSets(
  local: AnnotationSet,
  remote: AnnotationSet,
  now: number = Date.now(),
): AnnotationSet {
  const deleted: Record<string, number> = {};
  for (const [id, at] of Object.entries(local.deleted ?? {})) deleted[id] = at;
  for (const [id, at] of Object.entries(remote.deleted ?? {})) {
    deleted[id] = Math.max(deleted[id] ?? 0, at);
  }

  const byId = new Map<string, Annotation>();
  for (const a of local.annotations ?? []) byId.set(a.id, a);
  for (const a of remote.annotations ?? []) {
    const mine = byId.get(a.id);
    // Strictly greater, so an equal timestamp keeps the local copy and the merge stays stable.
    if (!mine || stamp(a) > stamp(mine)) byId.set(a.id, a);
  }

  const annotations: Annotation[] = [];
  for (const a of byId.values()) {
    const tombstone = deleted[a.id];
    // `>=` because a delete that races an edit should win: the user's last visible intent was for
    // the annotation to be gone, and resurrecting it is the more surprising outcome.
    if (tombstone !== undefined && tombstone >= stamp(a)) continue;
    annotations.push(a);
  }

  // A tombstone whose annotation came back (edited after the delete) has done its job and would
  // otherwise sit there re-deleting it on some future merge.
  for (const id of Object.keys(deleted)) {
    const alive = byId.get(id);
    if (alive && stamp(alive) > deleted[id]) delete deleted[id];
  }

  return {
    annotations: sortForRender(annotations),
    deleted: pruneTombstones(deleted, now),
  };
}

/** Drop tombstones past the TTL. Anything that old has been seen by every device that will ever see it. */
export function pruneTombstones(
  deleted: Record<string, number>,
  now: number = Date.now(),
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, at] of Object.entries(deleted)) {
    if (now - at < TOMBSTONE_TTL_MS) out[id] = at;
  }
  return out;
}

/**
 * Stable render order: by page, then by age. A Map's insertion order would otherwise leak into the
 * z-order, so the same two annotations could stack differently on two devices.
 */
function sortForRender(annotations: Annotation[]): Annotation[] {
  return [...annotations].sort(
    (a, b) => a.pageIndex - b.pageIndex || stamp(a) - stamp(b) || a.id.localeCompare(b.id),
  );
}
