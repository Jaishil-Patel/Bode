import { useMemo, useRef } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useViewer } from "../store/viewerStore";
import SourceEditor from "../components/SourceEditor";
import { FlowNotes, useStickNotes } from "../notes/NoteLayer";
import type { NoteSurface } from "../notes/surface";

/**
 * Markdown tab view. Shows the reflowed, themed preview by default and swaps to the source
 * editor when `textEditing` is on (toggled from the toolbar / Ctrl+E). The rendered HTML is
 * pre-escaped in the store by renderMarkdown. PDF-specific chrome is gated on `doc` elsewhere.
 */
export default function MarkdownView() {
  const previewHtml = useViewer((s) => s.previewHtml);
  const textSource = useViewer((s) => s.textSource);
  const editing = useViewer((s) => s.textEditing);

  /*
   * Sticky notes are stuck to the column of text, measured from its top-left corner: they scroll
   * with it, and stay beside the same paragraph when a wider window moves the column over.
   */
  const scrollRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const noteSurface = useMemo<NoteSurface>(
    () => ({
      bounds: () => scrollRef.current?.getBoundingClientRect() ?? new DOMRect(),
      fromClient: (x, y) => {
        const r = columnRef.current?.getBoundingClientRect();
        return r ? { x: x - r.left, y: y - r.top } : null;
      },
    }),
    [],
  );
  useStickNotes(textSource != null && !editing ? noteSurface : null);

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
    <div ref={scrollRef} className="h-full overflow-auto">
      <div ref={columnRef} className="relative mx-auto max-w-3xl">
        <article
          onClick={onClick}
          className="markdown-body px-8 py-10"
          dangerouslySetInnerHTML={{ __html: previewHtml ?? "" }}
        />
        <FlowNotes />
      </div>
    </div>
  );
}
