import { invoke } from "@tauri-apps/api/core";

export type ThemeName = "light" | "dark" | "sepia" | "oled" | "custom";

export interface CustomTheme {
  bg: string;
  surface: string;
  surface2: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  accentFg: string;
}

// No swatch colour here: the settings panel previews a theme by rendering a miniature with that
// theme's own `data-theme` attribute, so themes.css stays the single source of truth for colour.
export const BUILT_IN_THEMES: { name: ThemeName; label: string }[] = [
  { name: "light", label: "Light" },
  { name: "dark", label: "Dark" },
  { name: "sepia", label: "Sepia" },
  { name: "oled", label: "OLED" },
  { name: "custom", label: "Custom" },
];

export const DEFAULT_CUSTOM_THEME: CustomTheme = {
  bg: "#181a2a",
  surface: "#21243b",
  surface2: "#2a2e4a",
  border: "#363b5c",
  text: "#e8e9f3",
  muted: "#9aa0c0",
  accent: "#8b5cf6",
  accentFg: "#ffffff",
};

/**
 * Whether a theme is a dark one, for the settings that follow the theme rather than being set.
 *
 * Built-ins are known by name. A custom theme is judged by the luminance of its background,
 * because the user picked those colours and nothing else can say what they meant by them.
 */
export function isDarkTheme(theme: ThemeName, custom: CustomTheme): boolean {
  if (theme === "custom") return luminanceOf(custom.bg) < 0.5;
  return theme === "dark" || theme === "oled";
}

/** Perceived lightness of a `#rgb`/`#rrggbb` colour, 0..1. Falls back to dark on anything else. */
function luminanceOf(hex: string): number {
  const h = hex.trim().replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  if (full.length !== 6) return 0;
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return 0;
  // Rec. 601 weights: cheap, and matching human sensitivity matters more here than accuracy.
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

/** Maps CustomTheme fields to the CSS variable names defined in themes.css. */
const VAR_MAP: Record<keyof CustomTheme, string> = {
  bg: "--bg",
  surface: "--surface",
  surface2: "--surface-2",
  border: "--border",
  text: "--text",
  muted: "--muted",
  accent: "--accent",
  accentFg: "--accent-fg",
};

/**
 * The custom theme as inline CSS variables.
 *
 * `applyTheme` writes these onto <html> when custom is the active theme; this returns the same set
 * as a style object so the settings panel can preview custom while a different theme is live —
 * themes.css deliberately defines no values for `[data-theme="custom"]`, so a preview with only the
 * attribute set would inherit whatever theme is currently applied.
 */
export function customThemeVars(custom: CustomTheme): Record<string, string> {
  return Object.fromEntries(
    (Object.keys(VAR_MAP) as (keyof CustomTheme)[]).map((k) => [VAR_MAP[k], custom[k]]),
  );
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  let h = hex.trim().replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6) return null;
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return null;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Tint the native (Windows) title bar to match the current theme's surface/text colours. */
function updateNativeTitleBar(): void {
  const cs = getComputedStyle(document.documentElement);
  const bg = hexToRgb(cs.getPropertyValue("--surface"));
  const text = hexToRgb(cs.getPropertyValue("--text"));
  if (!bg || !text) return;
  invoke("set_titlebar_color", {
    r: bg.r, g: bg.g, b: bg.b,
    tr: text.r, tg: text.g, tb: text.b,
  }).catch(() => {
    // Non-Windows / non-Tauri: no native title bar to tint.
  });
}

/** Kept in step with the transition duration in index.css (`html.theme-fade`). */
const THEME_FADE_MS = 240;
let fadeTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Arm the cross-fade for one theme change.
 *
 * The class has to come off again: left on, it would slow every hover and press in the app to a
 * quarter second. Re-arming while a fade is already running restarts the timer rather than stacking
 * a second one, so flicking through themes in the picker stays smooth instead of cutting each fade
 * short at the previous switch's deadline.
 */
function beginThemeFade(root: HTMLElement): void {
  root.classList.add("theme-fade");
  if (fadeTimer !== null) clearTimeout(fadeTimer);
  fadeTimer = setTimeout(() => {
    fadeTimer = null;
    root.classList.remove("theme-fade");
  }, THEME_FADE_MS);
}

/**
 * Apply a theme to <html>: set the data-theme attribute and, for custom, inline vars.
 *
 * `animate` cross-fades the colour change. It is opt-in because the two callers that must not fade
 * outnumber the ones that should: hydration would fade the default theme into the saved one on every
 * launch (reading as a flash of the wrong theme), and dragging a custom colour picker would smear
 * every sample behind the cursor instead of tracking it.
 */
export function applyTheme(theme: ThemeName, custom: CustomTheme, animate = false): void {
  const root = document.documentElement;
  if (animate) beginThemeFade(root);
  root.dataset.theme = theme;

  // Always clear any previously-inlined custom vars first.
  for (const cssVar of Object.values(VAR_MAP)) {
    root.style.removeProperty(cssVar);
  }
  if (theme === "custom") {
    for (const key of Object.keys(VAR_MAP) as (keyof CustomTheme)[]) {
      root.style.setProperty(VAR_MAP[key], custom[key]);
    }
  }

  updateNativeTitleBar();
}
