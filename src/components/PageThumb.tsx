import { useEffect, useRef, useState } from "react";
import { useViewer } from "../store/viewerStore";

/**
 * A lazily-rendered page bitmap, shared by the thumbnail rail and the page organizer.
 *
 * Takes a *source* page number, not a visible one, so reordering the manifest never changes what a
 * card renders — combined with keying cards by `PageRef.id`, moving a page moves its existing
 * canvas rather than re-rasterising it.
 */
export default function PageThumb({
  srcPage,
  width,
  className,
}: {
  srcPage: number;
  width: number;
  className?: string;
}) {
  const doc = useViewer((s) => s.doc);
  const baseSize = useViewer((s) => s.baseSize);
  const ref = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [seen, setSeen] = useState(false);
  const aspect = baseSize.height / baseSize.width;

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
    (async () => {
      const page = await doc.getPage(srcPage);
      if (cancelled) return;
      const vp = page.getViewport({ scale: width / baseSize.width });
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
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
  }, [seen, doc, srcPage, width, baseSize.width]);

  return (
    <div
      ref={ref}
      className={`overflow-hidden rounded bg-white ${className ?? ""}`}
      style={{ width, height: width * aspect }}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}
