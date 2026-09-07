import { pdfjs, type PdfDocument } from "./pdfWorker";
import type { FieldRect } from "./formFields";

/*
 * Guessing where a flat form wants to be filled in.
 *
 * A scanned or printed form has no fields at all — just ink. What it does have is the visual
 * grammar people have used for blanks since typewriters: a run of underscores, a label with a
 * colon and a gap after it, a ruled line to write on, an empty box to tick. This reads those back
 * out and proposes somewhere to type.
 *
 * It is a guess, and it is presented as one: candidates show as dashed outlines the reader clicks
 * to activate, never as inputs that appear on their own. The bar for accepting a candidate is
 * therefore "obviously right", and the rules below lean hard towards rejecting rather than
 * cluttering the page with boxes in the wrong places.
 *
 * The detection itself is pure — it takes plain boxes, not pdf.js objects — so the heuristics can
 * be tested against fixtures without a PDF anywhere in sight. `readDetectedSlots` is the thin
 * adapter that gets those boxes out of a page.
 *
 * Everything here is in Bode's display space: PDF points at scale 1, top-left origin, y down.
 */

/** A laid-out run of text on the page. */
export interface TextBox {
  str: string;
  x: number;
  y: number;
  w: number;
  /** Font height, which is also roughly the line height we size a slot to. */
  h: number;
}

/** The bounding box of one drawn path — a rule, a border, a box outline. */
export interface PathRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DetectedSlot {
  /** Deterministic, so a filled slot is still the same slot after a reload. */
  key: string;
  rect: FieldRect;
  kind: "text" | "checkbox";
  label: string;
  /** Which rule proposed it — useful when tuning, and shown in the slot's tooltip. */
  source: "leader" | "gap" | "rule" | "box";
}

// --- Thresholds. Chosen to under-detect: a missed blank is an annoyance, a wrong one is clutter.

/** Shortest run of underscores or dots that reads as a blank rather than punctuation. */
const MIN_LEADER = 4;
/** Narrower than this and there is nowhere to write, so it is probably not a blank. */
const MIN_SLOT_W = 24;
/** A gap after a "Label:" has to be at least this wide to count as room left for an answer. */
const MIN_GAP_W = 48;
/** Thicker than this is a filled shape, not a rule to write on. */
const MAX_RULE_H = 2.5;
/** A line most of the page wide is a divider or a table border, not a field. */
const MAX_RULE_FRACTION = 0.72;
/** Boxes taller than this are panels and regions, not single-line fields. */
const MAX_BOX_H = 44;
/** At or under this, with roughly square sides, a box is a tick box. */
const MAX_TICK = 26;
/** Default slot height when there is no nearby text to take a size from. */
const DEFAULT_SLOT_H = 13;
/** Two candidates overlapping by more than this share of the smaller one are the same blank. */
const MERGE_OVERLAP = 0.5;

const isLeaderChar = (c: string) => c === "_" || c === "." || c === "·" || c === "…";

/**
 * A slot's identity: which page it is on and where, rounded to whole points.
 *
 * Deterministic, so that re-detecting a page produces the same identities and React keeps the same
 * elements rather than replacing the row of suggestions on every scroll.
 */
export const slotKey = (pageIndex: number, rect: FieldRect) =>
  `g:${pageIndex}:${Math.round(rect.x)}:${Math.round(rect.y)}:${Math.round(rect.w)}:${Math.round(rect.h)}`;

const overlap = (a: FieldRect, b: FieldRect) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const smaller = Math.min(a.w * a.h, b.w * b.h);
  return smaller > 0 ? (w * h) / smaller : 0;
};

/** Text sitting on roughly the same line, which is what "before" and "after" mean on a form. */
const sameLine = (a: TextBox, b: TextBox) =>
  Math.abs(a.y + a.h / 2 - (b.y + b.h / 2)) < Math.max(a.h, b.h) * 0.6;

/**
 * The label for a blank: the nearest text ending to its left on the same line, else the nearest
 * text directly above it. This is what turns a bare box into "Date of birth".
 */
function labelFor(rect: FieldRect, texts: TextBox[]): string {
  const mid = rect.y + rect.h / 2;
  let best: { t: TextBox; d: number } | null = null;
  for (const t of texts) {
    if (!t.str.trim()) continue;
    const onLine = Math.abs(t.y + t.h / 2 - mid) < Math.max(t.h, rect.h) * 0.7;
    const endsLeft = t.x + t.w <= rect.x + 2;
    if (onLine && endsLeft) {
      const d = rect.x - (t.x + t.w);
      if (d >= 0 && (!best || d < best.d)) best = { t, d };
    }
  }
  if (!best) {
    // Nothing to the left — try directly above, the layout column forms use for tick lists.
    for (const t of texts) {
      if (!t.str.trim()) continue;
      const above = t.y + t.h <= rect.y + 2;
      const horizontallyOver = t.x < rect.x + rect.w && t.x + t.w > rect.x;
      if (above && horizontallyOver) {
        const d = rect.y - (t.y + t.h);
        if (d >= 0 && d < 40 && (!best || d < best.d)) best = { t, d };
      }
    }
  }
  return best ? best.t.str.replace(/[\s:._]+$/, "").trim() : "";
}

