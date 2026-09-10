import { useEffect, useMemo, useState } from "react";
import type { PdfDocument } from "./pdfWorker";
import { readFormFields, type FieldRect, type FormField } from "./formFields";
import { readDetectedSlots, type DetectedSlot } from "./detectFields";
import { useFormValues } from "../forms/useFormValues";
import { useSettings } from "../settings/useSettings";
import { newId, useAnnotations } from "../annotations/useAnnotations";
import { fitInside, useSignatureAspect } from "../annotations/signature";

/*
 * The fillable layer over a page.
 *
 * A PDF that carries a real form already knows where every box is, what kind it is, what it is
 * called and whether it has to be answered — so this puts a real input on each one and gets out of
 * the way. A flat scan knows none of that, so slots guessed by `detectFields` show as dashed
 * outlines, and only when the reader asks for them.
 *
 * Clicking one of those outlines does not create some third kind of thing: it drops an ordinary
 * text annotation on the blank, sized to it and ready to type in. From that moment it is a text
 * box like any other — move it, resize it from the corner, delete it, undo it — because it *is*
 * one. A guess is only ever a suggestion of where to put a text box; nothing about it needs to
 * survive as a separate concept, and a slot the reader has filled simply stops being offered.
 *
 * What pdf.js still paints, and what this has to draw
 * --------------------------------------------------
 * With `AnnotationMode.ENABLE_FORMS`, pdf.js returns an empty operator list for a widget — leaving
 * the canvas bare for an HTML layer like this one — but only for the ones it expects that layer to
 * own. Read-only fields (`hasOwnCanvas`), push buttons (`hasOwnCanvas`) and signature fields
 * (excluded by name) keep being painted exactly as the author drew them. So this layer renders
 * controls for editable fields only; the rest are already on screen and are left alone, apart from
 * a click target over a signature field.
 *
 * Geometry is in display space (PDF points at scale 1, top-left origin), the same space
 * annotations use — so drawing at the current zoom is a multiply by `scale`, and a signature
 * dropped into a signature field needs no conversion at all. Fields are read once per page and
 * projected in a memo, never re-read on zoom: re-fetching mid-keystroke would throw away focus
 * and the caret.
 */

interface Props {
  doc: PdfDocument;
  /** 1-based SOURCE page — fields belong to the page in the file, like links do. */
  pageNumber: number;
  /** 0-based VISIBLE index, which is the space annotations and slot keys count in. */
  pageIndex: number;
  scale: number;
  filePath: string;
}

/** Fields that are ours to draw. The rest are already painted on the canvas. */
const isEditable = (f: FormField) =>
  !f.readOnly && f.kind !== "button" && f.kind !== "signature";

const px = (rect: FieldRect, scale: number) => ({
  left: rect.x * scale,
  top: rect.y * scale,
  width: rect.w * scale,
  height: rect.h * scale,
});

/** Field chrome: enough tint to find the blanks at a glance, not enough to fight the page. */
const FILLABLE_BG = "color-mix(in srgb, var(--accent-ink) 9%, transparent)";
const FILLABLE_BORDER = "color-mix(in srgb, var(--accent-ink) 38%, transparent)";
/** A required field nobody has answered yet. Amber reads on every theme, light or dark. */
const REQUIRED_BORDER = "#f59e0b";

