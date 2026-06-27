import { openUrl } from "@tauri-apps/plugin-opener";
import { useViewer } from "../store/viewerStore";

/**
 * Markdown tab view. Shows the reflowed, themed preview by default and swaps to a plain-text
 * source editor when `mdEditing` is on (toggled from the toolbar / Ctrl+E). The rendered HTML is
 * pre-escaped in the store by renderMarkdown. PDF-specific chrome is gated on `doc` elsewhere.
 */
export default function MarkdownView() {
  const mdHtml = useViewer((s) => s.mdHtml);
  const mdSource = useViewer((s) => s.mdSource);
  const editing = useViewer((s) => s.mdEditing);
  const setMdSource = useViewer((s) => s.setMdSource);

  if (mdSource == null) return null; // not a Markdown tab

  if (editing) {
    return (
      <textarea
        value={mdSource}
        onChange={(e) => setMdSource(e.target.value)}
        spellCheck={false}
        autoFocus
        className="h-full w-full resize-none bg-bg px-8 py-10 font-mono text-sm leading-relaxed text-text outline-none"
        style={{ tabSize: 2 }}
      />
    );
  }

  // A link click would otherwise navigate the whole webview away from the app (no way back).
  // Intercept anchors and hand external URLs to the OS browser instead.
  const onClick = (e: React.MouseEvent<HTMLElement>) => {
    const anchor = (e.target as HTMLElement).closest("a");
    const href = anchor?.getAttribute("href");
    if (!href) return;
    e.preventDefault();
    if (/^(https?|mailto):/i.test(href)) openUrl(href).catch(() => {});
    // In-document anchors (#heading) have no targets in our output, so there's nothing to do.
  };

  return (
    <div className="h-full overflow-auto">
      <article
        onClick={onClick}
        className="markdown-body mx-auto max-w-3xl px-8 py-10"
        dangerouslySetInnerHTML={{ __html: mdHtml ?? "" }}
      />
    </div>
  );
}
