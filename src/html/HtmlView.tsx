import { useCallback, useEffect } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useViewer } from "../store/viewerStore";
import { handleFullscreenKey } from "../store/fullscreenStore";
import SourceEditor from "../components/SourceEditor";

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

  // Listeners installed from *this* realm onto the frame's document — the frame runs no scripts of
  // its own. A link click would otherwise be silently swallowed by the sandbox, so mirror
  // MarkdownView and hand external URLs to the OS browser. Reaching contentDocument at all is the
  // only reason for `allow-same-origin` in sandboxed mode — see the warning below.
  const installFrameHandlers = useCallback((e: React.SyntheticEvent<HTMLIFrameElement>) => {
    try {
      const doc = e.currentTarget.contentDocument;
      if (!doc) return;

      // Keys pressed while the frame has focus never reach the app window on their own. Forward
      // the fullscreen ones so F11 works no matter where the user last clicked.
      doc.addEventListener("keydown", (ev) => {
        if (handleFullscreenKey(ev.key)) ev.preventDefault();
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
      const data = e.data as { __bode?: string; key?: string } | null;
      if (data && data.__bode === "key" && typeof data.key === "string") handleFullscreenKey(data.key);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  if (textSource == null) return null; // not an HTML tab

  if (editing) return <SourceEditor />;

  // A page with no background of its own would otherwise paint black text straight onto Bode's
  // dark theme; give it the white canvas a browser would.
  const frameClass = "h-full w-full border-0 bg-white";

  if (trustedUrl) {
    return (
      <iframe
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
    );
  }

  return (
    <iframe
      title={fileName ?? "HTML document"}
      srcDoc={textSource}
      // NEVER add `allow-scripts` here: paired with `allow-same-origin` on a srcdoc document it
      // would give the page full access to Bode's own origin and defeat the sandbox entirely.
      // Running scripts is what trusted mode above is for, on a separate origin.
      sandbox="allow-same-origin"
      onLoad={installFrameHandlers}
      className={frameClass}
    />
  );
}
