import { useViewer } from "../store/viewerStore";

/**
 * Plain-text source editor for text tabs (Markdown and HTML), shown in place of the preview
 * while `textEditing` is on. Deliberately a bare textarea: no syntax highlighting, no autocomplete
 * — Bode edits documents it opened, it isn't a code editor.
 */
export default function SourceEditor() {
  const textSource = useViewer((s) => s.textSource);
  const setTextSource = useViewer((s) => s.setTextSource);

  return (
    <textarea
      value={textSource ?? ""}
      onChange={(e) => setTextSource(e.target.value)}
      spellCheck={false}
      autoFocus
      className="h-full w-full resize-none bg-bg px-8 py-10 font-mono text-sm leading-relaxed text-text outline-none"
      style={{ tabSize: 2 }}
    />
  );
}
