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

  // Ctrl/Cmd + wheel zooms (up = in, down = out). Non-passive so we can stop the
  // WebView's built-in page zoom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      useViewer.getState().zoomBy(factor);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Two-finger pinch zooms on touch devices (Android). Non-passive so we can prevent the
  // WebView's native pinch-zoom and feed the gesture into our own scale instead.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let lastDist = 0;
    const dist = (t: TouchList) =>
      Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) lastDist = dist(e.touches);
    };
    const onMove = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      e.preventDefault();
      const d = dist(e.touches);
      if (lastDist > 0 && d > 0) {
        const factor = d / lastDist;
        if (Math.abs(factor - 1) > 0.005) {
          useViewer.getState().zoomBy(factor);
          lastDist = d;
        }
      } else {
        lastDist = d;
      }
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) lastDist = 0;
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
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

  // Keep the current page anchored when the scale changes.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !continuous) return;
    if (Math.abs(prevScale.current - scale) > 0.0001) {
      el.scrollTop = (currentPage - 1) * rowH;
      prevScale.current = scale;
    }
  }, [scale, rowH, currentPage, continuous]);

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
      <div key={i} style={{ position: "absolute", top: i * rowH, left: 0, right: 0 }}>
        <PdfPage
          doc={doc}
          pageNumber={i + 1}
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
