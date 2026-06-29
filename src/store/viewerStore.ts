import { create } from "zustand";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { readPdfBytes, readTextFile, writeTextFile } from "../platform/files";
import { openInNewWindow } from "../platform/window";
import { renderMarkdown } from "../markdown/renderMarkdown";
import {
  loadPdfFromBytes,
  getOutline,
  isPasswordException,
  isWrongPassword,
  type OutlineItem,
} from "../pdf/usePdfDocument";
import { searchDocument, type SearchMatch } from "../pdf/search";
import { saveUnlockedPdf, exportAnnotatedPdf } from "../pdf/exportPdf";
import { useAnnotations } from "../annotations/useAnnotations";
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
  offsetPts?: number; // distance from the page top (PDF points @ scale 1) for in-page link jumps
}

/** A pending request for the password of an encrypted PDF. Bytes are cached so retries don't re-read. */
interface PasswordPrompt {
  tabId: string;
  path: string;
  name: string;
  data: Uint8Array;
  wrong: boolean; // true once a supplied password was rejected
}

/** What kind of document a tab holds. PDFs go through PDF.js; Markdown is a reflowed reading view. */
export type DocKind = "pdf" | "md";

/** Lightweight tab descriptor shown in the tab strip. */
export interface TabMeta {
  id: string;
  filePath: string;
  fileName: string;
  kind: DocKind;
}

const MD_EXTS = ["md", "markdown", "mdown", "mkd", "markdn"];
const kindForPath = (path: string): DocKind =>
  MD_EXTS.includes(path.split(".").pop()?.toLowerCase() ?? "") ? "md" : "pdf";

interface ViewerState {
  doc: PdfDocument | null;
  /** Rendered HTML for a Markdown tab (null for PDF tabs). Drives the reflowed reading view. */
  mdHtml: string | null;
  /** Raw Markdown source for a Markdown tab (null for PDF tabs). Edited in the source editor. */
  mdSource: string | null;
  /** True while a Markdown tab shows the source editor instead of the rendered preview. */
  mdEditing: boolean;
  /** True when the Markdown source has unsaved edits. */
  mdDirty: boolean;
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

  /** Set when an encrypted PDF is waiting for the user to type a password. */
  passwordPrompt: PasswordPrompt | null;
  /** Paths of open PDFs unlocked with a password this session — gates the "Save unlocked copy" action. */
  encryptedPaths: string[];

  // Open documents. In "tabs" mode this can hold several; in "windows" mode each window
  // keeps a single entry. The top-level fields above mirror whichever tab is active.
  tabs: TabMeta[];
  activeTabId: string | null;

  openWithDialog: () => Promise<void>;
  openPath: (path: string) => Promise<void>;
  submitPassword: (password: string) => Promise<void>;
  cancelPassword: () => void;
  exportUnlocked: () => Promise<void>;
  saveAnnotated: () => Promise<void>;
  switchTab: (id: string) => void;
  closeTab: (id: string) => void;
  close: () => void;

  toggleMdEdit: (on?: boolean) => void;
  setMdSource: (text: string) => void;
  saveMd: () => Promise<void>;

  setFitMode: (m: FitMode) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomBy: (factor: number) => void;
  resetZoom: () => void;
  setResolvedScale: (s: number) => void;

