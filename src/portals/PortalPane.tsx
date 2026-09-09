/*
 * One pinned region, floating over the document.
 *
 * The region is re-rendered from the PDF rather than copied off the page canvas. Copying would
 * have been less code, but a portal's whole purpose is to stay readable while you are somewhere
 * else in the document — and "somewhere else" is exactly when virtualization has thrown that
 * page's canvas away. Rendering from the document means a portal is independent of what happens
 * to be on screen, and can be drawn sharper than the page it came from.
 */
import { useEffect, useRef, useState } from "react";
import type { PdfDocument } from "../pdf/pdfWorker";
import { IconClose, IconChevronDown, IconChevronRight } from "../components/icons";
import { INVERT_FILTER, usePageInverted } from "../settings/usePageColors";
import { PORTAL_Z_BASE, PORTAL_Z_TOP, TITLE_H, usePortals, type Portal } from "./usePortals";

/**
 * How much sharper than its opening size a portal is rendered.
 *
 * The pane can be resized after the fact and nobody wants a re-render mid-drag, so it is drawn
 * with room to grow and scaled down by CSS until it settles. Capped because the source is a
 * region of a page: a small crop asked for at a huge scale is a very large canvas for nothing.
 */
const OVERSAMPLE = 2;
const MAX_SCALE = 6;
const MIN_W = 160;
const MIN_H = 100;

