import { create } from "zustand";
import { load, type Store } from "@tauri-apps/plugin-store";
import { mergeAnnotationSets, pruneTombstones, type AnnotationSet } from "./merge";

/*
 * Annotation geometry is stored in PDF points (the page size at scale 1.0) with a
 * top-left origin and y growing downward — the same space PdfPage renders in. To draw
 * at the current zoom, multiply by `scale`; to read pointer coordinates, divide by it.
 * Keeping coordinates scale-independent means annotations stay anchored at any zoom.
 */

export type Tool =
  | "select"
  | "highlight"
  | "text"
  | "rect"
  | "ellipse"
  | "pen"
  | "edit"
  | "signature"
  | "eraser";

interface Base {
  id: string;
  pageIndex: number;
  color: string;
  /**
   * When this annotation was last changed, and by which device. Both are optional because they were
   * added after annotations already existed on disk; `migrate` fills them in so everything loaded
   * from here on carries the shape, but the merge still treats a missing value as "oldest" rather
   * than assuming it is present.
   */
  updatedAt?: number;
  origin?: string;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface HighlightAnno extends Base {
  type: "highlight";
  // One rectangle per selected text line (the highlighted quads).
  rects: Rect[];
}
export interface RectAnno extends Base {
  type: "rect";
  x: number;
  y: number;
  w: number;
  h: number;
  strokeWidth: number;
  filled: boolean;
  fillOpacity: number;
}
export interface EllipseAnno extends Base {
  type: "ellipse";
  x: number;
  y: number;
  w: number;
  h: number;
  strokeWidth: number;
  filled: boolean;
  fillOpacity: number;
}
export interface PenAnno extends Base {
  type: "pen";
  points: { x: number; y: number }[];
  strokeWidth: number;
}
export interface TextAnno extends Base {
  type: "text";
  x: number;
  y: number;
  w: number;
  // Minimum box height in PDF points (the size the user dragged/resized to). The box still
  // grows taller to fit wrapped text. Undefined for click-placed/edit-tool boxes (pure auto-height).
  h?: number;
  fontSize: number;
  text: string;
  // Font family copied from the original text when editing, so the replacement matches.
  // Undefined for free-standing text boxes (they use the UI font).
  fontFamily?: string;
  // For edited text: the original text and its on-page width (PDF points). The export
  // horizontally scales the replacement to fill this width using pdf-lib's metrics, so the
  // saved PDF matches the original width without changing the (already-correct) glyph height.
  fitText?: string;
  fitWidth?: number;
  // Horizontal scale applied on screen so the replacement fills the original width with the
  // substitute font (mirrors pdf.js's per-span scaleX). Keeps glyph HEIGHT equal to the
  // original — fixing the "edited text looks bigger" problem. Undefined/1 for free text boxes.
  scaleX?: number;
}
export interface SignatureAnno extends Base {
  type: "signature";
  x: number;
  y: number;
  w: number;
  h: number;
  dataUrl: string; // trimmed PNG of the drawn signature
}
export type Annotation =
  | HighlightAnno
  | RectAnno
  | EllipseAnno
  | PenAnno
  | TextAnno
  | SignatureAnno;

interface AnnotationState {
  hydrated: boolean;
  byFile: Record<string, Annotation[]>;
  /**
   * Tombstones: doc key → annotation id → when it was deleted. A merge cannot tell "you deleted
   * this" from "I haven't seen it yet" without them, so without this every sync would resurrect
   * everything the other device had ever erased. Pruned after `TOMBSTONE_TTL_MS`.
   */
  deleted: Record<string, Record<string, number>>;
  tool: Tool;
  color: string; // used for text & shapes
  strokeWidth: number;
  fontSize: number;
  fillShapes: boolean; // whether new rect/ellipse shapes are filled
  fillOpacity: number; // 0..1 opacity for shape fills
  highlightPresets: string[]; // exactly 3
  activePreset: number; // 0..2
  selectedId: string | null;
  signatureDataUrl: string | null; // last drawn signature, reused for quick re-placement
  signaturePadOpen: boolean; // transient: whether the draw-a-signature modal is showing
  // Transient: whether the tool-options pill (colour/thickness/fill) is showing. Opens when a
  // tool is picked or an annotation is selected; closes once the tool is used (an annotation added).
  optionsOpen: boolean;

