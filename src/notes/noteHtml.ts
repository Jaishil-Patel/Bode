/*
 * A sticky note's content: text, line breaks and highlights — and nothing else.
 *
 * The note is edited as a contenteditable, because a textarea cannot show part of its text
 * highlighted. That lets arbitrary markup in, so what is saved is rebuilt from scratch out of the
 * few things a note can hold rather than trusted as typed: a note is written back into the page as
 * HTML on the next open, and must never be able to carry a script, an image or a link with it.
 *
 * Highlights are stored as `<mark>` carrying the colour they were made in — the highlighter
 * preset that was active on the annotation bar, the same one the page uses. While editing they
 * are spans with an inline background instead, because that is what the browser's own highlight
 * command produces and knows how to add to, split and remove.
 */

const CLEARED = new Set(["transparent", "rgba(0, 0, 0, 0)"]);

/** A colour value plain enough to write back into a style attribute: hex, rgb() or rgba(). */
const SAFE_COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d.,\s%]+\))$/i;

/**
 * What an element does to the highlight of the text inside it: sets a colour, clears it (a
 * transparent background is how the highlight command takes one off inside another), or — for
 * `undefined` — leaves whatever it is inside of. A mark from before marks had colours is "".
 */
function highlightOf(el: HTMLElement): string | null | undefined {
  const bg = el.style.backgroundColor;
  if (CLEARED.has(bg)) return null;
  if (bg) return SAFE_COLOR.test(bg) ? bg : undefined;
  return el.tagName === "MARK" ? "" : undefined;
}

/** Rebuild a note's markup from what the editor holds, keeping only text, breaks and marks. */
export function sanitizeNoteHtml(html: string): string {
  const src = document.createElement("template");
  src.innerHTML = html;
  const out = document.createElement("div");

  const copy = (from: Node, to: Node, marked: string | null) => {
    for (const node of Array.from(from.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = document.createTextNode(node.textContent ?? "");
        if (marked !== null) {
          // Adjacent runs in one colour are joined, so a highlight added in pieces saves as one.
          const last = to.lastChild;
          if (last instanceof HTMLElement && last.tagName === "MARK" && last.style.backgroundColor === marked) {
            last.appendChild(text);
          } else {
            const mark = document.createElement("mark");
            if (marked) mark.style.backgroundColor = marked;
            to.appendChild(mark).appendChild(text);
          }
        } else {
          to.appendChild(text);
        }
      } else if (node instanceof HTMLElement) {
        if (node.tagName === "BR") {
          to.appendChild(document.createElement("br"));
        } else if (node.tagName === "DIV" || node.tagName === "P") {
          // A line of its own: what the editor makes on Enter.
          copy(node, to.appendChild(document.createElement("div")), marked);
        } else if (node.tagName !== "SCRIPT" && node.tagName !== "STYLE") {
          // Any other element contributes its text only.
          const own = highlightOf(node);
          copy(node, to, own === undefined ? marked : own);
        }
      }
    }
  };
  copy(src.content, out, null);
  return out.innerHTML;
}

/**
 * The markup to put in the editor: saved marks become spans in their own colour, or in `fallback`
 * for a mark saved before marks had one.
 */
export function toEditorHtml(html: string, fallback: string): string {
  const src = document.createElement("template");
  src.innerHTML = sanitizeNoteHtml(html);
  for (const mark of Array.from(src.content.querySelectorAll("mark"))) {
    const span = document.createElement("span");
    span.style.backgroundColor = mark.style.backgroundColor || fallback;
    span.append(...Array.from(mark.childNodes));
    mark.replaceWith(span);
  }
  return src.innerHTML;
}

/** A note from before highlighting, which only had plain text, as note markup. */
export function textToNoteHtml(text: string): string {
  const div = document.createElement("div");
  text.split("\n").forEach((line, i) => {
    if (i > 0) div.appendChild(document.createElement("br"));
    div.appendChild(document.createTextNode(line));
  });
  return div.innerHTML;
}
