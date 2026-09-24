import { useEffect, useRef, useState } from "react";
import { INVERT_FILTER, usePageInverted } from "../settings/usePageColors";
import { useViewer, displaySize } from "../store/viewerStore";
import { rotatedViewport, type PageRef } from "../pdf/pageOps";

/**
 * A lazily-rendered page bitmap, shared by the thumbnail rail and the page organizer.
 *
 * Takes a *source* page number, not a visible one, so reordering the manifest never changes what a
 * card renders — combined with keying cards by `PageRef.id`, moving a page moves its existing
 * canvas rather than re-rasterising it.
 */
export default function PageThumb({
  srcPage,
  rotation = 0,
  width,
  className,
}: {
  srcPage: number;
  /** Extra rotation from the page manifest, so a turned page shows turned. */
  rotation?: PageRef["rotation"];
  width: number;
  className?: string;
}) {
  const doc = useViewer((s) => s.doc);
  const baseSize = useViewer((s) => s.baseSize);
  const ref = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inverted = usePageInverted();
  const [seen, setSeen] = useState(false);
  const shown = displaySize(baseSize, rotation);
  const aspect = shown.height / shown.width;

  // Render only once scrolled into view.
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
    let task: { cancel: () => void } | null = null;
    (async () => {
      const page = await doc.getPage(srcPage);
      if (cancelled) return;
      // Render at the screen's real pixel density (and never below 2x): drawn at CSS pixels, the
      // bitmap is upscaled on any high-DPI display and the page text comes out soft.
      const density = Math.max(window.devicePixelRatio || 1, 2);
      const vp = rotatedViewport(page, (width / shown.width) * density, rotation);
      // Paint aside and blit when done, so a resize (the organizer's size slider) keeps showing
      // the previous bitmap instead of flashing blank while the new one renders.
      const off = document.createElement("canvas");
      off.width = Math.ceil(vp.width);
      off.height = Math.ceil(vp.height);
      const offCtx = off.getContext("2d");
      if (!offCtx) return;
      const render = page.render({ canvasContext: offCtx, viewport: vp });
      task = render;
      try {
        await render.promise;
      } catch {
        return; // cancelled
      }
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (cancelled || !canvas || !ctx) return;
      canvas.width = off.width;
      canvas.height = off.height;
      ctx.drawImage(off, 0, 0);
      page.cleanup();
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [seen, doc, srcPage, rotation, width, shown.width]);

  return (
    <div
      ref={ref}
      className={`overflow-hidden rounded ${className ?? ""}`}
      style={{ width, height: width * aspect, background: inverted ? "#0d0d0d" : "#fff" }}
    >
      {/* A CSS filter is safe here, unlike on the page itself: nothing blends against a
          thumbnail, so there is no backdrop for a stacking context to disturb. */}
      <canvas
        ref={canvasRef}
        className="block h-full w-full"
        style={{ filter: inverted ? INVERT_FILTER : undefined }}
      />
    </div>
  );
}
