import { isAndroid } from "./files";

/**
 * Open a document in a brand-new OS window (the "separate windows" open mode).
 *
 * Each window loads the same frontend with the file path passed as a `?file=` query param,
 * which App reads on startup. We avoid a Rust round-trip by using the JS WebviewWindow API.
 * Returns false when a new window can't be created (e.g. Android), so callers can fall back
 * to opening the file as a tab instead.
 */
export async function openInNewWindow(
  path: string,
  /** Where to put the new window, in screen CSS pixels. Used when a tab is dropped on the desktop. */
  at?: { x: number; y: number },
): Promise<boolean> {
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
      ...(at ? { x: at.x, y: at.y } : {}),
    });
    return true;
  } catch {
    return false;
  }
}

/*
 * Dragging a tab out of the strip and onto the desktop.
 *
 * A webview can only see inside its own window, and HTML drag-and-drop does not cross OS windows,
 * so the drop point has to be resolved by the backend: it knows every Bode window's frame. These
 * two helpers are the whole of the frontend's side of that conversation.
 */

/**
 * True in a window spawned to hold a torn-off document, rather than the app's original window.
 * Those carry their file in the URL, which is also what App opens on startup.
 */
export const isSpawnedWindow = () =>
  typeof window !== "undefined" && new URLSearchParams(window.location.search).has("file");

/**
 * Hand `path` to whichever other Bode window sits under the given screen point, if any.
 * Returns false when the drop landed on empty desktop (or on this window), leaving it to the
 * caller to open a new window instead.
 */
export async function handOffToWindowAt(
  path: string,
  screenX: number,
  screenY: number,
): Promise<boolean> {
  if (isAndroid()) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    // Pointer screen coordinates are CSS pixels; window frames are physical pixels.
    const dpr = window.devicePixelRatio || 1;
    const label = await invoke<string | null>("window_at_point", {
      x: Math.round(screenX * dpr),
      y: Math.round(screenY * dpr),
      exclude: getCurrentWindow().label,
    });
    if (!label) return false;
    await invoke("send_file_to_window", { label, path });
    return true;
  } catch {
    return false;
  }
}

/**
 * Close this window if it was spawned to hold a single document and that document has just left
 * it. The app's "main" window stays — closing it would quit Bode out from under the drag.
 */
export async function closeIfSpawnedWindow(): Promise<void> {
  if (isAndroid()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    if (win.label !== "main") await win.close();
  } catch {
    // Leave the window up; an empty viewer is a far better outcome than a thrown drag.
  }
}

/**
 * Put this OS window into (or out of) real fullscreen — the F11 behaviour, where the window covers
 * the screen and loses its title bar. Fire-and-forget: platforms without a desktop window manager
 * (Android) simply keep their normal window, and the caller still hides the app's own chrome.
 */
export async function setWindowFullscreen(on: boolean): Promise<void> {
  if (isAndroid()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setFullscreen(on);
  } catch {
    // Nothing to recover from — in-app fullscreen still applies.
  }
}
