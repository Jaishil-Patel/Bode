/*
 * Where the document area starts: the bottom edge of the bars across the top of the window
 * (caption, toolbar, tab strip, and any banner under them).
 *
 * Those bars change height — each has a size setting, the tab strip only exists with more than one
 * document open, and fullscreen takes them all away — so anything floating over the document (the
 * tools bar, portals, notes) cannot assume a fixed number for them. App measures the real edge and
 * publishes it as `--content-top` on the root element; CSS reads the variable, and code that
 * positions things by hand reads it through `contentTop()`.
 */

export const CONTENT_TOP_VAR = "--content-top";

/** The edge in CSS px, or 0 where there is no document (tests) or it has not been measured yet. */
export function contentTop(): number {
  if (typeof document === "undefined") return 0;
  const v = getComputedStyle(document.documentElement).getPropertyValue(CONTENT_TOP_VAR);
  return parseFloat(v) || 0;
}

/** Keep `--content-top` in step with the top of `el`, the element the document area starts with. */
export function publishContentTop(el: HTMLElement): () => void {
  const update = () =>
    document.documentElement.style.setProperty(CONTENT_TOP_VAR, `${el.getBoundingClientRect().top}px`);
  update();
  // Any bar above changing height resizes this element too (it takes whatever height is left), so
  // watching its size is watching the edge. The window resizing does the same.
  const ro = new ResizeObserver(update);
  ro.observe(el);
  return () => ro.disconnect();
}
