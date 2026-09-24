import { useCallback, useRef, useState } from "react";
import { useViewer } from "../store/viewerStore";
import { useSettings } from "../settings/useSettings";
import type { OutlineItem } from "../pdf/usePdfDocument";
import { IconChevronRight } from "./icons";
import PageThumb from "./PageThumb";
import PageMenu from "./PageMenu";
import type { PageRef } from "../pdf/pageOps";

const THUMB_WIDTH = 140;
const LONG_PRESS_MS = 450;

/**
 * One page in the navigation rail. `pageNumber` is the visible position, `page.srcPage` what to draw.
 * Right-click, or a long-press on touch, opens quick page actions.
 */
function Thumb({
  pageNumber,
  page,
  onMenu,
}: {
  pageNumber: number;
  page: PageRef;
  onMenu: (id: string, x: number, y: number) => void;
}) {
  const currentPage = useViewer((s) => s.currentPage);
  const goToPage = useViewer((s) => s.goToPage);
  const active = currentPage === pageNumber;
  const hold = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  // Set when a long-press opened the menu, so the release that follows doesn't also navigate.
  const held = useRef(false);
  const touch = useRef(false);

  const cancelHold = () => {
    if (hold.current) clearTimeout(hold.current.timer);
    hold.current = null;
  };

  return (
    <button
      onClick={() => {
        if (held.current) {
          held.current = false;
          return;
        }
        goToPage(pageNumber);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        cancelHold();
        // Touch browsers fire this for a long-press too; the finger lifting must not then navigate.
        if (touch.current) held.current = true;
        onMenu(page.id, e.clientX, e.clientY);
      }}
      onPointerDown={(e) => {
        held.current = false;
        touch.current = e.pointerType !== "mouse";
        if (!touch.current) return; // a mouse has a right button for this
        const { clientX: x, clientY: y } = e;
        hold.current = {
          x,
          y,
          timer: setTimeout(() => {
            held.current = true;
            hold.current = null;
            navigator.vibrate?.(10);
            onMenu(page.id, x, y);
          }, LONG_PRESS_MS),
        };
      }}
      onPointerMove={(e) => {
        const h = hold.current;
        if (h && Math.hypot(e.clientX - h.x, e.clientY - h.y) > 8) cancelHold(); // a scroll
      }}
      onPointerUp={cancelHold}
      onPointerCancel={cancelHold}
      className="flex flex-col items-center gap-1 outline-none"
    >
      <PageThumb
        srcPage={page.srcPage}
        rotation={page.rotation}
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
  const { layout, updateLayout } = useSettings();
  const tab = layout.sidebarTab;
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const openMenu = useCallback((id: string, x: number, y: number) => setMenu({ id, x, y }), []);
  const closeMenu = useCallback(() => setMenu(null), []);

  return (
    <div className="glass no-select relative z-30 flex h-full w-56 flex-col border-r border-border bg-surface">
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
              <Thumb key={p.id} pageNumber={i + 1} page={p} onMenu={openMenu} />
            ))}
          </div>
        ) : outline.length ? (
          outline.map((n, i) => <OutlineNode key={i} node={n} depth={0} />)
        ) : (
          <p className="px-1 py-4 text-center text-xs text-muted">No outline in this document.</p>
        )}
      </div>
      {menu && <PageMenu pageId={menu.id} at={{ x: menu.x, y: menu.y }} onClose={closeMenu} />}
    </div>
  );
}
