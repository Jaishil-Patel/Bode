import { create } from "zustand";
import { load, type Store } from "@tauri-apps/plugin-store";
import { docKeyFor, type KeyContext } from "../platform/docKey";
import {
  applyTheme,
  DEFAULT_CUSTOM_THEME,
  type CustomTheme,
  type ThemeName,
} from "./themes";

export interface RecentFile {
  path: string;
  name: string;
  openedAt: number;
}

export interface LayoutSettings {
  continuous: boolean;
  pageGap: number; // px between pages
  sidebarOpen: boolean;
  sidebarSide: "left" | "right";
  sidebarTab: "thumbnails" | "outline";
  // Which edge the floating annotation/tools bar docks to (vertical on left/right).
  toolsSide: "bottom" | "top" | "left" | "right";
  annotationsHidden: boolean; // hide the floating annotation pill
  // How additional PDFs open: stacked as tabs in this window, or each in its own OS window.
  openMode: "tabs" | "windows";
  // Allow the Save button to write an unlocked (decrypted) copy of a password-protected PDF.
  removePasswordOnSave: boolean;
}

interface SettingsState {
  hydrated: boolean;
  theme: ThemeName;
  customTheme: CustomTheme;
  layout: LayoutSettings;
  recents: RecentFile[];
  /**
   * Where the user last was in a document, keyed by doc key (see `docKey.ts`). `at` is what makes
   * this mergeable across devices: without a timestamp, two devices' positions cannot be ordered
   * and syncing would have to guess which one to keep.
   */
  lastPositions: Record<string, { page: number; at?: number }>;
  /**
   * HTML files the user has chosen to run scripts for, so the choice survives a restart instead of
   * having to be re-made on every open. Only ever added by an explicit click on the shield toggle.
   */
  trustedHtml: string[];
  /** When theme/customTheme last changed here, so a sync can order two devices' preferences. */
  settingsUpdatedAt: number;
  /**
   * This device's Nearby id and the folder it shares, cached here so `docKey` can answer at startup.
   *
   * It could be read from Rust instead, but only by initialising Nearby — which generates a
   * certificate. A user who never shares anything should never pay for one, and until they do share
   * there is no doc key to compute anyway. Written by the Devices panel whenever status changes.
   */
  nearbyContext: KeyContext | null;

  hydrate: () => Promise<void>;
  setTheme: (t: ThemeName) => void;
  setCustomThemeVar: (key: keyof CustomTheme, value: string) => void;
  updateLayout: (patch: Partial<LayoutSettings>) => void;
  toggleSidebar: () => void;
  addRecent: (path: string, name: string) => void;
  clearRecents: () => void;
  savePosition: (path: string, page: number) => void;
  setHtmlTrust: (path: string, trusted: boolean) => void;
  applyRemoteSettings: (remote: SyncableSettings) => void;
  mergePositions: (positions: Record<string, { page: number; at?: number }>) => void;
  setPositions: (positions: Record<string, { page: number; at?: number }>) => void;
  setNearbyContext: (ctx: KeyContext | null) => void;
  /**
   * The key annotations and reading positions are stored under for a document.
   *
   * Everything that touches per-document state must go through this rather than using the path
   * directly, or the desktop and the phone would file the same PDF under two different names and
   * neither would ever see the other's highlights.
   */
  docKey: (path: string) => string;
}

const DEFAULT_LAYOUT: LayoutSettings = {
  continuous: true,
  pageGap: 16,
  sidebarOpen: false,
  sidebarSide: "left",
  sidebarTab: "thumbnails",
  toolsSide: "bottom",
  annotationsHidden: false,
  openMode: "tabs",
  removePasswordOnSave: false,
};

const STORE_FILE = "settings.json";
const STATE_KEY = "state";

let storePromise: Promise<Store> | null = null;
const getStore = () => (storePromise ??= load(STORE_FILE, { autoSave: false, defaults: {} }));

let hydrateOnce: Promise<void> | null = null;
/**
 * Resolves once persisted settings have been read. A file handed to the app at launch can start
 * opening before hydration finishes, so anything that must see saved state (e.g. whether an HTML
 * file was trusted) has to await this rather than read the store directly.
 */
export const settingsReady = () => hydrateOnce ?? Promise.resolve();