/** Blanks written as a run of underscores or dot leaders, inside or as a whole text run. */
function fromLeaders(texts: TextBox[]): FieldRect[] {
  const out: FieldRect[] = [];
  for (const t of texts) {
    const s = t.str;
    if (!s || t.w <= 0) continue;
    let i = 0;
    while (i < s.length) {
      if (!isLeaderChar(s[i])) {
        i++;
        continue;
      }
      let j = i;
      while (j < s.length && isLeaderChar(s[j])) j++;
      const run = j - i;
      // Dots are also sentence punctuation and numbering, so they need a longer run to count.
      const needed = s[i] === "_" ? MIN_LEADER : MIN_LEADER + 2;
      if (run >= needed) {
        // Character positions are approximated by proportion of the run's width. Leader glyphs
        // are near enough uniform that this lands within a character either way.
        const per = t.w / s.length;
        const x = t.x + per * i;
        const w = per * run;
        if (w >= MIN_SLOT_W) out.push({ x, y: t.y - t.h * 0.15, w, h: t.h * 1.15 });
      }
      i = j;
    }
  }
  return out;
}

/** "Label:" followed by enough empty room on the same line to write an answer in. */
function fromGaps(texts: TextBox[], page: { w: number }): FieldRect[] {
  const out: FieldRect[] = [];
  const rightMargin = page.w * 0.94;
  for (const t of texts) {
    if (!/[:?]\s*$/.test(t.str)) continue;
    const from = t.x + t.w + 3;
    // The next thing written on this line, if anything, bounds the answer space.
    let next = rightMargin;
    for (const o of texts) {
      if (o === t || !o.str.trim()) continue;
      if (!sameLine(t, o)) continue;
      if (o.x >= from && o.x < next) next = o.x;
    }
    const w = next - from - 2;
    if (w >= MIN_GAP_W) out.push({ x: from, y: t.y - t.h * 0.15, w, h: t.h * 1.15 });
  }
  return out;
}

/** Ruled lines to write on: thin, horizontal, not spanning the page, not underlining anything. */
function fromRules(paths: PathRect[], texts: TextBox[], page: { w: number }): FieldRect[] {
  const out: FieldRect[] = [];
  for (const p of paths) {
    if (p.h > MAX_RULE_H || p.w < MIN_SLOT_W) continue;
    if (p.w > page.w * MAX_RULE_FRACTION) continue; // a divider, not a blank
    // A rule with text sitting right on top of it is an underline, not a place to write.
    const underlines = texts.some(
      (t) =>
        t.str.trim() &&
        t.x < p.x + p.w &&
        t.x + t.w > p.x &&
        p.y - (t.y + t.h) < t.h * 0.5 &&
        p.y >= t.y,
    );
    if (underlines) continue;
    const near = texts.find((t) => t.str.trim() && Math.abs(t.y + t.h - p.y) < 20);
    const h = near ? near.h * 1.15 : DEFAULT_SLOT_H;
    out.push({ x: p.x, y: p.y - h, w: p.w, h });
  }
  return out;
}

/** Empty drawn boxes: a single-line field to type in, or a small square to tick. */
function fromBoxes(
  paths: PathRect[],
  texts: TextBox[],
  page: { w: number },
): { rect: FieldRect; kind: "text" | "checkbox" }[] {
  const out: { rect: FieldRect; kind: "text" | "checkbox" }[] = [];
  for (const p of paths) {
    if (p.h <= MAX_RULE_H) continue; // that is a rule, handled above
    if (p.h > MAX_BOX_H) continue; // a panel or a region
    if (p.w > page.w * MAX_RULE_FRACTION) continue;
    const tick = p.w <= MAX_TICK && p.h <= MAX_TICK && Math.abs(p.w - p.h) < Math.max(p.w, p.h) * 0.4;
    if (!tick && p.w < MIN_SLOT_W) continue;
    // A box with writing already in it is a printed cell, not somewhere to fill in.
    const filled = texts.some(
      (t) => t.str.trim() && t.x + t.w > p.x + 1 && t.x < p.x + p.w - 1 && t.y + t.h > p.y + 1 && t.y < p.y + p.h - 1,
    );
    if (filled) continue;
    out.push({
      rect: { x: p.x + 1, y: p.y + 1, w: p.w - 2, h: p.h - 2 },
      kind: tick ? "checkbox" : "text",
    });
  }
  return out;
}

/**
 * Propose fillable slots for a page that has no real form fields.
 *
 * Pure: give it boxes, get back slots. Candidates are gathered from every rule, then merged so
 * that a ruled line under a "Name:" label does not become two overlapping blanks.
 */
