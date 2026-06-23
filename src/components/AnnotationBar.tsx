import { useRef, useState } from "react";
import { useViewer } from "../store/viewerStore";
import { useSettings } from "../settings/useSettings";
import { useAnnotations } from "../annotations/useAnnotations";
import {
  IconCursor,
  IconHighlight,
  IconText,
  IconSquare,
  IconCircle,
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
    fillShapes,
    fillOpacity,
    highlightPresets,
    activePreset,
    selectedId,
    byFile,
    setTool,
    setColor,
    setStrokeWidth,
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
  const penContext = tool === "pen" || selectedAnno?.type === "pen";
  const shapeContext = tool === "rect" || tool === "ellipse" || selectedIsShape;

  const Divider = () =>
    vertical ? (
      <div className="my-1 h-px w-5 shrink-0 bg-border opacity-70" />
    ) : (
      <div className="mx-1 h-5 w-px shrink-0 bg-border opacity-70" />
    );

  // Shared colour swatch + line-thickness slider, rendered next to whichever tool needs it.
  const colorThickness = (
    <>
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
      <input
        type="range"
        min={1}
        max={12}
        value={strokeWidth}
        title="Line thickness"
        onChange={(e) => setStrokeWidth(Number(e.target.value))}
        className="w-16 shrink-0 accent-[var(--accent)]"
      />
    </>
  );

  // Fill toggle + opacity, shown only in the shape context.
  const fillControls = (
    <>
      <button
        title="Toggle filled shapes"
        onClick={() => setFillShapes(!fillShapes)}
        style={fillShapes ? { background: ACTIVE_BG } : undefined}
        className={`flex h-9 shrink-0 items-center gap-1.5 rounded-full px-2.5 transition-colors ${
          fillShapes ? "text-accent" : "text-muted hover:bg-white/10"
        }`}
      >
        <span
          className="h-3.5 w-3.5 rounded-[4px] border-2"
          style={{ borderColor: "currentColor", background: fillShapes ? "currentColor" : "transparent" }}
        />
        <span className="text-xs font-medium">Fill</span>
      </button>
      {fillShapes && (
        <label className="flex shrink-0 items-center gap-1 text-xs text-muted" title="Fill opacity">
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(fillOpacity * 100)}
            onChange={(e) => setFillOpacity(Number(e.target.value) / 100)}
            className="w-14 accent-[var(--accent)]"
          />
          <span className="w-8 text-right tabular-nums">{Math.round(fillOpacity * 100)}%</span>
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

  const containerCls = vertical
    ? "no-select fixed z-40 flex max-h-[calc(100vh-2rem)] flex-col items-center gap-1 overflow-y-auto rounded-full border border-white/15 px-1.5 py-2.5 shadow-2xl ring-1 ring-black/5 backdrop-blur-2xl backdrop-saturate-150"
    : "no-select fixed z-40 flex max-w-[calc(100vw-1rem)] items-center gap-1 overflow-x-auto rounded-full border border-white/15 px-2.5 py-1.5 shadow-2xl ring-1 ring-black/5 backdrop-blur-2xl backdrop-saturate-150";

  return (
    <>
      <div
        className={containerCls}
        style={{ ...posStyle, background: "color-mix(in srgb, var(--surface) 42%, transparent)" }}
      >
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

        {/* Pencil — colour & thickness appear only while it's the active/selected tool */}
        <ToolBtn active={tool === "pen"} title="Freehand draw (P)" onClick={() => setTool("pen")}>
          <IconPen />
        </ToolBtn>
        {penContext && colorThickness}

        <ToolBtn active={tool === "eraser"} title="Eraser — click or drag to remove (X)" onClick={() => setTool("eraser")}>
          <IconEraser />
        </ToolBtn>

        <ToolBtn active={tool === "text"} title="Text box (T)" onClick={() => setTool("text")}>
          <IconText />
        </ToolBtn>

        {/* Shapes — colour, thickness & fill appear only in the shape context */}
        <ToolBtn active={tool === "rect"} title="Rectangle (R)" onClick={() => setTool("rect")}>
          <IconSquare />
        </ToolBtn>
        <ToolBtn active={tool === "ellipse"} title="Ellipse (O)" onClick={() => setTool("ellipse")}>
          <IconCircle />
        </ToolBtn>
        {shapeContext && (
          <>
            {colorThickness}
            {fillControls}
          </>
        )}

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
