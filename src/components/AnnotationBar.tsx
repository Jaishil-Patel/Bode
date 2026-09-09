import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { useViewer } from "../store/viewerStore";
import { useSettings } from "../settings/useSettings";
import {
  isClosedShape,
  isShapeAnno,
  MARK_WEIGHT_MAX,
  MARK_WEIGHT_MIN,
  useAnnotations,
  type ShapeKind,
  type Tool,
} from "../annotations/useAnnotations";
import { barTools, menuTools, normalizeToolbar, type ToolDef } from "../annotations/tools";
import {
  IconArrow,
  IconCircle,
  IconFill,
  IconLine,
  IconTrash,
  IconChevronDown,
  IconGrip,
  IconMore,
  IconPen,
  IconSquare,
  IconTriangle,
} from "./icons";

type Side = "bottom" | "top" | "left" | "right";

/** The shape picker's contents, in the order it offers them. */
const SHAPE_PICKER: { kind: ShapeKind; label: string; Icon: (p: { className?: string }) => JSX.Element }[] = [
  { kind: "rect", label: "Rectangle", Icon: IconSquare },
  { kind: "ellipse", label: "Ellipse", Icon: IconCircle },
  { kind: "triangle", label: "Triangle", Icon: IconTriangle },
  { kind: "line", label: "Line", Icon: IconLine },
  { kind: "arrow", label: "Arrow", Icon: IconArrow },
];

// Subtle accent tint used for the active tool, theme-aware via color-mix.
const ACTIVE_BG = "color-mix(in srgb, var(--accent) 22%, transparent)";

/*
 * The highlighter palette.
 *
 * Curated pastels rather than a raw colour wheel: a highlight has to sit under black text and
 * stay readable, which rules out most of the spectrum, so offering all of it is a worse tool than
 * offering the dozen that work. The native picker is still one tap away for anything else.
 */
const HIGHLIGHT_PALETTE = [
  "#fff59d", "#ffe0a3", "#ffd0a3", "#ffc9c9",
  "#ffb3d9", "#e5c9ff", "#c7d2fe", "#a8dfff",
  "#a7f3d0", "#d9f99d", "#cfe8d4", "#dcdfe4",
];

/**
 * Recolouring one highlighter preset.
 *
 * Opened by tapping the preset you are already on — the swatch itself is the affordance, so the
 * bar carries no extra control and no corner nub. Anchored to that swatch rather than parked in
 * the shared options pill, because this belongs to the one colour you tapped, not to the tool.
 */