export function detectSlots(
  texts: TextBox[],
  paths: PathRect[],
  page: { w: number; h: number },
  pageIndex: number,
): DetectedSlot[] {
  const candidates: { rect: FieldRect; kind: "text" | "checkbox"; source: DetectedSlot["source"] }[] =
    [
      ...fromLeaders(texts).map((rect) => ({ rect, kind: "text" as const, source: "leader" as const })),
      ...fromBoxes(paths, texts, page).map((b) => ({ ...b, source: "box" as const })),
      ...fromRules(paths, texts, page).map((rect) => ({ rect, kind: "text" as const, source: "rule" as const })),
      ...fromGaps(texts, page).map((rect) => ({ rect, kind: "text" as const, source: "gap" as const })),
    ];

  // Reading order, so the merge below keeps the first-proposed of any overlapping pair and the
  // result is stable regardless of which rule found what.
  candidates.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);

  const kept: DetectedSlot[] = [];
  for (const c of candidates) {
    const { rect } = c;
    if (rect.w < 8 || rect.h < 5) continue;
    if (rect.x < -2 || rect.y < -2 || rect.x + rect.w > page.w + 2 || rect.y + rect.h > page.h + 2)
      continue;
    if (kept.some((k) => overlap(k.rect, rect) > MERGE_OVERLAP)) continue;
    kept.push({
      key: slotKey(pageIndex, rect),
      rect,
      kind: c.kind,
      label: labelFor(rect, texts),
      source: c.source,
    });
  }
  return kept;
}

// --- pdf.js adapter -------------------------------------------------------------------------

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/**
 * Bounding boxes of the paths a page draws, in display space.
 *
 * Path coordinates in an operator list are in content space, *before* whatever transforms are in
 * effect where the path appears — so this walks the list keeping the transform stack pdf.js's own
 * canvas renderer keeps. Without that, every candidate on a page whose content is scaled or
 * translated (which is most of them) lands somewhere else entirely.
 */
export function pathBoxesFrom(
  fnArray: number[],
  argsArray: unknown[],
  viewportTransform: number[],
): PathRect[] {
  const { OPS, Util } = pdfjs;
  const stack: Matrix[] = [];
  let ctm: Matrix = IDENTITY;
  const out: PathRect[] = [];

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i] as unknown[];
    switch (fn) {
      case OPS.save:
        stack.push(ctm);
        break;
      case OPS.restore:
        ctm = stack.pop() ?? IDENTITY;
        break;
      case OPS.transform:
        ctm = Util.transform(ctm, args as number[]) as Matrix;
        break;
      case OPS.paintFormXObjectBegin:
        // A form XObject carries its own matrix and behaves like a save/transform pair.
        stack.push(ctm);
        ctm = Util.transform(ctm, args[0] as number[]) as Matrix;
        break;
      case OPS.paintFormXObjectEnd:
        ctm = stack.pop() ?? IDENTITY;
        break;
      case OPS.constructPath: {
        // args are [subOps, coords, minMax]; minMax is the path's own bounding box.
        const minMax = args[2] as number[] | undefined;
        if (!minMax || minMax.length < 4) break;
        const m = Util.transform(viewportTransform, ctm);
        const [ax, ay] = Util.applyTransform([minMax[0], minMax[1]], m);
        const [bx, by] = Util.applyTransform([minMax[2], minMax[3]], m);
        out.push({
          x: Math.min(ax, bx),
          y: Math.min(ay, by),
          w: Math.abs(bx - ax),
          h: Math.abs(by - ay),
        });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** Read a page's text and drawn paths, and propose slots for it. */
export async function readDetectedSlots(
  doc: PdfDocument,
  pageNumber: number,
  pageIndex: number,
): Promise<DetectedSlot[]> {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });

  const content = await page.getTextContent();
  const texts: TextBox[] = [];
  for (const item of content.items as Array<Record<string, unknown>>) {
    if (typeof item.str !== "string") continue;
    const transform = item.transform as number[] | undefined;
    if (!transform) continue;
    // Same composition PdfPage uses to place a text span: the item's own matrix through the
    // viewport's. tx[4]/tx[5] land on the glyph baseline, so the box starts one ascent above it.
    const tx = pdfjs.Util.transform(viewport.transform, transform);
    const h = Math.hypot(tx[2], tx[3]);
    texts.push({
      str: item.str,
      x: tx[4],
      y: tx[5] - h * 0.8,
      w: typeof item.width === "number" ? item.width : 0,
      h,
    });
  }

  let paths: PathRect[] = [];
  try {
    const ops = await page.getOperatorList();
    paths = pathBoxesFrom(ops.fnArray as unknown as number[], ops.argsArray, viewport.transform);
  } catch {
    // A page whose content stream will not decode still gets text-based detection.
  }

  return detectSlots(texts, paths, { w: viewport.width, h: viewport.height }, pageIndex);
}