  // Undo/redo history (session-only, not persisted). Each entry is the whole annotation map AND the
  // tombstones before a mutation — they have to move together, or undoing a delete would restore
  // the annotation while leaving the tombstone that tells the next sync to delete it again.
  past: HistoryEntry[];
  future: HistoryEntry[];

  hydrate: () => Promise<void>;
  setTool: (t: Tool) => void;
  setColor: (c: string) => void;
  setStrokeWidth: (w: number) => void;
  setFontSize: (s: number) => void;
  setFillShapes: (v: boolean) => void;
  setFillOpacity: (v: number) => void;
  setHighlightPreset: (i: number, c: string) => void;
  setActivePreset: (i: number) => void;
  setSelected: (id: string | null) => void;
  setSignatureDataUrl: (url: string | null) => void;
  setSignaturePadOpen: (open: boolean) => void;
  setOptionsOpen: (open: boolean) => void;

  add: (file: string, anno: Annotation) => void;
  update: (file: string, id: string, patch: Partial<Annotation>) => void;
  remove: (file: string, id: string) => void;
  clearPage: (file: string, pageIndex: number) => void;
  remapPages: (file: string, map: ReadonlyMap<number, number>) => void;
  undo: () => void;
  redo: () => void;

  /** Fold another device's annotations into ours, for every document at once. */
  mergeAll: (incoming: Record<string, AnnotationSet>) => void;
  /** Replace the whole map, for re-keying from local paths to doc keys. Not undoable. */
  rekeyAll: (
    byFile: Record<string, Annotation[]>,
    deleted: Record<string, Record<string, number>>,
  ) => void;
  /** What to send another device for one document. */
  setFor: (file: string) => AnnotationSet;

  /** Color the active drawing tool should use right now. */
  activeColor: () => string;
}

interface HistoryEntry {
  byFile: Record<string, Annotation[]>;
  deleted: Record<string, Record<string, number>>;
}

const STORE_FILE = "annotations.json";
const STATE_KEY = "state";

let storePromise: Promise<Store> | null = null;
const getStore = () =>
  (storePromise ??= load(STORE_FILE, { autoSave: false, defaults: {} }));

type Persisted = Pick<
  AnnotationState,
  | "byFile"
  | "deleted"
  | "color"
  | "strokeWidth"
  | "fontSize"
  | "fillShapes"
  | "fillOpacity"
  | "highlightPresets"
  | "signatureDataUrl"
>;

const DEFAULT_PRESETS = ["#fde047", "#86efac", "#93c5fd"]; // yellow, green, blue

/**
 * Upgrade annotations saved by older versions to the current shape.
 *
 * `updatedAt` is backfilled here rather than left absent, so that by the time an old file is synced
 * its annotations already sort against a device that has been stamping them all along. They are
 * stamped at 0 — the epoch — because we genuinely do not know when they were made, and claiming
 * "now" would let a decade-old highlight win a merge against a fresh edit.
 */
function migrate(byFile: Record<string, Annotation[]>): Record<string, Annotation[]> {
  const out: Record<string, Annotation[]> = {};
  for (const [file, list] of Object.entries(byFile)) {
    out[file] = (list ?? []).map((a) => {
      let next = a;
      if (next.type === "highlight" && !("rects" in next && Array.isArray(next.rects))) {
        const o = next as unknown as { x: number; y: number; w: number; h: number };
        next = { ...next, rects: [{ x: o.x, y: o.y, w: o.w, h: o.h }] } as Annotation;
      }
      if (next.type === "rect" || next.type === "ellipse") {
        const patch: Partial<RectAnno> = {};
        if (typeof next.filled !== "boolean") patch.filled = false;
        if (typeof next.fillOpacity !== "number") patch.fillOpacity = 0.35;
        if (Object.keys(patch).length) next = { ...next, ...patch } as Annotation;
      }
      if (typeof next.updatedAt !== "number") next = { ...next, updatedAt: 0 } as Annotation;
      return next;
    });
  }
  return out;
}

/** Drop expired tombstones at load, so the record cannot grow across restarts. */
function migrateTombstones(
  deleted: Record<string, Record<string, number>>,
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [file, ids] of Object.entries(deleted ?? {})) {
    const kept = pruneTombstones(ids ?? {});
    if (Object.keys(kept).length) out[file] = kept;
  }
  return out;
}

