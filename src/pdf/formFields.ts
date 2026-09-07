import type { PdfDocument } from "./pdfWorker";

/*
 * Reading a page's interactive form fields.
 *
 * Every fillable box in a PDF is a "widget" annotation — the same channel links arrive on, which
 * is why this reads almost exactly like LinkLayer's fetch. What a widget carries is the whole
 * point of the feature: the field's exact box, its type, its name, and whether it is required.
 * None of that has to be guessed.
 *
 * Rects come back in Bode's display space — PDF points at scale 1, top-left origin, the page's
 * own /Rotate already applied. That is deliberately the same space annotations live in, so a
 * signature dropped into a signature field needs no conversion at all, and drawing at the
 * current zoom is a plain multiply by `scale`. The conversion is exact because a pdf.js viewport
 * transform is linear in its scale: projecting at 1 and multiplying is the same as projecting
 * at `scale`, and doing it this way means a zoom never re-reads the document.
 */

export type FieldKind =
  | "text"
  | "checkbox"
  | "radio"
  | "dropdown"
  | "listbox"
  | "signature"
  | "button";

export interface FieldRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FormField {
  /** Fully-qualified field name — the key values are stored under. Radios share one per group. */
  key: string;
  /** This widget's own pdf.js id. Unique even among the radios sharing a `key`. */
  widgetId: string;
  kind: FieldKind;
  /** Display space: PDF points at scale 1, top-left origin. Multiply by `scale` to draw. */
  rect: FieldRect;
  /** The tooltip (/TU) if the author wrote one, else the field name. */
  label: string;
  required: boolean;
  readOnly: boolean;
  /** The value already in the file, used until the reader types something of their own. */
  initial: string;
  /** Choice fields only. */
  options?: { value: string; label: string }[];
  /** The "on" state this particular checkbox or radio widget turns the field to. */
  onValue?: string;
  maxLen?: number;
  multiline?: boolean;
  comb?: boolean;
  /** From the /DA string. 0 means "auto-size to the box", which is what pdf.js reports for it. */
  fontSize?: number;
  /** 0 left, 1 centre, 2 right. */
  align?: number;
}

/** pdf.js hands these back as plain objects with no useful type, so name the bits we read. */
interface WidgetData {
  id?: string;
  subtype?: string;
  fieldType?: string;
  fieldName?: string;
  fieldValue?: unknown;
  alternativeText?: string;
  rect?: number[];
  hidden?: boolean;
  readOnly?: boolean;
  required?: boolean;
  multiLine?: boolean;
  comb?: boolean;
  maxLen?: number;
  textAlignment?: number | null;
  checkBox?: boolean;
  radioButton?: boolean;
  pushButton?: boolean;
  combo?: boolean;
  exportValue?: string;
  buttonValue?: string | null;
  options?: { exportValue?: string; displayValue?: string }[];
  defaultAppearanceData?: { fontSize?: number };
}

function kindOf(a: WidgetData): FieldKind | null {
  switch (a.fieldType) {
    case "Tx":
      return "text";
    case "Sig":
      return "signature";
    case "Ch":
      return a.combo ? "dropdown" : "listbox";
    case "Btn":
      if (a.pushButton) return "button";
      if (a.radioButton) return "radio";
      return "checkbox"; // pdf.js reports neither flag for a plain checkbox
    default:
      return null; // an unimplemented widget type; leave whatever pdf.js drew alone
  }
}

/**
 * The field's current value as a string.
 *
 * Choice fields report an array (they can be multi-select) and buttons report the name of the
 * chosen state, so this flattens both to the one shape the value store keeps.
 */
function initialValue(a: WidgetData): string {
  const v = a.fieldValue;
  if (Array.isArray(v)) return v.length ? String(v[0]) : "";
  if (v == null) return "";
  return String(v);
}

/** Read every fillable field on a page. Empty for a document with no form. */
export async function readFormFields(
  doc: PdfDocument,
  pageNumber: number,
): Promise<FormField[]> {
  const page = await doc.getPage(pageNumber);
  const annotations = await page.getAnnotations({ intent: "display" });
  // Scale 1: display points. See the note at the top of the file.
  const viewport = page.getViewport({ scale: 1 });

  const out: FormField[] = [];
  for (const raw of annotations as WidgetData[]) {
    if (raw.subtype !== "Widget" || raw.hidden) continue;
    const kind = kindOf(raw);
    if (!kind) continue;
    if (!Array.isArray(raw.rect)) continue;

    // convertToViewportRectangle applies the scale, the bottom-left-to-top-left flip and the
    // page's /Rotate in one step. The corners can come back either way round after the flip.
    const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(raw.rect);
    const rect: FieldRect = {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      w: Math.abs(x2 - x1),
      h: Math.abs(y2 - y1),
    };
    // A zero-sized widget cannot be clicked and would render as an invisible trap.
    if (rect.w < 1 || rect.h < 1) continue;

    const key = raw.fieldName ?? raw.id ?? "";
    if (!key) continue;

    out.push({
      key,
      widgetId: raw.id ?? key,
      kind,
      rect,
      label: raw.alternativeText?.trim() || key,
      required: raw.required === true,
      readOnly: raw.readOnly === true,
      initial: initialValue(raw),
      options: raw.options?.length
        ? raw.options.map((o) => ({
            value: o.exportValue ?? o.displayValue ?? "",
            label: o.displayValue ?? o.exportValue ?? "",
          }))
        : undefined,
      // A checkbox names its on-state in /AP; a radio names it per widget. Either way the
      // fallback is "On", the near-universal default.
      onValue:
        kind === "checkbox"
          ? raw.exportValue || "On"
          : kind === "radio"
            ? raw.buttonValue || "On"
            : undefined,
      maxLen: raw.maxLen || undefined,
      multiline: raw.multiLine === true,
      comb: raw.comb === true,
      fontSize: raw.defaultAppearanceData?.fontSize || undefined,
      align: raw.textAlignment ?? undefined,
    });
  }
  return out;
}

/**
 * Whether this document has an AcroForm at all — one cheap document-level question, rather than
 * reading every page to find out. `getFieldObjects` resolves to null when there is no form.
 */
export async function hasAcroForm(doc: PdfDocument): Promise<boolean> {
  try {
    const fields = await doc.getFieldObjects();
    return !!fields && Object.keys(fields).length > 0;
  } catch {
    return false;
  }
}
