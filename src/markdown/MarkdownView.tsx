import { openUrl } from "@tauri-apps/plugin-opener";
import { useViewer } from "../store/viewerStore";
import SourceEditor from "../components/SourceEditor";

/**
 * Markdown tab view. Shows the reflowed, themed preview by default and swaps to the source
 * editor when `textEditing` is on (toggled from the toolbar / Ctrl+E). The rendered HTML is
 * pre-escaped in the store by renderMarkdown. PDF-specific chrome is gated on `doc` elsewhere.
 */
export default function MarkdownView() {
  const previewHtml = useViewer((s) => s.previewHtml);
  const textSource = useViewer((s) => s.textSource);
  const editing = useViewer((s) => s.textEditing);

  if (textSource == null) return null; // not a Markdown tab

  if (editing) return <SourceEditor />;

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
        dangerouslySetInnerHTML={{ __html: previewHtml ?? "" }}
      />
    </div>
  );
}
