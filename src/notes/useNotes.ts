/*
 * Sticky notes — a portal's floating pane, holding your own words instead of a piece of the page.
 *
 * Like a portal, a note is pinned to the *window* rather than to a spot on a page: it stays put
 * while the document scrolls underneath, which is what makes it useful for keeping a thought in
 * view while reading on. Unlike a portal it outlives the session. A portal can be pinned again in
 * a second; what you wrote cannot, so notes are saved per document and come back when it is
 * reopened, in any window.
 *
 * Kept out of the file on purpose, and out of the annotation store with it: a note belongs to the
 * reader, not to the document, and works the same for a Markdown or HTML file that has nowhere to
 * put one. Keyed by doc key (see `docKey.ts`), so a note follows the document rather than its path.
 */
import { create } from "zustand";
import { load } from "@tauri-apps/plugin-store";
import { sharedStore } from "../platform/sharedStore";
import { contentTop } from "../platform/contentTop";

export const NOTE_COLORS = ["yellow", "pink", "green", "blue"] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];

export interface Note {
  id: string;
  /** Plain text of the note, kept alongside `html` for the folded title and for older builds. */
  text: string;
  /** Where the pane sits on screen, in CSS px, and how big it is (title bar included). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Stacking order among this document's notes, so clicking a note brings it forward. */
  z: number;
  /** Collapsed to its title bar, for getting it out of the way without losing it. */
  folded: boolean;
  color: NoteColor;
  /**
   * The note's content, with highlights: text, line breaks and `<mark>`, nothing else (see
   * `noteHtml.ts`). Absent on notes written before highlighting existed, which only had `text`.
   */
  html?: string;
}

/**
 * One document's notes, and when they last changed.
 *
 * Every window shares one notes file and two of them can be changing it at once, so a merge has to
 * decide which copy of a document's notes is newer. Stamping the document rather than each note is
 * what lets a deletion win: a removed note leaves nothing behind to carry a timestamp of its own.
 */
export interface DocNotes {
  at: number;
  notes: Note[];
}

const STORE_FILE = "notes.json";
/** Typing writes on every keystroke; the debounce is what keeps that off the disk. */
const PERSIST_DEBOUNCE_MS = 400;

export const NOTE_W = 240;
export const NOTE_H = 200;
/** How far each new note steps from the last, so a second one never hides the first exactly. */
const CASCADE = 24;

interface State {
  byDoc: Record<string, DocNotes>;
  /** The note just created, which its pane focuses once and then clears. */
  fresh: string | null;
  hydrate: () => Promise<void>;
  /** Add a note, at a screen point if given (its top-left corner), else mid-window. */
  add: (docKey: string, at?: { x: number; y: number }) => void;
  update: (docKey: string, id: string, patch: Partial<Omit<Note, "id">>) => void;
  remove: (docKey: string, id: string) => void;
  raise: (docKey: string, id: string) => void;
  clearFresh: () => void;
}

const noteId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/**
 * Combine two copies of the notes file: per document, the more recently changed copy wins.
 * Documents only one side knows about are kept.
 */
export function mergeNotes(
  a: Record<string, DocNotes>,
  b: Record<string, DocNotes>,
): Record<string, DocNotes> {
  const out = { ...a };
  for (const [key, doc] of Object.entries(b)) {
    if (!out[key] || doc.at > out[key].at) out[key] = doc;
  }
  return out;
}

/** Where a new note goes: the middle of the window, stepped along for each note already open. */
export function placeNew(existing: number, view: { w: number; h: number }) {
  const step = (existing % 8) * CASCADE;
  return {
    x: Math.max(8, Math.round((view.w - NOTE_W) / 2) + step),
    y: Math.max(contentTop() + 8, Math.round((view.h - NOTE_H) / 2) + step),
  };
}

export const useNotes = create<State>((set, get) => {
  /** Replace one document's notes, stamping it as changed now. */
  const edit = (docKey: string, fn: (notes: Note[]) => Note[]) => {
    set((s) => ({
      byDoc: { ...s.byDoc, [docKey]: { at: Date.now(), notes: fn(s.byDoc[docKey]?.notes ?? []) } },
    }));
    shared.persist();
  };
  const topZ = (docKey: string) =>
    (get().byDoc[docKey]?.notes ?? []).reduce((m, n) => Math.max(m, n.z), 0);

  return {
    byDoc: {},
    fresh: null,

    hydrate: () => shared.hydrate(),

    add: (docKey, at) => {
      const notes = get().byDoc[docKey]?.notes ?? [];
      const view = { w: window.innerWidth, h: window.innerHeight };
      const { x, y } = at
        ? {
            x: Math.max(8, Math.min(at.x, view.w - NOTE_W - 8)),
            y: Math.max(contentTop() + 8, Math.min(at.y, view.h - NOTE_H - 8)),
          }
        : placeNew(notes.length, view);
      const note: Note = {
        id: noteId(),
        text: "",
        x,
        y,
        w: NOTE_W,
        h: NOTE_H,
        z: topZ(docKey) + 1,
        folded: false,
        color: "yellow",
      };
      edit(docKey, (ns) => [...ns, note]);
      set({ fresh: note.id });
    },

    update: (docKey, id, patch) =>
      edit(docKey, (ns) => ns.map((n) => (n.id === id ? { ...n, ...patch } : n))),

    remove: (docKey, id) => edit(docKey, (ns) => ns.filter((n) => n.id !== id)),

    raise: (docKey, id) => {
      const note = get().byDoc[docKey]?.notes.find((n) => n.id === id);
      const z = topZ(docKey);
      // Already on top: nothing to write, which matters because every press on a note raises it.
      if (!note || note.z === z) return;
      edit(docKey, (ns) => ns.map((n) => (n.id === id ? { ...n, z: z + 1 } : n)));
    },

    clearFresh: () => set({ fresh: null }),
  };
});

const shared = sharedStore({
  open: () => load(STORE_FILE, { autoSave: false, defaults: {} }),
  debounceMs: PERSIST_DEBOUNCE_MS,
  fields: {
    byDoc: {
      read: () => useNotes.getState().byDoc,
      apply: (v: Record<string, DocNotes>) => useNotes.setState({ byDoc: v ?? {} }),
      merge: (stored: Record<string, DocNotes>, local: Record<string, DocNotes>) =>
        mergeNotes(stored ?? {}, local),
      // Safe here, unlike for a plain list: a deletion stamps its document, so it wins the merge.
      mergeOnWrite: true,
    },
  },
});

