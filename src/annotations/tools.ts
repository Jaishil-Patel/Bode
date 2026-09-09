/*
 * The one description of the annotation tools.
 *
 * Every tool used to be written out four times over — in the `Tool` union, in the tools bar's
 * JSX, in App's single-key shortcut map, and in the Settings shortcut reference — and the four
 * had already drifted apart: the reference omitted the form tool while claiming, in its own
 * comment, to list all of them. A registry is what makes a customisable bar possible at all (the
 * bar has to be able to render an arbitrary subset in an arbitrary order), and collapsing the
 * duplication is the same change.
 *
 * The union in `useAnnotations` stays the source of truth for *which* tools exist; this adds what
 * the interface needs to say about each one.
 */

import type { Tool } from "./useAnnotations";
import {
  IconCursor,
  IconEdit,
  IconEraser,
  IconForm,
  IconHighlight,
  IconPen,
  IconPin,
  IconShapes,
  IconSignature,
  IconSquiggly,
  IconStrikeout,
  IconText,
  IconUnderline,
} from "../components/icons";

export interface ToolDef {
  id: Tool;
  /**
   * The tool's name in words, for everywhere there is room for words: the Settings card, the
   * bar's ⋯ menu, the command palette, the shortcut reference.
   *
   * Short enough to sit under a small icon without wrapping. The bar itself stays icons-only —
   * it floats over the page, and every millimetre it takes is page the reader cannot see.
   */
  name: string;
  /** The hover tooltip, which has room to say more than the label. */
  title: string;
  /** The single-key shortcut, lowercase. Works whether or not the tool is on the bar. */
  key: string;
  Icon: (p: { className?: string }) => JSX.Element;
}

/**
 * Every tool, in the order the bar shipped with — which is also the default order and the order
 * "Reset to default" restores.
 */
export const TOOLS: readonly ToolDef[] = [
  { id: "select", name: "Select", title: "Select / move (V)", key: "v", Icon: IconCursor },
  { id: "highlight", name: "Highlight", title: "Highlighter (H)", key: "h", Icon: IconHighlight },
  {
    id: "underline",
    name: "Underline",
    title: "Underline selected text (U)",
    key: "u",
    Icon: IconUnderline,
  },
  {
    id: "strikeout",
    name: "Strike",
    title: "Strike through selected text (K)",
    key: "k",
    Icon: IconStrikeout,
  },
  {
    id: "squiggly",
    name: "Squiggle",
    title: "Squiggly underline on selected text (G)",
    key: "g",
    Icon: IconSquiggly,
  },
  { id: "pen", name: "Pen", title: "Freehand draw (P)", key: "p", Icon: IconPen },
  {
    id: "eraser",
    name: "Eraser",
    title: "Eraser — click or drag to remove (X)",
    key: "x",
    Icon: IconEraser,
  },
  { id: "text", name: "Text", title: "Text box (T)", key: "t", Icon: IconText },
  { id: "shape", name: "Shape", title: "Shapes (R) — pick square or ellipse in the options", key: "r", Icon: IconShapes },
  { id: "edit", name: "Edit", title: "Edit text (E)", key: "e", Icon: IconEdit },
  {
    id: "signature",
    name: "Sign",
    title: "Sign (S) — drag a box to size the signature; click the tool again to draw a new one",
    key: "s",
    Icon: IconSignature,
  },
  { id: "form", name: "Form", title: "Fill in a form (F)", key: "f", Icon: IconForm },
  {
    id: "pin",
    name: "Pin",
    title: "Pin a region (N) — drag round a figure to keep it on screen while you read",
    key: "n",
    Icon: IconPin,
  },
];

const BY_ID = new Map(TOOLS.map((t) => [t.id, t]));
const BY_KEY = new Map(TOOLS.map((t) => [t.key, t]));

/** The tool a single keypress selects, or undefined if that key isn't a tool shortcut. */
export const toolForKey = (key: string): ToolDef | undefined => BY_KEY.get(key.toLowerCase());

/** The default bar order: every tool, as listed above. */
export const DEFAULT_TOOL_ORDER: Tool[] = TOOLS.map((t) => t.id);

export interface ToolbarLayout {
  order: Tool[];
  hidden: Tool[];
}

/**
 * Reconcile a saved toolbar with the tools that actually exist.
 *
 * Settings on disk were written by whatever version of Bode last ran, so a saved order can be
 * missing a tool added since (it must still appear, or it would be invisible *and* absent from
 * the Settings grid that switches it back on) and can name a tool since removed (which must be
 * dropped rather than rendered as a hole). Doing this on every read rather than once at hydrate
 * means it is right even for settings written by a newer build and then opened by an older one.
 *
 * New tools arrive switched on, at the end. Arriving hidden would be worse: a feature nobody can
 * see is a feature nobody finds.
 */
export function normalizeToolbar(
  order: Tool[] | undefined,
  hidden: Tool[] | undefined,
): ToolbarLayout {
  const seen = new Set<Tool>();
  const kept: Tool[] = [];
  for (const id of order ?? []) {
    if (BY_ID.has(id) && !seen.has(id)) {
      seen.add(id);
      kept.push(id);
    }
  }
  for (const t of TOOLS) if (!seen.has(t.id)) kept.push(t.id);

  const hiddenSet = new Set((hidden ?? []).filter((id) => BY_ID.has(id)));
  return { order: kept, hidden: kept.filter((id) => hiddenSet.has(id)) };
}

/**
 * The tools the bar shows: the ones switched on, plus the active tool even when it is switched
 * off.
 *
 * That last part is what makes picking a switched-off tool out of the More menu feel like
 * anything happened. Without it the bar would look identical before and after, and the only
 * evidence of the new tool would be the pointer's behaviour on the page.
 */
export function barTools(layout: ToolbarLayout, activeTool: Tool): ToolDef[] {
  const hidden = new Set(layout.hidden);
  return layout.order
    .filter((id) => !hidden.has(id) || id === activeTool)
    .map((id) => BY_ID.get(id)!)
    .filter(Boolean);
}

/** The tools the More menu offers: everything switched off, minus whatever the bar is showing. */
export function menuTools(layout: ToolbarLayout, activeTool: Tool): ToolDef[] {
  const hidden = new Set(layout.hidden);
  return layout.order
    .filter((id) => hidden.has(id) && id !== activeTool)
    .map((id) => BY_ID.get(id)!)
    .filter(Boolean);
}
