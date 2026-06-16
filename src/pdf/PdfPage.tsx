import { useEffect, useRef } from "react";
import { pdfjs, type PdfDocument } from "./pdfWorker";
import type { SearchMatch } from "./search";
import { useViewer } from "../store/viewerStore";
import AnnotationLayer from "../annotations/AnnotationLayer";

interface Props {
  doc: PdfDocument;
  pageNumber: number; // 1-based
  scale: number;
  width: number; // rendered CSS width in px (for placeholder sizing)
  height: number; // rendered CSS height in px
  visible: boolean;
  query: string;
  currentMatch: SearchMatch | null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

/**
 * Build span innerHTML, wrapping case-insensitive matches of `query` in highlight spans.
 * Returns the new running occurrence count for the page so callers can flag the current one.
 */
function highlightedHtml(
  text: string,
  query: string,
  occStart: number,
  currentOcc: number
): { html: string; occEnd: number } {
  if (!query) return { html: escapeHtml(text), occEnd: occStart };
  const needle = query.toLowerCase();
  const hay = text.toLowerCase();
  let out = "";
  let from = 0;
  let occ = occStart;
  let idx = hay.indexOf(needle, from);
  while (idx !== -1) {
    out += escapeHtml(text.slice(from, idx));
    const cls = occ === currentOcc ? "bode-highlight current" : "bode-highlight";
    out += `<span class="${cls}">${escapeHtml(text.slice(idx, idx + needle.length))}</span>`;
    occ++;
    from = idx + needle.length;
    idx = hay.indexOf(needle, from);
  }
  out += escapeHtml(text.slice(from));
  return { html: out, occEnd: occ };
}

// Measure a font's ascent as a fraction of its size, so text-layer spans align with the
// rendered glyph baseline (cached per font family). Mirrors PDF.js's getAscent approach.
const ascentCache = new Map<string, number>();
function ascentRatio(fontFamily: string): number {
  const cached = ascentCache.get(fontFamily);
  if (cached !== undefined) return cached;
  let ratio = 0.8; // sensible fallback
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const size = 1000;
    ctx.font = `${size}px ${fontFamily}`;
    const m = ctx.measureText("Hg");
    const ascent = m.fontBoundingBoxAscent || m.actualBoundingBoxAscent;
    if (ascent) ratio = ascent / size;
  }
  ascentCache.set(fontFamily, ratio);
  return ratio;
}

export default function PdfPage({
  doc,
  pageNumber,
  scale,
  width,
  height,
  visible,
  query,
  currentMatch,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const renderToken = useRef(0);
  const filePath = useViewer((s) => s.filePath);

  useEffect(() => {
    if (!visible) return;
    const token = ++renderToken.current;
    let cancelled = false;
    let renderTask: ReturnType<Awaited<ReturnType<PdfDocument["getPage"]>>["render"]> | null =
      null;

    (async () => {
      const page = await doc.getPage(pageNumber);
      if (cancelled || token !== renderToken.current) return;

      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      const textLayer = textLayerRef.current;
      if (!canvas || !textLayer) return;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // Render the bitmap at device resolution for crispness, display at CSS size.
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      renderTask = page.render({
        canvasContext: ctx,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      });

      try {
        await renderTask.promise;
      } catch {
        return; // cancelled
      }
      if (cancelled || token !== renderToken.current) return;

      // ---- Text layer (selection + search highlights) ----
      const content = await page.getTextContent();
      if (cancelled || token !== renderToken.current) return;

      textLayer.innerHTML = "";
      textLayer.style.width = `${Math.floor(viewport.width)}px`;
      textLayer.style.height = `${Math.floor(viewport.height)}px`;

      const currentOccOnPage =
        currentMatch && currentMatch.pageIndex === pageNumber - 1
          ? currentMatch.occurrenceOnPage
          : -1;
      let occ = 0;
      let currentEl: HTMLElement | null = null;

      for (const item of content.items) {
        if (!("str" in item) || !item.str) continue;
        const tx = pdfjs.Util.transform(viewport.transform, item.transform);
        const fontHeight = Math.hypot(tx[2], tx[3]);
        const angle = Math.atan2(tx[1], tx[0]);
        const style = content.styles[item.fontName];

        const span = document.createElement("span");
        const { html, occEnd } = highlightedHtml(item.str, query, occ, currentOccOnPage);
        span.innerHTML = html;

        // tx[5] is the glyph baseline; the CSS box top sits an *ascent* above it, not a
        // full font-height — otherwise the selectable line box rides above the glyphs.
        const fontFamily = style?.fontFamily ?? "sans-serif";
        const fontAscent = fontHeight * ascentRatio(fontFamily);
        const left = angle === 0 ? tx[4] : tx[4] + fontAscent * Math.sin(angle);
        const top = angle === 0 ? tx[5] - fontAscent : tx[5] - fontAscent * Math.cos(angle);

        span.style.left = `${left}px`;
        span.style.top = `${top}px`;
        span.style.fontSize = `${fontHeight}px`;
        span.style.fontFamily = fontFamily;
        span.style.transformOrigin = "0% 0%";
        if (angle !== 0) span.style.transform = `rotate(${angle}rad)`;
        textLayer.appendChild(span);

        // Horizontal scale to match the item's true width (improves selection accuracy).
        const target = item.width * scale;
        if (target > 0) {
          const measured = span.getBoundingClientRect().width;
          if (measured > 0) {
            const sx = target / measured;
            span.style.transform = `${angle !== 0 ? `rotate(${angle}rad) ` : ""}scaleX(${sx})`;
          }
        }

        if (currentOccOnPage >= occ && currentOccOnPage < occEnd) {
          currentEl = span.querySelector(".current") as HTMLElement | null;
        }
        occ = occEnd;
      }

      if (currentEl) {
        currentEl.scrollIntoView({ block: "center", inline: "center" });
      }

      page.cleanup();
    })();

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [doc, pageNumber, scale, visible, query, currentMatch]);

  return (
    <div
      className="relative mx-auto bg-white"
      style={{ width, height, boxShadow: "var(--page-shadow)", borderRadius: 2 }}
      data-page={pageNumber}
    >
      {visible ? (
        <>
          <canvas ref={canvasRef} className="block" />
          <div ref={textLayerRef} className="textLayer" />
          {filePath && (
            <AnnotationLayer
              filePath={filePath}
              pageIndex={pageNumber - 1}
              scale={scale}
              width={width}
              height={height}
            />
          )}
        </>
      ) : (
        <div className="flex h-full w-full items-center justify-center text-xs text-muted">
          {pageNumber}
        </div>
      )}
    </div>
  );
}
