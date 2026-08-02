import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
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
import {
  initialManifest,
  isPristine,
  indexRemap,
  removeIds,
  sourceToVisible,
  movePages as movePagesIn,
  type PageRef,
} from "../pdf/pageOps";
import { useAnnotations } from "../annotations/useAnnotations";
import type { PdfDocument } from "../pdf/pdfWorker";
import { useSettings, settingsReady } from "../settings/useSettings";

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

/**
 * What kind of document a tab holds. PDFs go through PDF.js; Markdown is a reflowed reading view;
 * HTML is shown as-is in a sandboxed frame. The latter two are "text tabs" — both are read into
 * `textSource`, both share the source editor and the in-place save.
 */
export type DocKind = "pdf" | "md" | "html";

/** The text-document kinds: everything that isn't a PDF. */
export type TextKind = Exclude<DocKind, "pdf">;

/** Lightweight tab descriptor shown in the tab strip. */
export interface TabMeta {
  id: string;
  filePath: string;
  fileName: string;
  kind: DocKind;
}

const MD_EXTS = ["md", "markdown", "mdown", "mkd", "markdn"];
const HTML_EXTS = ["html", "htm", "xhtml"];
const kindForPath = (path: string): DocKind => {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (MD_EXTS.includes(ext)) return "md";
  if (HTML_EXTS.includes(ext)) return "html";
  return "pdf";
};

interface ViewerState {
  doc: PdfDocument | null;
  /** Which text view a non-PDF tab uses, and the discriminator App renders off. Null for PDF tabs. */
  textKind: TextKind | null;
  /** Raw file text for a Markdown or HTML tab (null for PDF tabs). Edited in the source editor. */
  textSource: string | null;
  /**
   * Rendered HTML for a Markdown tab, driving the reflowed reading view. Null for HTML tabs —
   * those need no render step, the sandboxed frame takes `textSource` directly.
   */
  previewHtml: string | null;
  /** True while a text tab shows the source editor instead of the preview. */
  textEditing: boolean;
  /** True when the source has unsaved edits. */
  textDirty: boolean;
  /**
   * Set when the user has trusted this HTML tab, letting its scripts run. Holds the `bodehtml://`
   * URL the backend serves the file from; null means the default scriptless sandbox. Never
   * persisted — trust is per tab, for this session only.
   */
  htmlTrustedUrl: string | null;
  /** Bumped after a save so a trusted frame reloads instead of showing the pre-edit page. */
  htmlReloadNonce: number;
  fileName: string | null;
  filePath: string | null;
  /**
   * Number of pages the viewer shows — the manifest length, which is the source page count until
   * pages are removed. Everything user-facing (page counter, navigation, annotations) counts here.
   */
  numPages: number;
  /**
   * Staged page order for this tab. Diverges from the source once pages are removed or reordered,
   * and is applied to the file only on save. Empty for Markdown tabs.
   */
  pages: PageRef[];
  /** True while the sidebar is in page-organize mode. Transient UI state, never persisted. */
  organizeOpen: boolean;
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

  setOrganizeOpen: (open: boolean) => void;
  removePages: (ids: string[]) => void;
  reorderPages: (ids: string[], toIndex: number) => void;
  resetPageEdits: () => void;
  /** True when the staged page order differs from the file on disk. */
  hasPageEdits: () => boolean;

  switchTab: (id: string) => void;
  closeTab: (id: string) => void;
  close: () => void;

