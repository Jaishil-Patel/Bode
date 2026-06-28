import { useEffect, useRef, useState } from "react";
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

export default function AnnotationBar() {
  const { filePath, currentPage } = useViewer();
  const updateLayout = useSettings((s) => s.updateLayout);
  const side = useSettings((s) => s.layout.toolsSide);
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
  const [dragTarget, setDragTarget] = useState<Side | null>(null);
  const dragging = useRef(false);
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragging.current = true;
    setDragTarget(side);
    const move = (ev: PointerEvent) => {
      if (dragging.current) setDragTarget(edgeAt(ev.clientX, ev.clientY));
    };
    const up = (ev: PointerEvent) => {
      dragging.current = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const target = edgeAt(ev.clientX, ev.clientY);
      setDragTarget(null);
      if (target !== side) updateLayout({ toolsSide: target });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Colour + thickness are only shown contextually: with the pencil, or with the shape tools /
  // a selected shape. This keeps the bar uncluttered the rest of the time.
  const selectedAnno = filePath ? (byFile[filePath] ?? []).find((a) => a.id === selectedId) : undefined;
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

  // Position the floating bar against the chosen edge, centred along that edge.
  const posStyle: React.CSSProperties =
    side === "bottom"
      ? { bottom: "calc(env(safe-area-inset-bottom) + 1.25rem)", left: "50%", transform: "translateX(-50%)" }
      : side === "top"
      ? { top: "calc(env(safe-area-inset-top) + 3.5rem)", left: "50%", transform: "translateX(-50%)" }
      : side === "left"
      ? { left: "0.75rem", top: "50%", transform: "translateY(-50%)" }
      : { right: "0.75rem", top: "50%", transform: "translateY(-50%)" };

  const glass =
    "rounded-full border border-white/15 shadow-2xl ring-1 ring-black/5 backdrop-blur-2xl backdrop-saturate-150";
  const surfaceBg = { background: "color-mix(in srgb, var(--surface) 42%, transparent)" };
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
      className={`no-select pointer-events-auto flex items-center gap-2 ${glass} ${
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
        className={`no-select pointer-events-none fixed z-40 flex items-center gap-2 ${vertical ? "flex-row" : "flex-col"}`}
        style={posStyle}
      >
        {pillFirst && optionsPill}
        <div className={`${containerCls} pointer-events-auto`} style={surfaceBg}>
        <button
          title="Drag to move the tools bar to another edge"
          onPointerDown={startDrag}
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
          onClick={() => selectedId && filePath && remove(filePath, selectedId)}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text transition-colors hover:bg-white/10 disabled:opacity-25 disabled:hover:bg-transparent"
        >
          <IconTrash />
        </button>
        <button
          title="Clear annotations on this page"
          onClick={() => filePath && clearPage(filePath, currentPage - 1)}
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

      {/* Drag feedback: highlight the edge the bar will snap to on release. */}
      {dragTarget && (
        <div className="pointer-events-none fixed inset-0 z-[60]">
          <div
            className="absolute bg-accent/30 ring-2 ring-accent transition-all"
            style={
              dragTarget === "top"
                ? { top: 0, left: 0, right: 0, height: 56 }
                : dragTarget === "bottom"
                ? { bottom: 0, left: 0, right: 0, height: 56 }
                : dragTarget === "left"
                ? { top: 0, bottom: 0, left: 0, width: 56 }
                : { top: 0, bottom: 0, right: 0, width: 56 }
            }
          />
        </div>
      )}
    </>
  );
}
