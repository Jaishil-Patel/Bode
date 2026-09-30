/*
 * One sticky note, floating over the document.
 *
 * The shell is a portal's (see `portals/PortalPane.tsx`) — the same title bar to drag, fold and
 * close by, the same grip to resize, the same band of z-indexes — so the two read as one family of
 * things you can pin to the window. What is inside is your own writing instead of a piece of the
 * page — and it is highlighted with the page's own highlighter: with that tool picked on the
 * annotation bar, selecting text in a note marks it in the active preset, exactly as on the page.
 */
import { useEffect, useRef, useState } from "react";
import { IconClose, IconChevronDown, IconChevronRight } from "../components/icons";
import { useAnnotations } from "../annotations/useAnnotations";
import { PORTAL_Z_BASE, PORTAL_Z_TOP, TITLE_H } from "../portals/usePortals";
import { NOTE_COLORS, useNotes, type Note, type NoteColor } from "./useNotes";
import { sanitizeNoteHtml, textToNoteHtml, toEditorHtml } from "./noteHtml";
import { contentTop } from "../platform/contentTop";

const MIN_W = 160;
const MIN_H = 80;
/** How long a press on the colour dot has to be held to offer the colours instead of cycling. */
const LONG_PRESS_MS = 450;

/*
 * Paper colours, fixed rather than themed. A sticky note is recognisably one because it is a
 * yellow square whatever the room looks like, and dark ink on it stays readable under every theme.
 */
const PAPER: Record<NoteColor, string> = {
  yellow: "#fdf1a6",
  pink: "#fbd3e6",
  green: "#c9f2d4",
  blue: "#cfe3fb",
};
/** For highlights saved before they carried their own colour. */
const LEGACY_MARKER = "#f8cf3e";
const INK = "#27272a";

/** The outermost highlight around `node` inside the editor, if it is in one. */
function highlightAt(node: Node, root: HTMLElement): HTMLElement | null {
  let found: HTMLElement | null = null;
  for (let el = node instanceof HTMLElement ? node : node.parentElement; el && el !== root; el = el.parentElement) {
    const bg = el.style.backgroundColor;
    if (bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)") found = el;
  }
  return found;
}

