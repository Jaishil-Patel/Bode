import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { useViewer } from "../store/viewerStore";
import { useSettings } from "../settings/useSettings";
import { useAnnotations } from "../annotations/useAnnotations";
import {
  IconCursor,
  IconHighlight,
  IconText,
  IconSquare,
  IconCircle,
  IconFill,
  IconPen,
  IconEdit,
  IconSignature,
  IconEraser,
  IconTrash,
  IconChevronDown,
  IconGrip,
} from "./icons";

type Side = "bottom" | "top" | "left" | "right";

// Subtle accent tint used for the active tool, theme-aware via color-mix.
const ACTIVE_BG = "color-mix(in srgb, var(--accent) 22%, transparent)";

function ToolBtn({
  active,
  title,
  onClick,
  children,
}: {
  active: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
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
  const vertical = side === "left" || side === "right";
  const {
    tool,
    color,
    strokeWidth,
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
  const selectedIsShape = selectedAnno?.type === "rect" || selectedAnno?.type === "ellipse";
  const selectedText = selectedAnno?.type === "text" ? selectedAnno : undefined;
  const penContext = tool === "pen" || selectedAnno?.type === "pen";
  const shapeContext = tool === "rect" || tool === "ellipse" || selectedIsShape;
  const textContext = tool === "text" || !!selectedText;
  // Show the selected box's own size when one is selected, otherwise the tool default.
  const effectiveFontSize = selectedText ? selectedText.fontSize : fontSize;

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

  // Colour swatch, reused by the pen/shape and text option groups.
  const colorSwatch = (
    <label
      title="Colour for text & shapes"
      className="relative h-7 w-7 shrink-0 cursor-pointer overflow-hidden rounded-full border-2 border-white/30 shadow-inner"
      style={{ background: color }}
    >
      <input
        type="color"
        value={color}
        onChange={(e) => setColor(e.target.value)}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      />
    </label>
  );

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

  // Colour swatch + typeable font-size field for text boxes (active text tool or selected box).
  const fontControls = (
    <>
      {colorSwatch}
      <FontSizeField value={effectiveFontSize} onChange={setFontSize} min={4} max={200} vertical={vertical} />
    </>
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
  const showPill = optionsOpen && (penContext || shapeContext || textContext);
  const pillFirst = side === "bottom" || side === "right"; // order so the pill sits toward the page
  const optionsPill = showPill ? (
    <div
      className={`no-select ${pe} flex items-center gap-2 ${glass} ${
        vertical ? "flex-col px-2 py-3" : "px-3 py-1.5"
      }`}
      style={surfaceBg}
    >
      {textContext ? (
        fontControls
      ) : (
        <>
          {colorThickness}
          {shapeContext && fillControls}
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
        <div className={`${containerCls} ${pe}`} style={surfaceBg}>
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

        <ToolBtn active={tool === "select"} title="Select / move (V)" onClick={() => setTool("select")}>
          <IconCursor />
        </ToolBtn>

        <Divider />

        {/* Highlighter with three editable presets */}
        <button
          title="Highlighter (H)"
          onClick={() => pickHighlight(activePreset)}
          style={tool === "highlight" ? { background: ACTIVE_BG } : undefined}
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors ${
            tool === "highlight" ? "text-accent" : "text-text hover:bg-white/10"
          }`}
        >
          <IconHighlight />
        </button>
        {highlightPresets.map((c, i) => (
          <div key={i} className="relative h-7 w-7 shrink-0">
            <button
              title={`Highlight colour ${i + 1}`}
              onClick={() => pickHighlight(i)}
              className={`h-full w-full rounded-full border-2 shadow-inner transition-transform hover:scale-110 ${
                tool === "highlight" && activePreset === i ? "border-accent" : "border-white/30"
              }`}
              style={{ background: c }}
            />
            <input
              type="color"
              value={c}
              title="Edit colour"
              onChange={(e) => setHighlightPreset(i, e.target.value)}
              className="absolute -bottom-0.5 -right-0.5 h-3 w-3 cursor-pointer rounded-full border border-white/60 p-0"
              style={{ background: c }}
            />
          </div>
        ))}

        <Divider />

        {/* Pencil — colour & thickness appear in the floating options pill (see below) */}
        <ToolBtn active={tool === "pen"} title="Freehand draw (P)" onClick={() => setTool("pen")}>
          <IconPen />
        </ToolBtn>

        <ToolBtn active={tool === "eraser"} title="Eraser — click or drag to remove (X)" onClick={() => setTool("eraser")}>
          <IconEraser />
        </ToolBtn>

        <ToolBtn active={tool === "text"} title="Text box (T)" onClick={() => setTool("text")}>
          <IconText />
        </ToolBtn>

        {/* Shapes — colour, thickness & fill appear in the floating options pill (see below) */}
        <ToolBtn active={tool === "rect"} title="Rectangle (R)" onClick={() => setTool("rect")}>
          <IconSquare />
        </ToolBtn>
        <ToolBtn active={tool === "ellipse"} title="Ellipse (O)" onClick={() => setTool("ellipse")}>
          <IconCircle />
        </ToolBtn>

        <Divider />

        <ToolBtn active={tool === "edit"} title="Edit text (E)" onClick={() => setTool("edit")}>
          <IconEdit />
        </ToolBtn>
        <ToolBtn
          active={tool === "signature"}
          title="Sign (S) — click again to draw a new signature"
          onClick={() => (tool === "signature" ? setSignaturePadOpen(true) : setTool("signature"))}
        >
          <IconSignature />
        </ToolBtn>

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
