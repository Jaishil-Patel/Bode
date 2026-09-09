/*
 * Pinned regions of a document — "portals".
 *
 * Reading a paper means constantly looking away from the sentence you are on to the figure it is
 * talking about, and then finding your way back. A portal is that figure, lifted out of the page
 * and kept on screen while you carry on reading somewhere else entirely.
 *
 * Deliberately not annotations. Nothing here is written into the PDF on save, and nothing is
 * synced to another device: a portal is a reading aid for the session you are in, in the same way
 * that where your window sits is. Keeping it out of the annotation store also keeps it out of the
 * merge, which has enough to reconcile already.
 */
import { create } from "zustand";
import type { Rect } from "../annotations/useAnnotations";

export interface Portal {
  id: string;
  /** Which page the region was lifted from, 0-based. */
  pageIndex: number;
  /** The region, in page space (PDF points at scale 1). */
  rect: Rect;
  /** Where the pane sits on screen, in CSS px, and how big it is. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Stacking order, so clicking a pane brings it forward. */
  z: number;
  /** Collapsed to its title bar, for getting it out of the way without losing it. */
  folded: boolean;
}

interface State {
  /** Keyed by doc key, so switching tabs does not mix one document's portals into another's. */
  byDoc: Record<string, Portal[]>;
  topZ: number;
  open: (docKey: string, pageIndex: number, rect: Rect, at: { x: number; y: number }) => void;
  close: (docKey: string, id: string) => void;
  closeAll: (docKey: string) => void;
  update: (docKey: string, id: string, patch: Partial<Portal>) => void;
  raise: (docKey: string, id: string) => void;
}

/** Panes open at a readable size, keeping the region's own proportions. */
const paneSize = (rect: Rect) => {
  const w = Math.min(420, Math.max(200, rect.w));
  const ratio = rect.w > 0 ? rect.h / rect.w : 0.6;
  return { w, h: Math.min(520, Math.max(120, w * ratio)) + TITLE_H };
};

/** Height of the pane's title bar, which the content sits below. Sized to be grabbable by a thumb. */
export const TITLE_H = 34;

/*
 * The band of z-indexes portals live in.
 *
 * `Portal.z` is an ever-growing counter — it only has to order portals against each other — so it
 * must never reach the DOM as a z-index directly. Doing that put a portal above the settings and
 * devices drawers (z-40) as soon as it had been clicked a few times. The counter decides the
 * order; this band decides where that order sits relative to everything else, and it stays below
 * anything that is meant to cover the document.
 */
export const PORTAL_Z_BASE = 20;
export const PORTAL_Z_TOP = 34;

export const usePortals = create<State>((set, get) => ({
  byDoc: {},
  topZ: 1,

  open: (docKey, pageIndex, rect, at) => {
    const z = get().topZ + 1;
    const { w, h } = paneSize(rect);
    // Clamp on open so a pane dragged from the far edge of a page cannot appear off-screen.
    const x = Math.min(Math.max(8, at.x), Math.max(8, window.innerWidth - w - 8));
    const y = Math.min(Math.max(8, at.y), Math.max(8, window.innerHeight - h - 8));
    const portal: Portal = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      pageIndex,
      rect,
      x,
      y,
      w,
      h,
      z,
      folded: false,
    };
    set((s) => ({ topZ: z, byDoc: { ...s.byDoc, [docKey]: [...(s.byDoc[docKey] ?? []), portal] } }));
  },

  close: (docKey, id) =>
    set((s) => ({
      byDoc: { ...s.byDoc, [docKey]: (s.byDoc[docKey] ?? []).filter((p) => p.id !== id) },
    })),

  closeAll: (docKey) => set((s) => ({ byDoc: { ...s.byDoc, [docKey]: [] } })),

  update: (docKey, id, patch) =>
    set((s) => ({
      byDoc: {
        ...s.byDoc,
        [docKey]: (s.byDoc[docKey] ?? []).map((p) => (p.id === id ? { ...p, ...patch } : p)),
      },
    })),

  raise: (docKey, id) => {
    const z = get().topZ + 1;
    set((s) => ({
      topZ: z,
      byDoc: {
        ...s.byDoc,
        [docKey]: (s.byDoc[docKey] ?? []).map((p) => (p.id === id ? { ...p, z } : p)),
      },
    }));
  },
}));
