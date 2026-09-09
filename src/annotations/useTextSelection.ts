/*
 * The in-progress text selection for the highlight tool on touch devices.
 *
 * Kept in a store rather than in component state for two reasons. The drag has to survive a
 * re-render — a zoom rebuilds the whole text layer underneath it — and both the layer that
 * handles the gesture and the layer that paints the preview need to read the same selection
 * without one owning the other.
 *
 * The selection is stored purely as character indices, never as pixels. That is what makes a
 * pinch mid-drag a non-event: PdfPage rebuilds its spans in the same order from the same text
 * content, so the same indices resolve to the new geometry with nothing to migrate.
 */
import { create } from "zustand";
import { samePos, type CharPos } from "../pdf/textGeometry";

/** Which end of the selection the finger currently has hold of. */
export type DragEnd = "anchor" | "focus";

export interface TextSelection {
  pageIndex: number;
  /** Where the selection started. Fixed while dragging the other end. */
  anchor: CharPos;
  /** Where it currently reaches. May be before `anchor` — `order()` sorts them. */
  focus: CharPos;
}

interface State {
  sel: TextSelection | null;
  dragging: DragEnd | null;
  setSel: (s: TextSelection | null) => void;
  /** Moves whichever end is being dragged. */
  moveEnd: (p: CharPos) => void;
  setDragging: (d: DragEnd | null) => void;
  clear: () => void;
}

export const useTextSelection = create<State>((set, get) => ({
  sel: null,
  dragging: null,
  setSel: (sel) => set({ sel }),

  moveEnd: (p) => {
    const { sel, dragging } = get();
    if (!sel || !dragging) return;
    // The throttle that keeps a drag at 60fps: pointermove fires far faster than the caret
    // actually crosses a character, and without this every event would re-render the preview.
    if (samePos(sel[dragging], p)) return;
    set({ sel: { ...sel, [dragging]: p } });
  },

  setDragging: (dragging) => set({ dragging }),
  clear: () => set({ sel: null, dragging: null }),
}));
