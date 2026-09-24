import { create } from "zustand";
import { load } from "@tauri-apps/plugin-store";
import { sharedStore } from "../platform/sharedStore";

/*
 * What the reader has typed into a document's form.
 *
 * Deliberately its own store rather than another `Annotation` variant. A filled field is not an
 * annotation: it cannot be erased, dragged, recoloured or cleared with the page, and it is
 * identified by the form's own field name rather than by a generated id. Folding it into the
 * annotation union would mean auditing every `a.type === …` branch in the drawing layer, none of
 * which is exhaustiveness-checked.
 *
 * Undo is not lost by that choice: typing in an input has native per-field undo, and App's
 * Ctrl+Z handler already stands aside while the focus is in one.
 *
 * Values are keyed by doc key (the cross-device identity from docKey.ts) so they survive a
 * restart, and by field name inside that. They are not synced between devices yet — annotations
 * are, form values are not.
 */

/** A text value, or a checkbox/radio state. Choice fields store the chosen export value. */
export type FieldValue = string;

const STORE_FILE = "forms.json";

interface FormValuesState {
  hydrated: boolean;
  /** doc key → field key → value. */
  byFile: Record<string, Record<string, FieldValue>>;
  /**
   * When each document's form was last written out to a PDF, so the toolbar can show that a
   * filled form has not been exported yet. Absent means "filled, never saved".
   */
  savedAt: Record<string, number>;

  hydrate: () => Promise<void>;
  setValue: (docKey: string, field: string, value: FieldValue) => void;
  clearDoc: (docKey: string) => void;
  /** Marks this document's current values as written out. */
  markSaved: (docKey: string) => void;
  /** True when the document holds values that have not been exported since. */
  isDirty: (docKey: string) => boolean;
}

type Persisted = Pick<FormValuesState, "byFile" | "savedAt">;


export const useFormValues = create<FormValuesState>((set, get) => {
  // Writes only what changed, and keeps every window's answers in step: `platform/sharedStore.ts`.
  const save = () => shared.persist();

  return {
    hydrated: false,
    byFile: {},
    savedAt: {},

    hydrate: async () => {
      await shared.hydrate();
      set({ hydrated: true });
    },

    setValue: (docKey, field, value) => {
      const forDoc = { ...(get().byFile[docKey] ?? {}) };
      // An empty value is an absent value: it keeps the store from filling up with the blanks
      // that typing-then-deleting leaves behind, and it is what "unfilled" means on export.
      if (value === "") delete forDoc[field];
      else forDoc[field] = value;
      set({
        byFile: { ...get().byFile, [docKey]: forDoc },
        // Editing makes the document dirty again; dropping the stamp is what says so.
        savedAt: dropKey(get().savedAt, docKey),
      });
      save();
    },

    clearDoc: (docKey) => {
      if (!get().byFile[docKey]) return;
      set({
        byFile: dropKey(get().byFile, docKey),
        savedAt: dropKey(get().savedAt, docKey),
      });
      save();
    },

    markSaved: (docKey) => {
      set({ savedAt: { ...get().savedAt, [docKey]: Date.now() } });
      save();
    },

    isDirty: (docKey) => {
      const values = get().byFile[docKey];
      if (!values || Object.keys(values).length === 0) return false;
      return get().savedAt[docKey] === undefined;
    },
  };
});

/**
 * Forget answers an older version kept for guessed blanks.
 *
 * Those used to be values here, keyed by where on the page they were detected. A guessed blank is
 * an ordinary text annotation now, so anything left under a "g:" key can no longer be shown or
 * saved — it would only ride along as an answer whose field does not exist.
 */
function dropDetectedSlots(
  byFile: Record<string, Record<string, FieldValue>>,
): Record<string, Record<string, FieldValue>> {
  const out: Record<string, Record<string, FieldValue>> = {};
  for (const [docKey, values] of Object.entries(byFile)) {
    const kept = Object.fromEntries(Object.entries(values).filter(([k]) => !k.startsWith("g:")));
    if (Object.keys(kept).length > 0) out[docKey] = kept;
  }
  return out;
}

function dropKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

const shared = sharedStore({
  open: () => load(STORE_FILE, { autoSave: false, defaults: {} }),
  fields: {
    byFile: {
      read: () => useFormValues.getState().byFile,
      apply: (v: Persisted["byFile"]) => useFormValues.setState({ byFile: dropDetectedSlots(v ?? {}) }),
    },
    savedAt: {
      read: () => useFormValues.getState().savedAt,
      apply: (v: Persisted["savedAt"]) => useFormValues.setState({ savedAt: v ?? {} }),
    },
  },
  // Written by earlier versions: both fields in one blob under "state".
  legacy: { key: "state", split: (blob: Partial<Persisted>) => ({ ...blob }) },
});