function ColorPopover({
  anchorEl,
  side,
  value,
  onChange,
  onClose,
}: {
  anchorEl: HTMLElement | null;
  side: Side;
  value: string;
  onChange: (c: string) => void;
  onClose: () => void;
}) {
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<React.CSSProperties>({});

  useLayoutEffect(() => {
    if (!anchorEl) return;
    const r = anchorEl.getBoundingClientRect();
    const GAP = 10;
    // Opens away from whichever edge the bar is docked to, so it never covers the bar it came from.
    const style: React.CSSProperties =
      side === "bottom"
        ? { left: r.left + r.width / 2, bottom: window.innerHeight - r.top + GAP, transform: "translateX(-50%)" }
        : side === "top"
          ? { left: r.left + r.width / 2, top: r.bottom + GAP, transform: "translateX(-50%)" }
          : side === "left"
            ? { left: r.right + GAP, top: r.top + r.height / 2, transform: "translateY(-50%)" }
            : { right: window.innerWidth - r.left + GAP, top: r.top + r.height / 2, transform: "translateY(-50%)" };
    setPos(style);
  }, [anchorEl, side]);

  useEffect(() => {
    const onDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (!anchorEl?.contains(t) && !pop.current?.contains(t)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchorEl, onClose]);

  return createPortal(
    <div
      ref={pop}
      style={pos}
      className="animate-fade-in fixed z-50 rounded-xl border border-border bg-surface p-2 shadow-2xl"
    >
      <div className="grid grid-cols-4 gap-1.5">
        {HIGHLIGHT_PALETTE.map((c) => {
          const on = c.toLowerCase() === value.toLowerCase();
          return (
            <button
              key={c}
              title={c}
              onClick={() => onChange(c)}
              style={{ background: c }}
              className={`h-7 w-7 rounded-full border-2 shadow-inner ${
                on ? "border-accent" : "border-black/10"
              }`}
            />
          );
        })}
      </div>
      <label className="mt-2 flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1.5 text-xs text-text hover-tint">
        <span
          className="h-5 w-5 shrink-0 rounded-full border border-black/10 shadow-inner"
          style={{
            // A colour wheel, so "anything else" reads as a choice rather than as a 13th swatch.
            background:
              "conic-gradient(#f87171, #fbbf24, #a3e635, #34d399, #22d3ee, #818cf8, #e879f9, #f87171)",
          }}
        />
        Custom…
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="sr-only"
        />
      </label>
    </div>,
    document.body,
  );
}

/**
 * One tool.
 *
 * Icon only, deliberately: the bar floats over the page and every millimetre it takes is page the
 * reader cannot see. The names live where there is room for them — in Settings, where you choose
 * which tools appear, and in the ⋯ menu — so the bar stays as small as it can be.
 */
function ToolBtn({
  active,
  title,
  onClick,
  toolId,
  children,
}: {
  active: boolean;
  title: string;
  onClick: () => void;
  /** Lets the options pill find this button in the DOM so it can line itself up with it. */
  toolId?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      data-tool={toolId}
      onClick={onClick}
      style={active ? { background: ACTIVE_BG } : undefined}
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors ${
        active ? "text-accent" : "text-text hover:bg-white/10"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * The tools that are switched off, reachable in one tap.
 *
 * This is what makes it safe to let every tool be switched off, `select` included: there is no
 * arrangement of the settings that can strand a tool somewhere the user cannot get at it.
 *
 * The popover is portalled to the body rather than positioned inside the bar, because the bar is
 * a scroll container (`overflow-x-auto` / `overflow-y-auto`, so a long bar can be swiped on a
 * phone) and an absolutely-positioned child of one is clipped to it. Portalled, it is positioned
 * from the button's own rect and opens toward the page on whichever edge the bar is docked to.
 */
function MoreTools({
  tools,
  side,
  activeTool,
  onPick,
}: {
  tools: ToolDef[];
  side: Side;
  activeTool: Tool;
  onPick: (id: Tool) => void;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<React.CSSProperties>({});

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const GAP = 8;
    const style: React.CSSProperties =
      side === "bottom"
        ? { left: r.left + r.width / 2, bottom: window.innerHeight - r.top + GAP, transform: "translateX(-50%)" }
        : side === "top"
          ? { left: r.left + r.width / 2, top: r.bottom + GAP, transform: "translateX(-50%)" }
          : side === "left"
            ? { left: r.right + GAP, top: r.top + r.height / 2, transform: "translateY(-50%)" }
            : { right: window.innerWidth - r.left + GAP, top: r.top + r.height / 2, transform: "translateY(-50%)" };
    setPos(style);
  }, [open, side, tools.length]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (!btn.current?.contains(t) && !pop.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // `mousedown`/`touchstart` rather than `click`, so a tap outside also lands on whatever is
    // underneath instead of being spent dismissing the menu.
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (tools.length === 0) return null;

  return (
    <>
      <button
        ref={btn}
        title={`More tools (${tools.length})`}
        onClick={() => setOpen((o) => !o)}
        style={open ? { background: ACTIVE_BG } : undefined}
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors ${
          open ? "text-accent" : "text-muted hover:bg-white/10"
        }`}
      >
        <IconMore />
      </button>
      {open &&
        createPortal(
          <div
            ref={pop}
            style={pos}
            className="animate-fade-in fixed z-50 min-w-[11rem] overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-2xl"
          >
            {tools.map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  setOpen(false);
                  onPick(t.id);
                }}
                className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors hover:bg-surface-2 ${
                  activeTool === t.id ? "text-accent" : "text-text"
                }`}
              >
                <span className="shrink-0">
                  <t.Icon />
                </span>
                <span className="flex-1">{t.name}</span>
                <span className="shrink-0 text-xs text-muted">{t.key.toUpperCase()}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

/** A compact, typeable font-size field with −/+ steppers and arrow-key support. Lays out as a
 *  tall capsule (+ above, − below) when `vertical`, matching a side-docked tools bar. */
function FontSizeField({
  value,
  onChange,
  min,
  max,
  vertical,
}: {
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  vertical: boolean;
}) {
  const [text, setText] = useState(String(Math.round(value)));
  const focused = useRef(false);
  // Reflect external changes (e.g. selecting another box) unless the user is mid-edit.
  useEffect(() => {
    if (!focused.current) setText(String(Math.round(value)));
  }, [value]);

  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  const step = (delta: number) => onChange(clamp(Math.round(value) + delta));

  const btnCls = `flex items-center justify-center text-base leading-none text-muted transition-colors hover:bg-white/10 hover:text-text ${
    vertical ? "h-6 w-full" : "h-full w-6"
  }`;
  const minus = (
    <button className={btnCls} title="Smaller" onClick={() => step(-1)}>
      −
    </button>
  );
  const plus = (
    <button className={btnCls} title="Larger" onClick={() => step(1)}>
      +
    </button>
  );

  return (
    <div
      className={`flex shrink-0 items-center overflow-hidden rounded-full border border-white/15 bg-black/10 ${
        vertical ? "w-8 flex-col" : "h-7"
      }`}
      title="Font size (points)"
    >
      {vertical ? plus : minus}
      <input
        type="text"
        inputMode="numeric"
        value={text}
        onFocus={(e) => {
          focused.current = true;
          e.currentTarget.select();
        }}
        onChange={(e) => {
          const v = e.target.value.replace(/[^\d]/g, "").slice(0, 3);
          setText(v);
          const n = parseInt(v, 10);
          if (Number.isFinite(n) && n >= min) onChange(clamp(n));
        }}
        onBlur={() => {
          focused.current = false;
          setText(String(Math.round(value)));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "ArrowUp") {
            e.preventDefault();
            step(1);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            step(-1);
          }
        }}
        className={`bg-transparent text-center text-xs font-medium tabular-nums text-text outline-none ${
          vertical ? "h-6 w-full" : "h-full w-7"
        }`}
      />
      {vertical ? minus : plus}
    </div>
  );
}

/** Nearest screen edge to the pointer, for drag-to-dock. */
function edgeAt(x: number, y: number): Side {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const dist: Record<Side, number> = { left: x, right: w - x, top: y, bottom: h - y };
  return (Object.keys(dist) as Side[]).reduce((a, b) => (dist[b] < dist[a] ? b : a));
}

/**
 * How far the pointer must travel before a press counts as a drag rather than a tap.
 *
 * Only the minimised button needs this — it is the one control carrying two actions on one press
 * (tap to reopen, drag to move). Small enough that a deliberate drag is never mistaken for a tap,
 * large enough to absorb the couple of pixels a finger moves while lifting off a touchscreen.
 */
const DRAG_SLOP = 6;

/**
 * Where the minimised button is being dragged to, while a drag is in flight.
 *
 * This is a store rather than component state because the gesture outlives the component that
 * starts it: pressing the grip minimises the bar, which unmounts AnnotationBar and mounts
 * MinimizedToolsButton mid-drag. The window listeners survive that on their own (they are closures
 * on `window`), but the position they produce has to reach whichever component is currently on
 * screen. Transient by design — nothing here is persisted.
 */
const useToolsDrag = create<{
  at: { x: number; y: number } | null;
  update: (at: { x: number; y: number } | null) => void;
}>((set) => ({
  at: null,
  update: (at) => set({ at }),
}));

/**
 * Start dragging the tools button, from either the grip or the minimised button itself.
 *
 * `onTap` runs when the press ends without ever clearing DRAG_SLOP. The grip passes none: it has
 * already minimised by the time this is called, so a press that goes nowhere is simply a minimise.
 *
 * `restoreOnDrop` is what separates the two gestures. A drag begun at the grip is "move the tools":
 * the bar collapsed into the button under your finger, so on release it grows back out of it at the
 * new edge, playing the collapse in reverse. A drag begun on an already-minimised button is "move
 * the button", and leaves it minimised — otherwise nudging the icon out of your way would reopen
 * the very thing you were trying to get out of the way.
 */
function startToolsDrag(
  e: React.PointerEvent,
  { onTap, restoreOnDrop = false }: { onTap?: () => void; restoreOnDrop?: boolean } = {},
) {
  e.preventDefault();
  e.stopPropagation();
  const sx = e.clientX;
  const sy = e.clientY;
  let moved = false;
  const { update } = useToolsDrag.getState();

  const stop = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    update(null);
  };
  const move = (ev: PointerEvent) => {
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_SLOP) return;
    moved = true;
    update({ x: ev.clientX, y: ev.clientY });
  };
  const up = (ev: PointerEvent) => {
    stop();
    if (!moved) {
      onTap?.();
      return;
    }
    // One update, so the edge and the restore land in the same render — two calls would dock the
    // button, paint, and only then start growing the bar.
    useSettings.getState().updateLayout({
      toolsSide: edgeAt(ev.clientX, ev.clientY),
      ...(restoreOnDrop && { annotationsHidden: false }),
    });
  };
  /*
   * Android can take a gesture away mid-drag — a system edge swipe, an incoming call, or the
   * WebView deciding it owns the pan. Without this the listeners leak and the button is stranded
   * wherever the finger last was, with no pointerup ever arriving to put it down. The drag is
   * abandoned rather than committed: a cancelled gesture is not a choice of edge.
   */
  const cancel = () => stop();

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
}

/** Where the bar — or its minimised button — sits for a given edge, centred along that edge. */
const toolsPos = (side: Side): React.CSSProperties =>
  side === "bottom"
    ? { bottom: "calc(env(safe-area-inset-bottom) + 1.25rem)", left: "50%", transform: "translateX(-50%)" }
    : side === "top"
    ? { top: "calc(env(safe-area-inset-top) + 3.5rem)", left: "50%", transform: "translateX(-50%)" }
    : side === "left"
    ? { left: "0.75rem", top: "50%", transform: "translateY(-50%)" }
    : { right: "0.75rem", top: "50%", transform: "translateY(-50%)" };

const GLASS =
  "rounded-full border border-white/15 shadow-2xl ring-1 ring-black/5 backdrop-blur-2xl backdrop-saturate-150";
const GLASS_BG = "color-mix(in srgb, var(--surface) 42%, transparent)";

/**
 * How long the bar takes to collapse into its button, or grow back out of it.
 *
 * Kept in step with the transition on `.tools-collapse` in index.css. JS needs the number too: the
 * outgoing element has to stay mounted for exactly as long as its exit animation runs.
 */
const COLLAPSE_MS = 200;

/**
 * Keep an element mounted for the length of its exit animation.
 *
 * Entering needs no bookkeeping at all: `.tools-in` is a keyframe animation, so it plays the moment
 * the element appears. Driving the open state from JS instead meant flipping a class one frame
 * after mount, which raced — the element could be left collapsed and invisible if that frame was
 * missed. Nothing here depends on a frame firing.
 */
function useCollapse(show: boolean) {
  const [lingering, setLingering] = useState(false);

  useEffect(() => {
    if (show) {
      setLingering(true);
      return;
    }
    const t = setTimeout(() => setLingering(false), COLLAPSE_MS);
    return () => clearTimeout(t);
  }, [show]);

  return { mounted: show || lingering, open: show };
}

/**
 * The animation classes for one of the two forms.
 *
 * These go on an *inner* element, never the positioned one. The fixed wrapper carries the
 * `translateX(-50%)` that centres it on its edge, and folding a scale into that same transform
 * makes the collapse impossible to express as a keyframe without one variant per side.
 */
const collapseCls = (open: boolean) => (open ? "tools-in" : "tools-out");

/**
 * The tools bar while minimised.
 *
 * Tap restores the bar; drag picks it up, carries it under the pointer and drops it against
 * whichever edge is nearest on release. Repositioning used to be possible only from the grip on the
 * expanded bar, which meant the minimised icon could be sitting in your way with no way to move it
 * except reopening the whole bar first.
 *
 * Lives here rather than in App so the docking rules, the edge preview and `toolsPos` have one
 * definition — App previously kept a second copy of the positioning, to be kept in step by hand.
 */
function MinimizedToolsButton({ open }: { open: boolean }) {
  const updateLayout = useSettings((s) => s.updateLayout);
  const side = useSettings((s) => s.layout.toolsSide);
  const at = useToolsDrag((s) => s.at);

  return (
    <div
      className="no-select fixed z-40"
      style={{
        // While dragging the button follows the pointer, so the docked `bottom`/`right` offsets
        // must not be spread in alongside `left`/`top` — hence two whole branches, not a merge.
        // The lift lives out here, on the untouched wrapper, rather than fighting the inner
        // element's collapse animation for the same property.
        ...(at
          ? { left: at.x, top: at.y, transform: "translate(-50%, -50%) scale(1.08)" }
          : toolsPos(side)),
        pointerEvents: open ? undefined : "none",
      }}
    >
      <button
        title="Tap to show the tools · drag to move them to another edge"
        // A tap is how you get the bar back. A drag only re-docks it and leaves it minimised —
        // otherwise moving the icon out of the way would reopen the thing you just moved.
        onPointerDown={(e) =>
          startToolsDrag(e, { onTap: () => updateLayout({ annotationsHidden: false }) })
        }
        // The pointer path never fires a click, so the keyboard needs its own way in.
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            updateLayout({ annotationsHidden: false });
          }
        }}
        className={`flex h-11 w-11 items-center justify-center text-text ${GLASS} ${collapseCls(
          open,
        )} ${at ? "cursor-grabbing" : "cursor-grab"}`}
        // As on the grip: opt out of native panning so a touch drag survives past a few pixels.
        style={{ background: GLASS_BG, touchAction: "none" }}
      >
        <IconPen />
      </button>
    </div>
  );
}

