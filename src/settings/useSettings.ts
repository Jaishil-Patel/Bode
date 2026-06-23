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
  toolbarAutoHide: boolean;
  zenMode: boolean;
  annotationsHidden: boolean; // hide the floating annotation pill
  // How additional PDFs open: stacked as tabs in this window, or each in its own OS window.
  openMode: "tabs" | "windows";
}

interface SettingsState {
  hydrated: boolean;
  theme: ThemeName;
  customTheme: CustomTheme;
  layout: LayoutSettings;
  recents: RecentFile[];
  lastPositions: Record<string, { page: number }>;

  hydrate: () => Promise<void>;
  setTheme: (t: ThemeName) => void;
  setCustomThemeVar: (key: keyof CustomTheme, value: string) => void;
  updateLayout: (patch: Partial<LayoutSettings>) => void;
  toggleSidebar: () => void;
  toggleZen: () => void;
  addRecent: (path: string, name: string) => void;
  clearRecents: () => void;
  savePosition: (path: string, page: number) => void;
}

const DEFAULT_LAYOUT: LayoutSettings = {
  continuous: true,
  pageGap: 16,
  sidebarOpen: false,
  sidebarSide: "left",
  sidebarTab: "thumbnails",
  toolsSide: "bottom",
  toolbarAutoHide: false,
  zenMode: false,
  annotationsHidden: false,
  openMode: "tabs",
};

const STORE_FILE = "settings.json";
const STATE_KEY = "state";

let storePromise: Promise<Store> | null = null;
const getStore = () => (storePromise ??= load(STORE_FILE, { autoSave: false, defaults: {} }));

type Persisted = Pick<
  SettingsState,
  "theme" | "customTheme" | "layout" | "recents" | "lastPositions"
>;

function snapshot(s: SettingsState): Persisted {
  return {
    theme: s.theme,
    customTheme: s.customTheme,
    layout: s.layout,
    recents: s.recents,
    lastPositions: s.lastPositions,
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

  hydrate: async () => {
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
        });
      }
    } catch {
      // Fall back to defaults.
    } finally {
      const s = get();
      applyTheme(s.theme, s.customTheme);
      set({ hydrated: true });
    }
  },

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
  toggleZen: () => {
    set((st) => ({ layout: { ...st.layout, zenMode: !st.layout.zenMode } }));
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
}));