export default function FormLayer({ doc, pageNumber, pageIndex, scale, filePath }: Props) {
  const docKey = useSettings((s) => s.docKey(filePath));
  const values = useFormValues((s) => s.byFile[docKey]);
  const setValue = useFormValues((s) => s.setValue);
  const tool = useAnnotations((s) => s.tool);
  const signatureDataUrl = useAnnotations((s) => s.signatureDataUrl);
  const signatureAspect = useSignatureAspect(signatureDataUrl);

  const annotations = useAnnotations((s) => s.byFile[docKey]);

  const [fields, setFields] = useState<FormField[]>([]);
  const [slots, setSlots] = useState<DetectedSlot[]>([]);

  // Read the page's real fields once. Deliberately not keyed on `scale`.
  useEffect(() => {
    let cancelled = false;
    readFormFields(doc, pageNumber)
      .then((f) => {
        if (!cancelled) setFields(f);
      })
      .catch(() => {
        if (!cancelled) setFields([]);
      });
    return () => {
      cancelled = true;
    };
  }, [doc, pageNumber]);

  // Guessing is opt-in (the form tool) and only makes sense where there is no real form.
  const detecting = tool === "form" && fields.length === 0;
  useEffect(() => {
    if (!detecting) {
      setSlots([]);
      return;
    }
    let cancelled = false;
    readDetectedSlots(doc, pageNumber, pageIndex)
      .then((s) => {
        if (!cancelled) setSlots(s);
      })
      .catch(() => {
        if (!cancelled) setSlots([]);
      });
    return () => {
      cancelled = true;
    };
  }, [detecting, doc, pageNumber, pageIndex]);

  /*
   * Whether a click on this layer lands on a field.
   *
   * Select is the everyday tool, so fields are live without anyone choosing a mode — that is what
   * makes a form fillable on sight. But the highlighter and the text-edit tool deliberately let
   * clicks fall through to the real text layer underneath, and an input sitting on top would eat
   * the very drag they need. So the controls go inert for those, the same way annotations do.
   */
  const interactive = tool === "select" || tool === "form";
  const controlPE: React.CSSProperties["pointerEvents"] = interactive ? "auto" : "none";

  const editable = useMemo(() => fields.filter(isEditable), [fields]);
  const signatures = useMemo(() => fields.filter((f) => f.kind === "signature"), [fields]);

  const valueOf = (f: FormField) => values?.[f.key] ?? f.initial;

  /*
   * Boxes on this page that already hold something the reader put there.
   *
   * A blank with a text box already on it is answered, so it stops being offered — and because
   * this is measured geometrically rather than by remembering which slot was clicked, it keeps
   * working after the box has been dragged somewhere else or resized.
   */
  const filledBoxes = useMemo(
    () =>
      (annotations ?? [])
        .filter((a) => a.pageIndex === pageIndex)
        .flatMap((a) =>
          a.type === "text"
            ? [{ x: a.x, y: a.y, w: a.w, h: a.h ?? a.fontSize * 1.4 }]
            : a.type === "signature"
              ? [{ x: a.x, y: a.y, w: a.w, h: a.h }]
              : [],
        ),
    [annotations, pageIndex],
  );

  const alreadyFilled = (r: FieldRect) => {
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    return filledBoxes.some((b) => cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h);
  };

  /** Turn a guessed blank into a plain text box, sized to it and ready to type in. */
  const fillSlot = (slot: DetectedSlot) => {
    const store = useAnnotations.getState();
    const id = newId();
    store.add(docKey, {
      id,
      pageIndex,
      type: "text",
      color: store.activeColor(),
      x: slot.rect.x,
      y: slot.rect.y,
      w: slot.rect.w,
      h: slot.rect.h,
      // Sized to the blank rather than to the last size the text tool was set to — a form's
      // lines are the one place the right size is already decided for you.
      fontSize: Math.max(6, Math.round(Math.min(slot.rect.h * 0.72, 14))),
      // A tick box gets the mark someone would write in it anyway. "X" rather than a check
      // glyph because the export draws with a standard PDF font, which cannot encode "✓".
      text: slot.kind === "checkbox" ? "X" : "",
    });
    store.setSelected(id);
    store.setEditingId(id);
  };

  const placeSignature = (rect: FieldRect) => {
    const store = useAnnotations.getState();
    if (!store.signatureDataUrl) {
      // Nothing drawn yet — open the pad, exactly as the signature tool does. The next click
      // on the field places it.
      store.setSignaturePadOpen(true);
      return;
    }
    const id = newId();
    store.add(docKey, {
      id,
      pageIndex,
      type: "signature",
      color: "#000000",
      ...fitInside(rect, signatureAspect),
      dataUrl: store.signatureDataUrl,
    });
    store.setSelected(id);
  };

  if (editable.length === 0 && signatures.length === 0 && slots.length === 0) return null;

  const fontPx = (f: FormField) =>
    (f.fontSize && f.fontSize > 0 ? f.fontSize : Math.min(f.rect.h * 0.62, 11)) * scale;

  const alignOf = (f: FormField) =>
    f.align === 1 ? "center" : f.align === 2 ? "right" : "left";

  const baseStyle = (f: FormField): React.CSSProperties => {
    const empty = !valueOf(f).trim();
    return {
      position: "absolute",
      ...px(f.rect, scale),
      pointerEvents: controlPE,
      boxSizing: "border-box",
      margin: 0,
      background: FILLABLE_BG,
      border: `1px solid ${f.required && empty ? REQUIRED_BORDER : FILLABLE_BORDER}`,
      borderRadius: 2,
      color: "var(--text)",
      font: "inherit",
      fontSize: fontPx(f),
      lineHeight: 1.15,
      padding: `0 ${Math.max(1, 2 * scale)}px`,
      outline: "none",
    };
  };

  return (
    <div className="absolute inset-0" style={{ pointerEvents: "none", zIndex: 2 }}>
      {editable.map((f) => {
        const value = valueOf(f);
        const title = f.required ? `${f.label} (required)` : f.label;
        const commit = (v: string) => setValue(docKey, f.key, v);

        if (f.kind === "checkbox" || f.kind === "radio") {
          const on = value === (f.onValue ?? "On");
          return (
            <button
              key={f.widgetId}
              title={title}
              aria-label={title}
              aria-pressed={on}
              onClick={() => commit(on ? "" : (f.onValue ?? "On"))}
              style={{
                ...baseStyle(f),
                borderRadius: f.kind === "radio" ? "50%" : 2,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                padding: 0,
              }}
            >
              {on && (
                <span
                  style={{
                    // A dot for a radio, a tick for a box — the shapes people expect.
                    width: f.kind === "radio" ? "56%" : "72%",
                    height: f.kind === "radio" ? "56%" : "72%",
                    borderRadius: f.kind === "radio" ? "50%" : 0,
                    background: f.kind === "radio" ? "var(--text)" : "transparent",
                    color: "var(--text)",
                    fontSize: Math.max(8, f.rect.h * scale * 0.8),
                    lineHeight: 1,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {f.kind === "checkbox" ? "✓" : ""}
                </span>
              )}
            </button>
          );
        }

        if (f.kind === "dropdown" || f.kind === "listbox") {
          return (
            <select
              key={f.widgetId}
              title={title}
              aria-label={title}
              value={value}
              onChange={(e) => commit(e.target.value)}
              style={{ ...baseStyle(f), cursor: "pointer" }}
            >
              <option value="" />
              {f.options?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          );
        }

        if (f.multiline) {
          return (
            <textarea
              key={f.widgetId}
              title={title}
              aria-label={title}
              value={value}
              maxLength={f.maxLen}
              onChange={(e) => commit(e.target.value)}
              style={{ ...baseStyle(f), resize: "none", textAlign: alignOf(f), paddingTop: 1 }}
            />
          );
        }

        return (
          <input
            key={f.widgetId}
            type="text"
            title={title}
            aria-label={title}
            value={value}
            maxLength={f.maxLen}
            onChange={(e) => commit(e.target.value)}
            style={{ ...baseStyle(f), textAlign: alignOf(f) }}
          />
        );
      })}

      {/* Signature fields keep the appearance pdf.js painted; this is just somewhere to click. */}
      {signatures.map((f) => (
        <button
          key={f.widgetId}
          title={`${f.label} — click to sign`}
          aria-label={`${f.label} — click to sign`}
          onClick={() => placeSignature(f.rect)}
          style={{
            position: "absolute",
            ...px(f.rect, scale),
            pointerEvents: controlPE,
            cursor: "pointer",
            background: FILLABLE_BG,
            border: `1px dashed ${f.required ? REQUIRED_BORDER : FILLABLE_BORDER}`,
            borderRadius: 2,
            padding: 0,
          }}
        />
      ))}

      {/* Guessed blanks: a dashed suggestion until clicked, an ordinary text box after. */}
      {slots.map((slot) =>
        alreadyFilled(slot.rect) ? null : (
          <button
            key={slot.key}
            title={
              slot.label
                ? `Fill in: ${slot.label}`
                : `Detected blank (${slot.source}) — click to add a text box`
            }
            aria-label={slot.label ? `Fill in ${slot.label}` : "Detected blank"}
            onClick={() => fillSlot(slot)}
            style={{
              position: "absolute",
              ...px(slot.rect, scale),
              pointerEvents: controlPE,
              cursor: "text",
              background: "transparent",
              border: `1px dashed ${FILLABLE_BORDER}`,
              borderRadius: 2,
              padding: 0,
            }}
          />
        ),
      )}
    </div>
  );
}
