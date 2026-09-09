import {
  PDFDocument,
  PDFBool,
  PDFName,
  StandardFonts,
  BlendMode,
  rgb,
  degrees,
  setCharacterSqueeze,
  type PDFForm,
  type PDFPage,
  type PDFFont,
} from "pdf-lib";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { readPdfBytes, writePdfBytes } from "../platform/files";
import { baseNameOf, isRemote } from "../platform/docId";
import { HIGHLIGHT_OPACITY, type Annotation } from "../annotations/useAnnotations";
import { applyManifest, type PageRef } from "./pageOps";

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
      // Multiply, matching what AnnotationLayer paints on screen and what Acrobat writes for its
      // own Highlight annotations. Without it the fill is composited normally and washes out the
      // text it covers, however low the alpha goes.
      for (const q of a.rects) {
        const u = map.rect(q.x, q.y, q.w, q.h);
        page.drawRectangle({
          x: u.x,
          y: u.y,
          width: u.w,
          height: u.h,
          color: col(a.color),
          opacity: HIGHLIGHT_OPACITY,
          blendMode: BlendMode.Multiply,
        });
      }
      break;
    }
    /*
     * Underline, strikethrough and squiggle.
     *
     * Drawn as line segments through `map.toUser`, the same route the pen takes, so a rotated
     * page is handled once and correctly rather than a second time here. The weight and the
     * vertical position inside the line box repeat what AnnotationLayer paints, so what is saved
     * is what was on screen.
     */
    case "underline":
    case "strikeout":
    case "squiggly": {
      for (const q of a.rects) {
        // Repeats AnnotationLayer's geometry so what is saved is what was on screen.
        const thickness = Math.max(0.25, q.h * 0.075 * (a.weight ?? 1));
        const y = q.y + q.h * (a.type === "strikeout" ? 0.66 : 1.02);
        if (a.type === "squiggly") {
          const amp = q.h * 0.11;
          const step = Math.max(2, amp * 2.4);
          // Sampled into short segments: pdf-lib has no quadratic primitive on a line, and at
          // this amplitude a polyline is indistinguishable from the curve it approximates.
          let prev = map.toUser(q.x, y);
          for (let x = q.x + step / 2; x < q.x + q.w + step / 2; x += step / 2) {
            const cx = Math.min(x, q.x + q.w);
            const phase = Math.round((cx - q.x) / (step / 2)) % 2 === 1;
            const py = phase ? y - amp : y;
            const pt = map.toUser(cx, py);
            page.drawLine({ start: prev, end: pt, thickness, color: col(a.color), lineCap: 1 });
            prev = pt;
          }
        } else {
          page.drawLine({
            start: map.toUser(q.x, y),
            end: map.toUser(q.x + q.w, y),
            thickness,
            color: col(a.color),
            lineCap: 1,
          });
        }
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
    /*
     * Triangle, drawn through its own corners rather than a box.
     *
     * `drawSvgPath` takes a path in PDF user space with y already the right way up, so the three
     * corners go through `map.toUser` individually — the same route the pen takes — and rotation
     * is handled once, by the mapper, rather than a second time here.
     */
    case "triangle": {
      const apex = map.toUser(a.x + a.w / 2, a.y);
      const left = map.toUser(a.x, a.y + a.h);
      const right = map.toUser(a.x + a.w, a.y + a.h);
      page.drawSvgPath(
        `M ${apex.x} ${apex.y} L ${left.x} ${left.y} L ${right.x} ${right.y} Z`,
        {
          // drawSvgPath measures from the top-left of the page, so an origin at the top undoes
          // the flip the coordinates already carry.
          x: 0,
          y: page.getSize().height,
          color: a.filled ? col(a.color) : undefined,
          opacity: a.filled ? a.fillOpacity : undefined,
          borderColor: col(a.color),
          borderWidth: a.strokeWidth,
          borderLineCap: 1,
        },
      );
      break;
    }
    case "line":
    case "arrow": {
      const from = map.toUser(a.x, a.y);
      const to = map.toUser(a.x + a.w, a.y + a.h);
      page.drawLine({ start: from, end: to, thickness: a.strokeWidth, color: col(a.color), lineCap: 1 });
      if (a.type === "arrow") {
        // The head is built in page space and mapped like everything else, so it stays attached
        // to the tip whatever rotation the page carries.
        const size = Math.max(6, a.strokeWidth * 4);
        const ang = Math.atan2(a.h, a.w);
        const spread = Math.PI / 7;
        for (const s of [-spread, spread]) {
          const bx = a.x + a.w - size * Math.cos(ang + s);
          const by = a.y + a.h - size * Math.sin(ang + s);
          page.drawLine({
            start: map.toUser(bx, by),
            end: to,
            thickness: a.strokeWidth,
            color: col(a.color),
            lineCap: 1,
          });
        }
      }
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

/** What a save did, so the caller can tell the reader anything surprising about it. */
export interface ExportResult {
  /** False when the user cancelled the save dialog. */
  saved: boolean;
  /**
   * The answers could not be baked into the page and were left as live form fields instead —
   * which happens when the text uses characters pdf-lib's standard fonts cannot draw.
   */
  formLeftEditable?: boolean;
  /** Answers whose field no longer exists in the document. */
  missingFields?: string[];
}

/*
 * Writing the reader's answers into the document, then flattening them into the page.
 *
 * Filling happens through the form rather than by drawing text: every value goes into the field it
 * belongs to, so the PDF's own rules about position, alignment, font size and comb spacing decide
 * how it looks, and a checkbox gets the tick its author drew rather than one of ours. Fields are
 * addressed by name, which is why the value store keys on the fully-qualified name pdf.js reports.
 *
 * Flattening is the last step: appearances are generated, then baked into the page content and the
 * fields removed. What comes out is a finished document — the answers cannot be edited by whoever
 * receives it, and it looks the same in every viewer.
 *
 * Only a document's real fields pass through here. A blank guessed on a flat form is an ordinary
 * text annotation by the time it reaches a save, and is drawn onto the page by `drawAnnotation`
 * along with every other mark the reader made.
 *
 * A form nobody filled is left completely alone, still interactive. Flattening is for answers, not
 * something a save does to a document on its way past.
 */

/** What could not be written, for the caller to surface. Empty means everything landed. */
export interface FormFillResult {
  /** The answers stayed as live fields because their appearances could not be drawn. */
  leftEditable: boolean;
  /** Keys that no longer match anything in the document. */
  missing: string[];
}

/**
 * Choose an option using the value the form layer recorded for it.
 *
 * The two libraries name the same option differently. pdf.js reports a button's on-state as it is
 * written in the widget's appearance dictionary, which a PDF is free to make "0", "1", "2" while
 * carrying readable labels in /Opt alongside — and /Opt is exactly what pdf-lib matches against.
 * Left unresolved, a chosen radio or list option would be dropped on save without a word. So: try
 * the value as written, then as an index into the options, then case-insensitively.
 */
function selectOption(options: string[], value: string, select: (v: string) => void): boolean {
  const attempt = (v: string) => {
    try {
      select(v);
      return true;
    } catch {
      return false;
    }
  };
  if (attempt(value)) return true;
  if (/^\d+$/.test(value)) {
    const byIndex = options[Number(value)];
    if (byIndex !== undefined && attempt(byIndex)) return true;
  }
  const insensitive = options.find((o) => o.toLowerCase() === value.toLowerCase());
  return insensitive !== undefined ? attempt(insensitive) : false;
}

function setFieldValue(form: PDFForm, name: string, value: string): boolean {
  // getFieldMaybe rather than getField: a document edited elsewhere since the value was typed
  // should skip that one answer, not fail the whole save.
  const field = form.getFieldMaybe(name);
  if (!field) return false;
  const kind = field.constructor.name;
  try {
    if (kind === "PDFTextField") {
      form.getTextField(name).setText(value);
    } else if (kind === "PDFCheckBox") {
      const box = form.getCheckBox(name);
      if (value) box.check();
      else box.uncheck();
    } else if (kind === "PDFRadioGroup") {
      const group = form.getRadioGroup(name);
      if (!value) group.clear();
      else if (!selectOption(group.getOptions(), value, (v) => group.select(v))) return false;
    } else if (kind === "PDFDropdown") {
      const dropdown = form.getDropdown(name);
      if (!value) dropdown.clear();
      else if (!selectOption(dropdown.getOptions(), value, (v) => dropdown.select(v))) return false;
    } else if (kind === "PDFOptionList") {
      const list = form.getOptionList(name);
      if (!value) list.clear();
      else if (!selectOption(list.getOptions(), value, (v) => list.select(v))) return false;
    } else {
      return false; // a signature or push button; nothing of ours to write
    }
    return true;
  } catch {
    // A value that is no longer one of the field's options, most likely. Skip it rather than
    // abandoning every other answer in the document.
    return false;
  }
}

/**
 * Fill the document's form from `values`.
 *
 * Runs before any page manifest is applied, because rebuilding the page order drops the
 * document-level AcroForm along with it — see the call site.
 */
async function applyFormValues(
  doc: PDFDocument,
  values: Record<string, string>,
): Promise<FormFillResult> {
  const result: FormFillResult = { leftEditable: false, missing: [] };
  const entries = Object.entries(values).filter(([, v]) => v !== "");
  if (entries.length === 0) return result;

  const form = doc.getForm();
  for (const [key, value] of entries) {
    if (!setFieldValue(form, key, value)) result.missing.push(key);
  }

  // Draw each answer, then bake the drawings into the page and drop the fields.
  //
  // pdf-lib builds appearances with its standard fonts, which are WinAnsi — an accented name is
  // fine, Greek or CJK is not, and the attempt throws. There is nothing to fall back to for
  // flattening (a field with no appearance flattens to nothing, silently losing the answer), so
  // the form is left live instead and NeedAppearances asks the viewer to draw it. The answers are
  // correctly stored either way; the caller says which of the two happened.
  try {
    const helvetica = await doc.embedFont(StandardFonts.Helvetica);
    form.updateFieldAppearances(helvetica);
    form.flatten({ updateFieldAppearances: false }); // just done, with a font we chose
  } catch {
    result.leftEditable = true;
    try {
      form.acroForm.dict.set(PDFName.of("NeedAppearances"), PDFBool.True);
    } catch {
      // Nothing further to try; the values are still in the file.
    }
  }

  return result;
}

/**
 * Build a flattened PDF from `filePath` + its annotations and prompt the user for a save location.
 * Returns true if a file was written, false if the user cancelled.
 */
export async function exportAnnotatedPdf(
  filePath: string,
  annotations: Annotation[],
  /** When set, the (encrypted) source is decrypted first so the saved copy opens without a password. */
  password?: string,
  /** Staged page edits. When set, the output is rebuilt in this page order before flattening. */
  manifest?: PageRef[],
  /** Answers typed into the document's form, by field name (or detected-slot key). */
  formValues?: Record<string, string>,
): Promise<ExportResult> {
  const raw = await readPdfBytes(filePath);
  // pdf-lib can't parse an encrypted PDF, so decrypt via the Rust backend before flattening.
  const source = password ? await decryptPdfBytes(raw, password) : raw;
  const loaded = await PDFDocument.load(source);

  // Fill and flatten BEFORE anything rebuilds the document. Applying a manifest copies pages into
  // a fresh PDFDocument, and while that carries each page's widgets across it leaves the
  // document-level AcroForm behind — field tree, resources and all — so a form filled afterwards
  // would come out orphaned. Flattened first, the answers are page content and copy across intact.
  const fill = formValues
    ? await applyFormValues(loaded, formValues)
    : { leftEditable: false, missing: [] };

  // Apply page removals/reordering. The rebuilt page order *is* the manifest order, which is
  // the space annotation `pageIndex` already counts in, so they need no further mapping below.
  const doc = manifest ? await applyManifest(loaded, manifest) : loaded;
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

  // Appearances are this file's business, not the serializer's: they were generated (and usually
  // flattened away) during the fill, and where that failed the document deliberately carries
  // NeedAppearances instead. Left to its default, save() regenerates them and throws again on the
  // very text the fill already decided it could not draw — losing the whole save, not just a
  // field's appearance.
  const out = await doc.save({ updateFieldAppearances: false });

  // A decrypted save is a different artefact than a signed one — name it accordingly.
  const suffix = password ? "-unlocked.pdf" : "-edited.pdf";
  const dest = await save({
    defaultPath: suggestedSaveName(filePath, suffix),
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!dest) return { saved: false };

  await writePdfBytes(dest, out);
  return { saved: true, formLeftEditable: fill.leftEditable, missingFields: fill.missing };
}

/** Swap a path's extension for `suffix` (e.g. "/a/b.pdf" + "-unlocked.pdf" → "/a/b-unlocked.pdf"). */
export function withSuffix(filePath: string, suffix: string): string {
  const dot = filePath.lastIndexOf(".");
  return (dot > 0 ? filePath.slice(0, dot) : filePath) + suffix;
}

/**
 * What to hand a save dialog as its starting point.
 *
 * A real filesystem path is passed whole, because the dialog uses its directory to decide where to
 * open — that is the desktop behaviour we want. A `content://` URI or a `bode://` id is NOT a path:
 * its last dot may sit inside a provider authority or a percent-escape, so `withSuffix` on the whole
 * string produces a nonsense suggestion. Those collapse to a bare file name instead.
 */
function suggestedSaveName(docId: string, suffix: string): string {
  const isPath = !isRemote(docId) && !docId.startsWith("content://");
  return withSuffix(isPath ? docId : baseNameOf(docId), suffix);
}

/** Decrypt PDF bytes via the Rust `decrypt_pdf` command, returning the plaintext PDF bytes. */
async function decryptPdfBytes(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  const raw = await invoke<number[] | Uint8Array>("decrypt_pdf", {
    bytes: Array.from(bytes),
    password,
  });
  return raw instanceof Uint8Array ? raw : Uint8Array.from(raw);
}

/**
 * Write a decrypted copy of a password-protected PDF, using the password the user already unlocked
 * it with. Returns true if a file was written, false if the user cancelled.
 */
export async function saveUnlockedPdf(filePath: string, password: string): Promise<boolean> {
  const bytes = await readPdfBytes(filePath);
  const out = await decryptPdfBytes(bytes, password);
  const dest = await save({
    defaultPath: suggestedSaveName(filePath, "-unlocked.pdf"),
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!dest) return false;

  await writePdfBytes(dest, out);
  return true;
}
