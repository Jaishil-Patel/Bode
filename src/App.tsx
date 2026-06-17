import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useViewer } from "./store/viewerStore";
import { useSettings } from "./settings/useSettings";
import { useAnnotations } from "./annotations/useAnnotations";
import Toolbar from "./components/Toolbar";
import AnnotationBar from "./components/AnnotationBar";
import Sidebar from "./components/Sidebar";
import SearchBar from "./components/SearchBar";
import CommandPalette from "./components/CommandPalette";
import SignaturePad from "./components/SignaturePad";
import SettingsPanel from "./settings/SettingsPanel";
import PdfViewer from "./pdf/PdfViewer";
import { isAndroid } from "./platform/files";
import { IconOpen, IconPen } from "./components/icons";

function ShowToolsButton() {
  const updateLayout = useSettings((s) => s.updateLayout);
  return (
    <button
      title="Show annotation tools"
      onClick={() => updateLayout({ annotationsHidden: false })}
      className="no-select fixed bottom-5 left-1/2 z-40 flex h-11 w-11 -translate-x-1/2 items-center justify-center rounded-full border border-white/15 text-text shadow-2xl ring-1 ring-black/5 backdrop-blur-2xl backdrop-saturate-150 transition-transform hover:scale-105"
      style={{ background: "color-mix(in srgb, var(--surface) 42%, transparent)" }}
    >
      <IconPen />
    </button>
  );
}

function EmptyState() {
  const openWithDialog = useViewer((s) => s.openWithDialog);
  const openPath = useViewer((s) => s.openPath);
  const { recents } = useSettings();
  // Android hands back content:// URIs whose read permission isn't kept after the app closes, so
  // a stored recent can't be reopened — hide the list there rather than show broken entries.
  const showRecents = recents.length > 0 && !isAndroid();

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8">
      <div className="text-center">
        <h1 className="text-3xl font-semibold text-text">Bode</h1>
        <p className="mt-1 text-sm text-muted">A calm, fast PDF reader.</p>
      </div>
      <button
        onClick={openWithDialog}
        className="flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 font-medium text-accent-fg transition-opacity hover:opacity-90"
      >
        <IconOpen /> Open a PDF
      </button>
      {showRecents && (
        <div className="w-full max-w-sm">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Recent</h2>
          <div className="flex flex-col gap-1">
            {recents.slice(0, 8).map((r) => (
              <button
                key={r.path}
                onClick={() => openPath(r.path)}
                title={r.path}
                className="truncate rounded px-3 py-2 text-left text-sm text-text hover:bg-surface-2"
              >
                {r.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const { doc, loading, error, openWithDialog, openPath, zoomIn, zoomOut, resetZoom, toggleSearch, nextPage, prevPage } =
    useViewer();
  const { hydrate, layout, toggleSidebar } = useSettings();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Hydrate persisted settings + annotations and open any file the app was launched with.
  useEffect(() => {
    hydrate();
    useAnnotations.getState().hydrate();
    invoke<string | null>("take_launch_file")
      .then((p) => {
        if (p) openPath(p);
      })
      .catch(() => {});
  }, [hydrate, openPath]);

  // Global keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const target = e.target as HTMLElement;
      const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA";

      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (mod && e.key.toLowerCase() === "o") {
        e.preventDefault();
        openWithDialog();
      } else if (mod && e.key.toLowerCase() === "f") {
        e.preventDefault();
        toggleSearch(true);
      } else if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
      } else if (mod && e.key.toLowerCase() === "z") {
        // Let inputs/textareas keep their native text undo; otherwise undo annotations.
        if (typing) return;
        e.preventDefault();
        const { undo, redo } = useAnnotations.getState();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === "y") {
        if (typing) return;
        e.preventDefault();
        useAnnotations.getState().redo();
      } else if (mod && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        zoomIn();
      } else if (mod && e.key === "-") {
        e.preventDefault();
        zoomOut();
      } else if (mod && e.key === "0") {
        e.preventDefault();
        resetZoom();
      } else if (!typing && (e.key === "PageDown" || (e.key === "ArrowRight" && !mod))) {
        if (!layout.continuous) {
          e.preventDefault();
          nextPage();
        }
      } else if (!typing && (e.key === "PageUp" || (e.key === "ArrowLeft" && !mod))) {
        if (!layout.continuous) {
          e.preventDefault();
          prevPage();
        }
      } else if (!typing && !mod && (e.key === "Delete" || e.key === "Backspace")) {
        const { selectedId, remove } = useAnnotations.getState();
        const fp = useViewer.getState().filePath;
        if (selectedId && fp) {
          e.preventDefault();
          remove(fp, selectedId);
        }
      } else if (!typing && !mod) {
        // Single-key tool shortcuts.
        const tools: Record<string, () => void> = {
          v: () => useAnnotations.getState().setTool("select"),
          h: () => useAnnotations.getState().setTool("highlight"),
          t: () => useAnnotations.getState().setTool("text"),
          r: () => useAnnotations.getState().setTool("rect"),
          o: () => useAnnotations.getState().setTool("ellipse"),
          p: () => useAnnotations.getState().setTool("pen"),
          e: () => useAnnotations.getState().setTool("edit"),
          s: () => useAnnotations.getState().setTool("signature"),
          x: () => useAnnotations.getState().setTool("eraser"),
        };
        const fn = tools[e.key.toLowerCase()];
        if (fn) {
          e.preventDefault();
          fn();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openWithDialog, toggleSearch, toggleSidebar, zoomIn, zoomOut, resetZoom, nextPage, prevPage, layout.continuous]);

  const showSidebar = doc && layout.sidebarOpen && !layout.zenMode;
  const showToolbar = !(layout.zenMode && layout.toolbarAutoHide);

  return (
    <div className="flex h-full flex-col bg-bg">
      {showToolbar && <Toolbar onOpenSettings={() => setSettingsOpen(true)} />}
      {doc && !layout.zenMode && (layout.annotationsHidden ? <ShowToolsButton /> : <AnnotationBar />)}

      <div className={`flex min-h-0 flex-1 ${layout.sidebarSide === "right" ? "flex-row-reverse" : ""}`}>
        {showSidebar && <Sidebar />}
        <main className="relative min-w-0 flex-1">
          {error && (
            <div className="absolute left-1/2 top-4 z-30 -translate-x-1/2 rounded-md bg-red-500/90 px-4 py-2 text-sm text-white">
              {error}
            </div>
          )}
          {loading && (
            <div className="absolute inset-0 z-20 flex items-center justify-center text-muted">
              Loading…
            </div>
          )}
          {doc ? <PdfViewer /> : <EmptyState />}
          <SearchBar />
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
      <SignaturePad />
    </div>
  );
}