export default function PortalPane({
  portal,
  stack,
  doc,
  docKey,
  srcPage,
  onJump,
}: {
  portal: Portal;
  /** Position among the open portals, lowest first. Mapped into a fixed band of z-indexes. */
  stack: number;
  doc: PdfDocument;
  docKey: string;
  /** 1-based page in the source document, which differs from the viewer's page once pages move. */
  srcPage: number;
  onJump: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { update, close, raise } = usePortals();
  const inverted = usePageInverted();
  const [rendering, setRendering] = useState(true);

  const bodyH = portal.h - TITLE_H;

  // Render the region once, at the size it opened at times an oversample. Deliberately not a
  // dependency of the pane's width: resizing scales the bitmap it already has, which is instant,
  // and re-rendering on every pixel of a drag would be neither.
  useEffect(() => {
    let cancelled = false;
    let task: ReturnType<Awaited<ReturnType<PdfDocument["getPage"]>>["render"]> | null = null;
    (async () => {
      setRendering(true);
      const page = await doc.getPage(srcPage);
      if (cancelled) return;
      const dpr = window.devicePixelRatio || 1;
      const target = Math.min(MAX_SCALE, (portal.w / Math.max(1, portal.rect.w)) * OVERSAMPLE);
      const vp = page.getViewport({ scale: target });
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;

      canvas.width = Math.max(1, Math.floor(portal.rect.w * target * dpr));
      canvas.height = Math.max(1, Math.floor(portal.rect.h * target * dpr));

      /*
       * Render the whole page, but shifted so the region lands at the canvas origin.
       *
       * pdf.js has no crop of its own; the supported way to draw part of a page is to give it a
       * transform that moves the part you want into view. Everything outside the canvas is
       * clipped by the canvas itself and costs nothing to "draw".
       */
      task = page.render({
        canvasContext: ctx,
        viewport: vp,
        transform: [dpr, 0, 0, dpr, -portal.rect.x * target * dpr, -portal.rect.y * target * dpr],
      });
      try {
        await task.promise;
      } catch {
        return; // cancelled
      }
      if (!cancelled) setRendering(false);
      page.cleanup();
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, srcPage, portal.rect.x, portal.rect.y, portal.rect.w, portal.rect.h]);

  /*
   * Shared by the title-bar drag and the resize grip: both move numbers in the store.
   *
   * The title bar is draggable along its whole length, including the page label. It used to
   * carry a button there that swallowed the press, and because that button was the flexible one
   * it filled the bar — leaving only the few pixels between the controls to grab, which is
   * findable with a mouse and impossible with a thumb. So the label is plain text now, and a
   * press that goes nowhere is treated as a tap and jumps to the source instead.
   */
  const TAP_SLOP = 4;
  const startDrag = (e: React.PointerEvent, mode: "move" | "resize", onTap?: () => void) => {
    e.preventDefault();
    e.stopPropagation();
    raise(docKey, portal.id);
    const sx = e.clientX;
    const sy = e.clientY;
    const from = { x: portal.x, y: portal.y, w: portal.w, h: portal.h };
    let moved = false;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (Math.abs(dx) > TAP_SLOP || Math.abs(dy) > TAP_SLOP) moved = true;
      if (mode === "move") {
        update(docKey, portal.id, {
          x: Math.min(Math.max(0, from.x + dx), window.innerWidth - 60),
          y: Math.min(Math.max(0, from.y + dy), window.innerHeight - TITLE_H),
        });
      } else {
        update(docKey, portal.id, {
          w: Math.max(MIN_W, from.w + dx),
          h: Math.max(MIN_H + TITLE_H, from.h + dy),
        });
      }
    };
    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      if (!moved) onTap?.();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  return (
    <div
      onPointerDown={() => raise(docKey, portal.id)}
      className="animate-fade-in fixed flex flex-col overflow-hidden rounded-xl border border-border shadow-2xl"
      style={{
        left: portal.x,
        top: portal.y,
        width: portal.w,
        height: portal.folded ? TITLE_H : portal.h,
        zIndex: Math.min(PORTAL_Z_BASE + stack, PORTAL_Z_TOP),
        background: "var(--surface)",
      }}
    >
      <div
        onPointerDown={(e) => startDrag(e, "move", onJump)}
        title="Drag to move · tap to go to where this came from"
        className="no-select flex shrink-0 cursor-grab items-center gap-1 px-1.5 active:cursor-grabbing"
        style={{ height: TITLE_H, background: "var(--surface-2)", touchAction: "none" }}
      >
        <button
          title={portal.folded ? "Unfold" : "Fold away"}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => update(docKey, portal.id, { folded: !portal.folded })}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted hover:text-text"
        >
          {portal.folded ? (
            <IconChevronRight className="h-3.5 w-3.5" />
          ) : (
            <IconChevronDown className="h-3.5 w-3.5" />
          )}
        </button>
        {/* Plain text, not a button: it is the largest part of the bar and has to stay part of
            the drag surface. Tapping it still jumps, via the tap detection in `startDrag`. */}
        <span className="min-w-0 flex-1 truncate text-xs text-muted">Page {portal.pageIndex + 1}</span>
        <button
          title="Close"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => close(docKey, portal.id)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted hover:text-text"
        >
          <IconClose className="h-3.5 w-3.5" />
        </button>
      </div>

      {/*
        * Hidden while folded, never unmounted.
        *
        * A canvas holds its pixels in the element. Taking it out of the tree and putting it back
        * hands React a brand-new, blank one — and the render effect has no reason to run again,
        * since the document, the page and the region it depends on have not changed. So folding
        * a portal and reopening it emptied it. Keeping the node and hiding its container costs
        * nothing and keeps the bitmap.
        */}
      <div
        className="relative min-h-0 flex-1 overflow-hidden"
        style={{
          background: inverted ? "#0d0d0d" : "#fff",
          display: portal.folded ? "none" : undefined,
        }}
      >
        <canvas
          ref={canvasRef}
          className="block h-full w-full"
          style={{ objectFit: "contain", filter: inverted ? INVERT_FILTER : undefined }}
        />
        {rendering && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-muted">
            Rendering…
          </div>
        )}
        {/* Resize grip. Its own pointer handling, so a drag here never reads as a move. */}
        <div
          onPointerDown={(e) => startDrag(e, "resize")}
          title="Resize"
          style={{
            position: "absolute",
            right: 0,
            bottom: 0,
            // Sized for a fingertip rather than a cursor; it is the only other thing on the pane
            // you have to hit precisely.
            width: 24,
            height: 24,
            cursor: "nwse-resize",
            touchAction: "none",
            background:
              "linear-gradient(135deg, transparent 50%, color-mix(in srgb, var(--muted) 55%, transparent) 50%)",
          }}
        />
      </div>
      <span className="sr-only">{`Pinned region from page ${portal.pageIndex + 1}, height ${Math.round(bodyH)}px`}</span>
    </div>
  );
}