type Persisted = Pick<
  SettingsState,
  | "theme"
  | "customTheme"
  | "layout"
  | "recents"
  | "lastPositions"
  | "trustedHtml"
  | "settingsUpdatedAt"
  | "nearbyContext"
>;

function snapshot(s: SettingsState): Persisted {
  return {
    theme: s.theme,
    customTheme: s.customTheme,
    layout: s.layout,
    recents: s.recents,
    lastPositions: s.lastPositions,
    trustedHtml: s.trustedHtml,
    settingsUpdatedAt: s.settingsUpdatedAt,
    nearbyContext: s.nearbyContext,
  };
}

/*
 * Settings live in one blob that is rewritten whole on every mutation, and `savePosition` fires on
 * every page turn — so scrolling a 500-page PDF used to mean 500 full-file writes. Snapshotting is
 * eager (the value written is the one at call time) but the write itself is on a trailing timer, so
 * a burst of scrolling costs one write.
 */
const PERSIST_DEBOUNCE_MS = 400;

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pending: Persisted | null = null;

/** Write whatever is queued right now. Safe to call when nothing is pending. */
async function flushSettings(): Promise<void> {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const state = pending;
  pending = null;
  if (!state) return;
  try {
    const store = await getStore();
    await store.set(STATE_KEY, state);
    await store.save();
  } catch {
    // Persistence is best-effort; ignore when the store isn't available.
  }
}

function persist(s: SettingsState) {
  pending = snapshot(s);
  if (persistTimer !== null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void flushSettings();
  }, PERSIST_DEBOUNCE_MS);
}

// A debounced write must not outlive the app. Android kills backgrounded processes without warning,
// so anything still queued when the window hides has to go to disk immediately.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => void flushSettings());
  window.addEventListener("blur", () => void flushSettings());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushSettings();
  });
}

export const useSettings = create<SettingsState>((set, get) => ({
  hydrated: false,
  theme: "dark",
  customTheme: DEFAULT_CUSTOM_THEME,
  layout: DEFAULT_LAYOUT,
  recents: [],
  lastPositions: {},
  trustedHtml: [],
  settingsUpdatedAt: 0,
  nearbyContext: null,

  // Memoized so it runs once and, more importantly, so `settingsReady()` can hand the same promise
  // to startup callers that must not read settings before they are loaded (see openPath).
  hydrate: () =>
    (hydrateOnce ??= (async () => {
      try {
        const store = await getStore();
        const saved = await store.get<Persisted>(STATE_KEY);
        if (saved) {
          set({
            theme: saved.theme ?? "dark",
            customTheme: { ...DEFAULT_CUSTOM_THEME, ...saved.customTheme },
            layout: { ...DEFAULT_LAYOUT, ...saved.layout },
            recents: saved.recents ?? [],
            lastPositions: saved.lastPositions ?? {},
            trustedHtml: saved.trustedHtml ?? [],
            settingsUpdatedAt: saved.settingsUpdatedAt ?? 0,
            nearbyContext: saved.nearbyContext ?? null,
          });
        }
      } catch {
        // Fall back to defaults.
      } finally {
        const s = get();
        applyTheme(s.theme, s.customTheme);
        set({ hydrated: true });
      }
    })()),

  setTheme: (t) => {
    set({ theme: t, settingsUpdatedAt: Date.now() });
    const s = get();
    applyTheme(t, s.customTheme);
    persist(s);
  },
  setCustomThemeVar: (key, value) => {
    const customTheme = { ...get().customTheme, [key]: value };
    set({ customTheme, theme: "custom", settingsUpdatedAt: Date.now() });
    applyTheme("custom", customTheme);
    persist(get());
  },
  updateLayout: (patch) => {
    set({ layout: { ...get().layout, ...patch } });
    persist(get());
  },
  toggleSidebar: () => {
    set((st) => ({ layout: { ...st.layout, sidebarOpen: !st.layout.sidebarOpen } }));
    persist(get());
  },
  addRecent: (path, name) => {
    const recents = [
      { path, name, openedAt: Date.now() },
      ...get().recents.filter((r) => r.path !== path),
    ].slice(0, 12);
    set({ recents });
    persist(get());
  },
  clearRecents: () => {
    set({ recents: [] });
    persist(get());
  },
  savePosition: (path, page) => {
    set((st) => ({ lastPositions: { ...st.lastPositions, [path]: { page, at: Date.now() } } }));
    // Position writes are frequent; the debounce in `persist` is what keeps them off the disk.
    persist(get());
  },
  setHtmlTrust: (path, trusted) => {
    const without = get().trustedHtml.filter((p) => p !== path);
    // Newest first and capped, so a long tail of one-off pages can't keep running scripts forever.
    set({ trustedHtml: trusted ? [path, ...without].slice(0, 50) : without });
    persist(get());
  },

  /**
   * Take on another device's preferences, per the rules in `mergeSettings`. Only ever called from an
   * explicit "get settings from…" action — preferences drifting between devices on their own would
   * be far more surprising than useful.
   */
  applyRemoteSettings: (remote) => {
    const merged = mergeSettings(get(), remote);
    set(merged);
    const s = get();
    applyTheme(s.theme, s.customTheme);
    persist(s);
    void flushSettings();
  },

  mergePositions: (positions) => {
    set((st) => ({ lastPositions: mergePositions(st.lastPositions, positions) }));
    persist(get());
  },

  /** Replace positions wholesale, for re-keying from local paths to doc keys. */
  setPositions: (lastPositions) => {
    set({ lastPositions });
    persist(get());
  },

  setNearbyContext: (ctx) => {
    const current = get().nearbyContext;
    // Writing unconditionally would persist on every three-second status poll.
    if (current?.deviceId === ctx?.deviceId && current?.shareRoot === ctx?.shareRoot) return;
    set({ nearbyContext: ctx });
    persist(get());
  },

  docKey: (path) => docKeyFor(path, get().nearbyContext ?? { deviceId: null, shareRoot: null }),
}));

