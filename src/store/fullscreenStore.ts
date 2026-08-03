import { create } from "zustand";
import { setWindowFullscreen } from "../platform/window";

/**
 * Fullscreen mode — what F11 does in a browser: the OS window fills the screen and Bode's chrome
 * (toolbar, tab bar, sidebar) gets out of the way, leaving only the document. Applies to every
 * document type; a PDF gets the presentation mode its viewer peers have, and every toolbar control
 * it hides has a keyboard equivalent (zoom, paging, find, sidebar, palette).
 *
 * Deliberately kept out of the persisted settings store: this is transient view state, so quitting
 * while fullscreen can never bring the app back up with no way to reach the toolbar.
 */
interface FullscreenState {
  fullscreen: boolean;
  setFullscreen: (on: boolean) => void;
  toggleFullscreen: () => void;
}

export const useFullscreen = create<FullscreenState>((set, get) => ({
  fullscreen: false,
  setFullscreen: (on) => {
    if (get().fullscreen === on) return;
    set({ fullscreen: on });
    setWindowFullscreen(on);
  },
  toggleFullscreen: () => get().setFullscreen(!get().fullscreen),
}));

/**
 * Handle F11 / Escape pressed *inside an HTML frame* — the sandboxed one directly, or a trusted
 * page on its own origin by way of postMessage. Returns true when the key was used, so the caller
 * can preventDefault only then.
 *
 * App has its own copy of this for the app window, where Escape additionally defers to whatever
 * modal is open. There's no such check here: for the frame to see a key at all, focus has to be in
 * the page rather than in a search bar or dialog.
 */
export function handleFullscreenKey(key: string): boolean {
  const { fullscreen, setFullscreen, toggleFullscreen } = useFullscreen.getState();
  if (key === "F11") {
    toggleFullscreen();
    return true;
  }
  if (key === "Escape" && fullscreen) {
    setFullscreen(false);
    return true;
  }
  return false;
}
