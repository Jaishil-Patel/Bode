import {
  PDFDocument,
  StandardFonts,
  rgb,
  degrees,
  setCharacterSqueeze,
  type PDFPage,
  type PDFFont,
} from "pdf-lib";
import { save } from "@tauri-apps/plugin-dialog";
import { readPdfBytes, writePdfBytes } from "../platform/files";
import type { Annotation } from "../annotations/useAnnotations";

/*
 * Flattens the overlay annotations (the same ones AnnotationLayer renders) into the original
 * PDF and writes a new file. Annotation geometry is in "display" space: PDF points at scale 1.0,
 * top-left origin, y down — the space PdfPage/pdf.js render in, with the page's rotation already
 * applied. pdf-lib draws in unrotated user space (bottom-left origin, y up), so each page gets a
 * mapper that converts a display point to user space accounting for /Rotate.
 */

type Rgb = { r: number; g: number; b: number };

function hexToRgb(hex: string): Rgb {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h || "000000", 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}
const col = (hex: string) => {
  const c = hexToRgb(hex);
  return rgb(c.r, c.g, c.b);
};

/** Map a display-space point (top-left origin, y down) to pdf-lib user space (bottom-left, y up). */
function makeMapper(page: PDFPage) {
  const r = ((page.getRotation().angle % 360) + 360) % 360;
  const { width: pw, height: ph } = page.getSize(); // unrotated media box
  const toUser = (dx: number, dy: number) => {
    switch (r) {
      case 90:
        return { x: dy, y: dx };
      case 180:
        return { x: pw - dx, y: dy };
      case 270:
        return { x: pw - dy, y: ph - dx };
      default:
        return { x: dx, y: ph - dy };
    }
  };
  /** Map a display rectangle to an axis-aligned user-space rect (rotation is a multiple of 90°). */
  const rect = (x: number, y: number, w: number, h: number) => {
    const a = toUser(x, y);
    const b = toUser(x + w, y + h);
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.abs(b.x - a.x),
      h: Math.abs(b.y - a.y),
    };
  };
  return { rotation: r, toUser, rect };
}

/** Greedy word-wrap to a max width, also splitting on explicit newlines. */
function wrapLines(text: string, font: PDFFont, fontSize: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const words = raw.split(/(\s+)/); // keep spaces so widths are accurate
    let line = "";
    for (const word of words) {
      const candidate = line + word;
      if (font.widthOfTextAtSize(candidate, fontSize) > maxWidth && line.trim()) {
        out.push(line.replace(/\s+$/, ""));
        line = word.replace(/^\s+/, "");
      } else {
        line = candidate;
      }
    }
    out.push(line);
  }
  return out;
}

/*
 * Decode a data: URL to bytes WITHOUT fetch(). In the packaged build the CSP's connect-src
 * doesn't allow the data: scheme, so `fetch(dataUrl)` is blocked and throws "Failed to fetch" —
 * which surfaced as a save failure when flattening a signature. Decoding inline sidesteps that.
 */