/** Everything this device is willing to hand another one. See `mergeSettings` for what is excluded. */
export interface SyncableSettings {
  theme: ThemeName;
  customTheme: CustomTheme;
  recents: RecentFile[];
  settingsUpdatedAt: number;
}

export function syncableSettings(s: SettingsState): SyncableSettings {
  return {
    theme: s.theme,
    customTheme: s.customTheme,
    recents: s.recents,
    settingsUpdatedAt: s.settingsUpdatedAt,
  };
}

/**
 * Per-field rules, because `settings.json` is one blob and a whole-blob last-write-wins would let a
 * phone's window layout overwrite a desktop's.
 *
 * - `theme`/`customTheme` — last-write-wins on `settingsUpdatedAt`.
 * - `recents` — union, newest first, re-capped. Two devices' reading histories are both real.
 * - `layout` — never synced: a phone's sidebar and page gap are wrong for a desktop.
 * - `trustedHtml` — never synced. It is a local security decision about local paths, and importing
 *   another device's list would grant script execution the user never agreed to on this one.
 */
export function mergeSettings(
  local: SyncableSettings,
  remote: SyncableSettings,
): SyncableSettings {
  const remoteIsNewer = (remote.settingsUpdatedAt ?? 0) > (local.settingsUpdatedAt ?? 0);

  const byPath = new Map<string, RecentFile>();
  for (const r of [...local.recents, ...remote.recents]) {
    const existing = byPath.get(r.path);
    if (!existing || r.openedAt > existing.openedAt) byPath.set(r.path, r);
  }
  const recents = [...byPath.values()].sort((a, b) => b.openedAt - a.openedAt).slice(0, 12);

  return {
    theme: remoteIsNewer ? remote.theme : local.theme,
    customTheme: remoteIsNewer ? remote.customTheme : local.customTheme,
    recents,
    settingsUpdatedAt: Math.max(local.settingsUpdatedAt ?? 0, remote.settingsUpdatedAt ?? 0),
  };
}

/** Per-key last-write-wins. An entry with no timestamp is from before sync existed, so it loses. */
export function mergePositions(
  local: Record<string, { page: number; at?: number }>,
  remote: Record<string, { page: number; at?: number }>,
): Record<string, { page: number; at?: number }> {
  const out = { ...local };
  for (const [key, theirs] of Object.entries(remote)) {
    const mine = out[key];
    if (!mine || (theirs.at ?? 0) > (mine.at ?? 0)) out[key] = theirs;
  }
  return out;
}
