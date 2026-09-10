/*
 * Our own window caption, because Windows will not give us the one we want.
 *
 * The native title bar can be tinted, but only to a single flat colour — there is no API that
 * paints a gradient into it. Under Glass that meant a flat band sitting on top of a bar whose
 * whole character is that it is *not* flat, and the join between them read as a seam no matter how
 * carefully the flat colour was matched to the average beneath it.
 *
 * So the window is undecorated and the caption is drawn here instead. Nothing about the gradient is
 * reproduced or matched: this bar is inside the same `.bg-bg` element as everything else, so the
 * composition simply continues through it, and "matching" stops being a problem anyone has to
 * solve. It carries the same `.glass` treatment as the toolbar below it for the same reason — two
 * strips of identical frost over one continuous ground read as a single pane.
 *
 * What undecorating costs, and where each piece went:
 *   - dragging and double-click-to-maximise: `data-tauri-drag-region`, handled by Tauri itself
 *   - the resize edges: tao hit-tests those for undecorated resizable windows, so they survive
 *   - Snap Layouts (the tiling flyout on hovering maximise): needs the window to answer a Win32
 *     hit-test with HTMAXBUTTON, which is `set_caption_button_rect` in lib.rs — this component's
 *     job is only to report where the button ended up.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { isAndroid } from "../platform/files";

/* Windows draws its caption glyphs from Segoe MDL2 at 10px. These are the same shapes as paths, so
   the bar does not depend on a font that only exists on one OS. */
const IconMinimise = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
    <rect x="0" y="4.5" width="10" height="1" fill="currentColor" />
  </svg>
);
const IconMaximise = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
    <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
  </svg>
);
/* The offset pair Windows uses for "restore": the sheet behind, and the one in front of it. */
const IconRestore = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
    <path d="M2.5 2.5V0.5H9.5V7.5H7.5" fill="none" stroke="currentColor" strokeWidth="1" />
    <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
  </svg>
);
const IconClose = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
    <path d="M0.5 0.5L9.5 9.5M9.5 0.5L0.5 9.5" stroke="currentColor" strokeWidth="1.1" />
  </svg>
);

/*
 * `getCurrentWindow` reads Tauri internals that a plain browser does not have, and throws rather
 * than returning nothing. Running the frontend under `npm run dev` is a normal thing to do here, so
 * every call goes through this and the caption simply renders inert instead of taking the app down.
 */
function currentWindow() {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

export default function TitleBar() {
  const [maximised, setMaximised] = useState(false);
  const maxBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (isAndroid()) return;
    const win = currentWindow();
    if (!win) return;
    let stop: (() => void) | undefined;
    // The icon has to follow the window however it was changed — our button, a drag to the top of
    // the screen, Win+Up, or a snap layout — so it is driven by the window's own resize event.
    const sync = () => void win.isMaximized().then(setMaximised).catch(() => {});
    sync();
    win.onResized(sync).then((un) => {
      stop = un;
    }).catch(() => {});
    return () => stop?.();
  }, []);

  /*
   * Tell Rust where the maximise button is, in physical pixels relative to the window.
   *
   * Snap Layouts is not something a web page can offer: Windows shows the flyout when the window
   * itself reports the cursor is over its maximise button, which is a WM_NCHITTEST answer. Rust
   * can only give that answer if it knows the rect, and only the layout here knows the rect —
   * hence the round trip. Re-measured on resize because the button is pinned to the right edge.
   */
  const reportRect = useCallback(() => {
    if (isAndroid() || !maxBtn.current) return;
    const r = maxBtn.current.getBoundingClientRect();
    const s = window.devicePixelRatio || 1;
    invoke("set_caption_button_rect", {
      x: Math.round(r.left * s),
      y: Math.round(r.top * s),
      w: Math.round(r.width * s),
      h: Math.round(r.height * s),
    }).catch(() => {
      // Not Windows, or the command is unavailable: the button still works, just without the flyout.
    });
  }, []);

  useEffect(() => {
    reportRect();
    window.addEventListener("resize", reportRect);
    return () => window.removeEventListener("resize", reportRect);
  }, [reportRect, maximised]);

  if (isAndroid()) return null;

  const win = currentWindow();
  // 46x32 per button is the Windows caption metric; matching it is what stops the bar reading as a
  // web imitation of a title bar rather than as the title bar.
  const btn =
    "flex h-8 w-[46px] shrink-0 items-center justify-center text-text/80 transition-colors hover:bg-surface-2 hover:text-text";

  return (
    /*
     * No `.glass` and no fill of its own. The frost belongs to the pane in App that holds this and
     * the toolbar together — two adjacent backdrop-filters each clamp their blur at their own edge,
     * and that discontinuity along the shared border is exactly the seam this bar is meant not to
     * have. One filter over both, and there is nothing to line up.
     */
    <div data-tauri-drag-region className="no-select relative flex h-8 shrink-0 items-center">
      {/* The identity is the app's, not the document's — the tab strip and the toolbar already say
          which file is open, and a caption that renames itself is the thing you cannot aim at.
          A drag region like the rest of the bar: on Windows everything but the buttons drags. */}
      <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-2 px-2.5">
        <img
          src="/logo.png"
          alt=""
          aria-hidden
          draggable={false}
          className="h-4 w-4 shrink-0 rounded-[3px]"
        />
        <span className="truncate text-xs font-medium text-muted">Bode</span>
      </div>
      <button className={btn} title="Minimise" onClick={() => void win?.minimize()}>
        <IconMinimise />
      </button>
      <button
        ref={maxBtn}
        className={btn}
        title={maximised ? "Restore" : "Maximise"}
        onClick={() => void win?.toggleMaximize()}
      >
        {maximised ? <IconRestore /> : <IconMaximise />}
      </button>
      <button
        className={`${btn} hover:!bg-[#c42b1c] hover:!text-white`}
        title="Close"
        onClick={() => void win?.close()}
      >
        <IconClose />
      </button>
    </div>
  );
}
