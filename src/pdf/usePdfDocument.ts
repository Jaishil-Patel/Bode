import { pdfjs, type PdfDocument } from "./pdfWorker";

export interface OutlineItem {
  title: string;
  pageIndex: number | null;
  items: OutlineItem[];
}

/** Load a PDF document from raw bytes, optionally supplying a decryption password. */
export async function loadPdfFromBytes(data: Uint8Array, password?: string): Promise<PdfDocument> {
  // PDF.js transfers ownership of the buffer to its worker (detaching it); pass a copy if the
  // caller needs to reuse the bytes (e.g. a password retry).
  const task = pdfjs.getDocument({ data, password });
  return task.promise;
}

/** True when a load rejection means the PDF is encrypted and needs (a different) password. */
export function isPasswordException(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === "PasswordException";
}

/** True when the password supplied to a previous load attempt was wrong (vs. simply missing). */
export function isWrongPassword(e: unknown): boolean {
  return (
    isPasswordException(e) &&
    (e as { code?: number }).code === pdfjs.PasswordResponses.INCORRECT_PASSWORD
  );
}

/** Resolve a PDF.js outline (table of contents) into flat page indices. */
export async function getOutline(doc: PdfDocument): Promise<OutlineItem[]> {
  const raw = await doc.getOutline();
  if (!raw) return [];

  const resolve = async (dest: unknown): Promise<number | null> => {
    try {
      let explicit = dest;
      if (typeof dest === "string") {
        explicit = await doc.getDestination(dest);
      }
      if (!Array.isArray(explicit) || !explicit[0]) return null;
      const ref = explicit[0];
      const pageIndex = await doc.getPageIndex(ref as Parameters<typeof doc.getPageIndex>[0]);
      return pageIndex;
    } catch {
      return null;
    }
  };

  const walk = async (nodes: Awaited<ReturnType<typeof doc.getOutline>>): Promise<OutlineItem[]> => {
    const out: OutlineItem[] = [];
    for (const node of nodes ?? []) {
      out.push({
        title: node.title,
        pageIndex: await resolve(node.dest),
        items: await walk(node.items),
      });
    }
    return out;
  };

  return walk(raw);
}
