import { create } from "zustand";
import { load, type Store } from "@tauri-apps/plugin-store";

/*
 * Annotation geometry is stored in PDF points (the page size at scale 1.0) with a
 * top-left origin and y growing downward — the same space PdfPage renders in. To draw
 * at the current zoom, multiply by `scale`; to read pointer coordinates, divide by it.
 * Keeping coordinates scale-independent means annotations stay anchored at any zoom.
 */

export type Tool = "select" | "highlight" | "text" | "rect" | "ellipse" | "pen";

interface Base {
  id: string;
  pageIndex: number;
  color: string;
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
  fontSize: number;
  text: string;
}
export type Annotation =
  | HighlightAnno
  | RectAnno
  | EllipseAnno
  | PenAnno
  | TextAnno;

interface AnnotationState {
  hydrated: boolean;
  byFile: Record<string, Annotation[]>;
  tool: Tool;
  color: string; // used for text & shapes
  strokeWidth: number;
  fontSize: number;
  fillShapes: boolean; // whether new rect/ellipse shapes are filled
  fillOpacity: number; // 0..1 opacity for shape fills
  highlightPresets: string[]; // exactly 3
  activePreset: number; // 0..2
  selectedId: string | null;

  hydrate: () => Promise<void>;
  setTool: (t: Tool) => void;
  setColor: (c: string) => void;
  setStrokeWidth: (w: number) => void;
  setFillShapes: (v: boolean) => void;
  setFillOpacity: (v: number) => void;
  setHighlightPreset: (i: number, c: string) => void;
  setActivePreset: (i: number) => void;
  setSelected: (id: string | null) => void;

  add: (file: string, anno: Annotation) => void;
  update: (file: string, id: string, patch: Partial<Annotation>) => void;
  remove: (file: string, id: string) => void;
  clearPage: (file: string, pageIndex: number) => void;

  /** Color the active drawing tool should use right now. */
  activeColor: () => string;
}

const STORE_FILE = "annotations.json";
const STATE_KEY = "state";

let storePromise: Promise<Store> | null = null;
const getStore = () =>
  (storePromise ??= load(STORE_FILE, { autoSave: false, defaults: {} }));

type Persisted = Pick<
  AnnotationState,
  | "byFile"
  | "color"
  | "strokeWidth"
  | "fontSize"
  | "fillShapes"
  | "fillOpacity"
  | "highlightPresets"
>;

const DEFAULT_PRESETS = ["#fde047", "#86efac", "#93c5fd"]; // yellow, green, blue

/** Upgrade annotations saved by older versions to the current shape. */
function migrate(byFile: Record<string, Annotation[]>): Record<string, Annotation[]> {
  const out: Record<string, Annotation[]> = {};
  for (const [file, list] of Object.entries(byFile)) {
    out[file] = (list ?? []).map((a) => {
      if (a.type === "highlight" && !("rects" in a && Array.isArray(a.rects))) {
        const o = a as unknown as { x: number; y: number; w: number; h: number };
        return { ...a, rects: [{ x: o.x, y: o.y, w: o.w, h: o.h }] } as Annotation;
      }
      if (a.type === "rect" || a.type === "ellipse") {
        const patch: Partial<RectAnno> = {};
        if (typeof a.filled !== "boolean") patch.filled = false;
        if (typeof a.fillOpacity !== "number") patch.fillOpacity = 0.35;
        if (Object.keys(patch).length) return { ...a, ...patch } as Annotation;
      }
      return a;
    });
  }
  return out;
}

function snapshot(s: AnnotationState): Persisted {
  return {
    byFile: s.byFile,
    color: s.color,
    strokeWidth: s.strokeWidth,
    fontSize: s.fontSize,
    fillShapes: s.fillShapes,
    fillOpacity: s.fillOpacity,
    highlightPresets: s.highlightPresets,
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

export const useAnnotations = create<AnnotationState>((set, get) => {
  const save = () => void persist(get);
  return {
    hydrated: false,
    byFile: {},
    tool: "select",
    color: "#ef4444",
    strokeWidth: 2,
    fontSize: 16,
    fillShapes: false,
    fillOpacity: 0.35,
    highlightPresets: [...DEFAULT_PRESETS],
    activePreset: 0,
    selectedId: null,

    hydrate: async () => {
      try {
        const store = await getStore();
        const saved = await store.get<Persisted>(STATE_KEY);
        if (saved) {
          set({
            byFile: migrate(saved.byFile ?? {}),
            color: saved.color ?? "#ef4444",
            strokeWidth: saved.strokeWidth ?? 2,
            fontSize: saved.fontSize ?? 16,
            fillShapes: saved.fillShapes ?? false,
            fillOpacity: saved.fillOpacity ?? 0.35,
            highlightPresets:
              saved.highlightPresets?.length === 3
                ? saved.highlightPresets
                : [...DEFAULT_PRESETS],
          });
        }
      } catch {
        /* defaults */
      } finally {
        set({ hydrated: true });
      }
    },

    setTool: (t) => set({ tool: t, selectedId: t === "select" ? get().selectedId : null }),
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
    setSelected: (id) => set({ selectedId: id }),

    add: (file, anno) => {
      set((st) => ({
        byFile: { ...st.byFile, [file]: [...(st.byFile[file] ?? []), anno] },
        selectedId: anno.id,
      }));
      save();
    },
    update: (file, id, patch) => {
      set((st) => ({
        byFile: {
          ...st.byFile,
          [file]: (st.byFile[file] ?? []).map((a) =>
            a.id === id ? ({ ...a, ...patch } as Annotation) : a
          ),
        },
      }));
      save();
    },
    remove: (file, id) => {
      set((st) => ({
        byFile: { ...st.byFile, [file]: (st.byFile[file] ?? []).filter((a) => a.id !== id) },
        selectedId: st.selectedId === id ? null : st.selectedId,
      }));
      save();
    },
    clearPage: (file, pageIndex) => {
      set((st) => ({
        byFile: {
          ...st.byFile,
          [file]: (st.byFile[file] ?? []).filter((a) => a.pageIndex !== pageIndex),
        },
      }));
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
