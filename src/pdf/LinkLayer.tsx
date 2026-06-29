import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { PdfDocument } from "./pdfWorker";
import { resolveDestination } from "./usePdfDocument";
import { useViewer } from "../store/viewerStore";

interface Props {
  doc: PdfDocument;
  pageNumber: number; // 1-based
  scale: number;
}

interface LinkRect {
  left: number;
  top: number;
  width: number;
  height: number;
  url?: string; // external URI link
  dest?: unknown; // internal GoTo destination (named string or explicit array)
}

// Only follow links we understand and trust; PDF.js already sanitizes `url`.
const isSafeUrl = (url: string) => /^(https?:|mailto:)/i.test(url);

/**
 * Transparent overlay that turns a page's PDF link annotations into clickable hotspots:
 * external URI links open in the system browser, internal GoTo links scroll to their target.
 * The container is pointer-events:none so text selection and annotation drawing pass through;
 * only the link rects themselves capture clicks.
 */
export default function LinkLayer({ doc, pageNumber, scale }: Props) {
  const [links, setLinks] = useState<LinkRect[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const page = await doc.getPage(pageNumber);
      if (cancelled) return;
      const annotations = await page.getAnnotations({ intent: "display" });
      if (cancelled) return;
      const viewport = page.getViewport({ scale });

      const out: LinkRect[] = [];
      for (const a of annotations as Array<Record<string, unknown>>) {
        if (a.subtype !== "Link") continue;
        const url = typeof a.url === "string" ? a.url : undefined;
        const dest = a.dest;
        if (!url && !dest) continue; // nothing actionable (e.g. named JS actions)
        if (url && !isSafeUrl(url)) continue;

        const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(a.rect as number[]);
        out.push({
          left: Math.min(x1, x2),
          top: Math.min(y1, y2),
          width: Math.abs(x2 - x1),
          height: Math.abs(y2 - y1),
          url,
          dest,
        });
      }
      setLinks(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [doc, pageNumber, scale]);

  if (links.length === 0) return null;

  const onClick = (link: LinkRect) => {
    if (link.url) {
      void openUrl(link.url).catch((e) =>
        useViewer.setState({ error: `Couldn't open link: ${e instanceof Error ? e.message : String(e)}` }),
      );
    } else if (link.dest !== undefined) {
      void resolveDestination(doc, link.dest).then((r) => {
        if (r) useViewer.getState().goToPdfDestination(r.pageIndex, r.topPts);
      });
    }
  };

  return (
    <div className="absolute inset-0" style={{ pointerEvents: "none", zIndex: 2 }}>
      {links.map((link, i) => (
        <button
          key={i}
          title={link.url}
          onClick={() => onClick(link)}
          className="absolute"
          style={{
            left: link.left,
            top: link.top,
            width: link.width,
            height: link.height,
            pointerEvents: "auto",
            cursor: "pointer",
            background: "transparent",
            border: "none",
            padding: 0,
          }}
        />
      ))}
    </div>
  );
}
