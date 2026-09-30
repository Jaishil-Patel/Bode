/*
 * Every sticky note for the document on screen — PDF, Markdown or HTML alike.
 *
 * Lives beside the portal layer in App, outside every viewer, for the same reason: a note is pinned
 * to the window, so nothing the document does underneath may move it or take it away.
 */
import { useEffect, useState } from "react";
import { useViewer } from "../store/viewerStore";
import { useSettings } from "../settings/useSettings";
import NotePane from "./NotePane";
import { useNotes, type Note } from "./useNotes";

/* The same reference every time, so a document with no notes is not a new state on every render —
   see the matching note in `portals/PortalLayer.tsx`. */
const NONE: Note[] = [];

export default function NoteLayer() {
  const filePath = useViewer((s) => s.filePath);
  const docKey = useSettings((s) => (filePath ? s.docKey(filePath) : null));
  const notes = useNotes((s) => (docKey ? (s.byDoc[docKey]?.notes ?? NONE) : NONE));

  // Panes are kept inside the window when drawn, so a smaller window has to redraw them.
  const [, setSize] = useState(0);
  useEffect(() => {
    const onResize = () => setSize((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  if (!docKey || notes.length === 0) return null;

  const stacked = [...notes].sort((a, b) => a.z - b.z);
  return (
    <>
      {stacked.map((n, i) => (
        <NotePane key={n.id} note={n} stack={i} docKey={docKey} />
      ))}
    </>
  );
}

/** Add a note to the document on screen, if there is one. For the toolbar, palette and shortcut. */
export function addNoteToCurrentDoc() {
  const filePath = useViewer.getState().filePath;
  if (!filePath) return;
  useNotes.getState().add(useSettings.getState().docKey(filePath));
}
