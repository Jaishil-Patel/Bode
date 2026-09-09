/*
 * Whether the document itself is drawn inverted.
 *
 * Themes only ever restyled the app *around* the page: pick OLED and you still got a sheet of
 * white paper burning in the middle of a black screen, which is the one place the reader is
 * actually looking. This is the switch that carries the theme through to the page.
 *
 * A hook rather than a plain function because it has to re-render whatever draws the page when
 * the theme or the preference changes, and both live in the settings store.
 */
import { useSettings } from "./useSettings";
import { isDarkTheme } from "./themes";

/**
 * The CSS/canvas filter that inverts a page, or "" when it should be left alone.
 *
 * `invert(1)` alone turns a page into a photographic negative — blue diagrams come out orange.
 * Following it with a 180° hue rotation puts the hues back roughly where they started, so what
 * changes is the lightness and not the colour scheme. It is the standard pairing for this, and
 * it is close enough to an involution that a colour passed through it twice comes back.
 */
export const INVERT_FILTER = "invert(1) hue-rotate(180deg)";

export function usePageInverted(): boolean {
  const mode = useSettings((s) => s.layout.pageColors);
  const theme = useSettings((s) => s.theme);
  const custom = useSettings((s) => s.customTheme);
  if (mode === "normal") return false;
  if (mode === "inverted") return true;
  return isDarkTheme(theme, custom);
}