function snapshot(s: AnnotationState): Persisted {
  return {
    byFile: s.byFile,
    deleted: s.deleted,
    color: s.color,
    strokeWidth: s.strokeWidth,
    fontSize: s.fontSize,
    fillShapes: s.fillShapes,
    fillOpacity: s.fillOpacity,
    highlightPresets: s.highlightPresets,
    signatureDataUrl: s.signatureDataUrl,
  };
}

async function persist(get: () => AnnotationState) {
  try {
    const store = await getStore();
    await store.set(STATE_KEY, snapshot(get()));
    await store.save();
  } catch {
    // best-effort
  }
}

const HISTORY_LIMIT = 100;

export const useAnnotations = create<AnnotationState>((set, get) => {
  const save = () => void persist(get);

  // Capture the current annotation map and tombstones as one undo step, and drop the redo stack.
  const pushHistory = () =>
    set((st) => ({
      past: [...st.past, { byFile: st.byFile, deleted: st.deleted }].slice(-HISTORY_LIMIT),
      future: [],
    }));

  /** Record that `ids` were removed from `file`, so a later merge does not bring them back. */
  const tombstone = (
    deleted: Record<string, Record<string, number>>,
    file: string,
    ids: string[],
    at: number,
  ): Record<string, Record<string, number>> => {
    if (ids.length === 0) return deleted;
    const forFile = { ...(deleted[file] ?? {}) };
    for (const id of ids) forFile[id] = at;
    return { ...deleted, [file]: forFile };
  };

  // Consecutive updates to the same annotation (a drag-resize, or a burst of typing) collapse
  // into a single undo step: only the first one snapshots history.
  let coalesceKey: string | null = null;
  let coalesceAt = 0;

  return {
    hydrated: false,
    byFile: {},
    deleted: {},
    tool: "select",
    color: "#ef4444",
    strokeWidth: 2,
    fontSize: 16,
    fillShapes: false,
    fillOpacity: 0.35,
    highlightPresets: [...DEFAULT_PRESETS],
    activePreset: 0,
    selectedId: null,
    signatureDataUrl: null,
    signaturePadOpen: false,
    optionsOpen: false,
    past: [],
    future: [],

    hydrate: async () => {
      try {
        const store = await getStore();
        const saved = await store.get<Persisted>(STATE_KEY);
        if (saved) {
          set({
            byFile: migrate(saved.byFile ?? {}),
            deleted: migrateTombstones(saved.deleted ?? {}),
            color: saved.color ?? "#ef4444",
            strokeWidth: saved.strokeWidth ?? 2,
            fontSize: saved.fontSize ?? 16,
            fillShapes: saved.fillShapes ?? false,
            fillOpacity: saved.fillOpacity ?? 0.35,
            highlightPresets:
              saved.highlightPresets?.length === 3
                ? saved.highlightPresets
                : [...DEFAULT_PRESETS],
            signatureDataUrl: saved.signatureDataUrl ?? null,
          });
        }
      } catch {
        /* defaults */
      } finally {
        set({ hydrated: true });
      }
    },

    setTool: (t) =>
      set({ tool: t, selectedId: t === "select" ? get().selectedId : null, optionsOpen: true }),
    setColor: (c) => {
      set({ color: c });
      // Recolor the current selection if it isn't a highlight.
      const { selectedId, byFile } = get();
      if (selectedId) {
        for (const [file, list] of Object.entries(byFile)) {
          const a = list.find((x) => x.id === selectedId);
          if (a && a.type !== "highlight") get().update(file, selectedId, { color: c });
        }
      }
      save();
    },
    setStrokeWidth: (w) => {
      set({ strokeWidth: w });
      save();
    },
    setFontSize: (s) => {
      set({ fontSize: s });
      // Resize the selected text box too, so the control edits the box you're looking at.
      const { selectedId, byFile } = get();
      if (selectedId) {
        for (const [file, list] of Object.entries(byFile)) {
          const a = list.find((x) => x.id === selectedId);
          if (a && a.type === "text")
            get().update(file, selectedId, { fontSize: s } as Partial<Annotation>);
        }
      }
      save();
    },
    setFillShapes: (v) => {
      set({ fillShapes: v });
      // Apply to a selected shape too.
      const { selectedId, byFile } = get();
      if (selectedId) {
        for (const [file, list] of Object.entries(byFile)) {
          const a = list.find((x) => x.id === selectedId);
          if (a && (a.type === "rect" || a.type === "ellipse"))
            get().update(file, selectedId, { filled: v } as Partial<Annotation>);
        }
      }
      save();
    },
    setFillOpacity: (v) => {
      set({ fillOpacity: v });
      const { selectedId, byFile } = get();
      if (selectedId) {
        for (const [file, list] of Object.entries(byFile)) {
          const a = list.find((x) => x.id === selectedId);
          if (a && (a.type === "rect" || a.type === "ellipse"))
            get().update(file, selectedId, { fillOpacity: v } as Partial<Annotation>);
        }
      }
      save();
    },
    setHighlightPreset: (i, c) => {
      const next = [...get().highlightPresets];
      next[i] = c;
      set({ highlightPresets: next });
      // Recolor a selected highlight live.
      const { selectedId, byFile, activePreset } = get();
      if (selectedId && i === activePreset) {
        for (const [file, list] of Object.entries(byFile)) {
          if (list.some((x) => x.id === selectedId && x.type === "highlight"))
            get().update(file, selectedId, { color: c });
        }
      }
      save();
    },
    setActivePreset: (i) => set({ activePreset: i }),
    // Selecting an annotation opens its options pill so its colour/thickness/fill can be edited.
    setSelected: (id) => set(id ? { selectedId: id, optionsOpen: true } : { selectedId: id }),
    setSignatureDataUrl: (url) => {
      set({ signatureDataUrl: url });
      save();
    },
    setSignaturePadOpen: (open) => set({ signaturePadOpen: open }),
    setOptionsOpen: (open) => set({ optionsOpen: open }),

    add: (file, anno) => {
      pushHistory();
      coalesceKey = null;
      const stamped = { ...anno, updatedAt: Date.now() } as Annotation;
      set((st) => ({
        byFile: { ...st.byFile, [file]: [...(st.byFile[file] ?? []), stamped] },
        selectedId: anno.id,
        optionsOpen: false, // the tool was just used — collapse its options pill
      }));
      save();
    },
    update: (file, id, patch) => {
      const now = Date.now();
      const key = `${file}:${id}`;
      // Snapshot only when starting a new edit (different target, or after a short pause).
      if (!(key === coalesceKey && now - coalesceAt < 700)) pushHistory();
      coalesceKey = key;
      coalesceAt = now;
      set((st) => ({
        byFile: {
          ...st.byFile,
          [file]: (st.byFile[file] ?? []).map((a) =>
            a.id === id ? ({ ...a, ...patch, updatedAt: now } as Annotation) : a
          ),
        },
      }));
      save();
    },
    remove: (file, id) => {
      pushHistory();
      coalesceKey = null;
      set((st) => ({
        byFile: { ...st.byFile, [file]: (st.byFile[file] ?? []).filter((a) => a.id !== id) },
        deleted: tombstone(st.deleted, file, [id], Date.now()),
        selectedId: st.selectedId === id ? null : st.selectedId,
      }));
      save();
    },
    clearPage: (file, pageIndex) => {
      pushHistory();
      coalesceKey = null;
      set((st) => {
        const list = st.byFile[file] ?? [];
        const gone = list.filter((a) => a.pageIndex === pageIndex).map((a) => a.id);
        return {
          byFile: { ...st.byFile, [file]: list.filter((a) => a.pageIndex !== pageIndex) },
          deleted: tombstone(st.deleted, file, gone, Date.now()),
        };
      });
      save();
    },
    /**
     * Move annotations to follow their pages after a page edit (remove/reorder), using an old →
     * new visible page index map. Annotations on pages missing from the map are dropped with the
     * page. One history entry, so undo restores placement and removal together.
     */
    remapPages: (file, map) => {
      const list = get().byFile[file];
      if (!list?.length) return; // nothing to move — don't spend an undo step
      pushHistory();
      coalesceKey = null;
      const now = Date.now();
      set((st) => {
        const current = st.byFile[file] ?? [];
        // Annotations on pages that no longer exist are deletions, and have to be recorded as such
        // or the next sync would restore them onto pages the user removed.
        const dropped = current.filter((a) => map.get(a.pageIndex) === undefined).map((a) => a.id);
        return {
          byFile: {
            ...st.byFile,
            [file]: current.flatMap((a) => {
              const to = map.get(a.pageIndex);
              return to === undefined ? [] : [{ ...a, pageIndex: to, updatedAt: now } as Annotation];
            }),
          },
          deleted: tombstone(st.deleted, file, dropped, now),
        };
      });
      save();
    },
    undo: () => {
      coalesceKey = null;
      const { past } = get();
      if (past.length === 0) return;
      set((st) => {
        const entry = st.past[st.past.length - 1];
        return {
          byFile: entry.byFile,
          deleted: entry.deleted,
          past: st.past.slice(0, -1),
          future: [{ byFile: st.byFile, deleted: st.deleted }, ...st.future].slice(0, HISTORY_LIMIT),
          selectedId: null,
        };
      });
      save();
    },
    redo: () => {
      coalesceKey = null;
      const { future } = get();
      if (future.length === 0) return;
      set((st) => {
        const entry = st.future[0];
        return {
          byFile: entry.byFile,
          deleted: entry.deleted,
          future: st.future.slice(1),
          past: [...st.past, { byFile: st.byFile, deleted: st.deleted }].slice(-HISTORY_LIMIT),
          selectedId: null,
        };
      });
      save();
    },

    /**
     * Not an undo step: this renames the shelf, it does not change what is on it. Every annotation
     * survives with the same id and the same geometry, so there is nothing for a user to undo — and
     * an undo that put the old keys back would only hide the documents again.
     */
    rekeyAll: (byFile, deleted) => {
      set({ byFile, deleted });
      save();
    },

    setFor: (file) => ({
      annotations: get().byFile[file] ?? [],
      deleted: get().deleted[file] ?? {},
    }),

    /**
     * Folding in another device's work is not an undoable edit in the usual sense, but it can change
     * a lot at once — so it takes a history step, letting the user back out of a surprising sync the
     * same way they back out of a mistaken stroke.
     *
     * ONE step for the whole sync, not one per document: a library of fifty documents would
     * otherwise push fifty entries and flush every real edit out of a hundred-deep undo stack.
     */
    mergeAll: (incoming) => {
      const files = Object.keys(incoming);
      if (files.length === 0) return; // nothing came back — don't spend an undo step
      pushHistory();
      coalesceKey = null;
      set((st) => {
        const byFile = { ...st.byFile };
        const deleted = { ...st.deleted };
        for (const file of files) {
          const merged = mergeAnnotationSets(
            { annotations: st.byFile[file] ?? [], deleted: st.deleted[file] ?? {} },
            incoming[file],
          );
          byFile[file] = merged.annotations;
          if (Object.keys(merged.deleted).length) deleted[file] = merged.deleted;
          else delete deleted[file];
        }
        return { byFile, deleted };
      });
      save();
    },

    activeColor: () => {
      const s = get();
      return s.tool === "highlight" ? s.highlightPresets[s.activePreset] : s.color;
    },
  };
});

export const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `a_${Date.now()}_${Math.random().toString(36).slice(2)}`;
