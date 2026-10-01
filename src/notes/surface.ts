/*
 * Where on the document a sticky note is stuck.
 *
 * A note sits on the page, not over the window: it scrolls with the text it was put next to. Each
 * viewer knows its own geometry — a PDF has pages and a zoom, Markdown flows in one column, an HTML
 * frame scrolls inside itself — so the viewer on screen publishes a surface here, and the note code
 * asks it to turn a point on screen into a point on the document. Drawing goes the other way and is
 * done by the viewer itself (see `NoteLayer.tsx`), inside its own scrolling content, so the browser
 * moves notes with the page and they never trail a frame behind it.
 */
import { useLayoutEffect } from "react";

/** A point on the document: on a PDF page in unzoomed page points, else in the content's own px. */
export interface NoteAnchor {
  /** 1-based page, for a PDF. Absent for a document that is one long flow (Markdown, HTML). */
  page?: number;
  x: number;
  y: number;
}

export interface NoteSurface {
  /** The visible part of the document, in client px: notes are placed and kept inside it. */
  bounds(): DOMRect;
  /** The document point under a point on screen, or null when there is nothing there to stick to. */
  fromClient(x: number, y: number): NoteAnchor | null;
}

let current: NoteSurface | null = null;

export const getNoteSurface = () => current;

/** Publish `surface` for as long as the calling viewer is mounted. */
export function useNoteSurface(surface: NoteSurface | null) {
  useLayoutEffect(() => {
    if (!surface) return;
    current = surface;
    return () => {
      if (current === surface) current = null;
    };
  }, [surface]);
}
