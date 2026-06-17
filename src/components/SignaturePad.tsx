import { useEffect, useRef, useState } from "react";
import { useAnnotations } from "../annotations/useAnnotations";

const W = 520;
const H = 200;

/**
 * Modal canvas for drawing a signature once. On save it trims the transparent margins and
 * stores a PNG data URL on the annotations store (`signatureDataUrl`), which the signature
 * tool then stamps onto pages. Opened/closed via `signaturePadOpen` so the deeply-nested
 * AnnotationLayer can request it without prop drilling.
 */
export default function SignaturePad() {
  const open = useAnnotations((s) => s.signaturePadOpen);
  const setOpen = useAnnotations((s) => s.setSignaturePadOpen);
  const setSignatureDataUrl = useAnnotations((s) => s.setSignatureDataUrl);
  const setTool = useAnnotations((s) => s.setTool);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [hasInk, setHasInk] = useState(false);

  // Reset the canvas each time the pad opens.
  useEffect(() => {
    if (!open) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, W, H);
    setHasInk(false);
  }, [open]);

  if (!open) return null;

  const pos = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };

  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drawing.current = true;
    last.current = pos(e);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    const ctx = canvasRef.current!.getContext("2d")!;
    const p = pos(e);
    ctx.strokeStyle = "#0f172a"; // ink colour (dark slate); flattened as-is into the PDF
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(last.current!.x, last.current!.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
    setHasInk(true);
  };
  const onUp = () => {
    drawing.current = false;
    last.current = null;
  };

  const clear = () => {
    canvasRef.current?.getContext("2d")?.clearRect(0, 0, W, H);
    setHasInk(false);
  };

  // Crop to the painted bounding box so the placed signature has no empty padding.
  const trimmedDataUrl = (): string | null => {
    const src = canvasRef.current!;
    const ctx = src.getContext("2d")!;
    const { data } = ctx.getImageData(0, 0, W, H);
    let minX = W, minY = H, maxX = 0, maxY = 0;
    let found = false;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (data[(y * W + x) * 4 + 3] !== 0) {
          found = true;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (!found) return null;
    const pad = 6;
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);
    maxX = Math.min(W - 1, maxX + pad);
    maxY = Math.min(H - 1, maxY + pad);
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    out.getContext("2d")!.drawImage(src, minX, minY, w, h, 0, 0, w, h);
    return out.toDataURL("image/png");
  };

  const save = () => {
    const url = trimmedDataUrl();
    if (!url) return;
    setSignatureDataUrl(url);
    setOpen(false);
    setTool("signature"); // ready to stamp it onto the page
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={() => setOpen(false)}
    >
      <div
        className="overflow-hidden rounded-xl border border-border bg-surface shadow-2xl animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border px-4 py-3 text-sm font-medium text-text">
          Draw your signature
        </div>
        <div className="p-4">
          <canvas
            ref={canvasRef}
            width={W}
            height={H}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            className="w-[520px] max-w-[80vw] touch-none rounded-lg border border-border bg-white"
            style={{ cursor: "crosshair", aspectRatio: `${W} / ${H}` }}
          />
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
          <button
            onClick={clear}
            className="rounded-md px-3 py-1.5 text-sm text-text transition-colors hover:bg-surface-2"
          >
            Clear
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setOpen(false)}
              className="rounded-md px-3 py-1.5 text-sm text-text transition-colors hover:bg-surface-2"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={!hasInk}
              className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
