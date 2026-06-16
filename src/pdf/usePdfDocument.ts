import { pdfjs, type PdfDocument } from "./pdfWorker";

export interface OutlineItem {
  title: string;
  pageIndex: number | null;
  items: OutlineItem[];
}

/** Load a PDF document from raw bytes. */
export async function loadPdfFromBytes(data: Uint8Array): Promise<PdfDocument> {
  // PDF.js takes ownership of the buffer, so hand it a copy-safe view.
  const task = pdfjs.getDocument({ data });
  return task.promise;
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
