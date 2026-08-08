import { useEffect, useRef, useState } from "react";
import { useViewer } from "../store/viewerStore";
import { useSettings } from "../settings/useSettings";
import { useAnnotations } from "../annotations/useAnnotations";
import { useFullscreen } from "../store/fullscreenStore";
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
  IconDevices,
  IconSettings,
  IconPen,
  IconPages,
  IconZen,
  IconMore,
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

/**
 * One toolbar action, defined once and rendered two ways.
 *
 * On a wide screen these sit on the bar; on a phone they move into the ⋯ menu. Describing them as
 * data rather than as JSX is what keeps the two renderings from drifting — a button that existed in
 * only one of them would be missing on exactly one class of device, which is the bug this is fixing.
 */
type Action = {
  id: string;
  /** Tooltip on the bar. */
  title: string;
  /** Written out in the menu, where there is room and no hover to reveal a tooltip. */
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  active?: boolean;
};

/**
 * The actions that don't fit on a phone.
 *
 * With a PDF open the bar wants about 400px of buttons against a 360px screen, so the four furthest
 * right — Save included — were rendered past the edge and could not be reached at all. Below the
 * `sm` breakpoint they live here instead. The breakpoint is the same one the zoom controls already
 * use, so a phone in landscape gets the full bar back.
 */
function OverflowMenu({ actions }: { actions: Action[] }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // `mousedown`/`touchstart` rather than `click`: closing on the press means a tap outside the
    // menu also lands on whatever is underneath, instead of being spent dismissing.
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (actions.length === 0) return null;

  return (
    <div ref={wrap} className="relative shrink-0">
      <Btn title="More actions" onClick={() => setOpen((o) => !o)} active={open}>
        <IconMore />
      </Btn>
      {open && (
        <div className="animate-fade-in absolute right-0 top-full z-50 mt-1 min-w-[11rem] overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-2xl">
          {actions.map((action) => (
            <button
              key={action.id}
              onClick={() => {
                setOpen(false);
                action.onClick();
              }}
              className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors hover:bg-surface-2 ${
                action.active ? "text-accent" : "text-text"
              }`}
            >
              <span className="shrink-0">{action.icon}</span>
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Toolbar({
  onOpenSettings,
  onOpenDevices,
  devicesOpen,
}: {
  onOpenSettings: () => void;
  onOpenDevices: () => void;
  /** So the button reads as pressed while the drawer is open, like every other toggle here. */
  devicesOpen?: boolean;
}) {
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
  const toggleFullscreen = useFullscreen((s) => s.toggleFullscreen);
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

  // Secondary by design: none of these is something you reach for mid-sentence, which is what makes
  // them the ones to move off a phone's bar. Undo, Redo, Find and Save stay put — there is no other
  // undo anywhere in the app, so burying it would cost two taps per stroke while drawing.
  const secondary: Action[] = [
    doc && {
      id: "organize",
      title: "Organize pages (remove & reorder)",
      label: "Organize pages",
      icon: <IconPages />,
      active: organizeOpen,
      onClick: () => {
        const next = !organizeOpen;
        setOrganizeOpen(next);
        if (next && !layout.sidebarOpen) toggleSidebar(); // the organizer lives in the sidebar
      },
    },
    (doc || isText) && {
      id: "fullscreen",
      title: "Fullscreen (F11)",
      label: "Fullscreen",
      icon: <IconZen />,
      onClick: toggleFullscreen,
    },
    {
      id: "devices",
      title: "Devices on my network",
      label: "Devices",
      icon: <IconDevices />,
      active: devicesOpen,
      onClick: onOpenDevices,
    },
    {
      id: "settings",
      title: "Settings",
      label: "Settings",
      icon: <IconSettings />,
      onClick: onOpenSettings,
    },
  ].filter(Boolean) as Action[];

  return (
    <div
      className="no-select flex min-h-12 items-center gap-0.5 border-b border-border bg-surface px-2 sm:gap-1"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      {/* The sidebar (thumbnails/outline) only applies to PDFs, so hide its toggle for text tabs. */}
      {!isText && (
        <>
          <Btn title="Toggle sidebar (Ctrl+B)" onClick={toggleSidebar} active={layout.sidebarOpen}>
            <IconSidebar />
          </Btn>
          {/* Dividers are grouping, not function. On a phone every pixel one costs is a pixel a
              button doesn't have, so they only appear once there is room for them. */}
          <div className="mx-1 hidden h-6 w-px bg-border sm:block" />
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

      {/* Below `sm` the name is hidden, so this is pure spacing — and padding on a spacer is width
          taken from the buttons for nothing. */}
      <div className="min-w-0 flex-1 truncate text-center text-sm text-muted sm:px-3">
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
          <div className="mx-1 hidden h-6 w-px bg-border sm:block" />
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
          <div className="mx-1 hidden h-6 w-px bg-border sm:block" />
        </>
      )}
      {doc && (
        <Btn title="Find (Ctrl+F)" onClick={() => toggleSearch()} active={search.open}>
          <IconSearch />
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

      {/* The same actions, twice: on the bar where there is room, behind ⋯ where there isn't. */}
      <div className="hidden items-center gap-1 sm:flex">
        {secondary.map((action) => (
          <Btn key={action.id} title={action.title} onClick={action.onClick} active={action.active}>
            {action.icon}
          </Btn>
        ))}
      </div>
      <div className="sm:hidden">
        <OverflowMenu actions={secondary} />
      </div>
    </div>
  );
}
