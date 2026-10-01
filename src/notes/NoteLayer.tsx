/*
 * Every sticky note for the document on screen — PDF, Markdown or HTML alike.
 *
 * Drawn by the viewers, inside their own scrolling content, because a note is stuck to the page:
 * a PDF page draws the notes on it (`PageNotes`), and a document that is one long flow draws its
 * notes over that flow (`FlowNotes`). The browser then scrolls and clips them with the page itself.
 * Each viewer also publishes a surface (see `surface.ts`) through `useStickNotes`, which is how a
 * point on screen — a click with the Note tool, a note dropped after a drag — becomes a point on
 * the document.
 */
import { useEffect, useMemo, useState } from "react";
import { useViewer } from "../store/viewerStore";
import { useSettings } from "../settings/useSettings";
import NotePane from "./NotePane";
import { keepInView, useNotes, type Note } from "./useNotes";
import { getNoteSurface, useNoteSurface, type NoteSurface } from "./surface";
import { TITLE_H } from "../portals/usePortals";
import { contentTop } from "../platform/contentTop";

/* The same reference every time, so a document with no notes is not a new state on every render —
   see the matching note in `portals/PortalLayer.tsx`. */
const NONE: Note[] = [];

/** The document on screen's key and notes, and each note's place in the stacking order. */
function useDocNotes() {
  const filePath = useViewer((s) => s.filePath);
  const docKey = useSettings((s) => (filePath ? s.docKey(filePath) : null));
  const notes = useNotes((s) => (docKey ? (s.byDoc[docKey]?.notes ?? NONE) : NONE));
  const floating = useSettings((s) => s.layout.notesMode === "window");
  // Ranked across the whole document rather than per page, so a note hanging over the next page
  // stacks against that page's notes the same way it would anywhere else.
  const rank = useMemo(() => {
    const m = new Map<string, number>();
    [...notes].sort((a, b) => a.z - b.z).forEach((n, i) => m.set(n.id, i));
    return m;
  }, [notes]);
  return { docKey, notes, rank, floating };
}

/** The notes stuck to one PDF page, drawn inside that page so they follow its zoom and scroll. */
export function PageNotes({ page, scale }: { page: number; scale: number }) {
  const { docKey, notes, rank, floating } = useDocNotes();
  if (!docKey || floating) return null;
  return (
    <>
      {notes
        .filter((n) => n.at?.page === page)
        .map((n) => (
          <NotePane
            key={n.id}
            note={n}
            docKey={docKey}
            stack={rank.get(n.id) ?? 0}
            // Where on the page is zoomed with it; the note itself keeps its size, as a sticky
            // note would — shrunk with a zoomed-out page it would soon be unreadable.
            left={n.at!.x * scale}
            top={n.at!.y * scale}
          />
        ))}
    </>
  );
}

/**
 * The notes on a document with no pages, drawn over its content. `dx`/`dy` shift them, for content
 * that scrolls somewhere this layer is not (an HTML frame scrolls inside itself).
 */
export function FlowNotes({ dx = 0, dy = 0 }: { dx?: number; dy?: number }) {
  const { docKey, notes, rank, floating } = useDocNotes();
  if (!docKey || floating) return null;
  return (
    <>
      {notes
        .filter((n) => n.at && n.at.page == null)
        .map((n) => (
          <NotePane
            key={n.id}
            note={n}
            docKey={docKey}
            stack={rank.get(n.id) ?? 0}
            left={n.at!.x + dx}
            top={n.at!.y + dy}
          />
        ))}
    </>
  );
}

/**
 * The notes for the document on screen, floating over the window: the other way notes can work
 * (see `notesMode`). They stay put while the document scrolls underneath, for keeping a thought in
 * view while reading on. Drawn by App, outside every viewer, so nothing the document does moves them.
 */
export default function WindowNotes() {
  const { docKey, notes, rank, floating } = useDocNotes();

  // Panes are kept inside the window when drawn, so a smaller window has to redraw them.
  const [, setSize] = useState(0);
  useEffect(() => {
    const onResize = () => setSize((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  if (!docKey || !floating) return null;
  return (
    <>
      {notes.map((n) => (
        <NotePane
          key={n.id}
          note={n}
          docKey={docKey}
          stack={rank.get(n.id) ?? 0}
          floating
          // Drawn inside the window, below its bars, without rewriting where the note was put, so
          // making the window big again puts it back.
          left={Math.max(0, Math.min(n.x, window.innerWidth - 60))}
          top={Math.max(contentTop(), Math.min(n.y, window.innerHeight - TITLE_H))}
        />
      ))}
    </>
  );
}

/**
 * Publish a viewer's surface, and stick any loose notes to it.
 *
 * A note is loose when it has a place on the window but none on the document: it was made before
 * notes stuck to pages, or while no viewer was up to stick it to. It is stuck to whatever is under
 * that spot now, once the viewer has had a moment to restore its scroll position.
 */
export function useStickNotes(surface: NoteSurface | null) {
  useNoteSurface(surface);
  const { docKey, notes } = useDocNotes();
  const loose = notes.some((n) => !n.at);
  useEffect(() => {
    if (!surface || !docKey || !loose) return;
    const t = window.setTimeout(() => {
      if (getNoteSurface() !== surface) return;
      const { update } = useNotes.getState();
      const view = surface.bounds();
      for (const n of useNotes.getState().byDoc[docKey]?.notes ?? []) {
        if (n.at) continue;
        const p = keepInView(n, view);
        const at = surface.fromClient(p.x, p.y);
        if (at) update(docKey, n.id, { at });
      }
    }, 300);
    return () => window.clearTimeout(t);
  }, [surface, docKey, loose]);
}

/** Add a note to the document on screen, if there is one. For the toolbar, palette and shortcut. */
export function addNoteToCurrentDoc() {
  const filePath = useViewer.getState().filePath;
  if (!filePath) return;
  useNotes.getState().add(useSettings.getState().docKey(filePath));
}
