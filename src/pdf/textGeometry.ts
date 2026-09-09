/*
 * Character-level geometry for a rendered pdf.js text layer.
 *
 * This exists so the highlight tool can run its own text selection on touch devices instead of
 * the WebView's. The platform selection is otherwise perfectly good, but it comes with a
 * magnifier that the OS pins directly under the finger, and nothing a web page can do will move
 * it — so the selection has to be ours if the magnifier is going to be ours.
 *
 * Everything here works in PAGE SPACE (PDF points at scale 1, origin at the page's top-left),
 * matching how annotations are stored, so a zoom cannot invalidate anything measured here.
 *
 * The one subtle piece is `prefix`: per-character offsets are stored as fractions of the span's
 * own width rather than as pixels. That makes them independent of the zoom, of the `scaleX`
 * correction PdfPage applies to each span, and of a late-arriving webfont — all three change the
 * span's width and none of them change where a character sits *within* it.
 */

/** A caret position: character `ch` of span `span`, where `ch` may equal the text length. */
export interface CharPos {
  span: number;
  ch: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SpanGeom {
  text: string;
  /** Page-space box of the span as displayed (post-transform). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Index into `PageGeom.lines`. */
  line: number;
  /** `text.length + 1` cumulative offsets, each 0..1 of `w`. */
  prefix: Float32Array;
  /** Rotated spans only support whole-span granularity — see `hitTest`. */
  rotated: boolean;
}

export interface PageGeom {
  scale: number;
  spans: SpanGeom[];
  /** Span indices grouped into visual lines, each sorted left to right. */
  lines: number[][];
  /** The node the geometry was measured from, to detect a rebuilt layer. */
  first: Element | null;
}

// Reused canvas for measuring text width.
let measureCtx: CanvasRenderingContext2D | null = null;
export function measureTextWidth(text: string, fontPx: number, fontFamily: string): number {
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
  if (!measureCtx) return 0;
  measureCtx.font = `${fontPx}px ${fontFamily}`;
  return measureCtx.measureText(text).width;
}

/** Cumulative per-character offsets, normalised to 0..1 of the whole string's width. */
function prefixRatios(text: string, font: string): Float32Array {
  const out = new Float32Array(text.length + 1);
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
  if (!measureCtx || !text.length) return out;
  measureCtx.font = font;
  // Cumulative slices rather than summed per-character advances: only this form accounts for
  // the kerning between the pair straddling each boundary.
  const total = measureCtx.measureText(text).width || 1;
  for (let i = 1; i <= text.length; i++) {
    out[i] = measureCtx.measureText(text.slice(0, i)).width / total;
  }
  out[text.length] = 1;
  return out;
}

/**
 * Measure every span in a rendered text layer. One forced layout for the whole page, so this is
 * called lazily on first touch rather than during a render.
 */
export function buildPageGeom(textLayer: HTMLElement, scale: number): PageGeom {
  const lr = textLayer.getBoundingClientRect();
  const spans: SpanGeom[] = [];

  // Direct children only. Search wraps its matches in nested spans, and those must stay
  // invisible to this: `textContent` still reports the whole item either way.
  for (const el of Array.from(textLayer.children)) {
    if (!(el instanceof HTMLElement)) continue;
    const text = el.textContent ?? "";
    if (!text) continue;
    // getBoundingClientRect is post-transform, so this is the box actually on screen — the
    // scaleX correction PdfPage applies is already baked in and never needs undoing.
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const fontPx = parseFloat(el.style.fontSize) || 0;
    spans.push({
      text,
      x: (r.left - lr.left) / scale,
      y: (r.top - lr.top) / scale,
      w: r.width / scale,
      h: r.height / scale,
      line: 0,
      prefix: prefixRatios(text, `${fontPx}px ${el.style.fontFamily || "sans-serif"}`),
      rotated: (el.style.transform || "").includes("rotate"),
    });
  }

  // Group into visual lines: walk top-to-bottom and start a new line once a span's top clears
  // most of the current line's height. PDF text arrives in no dependable order.
  const byY = spans.map((_, i) => i).sort((a, b) => spans[a].y - spans[b].y);
  const lines: number[][] = [];
  let lineTop = -Infinity;
  let lineH = 0;
  for (const i of byY) {
    const s = spans[i];
    if (!lines.length || s.y > lineTop + lineH * 0.6) {
      lines.push([i]);
      lineTop = s.y;
      lineH = s.h;
    } else {
      lines[lines.length - 1].push(i);
      lineH = Math.max(lineH, s.h);
    }
  }
  lines.forEach((line, li) => {
    line.sort((a, b) => spans[a].x - spans[b].x);
    for (const i of line) spans[i].line = li;
  });

  return { scale, spans, lines, first: textLayer.firstElementChild };
}

const cache = new WeakMap<HTMLElement, PageGeom>();

/** Measured geometry for a text layer, rebuilt when the layer or the zoom has changed. */
export function pageGeom(textLayer: HTMLElement, scale: number): PageGeom {
  const hit = cache.get(textLayer);
  // `first` catches a rebuilt layer — a re-render, or a search query changing the spans.
  if (hit && hit.scale === scale && hit.first === textLayer.firstElementChild) return hit;
  const built = buildPageGeom(textLayer, scale);
  cache.set(textLayer, built);
  return built;
}

/** DOM order, so a selection dragged backwards still yields start-before-end. */
export function order(a: CharPos, b: CharPos): [CharPos, CharPos] {
  if (a.span < b.span || (a.span === b.span && a.ch <= b.ch)) return [a, b];
  return [b, a];
}

export const samePos = (a: CharPos | null, b: CharPos | null): boolean =>
  a === b || (!!a && !!b && a.span === b.span && a.ch === b.ch);

/** Nearest character boundary to fraction `f` of a span's width. */
function boundaryAt(prefix: Float32Array, f: number): number {
  let lo = 0;
  let hi = prefix.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (prefix[mid] < f) lo = mid + 1;
    else hi = mid;
  }
  // `lo` is the first boundary at or past `f`; take whichever neighbour is closer, which is what
  // makes a caret land where it looks like it should rather than always before the character.
  if (lo > 0 && f - prefix[lo - 1] < prefix[lo] - f) return lo - 1;
  return lo;
}

