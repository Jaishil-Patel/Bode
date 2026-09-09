import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useViewer } from "../store/viewerStore";
import { useSettings } from "../settings/useSettings";
import { setViewport } from "./viewport";
import PdfPage from "./PdfPage";

const PADDING = 24; // px of breathing room used when fitting
const BUFFER = 2; // pages rendered above/below the viewport
/*
 * Quiet time after a scale change before the pages are re-rendered crisply.
 *
 * A pinch no longer goes through the store at all — it is one commit at the end — so this only
 * has to absorb a burst of discrete steps, like a held zoom shortcut or a few quick taps on the
 * toolbar buttons. Short enough to read as immediate.
 */
const SETTLE_MS = 70;

/*
 * The scale to actually re-render bitmaps at.
 *
 * A pinch or trackpad zoom produces a new scale on every event — dozens a second — and each one
 * used to start a page render that the next event cancelled. Holding the render scale still until
 * the gesture stops turns that into one render per gesture. The zoom itself stays live: layout and
 * every overlay follow `scale` immediately, and PdfPage stretches the bitmap it already has in the
 * meantime, so this costs a moment of softness rather than any responsiveness.
 */
function useSettledScale(scale: number, ms: number): number {
  const [settled, setSettled] = useState(scale);
  useEffect(() => {
    if (scale === settled) return;
    const t = setTimeout(() => setSettled(scale), ms);
    return () => clearTimeout(t);
  }, [scale, settled, ms]);
  return settled;
}

