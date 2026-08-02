import { create } from "zustand";
import { load, type Store } from "@tauri-apps/plugin-store";
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
  lastPositions: Record<string, { page: number }>;
  /**
   * HTML files the user has chosen to run scripts for, so the choice survives a restart instead of
   * having to be re-made on every open. Only ever added by an explicit click on the shield toggle.
   */
  trustedHtml: string[];

  hydrate: () => Promise<void>;
  setTheme: (t: ThemeName) => void;
  setCustomThemeVar: (key: keyof CustomTheme, value: string) => void;
  updateLayout: (patch: Partial<LayoutSettings>) => void;
  toggleSidebar: () => void;
  addRecent: (path: string, name: string) => void;
  clearRecents: () => void;
  savePosition: (path: string, page: number) => void;
  setHtmlTrust: (path: string, trusted: boolean) => void;
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
  "theme" | "customTheme" | "layout" | "recents" | "lastPositions" | "trustedHtml"
>;

function snapshot(s: SettingsState): Persisted {
  return {
    theme: s.theme,
    customTheme: s.customTheme,
    layout: s.layout,
    recents: s.recents,
    lastPositions: s.lastPositions,
    trustedHtml: s.trustedHtml,
  };
}

async function persist(s: SettingsState) {
  try {
    const store = await getStore();
    await store.set(STATE_KEY, snapshot(s));
    await store.save();
  } catch {
    // Persistence is best-effort; ignore when the store isn't available.
  }
}

export const useSettings = create<SettingsState>((set, get) => ({
  hydrated: false,
  theme: "dark",
  customTheme: DEFAULT_CUSTOM_THEME,
  layout: DEFAULT_LAYOUT,
  recents: [],
  lastPositions: {},
  trustedHtml: [],

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
    set({ theme: t });
    const s = get();
    applyTheme(t, s.customTheme);
    void persist(s);
  },
  setCustomThemeVar: (key, value) => {
    const customTheme = { ...get().customTheme, [key]: value };
    set({ customTheme, theme: "custom" });
    applyTheme("custom", customTheme);
    void persist(get());
  },
  updateLayout: (patch) => {
    set({ layout: { ...get().layout, ...patch } });
    void persist(get());
  },
  toggleSidebar: () => {
    set((st) => ({ layout: { ...st.layout, sidebarOpen: !st.layout.sidebarOpen } }));
    void persist(get());
  },
  addRecent: (path, name) => {
    const recents = [
      { path, name, openedAt: Date.now() },
      ...get().recents.filter((r) => r.path !== path),
    ].slice(0, 12);
    set({ recents });
    void persist(get());
  },
  clearRecents: () => {
    set({ recents: [] });
    void persist(get());
  },
  savePosition: (path, page) => {
    set((st) => ({ lastPositions: { ...st.lastPositions, [path]: { page } } }));
    // Position writes are frequent; persist without forcing extra renders.
    void persist(get());
  },
  setHtmlTrust: (path, trusted) => {
    const without = get().trustedHtml.filter((p) => p !== path);
    // Newest first and capped, so a long tail of one-off pages can't keep running scripts forever.
    set({ trustedHtml: trusted ? [path, ...without].slice(0, 50) : without });
    void persist(get());
  },
}));
