/*
 * What right-clicking the document offers, worked out from what is under the pointer.
 *
 * Laid out after the readers people already know (Edge's PDF reader, Acrobat, SumatraPDF): the
 * menu is about what you clicked, most specific first.
 *
 *   selected text   Copy · highlight (the three presets) · underline / strike out / squiggly ·
 *                   sticky note · find it in the document · search the web · read it aloud
 *   an annotation   its colour · copy its text · delete
 *   a link          open it · copy its address
 *   a page          sticky note · pin a region · rotate, duplicate, delete the page · fit · fullscreen
 *   Markdown, HTML  copy, sticky note, search, read aloud · select all · edit the source
 *
 * Text fields keep the platform's own menu: it has spelling suggestions and a paste that works
 * with the system clipboard, neither of which a page can offer. So does a touch screen, where a
 * long-press already selects. Shift+right-click still opens the browser's menu anywhere, which is
 * where Inspect lives while developing.
 */
import { useEffect } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useViewer } from "../store/viewerStore";
import { useSettings } from "../settings/useSettings";
import { useFullscreen } from "../store/fullscreenStore";
import { useAnnotations, type Annotation } from "../annotations/useAnnotations";
import { annotationAt, markSelection, type MarkType } from "../annotations/fromSelection";
import { useNotes, NOTE_COLORS } from "../notes/useNotes";
import { PAPER } from "../notes/NotePane";
import { isTouchPrimary } from "../platform/device";
import { findInDocument } from "./SearchBar";
import { pageMenuItems } from "./PageMenu";
import { useContextMenu, type MenuItem } from "./ContextMenu";
import {
  IconCopy,
  IconCursor,
  IconEdit,
  IconExternal,
  IconFitPage,
  IconFitWidth,
  IconGlobe,
  IconHighlight,
  IconLink,
  IconNote,
  IconPen,
  IconPin,
  IconSearch,
  IconSpeaker,
  IconSquiggly,
  IconStrikeout,
  IconTrash,
  IconUnderline,
  IconZen,
  IconZenExit,
  IconChevronDown,
  IconChevronRight,
} from "./icons";

/** Colours offered for re-colouring a drawn mark: the ink colours the drawing tools start from. */
const INK = ["#ef4444", "#f97316", "#22c55e", "#3b82f6", "#a855f7", "#111827"];

const SEP: MenuItem = { kind: "separator" };

const ANNOTATION_NAMES: Record<Annotation["type"], string> = {
  highlight: "Highlight",
  underline: "Underline",
  strikeout: "Strike out",
  squiggly: "Squiggly",
  rect: "Rectangle",
  ellipse: "Ellipse",
  triangle: "Triangle",
  line: "Line",
  arrow: "Arrow",
  pen: "Drawing",
  text: "Text box",
  signature: "Signature",
};

/** Long selections are quoted by their start, so the menu stays a sensible width. */
const quote = (s: string) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 24 ? `“${one.slice(0, 22).trimEnd()}…”` : `“${one}”`;
};

function copyText(text: string) {
  navigator.clipboard?.writeText(text).catch(() => document.execCommand("copy"));
}

const canSpeak = () => typeof window !== "undefined" && "speechSynthesis" in window;

function speak(text: string) {
  const synth = window.speechSynthesis;
  synth.cancel();
  synth.speak(new SpeechSynthesisUtterance(text));
}

/**
 * The selected text, if the right-click landed on it. A selection elsewhere on the page is not
 * what was clicked — the menu for the thing under the pointer is.
 */
function selectionAt(sel: Selection | null, x: number, y: number): string {
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return "";
  const text = sel.toString();
  if (!text.trim()) return "";
  const pad = 4;
  for (let i = 0; i < sel.rangeCount; i++) {
    for (const r of Array.from(sel.getRangeAt(i).getClientRects())) {
      if (x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad)
        return text;
    }
  }
  return "";
}

export interface MenuContext {
  /** Where it was opened, in the app window's client px (where the menu and notes go). */
  x: number;
  y: number;
  target: Element;
  /** Whether the selection, if one was clicked, is in this document. */
  selected: string;
}

function viewContext() {
  const v = useViewer.getState();
  const docKey = v.filePath ? useSettings.getState().docKey(v.filePath) : null;
  return { v, docKey, isPdf: !!v.doc };
}

function noteHere(docKey: string | null, x: number, y: number): MenuItem[] {
  if (!docKey) return [];
  return [
    {
      label: "Add sticky note here",
      icon: <IconNote />,
      hint: "Ctrl+Shift+N",
      run: () => useNotes.getState().add(docKey, { x, y }),
    },
  ];
}

function fullscreenItem(): MenuItem {
  const { fullscreen, toggleFullscreen } = useFullscreen.getState();
  return {
    label: fullscreen ? "Exit fullscreen" : "Fullscreen",
    icon: fullscreen ? <IconZenExit /> : <IconZen />,
    hint: "F11",
    run: toggleFullscreen,
  };
}