/** The character position at a page-space point. */
export function hitTest(g: PageGeom, px: number, py: number): CharPos | null {
  if (!g.lines.length) return null;

  // Pick the line whose vertical band contains the point, else the vertically nearest, so
  // dragging into a margin or the gutter still tracks the text beside it.
  let line = -1;
  let best = Infinity;
  for (let li = 0; li < g.lines.length; li++) {
    let top = Infinity;
    let bot = -Infinity;
    for (const i of g.lines[li]) {
      top = Math.min(top, g.spans[i].y);
      bot = Math.max(bot, g.spans[i].y + g.spans[i].h);
    }
    const d = py < top ? top - py : py > bot ? py - bot : 0;
    if (d < best) {
      best = d;
      line = li;
    }
    if (d === 0) break;
  }
  if (line < 0) return null;

  const ids = g.lines[line];
  // Left of the line, or right of it: clamp to its ends.
  const firstSpan = g.spans[ids[0]];
  if (px <= firstSpan.x) return { span: ids[0], ch: 0 };
  const lastId = ids[ids.length - 1];
  const lastSpan = g.spans[lastId];
  if (px >= lastSpan.x + lastSpan.w) return { span: lastId, ch: lastSpan.text.length };

  // The span containing the point, else the nearest one on the line (spans have gaps).
  let id = ids[0];
  let gap = Infinity;
  for (const i of ids) {
    const s = g.spans[i];
    if (px >= s.x && px <= s.x + s.w) {
      id = i;
      break;
    }
    const d = px < s.x ? s.x - px : px - (s.x + s.w);
    if (d < gap) {
      gap = d;
      id = i;
    }
  }

  const s = g.spans[id];
  // A rotated span's client rect is the axis-aligned envelope of the rotated box, so horizontal
  // fractions across it mean nothing. Whole-span granularity is the honest answer.
  if (s.rotated) return { span: id, ch: px < s.x + s.w / 2 ? 0 : s.text.length };
  const f = Math.min(1, Math.max(0, (px - s.x) / (s.w || 1)));
  return { span: id, ch: boundaryAt(s.prefix, f) };
}

