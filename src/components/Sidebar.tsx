import { useState } from "react";
import { useViewer } from "../store/viewerStore";
import { useSettings } from "../settings/useSettings";
import type { OutlineItem } from "../pdf/usePdfDocument";
import { IconChevronRight } from "./icons";
import PageThumb from "./PageThumb";
import PageOrganizer from "./PageOrganizer";

const THUMB_WIDTH = 140;

/** One page in the navigation rail. `pageNumber` is the visible position, `srcPage` what to draw. */
function Thumb({ pageNumber, srcPage }: { pageNumber: number; srcPage: number }) {
  const currentPage = useViewer((s) => s.currentPage);
  const goToPage = useViewer((s) => s.goToPage);
  const active = currentPage === pageNumber;

  return (
    <button
      onClick={() => goToPage(pageNumber)}
      className="flex flex-col items-center gap-1 outline-none"
    >
      <PageThumb
        srcPage={srcPage}
        width={THUMB_WIDTH}
        className={`border-2 ${active ? "border-accent" : "border-transparent"}`}
      />
      <span className={`text-xs ${active ? "text-accent" : "text-muted"}`}>{pageNumber}</span>
    </button>
  );
}

function OutlineNode({ node, depth }: { node: OutlineItem; depth: number }) {
  // Outline destinations are page indexes in the source document, so they go through
  // goToPdfDestination, which maps them onto whatever position that page now holds.
  const goToPdfDestination = useViewer((s) => s.goToPdfDestination);
  const [open, setOpen] = useState(true);
  const hasKids = node.items.length > 0;
  return (
    <div>
      <div
        className="flex items-center gap-1 rounded px-1 py-1 hover:bg-surface-2"
        style={{ paddingLeft: depth * 12 + 4 }}
      >
        {hasKids ? (
          <button onClick={() => setOpen((o) => !o)} className="text-muted">
            <IconChevronRight className={`transition-transform ${open ? "rotate-90" : ""}`} />
          </button>
        ) : (
          <span className="w-[18px]" />
        )}
        <button
          onClick={() => node.pageIndex != null && goToPdfDestination(node.pageIndex)}
          className="flex-1 truncate text-left text-sm text-text"
          title={node.title}
        >
          {node.title}
        </button>
      </div>
      {open && hasKids && (
        <div>
          {node.items.map((c, i) => (
            <OutlineNode key={i} node={c} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function Sidebar() {
  const { pages, outline } = useViewer();
  const organizeOpen = useViewer((s) => s.organizeOpen);
  const doc = useViewer((s) => s.doc);
  const { layout, updateLayout } = useSettings();
  const tab = layout.sidebarTab;

  // Organize mode takes over the whole rail: it needs the width, and mixing selection checkboxes
  // into the navigation list would make a plain click ambiguous.
  if (organizeOpen && doc) {
    return (
      <div className="no-select flex h-full w-56 flex-col border-r border-border bg-surface">
        <PageOrganizer />
      </div>
    );
  }

  return (
    <div className="no-select flex h-full w-56 flex-col border-r border-border bg-surface">
      <div className="flex border-b border-border">
        {(["thumbnails", "outline"] as const).map((t) => (
          <button
            key={t}
            onClick={() => updateLayout({ sidebarTab: t })}
            className={`flex-1 py-2 text-xs capitalize transition-colors ${
              tab === t ? "border-b-2 border-accent text-accent" : "text-muted hover:text-text"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto p-3">
        {tab === "thumbnails" ? (
          <div className="flex flex-col items-center gap-3">
            {pages.map((p, i) => (
              <Thumb key={p.id} pageNumber={i + 1} srcPage={p.srcPage} />
            ))}
          </div>
        ) : outline.length ? (
          outline.map((n, i) => <OutlineNode key={i} node={n} depth={0} />)
        ) : (
          <p className="px-1 py-4 text-center text-xs text-muted">No outline in this document.</p>
        )}
      </div>
    </div>
  );
}