function selectionItems(ctx: MenuContext): MenuItem[] {
  const { docKey, isPdf } = viewContext();
  const text = ctx.selected;
  const a = useAnnotations.getState();
  const mark = (type: MarkType, color: string) => () => {
    if (docKey) markSelection(docKey, type, color);
  };
  const reading = canSpeak() && window.speechSynthesis.speaking;
  return [
    { label: "Copy", icon: <IconCopy />, hint: "Ctrl+C", run: () => copyText(text) },
    SEP,
    ...(isPdf && docKey
      ? ([
          {
            kind: "swatches",
            label: "Highlight",
            icon: <IconHighlight />,
            colors: a.highlightPresets,
            active: a.highlightPresets[a.activePreset],
            pick: (c) => {
              mark("highlight", c)();
              // The colour picked becomes the highlighter's, as picking it on the bar would.
              const i = useAnnotations.getState().highlightPresets.indexOf(c);
              if (i >= 0) useAnnotations.getState().setActivePreset(i);
            },
          },
          { label: "Underline", icon: <IconUnderline />, run: mark("underline", a.color) },
          { label: "Strike out", icon: <IconStrikeout />, run: mark("strikeout", a.color) },
          { label: "Squiggly underline", icon: <IconSquiggly />, run: mark("squiggly", a.color) },
          SEP,
        ] satisfies MenuItem[])
      : []),
    ...noteHere(docKey, ctx.x, ctx.y),
    SEP,
    ...(isPdf
      ? [
          {
            label: `Find ${quote(text)}`,
            icon: <IconSearch />,
            run: () => findInDocument(text.replace(/\s+/g, " ").trim()),
          },
        ]
      : []),
    {
      label: `Search the web for ${quote(text)}`,
      icon: <IconGlobe />,
      run: () =>
        void openUrl(
          `https://www.google.com/search?q=${encodeURIComponent(text.replace(/\s+/g, " ").trim())}`,
        ).catch(() => {}),
    },
    ...(canSpeak()
      ? [
          reading
            ? { label: "Stop reading aloud", icon: <IconSpeaker />, run: () => speechSynthesis.cancel() }
            : { label: "Read aloud", icon: <IconSpeaker />, run: () => speak(text) },
        ]
      : []),
  ];
}

function linkItems(el: Element): MenuItem[] {
  const url = el.getAttribute("data-link") ?? el.getAttribute("href") ?? "";
  const external = /^(https?|mailto):/i.test(url);
  if (external)
    return [
      { label: "Open link", icon: <IconExternal />, run: () => void openUrl(url).catch(() => {}) },
      { label: "Copy link address", icon: <IconLink />, run: () => copyText(url) },
    ];
  // A link within the PDF: its own click handler knows where it goes.
  if (el.getAttribute("data-link") === "internal")
    return [{ label: "Go to link", icon: <IconLink />, run: () => (el as HTMLElement).click() }];
  return [];
}

function annotationItems(docKey: string, anno: Annotation): MenuItem[] {
  const a = useAnnotations.getState();
  const isHighlight = anno.type === "highlight";
  const colors = isHighlight
    ? Array.from(new Set([...a.highlightPresets, "#ff6fb5"]))
    : anno.type === "signature"
      ? []
      : INK;
  return [
    { kind: "header", label: ANNOTATION_NAMES[anno.type] },
    ...(colors.length
      ? ([
          {
            kind: "swatches",
            label: "Colour",
            icon: <IconPen />,
            colors,
            active: anno.color,
            pick: (c) => useAnnotations.getState().update(docKey, anno.id, { color: c }),
          },
        ] satisfies MenuItem[])
      : []),
    ...(anno.type === "text" && anno.text
      ? [{ label: "Copy text", icon: <IconCopy />, run: () => copyText(anno.text) }]
      : []),
    {
      label: "Select",
      icon: <IconCursor />,
      run: () => {
        // Selected, it shows its handles and its options — size, thickness, fill.
        a.setTool("select");
        a.setSelected(anno.id);
      },
    },
    {
      label: "Delete",
      icon: <IconTrash />,
      hint: "Del",
      danger: true,
      run: () => useAnnotations.getState().remove(docKey, anno.id),
    },
  ];
}

function noteItems(docKey: string, id: string): MenuItem[] {
  const note = useNotes.getState().byDoc[docKey]?.notes.find((n) => n.id === id);
  if (!note) return [];
  const { update, remove } = useNotes.getState();
  return [
    { kind: "header", label: "Sticky note" },
    {
      kind: "swatches",
      label: "Colour",
      icon: <IconNote />,
      colors: NOTE_COLORS.map((c) => PAPER[c]),
      active: PAPER[note.color],
      pick: (hex) => {
        const c = NOTE_COLORS.find((k) => PAPER[k] === hex);
        if (c) update(docKey, id, { color: c });
      },
    },
    ...(note.text
      ? [{ label: "Copy text", icon: <IconCopy />, run: () => copyText(note.text) }]
      : []),
    {
      label: note.folded ? "Unfold" : "Fold away",
      icon: note.folded ? <IconChevronRight /> : <IconChevronDown />,
      run: () => update(docKey, id, { folded: !note.folded }),
    },
    { label: "Delete note", icon: <IconTrash />, danger: true, run: () => remove(docKey, id) },
  ];
}

