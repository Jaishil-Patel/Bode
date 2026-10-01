import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useViewer } from "../store/viewerStore";
import { handleFullscreenKey } from "../store/fullscreenStore";
import SourceEditor from "../components/SourceEditor";
import { frameContextMenu } from "../components/DocumentMenu";
import { FlowNotes, useStickNotes } from "../notes/NoteLayer";
import type { NoteSurface } from "../notes/surface";

/**
 * HTML tab view. Unlike Markdown — which we re-render into Bode's own theme — an HTML file is
 * shown as itself, styles and all, so it goes into a frame rather than the app's DOM.
 *
 * There are two modes, and the difference is what the frame loads:
 *
 * - **Sandboxed** (default). `srcdoc` with no `allow-scripts`, so the document can't run scripts
 *   (inline, external, or event-handler attributes), submit forms, open popups, or navigate the
 *   app away. Bode's strict CSP is inherited by the srcdoc document as a second layer, which also
 *   keeps remote images and stylesheets from loading. Safe for a file of unknown provenance.
 *
 * - **Trusted** (opt-in per tab, via the toolbar). The file is served over the `bodehtml` protocol
 *   so it gets its own origin — its scripts run, `localStorage` works, and relative paths resolve.
 *   Pages that build their whole UI in JavaScript only work here. See the notes in lib.rs for what
 *   still contains it; the short version is that the origin isn't Bode's, the backend only serves
 *   files the user trusted, and Tauri's IPC bootstrap never reaches a subframe.
 */
