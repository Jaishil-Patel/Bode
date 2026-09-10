import { useEffect, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useViewer } from "./store/viewerStore";
import { useSettings } from "./settings/useSettings";
import { useFullscreen } from "./store/fullscreenStore";
import { useAnnotations } from "./annotations/useAnnotations";
import { toolForKey } from "./annotations/tools";
import { useFormValues } from "./forms/useFormValues";
import Toolbar from "./components/Toolbar";
import TabBar from "./components/TabBar";
import AnnotationTools from "./components/AnnotationBar";
import PortalLayer from "./portals/PortalLayer";
import Sidebar from "./components/Sidebar";
import SearchBar from "./components/SearchBar";
import CommandPalette from "./components/CommandPalette";
import SignaturePad from "./components/SignaturePad";
import PasswordPrompt from "./components/PasswordPrompt";
import SettingsPanel from "./settings/SettingsPanel";
import PdfViewer from "./pdf/PdfViewer";
import { getViewport } from "./pdf/viewport";
import MarkdownView from "./markdown/MarkdownView";
import HtmlView from "./html/HtmlView";
import { isAndroid } from "./platform/files";
import { DevicesDrawer, DevicesPanel, StaleBanner } from "./devices/DevicesPanel";
import GlassFilter from "./components/GlassFilter";
import TitleBar from "./components/TitleBar";
import { usePageColorsAttribute } from "./settings/usePageColors";
import { IconOpen, IconZenExit } from "./components/icons";

/** How long the hint, in either form, stays before getting out of the way. */
const HINT_MS = 2400;

/** How far one arrow-key press nudges the page, in CSS pixels. Roughly three lines of body text. */
const ARROW_STEP = 72;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown"]);

/** Browser-style "press Esc to exit" toast, shown briefly each time fullscreen is entered. */
function FullscreenHint() {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setVisible(false), HINT_MS);
    return () => clearTimeout(t);
  }, []);
  if (!visible) return null;
  return (
    <div
      className="no-select animate-fade-in pointer-events-none fixed left-1/2 top-4 z-50 -translate-x-1/2 rounded-full border border-white/15 px-4 py-2 text-sm text-text shadow-2xl backdrop-blur-2xl"
      style={{ background: "color-mix(in srgb, var(--surface) 62%, transparent)" }}
    >
      Press F11 or Esc to exit fullscreen
    </div>
  );
}

/**
 * The way out of fullscreen on a device with no keyboard.
 *
 * Fullscreen hides the toolbar, so on a phone the only exits were F11 and Escape — neither of which
 * exists there. Entering it was a one-way door, and the toast helpfully advised pressing a key the
 * device does not have.
 *
 * The hint and the affordance are the same object on purpose: a toast pointing at a button can drift
 * away from where the button actually is, and this way there is nothing to point at. It opens
 * labelled, then collapses to the icon so that what remains over the page is as small as the job
 * allows.
 */
function FullscreenExitButton() {
  const setFullscreen = useFullscreen((s) => s.setFullscreen);
  const [labelled, setLabelled] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setLabelled(false), HINT_MS);
    return () => clearTimeout(t);
  }, []);

  return (
    <button
      onClick={() => setFullscreen(false)}
      title="Exit fullscreen"
      aria-label="Exit fullscreen"
      // Top-right, above where a top-docked annotation bar starts (safe area + 3.5rem), and clear
      // of every other tools position — which are centred on the bottom or on a side edge.
      className="no-select animate-fade-in fixed right-3 z-50 flex h-11 items-center gap-2 rounded-full border border-white/15 px-3.5 text-sm text-text shadow-2xl ring-1 ring-black/5 backdrop-blur-2xl backdrop-saturate-150 transition-transform active:scale-95"
      style={{
        top: "calc(env(safe-area-inset-top) + 0.75rem)",
        background: "color-mix(in srgb, var(--surface) 62%, transparent)",
      }}
    >
      <IconZenExit />
      {labelled && <span className="whitespace-nowrap">Exit fullscreen</span>}
    </button>
  );
}

