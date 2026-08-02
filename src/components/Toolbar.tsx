import { useEffect, useState } from "react";
import { useViewer } from "../store/viewerStore";
import { useSettings } from "../settings/useSettings";
import { useAnnotations } from "../annotations/useAnnotations";
import {
  IconSidebar,
  IconSearch,
  IconZoomIn,
  IconZoomOut,
  IconFitWidth,
  IconFitPage,
  IconSaveDisk,
  IconShield,
  IconShieldOff,
  IconUndo,
  IconRedo,
  IconSettings,
  IconPen,
  IconPages,
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
  const textKind = useViewer((s) => s.textKind);
  const isText = useViewer((s) => s.textSource != null);
  const textEditing = useViewer((s) => s.textEditing);
  const textDirty = useViewer((s) => s.textDirty);
  const toggleTextEdit = useViewer((s) => s.toggleTextEdit);
  const saveText = useViewer((s) => s.saveText);
  const htmlTrusted = useViewer((s) => s.htmlTrustedUrl != null);
  const setHtmlTrusted = useViewer((s) => s.setHtmlTrusted);
  const organizeOpen = useViewer((s) => s.organizeOpen);
  const setOrganizeOpen = useViewer((s) => s.setOrganizeOpen);
  const pageEdits = useViewer((s) => s.hasPageEdits());
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
      // The store decides plain vs. decrypt-and-flatten based on whether this PDF is encrypted
      // and the "Remove password when saving" setting; it also surfaces any error.
      await useViewer.getState().saveAnnotated();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="no-select flex min-h-12 items-center gap-1 border-b border-border bg-surface px-2"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      {/* The sidebar (thumbnails/outline) only applies to PDFs, so hide its toggle for text tabs. */}
      {!isText && (
        <>
          <Btn title="Toggle sidebar (Ctrl+B)" onClick={toggleSidebar} active={layout.sidebarOpen}>
            <IconSidebar />
          </Btn>
          <div className="mx-1 h-6 w-px bg-border" />
        </>
      )}

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
        <span className="hidden sm:inline">
          {fileName ?? "Bode"}
          {isText && textDirty && <span title="Unsaved changes" className="text-accent"> •</span>}
        </span>
      </div>

      {textKind === "html" && (
        <Btn
          title={
            htmlTrusted
              ? "Scripts are running — click to sandbox this page again and forget it"
              : "Sandboxed: scripts are blocked. Click to trust this page and let it run (remembered)."
          }
          onClick={() => setHtmlTrusted(!htmlTrusted)}
          active={htmlTrusted}
        >
          {htmlTrusted ? <IconShieldOff /> : <IconShield />}
        </Btn>
      )}

      {isText && (
        <>
          <Btn
            title={
              textEditing
                ? "Done editing (preview)"
                : `Edit ${textKind === "html" ? "HTML" : "Markdown"} (Ctrl+E)`
            }
            onClick={() => toggleTextEdit()}
            active={textEditing}
          >
            <IconPen />
          </Btn>
          <Btn title="Save (Ctrl+S)" onClick={saveText} disabled={!textDirty}>
            <IconSaveDisk />
          </Btn>
          <div className="mx-1 h-6 w-px bg-border" />
        </>
      )}

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
        <Btn
          title="Organize pages (remove & reorder)"
          onClick={() => {
            const next = !organizeOpen;
            setOrganizeOpen(next);
            if (next && !layout.sidebarOpen) toggleSidebar(); // the organizer lives in the sidebar
          }}
          active={organizeOpen}
        >
          <IconPages />
        </Btn>
      )}
      {doc && (
        <Btn
          title={
            saving
              ? "Saving…"
              : pageEdits
                ? "Save PDF with page edits"
                : "Save annotated PDF"
          }
          onClick={onSave}
        >
          <span className="relative">
            <IconSaveDisk className={saving ? "animate-pulse" : undefined} />
            {pageEdits && !saving && (
              <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-accent" />
            )}
          </span>
        </Btn>
      )}
      <Btn title="Settings" onClick={onOpenSettings}>
        <IconSettings />
      </Btn>
    </div>
  );
}