/**
 * Page-space rectangles covering the selection, one per span fragment — the same shape
 * `Range.getClientRects()` produces, so the mark looks exactly as it always has.
 */
export function rangeRects(g: PageGeom, a: CharPos, b: CharPos): Rect[] {
  const [s, e] = order(a, b);
  const out: Rect[] = [];
  for (let i = s.span; i <= e.span && i < g.spans.length; i++) {
    const sp = g.spans[i];
    const from = i === s.span ? s.ch : 0;
    const to = i === e.span ? e.ch : sp.text.length;
    if (to <= from) continue;
    const x0 = sp.x + sp.w * sp.prefix[from];
    const x1 = sp.x + sp.w * sp.prefix[to];
    if (x1 - x0 <= 0.01) continue;
    out.push({ x: x0, y: sp.y, w: x1 - x0, h: sp.h });
  }
  return out;
}

/** The selected text, for copying. */
export function rangeText(g: PageGeom, a: CharPos, b: CharPos): string {
  const [s, e] = order(a, b);
  let out = "";
  let prev: SpanGeom | null = null;
  for (let i = s.span; i <= e.span && i < g.spans.length; i++) {
    const sp = g.spans[i];
    const part = sp.text.slice(i === s.span ? s.ch : 0, i === e.span ? e.ch : sp.text.length);
    if (!part) continue;
    if (prev) {
      // pdf.js emits a span per text run, so word gaps and line breaks are geometry rather than
      // characters — they have to be inferred back.
      if (sp.line !== prev.line) out += "\n";
      else if (sp.x - (prev.x + prev.w) > sp.h * 0.2) out += " ";
    }
    out += part;
    prev = sp;
  }
  return out;
}

/** A zero-width page-space rect at a caret position, for placing a drag handle. */
export function caretRect(g: PageGeom, p: CharPos): Rect | null {
  const sp = g.spans[p.span];
  if (!sp) return null;
  const f = sp.prefix[Math.min(p.ch, sp.text.length)] ?? 0;
  return { x: sp.x + sp.w * f, y: sp.y, w: 0, h: sp.h };
}

/** The bounding box of a set of rects, or null for none. */
export function boundsOf(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The whole page, in DOM order — what "Select all" selects. */
export function allOf(g: PageGeom): [CharPos, CharPos] | null {
  if (!g.spans.length) return null;
  const last = g.spans.length - 1;
  return [
    { span: 0, ch: 0 },
    { span: last, ch: g.spans[last].text.length },
  ];
}

/** Expand a position to the word around it — what a long press should select. */
export function wordAt(g: PageGeom, p: CharPos): [CharPos, CharPos] {
  const sp = g.spans[p.span];
  if (!sp) return [p, p];
  const t = sp.text;
  if (sp.rotated) {
    return [
      { span: p.span, ch: 0 },
      { span: p.span, ch: t.length },
    ];
  }
  const isWord = (c: string) => !!c && !/\s/.test(c);
  // A caret sits between characters; when it lands on a boundary, prefer the word to its left.
  let i = Math.min(p.ch, t.length);
  if (!isWord(t[i]) && i > 0 && isWord(t[i - 1])) i--;
  if (!isWord(t[i])) return [p, p];
  let a = i;
  let b = i;
  while (a > 0 && isWord(t[a - 1])) a--;
  while (b < t.length && isWord(t[b])) b++;
  return [
    { span: p.span, ch: a },
    { span: p.span, ch: b },
  ];
}
