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

export const BUILT_IN_THEMES: { name: ThemeName; label: string; swatch: string }[] = [
  { name: "light", label: "Light", swatch: "#ffffff" },
  { name: "dark", label: "Dark", swatch: "#232428" },
  { name: "sepia", label: "Sepia", swatch: "#efe6d4" },
  { name: "oled", label: "OLED Black", swatch: "#000000" },
  { name: "custom", label: "Custom", swatch: "#6366f1" },
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

/** Apply a theme to <html>: set the data-theme attribute and, for custom, inline vars. */
export function applyTheme(theme: ThemeName, custom: CustomTheme): void {
  const root = document.documentElement;
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