function pdfPageItems(ctx: MenuContext, docKey: string | null): MenuItem[] {
  const { v } = viewContext();
  const pageEl = ctx.target.closest<HTMLElement>("[data-page]");
  const n = pageEl ? Number(pageEl.dataset.page) : 0;
  const page = n ? v.pages[n - 1] : undefined;

  // An annotation under the pointer comes first: it is the most specific thing there.
  let anno: Annotation | null = null;
  if (pageEl && docKey) {
    const r = pageEl.getBoundingClientRect();
    anno = annotationAt(docKey, n - 1, (ctx.x - r.left) / v.scale, (ctx.y - r.top) / v.scale);
  }

  // Right-clicking a mark is about that mark: its menu alone, short enough to take in at once.
  if (anno && docKey) return annotationItems(docKey, anno);

  return [
    ...(page ? [{ kind: "header", label: `Page ${n}` } satisfies MenuItem] : []),
    ...noteHere(docKey, ctx.x, ctx.y),
    {
      label: "Pin a region…",
      icon: <IconPin />,
      // The pin tool: drag over the part of the page to keep in view.
      run: () => useAnnotations.getState().setTool("pin"),
    },
    SEP,
    ...(page ? [...pageMenuItems(page.id, { moves: false }), SEP] : []),
    { label: "Fit width", icon: <IconFitWidth />, run: () => v.setFitMode("width") },
    { label: "Fit page", icon: <IconFitPage />, run: () => v.setFitMode("page") },
    fullscreenItem(),
  ];
}

function textDocItems(ctx: MenuContext, docKey: string | null): MenuItem[] {
  const v = useViewer.getState();
  return [
    ...noteHere(docKey, ctx.x, ctx.y),
    {
      label: "Select all",
      icon: <IconCursor />,
      hint: "Ctrl+A",
      run: () => {
        const doc = ctx.target.ownerDocument;
        const root = doc.querySelector(".markdown-body") ?? doc.body;
        const sel = doc.getSelection();
        if (!sel || !root) return;
        sel.removeAllRanges();
        const range = doc.createRange();
        range.selectNodeContents(root);
        sel.addRange(range);
      },
    },
    {
      label: v.textEditing ? "Done editing" : "Edit source",
      icon: <IconEdit />,
      hint: "Ctrl+E",
      run: () => v.toggleTextEdit(),
    },
    SEP,
    fullscreenItem(),
  ];
}

/** Build and open the menu for a right-click on the document. */
export function openDocumentMenu(ctx: MenuContext) {
  const { docKey, isPdf } = viewContext();
  const t = ctx.target;
  let items: MenuItem[] = [];

  const noteEl = t.closest<HTMLElement>("[data-note]");
  const linkEl = t.closest("[data-link], a[href]");
  if (noteEl) {
    if (docKey) items = noteItems(docKey, noteEl.dataset.note ?? "");
  } else if (ctx.selected) {
    items = selectionItems(ctx);
  } else {
    const link = linkEl ? linkItems(linkEl) : [];
    items = [
      ...link,
      SEP,
      ...(isPdf ? pdfPageItems(ctx, docKey) : textDocItems(ctx, docKey)),
    ];
  }
  if (items.length) useContextMenu.getState().open(ctx.x, ctx.y, items);
}

const isEditable = (t: Element) =>
  (t as HTMLElement).isContentEditable || !!t.closest("input, textarea, select");

/** Whether a right-click here should get Bode's menu, the platform's, or none. */
export function contextMenuMode(e: MouseEvent): "ours" | "platform" | "none" {
  const t = e.target as Element | null;
  if (!t || e.shiftKey || isTouchPrimary() || isEditable(t)) return "platform";
  // Only the document gets a menu — and its notes, which float outside it when set to — while the
  // app's own bars and panels have nothing to add to one.
  return t.closest("main, [data-note]") ? "ours" : "none";
}

/** Install the right-click handling for the app window. Mounted once, by App. */
export function useDocumentMenu() {
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      // Something under the pointer has a menu of its own (a thumbnail, a note's colour dot).
      if (e.defaultPrevented) return;
      const mode = contextMenuMode(e);
      if (mode === "platform") return;
      e.preventDefault();
      if (mode === "none") return;
      openDocumentMenu({
        x: e.clientX,
        y: e.clientY,
        target: e.target as Element,
        selected: selectionAt(window.getSelection(), e.clientX, e.clientY),
      });
    };
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);
}

/** For a document in a frame (HTML), whose right-clicks never reach this window on their own. */
export function frameContextMenu(frame: HTMLIFrameElement, e: MouseEvent) {
  const t = e.target as Element | null;
  if (!t || e.shiftKey || isTouchPrimary() || isEditable(t)) return;
  e.preventDefault();
  const r = frame.getBoundingClientRect();
  openDocumentMenu({
    x: e.clientX + r.left,
    y: e.clientY + r.top,
    target: t,
    // Measured in the frame's own coordinates, where its selection is.
    selected: selectionAt(t.ownerDocument.getSelection(), e.clientX, e.clientY),
  });
}
