import { PDFDocument, degrees } from "pdf-lib";

/**
 * The page list as the viewer sees it — Bode's staged model for page edits.
 *
 * Removing or reordering pages rewrites this manifest instead of the file: the document on disk
 * is untouched until Save, which replays the manifest with pdf-lib. This mirrors how annotations
 * already work (overlay now, flattened on export), so page edits stay reversible and cheap.
 *
 * Two page-numbering spaces exist once a manifest diverges from its source, and mixing them up is
 * the main hazard here:
 *   - **visible** — position in this list. What the viewer, page counter, thumbnails and
 *     annotations all use. `numPages` in the store is the manifest length.
 *   - **source** — `srcPage`, the page's original 1-based number in the PDF.js document, used
 *     only to render and to copy pages on save.
 */
export type PageRef = {
  /** Stable across reorders, so thumbnails and selections can key off it. */
  id: string;
  /** 1-based page number in the source document. */
  srcPage: number;
  /** Extra clockwise rotation to apply on top of the page's own /Rotate. */
  rotation: 0 | 90 | 180 | 270;
};

const newPageId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `p_${Date.now()}_${Math.random().toString(36).slice(2)}`;

/** The identity manifest: every source page, in order, unrotated. */
export const initialManifest = (numPages: number): PageRef[] =>
  Array.from({ length: numPages }, (_, i) => ({
    id: newPageId(),
    srcPage: i + 1,
    rotation: 0 as const,
  }));

/** True when the manifest still describes the source exactly, so Save has no page work to do. */
export const isPristine = (pages: PageRef[], srcPageCount: number): boolean =>
  pages.length === srcPageCount &&
  pages.every((p, i) => p.srcPage === i + 1 && p.rotation === 0);

export const removeIds = (pages: PageRef[], ids: ReadonlySet<string>): PageRef[] =>
  pages.filter((p) => !ids.has(p.id));

/**
 * Move every page in `ids` to `toIndex`, preserving the moved pages' relative order.
 *
 * `toIndex` is a *gap* index in the current list: 0 is above the first page, `pages.length` is
 * below the last. Gaps shift once the dragged pages are lifted out, so pages above the gap are
 * discounted first — otherwise dragging downwards lands one slot short.
 */
export function movePages(
  pages: PageRef[],
  ids: ReadonlySet<string>,
  toIndex: number
): PageRef[] {
  const moving = pages.filter((p) => ids.has(p.id));
  if (moving.length === 0) return pages;
  const liftedAbove = pages.slice(0, toIndex).filter((p) => ids.has(p.id)).length;
  const rest = pages.filter((p) => !ids.has(p.id));
  const at = Math.max(0, Math.min(toIndex - liftedAbove, rest.length));
  return [...rest.slice(0, at), ...moving, ...rest.slice(at)];
}

/**
 * Old visible index → new visible index (both 0-based) for every page that survived an edit,
 * matched by id. Annotations live in visible space, so they ride through this on every edit;
 * anything missing from the result belonged to a removed page.
 */
export function indexRemap(before: PageRef[], after: PageRef[]): Map<number, number> {
  const nowAt = new Map(after.map((p, i) => [p.id, i]));
  const map = new Map<number, number>();
  before.forEach((p, i) => {
    const to = nowAt.get(p.id);
    if (to !== undefined) map.set(i, to);
  });
  return map;
}

/**
 * Source page index → visible page index (both 0-based), for mapping things PDF.js reports in
 * source space — search hits, outline destinations, link targets — into what the viewer shows.
 * A page that appears more than once resolves to its first occurrence.
 */
export function sourceToVisible(pages: PageRef[]): Map<number, number> {
  const map = new Map<number, number>();
  pages.forEach((p, i) => {
    if (!map.has(p.srcPage - 1)) map.set(p.srcPage - 1, i);
  });
  return map;
}

/**
 * Rebuild `source` with its pages in manifest order, dropping removed ones. Returns a fresh
 * document for the caller to flatten annotations onto and serialize.
 *
 * Because the output page order *is* the manifest order, annotation page indexes (already in
 * visible space) line up with the result without further mapping.
 */
export async function applyManifest(
  source: PDFDocument,
  pages: PageRef[]
): Promise<PDFDocument> {
  const out = await PDFDocument.create();
  const copied = await out.copyPages(
    source,
    pages.map((p) => p.srcPage - 1)
  );
  copied.forEach((page, i) => {
    const extra = pages[i].rotation;
    if (extra) page.setRotation(degrees((page.getRotation().angle + extra) % 360));
    out.addPage(page);
  });
  return out;
}
