import { useEffect, useState } from "react";
import { useViewer } from "../store/viewerStore";
import { useSettings } from "../settings/useSettings";
import { useAnnotations } from "../annotations/useAnnotations";
import { exportAnnotatedPdf } from "../pdf/exportPdf";
import {
  IconSidebar,
  IconSearch,
  IconZoomIn,
  IconZoomOut,
  IconFitWidth,
  IconFitPage,
  IconSave,
  IconUndo,
  IconRedo,
  IconSettings,
} from "./icons";

function Btn({
  title,
  onClick,
  active,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition-colors ${
        disabled
          ? "cursor-default text-muted/40"
          : `hover:bg-surface-2 ${active ? "bg-surface-2 text-accent" : "text-text"}`
      }`}
    >
      {children}
    </button>
  );
}

export default function Toolbar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const {
    doc,
    fileName,
    currentPage,
    numPages,
    scale,
    fitMode,
    setFitMode,
    zoomIn,
    zoomOut,
    goToPage,
    toggleSearch,
  } = useViewer();
  const { layout, toggleSidebar } = useSettings();
  const filePath = useViewer((s) => s.filePath);
  const search = useViewer((s) => s.search);
  const byFile = useAnnotations((s) => s.byFile);
  const canUndo = useAnnotations((s) => s.past.length > 0);
  const canRedo = useAnnotations((s) => s.future.length > 0);
  const undo = useAnnotations((s) => s.undo);
  const redo = useAnnotations((s) => s.redo);

  const [pageInput, setPageInput] = useState(String(currentPage));
  useEffect(() => setPageInput(String(currentPage)), [currentPage]);

  const [saving, setSaving] = useState(false);
  const onSave = async () => {
    if (!filePath || saving) return;
    setSaving(true);
    try {
      await exportAnnotatedPdf(filePath, byFile[filePath] ?? []);
    } catch (e) {
      useViewer.setState({ error: `Save failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="no-select flex min-h-12 items-center gap-1 border-b border-border bg-surface px-2"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <Btn title="Toggle sidebar (Ctrl+B)" onClick={toggleSidebar} active={layout.sidebarOpen}>
        <IconSidebar />
      </Btn>

      <div className="mx-1 h-6 w-px bg-border" />

      {doc && (
        <>
          <div className="flex items-center gap-1 text-sm text-muted">
            <input
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value.replace(/[^0-9]/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter") goToPage(Number(pageInput) || 1);
              }}
              onBlur={() => goToPage(Number(pageInput) || 1)}
              className="w-12 rounded border border-border bg-surface-2 px-2 py-1 text-center text-text outline-none focus:border-accent"
            />
            <span>/ {numPages}</span>
          </div>

          {/* Zoom & fit controls are redundant with pinch-zoom on a phone — hide on narrow screens. */}
          <div className="hidden items-center gap-1 sm:flex">
            <div className="mx-1 h-6 w-px bg-border" />
            <Btn title="Zoom out (Ctrl+-)" onClick={zoomOut}>
              <IconZoomOut />
            </Btn>
            <span className="w-12 text-center text-sm text-muted">{Math.round(scale * 100)}%</span>
            <Btn title="Zoom in (Ctrl++)" onClick={zoomIn}>
              <IconZoomIn />
            </Btn>
            <Btn title="Fit width" onClick={() => setFitMode("width")} active={fitMode === "width"}>
              <IconFitWidth />
            </Btn>
            <Btn title="Fit page" onClick={() => setFitMode("page")} active={fitMode === "page"}>
              <IconFitPage />
            </Btn>
          </div>
        </>
      )}

      <div className="min-w-0 flex-1 truncate px-3 text-center text-sm text-muted">
        <span className="hidden sm:inline">{fileName ?? "Bode"}</span>
      </div>

      {doc && (
        <>
          <Btn title="Undo (Ctrl+Z)" onClick={undo} disabled={!canUndo}>
            <IconUndo />
          </Btn>
          <Btn title="Redo (Ctrl+Shift+Z)" onClick={redo} disabled={!canRedo}>
            <IconRedo />
          </Btn>
          <div className="mx-1 h-6 w-px bg-border" />
        </>
      )}
      {doc && (
        <Btn title="Find (Ctrl+F)" onClick={() => toggleSearch()} active={search.open}>
          <IconSearch />
        </Btn>
      )}
      {doc && (
        <Btn title={saving ? "Saving…" : "Save annotated PDF"} onClick={onSave}>
          <IconSave className={saving ? "animate-pulse" : undefined} />
        </Btn>
      )}
      <Btn title="Settings" onClick={onOpenSettings}>
        <IconSettings />
      </Btn>
    </div>
  );
}