  setCurrentPage: (p: number) => void;
  goToPage: (p: number) => void;
  goToPdfDestination: (pageIndex: number, topPts?: number) => void;
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
  | "mdHtml"
  | "mdSource"
  | "mdEditing"
  | "mdDirty"
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

/**
 * Passwords used to unlock encrypted PDFs this session, keyed by file path. Kept out of the
 * reactive store (and never persisted) so the secret doesn't leak into components or devtools —
 * the store only exposes `encryptedPaths` for UI gating. Used to write an unlocked copy on demand.
 */
const pdfPasswords = new Map<string, string>();

const newTabId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `t_${Date.now()}_${Math.random().toString(36).slice(2)}`;

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? "document";
const emptySearch = (): SearchState => ({ open: false, query: "", busy: false, matches: [], current: -1 });

/** Snapshot the currently-active tab's live state so it can be restored later. */
function captureActive(get: () => ViewerState): TabSnapshot {
  const s = get();
  return {
    doc: s.doc,
    mdHtml: s.mdHtml,
    mdSource: s.mdSource,
    mdEditing: s.mdEditing,
    mdDirty: s.mdDirty,
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
  mdHtml: null as string | null,
  mdSource: null as string | null,
  mdEditing: false,
  mdDirty: false,
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

/**
 * Build a PDF tab snapshot from already-read bytes via PDF.js, restoring the last-read page if
 * there is one. `password` is forwarded for encrypted PDFs; an encrypted file with a missing or
 * wrong password rejects with a PasswordException the caller handles.
 */
async function buildPdfSnapshot(
  path: string,
  name: string,
  data: Uint8Array,
  password?: string,
): Promise<TabSnapshot> {
  // PDF.js transfers (detaches) the buffer to its worker, so give it a fresh copy each call —
  // otherwise a password retry would reuse an already-detached buffer and postMessage would throw.
  const doc = await loadPdfFromBytes(data.slice(), password);
  const first = await doc.getPage(1);
  const vp = first.getViewport({ scale: 1 });
  const outline = await getOutline(doc).catch(() => []);

  const last = useSettings.getState().lastPositions[path];
  const startPage = last && last.page > 1 ? last.page : 1;

  return {
    doc,
    mdHtml: null,
    mdSource: null,
    mdEditing: false,
    mdDirty: false,
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
}

/** Read a Markdown file and render it to HTML for the reflowed reading view. */
async function loadMarkdownTab(path: string, name: string): Promise<TabSnapshot> {
  const source = await readTextFile(path);
  return {
    doc: null,
    mdHtml: renderMarkdown(source),
    mdSource: source,
    mdEditing: false,
    mdDirty: false,
    fileName: name,
    filePath: path,
    numPages: 0,
    baseSize: { width: 612, height: 792 },
    outline: [],
    currentPage: 1,
    fitMode: "width",
    customScale: 1,
    scale: 1,
    search: emptySearch(),
    scrollTarget: null,
  };
}

export const useViewer = create<ViewerState>((set, get) => ({
  doc: null,
  mdHtml: null,
  mdSource: null,
  mdEditing: false,
  mdDirty: false,
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

  passwordPrompt: null,
  encryptedPaths: [],

  tabs: [],
  activeTabId: null,

  openWithDialog: async () => {
    const selected = await openDialog({
      multiple: true,
      filters: [
        { name: "Documents", extensions: ["pdf", "md", "markdown"] },
        { name: "PDF", extensions: ["pdf"] },
        { name: "Markdown", extensions: ["md", "markdown"] },
      ],
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
    if (layout.openMode === "windows" && (get().doc || get().mdHtml)) {
      if (await openInNewWindow(path)) return;
      // If a new window couldn't be created, fall through and open as a tab instead.
    }

    // Open in a new tab, capturing the outgoing tab's state first.
    const outgoing = get().activeTabId;
    if (outgoing) tabStates.set(outgoing, captureActive(get));
    const id = newTabId();
    const name = baseName(path);
    const kind = kindForPath(path);
    set({
      tabs: [...get().tabs, { id, filePath: path, fileName: name, kind }],
      activeTabId: id,
      ...EMPTY_DOC_STATE,
      fileName: name,
      filePath: path,
      loading: true,
    });

    try {
      let loaded: TabSnapshot;
      if (kind === "md") {
        loaded = await loadMarkdownTab(path, name);
      } else {
        const data = await readPdfBytes(path);
        try {
          loaded = await buildPdfSnapshot(path, name, data);
        } catch (e) {
          // Encrypted PDF: hold the bytes and ask for a password instead of erroring out.
          if (isPasswordException(e)) {
            set({ loading: false, passwordPrompt: { tabId: id, path, name, data, wrong: false } });
            return;
          }
          throw e;
        }
      }
      useSettings.getState().addRecent(path, name);
      tabStates.set(id, loaded);
      // The user may have switched away while this loaded; only publish if still active.
      if (get().activeTabId === id) set({ ...loaded, loading: false, error: null });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (get().activeTabId === id) set({ loading: false, error: msg });
    }
  },

  submitPassword: async (password) => {
    const prompt = get().passwordPrompt;
    if (!prompt) return;
    const { tabId, path, name, data } = prompt;
    try {
      const loaded = await buildPdfSnapshot(path, name, data, password);
      useSettings.getState().addRecent(path, name);
      tabStates.set(tabId, loaded);
      // Remember the password (out of the reactive store) so we can write an unlocked copy later,
      // and flag the path so the "Save unlocked copy" command appears for it.
      pdfPasswords.set(path, password);
      set({
        passwordPrompt: null,
        encryptedPaths: get().encryptedPaths.includes(path)
          ? get().encryptedPaths
          : [...get().encryptedPaths, path],
      });
      // Only publish to the visible viewer if this tab is still the active one.
      if (get().activeTabId === tabId) set({ ...loaded, loading: false, error: null });
    } catch (e) {
      // Wrong password: keep the modal open and flag it. Anything else is a real failure.
      if (isWrongPassword(e)) {
        set({ passwordPrompt: { ...prompt, wrong: true } });
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        set({ passwordPrompt: null });
        if (get().activeTabId === tabId) set({ error: msg });
      }
    }
  },

  cancelPassword: () => {
    const prompt = get().passwordPrompt;
    if (!prompt) return;
    set({ passwordPrompt: null });
    get().closeTab(prompt.tabId); // drop the half-opened tab we created for this file
  },

  exportUnlocked: async () => {
    const path = get().filePath;
    if (!path) return;
    const password = pdfPasswords.get(path);
    if (!password) return; // not an unlocked-this-session PDF — action shouldn't have been offered
    try {
      await saveUnlockedPdf(path, password);
    } catch (e) {
      set({ error: `Save failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  },

  saveAnnotated: async () => {
    const path = get().filePath;
    if (!path) return;
    const annotations = useAnnotations.getState().byFile[path] ?? [];
    const password = pdfPasswords.get(path); // set only for PDFs unlocked this session
    try {
      if (password) {
        // pdf-lib can't keep the encryption, so flattening an encrypted PDF necessarily drops the
        // password. Only do that when the user has opted in; otherwise point them at the explicit action.
        if (!useSettings.getState().layout.removePasswordOnSave) {
          set({
            error:
              "This PDF is password-protected. Turn on “Remove password when saving” in Settings, or use “Save unlocked copy”.",
          });
          return;
        }
        await exportAnnotatedPdf(path, annotations, password);
      } else {
        await exportAnnotatedPdf(path, annotations);
      }
    } catch (e) {
      set({ error: `Save failed: ${e instanceof Error ? e.message : String(e)}` });
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

    // Forget any unlock password for this file (paths are unique per tab — openPath dedupes).
    const closedPath = tabs[idx]?.filePath;
    if (closedPath) {
      pdfPasswords.delete(closedPath);
      const encryptedPaths = get().encryptedPaths.filter((p) => p !== closedPath);
      if (encryptedPaths.length !== get().encryptedPaths.length) set({ encryptedPaths });
    }

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

  toggleMdEdit: (on) => {
    if (get().mdSource == null) return; // not a Markdown tab
    const next = on ?? !get().mdEditing;
    // Leaving the editor: re-render the preview from the (possibly edited) source.
    if (!next && get().mdEditing) set({ mdHtml: renderMarkdown(get().mdSource ?? "") });
    set({ mdEditing: next });
  },
  setMdSource: (text) => {
    if (get().mdSource == null) return;
    set({ mdSource: text, mdDirty: true });
  },
  saveMd: async () => {
    const { filePath, mdSource, mdDirty } = get();
    if (!filePath || mdSource == null || !mdDirty) return;
    try {
      await writeTextFile(filePath, mdSource);
      // Refresh the preview to match exactly what's now on disk, and clear the dirty flag.
      set({ mdDirty: false, mdHtml: renderMarkdown(mdSource) });
    } catch (e) {
      set({ error: `Save failed: ${e instanceof Error ? e.message : String(e)}` });
    }
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
  goToPdfDestination: (pageIndex, topPts) => {
    const page = Math.min(Math.max(1, pageIndex + 1), get().numPages || 1);
    // Dest y is from the page bottom; convert to a from-top offset using the uniform page height.
    const offsetPts =
      typeof topPts === "number" ? Math.max(0, get().baseSize.height - topPts) : undefined;
    set({ scrollTarget: { page, offsetPts, nonce: Date.now() } });
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
