import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useViewer } from "../store/viewerStore";
import { useSettings } from "../settings/useSettings";
import PdfPage from "./PdfPage";

const PADDING = 24; // px of breathing room used when fitting
const BUFFER = 2; // pages rendered above/below the viewport

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

  // Zoom gestures: trackpad pinch, mouse ctrl+wheel and touch pinch.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const zoomAt = (factor: number, clientX: number, clientY: number) => {
      if (Math.abs(factor - 1) < 0.0005) return;
      const r = el.getBoundingClientRect();
      zoomAnchor.current = {
        sx: el.scrollLeft,
        sy: el.scrollTop,
        cx: clientX - r.left,
        cy: clientY - r.top,
        s: useViewer.getState().scale,
      };
      useViewer.getState().zoomBy(factor);
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
      zoomAt(factor, e.clientX, e.clientY);
    };

    // WebKit (macOS WKWebView, Safari) does not synthesize ctrl+wheel for a trackpad pinch;
    // it fires these non-standard gesture events with a cumulative `scale` instead.
    type GestureEvent = MouseEvent & { scale: number };
    let lastGestureScale = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gesturing = true;
      lastGestureScale = (e as GestureEvent).scale || 1;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const ge = e as GestureEvent;
      if (!ge.scale || lastGestureScale <= 0) return;
      zoomAt(ge.scale / lastGestureScale, ge.clientX, ge.clientY);
      lastGestureScale = ge.scale;
    };
    const onGestureEnd = (e: Event) => {
      e.preventDefault();
      gesturing = false;
      lastGestureScale = 1;
    };

    // Two-finger pinch on touch devices (Android). Non-passive so we can prevent the WebView's
    // native pinch-zoom and feed the gesture into our own scale instead.
    let lastDist = 0;
    const dist = (t: TouchList) =>
      Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) lastDist = dist(e.touches);
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      e.preventDefault();
      const d = dist(e.touches);
      if (lastDist > 0 && d > 0) {
        const factor = d / lastDist;
        if (Math.abs(factor - 1) > 0.005) {
          const t = e.touches;
          zoomAt(factor, (t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2);
          lastDist = d;
        }
      } else {
        lastDist = d;
      }
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) lastDist = 0;
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart, { passive: false });
    el.addEventListener("gesturechange", onGestureChange, { passive: false });
    el.addEventListener("gestureend", onGestureEnd, { passive: false });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      el.removeEventListener("gestureend", onGestureEnd);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
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
        if (continuous && rowH > 0) {
          const center = el.scrollTop + el.clientHeight / 2;
          setCurrentPage(Math.min(Math.max(Math.round(center / rowH + 0.5), 1), numPages));
        }
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [continuous, rowH, numPages, setCurrentPage]);

  // Honor programmatic navigation (page jumps, search results, restored position).
  useEffect(() => {
    if (!scrollTarget) return;
    const el = scrollRef.current;
    if (!el) return;
    if (continuous) {
      // Add the in-page offset for link destinations, leaving a small margin above the target.
      const within = scrollTarget.offsetPts ? scrollTarget.offsetPts * scale - 12 : 0;
      const top = (scrollTarget.page - 1) * rowH + Math.max(0, within);
      el.scrollTo({ top, behavior: "smooth" });
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
        <div className="flex min-h-full items-start justify-center" style={{ padding: PADDING }}>
          <PdfPage
            doc={doc}
            pageNumber={currentPage}
            srcPage={manifest[currentPage - 1]?.srcPage}
            scale={scale}
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
      <div style={{ position: "relative", height: numPages * rowH, paddingTop: pageGap / 2 }}>
        {pages}
      </div>
    </div>
  );
}