export default function PdfViewer() {
  const {
    doc,
    numPages,
    pages: manifest,
    baseSize,
    fitMode,
    customScale,
    scale,
    currentPage,
    scrollTarget,
    search,
    setResolvedScale,
    setCurrentPage,
  } = useViewer();
  const { continuous, pageGap } = useSettings((s) => s.layout);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const prevScale = useRef(scale);
  // Nonce of the last scroll request acted on. Without it every re-run of the effect below —
  // and a zoom re-runs it, because the row height it reads changes — would replay the last
  // request, yanking the view back to wherever the document was opened or last jumped to.
  const appliedNonce = useRef(-1);
  // A scroll we asked for, and when. While it is in flight the container's offset describes
  // where the view is coming FROM, so the page tracker below has to sit the animation out
  // rather than tag the document with a page the user is only passing over.
  const pendingScroll = useRef<{ top: number; at: number } | null>(null);

  // Hand the scroll container to the keyboard handler in App for as long as this viewer is up.
  useLayoutEffect(() => {
    setViewport(scrollRef.current);
    return () => setViewport(null);
  });

  // Track container size for fit calculations.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Where the in-flight zoom gesture is centred, captured before the scale changes so the
  // layout effect below can keep that point under the cursor/fingers.
  const zoomAnchor = useRef<{ sx: number; sy: number; cx: number; cy: number; s: number } | null>(
    null
  );
  /** The element holding the pages, transformed directly while a zoom gesture is in flight. */
  const pagesRef = useRef<HTMLDivElement>(null);

  /*
   * Live zoom: a CSS transform during the gesture, one real scale change at the end.
   *
   * A pinch emits scale changes at the rate of the touch stream. Putting each one through the
   * store meant React re-rendered every mounted page and all four of its overlays per event,
   * which is what made a pinch feel like it was catching. A transform on the page container
   * costs the compositor a matrix and React nothing at all, so the gesture runs at display rate;
   * the store hears about it once, when the fingers lift.
   *
   * The preview and the committed layout agree exactly. A page sits at `pad + i*rowH`, so a zoom
   * maps y to `pad + (y - pad) * f` while a transform about the focal point maps it to
   * `fy + (y - fy) * f` — different formulas, but once the scroll correction below is applied
   * both put a given point at `f * (y - sy - cy) + cy`, so nothing shifts at the handover.
   */
  const gesture = useRef<{
    factor: number;
    cx: number;
    cy: number;
    sx: number;
    sy: number;
    s: number;
    ox: number;
    oy: number;
  } | null>(null);
  const gestureIdle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Zoom gestures: trackpad pinch, mouse ctrl+wheel and touch pinch.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const beginGesture = (clientX: number, clientY: number) => {
      const r = el.getBoundingClientRect();
      const cx = clientX - r.left;
      const cy = clientY - r.top;
      // Horizontally the page is centred by `mx-auto` until it outgrows the viewport, and only
      // then does it scale about its own left edge. Matching that here keeps a page that fits the
      // width from sliding sideways under the fingers.
      const hOverflow = el.scrollWidth > el.clientWidth + 1;
      gesture.current = {
        factor: 1,
        cx,
        cy,
        sx: el.scrollLeft,
        sy: el.scrollTop,
        s: useViewer.getState().scale,
        ox: hOverflow ? cx + el.scrollLeft : el.clientWidth / 2,
        oy: cy + el.scrollTop,
      };
    };

    const previewGesture = (factor: number) => {
      const g = gesture.current;
      const pages = pagesRef.current;
      if (!g || !pages) return;
      // Clamp against the same limits the store enforces, so the preview cannot show a zoom the
      // commit will refuse and then snap back from.
      const target = Math.min(Math.max(g.s * g.factor * factor, 0.1), 6);
      g.factor = target / g.s;
      pages.style.transformOrigin = `${g.ox}px ${g.oy}px`;
      pages.style.transform = `scale(${g.factor})`;
    };

    const commitGesture = () => {
      clearTimeout(gestureIdle.current);
      const g = gesture.current;
      gesture.current = null;
      const pages = pagesRef.current;
      if (pages) {
        pages.style.transform = "";
        pages.style.transformOrigin = "";
      }
      if (!g || Math.abs(g.factor - 1) < 0.0005) return;
      zoomAnchor.current = { sx: g.sx, sy: g.sy, cx: g.cx, cy: g.cy, s: g.s };
      useViewer.getState().zoomBy(g.factor);
    };

    /** Wheel zoom has no end event, so idle time stands in for one. */
    const armIdleCommit = () => {
      clearTimeout(gestureIdle.current);
      gestureIdle.current = setTimeout(commitGesture, 90);
    };

    // Chromium (WebView2, Android WebView) reports a trackpad pinch as a wheel event with
    // ctrlKey set and small fractional deltas, while a real mouse wheel notch arrives as one
    // large delta. Scale proportionally for the pinch, step for the notch — a fixed step per
    // event would slam a pinch straight into the zoom limits.
    let gesturing = false;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey) || gesturing) return;
      e.preventDefault();
      const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 100 : e.deltaY;
      const factor = Math.abs(d) < 40 ? Math.exp(-d * 0.012) : d < 0 ? 1.12 : 1 / 1.12;
      if (!gesture.current) beginGesture(e.clientX, e.clientY);
      previewGesture(factor);
      armIdleCommit();
    };

    // WebKit (macOS WKWebView, Safari) does not synthesize ctrl+wheel for a trackpad pinch;
    // it fires these non-standard gesture events with a cumulative `scale` instead.
    type GestureEvent = MouseEvent & { scale: number };
    let lastGestureScale = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gesturing = true;
      const ge = e as GestureEvent;
      lastGestureScale = ge.scale || 1;
      beginGesture(ge.clientX, ge.clientY);
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const ge = e as GestureEvent;
      if (!ge.scale || lastGestureScale <= 0) return;
      previewGesture(ge.scale / lastGestureScale);
      lastGestureScale = ge.scale;
    };
    const onGestureEnd = (e: Event) => {
      e.preventDefault();
      gesturing = false;
      lastGestureScale = 1;
      commitGesture();
    };

    // Two-finger pinch on touch devices (Android). Non-passive so we can prevent the WebView's
    // native pinch-zoom and feed the gesture into our own scale instead.
    let lastDist = 0;
    const dist = (t: TouchList) =>
      Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      const t = e.touches;
      lastDist = dist(t);
      beginGesture((t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2);
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      e.preventDefault();
      const d = dist(e.touches);
      if (lastDist > 0 && d > 0) {
        // No dead zone: the transform is cheap enough to follow every sample, and skipping the
        // small ones is what used to make a slow pinch move in steps.
        previewGesture(d / lastDist);
      }
      lastDist = d;
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length >= 2) return;
      lastDist = 0;
      commitGesture();
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart, { passive: false });
    el.addEventListener("gesturechange", onGestureChange, { passive: false });
    el.addEventListener("gestureend", onGestureEnd, { passive: false });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      // A gesture in flight when the viewer unmounts must not leave its scale unrecorded.
      commitGesture();
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      el.removeEventListener("gestureend", onGestureEnd);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, []);

  // Resolve fit mode into an actual scale and publish it.
  const usableW = Math.max(size.w - PADDING * 2, 100);
  const usableH = Math.max(size.h - PADDING * 2, 100);
  let resolved = customScale;
  if (fitMode === "width") resolved = usableW / baseSize.width;
  else if (fitMode === "page")
    resolved = Math.min(usableW / baseSize.width, usableH / baseSize.height);
  resolved = Math.min(Math.max(resolved, 0.1), 6);

  useEffect(() => {
    setResolvedScale(resolved);
  }, [resolved, setResolvedScale]);

  const renderScale = useSettledScale(scale, SETTLE_MS);

  const pageW = baseSize.width * scale;
  const pageH = baseSize.height * scale;
  const rowH = pageH + pageGap;

  // Keep the view anchored when the scale changes: on the gesture's focal point if the zoom
  // came from a pinch/ctrl+wheel, otherwise on the current page (zoom buttons and shortcuts).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (Math.abs(prevScale.current - scale) > 0.0001) {
      const a = zoomAnchor.current;
      if (a) {
        const pad = continuous ? pageGap / 2 : PADDING;
        const ratio = scale / a.s;
        el.scrollLeft = (a.sx + a.cx) * ratio - a.cx;
        el.scrollTop = (a.sy + a.cy - pad) * ratio + pad - a.cy;
        zoomAnchor.current = null;
      } else if (continuous) {
        el.scrollTop = (currentPage - 1) * rowH;
      }
      // Whatever a scroll request was still travelling towards was measured at the old zoom, so
      // it is stale now; this position is the settled one.
      pendingScroll.current = null;
      prevScale.current = scale;
    }
  }, [scale, rowH, currentPage, continuous, pageGap]);

  // Scroll-driven virtualization window + current page tracking.
  const [scrollTop, setScrollTop] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        setScrollTop(el.scrollTop);
        if (!continuous || rowH <= 0) return;
        const p = pendingScroll.current;
        if (p) {
          // Arrived, or the user grabbed the scroller mid-flight and the request is now moot.
          if (Math.abs(el.scrollTop - p.top) < 2 || Date.now() - p.at > 800) pendingScroll.current = null;
          else return;
        }
        const center = el.scrollTop + el.clientHeight / 2;
        setCurrentPage(Math.min(Math.max(Math.round(center / rowH + 0.5), 1), numPages));
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [continuous, rowH, numPages, setCurrentPage]);

  // Honor programmatic navigation (page jumps, search results, restored position). Each request
  // is acted on once, by nonce — the effect also re-runs whenever the zoom changes, and replaying
  // a stale request there is what used to drag the reader back to the page the file opened on.
  useEffect(() => {
    if (!scrollTarget || appliedNonce.current === scrollTarget.nonce) return;
    const el = scrollRef.current;
    if (!el) return;
    appliedNonce.current = scrollTarget.nonce;
    if (continuous) {
      // Add the in-page offset for link destinations, leaving a small margin above the target.
      const within = scrollTarget.offsetPts ? scrollTarget.offsetPts * scale - 12 : 0;
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      const top = Math.min((scrollTarget.page - 1) * rowH + Math.max(0, within), max);
      // Claim the page up front rather than waiting for the scroll to land on it. The zoom may
      // still be resolving underneath this — the row height it was measured against can change a
      // frame later — and the anchoring effect above re-derives the offset from the current page,
      // so having that right is what survives the change.
      setCurrentPage(scrollTarget.page);
      pendingScroll.current = { top, at: Date.now() };
      el.scrollTo({ top, behavior: scrollTarget.instant ? "auto" : "smooth" });
    } else {
      setCurrentPage(scrollTarget.page);
    }
  }, [scrollTarget, rowH, scale, continuous, setCurrentPage]);

  if (!doc) return null;

  // ---- Single-page mode ----
  if (!continuous) {
    const cur = useViewer.getState().currentMatch();
    return (
      <div ref={scrollRef} className="h-full w-full overflow-auto">
        <div
          ref={pagesRef}
          className="flex min-h-full items-start justify-center"
          style={{ padding: PADDING }}
        >
          <PdfPage
            doc={doc}
            pageNumber={currentPage}
            srcPage={manifest[currentPage - 1]?.srcPage}
            scale={scale}
            renderScale={renderScale}
            width={pageW}
            height={pageH}
            visible
            query={search.query}
            currentMatch={cur}
          />
        </div>
      </div>
    );
  }

  // ---- Continuous mode with virtualization ----
  const first = Math.max(0, Math.floor(scrollTop / rowH) - BUFFER);
  const last = Math.min(numPages - 1, Math.ceil((scrollTop + size.h) / rowH) + BUFFER);
  const currentMatch = useViewer.getState().currentMatch();

  const pages = [];
  for (let i = first; i <= last; i++) {
    pages.push(
      <div key={manifest[i]?.id ?? i} style={{ position: "absolute", top: i * rowH, left: 0, right: 0 }}>
        <PdfPage
          doc={doc}
          pageNumber={i + 1}
          srcPage={manifest[i]?.srcPage}
          scale={scale}
          renderScale={renderScale}
          width={pageW}
          height={pageH}
          visible
          query={search.query}
          currentMatch={currentMatch}
        />
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="h-full w-full overflow-auto">
      <div
        ref={pagesRef}
        style={{
          position: "relative",
          height: numPages * rowH,
          paddingTop: pageGap / 2,
        }}
      >
        {pages}
      </div>
    </div>
  );
}
