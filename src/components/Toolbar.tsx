import { useEffect, useState } from "react";
import { useViewer } from "../store/viewerStore";
import { useSettings } from "../settings/useSettings";
import {
  IconOpen,
  IconSearch,
  IconSidebar,
  IconZoomIn,
  IconZoomOut,
  IconFitWidth,
  IconFitPage,
  IconSettings,
  IconZen,
} from "./icons";

function Btn({
  title,
  onClick,
  active,
  children,
}: {
  title: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={`flex h-9 w-9 items-center justify-center rounded-md transition-colors hover:bg-surface-2 ${
        active ? "bg-surface-2 text-accent" : "text-text"
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
    openWithDialog,
    setFitMode,
    zoomIn,
    zoomOut,
    goToPage,
    toggleSearch,
  } = useViewer();
  const { layout, toggleSidebar, toggleZen } = useSettings();
  const search = useViewer((s) => s.search);

  const [pageInput, setPageInput] = useState(String(currentPage));
  useEffect(() => setPageInput(String(currentPage)), [currentPage]);

  return (
    <div className="no-select flex h-12 items-center gap-1 border-b border-border bg-surface px-2">
      <Btn title="Toggle sidebar (Ctrl+B)" onClick={toggleSidebar} active={layout.sidebarOpen}>
        <IconSidebar />
      </Btn>
      <Btn title="Open PDF (Ctrl+O)" onClick={openWithDialog}>
        <IconOpen />
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
        </>
      )}

      <div className="flex-1 truncate px-3 text-center text-sm text-muted">{fileName ?? "Bode"}</div>

      {doc && (
        <Btn title="Find (Ctrl+F)" onClick={() => toggleSearch()} active={search.open}>
          <IconSearch />
        </Btn>
      )}
      <Btn title="Zen mode" onClick={toggleZen} active={layout.zenMode}>
        <IconZen />
      </Btn>
      <Btn title="Settings" onClick={onOpenSettings}>
        <IconSettings />
      </Btn>
    </div>
  );
}
