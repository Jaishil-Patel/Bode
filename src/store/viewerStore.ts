import { create } from "zustand";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { readPdfBytes } from "../platform/files";
import { openInNewWindow } from "../platform/window";
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

/** Lightweight tab descriptor shown in the tab strip. */
export interface TabMeta {
  id: string;
  filePath: string;
  fileName: string;
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

  // Open documents. In "tabs" mode this can hold several; in "windows" mode each window
  // keeps a single entry. The top-level fields above mirror whichever tab is active.
  tabs: TabMeta[];
  activeTabId: string | null;

  openWithDialog: () => Promise<void>;
  openPath: (path: string) => Promise<void>;
  switchTab: (id: string) => void;
  closeTab: (id: string) => void;
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

/** Per-tab heavy state, kept outside the reactive store and restored on tab switch. */
type TabSnapshot = Pick<
  ViewerState,
  | "doc"
  | "fileName"
  | "filePath"
  | "numPages"
  | "baseSize"
  | "outline"
  | "currentPage"
  | "fitMode"
  | "customScale"
  | "scale"
  | "search"
  | "scrollTarget"
>;
const tabStates = new Map<string, TabSnapshot>();

const newTabId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `t_${Date.now()}_${Math.random().toString(36).slice(2)}`;

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? "document.pdf";
const emptySearch = (): SearchState => ({ open: false, query: "", busy: false, matches: [], current: -1 });

/** Snapshot the currently-active tab's live state so it can be restored later. */
function captureActive(get: () => ViewerState): TabSnapshot {
  const s = get();
  return {
    doc: s.doc,
    fileName: s.fileName,
    filePath: s.filePath,
    numPages: s.numPages,
    baseSize: s.baseSize,
    outline: s.outline,
    currentPage: s.currentPage,
    fitMode: s.fitMode,
    customScale: s.customScale,
    scale: s.scale,
    search: s.search,
    scrollTarget: s.scrollTarget,
  };
}

const EMPTY_DOC_STATE = {
  doc: null,
  fileName: null,
  filePath: null,
  numPages: 0,
  baseSize: { width: 612, height: 792 },
  outline: [] as OutlineItem[],
  currentPage: 1,
  loading: false,
  error: null as string | null,
  search: emptySearch(),
  scrollTarget: null as ScrollTarget | null,
};

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

  search: emptySearch(),
  scrollTarget: null,

  tabs: [],
  activeTabId: null,

  openWithDialog: async () => {
    const selected = await openDialog({
      multiple: true,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    const paths = Array.isArray(selected) ? selected : typeof selected === "string" ? [selected] : [];
    for (const p of paths) await get().openPath(p);
  },

  openPath: async (path: string) => {
    const layout = useSettings.getState().layout;

    // Already open here — just focus its tab.
    const existing = get().tabs.find((t) => t.filePath === path);
    if (existing) {
      get().switchTab(existing.id);
      return;
    }

    // Separate-windows mode: once this window has a document, send further files to new windows.
    if (layout.openMode === "windows" && get().doc) {
      if (await openInNewWindow(path)) return;
      // If a new window couldn't be created, fall through and open as a tab instead.
    }

    // Open in a new tab, capturing the outgoing tab's state first.
    const outgoing = get().activeTabId;
    if (outgoing) tabStates.set(outgoing, captureActive(get));
    const id = newTabId();
    const name = baseName(path);
    set({
      tabs: [...get().tabs, { id, filePath: path, fileName: name }],
      activeTabId: id,
      ...EMPTY_DOC_STATE,
      fileName: name,
      filePath: path,
      loading: true,
    });

    try {
      const data = await readPdfBytes(path);
      const doc = await loadPdfFromBytes(data);
      const first = await doc.getPage(1);
      const vp = first.getViewport({ scale: 1 });
      const outline = await getOutline(doc).catch(() => []);

      const settings = useSettings.getState();
      settings.addRecent(path, name);
      const last = settings.lastPositions[path];
      const startPage = last && last.page > 1 ? last.page : 1;

      const loaded: TabSnapshot = {
        doc,
        fileName: name,
        filePath: path,
        numPages: doc.numPages,
        baseSize: { width: vp.width, height: vp.height },
        outline,
        currentPage: 1,
        fitMode: "width",
        customScale: 1,
        scale: 1,
        search: emptySearch(),
        scrollTarget: startPage > 1 ? { page: startPage, nonce: Date.now() } : null,
      };
      tabStates.set(id, loaded);
      // The user may have switched away while this loaded; only publish if still active.
      if (get().activeTabId === id) set({ ...loaded, loading: false, error: null });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (get().activeTabId === id) set({ loading: false, error: msg });
    }
  },

  switchTab: (id) => {
    if (id === get().activeTabId) return;
    const cur = get().activeTabId;
    if (cur) tabStates.set(cur, captureActive(get));
    searchToken++; // drop any in-flight search from the old tab
    const snap = tabStates.get(id);
    if (snap) {
      // Re-issue a scroll to the page the user left off on — the viewer's scroll container
      // keeps its old offset across the switch, so nudge it back to this tab's position.
      const scrollTarget = { page: snap.currentPage, nonce: Date.now() };
      set({ ...snap, scrollTarget, activeTabId: id, loading: false, error: null });
    } else {
      // Target is still loading (no snapshot yet) — show its name and let the loader publish.
      const meta = get().tabs.find((t) => t.id === id);
      set({
        ...EMPTY_DOC_STATE,
        activeTabId: id,
        fileName: meta?.fileName ?? null,
        filePath: meta?.filePath ?? null,
        loading: true,
      });
    }
  },

  closeTab: (id) => {
    tabStates.get(id)?.doc?.destroy();
    tabStates.delete(id);
    const tabs = get().tabs;
    const idx = tabs.findIndex((t) => t.id === id);
    const remaining = tabs.filter((t) => t.id !== id);

    if (get().activeTabId !== id) {
      set({ tabs: remaining });
      return;
    }

    // Closing the active tab: fall back to a neighbour, or empty out if it was the last.
    const next = remaining[idx] ?? remaining[idx - 1] ?? null;
    set({ tabs: remaining, activeTabId: null });
    if (next) {
      get().switchTab(next.id);
    } else {
      set({ ...EMPTY_DOC_STATE });
    }
  },

  close: () => {
    const id = get().activeTabId;
    if (id) get().closeTab(id);
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
    if (token !== searchToken) return; // a newer search (or tab switch) superseded this one
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