function EmptyState() {
  const openWithDialog = useViewer((s) => s.openWithDialog);
  const openPath = useViewer((s) => s.openPath);
  const { recents } = useSettings();
  const [showDevices, setShowDevices] = useState(false);
  // Android hands back content:// URIs whose read permission isn't kept after the app closes, so
  // a stored recent can't be reopened — hide the list there rather than show broken entries.
  const canRecents = !isAndroid();
  const hasRecents = recents.length > 0;

  return (
    /*
     * Scrolls on the outside, centres on the inside.
     *
     * The content is short enough to sit in the middle of the window right up until the devices
     * panel is opened, at which point it is taller than the window — and a centred flex column
     * that overflows spills past BOTH ends, so the bottom of the panel was unreachable. Centring
     * against `min-h-full` keeps the short case looking the same and lets the tall case grow into
     * a scroll instead of off the screen.
     */
    <div className="h-full overflow-y-auto">
      {/*
       * One column on a phone, two from `sm` up.
       *
       * A grid rather than a pair of flex columns, so the DOM order stays exactly the phone order
       * — title, button, recents, devices — and each piece is *placed* into a cell rather than
       * moved. Two flex columns would have meant nesting Devices alongside the button, which on a
       * narrow window would push it above Recent and quietly change the phone layout. Every
       * two-column rule here is `sm:`-prefixed for the same reason.
       */}
      <div
        className={`flex min-h-full flex-col items-center justify-center gap-6 p-8 ${
          canRecents
            ? "sm:mx-auto sm:grid sm:max-w-5xl sm:grid-cols-2 sm:content-center sm:items-start sm:gap-x-16 sm:gap-y-7 sm:p-12 lg:max-w-6xl lg:gap-x-20"
            : ""
        }`}
      >
        <div className="text-center sm:col-start-1 sm:row-start-1 sm:text-left">
          <h1 className="text-3xl font-semibold text-text sm:text-5xl">Bode</h1>
          <p className="mt-1 text-sm text-muted sm:mt-2 sm:text-base">
            A calm, fast reader for PDF, Markdown &amp; HTML.
          </p>
        </div>
        <button
          onClick={openWithDialog}
          className="glass glass-cta open-cta flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 font-medium text-accent-fg transition-opacity hover:opacity-90 sm:col-start-1 sm:row-start-2 sm:justify-self-start sm:gap-3 sm:rounded-xl sm:px-7 sm:py-4 sm:text-base"
        >
          <IconOpen /> Open a document
        </button>

        {/*
         * Always present on desktop, even with nothing in it: an empty right-hand column with a
         * line explaining itself is a better answer than a column that silently is not there.
         * On a phone an empty list still collapses away exactly as it always did.
         */}
        {canRecents && (
          <div
            className={`w-full max-w-sm sm:col-start-2 sm:row-span-3 sm:row-start-1 sm:max-w-none sm:rounded-2xl sm:border sm:border-border sm:bg-surface sm:p-6 ${
              hasRecents ? "" : "hidden sm:block"
            }`}
          >
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted sm:mb-3 sm:text-sm">
              Recent
            </h2>
            {hasRecents ? (
              <div className="flex flex-col gap-1">
                {/* Twelve on desktop, where the column has the room for them; the phone keeps
                    the eight it showed before, since its layout has not changed. */}
                {recents.slice(0, 12).map((r, i) => (
                  <button
                    key={r.path}
                    onClick={() => openPath(r.path)}
                    title={r.path}
                    className={`truncate rounded px-3 py-2 text-left text-sm text-text hover:bg-surface-2 sm:rounded-lg sm:px-3.5 sm:py-2.5 sm:text-base ${
                      i >= 8 ? "hidden sm:block" : ""
                    }`}
                  >
                    {r.name}
                  </button>
                ))}
              </div>
            ) : (
              <p className="px-3 py-2 text-sm text-muted sm:text-base">
                Documents you open will show up here.
              </p>
            )}
          </div>
        )}

        {/* Opening this is what starts Nearby — nothing binds a port or generates a key until then. */}
        <div className="w-full max-w-sm sm:col-start-1 sm:row-start-3 sm:max-w-none">
          {showDevices ? (
            <DevicesPanel />
          ) : (
            <button
              onClick={() => setShowDevices(true)}
              className="w-full rounded px-3 py-2 text-sm text-muted hover:bg-surface-2 hover:text-text sm:w-auto sm:px-3.5 sm:py-2.5 sm:text-base sm:text-left"
            >
              Devices on my network…
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const { doc, textKind, loading, error, openWithDialog, openPath, zoomIn, zoomOut, resetZoom, toggleSearch, nextPage, prevPage } =
    useViewer();
  const { hydrate, layout, toggleSidebar } = useSettings();
  const fullscreen = useFullscreen((s) => s.fullscreen);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);

  // Hydrate persisted settings + annotations and open any file the app was launched with.
  useEffect(() => {
    hydrate();
    useAnnotations.getState().hydrate();
    useFormValues.getState().hydrate();
    // A window spawned for the "separate windows" open mode carries its file in the URL;
    // otherwise ask the backend for any file-association / "Open with" launch path.
    const fileParam = new URLSearchParams(window.location.search).get("file");
    if (fileParam) {
      openPath(decodeURIComponent(fileParam));
    } else if (isAndroid()) {
      // Android "Open with": MainActivity copies the shared PDF into the app cache and gives us
      // the path. Warm starts push it via window.__bodeOpenFile; a cold start pulls the pending
      // path now that the frontend is ready (the bridge is injected by MainActivity).
      const w = window as typeof window & {
        __bodeOpenFile?: (p: string) => void;
        BodeAndroid?: { ready?: () => string | null };
      };
      w.__bodeOpenFile = (p) => openPath(p);
      const launch = w.BodeAndroid?.ready?.();
      if (launch) openPath(launch);
    } else {
      invoke<string | null>("take_launch_file")
        .then((p) => {
          if (p) openPath(p);
        })
        .catch(() => {});
    }

    // A PDF opened from the OS while Bode is already running arrives here: the single-instance
    // plugin routes it to this window via an "open-file" event. openPath handles tabs vs windows.
    // Also how a tab dragged from another Bode window and dropped on this one arrives.
    const unlistenP = listen<string>("open-file", (e) => {
      if (e.payload) openPath(e.payload);
    });
    return () => {
      unlistenP.then((un) => un()).catch(() => {});
    };
  }, [hydrate, openPath]);

  // Global keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const target = e.target as HTMLElement;
      const typing =
        target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";

      // F11 is unambiguous — nothing else wants it — so it toggles fullscreen from anywhere.
      // Pressed inside an HTML frame it never reaches this listener; HtmlView handles that case.
      if (e.key === "F11") {
        e.preventDefault();
        useFullscreen.getState().toggleFullscreen();
        return;
      }
      // Escape unwinds one layer at a time, the way a browser does: anything modal sitting on top
      // of the document claims it first (each of those closes itself), and only a bare view exits
      // fullscreen. Without this, one Escape would close the search AND drop out of fullscreen.
      if (e.key === "Escape" && useFullscreen.getState().fullscreen) {
        const overlayOpen =
          paletteOpen ||
          settingsOpen ||
          devicesOpen ||
          useViewer.getState().search.open ||
          useViewer.getState().passwordPrompt != null ||
          useAnnotations.getState().signaturePadOpen;
        if (!overlayOpen) {
          e.preventDefault();
          useFullscreen.getState().setFullscreen(false);
          return;
        }
      }

      // The drawers are the only overlays that never closed themselves on Escape — the guard above
      // knew about them, so Escape was swallowed and then did nothing at all.
      if (e.key === "Escape" && (devicesOpen || settingsOpen)) {
        e.preventDefault();
        setDevicesOpen(false);
        setSettingsOpen(false);
        return;
      }

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
      } else if (mod && e.key.toLowerCase() === "s") {
        // Save the active text tab — Markdown or HTML (no-op / native default elsewhere).
        if (useViewer.getState().textSource != null) {
          e.preventDefault();
          useViewer.getState().saveText();
        }
      } else if (mod && e.key.toLowerCase() === "e") {
        if (useViewer.getState().textSource != null) {
          e.preventDefault();
          useViewer.getState().toggleTextEdit();
        }
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
      } else if (!typing && !mod && SCROLL_KEYS.has(e.key)) {
        // The scroll container is a plain div, so nothing is focused and the browser scrolls
        // nothing on its own — every one of these keys has to be driven by hand.
        const el = getViewport();
        if (!el) return; // a text view: leave the keys to the browser
        const back = e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "PageUp";
        const dir = back ? -1 : 1;
        const horizontal = e.key === "ArrowLeft" || e.key === "ArrowRight";
        e.preventDefault();
        if (horizontal && el.scrollWidth - el.clientWidth > 1) {
          // Zoomed in past the window: left/right pan across the page, which is the only way
          // to reach the far edge without a mouse.
          el.scrollBy({ left: dir * ARROW_STEP });
        } else if (horizontal) {
          // Nothing to pan to — the whole width is already on screen, so turn the page instead.
          if (back) prevPage();
          else nextPage();
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          el.scrollBy({ top: dir * ARROW_STEP });
        } else if (layout.continuous) {
          el.scrollBy({ top: dir * Math.max(el.clientHeight - ARROW_STEP, 120), behavior: "smooth" });
        } else {
          if (back) prevPage();
          else nextPage();
        }
      } else if (!typing && !mod && (e.key === "Delete" || e.key === "Backspace")) {
        const { selectedId, remove } = useAnnotations.getState();
        const fp = useViewer.getState().filePath;
        if (selectedId && fp) {
          e.preventDefault();
          remove(fp, selectedId);
        }
      } else if (!typing && !mod) {
        // Single-key tool shortcuts, read from the registry so they cannot drift from the bar.
        // They work for every tool, including ones taken off the bar in Settings — a tool being
        // out of sight is a statement about the bar, not about the keyboard.
        const t = toolForKey(e.key);
        if (t) {
          e.preventDefault();
          useAnnotations.getState().setTool(t.id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    openWithDialog,
    toggleSearch,
    toggleSidebar,
    zoomIn,
    zoomOut,
    resetZoom,
    nextPage,
    prevPage,
    layout.continuous,
    paletteOpen,
    settingsOpen,
    devicesOpen,
  ]);

  // The window is created with zoomHotkeysEnabled so WebView2 forwards trackpad pinches to the
  // page at all (it suppresses them otherwise). The flip side is that an unhandled pinch would
  // scale the entire UI, chrome included, so cancel the browser's own zoom app-wide here. This
  // runs in the capture phase and only prevents the default — the viewer's own bubble-phase
  // handler still receives the event and turns it into a PDF zoom.
  useEffect(() => {
    const kill = (e: Event) => e.preventDefault();
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    };
    const opts = { capture: true, passive: false } as const;
    window.addEventListener("wheel", onWheel, opts);
    window.addEventListener("gesturestart", kill, opts);
    window.addEventListener("gesturechange", kill, opts);
    window.addEventListener("gestureend", kill, opts);
    return () => {
      window.removeEventListener("wheel", onWheel, opts);
      window.removeEventListener("gesturestart", kill, opts);
      window.removeEventListener("gesturechange", kill, opts);
      window.removeEventListener("gestureend", kill, opts);
    };
  }, []);

  // Glass restyles itself when the pages go dark; this is what tells it they have.
  usePageColorsAttribute();

  const showSidebar = doc && layout.sidebarOpen && !fullscreen;

  return (
    /* --caption-h keeps the modal overlays clear of our caption; see `.below-caption`. */
    <div
      className="flex h-full flex-col bg-bg"
      style={{ "--caption-h": fullscreen ? "0px" : "2rem" } as CSSProperties}
    >
      {/* A filter definition only, drawing nothing. The Glass theme's chrome refracts through it. */}
      <GlassFilter />
      {/* Fullscreen drops the window chrome so only the document is left. */}
      {!fullscreen && (
        <>
          {/*
            * One pane, holding the caption and the toolbar.
            *
            * The window is undecorated, so the caption is ours — and being inside `bg-bg` is what
            * lets the ground run through it and the toolbar without a join. But two `.glass`
            * children would not have been enough: a backdrop-filter can only sample within its own
            * element, so each would clamp its blur at the shared edge and the mismatch would read
            * as a line, with each element's own cast shadow bleeding across it for good measure.
            * The frost, the fill and the border live here instead, once, over both.
            */}
          <div className="glass glass-flat relative z-40 shrink-0 border-b border-border bg-surface">
            <TitleBar />
            <Toolbar
              onOpenSettings={() => setSettingsOpen(true)}
              onOpenDevices={() => setDevicesOpen(true)}
              devicesOpen={devicesOpen}
            />
          </div>
          <TabBar />
          {/* Only ever visible for a document kept offline whose owner has newer bytes. */}
          <StaleBanner />
        </>
      )}
      {/* The annotation tools stay: they already float over the page and collapse to a single pill,
          so they're not the kind of chrome fullscreen is meant to clear away. */}
      {doc && <AnnotationTools />}
      {/* Pinned regions. Outside the viewer on purpose: a portal is anchored to the window, so
          scrolling the document — or scrolling its own page out of the render window — must
          neither move it nor take it away. */}
      {doc && <PortalLayer />}
      {/* A phone has no F11 and no Escape, so it gets a button instead of advice about keys. */}
      {fullscreen && (isAndroid() ? <FullscreenExitButton /> : <FullscreenHint />)}

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
          {doc ? (
            <PdfViewer />
          ) : textKind === "html" ? (
            <HtmlView />
          ) : textKind === "md" ? (
            <MarkdownView />
          ) : (
            <EmptyState />
          )}
          <SearchBar />
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenDevices={() => setDevicesOpen(true)}
      />
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
      {devicesOpen && <DevicesDrawer onClose={() => setDevicesOpen(false)} />}
      <SignaturePad />
      <PasswordPrompt />
    </div>
  );
}
