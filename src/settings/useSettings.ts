import { create } from "zustand";
import { load } from "@tauri-apps/plugin-store";
import { sharedStore } from "../platform/sharedStore";
import { docKeyFor, type KeyContext } from "../platform/docKey";
import { DEFAULT_TOOL_ORDER } from "../annotations/tools";
import type { Tool } from "../annotations/useAnnotations";
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
  /**
   * Which tools the bar shows and in what order.
   *
   * Two flat arrays rather than one object because they have to survive the defensive
   * `{ ...DEFAULT_LAYOUT, ...saved.layout }` spread in `hydrate` without a merge of their own.
   * Neither is trusted as read: `normalizeToolbar` in `annotations/tools.ts` reconciles them with
   * the tools that actually exist, so a settings file written by another version can neither hide
   * a tool it has never heard of nor leave a hole where a removed one used to be.
   *
   * Anything switched off stays reachable — from the bar's ⋯ menu, from its single-key shortcut,
   * and from the command palette — which is what makes it safe for every tool to be switchable,
   * `select` included.
   */
  toolOrder: Tool[];
  toolsHidden: Tool[];
  // Allow the Save button to write an unlocked (decrypted) copy of a password-protected PDF.
  removePasswordOnSave: boolean;
  /**
   * Whether the page itself is inverted for dark reading.
   *
   * A theme only ever restyled the app around the document, so a dark theme still put a sheet of
   * white paper in the middle of the screen — the one place the reader is actually looking.
   * "auto" ties this to the theme, which is what most people want and nobody wants to configure;
   * the explicit settings are for anyone who disagrees in either direction.
   */
  pageColors: "normal" | "auto" | "inverted";
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
  toolOrder: DEFAULT_TOOL_ORDER,
  toolsHidden: [],
  removePasswordOnSave: false,
  pageColors: "auto",
};

const STORE_FILE = "settings.json";

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

/*
 * Writing is debounced: `savePosition` fires on every page turn, and a burst of scrolling should
 * cost one write. Only the fields that changed are written — see `platform/sharedStore.ts`, which
 * is also what keeps every open window on the same settings.
 */
const PERSIST_DEBOUNCE_MS = 400;

function persist() {
  shared.persist();
}

/** Write whatever is queued right now. Safe to call when nothing is pending. */
const flushSettings = () => shared.flush();

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
    (hydrateOnce ??= shared.hydrate().then(() => {
      const s = get();
      applyTheme(s.theme, s.customTheme);
      set({ hydrated: true });
    })),

  setTheme: (t) => {
    set({ theme: t, settingsUpdatedAt: Date.now() });
    const s = get();
    applyTheme(t, s.customTheme, true);
    persist();
  },
  setCustomThemeVar: (key, value) => {
    const customTheme = { ...get().customTheme, [key]: value };
    set({ customTheme, theme: "custom", settingsUpdatedAt: Date.now() });
    applyTheme("custom", customTheme);
    persist();
  },
  updateLayout: (patch) => {
    set({ layout: { ...get().layout, ...patch } });
    persist();
  },
  toggleSidebar: () => {
    set((st) => ({ layout: { ...st.layout, sidebarOpen: !st.layout.sidebarOpen } }));
    persist();
  },
  addRecent: (path, name) => {
    const recents = [
      { path, name, openedAt: Date.now() },
      ...get().recents.filter((r) => r.path !== path),
    ].slice(0, 12);
    set({ recents });
    persist();
  },
  clearRecents: () => {
    set({ recents: [] });
    persist();
  },
  savePosition: (path, page) => {
    set((st) => ({ lastPositions: { ...st.lastPositions, [path]: { page, at: Date.now() } } }));
    // Position writes are frequent; the debounce in `persist` is what keeps them off the disk.
    persist();
  },
  setHtmlTrust: (path, trusted) => {
    const without = get().trustedHtml.filter((p) => p !== path);
    // Newest first and capped, so a long tail of one-off pages can't keep running scripts forever.
    set({ trustedHtml: trusted ? [path, ...without].slice(0, 50) : without });
    persist();
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
    // Faded: a theme arriving from another device is a visible change the user did not make here,
    // and a snap gives no clue that anything was received.
    applyTheme(s.theme, s.customTheme, true);
    persist();
    void flushSettings();
  },

  mergePositions: (positions) => {
    set((st) => ({ lastPositions: mergePositions(st.lastPositions, positions) }));
    persist();
  },

  /** Replace positions wholesale, for re-keying from local paths to doc keys. */
  setPositions: (lastPositions) => {
    set({ lastPositions });
    persist();
  },

  setNearbyContext: (ctx) => {
    const current = get().nearbyContext;
    // Writing unconditionally would persist on every three-second status poll.
    if (current?.deviceId === ctx?.deviceId && current?.shareRoot === ctx?.shareRoot) return;
    set({ nearbyContext: ctx });
    persist();
  },

  docKey: (path) => docKeyFor(path, get().nearbyContext ?? { deviceId: null, shareRoot: null }),
}));