function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  const meta = dataUrl.slice(0, comma);
  const data = dataUrl.slice(comma + 1);
  const binary = /;base64/i.test(meta) ? atob(data) : decodeURIComponent(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Pick the standard font whose look matches the original text's family, so edits blend in. */
function standardFontFor(fontFamily?: string): StandardFonts {
  const f = (fontFamily ?? "").toLowerCase();
  if (f.includes("mono") || f.includes("courier")) return StandardFonts.Courier;
  // "sans-serif" contains "serif", so check sans first.
  if (f.includes("sans")) return StandardFonts.Helvetica;
  if (f.includes("serif") || f.includes("times") || f.includes("roman") || f.includes("georgia"))
    return StandardFonts.TimesRoman;
  return StandardFonts.Helvetica;
}

async function drawAnnotation(
  a: Annotation,
  page: PDFPage,
  map: ReturnType<typeof makeMapper>,
  doc: PDFDocument,
  getFont: (fontFamily?: string) => Promise<PDFFont>,
) {
  switch (a.type) {
    case "highlight": {
      for (const q of a.rects) {
        const u = map.rect(q.x, q.y, q.w, q.h);
        page.drawRectangle({ x: u.x, y: u.y, width: u.w, height: u.h, color: col(a.color), opacity: 0.35 });
      }
      break;
    }
    case "rect": {
      const u = map.rect(a.x, a.y, a.w, a.h);
      page.drawRectangle({
        x: u.x,
        y: u.y,
        width: u.w,
        height: u.h,
        color: a.filled ? col(a.color) : undefined,
        opacity: a.filled ? a.fillOpacity : undefined,
        borderColor: a.strokeWidth > 0 ? col(a.color) : undefined,
        borderWidth: a.strokeWidth > 0 ? a.strokeWidth : undefined,
      });
      break;
    }
    case "ellipse": {
      const u = map.rect(a.x, a.y, a.w, a.h);
      page.drawEllipse({
        x: u.x + u.w / 2,
        y: u.y + u.h / 2,
        xScale: u.w / 2,
        yScale: u.h / 2,
        color: a.filled ? col(a.color) : undefined,
        opacity: a.filled ? a.fillOpacity : undefined,
        borderColor: col(a.color),
        borderWidth: a.strokeWidth,
      });
      break;
    }
    case "pen": {
      for (let i = 1; i < a.points.length; i++) {
        const p0 = map.toUser(a.points[i - 1].x, a.points[i - 1].y);
        const p1 = map.toUser(a.points[i].x, a.points[i].y);
        page.drawLine({ start: p0, end: p1, thickness: a.strokeWidth, color: col(a.color), lineCap: 1 });
      }
      break;
    }
    case "text": {
      if (!a.text.trim()) break;
      const font = await getFont(a.fontFamily);
      // Keep the glyph height at the stored size (already matched to the original). For edited
      // text, horizontally scale (PDF's Tz operator) so the original text fills its original
      // width in THIS font — matching width without inflating the size. Width is linear in scale.
      const size = a.fontSize;
      let squeeze = 1;
      if (a.fitText && a.fitWidth) {
        const natural = font.widthOfTextAtSize(a.fitText, size);
        if (natural > 0) squeeze = a.fitWidth / natural;
      }
      const lineHeight = size * 1.25;
      // Wrapping budget is in the font's own (unsqueezed) units, so wrap at the visible width.
      const lines = wrapLines(a.text, font, size, a.w / squeeze);
      // Tz is a text-state parameter; set it once, then reset after this annotation's lines.
      if (squeeze !== 1) page.pushOperators(setCharacterSqueeze(squeeze * 100));
      lines.forEach((line, i) => {
        // Baseline sits ~0.8em below the box top of each line (display space), then mapped.
        const baseY = a.y + i * lineHeight + size * 0.8;
        const p = map.toUser(a.x, baseY);
        page.drawText(line, {
          x: p.x,
          y: p.y,
          size,
          font,
          color: col(a.color),
          rotate: degrees(map.rotation),
        });
      });
      if (squeeze !== 1) page.pushOperators(setCharacterSqueeze(100));
      break;
    }
    case "signature": {
      const png = await doc.embedPng(dataUrlToBytes(a.dataUrl));
      // Anchor at the image's display bottom-left, mapped to user space.
      const p = map.toUser(a.x, a.y + a.h);
      page.drawImage(png, { x: p.x, y: p.y, width: a.w, height: a.h, rotate: degrees(map.rotation) });
      break;
    }
  }
}

/**
 * Build a flattened PDF from `filePath` + its annotations and prompt the user for a save location.
 * Returns true if a file was written, false if the user cancelled.
 */
export async function exportAnnotatedPdf(
  filePath: string,
  annotations: Annotation[],
): Promise<boolean> {
  const raw = await readPdfBytes(filePath);
  const doc = await PDFDocument.load(raw);
  const pages = doc.getPages();

  // Embed each standard font at most once and reuse it across annotations.
  const fontCache = new Map<StandardFonts, PDFFont>();
  const getFont = async (fontFamily?: string) => {
    const name = standardFontFor(fontFamily);
    let f = fontCache.get(name);
    if (!f) {
      f = await doc.embedFont(name);
      fontCache.set(name, f);
    }
    return f;
  };

  for (const a of annotations) {
    const page = pages[a.pageIndex];
    if (!page) continue;
    await drawAnnotation(a, page, makeMapper(page), doc, getFont);
  }

  const out = await doc.save();

  const dot = filePath.lastIndexOf(".");
  const suggested = (dot > 0 ? filePath.slice(0, dot) : filePath) + "-signed.pdf";
  const dest = await save({
    defaultPath: suggested,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!dest) return false;

  await writePdfBytes(dest, out);
  return true;
}
