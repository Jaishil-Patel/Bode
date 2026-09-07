import { useEffect, useState } from "react";
import { useViewer } from "../store/viewerStore";
import { useSettings } from "../settings/useSettings";
import { useFormValues } from "./useFormValues";
import { hasAcroForm, readFormFields } from "../pdf/formFields";

/*
 * "3 of 12 required fields left", and a way to get to the next one.
 *
 * A long form's whole problem is the one box you missed on page four. Required-ness is stated in
 * the file, so this counts what is still unanswered and jumps to it — the outline the form layer
 * draws in amber does the rest once you are on the page.
 *
 * The count is document-wide, which means walking the pages once: pdf.js only reports fields per
 * page, and `getFieldObjects` returns the field tree without the flags or page numbers this needs.
 * The walk is gated on the document actually having a form, so an ordinary PDF pays one cheap
 * question and nothing else.
 */

interface RequiredField {
  key: string;
  /** 1-based VISIBLE page, which is what goToPage expects. */
  page: number;
}

/**
 * Beyond this many pages, stop scanning. A form this long is not a form anyone fills by hand, and
 * an unbounded walk on a thousand-page document would be felt.
 */
const MAX_SCAN_PAGES = 250;

export default function FormStatus() {
  const doc = useViewer((s) => s.doc);
  const numPages = useViewer((s) => s.numPages);
  const filePath = useViewer((s) => s.filePath);
  const docKey = useSettings((s) => (filePath ? s.docKey(filePath) : null));
  const values = useFormValues((s) => (docKey ? s.byFile[docKey] : undefined));

  const [required, setRequired] = useState<RequiredField[]>([]);

  useEffect(() => {
    setRequired([]);
    if (!doc || numPages === 0) return;
    let cancelled = false;

    (async () => {
      if (!(await hasAcroForm(doc)) || cancelled) return;
      // Source page numbers, so a reordered or trimmed document still scans the right pages and
      // reports the position the reader would actually scroll to.
      const manifest = useViewer.getState().pages;
      const limit = Math.min(numPages, MAX_SCAN_PAGES);
      const found: RequiredField[] = [];
      const seen = new Set<string>();
      for (let visible = 0; visible < limit; visible++) {
        if (cancelled) return;
        const src = manifest[visible]?.srcPage ?? visible + 1;
        let fields;
        try {
          fields = await readFormFields(doc, src);
        } catch {
          continue; // one unreadable page should not cost the whole count
        }
        for (const f of fields) {
          // A radio group is several widgets under one name; it is one answer to give.
          if (!f.required || f.readOnly || seen.has(f.key)) continue;
          seen.add(f.key);
          found.push({ key: f.key, page: visible + 1 });
        }
      }
      if (!cancelled) setRequired(found);
    })();

    return () => {
      cancelled = true;
    };
  }, [doc, numPages]);

  if (required.length === 0) return null;

  const answered = (f: RequiredField) => {
    const v = values?.[f.key];
    return typeof v === "string" && v.trim() !== "";
  };
  const outstanding = required.filter((f) => !answered(f));

  if (outstanding.length === 0) {
    return (
      <span
        title="Every required field on this form has an answer"
        className="hidden shrink-0 items-center rounded-full px-2.5 py-1 text-xs text-muted sm:inline-flex"
      >
        All required fields done
      </span>
    );
  }

  const next = outstanding[0];
  return (
    <button
      onClick={() => useViewer.getState().goToPage(next.page)}
      title={`Go to the next required field (${next.key}, page ${next.page})`}
      className="hidden shrink-0 items-center rounded-full px-2.5 py-1 text-xs font-medium transition-opacity hover:opacity-80 sm:inline-flex"
      style={{ background: "color-mix(in srgb, #f59e0b 20%, transparent)", color: "var(--text)" }}
    >
      {outstanding.length} of {required.length} required left
    </button>
  );
}
