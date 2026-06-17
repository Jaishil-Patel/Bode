import { create } from "zustand";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { readPdfBytes } from "../platform/files";
import { loadPdfFromBytes, getOutline, type OutlineItem } from "../pdf/usePdfDocument";
import { searchDocument, type SearchMatch } from "../pdf/search";
import type { PdfDocument } from "../pdf/pdfWorker";
import { useSettings } from "../settings/useSettings";

export type FitMode = "width" | "page" | "custom";

interface SearchState {
  open: boolean;
  query: string;
  busy: boolean;
  matches: SearchMatch[];
  current: number; // index into matches, -1 when none
}

interface ScrollTarget {
  page: number; // 1-based
  nonce: number; // changes every request so the viewer re-reacts
}

interface ViewerState {
  doc: PdfDocument | null;
  fileName: string | null;
  filePath: string | null;
  numPages: number;
  /** Page size at scale 1.0, used as the uniform model for scroll virtualization. */
  baseSize: { width: number; height: number };
  outline: OutlineItem[];

  currentPage: number; // 1-based, the page most in view
  fitMode: FitMode;
  customScale: number;
  scale: number; // resolved scale the viewer last applied (display only)

  loading: boolean;
  error: string | null;

  search: SearchState;
  scrollTarget: ScrollTarget | null;

  openWithDialog: () => Promise<void>;
  openPath: (path: string) => Promise<void>;
  close: () => void;

  setFitMode: (m: FitMode) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomBy: (factor: number) => void;
  resetZoom: () => void;
  setResolvedScale: (s: number) => void;

  setCurrentPage: (p: number) => void;
  goToPage: (p: number) => void;
  nextPage: () => void;
  prevPage: () => void;

  toggleSearch: (open?: boolean) => void;
  runSearch: (query: string) => Promise<void>;
  clearSearch: () => void;
  nextMatch: () => void;
  prevMatch: () => void;
  currentMatch: () => SearchMatch | null;
}

const ZOOM_STEPS = [0.25, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
let searchToken = 0;

export const useViewer = create<ViewerState>((set, get) => ({
  doc: null,
  fileName: null,
  filePath: null,
  numPages: 0,
  baseSize: { width: 612, height: 792 }, // US Letter @ 72dpi fallback
  outline: [],

  currentPage: 1,
  fitMode: "width",
  customScale: 1,
  scale: 1,

  loading: false,
  error: null,

  search: { open: false, query: "", busy: false, matches: [], current: -1 },
  scrollTarget: null,

  openWithDialog: async () => {
    const selected = await openDialog({
      multiple: false,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (typeof selected === "string") {
      await get().openPath(selected);
    }
  },

  openPath: async (path: string) => {
    set({ loading: true, error: null });
    try {
      const data = await readPdfBytes(path);
      const doc = await loadPdfFromBytes(data);
      const first = await doc.getPage(1);
      const vp = first.getViewport({ scale: 1 });
      const outline = await getOutline(doc).catch(() => []);
      const name = path.split(/[\\/]/).pop() ?? "document.pdf";

      get().clearSearch();
      set({
        doc,
        fileName: name,
        filePath: path,
        numPages: doc.numPages,
        baseSize: { width: vp.width, height: vp.height },
        outline,
        currentPage: 1,
        loading: false,
        error: null,
      });

      const settings = useSettings.getState();
      settings.addRecent(path, name);
      const last = settings.lastPositions[path];
      if (last && last.page > 1) {
        set({ scrollTarget: { page: last.page, nonce: Date.now() } });
      }
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  close: () => {
    get().doc?.destroy();
    set({
      doc: null,
      fileName: null,
      filePath: null,
      numPages: 0,
      outline: [],
      currentPage: 1,
      error: null,
    });
    get().clearSearch();
  },

  setFitMode: (m) => set({ fitMode: m }),
  zoomIn: () => {
    const cur = get().scale;
    const next = ZOOM_STEPS.find((s) => s > cur + 0.001) ?? cur * 1.25;
    set({ fitMode: "custom", customScale: next });
  },
  zoomOut: () => {
    const cur = get().scale;
    const next = [...ZOOM_STEPS].reverse().find((s) => s < cur - 0.001) ?? cur * 0.8;
    set({ fitMode: "custom", customScale: next });
  },
  zoomBy: (factor) => {
    const next = Math.min(Math.max(get().scale * factor, 0.1), 6);
    set({ fitMode: "custom", customScale: next });
  },
  resetZoom: () => set({ fitMode: "custom", customScale: 1 }),
  setResolvedScale: (s) => {
    if (Math.abs(s - get().scale) > 0.0001) set({ scale: s });
  },

  setCurrentPage: (p) => {
    if (p !== get().currentPage) {
      set({ currentPage: p });
      const { filePath } = get();
      if (filePath) useSettings.getState().savePosition(filePath, p);
    }
  },
  goToPage: (p) => {
    const page = Math.min(Math.max(1, Math.round(p)), get().numPages || 1);
    set({ scrollTarget: { page, nonce: Date.now() } });
  },
  nextPage: () => get().goToPage(get().currentPage + 1),
  prevPage: () => get().goToPage(get().currentPage - 1),

  toggleSearch: (open) => {
    const next = open ?? !get().search.open;
    set((st) => ({ search: { ...st.search, open: next } }));
  },
  runSearch: async (query) => {
    const doc = get().doc;
    const token = ++searchToken;
    set((st) => ({ search: { ...st.search, query, busy: true } }));
    if (!doc || !query.trim()) {
      set((st) => ({ search: { ...st.search, busy: false, matches: [], current: -1 } }));
      return;
    }
    const matches = await searchDocument(doc, query.trim());
    if (token !== searchToken) return; // a newer search superseded this one
    set((st) => ({
      search: { ...st.search, busy: false, matches, current: matches.length ? 0 : -1 },
    }));
    if (matches.length) get().goToPage(matches[0].pageIndex + 1);
  },
  clearSearch: () => {
    searchToken++;
    set((st) => ({
      search: { ...st.search, query: "", busy: false, matches: [], current: -1 },
    }));
  },
  nextMatch: () => {
    const { matches, current } = get().search;
    if (!matches.length) return;
    const idx = (current + 1) % matches.length;
    set((st) => ({ search: { ...st.search, current: idx } }));
    get().goToPage(matches[idx].pageIndex + 1);
  },
  prevMatch: () => {
    const { matches, current } = get().search;
    if (!matches.length) return;
    const idx = (current - 1 + matches.length) % matches.length;
    set((st) => ({ search: { ...st.search, current: idx } }));
    get().goToPage(matches[idx].pageIndex + 1);
  },
  currentMatch: () => {
    const { matches, current } = get().search;
    return current >= 0 ? matches[current] ?? null : null;
  },
}));
