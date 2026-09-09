/*
 * The magnifier shown while dragging a text selection on a phone.
 *
 * The whole reason this exists: Android's own selection loupe is pinned directly under the
 * finger, which is exactly where the hand already is. This one sits in a top corner, out of the
 * way of both the thumb and the text being read.
 *
 * It is deliberately imperative. `aim()` writes coordinates to a ref and a single rAF loop does
 * the drawing, so a drag costs zero React renders and zero layout reads per frame.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { createPortal } from "react-dom";
import type { Rect } from "../pdf/textGeometry";

const W = 168; // CSS px
const H = 92;
const MAG = 2.2; // magnification relative to what is on screen
const MARGIN = 8;
/** Keep clear of the selection by this much before considering a corner occupied. */
const AVOID = 24;
/** Only move back to the preferred corner once it is this much clearer, so it cannot dither. */
const RELEASE = 48;
const FLIP_MS = 400;

export interface LoupeHandle {
  /** Point the loupe at a client-space coordinate. Safe to call every pointermove. */
  aim: (clientX: number, clientY: number) => void;
}

interface Props {
  /** 1-based page number, matching the `data-page` attribute PdfPage puts on each page. */
  pageNumber: number;
  /** Live selection rectangles in page space, drawn over the magnified pixels. */
  rects: Rect[];
  /** Page-space → CSS px. */
  scale: number;
  color: string;
}

type Corner = "right" | "left" | "bottom";

/** Whether a client-space box comes within `pad` of another. */
const near = (a: DOMRect, b: Rect, pad: number) =>
  a.left - pad < b.x + b.w && a.right + pad > b.x && a.top - pad < b.y + b.h && a.bottom + pad > b.y;

const SelectionLoupe = forwardRef<LoupeHandle, Props>(function SelectionLoupe(
  { pageNumber, rects, scale, color },
  ref,
) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const aimRef = useRef<{ x: number; y: number } | null>(null);
  // Latest props, read by the rAF loop without making it a dependency.
  const live = useRef({ rects, scale, color, pageNumber });
  live.current = { rects, scale, color, pageNumber };

  useImperativeHandle(ref, () => ({
    aim: (x, y) => {
      aimRef.current = { x, y };
    },
  }));

  useEffect(() => {
    let raf = 0;
    let corner: Corner = "right";
    let lastFlip = 0;
    // The page canvas and its metrics, resolved once per drag rather than per frame.
    let src: HTMLCanvasElement | null = null;
    let pageRect: DOMRect | null = null;
    let bmp = 1; // bitmap px per CSS px

    const resolve = () => {
      if (src?.isConnected && pageRect) return true;
      const pageEl = document.querySelector<HTMLElement>(
        `[data-page="${live.current.pageNumber}"]`,
      );
      const canvas = pageEl?.querySelector("canvas");
      if (!pageEl || !canvas) return false;
      src = canvas;
      pageRect = pageEl.getBoundingClientRect();
      // Derived, never assumed to be devicePixelRatio: PdfPage floors the bitmap dimensions.
      bmp = canvas.width / (pageRect.width || 1);
      return true;
    };

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const aim = aimRef.current;
      const out = canvasRef.current;
      const box = boxRef.current;
      if (!aim || !out || !box) return;
      // A violent fling can unmount the page mid-drag; freeze on the last frame rather than throw.
      if (!resolve() || !src || !pageRect) return;

      const ctx = out.getContext("2d");
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      if (out.width !== W * dpr) {
        out.width = W * dpr;
        out.height = H * dpr;
      }

      // Source window in bitmap pixels, centred on the touch point and clamped to the page.
      // Centred exactly, with no upward lift: the loupe is off in a corner rather than under the
      // hand, so there is nothing to see around — an offset just shows the wrong line.
      const sw = (W / MAG) * bmp;
      const sh = (H / MAG) * bmp;
      const rawX = (aim.x - pageRect.left) * bmp - sw / 2;
      const rawY = (aim.y - pageRect.top) * bmp - sh / 2;
      const sx = Math.min(Math.max(rawX, 0), Math.max(0, src.width - sw));
      const sy = Math.min(Math.max(rawY, 0), Math.max(0, src.height - sh));

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, W, H);
      ctx.drawImage(src, sx, sy, sw, sh, 0, 0, W, H);

      // Show what is selected, not just the pixels under the finger. Multiply for the same
      // reason the page's own highlight layer uses it: tinting must not wash out the glyphs.
      const k = W / sw; // bitmap px → loupe px
      ctx.globalCompositeOperation = "multiply";
      ctx.fillStyle = live.current.color;
      for (const r of live.current.rects) {
        ctx.fillRect(
          (r.x * live.current.scale * bmp - sx) * k,
          (r.y * live.current.scale * bmp - sy) * k,
          r.w * live.current.scale * bmp * k,
          r.h * live.current.scale * bmp * k,
        );
      }
      ctx.globalCompositeOperation = "source-over";

      // Keep out of the way of the thing being read. Hysteresis plus a rate limit, or a
      // selection sitting across the top of the screen makes it strobe between corners.
      const now = performance.now();
      if (now - lastFlip > FLIP_MS) {
        const self = box.getBoundingClientRect();
        const pad = corner === "right" ? AVOID : RELEASE;
        const pr = pageRect;
        const clash = live.current.rects.some((r) =>
          near(
            self,
            {
              x: pr.left + r.x * live.current.scale,
              y: pr.top + r.y * live.current.scale,
              w: r.w * live.current.scale,
              h: r.h * live.current.scale,
            },
            pad,
          ),
        );
        const want: Corner = clash ? (corner === "right" ? "left" : "bottom") : "right";
        if (want !== corner) {
          corner = want;
          lastFlip = now;
          box.style.left = corner === "left" ? `${MARGIN}px` : "";
          box.style.right = corner === "left" ? "" : `${MARGIN}px`;
          box.style.top = corner === "bottom" ? "" : `calc(env(safe-area-inset-top, 0px) + ${MARGIN}px)`;
          box.style.bottom = corner === "bottom"
            ? `calc(env(safe-area-inset-bottom, 0px) + ${MARGIN}px)`
            : "";
        }
      }
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return createPortal(
    <div
      ref={boxRef}
      style={{
        position: "fixed",
        top: "calc(env(safe-area-inset-top, 0px) + 8px)",
        right: `${MARGIN}px`,
        width: W,
        height: H,
        zIndex: 60, // over the annotation bar
        pointerEvents: "none",
        borderRadius: 10,
        overflow: "hidden",
        border: "1px solid var(--border)",
        boxShadow: "0 6px 20px rgb(0 0 0 / 0.3)",
        background: "#fff",
      }}
    >
      <canvas ref={canvasRef} style={{ width: W, height: H, display: "block" }} />
    </div>,
    document.body,
  );
});

export default SelectionLoupe;
