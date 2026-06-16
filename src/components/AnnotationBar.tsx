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
  IconTrash,
  IconChevronDown,
} from "./icons";

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
      className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors ${
        active ? "text-accent" : "text-text hover:bg-white/10"
      }`}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <div className="mx-1 h-5 w-px bg-border opacity-70" />;
}

export default function AnnotationBar() {
  const { filePath, currentPage } = useViewer();
  const updateLayout = useSettings((s) => s.updateLayout);
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
    remove,
    clearPage,
  } = useAnnotations();

  const pickHighlight = (i: number) => {
    setActivePreset(i);
    setTool("highlight");
  };

  // Fill controls are only relevant for the shape tools, or when a shape is selected.
  const selectedAnno = filePath ? (byFile[filePath] ?? []).find((a) => a.id === selectedId) : undefined;
  const selectedIsShape = selectedAnno?.type === "rect" || selectedAnno?.type === "ellipse";
  const showFill = tool === "rect" || tool === "ellipse" || selectedIsShape;

  return (
    <div
      className="no-select fixed bottom-5 left-1/2 z-40 flex -translate-x-1/2 items-center gap-1 rounded-full border border-white/15 px-2.5 py-1.5 shadow-2xl ring-1 ring-black/5 backdrop-blur-2xl backdrop-saturate-150"
      style={{ background: "color-mix(in srgb, var(--surface) 42%, transparent)" }}
    >
      <ToolBtn active={tool === "select"} title="Select / move (V)" onClick={() => setTool("select")}>
        <IconCursor />
      </ToolBtn>

      <Divider />

      {/* Highlighter with three editable presets */}
      <button
        title="Highlighter (H)"
        onClick={() => pickHighlight(activePreset)}
        style={tool === "highlight" ? { background: ACTIVE_BG } : undefined}
        className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors ${
          tool === "highlight" ? "text-accent" : "text-text hover:bg-white/10"
        }`}
      >
        <IconHighlight />
      </button>
      {highlightPresets.map((c, i) => (
        <div key={i} className="relative h-7 w-7">
          <button
            title={`Highlight colour ${i + 1}`}
            onClick={() => pickHighlight(i)}
            className={`h-full w-full rounded-full border-2 shadow-inner transition-transform hover:scale-110 ${
              tool === "highlight" && activePreset === i
                ? "border-accent"
                : "border-white/30"
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

      {/* Text + shapes */}
      <ToolBtn active={tool === "text"} title="Text box (T)" onClick={() => setTool("text")}>
        <IconText />
      </ToolBtn>
      <ToolBtn active={tool === "rect"} title="Rectangle (R)" onClick={() => setTool("rect")}>
        <IconSquare />
      </ToolBtn>
      <ToolBtn active={tool === "ellipse"} title="Ellipse (O)" onClick={() => setTool("ellipse")}>
        <IconCircle />
      </ToolBtn>
      <ToolBtn active={tool === "pen"} title="Freehand draw (P)" onClick={() => setTool("pen")}>
        <IconPen />
      </ToolBtn>

      {/* Shared colour + thickness */}
      <label
        title="Colour for text & shapes"
        className="relative h-7 w-7 cursor-pointer overflow-hidden rounded-full border-2 border-white/30 shadow-inner"
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
        className="w-16 accent-[var(--accent)]"
      />

      {showFill && (
        <>
          <Divider />
          <button
            title="Toggle filled shapes"
            onClick={() => setFillShapes(!fillShapes)}
            style={fillShapes ? { background: ACTIVE_BG } : undefined}
            className={`flex h-9 items-center gap-1.5 rounded-full px-2.5 transition-colors ${
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
            <label className="flex items-center gap-1 text-xs text-muted" title="Fill opacity">
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
      )}

      <Divider />

      <button
        title="Delete selected (Del)"
        disabled={!selectedId}
        onClick={() => selectedId && filePath && remove(filePath, selectedId)}
        className="flex h-9 w-9 items-center justify-center rounded-full text-text transition-colors hover:bg-white/10 disabled:opacity-25 disabled:hover:bg-transparent"
      >
        <IconTrash />
      </button>
      <button
        title="Clear annotations on this page"
        onClick={() => filePath && clearPage(filePath, currentPage - 1)}
        className="rounded-full px-2.5 py-1.5 text-xs font-medium text-text transition-colors hover:bg-white/10"
      >
        Clear
      </button>

      <Divider />

      <button
        title="Hide toolbar"
        onClick={() => updateLayout({ annotationsHidden: true })}
        className="flex h-9 w-9 items-center justify-center rounded-full text-text transition-colors hover:bg-white/10"
      >
        <IconChevronDown />
      </button>
    </div>
  );
}
