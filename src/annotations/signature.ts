import { useEffect, useState } from "react";
import type { Rect } from "./useAnnotations";

/*
 * Sizing a drawn signature to the space it is being put in.
 *
 * Shared by the two places a signature lands: the signature tool, where the reader drags out the
 * box themselves, and a form's signature field, where the box comes from the PDF. Both want the
 * same answer — fill the space without stretching the handwriting — so both ask here.
 */

/** Width, in PDF points, of a signature dropped with a click rather than a dragged box. */
export const SIGNATURE_CLICK_WIDTH = 180;
/** Stand-in proportions until the signature image has actually decoded. */
const SIGNATURE_FALLBACK_ASPECT = 0.44;

/**
 * Aspect ratio (height ÷ width) of a signature image, cached by data URL.
 *
 * Placing a signature has to settle its size the instant the drag ends, and an image decode is
 * asynchronous — so the ratio is decoded once when the signature is first seen and read straight
 * out of this cache from then on.
 */
const signatureAspects = new Map<string, number>();

export function useSignatureAspect(url: string | null): number {
  const [, redraw] = useState(0);
  useEffect(() => {
    if (!url || signatureAspects.has(url)) return;
    const img = new Image();
    img.onload = () => {
      signatureAspects.set(url, img.width > 0 ? img.height / img.width : SIGNATURE_FALLBACK_ASPECT);
      redraw((n) => n + 1);
    };
    img.src = url;
  }, [url]);
  return (url ? signatureAspects.get(url) : undefined) ?? SIGNATURE_FALLBACK_ASPECT;
}

/**
 * The largest rect of the given proportions that fits inside `box`, centred in it — which is how a
 * signature is sized to the space that was drawn for it. A box with no height yet (a purely
 * horizontal drag, or a click) simply takes the height its width implies.
 */
export function fitInside(box: Rect, aspect: number): Rect {
  if (box.h <= 0) return { x: box.x, y: box.y, w: box.w, h: box.w * aspect };
  let w = box.w;
  let h = w * aspect;
  if (h > box.h) {
    h = box.h;
    w = aspect > 0 ? h / aspect : box.w;
  }
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}
