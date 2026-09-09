import { useEffect, useLayoutEffect, useRef } from "react";
import { pdfjs, type PdfDocument } from "./pdfWorker";
import type { SearchMatch } from "./search";
import { useViewer } from "../store/viewerStore";
import { isMarkupTool, useAnnotations } from "../annotations/useAnnotations";
import { isTouchPrimary } from "../platform/device";
import { INVERT_FILTER, usePageInverted } from "../settings/usePageColors";
import AnnotationLayer from "../annotations/AnnotationLayer";
import LinkLayer from "./LinkLayer";
import FormLayer from "./FormLayer";

interface Props {
  doc: PdfDocument;
  /** 1-based position in the viewer. Annotations, search and the page label all count in this space. */
  pageNumber: number;
  /**
   * 1-based page to pull from the source document, which differs from `pageNumber` once pages have
   * been reordered or removed. Defaults to `pageNumber` for an unedited document.
   */
  srcPage?: number;
  /** Live scale: drives layout, and every overlay that has to stay pinned to the page. */
  scale: number;
  /**
   * The scale to paint the bitmap at. Settles behind `scale` during a zoom gesture, so a pinch
   * produces one crisp render at the end rather than one per event — see `useSettledScale`.
   */
  renderScale: number;
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
  srcPage,
  scale,
  renderScale,
  width,
  height,
  visible,
  query,
  currentMatch,
}: Props) {
  const src = srcPage ?? pageNumber;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const renderToken = useRef(0);
  /*
   * The scales the two layers currently on screen were actually built at. They are tracked
   * separately because they land at different moments: the bitmap is blitted as soon as it is
   * rendered, while the text layer waits on a further async getTextContent() — so between those
   * two points the page legitimately has a canvas at one scale and spans at another.
   */
  const paintedScale = useRef(0);
  const textScale = useRef(0);
  const filePath = useViewer((s) => s.filePath);
  // The two text-selecting tools run our own selection on a touch device, so the platform's is
  // switched off for them (see .bode-nonative). Deliberately NOT a dependency of the render
  // effect — it is a class on an existing node, and rebuilding the text layer for it is waste.
  const customSelect =
    useAnnotations((a) => isMarkupTool(a.tool) || a.tool === "select") && isTouchPrimary();
  const inverted = usePageInverted();

  // The current display geometry, so the async render below can size against where the zoom has
  // actually got to rather than against the scale it started at.
  const display = useRef({ scale, width, height });
  display.current = { scale, width, height };

  /*
   * Keep what is already painted on screen and just stretch it to the size being displayed.
   *
   * This is what stops the flicker. The bitmap is only replaced once its successor has finished
   * rendering (below), so between a zoom and that moment the page shows the previous render,
   * CSS-scaled — briefly soft, but never blank. Assigning canvas.width/height is what used to
   * clear it to transparent and expose the white page behind.
   *
   * Called both from the layout effect and straight after a blit: a zoom that lands mid-render
   * would otherwise leave the finished bitmap sized for the scale the render began at.
   */
  const syncDisplay = () => {
    const canvas = canvasRef.current;
    const textLayer = textLayerRef.current;
    if (!canvas || !textLayer || !paintedScale.current) return;
    const d = display.current;
    canvas.style.width = `${Math.round(d.width)}px`;
    canvas.style.height = `${Math.round(d.height)}px`;
    // The text layer is built in its own scale's pixels; scale it to match what is displayed so
    // selection rectangles keep landing on the glyphs. transform-origin is 0 0 (index.css).
    if (!textScale.current) return;
    const k = d.scale / textScale.current;
    textLayer.style.transform = k === 1 ? "" : `scale(${k})`;
  };

  // Layout effect, not an effect: this has to land in the same frame as the size change, or the
  // canvas is a stale size for a paint.
  useLayoutEffect(syncDisplay, [scale, width, height]);

  useEffect(() => {
    if (!visible) {
      // Nothing is painted while the placeholder is up, so the preview transform above must not
      // scale against a scale from before the page was recycled.
      paintedScale.current = 0;
      textScale.current = 0;
      return;
    }
    const token = ++renderToken.current;
    let cancelled = false;
    let renderTask: ReturnType<Awaited<ReturnType<PdfDocument["getPage"]>>["render"]> | null =
      null;

    (async () => {
      const page = await doc.getPage(src);
      if (cancelled || token !== renderToken.current) return;

      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: renderScale });
      const canvas = canvasRef.current;
      const textLayer = textLayerRef.current;
      if (!canvas || !textLayer) return;

      /*
       * Paint into an offscreen canvas, not the one on screen.
       *
       * Assigning width/height to a canvas clears it, and pdf.js renders asynchronously — so
       * doing that up front left the page blank for the whole render, and blank *permanently*
       * for the renders that then got cancelled by the next zoom event. Rendering aside and
       * blitting the finished bitmap over in one synchronous step means the visible canvas
       * never has a frame with nothing in it.
       */
      const off = document.createElement("canvas");
      // Render the bitmap at device resolution for crispness, display at CSS size.
      off.width = Math.floor(viewport.width * dpr);
      off.height = Math.floor(viewport.height * dpr);
      const offCtx = off.getContext("2d");
      if (!offCtx) return;

      renderTask = page.render({
        canvasContext: offCtx,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        // Leave the editable form fields off the canvas so FormLayer can own them — painting the
        // baked appearance under a live input would show the old value through the new one.
        // pdf.js keeps drawing everything that layer does NOT take over: read-only fields, push
        // buttons and signature fields all still come out exactly as the author drew them.
        annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS,
      });

      try {
        await renderTask.promise;
      } catch {
        return; // cancelled
      }
      if (cancelled || token !== renderToken.current) return;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      // The one moment the visible canvas changes: resize and blit together, no blank frame.
      canvas.width = off.width;
      canvas.height = off.height;
      /*
       * Invert here, on the blit, rather than with a CSS filter on the element.
       *
       * A filter on the canvas would make it a stacking context, and the highlight layer beneath
       * blends against this canvas as its backdrop — so filtering the element would change what
       * that blend resolves against and quietly wreck every highlight on the page. Baking it into
       * the bitmap leaves the compositing exactly as it was: the overlays still blend against a
       * page, it is simply a dark one now.
       */
      ctx.filter = inverted ? INVERT_FILTER : "none";
      ctx.drawImage(off, 0, 0);
      ctx.filter = "none";
      paintedScale.current = renderScale;
      // Display size comes from where the zoom is now, not from this render's viewport — they
      // differ whenever the scale moved while this render was in flight.
      syncDisplay();

      // ---- Text layer (selection + search highlights) ----
      const content = await page.getTextContent();
      if (cancelled || token !== renderToken.current) return;

      textLayer.innerHTML = "";
      // Drop any preview transform left over from a zoom that happened while this render was in
      // flight: the measure pass below reads widths off these spans, and a scaled layer would
      // scale every one of those reads with it. syncDisplay puts it back once they are measured.
      textLayer.style.transform = "";
      textLayer.style.width = `${Math.floor(viewport.width)}px`;
      textLayer.style.height = `${Math.floor(viewport.height)}px`;

      const currentOccOnPage =
        currentMatch && currentMatch.pageIndex === pageNumber - 1
          ? currentMatch.occurrenceOnPage
          : -1;
      let occ = 0;
      let currentEl: HTMLElement | null = null;

      /*
       * Built in three passes — create, measure, correct — rather than one.
       *
       * Each span needs a horizontal scale derived from its own rendered width, and reading that
       * width right after appending the span forces the browser to lay the page out again. Doing
       * that inside the loop meant one full reflow per text run, hundreds per page, and it was
       * the hitch you felt every time a zoom settled. Batching the writes, then the reads, then
       * the writes again costs one reflow for the whole page.
       */
      const frag = document.createDocumentFragment();
      const pending: { span: HTMLElement; angle: number; target: number }[] = [];

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
        frag.appendChild(span);
        // Horizontal scale to match the item's true width (improves selection accuracy). Deferred
        // to the measure pass below, because reading a width here would force a reflow per span.
        pending.push({ span, angle, target: item.width * renderScale });

        if (currentOccOnPage >= occ && currentOccOnPage < occEnd) {
          currentEl = span.querySelector(".current") as HTMLElement | null;
        }
        occ = occEnd;
      }

      textLayer.appendChild(frag);

      // One reflow for the page: every read happens here, before any of the writes below.
      const widths = pending.map((p) => (p.target > 0 ? p.span.getBoundingClientRect().width : 0));
      pending.forEach((p, i) => {
        const measured = widths[i];
        if (p.target > 0 && measured > 0) {
          const sx = p.target / measured;
          p.span.style.transform = `${p.angle !== 0 ? `rotate(${p.angle}rad) ` : ""}scaleX(${sx})`;
        }
      });

      /*
       * Only now. The spans are in this render's pixels, so the preview transform has to be
       * recomputed against them — and it has to come after the measuring above, because
       * syncDisplay scales the whole text layer and would have scaled every width read with it.
       */
      textScale.current = renderScale;
      syncDisplay();

      if (currentEl) {
        currentEl.scrollIntoView({ block: "center", inline: "center" });
      }

      page.cleanup();
    })();

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [doc, src, pageNumber, renderScale, visible, query, currentMatch, inverted]);

  return (
    <div
      className="relative mx-auto"
      style={{
        width,
        height,
        boxShadow: "var(--page-shadow)",
        borderRadius: 2,
        // Shows through until the bitmap lands, and around it afterwards; white paper framing an
        // inverted page is worse than no page at all.
        background: inverted ? "#0d0d0d" : "#fff",
      }}
      data-page={pageNumber}
    >
      {visible ? (
        <>
          <canvas ref={canvasRef} className="block" />
          <div ref={textLayerRef} className={`textLayer${customSelect ? " bode-nonative" : ""}`} />
          <LinkLayer doc={doc} pageNumber={src} scale={scale} />
          {filePath && (
            <FormLayer
              doc={doc}
              pageNumber={src}
              pageIndex={pageNumber - 1}
              scale={scale}
              filePath={filePath}
            />
          )}
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