export default function NotePane({
  note,
  stack,
  docKey,
}: {
  note: Note;
  /** Position among the open notes, lowest first. Mapped into a fixed band of z-indexes. */
  stack: number;
  docKey: string;
}) {
  const { update, remove, raise } = useNotes();
  const fresh = useNotes((s) => s.fresh === note.id);
  const editorRef = useRef<HTMLDivElement>(null);
  const [picking, setPicking] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const pressTimer = useRef<number | null>(null);
  const longPressed = useRef(false);

  const color: NoteColor = note.color in PAPER ? note.color : "yellow";
  const paper = PAPER[color];
  const html = note.html ?? textToNoteHtml(note.text);

  /*
   * The editor is uncontrolled: React re-setting its contents on every keystroke would throw the
   * caret back to the start. It is filled on mount, and afterwards only when the saved note changes
   * underneath it — an edit made in another window — while it is not being typed in.
   */
  useEffect(() => {
    const el = editorRef.current;
    if (!el || document.activeElement === el) return;
    if (!el.innerHTML || sanitizeNoteHtml(el.innerHTML) !== sanitizeNoteHtml(html))
      el.innerHTML = toEditorHtml(html, LEGACY_MARKER);
  }, [html]);

  // A new note is for writing in, so it arrives with the cursor already in it.
  useEffect(() => {
    if (!fresh) return;
    editorRef.current?.focus();
    useNotes.getState().clearFresh();
  }, [fresh]);

  /*
   * Typing straight after a highlight writes plain text, not more highlight.
   *
   * The browser puts text typed at the end of a styled run inside that run, so once a word had
   * been highlighted — which leaves the caret right after it — everything typed next came out
   * highlighted too, and the highlight ran on for the rest of the sentence. A marker does not
   * work like that: it colours what was there when you drew it. So a keystroke at the very end of
   * a highlight is written just after it instead. Typing *inside* a highlight still extends it,
   * which is what you want when correcting a highlighted word.
   */
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const onBeforeInput = (e: InputEvent) => {
      if (e.inputType !== "insertText" || !e.data) return;
      const sel = window.getSelection();
      if (!sel || !sel.isCollapsed || !sel.anchorNode) return;
      const span = highlightAt(sel.anchorNode, el);
      if (!span) return;
      const tail = document.createRange();
      tail.setStart(sel.anchorNode, sel.anchorOffset);
      tail.setEnd(span, span.childNodes.length);
      if (tail.toString() !== "") return;
      e.preventDefault();
      const text = document.createTextNode(e.data);
      span.after(text);
      sel.collapse(text, text.length);
      save();
    };
    el.addEventListener("beforeinput", onBeforeInput);
    return () => el.removeEventListener("beforeinput", onBeforeInput);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * The same carry-over on Enter: a new line started from the end of a highlight arrives inside an
   * empty copy of it. Unwrapped, so the new line starts plain.
   */
  const onInput = (e: React.FormEvent<HTMLDivElement>) => {
    const el = editorRef.current;
    const sel = window.getSelection();
    if (el && sel?.anchorNode && (e.nativeEvent as InputEvent).inputType === "insertParagraph") {
      const span = highlightAt(sel.anchorNode, el);
      if (span && !span.textContent) span.replaceWith(...Array.from(span.childNodes));
    }
    save();
  };

  // The colour picker closes on a press anywhere else, as a menu does.
  useEffect(() => {
    if (!picking) return;
    const onDown = (e: PointerEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) setPicking(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [picking]);

  const save = () => {
    const el = editorRef.current;
    if (!el) return;
    update(docKey, note.id, { html: sanitizeNoteHtml(el.innerHTML), text: el.innerText.replace(/\n$/, "") });
  };

  /*
   * The annotation bar's highlighter, applied to text selected in this note.
   *
   * Selecting text that is already highlighted in the active colour takes the highlight off, so a
   * slip can be undone with the same tool. The browser's own command does the work — it splits and
   * merges the runs as needed, and it is on the editor's undo stack, so Ctrl+Z works as well.
   */
  const highlightSelection = () => {
    const { tool, activeColor } = useAnnotations.getState();
    if (tool !== "highlight") return;
    const el = editorRef.current;
    const sel = window.getSelection();
    if (!el || !sel || sel.isCollapsed || !el.contains(sel.anchorNode) || !el.contains(sel.focusNode))
      return;
    // Compared as the browser writes colours, since that is what it reports back.
    const probe = document.createElement("span");
    probe.style.backgroundColor = activeColor();
    const target = probe.style.backgroundColor;
    el.focus();
    document.execCommand("styleWithCSS", false, "true");
    const current = document.queryCommandValue("hiliteColor");
    document.execCommand("hiliteColor", false, current === target ? "transparent" : target);
    // Done with this selection, as on the page: the next drag is a new highlight.
    sel.collapseToEnd();
    save();
  };

  /*
   * Text can be selected first and the highlighter picked after, as it can on the page — so
   * picking it, or another preset, with text selected in this note highlights that text.
   */
  useEffect(
    () =>
      useAnnotations.subscribe((s, prev) => {
        if (s.tool === "highlight" && (prev.tool !== "highlight" || s.activePreset !== prev.activePreset))
          highlightSelection();
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /*
   * Positions are saved, and the window they were saved in may have been bigger than this one. The
   * note is drawn inside the window without rewriting where it was put, so making the window big
   * again puts it back.
   */
  const x = Math.max(0, Math.min(note.x, window.innerWidth - 60));
  // Kept below the bars across the top too, which can have grown since the note was put there.
  const y = Math.max(contentTop(), Math.min(note.y, window.innerHeight - TITLE_H));

  const startDrag = (e: React.PointerEvent, mode: "move" | "resize") => {
    e.preventDefault();
    e.stopPropagation();
    raise(docKey, note.id);
    const sx = e.clientX;
    const sy = e.clientY;
    const from = { x, y, w: note.w, h: note.h };

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (mode === "move") {
        update(docKey, note.id, {
          x: Math.min(Math.max(0, from.x + dx), window.innerWidth - 60),
          y: Math.min(Math.max(contentTop(), from.y + dy), window.innerHeight - TITLE_H),
        });
      } else {
        update(docKey, note.id, {
          w: Math.max(MIN_W, from.w + dx),
          h: Math.max(MIN_H + TITLE_H, from.h + dy),
        });
      }
    };
    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  /*
   * The colour dot: a tap steps to the next colour, a long press (or a right-click) lays the other
   * three out to pick from directly. Stepping is quick when you just want *a* different colour;
   * picking is for when you want a particular one without going round.
   */
  const cancelPress = () => {
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  const others = NOTE_COLORS.filter((c) => c !== color);
  const nextColor = NOTE_COLORS[(NOTE_COLORS.indexOf(color) + 1) % NOTE_COLORS.length];
  const pick = (c: NoteColor) => {
    update(docKey, note.id, { color: c });
    setPicking(false);
  };
  const Swatch = ({ c }: { c: NoteColor }) => (
    <span
      className="block h-3.5 w-3.5 rounded-full"
      style={{ background: PAPER[c], border: "1px solid rgb(0 0 0 / 0.3)" }}
    />
  );

  const firstLine = note.text.split("\n", 1)[0].trim();
  const iconBtn = "flex h-7 w-7 shrink-0 items-center justify-center rounded opacity-60 hover:opacity-100";

  return (
    <div
      onPointerDown={() => raise(docKey, note.id)}
      className="animate-fade-in fixed flex flex-col overflow-hidden rounded-lg shadow-2xl"
      style={{
        left: x,
        top: y,
        width: note.w,
        height: note.folded ? TITLE_H : note.h,
        zIndex: Math.min(PORTAL_Z_BASE + stack, PORTAL_Z_TOP),
        background: paper,
        color: INK,
        border: "1px solid rgb(0 0 0 / 0.12)",
      }}
    >
      <div
        onPointerDown={(e) => startDrag(e, "move")}
        title="Drag to move"
        className="no-select flex shrink-0 cursor-grab items-center gap-0.5 px-1.5 active:cursor-grabbing"
        style={{
          height: TITLE_H,
          background: `color-mix(in srgb, ${paper} 82%, #000)`,
          touchAction: "none",
        }}
      >
        <button
          title={note.folded ? "Unfold" : "Fold away"}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => update(docKey, note.id, { folded: !note.folded })}
          className={iconBtn}
        >
          {note.folded ? (
            <IconChevronRight className="h-3.5 w-3.5" />
          ) : (
            <IconChevronDown className="h-3.5 w-3.5" />
          )}
        </button>
        {picking ? (
          // In the bar rather than a popover: the note clips its overflow, and a menu hanging off
          // the bar would be cut off by the note it belongs to.
          <div
            ref={pickerRef}
            role="menu"
            aria-label="Note colour"
            onPointerDown={(e) => e.stopPropagation()}
            className="flex min-w-0 flex-1 items-center gap-1"
          >
            {others.map((c) => (
              <button
                key={c}
                role="menuitem"
                title={c[0].toUpperCase() + c.slice(1)}
                onClick={() => pick(c)}
                className="flex h-7 w-7 items-center justify-center rounded hover:bg-black/10"
              >
                <Swatch c={c} />
              </button>
            ))}
          </div>
        ) : (
          // Plain text so the whole bar stays something to drag by. Folded, the first line is what
          // tells one note from another.
          <span className="min-w-0 flex-1 truncate px-1 text-xs opacity-70">
            {note.folded && firstLine ? firstLine : "Note"}
          </span>
        )}
        <button
          title="Change colour · hold for all colours"
          aria-label="Change colour"
          onPointerDown={(e) => {
            e.stopPropagation();
            longPressed.current = false;
            cancelPress();
            pressTimer.current = window.setTimeout(() => {
              longPressed.current = true;
              setPicking(true);
            }, LONG_PRESS_MS);
          }}
          onPointerUp={cancelPress}
          onPointerLeave={cancelPress}
          onPointerCancel={cancelPress}
          onContextMenu={(e) => {
            e.preventDefault();
            cancelPress();
            longPressed.current = true;
            setPicking(true);
          }}
          onClick={() => {
            // The release that ends a long press is not also a tap.
            if (longPressed.current) return;
            update(docKey, note.id, { color: nextColor });
          }}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded"
        >
          <Swatch c={nextColor} />
        </button>
        <button
          title="Delete note"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => remove(docKey, note.id)}
          className={iconBtn}
        >
          <IconClose className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="relative min-h-0 flex-1" style={{ display: note.folded ? "none" : undefined }}>
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline
          aria-label="Note"
          data-placeholder="Write a note…"
          spellCheck
          onInput={onInput}
          // After the browser has settled the selection the drag made.
          onPointerUp={() => window.setTimeout(highlightSelection, 0)}
          onPaste={(e) => {
            // Text only: pasted formatting would be thrown away on save anyway, and until then it
            // would show fonts and colours the note is not going to keep.
            e.preventDefault();
            document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              // Escape leaves the note rather than also leaving fullscreen behind it.
              e.stopPropagation();
              e.currentTarget.blur();
            }
          }}
          className="note-editor h-full w-full overflow-auto px-3 py-2 text-sm leading-relaxed outline-none"
          style={{ color: INK, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
        />
        {/* Resize grip. Its own pointer handling, so a drag here never reads as a move. */}
        <div
          onPointerDown={(e) => startDrag(e, "resize")}
          title="Resize"
          style={{
            position: "absolute",
            right: 0,
            bottom: 0,
            width: 24,
            height: 24,
            cursor: "nwse-resize",
            touchAction: "none",
            background: "linear-gradient(135deg, transparent 50%, rgb(0 0 0 / 0.18) 50%)",
          }}
        />
      </div>
    </div>
  );
}
