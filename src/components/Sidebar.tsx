import { useEffect, useRef, useState } from "react";
import { useViewer } from "../store/viewerStore";
import { useSettings } from "../settings/useSettings";
import type { OutlineItem } from "../pdf/usePdfDocument";
import { IconChevronRight } from "./icons";

const THUMB_WIDTH = 140;

function Thumb({ pageNumber }: { pageNumber: number }) {
  const { doc, baseSize, currentPage, goToPage } = useViewer();
  const ref = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [seen, setSeen] = useState(false);
  const aspect = baseSize.height / baseSize.width;

  // Render only when scrolled into view.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!seen || !doc) return;
    let cancelled = false;
    (async () => {
      const page = await doc.getPage(pageNumber);
      if (cancelled) return;
      const scale = THUMB_WIDTH / baseSize.width;
      const vp = page.getViewport({ scale });
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      canvas.width = vp.width;
      canvas.height = vp.height;
      try {
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
      } catch {
        /* cancelled */
      }
      page.cleanup();
    })();
    return () => {
      cancelled = true;
    };
  }, [seen, doc, pageNumber, baseSize.width]);

  const active = currentPage === pageNumber;
  return (
    <button
      ref={ref as never}
      onClick={() => goToPage(pageNumber)}
      className="flex flex-col items-center gap-1 outline-none"
    >
      <div
        className={`overflow-hidden rounded border-2 bg-white ${
          active ? "border-accent" : "border-transparent"
        }`}
        style={{ width: THUMB_WIDTH, height: THUMB_WIDTH * aspect }}
      >
        <canvas ref={canvasRef} className="block h-full w-full" />
      </div>
      <span className={`text-xs ${active ? "text-accent" : "text-muted"}`}>{pageNumber}</span>
    </button>
  );
}

function OutlineNode({ node, depth }: { node: OutlineItem; depth: number }) {
  const goToPage = useViewer((s) => s.goToPage);
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
          onClick={() => node.pageIndex != null && goToPage(node.pageIndex + 1)}
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
  const { numPages, outline } = useViewer();
  const { layout, updateLayout } = useSettings();
  const tab = layout.sidebarTab;

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
            {Array.from({ length: numPages }, (_, i) => (
              <Thumb key={i} pageNumber={i + 1} />
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