/*
 * The settings file, one key per field. What arrives from it — at startup, or from another window
 * changing a setting — goes straight into the store; a theme arriving that way is applied too.
 */
const settingsField = <K extends keyof Persisted>(
  key: K,
  normalize: (v: Persisted[K]) => Persisted[K] = (v) => v,
  extra: { merge?: (stored: Persisted[K], local: Persisted[K]) => Persisted[K]; mergeOnWrite?: boolean } = {},
) => ({
  read: () => useSettings.getState()[key],
  apply: (v: Persisted[K]) => {
    useSettings.setState({ [key]: normalize(v) } as Partial<SettingsState>);
    const s = useSettings.getState();
    // Before hydration finishes the theme is applied once, at the end, without a fade.
    if ((key === "theme" || key === "customTheme") && s.hydrated) applyTheme(s.theme, s.customTheme, true);
  },
  ...extra,
});

const shared = sharedStore({
  open: () => load(STORE_FILE, { autoSave: false, defaults: {} }),
  debounceMs: PERSIST_DEBOUNCE_MS,
  fields: {
    theme: settingsField("theme"),
    customTheme: settingsField("customTheme", (v) => ({ ...DEFAULT_CUSTOM_THEME, ...v })),
    layout: settingsField("layout", (v) => ({ ...DEFAULT_LAYOUT, ...v })),
    // A file opened at launch is recorded before the saved list is read; both are kept.
    recents: settingsField("recents", (v) => v ?? [], { merge: mergeRecents }),
    // Two windows each record the page they are on; both entries are kept, newest per document.
    lastPositions: settingsField("lastPositions", (v) => v ?? {}, {
      merge: (stored, local) => mergePositions(local, stored),
      mergeOnWrite: true,
    }),
    trustedHtml: settingsField("trustedHtml", (v) => v ?? []),
    settingsUpdatedAt: settingsField("settingsUpdatedAt", (v) => v ?? 0),
    nearbyContext: settingsField("nearbyContext", (v) => v ?? null),
  },
  // Written by earlier versions: everything in one blob under "state".
  legacy: { key: "state", split: (blob: Partial<Persisted>) => ({ ...blob }) },
});

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

  const recents = mergeRecents(remote.recents, local.recents);

  return {
    theme: remoteIsNewer ? remote.theme : local.theme,
    customTheme: remoteIsNewer ? remote.customTheme : local.customTheme,
    recents,
    settingsUpdatedAt: Math.max(local.settingsUpdatedAt ?? 0, remote.settingsUpdatedAt ?? 0),
  };
}

/** Both lists, newest first and re-capped; a file on both keeps its latest open. */
export function mergeRecents(a: RecentFile[], b: RecentFile[]): RecentFile[] {
  const byPath = new Map<string, RecentFile>();
  for (const r of [...(a ?? []), ...(b ?? [])]) {
    const existing = byPath.get(r.path);
    if (!existing || r.openedAt > existing.openedAt) byPath.set(r.path, r);
  }
  return [...byPath.values()].sort((x, y) => y.openedAt - x.openedAt).slice(0, 12);
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