/**
 * The annotation tools, in whichever of their two forms is current.
 *
 * Owns the swap so the outgoing form can shrink away while the incoming one grows in, rather than
 * one being replaced by the other between frames. Both are briefly on screen together, which is
 * what makes the bar look like it collapses *into* its button.
 */
export default function AnnotationTools() {
  const hidden = useSettings((s) => s.layout.annotationsHidden);
  const bar = useCollapse(!hidden);
  const mini = useCollapse(hidden);

  return (
    <>
      {bar.mounted && <ToolsBar open={bar.open} />}
      {mini.mounted && <MinimizedToolsButton open={mini.open} />}
    </>
  );
}

function ToolsBar({ open }: { open: boolean }) {
  const { filePath, currentPage } = useViewer();
  const updateLayout = useSettings((s) => s.updateLayout);
  const side = useSettings((s) => s.layout.toolsSide);
  // Annotations are filed under a cross-device doc key, never the local path — see `docKey` in
  // useSettings. Computed here rather than at each use so the two buttons below cannot drift apart
  // from the lookup above.
  const docKey = useSettings((s) => (filePath ? s.docKey(filePath) : null));
  const toolOrder = useSettings((s) => s.layout.toolOrder);
  const toolsHidden = useSettings((s) => s.layout.toolsHidden);
  const vertical = side === "left" || side === "right";
  const {
    tool,
    color,
    strokeWidth,
    markWeight,
    shapeKind,
    fontSize,
    fillShapes,
    fillOpacity,
    highlightPresets,
    activePreset,
    selectedId,
    optionsOpen,
    byFile,
    setTool,
    setColor,
    setStrokeWidth,
    setMarkWeight,
    setShapeKind,
    setFontSize,
    setFillShapes,
    setFillOpacity,
    setHighlightPreset,
    setActivePreset,
    setSignaturePadOpen,
    remove,
    clearPage,
  } = useAnnotations();

  const pickHighlight = (i: number) => {
    setActivePreset(i);
    setTool("highlight");
  };

  /*
   * Which preset's palette is open, and the swatch it hangs off.
   *
   * Tapping a preset selects it; tapping the one already selected offers to recolour it. That
   * second tap is the whole affordance — the swatch stays a plain circle, and the palette is a
   * deliberate act rather than something you can hit while reaching for the colour beside it.
   */
  const [editing, setEditing] = useState<{ i: number; el: HTMLElement } | null>(null);
  const onPreset = (i: number, el: HTMLElement) => {
    if (tool === "highlight" && activePreset === i)
      setEditing((cur) => (cur?.i === i ? null : { i, el })); // a third tap puts it away again
    else {
      setEditing(null);
      pickHighlight(i);
    }
  };

  // ---- Drag-to-dock: grab the grip and release over an edge to move the bar there. ----
  /*
   * Pressing the grip collapses the bar and hands the same, still-held gesture to the minimised
   * button, so picking the bar up and putting it somewhere else is one motion rather than
   * minimise, let go, then find and drag the icon.
   *
   * The minimise fires on pointerdown, which unmounts this component while the finger is still
   * down — `startToolsDrag` is built for that: its listeners live on `window` and its position goes
   * through a store, so the drag simply continues against whatever is on screen.
   */
  const startDrag = (e: React.PointerEvent) => {
    updateLayout({ annotationsHidden: true });
    startToolsDrag(e, { restoreOnDrop: true });
  };

  // Colour + thickness are only shown contextually: with the pencil, or with the shape tools /
  // a selected shape. This keeps the bar uncluttered the rest of the time.
  const selectedAnno = docKey
    ? (byFile[docKey] ?? []).find((a) => a.id === selectedId)
    : undefined;
  const selectedIsShape = !!selectedAnno && isShapeAnno(selectedAnno);

  /*
   * Which button on the bar the options pill lines itself up with.
   *
   * Normally the active tool. But the pill also opens for a *selected* annotation, and the tool
   * then is Select — which has no options of its own, so pointing the pill at it said nothing and
   * looked like the pill had wandered off. Pointing it at the tool that made the thing instead
   * keeps the line between the controls and what they change.
   */
  const anchorTool: Tool =
    tool !== "select" || !selectedAnno
      ? tool
      : isShapeAnno(selectedAnno)
        ? "shape"
        : (selectedAnno.type as Tool);
  const selectedText = selectedAnno?.type === "text" ? selectedAnno : undefined;
  const penContext = tool === "pen" || selectedAnno?.type === "pen";
  const shapeContext = tool === "shape" || selectedIsShape;
  // A line and an arrow have no inside, so the fill toggle and its opacity are hidden for them
  // rather than shown doing nothing.
  const fillable = isClosedShape(
    selectedIsShape && selectedAnno ? (selectedAnno.type as ShapeKind) : shapeKind,
  );
  const textContext = tool === "text" || !!selectedText;
  // Underline, strike and squiggle draw a line in the pen colour, so they want the swatch — but
  // not the thickness slider: the weight is taken from the height of the text being marked.
  const markContext =
    tool === "underline" ||
    tool === "strikeout" ||
    tool === "squiggly" ||
    selectedAnno?.type === "underline" ||
    selectedAnno?.type === "strikeout" ||
    selectedAnno?.type === "squiggly";
  // Show the selected box's own size when one is selected, otherwise the tool default.
  const effectiveFontSize = selectedText ? selectedText.fontSize : fontSize;

  /*
   * Picking a tool, from the bar or from the ⋯ menu.
   *
   * Three tools do more than set the tool, and the behaviour has to be identical wherever the
   * tool was picked from — which is the reason this is a function rather than a per-button
   * `onClick` as it was when there was only ever one button per tool.
   */
  const activate = (id: Tool) => {
    if (id === "highlight") pickHighlight(activePreset);
    else if (id === "signature" && tool === "signature")
      setSignaturePadOpen(true); // clicking the tool it is already on means "draw a new one"
    else if (id === "form") setTool(tool === "form" ? "select" : "form");
    else setTool(id);
  };

  const toolbar = normalizeToolbar(toolOrder, toolsHidden);
  const shownTools = barTools(toolbar, tool);
  const hiddenTools = menuTools(toolbar, tool);

  const Divider = () =>
    vertical ? (
      <div className="my-1 h-px w-5 shrink-0 bg-border opacity-70" />
    ) : (
      <div className="mx-1 h-5 w-px shrink-0 bg-border opacity-70" />
    );

  // A range slider that turns vertical (rotated 90°) when the bar is docked left/right, so the
  // options pill stacks like the bar. Rotation preserves the custom track/thumb styling and the
  // fill grows upward, which reads correctly for a vertical slider.
  const slider = (props: {
    min: number;
    max: number;
    value: number;
    onChange: (v: number) => void;
    title: string;
    lenClass: string; // horizontal length, e.g. "w-16"
    boxClass: string; // vertical box height to fit the rotated slider, e.g. "h-16"
    val: number; // fill percentage 0..100
  }) => {
    const input = (
      <input
        type="range"
        min={props.min}
        max={props.max}
        value={props.value}
        title={props.title}
        onChange={(e) => props.onChange(Number(e.target.value))}
        className={`bode-range shrink-0 ${props.lenClass} ${vertical ? "-rotate-90" : ""}`}
        style={{ "--val": `${props.val}%` } as React.CSSProperties}
      />
    );
    return vertical ? (
      <div className={`flex w-5 shrink-0 items-center justify-center ${props.boxClass}`}>{input}</div>
    ) : (
      input
    );
  };

  // A colour swatch whose whole 28px face is the picker: the native input is stretched over it at
  // zero opacity, so there is never a smaller, separate target to aim at.
  const swatch = (value: string, onChange: (c: string) => void, title: string) => (
    <label
      title={title}
      className="relative h-7 w-7 shrink-0 cursor-pointer overflow-hidden rounded-full border-2 border-white/30 shadow-inner"
      style={{ background: value }}
    >
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      />
    </label>
  );

  // Colour swatch, reused by the pen/shape and text option groups.
  const colorSwatch = swatch(color, setColor, "Colour for text & shapes");

  // Shared colour swatch + line-thickness slider, rendered next to whichever tool needs it.
  const colorThickness = (
    <>
      {colorSwatch}
      {slider({
        min: 1,
        max: 12,
        value: strokeWidth,
        onChange: setStrokeWidth,
        title: "Line thickness",
        lenClass: "w-16",
        boxClass: "h-16",
        val: ((strokeWidth - 1) / 11) * 100,
      })}
    </>
  );

  /*
   * Colour and weight for the text marks.
   *
   * A separate slider from the pen's, and a different quantity: this one is a multiplier on a
   * weight already derived from the size of the text being marked, so "thicker" stays in
   * proportion whether it is a heading or a footnote being underlined.
   */
  const markControls = (
    <>
      {colorSwatch}
      {slider({
        min: MARK_WEIGHT_MIN * 100,
        max: MARK_WEIGHT_MAX * 100,
        value: Math.round(markWeight * 100),
        onChange: (v) => setMarkWeight(v / 100),
        title: "Line thickness",
        lenClass: "w-16",
        boxClass: "h-16",
        val: ((markWeight - MARK_WEIGHT_MIN) / (MARK_WEIGHT_MAX - MARK_WEIGHT_MIN)) * 100,
      })}
    </>
  );

  // Colour swatch + typeable font-size field for text boxes (active text tool or selected box).
  const fontControls = (
    <>
      {colorSwatch}
      <FontSizeField value={effectiveFontSize} onChange={setFontSize} min={4} max={200} vertical={vertical} />
    </>
  );

  /*
   * Which shape the shape tool draws.
   *
   * Square and ellipse used to be two tools taking two slots on a bar the user has to budget. As
   * a pair of buttons in the options they cost one slot between them, leave room for a third
   * shape later, and put the choice next to the colour and thickness it is drawn with. With a
   * shape selected the picker converts it, since the two carry identical fields.
   */
  const shapePicker = (
    <div className={`flex shrink-0 gap-0.5 ${vertical ? "flex-col" : ""}`}>
      {SHAPE_PICKER.map((o) => {
        const on = shapeKind === o.kind;
        return (
          <button
            key={o.kind}
            title={o.label}
            onClick={() => setShapeKind(o.kind)}
            style={on ? { background: ACTIVE_BG } : undefined}
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors ${
              on ? "text-accent" : "text-muted hover:bg-white/10"
            }`}
          >
            <o.Icon className="h-4 w-4" />
          </button>
        );
      })}
    </div>
  );

  // Fill toggle + opacity, shown only in the shape context.
  const fillControls = (
    <>
      <button
        title={fillShapes ? "Filled shapes: on" : "Filled shapes: off"}
        onClick={() => setFillShapes(!fillShapes)}
        style={fillShapes ? { background: ACTIVE_BG } : undefined}
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors ${
          fillShapes ? "text-accent" : "text-muted hover:bg-white/10"
        }`}
      >
        <IconFill />
      </button>
      {fillShapes && (
        <label
          className={`flex shrink-0 items-center gap-1 text-xs ${vertical ? "flex-col" : "gap-2"}`}
          title="Fill opacity"
        >
          {slider({
            min: 0,
            max: 100,
            value: Math.round(fillOpacity * 100),
            onChange: (v) => setFillOpacity(v / 100),
            title: "Fill opacity",
            lenClass: "w-20",
            boxClass: "h-20",
            val: Math.round(fillOpacity * 100),
          })}
          <span className="w-8 text-center tabular-nums text-text">{Math.round(fillOpacity * 100)}%</span>
        </label>
      )}
    </>
  );

  const posStyle = toolsPos(side);
  const glass = GLASS;
  const surfaceBg = { background: GLASS_BG };
  // While collapsing, the bar is still on screen but must not intercept anything aimed at the page
  // or at the button growing in behind it.
  const pe = open ? "pointer-events-auto" : "pointer-events-none";
  const containerCls = vertical
    ? `no-select no-scrollbar flex max-h-[calc(100vh-2rem)] flex-col items-center gap-1 overflow-y-auto px-1.5 py-2.5 ${glass}`
    : `no-select no-scrollbar flex max-w-[calc(100vw-1rem)] items-center gap-1 overflow-x-auto px-2.5 py-1.5 ${glass}`;

  // The tool-options pill (colour/thickness/fill) floats just off the bar's page-facing side. It
  // shows when a drawing tool is freshly picked (or a shape/pen is selected) and collapses once
  // the tool is used — keeping the bar itself a fixed size.
  const showPill = optionsOpen && (penContext || shapeContext || textContext || markContext);
  /*
   * Line the options pill up with the tool it belongs to.
   *
   * Centred on the bar, the pill said "some tool has options" and left you to work out which. The
   * bar can hold a dozen buttons and be reordered arbitrarily, so the answer was rarely nearby.
   * Offsetting it to the active button's centre makes the colour you are about to draw with sit
   * directly off the tool you picked.
   *
   * Measured rather than computed: the bar scrolls when it is longer than the screen, tools can
   * carry extra controls beside them (the highlighter's presets), and either would defeat any
   * arithmetic over button widths.
   */
  const barRef = useRef<HTMLDivElement>(null);
  const [pillOffset, setPillOffset] = useState(0);
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar || !showPill) return;
    const btn = bar.querySelector<HTMLElement>(`[data-tool="${anchorTool}"]`);
    if (!btn) {
      setPillOffset(0);
      return;
    }
    const b = bar.getBoundingClientRect();
    const t = btn.getBoundingClientRect();
    // Clamped to the bar so the pill can never be dragged off past its own ends by a tool that
    // has been scrolled to the edge.
    const raw = vertical
      ? t.top + t.height / 2 - (b.top + b.height / 2)
      : t.left + t.width / 2 - (b.left + b.width / 2);
    const limit = (vertical ? b.height : b.width) / 2;
    setPillOffset(Math.max(-limit, Math.min(limit, raw)));
  }, [showPill, anchorTool, side, vertical, shownTools.length, markContext, penContext, shapeContext, textContext]);

  const pillFirst = side === "bottom" || side === "right"; // order so the pill sits toward the page
  const optionsPill = showPill ? (
    <div
      className={`no-select ${pe} flex items-center gap-2 ${glass} ${
        vertical ? "flex-col px-2 py-3" : "px-3 py-1.5"
      }`}
      style={{
        ...surfaceBg,
        transform: vertical ? `translateY(${pillOffset}px)` : `translateX(${pillOffset}px)`,
        transition: "transform 160ms ease-out",
      }}
    >
      {markContext ? (
        markControls
      ) : textContext ? (
        fontControls
      ) : (
        <>
          {shapeContext && shapePicker}
          {colorThickness}
          {shapeContext && fillable && fillControls}
        </>
      )}
    </div>
  ) : null;

  return (
    <>
      {/* The wrapper only positions the bar + pill; it stays click-through so its empty area
          (the gap and the space beside the centred pill) never blocks drawing on the page —
          only the bar and pill themselves capture pointer events. */}
      <div
        className="no-select pointer-events-none fixed z-40"
        style={posStyle}
      >
        {/* Inner element so the collapse animates scale without disturbing the wrapper's
            positioning transform. */}
        <div
          className={`flex items-center gap-2 ${vertical ? "flex-row" : "flex-col"} ${collapseCls(open)}`}
        >
        {pillFirst && optionsPill}
        <div ref={barRef} className={`${containerCls} ${pe}`} style={surfaceBg}>
        <button
          title="Minimise · keep holding to drag the tools to another edge"
          onPointerDown={startDrag}
          // Without this the WebView claims the gesture for panning after a few pixels and fires
          // pointercancel, so a touch drag dies almost immediately. The bar itself scrolls
          // horizontally on a phone, which is exactly the pan being opted out of here.
          style={{ touchAction: "none" }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              updateLayout({ annotationsHidden: true });
            }
          }}
          className="flex h-9 w-7 shrink-0 cursor-grab items-center justify-center rounded-full text-muted hover:bg-white/10 active:cursor-grabbing"
        >
          <IconGrip />
        </button>

        <Divider />

        {/*
          The tools the user has chosen, in the order they chose, with no group dividers between
          them: an arrangement someone made themselves cannot also honour groupings someone else
          decided on. The dividers around the grip and around Delete/Clear stay, so the bar still
          reads as chrome, tools, chrome.
        */}
        {shownTools.map((t) => (
          <Fragment key={t.id}>
            <ToolBtn
              active={tool === t.id}
              title={t.title}
              onClick={() => activate(t.id)}
              toolId={t.id}
            >
              <t.Icon />
            </ToolBtn>
            {/* The highlighter's presets belong to it and travel with it when it is reordered. */}
            {t.id === "highlight" &&
              highlightPresets.map((c, i) => (
                <button
                  key={i}
                  title={
                    tool === "highlight" && activePreset === i
                      ? "Tap again to change this colour"
                      : `Highlight colour ${i + 1}`
                  }
                  onClick={(e) => onPreset(i, e.currentTarget)}
                  className={`h-7 w-7 shrink-0 rounded-full border-2 shadow-inner ${
                    tool === "highlight" && activePreset === i
                      ? "border-accent"
                      : "border-white/30"
                  }`}
                  style={{ background: c }}
                />
              ))}
          </Fragment>
        ))}

        <MoreTools tools={hiddenTools} side={side} activeTool={tool} onPick={activate} />

        {editing && (
          <ColorPopover
            anchorEl={editing.el}
            side={side}
            value={highlightPresets[editing.i]}
            onChange={(c) => setHighlightPreset(editing.i, c)}
            onClose={() => setEditing(null)}
          />
        )}

        <Divider />

        <button
          title="Delete selected (Del)"
          disabled={!selectedId}
          onClick={() => selectedId && docKey && remove(docKey, selectedId)}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text transition-colors hover:bg-white/10 disabled:opacity-25 disabled:hover:bg-transparent"
        >
          <IconTrash />
        </button>
        <button
          title="Clear annotations on this page"
          onClick={() => docKey && clearPage(docKey, currentPage - 1)}
          className="shrink-0 rounded-full px-2.5 py-1.5 text-xs font-medium text-text transition-colors hover:bg-white/10"
        >
          Clear
        </button>

        <Divider />

        <button
          title="Hide toolbar"
          onClick={() => updateLayout({ annotationsHidden: true })}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text transition-colors hover:bg-white/10"
        >
          <IconChevronDown />
        </button>
        </div>
        {!pillFirst && optionsPill}
        </div>
      </div>
    </>
  );
}