  toggleTextEdit: (on?: boolean) => void;
  setTextSource: (text: string) => void;
  saveText: () => Promise<void>;
  /** Turn "trusted page" mode on/off for the active HTML tab. */
  setHtmlTrusted: (on: boolean) => Promise<void>;

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
  | "textKind"
  | "textSource"
  | "previewHtml"
  | "textEditing"
  | "textDirty"
  | "htmlTrustedUrl"
  | "htmlReloadNonce"
  | "fileName"
  | "filePath"
  | "numPages"
  | "pages"
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
    textKind: s.textKind,
    textSource: s.textSource,
    previewHtml: s.previewHtml,
    textEditing: s.textEditing,
    textDirty: s.textDirty,
    htmlTrustedUrl: s.htmlTrustedUrl,
    htmlReloadNonce: s.htmlReloadNonce,
    fileName: s.fileName,
    filePath: s.filePath,
    numPages: s.numPages,
    pages: s.pages,
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
  textKind: null as TextKind | null,
  textSource: null as string | null,
  previewHtml: null as string | null,
  textEditing: false,
  textDirty: false,
  htmlTrustedUrl: null as string | null,
  htmlReloadNonce: 0,
  fileName: null,
  filePath: null,
  numPages: 0,
  pages: [] as PageRef[],
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
    textKind: null,
    textSource: null,
    previewHtml: null,
    textEditing: false,
    textDirty: false,
    htmlTrustedUrl: null,
    htmlReloadNonce: 0,
    fileName: name,
    filePath: path,
    numPages: doc.numPages,
    pages: initialManifest(doc.numPages),
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

/**
 * Read a text document. Markdown is rendered up front for the reflowed reading view; HTML is kept
 * as source only — HtmlView hands it straight to a sandboxed frame, so there is nothing to render.
 */
async function loadTextTab(path: string, name: string, kind: TextKind): Promise<TabSnapshot> {
  const source = await readTextFile(path);

  // Re-apply a trust decision the user made in an earlier session. The backend's allowlist is
  // in-memory, so this also re-registers the file's directory for the protocol handler.
  let htmlTrustedUrl: string | null = null;
  if (kind === "html") {
    await settingsReady(); // a launch-file open can beat hydration; don't read settings too early
    if (useSettings.getState().trustedHtml.includes(path)) {
      htmlTrustedUrl = await invoke<string>("trust_html_file", { path }).catch(() => null);
    }
  }

  return {
    doc: null,
    textKind: kind,
    textSource: source,
    previewHtml: kind === "md" ? renderMarkdown(source) : null,
    textEditing: false,
    textDirty: false,
    htmlTrustedUrl,
    htmlReloadNonce: 0,
    fileName: name,
    filePath: path,
    numPages: 0,
    pages: [],
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

/**
 * Publish an edited page manifest and bring everything that counts in visible page numbers back
 * into agreement with it: the page count, the annotations (via `remap`), the current page, and any
 * search results — whose page indexes were resolved against the old order and would now mislead.
 */
function commitPages(
  set: (partial: Partial<ViewerState>) => void,
  get: () => ViewerState,
  next: PageRef[],
  remap: ReadonlyMap<number, number>,
) {
  const { filePath, currentPage, search } = get();
  if (filePath) useAnnotations.getState().remapPages(filePath, remap);

  // Follow the page the reader was on; if it was the one removed, stay at that position in the
  // shortened document instead of jumping to the top.
  const followed = remap.get(currentPage - 1);
  const page = Math.min(
    Math.max(followed !== undefined ? followed + 1 : currentPage, 1),
    Math.max(next.length, 1),
  );

  set({
    pages: next,
    numPages: next.length,
    currentPage: page,
    search: search.matches.length ? { ...search, matches: [], current: -1 } : search,
    // Page positions shifted under the reader — re-anchor the scroll on the page they were reading.
    scrollTarget: { page, nonce: Date.now() },
  });
}

export const useViewer = create<ViewerState>((set, get) => ({
  doc: null,
  textKind: null,
  textSource: null,
  previewHtml: null,
  textEditing: false,
  textDirty: false,
  htmlTrustedUrl: null,
  htmlReloadNonce: 0,
  fileName: null,
  filePath: null,
  numPages: 0,
  pages: [],
  organizeOpen: false,
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
        { name: "Documents", extensions: ["pdf", "md", "markdown", "html", "htm"] },
        { name: "PDF", extensions: ["pdf"] },
        { name: "Markdown", extensions: ["md", "markdown"] },
        { name: "HTML", extensions: ["html", "htm"] },
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
    if (layout.openMode === "windows" && (get().doc || get().textKind)) {
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
      if (kind !== "pdf") {
        loaded = await loadTextTab(path, name, kind);
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
    // Only pass the manifest when it actually differs, so an untouched document is still saved by
    // drawing on its own pages rather than being rebuilt page by page.
    const manifest = get().hasPageEdits() ? get().pages : undefined;
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
        await exportAnnotatedPdf(path, annotations, password, manifest);
      } else {
        await exportAnnotatedPdf(path, annotations, undefined, manifest);
      }
    } catch (e) {
      set({ error: `Save failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  },

  setOrganizeOpen: (open) => set({ organizeOpen: open }),

  removePages: (ids) => {
    const idSet = new Set(ids);
    const before = get().pages;
    const next = removeIds(before, idSet);
    if (next.length === before.length) return; // nothing matched
    if (next.length === 0) {
      set({ error: "A PDF needs at least one page." });
      return;
    }
    commitPages(set, get, next, indexRemap(before, next));
  },

  reorderPages: (ids, toIndex) => {
    const before = get().pages;
    const next = movePagesIn(before, new Set(ids), toIndex);
    if (next.every((p, i) => p.id === before[i]?.id)) return; // no-op drop
    commitPages(set, get, next, indexRemap(before, next));
  },

  resetPageEdits: () => {
    const { doc, pages } = get();
    if (!doc) return;
    const fresh = initialManifest(doc.numPages);
    // A fresh manifest has new ids, so annotations can't be matched by id — send each one back to
    // the source page it is sitting on, which is exactly where that page lands in source order.
    const remap = new Map<number, number>();
    pages.forEach((p, i) => remap.set(i, p.srcPage - 1));
    commitPages(set, get, fresh, remap);
  },

  hasPageEdits: () => {
    const { doc, pages } = get();
    return !!doc && !isPristine(pages, doc.numPages);
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

  toggleTextEdit: (on) => {
    const { textKind, textSource, textEditing } = get();
    if (textSource == null) return; // not a text tab
    const next = on ?? !textEditing;
    // Leaving the editor: re-render the Markdown preview from the (possibly edited) source.
    // HTML needs no equivalent — its frame reads `textSource` directly.
    if (!next && textEditing && textKind === "md") set({ previewHtml: renderMarkdown(textSource) });
    set({ textEditing: next });
  },
  setTextSource: (text) => {
    if (get().textSource == null) return;
    set({ textSource: text, textDirty: true });
  },
  saveText: async () => {
    const { filePath, textKind, textSource, textDirty, htmlTrustedUrl, htmlReloadNonce } = get();
    if (!filePath || textSource == null || !textDirty) return;
    try {
      await writeTextFile(filePath, textSource);
      // Refresh the preview to match exactly what's now on disk, and clear the dirty flag. A
      // trusted frame reads the file over the protocol, so it needs a reload rather than a re-render.
      set({
        textDirty: false,
        ...(textKind === "md" ? { previewHtml: renderMarkdown(textSource) } : {}),
        ...(htmlTrustedUrl ? { htmlReloadNonce: htmlReloadNonce + 1 } : {}),
      });
    } catch (e) {
      set({ error: `Save failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  },

  setHtmlTrusted: async (on) => {
    const { textKind, filePath } = get();
    if (textKind !== "html" || !filePath) return;
    if (!on) {
      set({ htmlTrustedUrl: null });
      useSettings.getState().setHtmlTrust(filePath, false);
      return;
    }
    try {
      // The backend registers the file's directory as trusted and hands back the URL to load.
      const url = await invoke<string>("trust_html_file", { path: filePath });
      set({ htmlTrustedUrl: url, error: null });
      // Remember the choice so the page just works the next time it's opened.
      useSettings.getState().setHtmlTrust(filePath, true);
    } catch (e) {
      set({ error: `Could not run this page: ${e instanceof Error ? e.message : String(e)}` });
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
    // Base off customScale while already zooming: `scale` only catches up after the viewer
    // re-renders, so several gesture events in one frame would all compound off a stale value.
    const { fitMode, customScale, scale } = get();
    const base = fitMode === "custom" ? customScale : scale;
    const next = Math.min(Math.max(base * factor, 0.1), 6);
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
    // Outline entries and link targets are resolved against the source document, so translate
    // them into visible page numbers before scrolling. A removed page has nowhere to jump to.
    const visible = sourceToVisible(get().pages).get(pageIndex);
    if (get().pages.length && visible === undefined) return;
    const page = Math.min(Math.max(1, (visible ?? pageIndex) + 1), get().numPages || 1);
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
    const found = await searchDocument(doc, query.trim());
    if (token !== searchToken) return; // a newer search (or tab switch) superseded this one
    // The search walks the source document, so its page indexes are in source space. Translate to
    // visible pages and drop hits on pages the user has removed.
    const toVisible = sourceToVisible(get().pages);
    const matches = found.flatMap((m) => {
      const visible = toVisible.get(m.pageIndex);
      return visible === undefined ? [] : [{ ...m, pageIndex: visible }];
    });
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