export default function HtmlView() {
  const textSource = useViewer((s) => s.textSource);
  const fileName = useViewer((s) => s.fileName);
  const editing = useViewer((s) => s.textEditing);
  const trustedUrl = useViewer((s) => s.htmlTrustedUrl);
  const reloadNonce = useViewer((s) => s.htmlReloadNonce);

  /*
   * Sticky notes. The page scrolls inside its frame, where our notes cannot go, so they are drawn
   * over the frame and moved by however far it has scrolled: in document px, a note stays on the
   * same spot of the page. The sandboxed frame's scrolling is read straight off it; a trusted page
   * is on another origin and reports its own (see KEY_FORWARDER in lib.rs).
   */
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [scroll, setScroll] = useState({ x: 0, y: 0 });
  const scrollRef = useRef(scroll);
  scrollRef.current = scroll;
  // A different page, or the same one loaded again, starts at its top.
  useEffect(() => setScroll({ x: 0, y: 0 }), [textSource, trustedUrl, reloadNonce]);
  const noteSurface = useMemo<NoteSurface>(
    () => ({
      bounds: () => frameRef.current?.getBoundingClientRect() ?? new DOMRect(),
      fromClient: (x, y) => {
        const r = frameRef.current?.getBoundingClientRect();
        if (!r) return null;
        return {
          x: x - r.left + scrollRef.current.x,
          y: y - r.top + scrollRef.current.y,
        };
      },
    }),
    [],
  );
  useStickNotes(textSource != null && !editing ? noteSurface : null);

  /*
   * The wheel over a note scrolls the page under it, as it would on a PDF or Markdown document,
   * unless it is over writing that has scrolling of its own to do.
   */
  const onWheel = (e: React.WheelEvent) => {
    const editor = (e.target as Element).closest(".note-editor");
    if (editor && editor.scrollHeight > editor.clientHeight) return;
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    try {
      win.scrollBy(e.deltaX, e.deltaY);
    } catch {
      // A trusted page is on its own origin: ask it to scroll itself.
      win.postMessage({ __bode: "scrollBy", x: e.deltaX, y: e.deltaY }, "*");
    }
  };

  // Listeners installed from *this* realm onto the frame's document — the frame runs no scripts of
  // its own. A link click would otherwise be silently swallowed by the sandbox, so mirror
  // MarkdownView and hand external URLs to the OS browser. Reaching contentDocument at all is the
  // only reason for `allow-same-origin` in sandboxed mode — see the warning below.
  const installFrameHandlers = useCallback((e: React.SyntheticEvent<HTMLIFrameElement>) => {
    try {
      const frame = e.currentTarget;
      const doc = frame.contentDocument;
      if (!doc) return;

      // Bode's right-click menu rather than the browser's, as on the rest of the document.
      doc.addEventListener("contextmenu", (ev) => frameContextMenu(frame, ev));

      const win = doc.defaultView;
      win?.addEventListener("scroll", () => setScroll({ x: win.scrollX, y: win.scrollY }), {
        passive: true,
      });

      // Keys pressed while the frame has focus never reach the app window on their own. Forward
      // the fullscreen ones so F11 works no matter where the user last clicked, and the tab
      // switcher's (Ctrl+Tab, and the Ctrl release that finishes it) so it does too.
      const forward = (ev: KeyboardEvent) =>
        window.dispatchEvent(
          new KeyboardEvent(ev.type, {
            key: ev.key,
            ctrlKey: ev.ctrlKey,
            shiftKey: ev.shiftKey,
          }),
        );
      doc.addEventListener("keydown", (ev) => {
        if (ev.key === "Tab" && ev.ctrlKey) {
          ev.preventDefault();
          forward(ev);
        } else if (handleFullscreenKey(ev.key)) ev.preventDefault();
      });
      doc.addEventListener("keyup", (ev) => {
        if (ev.key === "Control") forward(ev);
      });

      doc.addEventListener("click", (ev) => {
        const anchor = (ev.target as HTMLElement | null)?.closest?.("a");
        const href = anchor?.getAttribute("href");
        if (!href) return;
        ev.preventDefault();
        if (/^(https?|mailto):/i.test(href)) openUrl(href).catch(() => {});
        // In-page anchors (#section) are left to the frame's own scrolling.
      });
    } catch {
      // Document not reachable — links are simply inert, which is the safe outcome.
    }
  }, []);

  // A trusted page sits on its own origin, so neither its keys nor its document are reachable from
  // here. It is served with a small forwarder (see serve_trusted_html in lib.rs) that posts the
  // fullscreen keys up to this window instead.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data as {
        __bode?: string;
        key?: string;
        x?: number;
        y?: number;
      } | null;
      if (data && data.__bode === "key" && typeof data.key === "string")
        handleFullscreenKey(data.key);
      if (
        data &&
        data.__bode === "scroll" &&
        e.source === frameRef.current?.contentWindow &&
        typeof data.x === "number" &&
        typeof data.y === "number"
      )
        setScroll({ x: data.x, y: data.y });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  if (textSource == null) return null; // not an HTML tab

  if (editing) return <SourceEditor />;

  // A page with no background of its own would otherwise paint black text straight onto Bode's
  // dark theme; give it the white canvas a browser would.
  const frameClass = "h-full w-full border-0 bg-white";

  const notes = <FlowNotes dx={-scroll.x} dy={-scroll.y} />;

  if (trustedUrl) {
    return (
      <div className="relative h-full w-full overflow-hidden" onWheel={onWheel}>
        <iframe
          ref={frameRef}
          // Re-keying on the nonce forces a fresh load after the source is saved.
          key={reloadNonce}
          title={fileName ?? "HTML document"}
          src={reloadNonce ? `${trustedUrl}?v=${reloadNonce}` : trustedUrl}
          // `allow-same-origin` here keeps the document on its OWN origin (bodehtml), which is not
          // Bode's — that's what gives it localStorage without any access to the app. Top-level
          // navigation stays blocked, so the page can't replace the Bode window.
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"
          className={frameClass}
        />
        {notes}
      </div>
    );
  }

  return (
    <div className="relative h-full w-full overflow-hidden" onWheel={onWheel}>
      <iframe
        ref={frameRef}
        title={fileName ?? "HTML document"}
        srcDoc={textSource}
        // NEVER add `allow-scripts` here: paired with `allow-same-origin` on a srcdoc document it
        // would give the page full access to Bode's own origin and defeat the sandbox entirely.
        // Running scripts is what trusted mode above is for, on a separate origin.
        sandbox="allow-same-origin"
        onLoad={installFrameHandlers}
        className={frameClass}
      />
      {notes}
    </div>
  );
}
