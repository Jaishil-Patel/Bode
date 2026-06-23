import { isAndroid } from "./files";

/**
 * Open a PDF in a brand-new OS window (the "separate windows" open mode).
 *
 * Each window loads the same frontend with the file path passed as a `?file=` query param,
 * which App reads on startup. We avoid a Rust round-trip by using the JS WebviewWindow API.
 * Returns false when a new window can't be created (e.g. Android), so callers can fall back
 * to opening the file as a tab instead.
 */
export async function openInNewWindow(path: string): Promise<boolean> {
  // Multi-window isn't available on the Android build.
  if (isAndroid()) return false;
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const label = `pdf-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    new WebviewWindow(label, {
      url: `index.html?file=${encodeURIComponent(path)}`,
      title: "Bode",
      width: 1200,
      height: 800,
      minWidth: 640,
      minHeight: 480,
      backgroundColor: "#1a1a1a",
    });
    return true;
  } catch {
    return false;
  }
}
