import { useEffect, useMemo, useRef, useState } from "react";
import { useViewer } from "../store/viewerStore";
import { useSettings } from "../settings/useSettings";
import { BUILT_IN_THEMES } from "../settings/themes";

interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

export default function CommandPalette({
  open,
  onClose,
  onOpenSettings,
}: {
  open: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  const viewer = useViewer();
  const settings = useSettings();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useMemo<Command[]>(() => {
    const cmds: Command[] = [
      { id: "open", label: "Open PDF…", hint: "Ctrl+O", run: () => viewer.openWithDialog() },
      { id: "search", label: "Find in document", hint: "Ctrl+F", run: () => viewer.toggleSearch(true) },
      { id: "sidebar", label: "Toggle sidebar", hint: "Ctrl+B", run: settings.toggleSidebar },
      { id: "zen", label: "Toggle zen mode", run: settings.toggleZen },
      { id: "fitw", label: "Fit width", run: () => viewer.setFitMode("width") },
      { id: "fitp", label: "Fit page", run: () => viewer.setFitMode("page") },
      { id: "zoomin", label: "Zoom in", run: viewer.zoomIn },
      { id: "zoomout", label: "Zoom out", run: viewer.zoomOut },
      {
        id: "continuous",
        label: settings.layout.continuous ? "Switch to single-page view" : "Switch to continuous view",
        run: () => settings.updateLayout({ continuous: !settings.layout.continuous }),
      },
      { id: "settings", label: "Open settings", run: onOpenSettings },
    ];
    for (const t of BUILT_IN_THEMES) {
      cmds.push({ id: `theme-${t.name}`, label: `Theme: ${t.label}`, run: () => settings.setTheme(t.name) });
    }
    return cmds;
  }, [viewer, settings, onOpenSettings]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(q));
  }, [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);
  useEffect(() => setActive(0), [query]);

  if (!open) return null;

  const choose = (cmd?: Command) => {
    if (!cmd) return;
    onClose();
    cmd.run();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[15vh]"
      onClick={onClose}
    >
      <div
        className="w-[520px] max-w-[90vw] overflow-hidden rounded-xl border border-border bg-surface shadow-2xl animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              choose(filtered[active]);
            } else if (e.key === "Escape") {
              onClose();
            }
          }}
          placeholder="Type a command…"
          className="w-full border-b border-border bg-transparent px-4 py-3 text-text outline-none"
        />
        <div className="max-h-80 overflow-auto py-1">
          {filtered.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-muted">No commands.</p>
          )}
          {filtered.map((c, i) => (
            <button
              key={c.id}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(c)}
              className={`flex w-full items-center justify-between px-4 py-2 text-left text-sm ${
                i === active ? "bg-accent text-accent-fg" : "text-text"
              }`}
            >
              <span>{c.label}</span>
              {c.hint && (
                <span className={i === active ? "text-accent-fg/80" : "text-muted"}>{c.hint}</span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
