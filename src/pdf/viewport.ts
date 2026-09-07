/**
 * The PDF scroll container, published by the mounted viewer.
 *
 * Keyboard scrolling is driven from App's single global key handler, which has no way to reach
 * into the viewer's ref. Registering the element here keeps that one handler authoritative —
 * a second window-level listener inside the viewer would race the first one for the same keys,
 * and which of the two won would depend on mount order.
 */
let viewport: HTMLElement | null = null;

export const setViewport = (el: HTMLElement | null) => {
  viewport = el;
};

/** The live scroll container, or null when no PDF is on screen. */
export const getViewport = () => viewport;
