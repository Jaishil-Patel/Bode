import type { PdfDocument } from "./pdfWorker";

export interface SearchMatch {
  /** 0-based page index this match is on. */
  pageIndex: number;
  /** Occurrence index of the match within its page (0-based), in reading order. */
  occurrenceOnPage: number;
}

/**
 * Scan every page's text for `query` (case-insensitive) and return ordered matches.
 *
 * Matches are counted per text item, identically to how PdfPage highlights them, so
 * counts and highlights stay consistent. Matches that span across separate text items
 * are not detected — an acceptable tradeoff for v1 simplicity.
 */
export async function searchDocument(
  doc: PdfDocument,
  query: string,
  signal?: { cancelled: boolean }
): Promise<SearchMatch[]> {
  const needle = query.toLowerCase();
  if (!needle) return [];

  const matches: SearchMatch[] = [];
  for (let p = 0; p < doc.numPages; p++) {
    if (signal?.cancelled) return matches;
    const page = await doc.getPage(p + 1);
    const content = await page.getTextContent();
    let occ = 0;
    for (const item of content.items) {
      const str = "str" in item ? item.str.toLowerCase() : "";
      let from = 0;
      let idx = str.indexOf(needle, from);
      while (idx !== -1) {
        matches.push({ pageIndex: p, occurrenceOnPage: occ });
        occ++;
        from = idx + needle.length;
        idx = str.indexOf(needle, from);
      }
    }
    page.cleanup();
  }
  return matches;
}

/** Count of matches occurring on a given page. */
export function matchesOnPage(matches: SearchMatch[], pageIndex: number): number {
  return matches.reduce((n, m) => (m.pageIndex === pageIndex ? n + 1 : n), 0);
}
