/*
 * Ctrl+Tab: back to the tab you were last on, the way Alt+Tab goes back to the last window.
 *
 * A quick Ctrl+Tab flips between the two most recent tabs. Holding Ctrl and pressing Tab again
 * walks further back through the tabs in the order they were last used, with a list up so you can
 * see where you will land; letting go of Ctrl goes there. Shift walks the other way and Escape
 * calls it off. The order is by use, not by the strip — the tab you want is almost always one you
 * were just in, wherever it happens to sit.
 *
 * Alt+Tab itself cannot be used: Windows takes it for switching windows before any app sees it.
 */
import { useEffect, useRef, useState } from "react";
import { useViewer } from "../store/viewerStore";
import { stepIndex, switchOrder, touch } from "../store/tabHistory";

/** Every tab this window has shown, most recently shown first. */
let history: string[] = [];
{
  const first = useViewer.getState().activeTabId;
  if (first) history = [first];
  useViewer.subscribe((s, prev) => {
    if (s.activeTabId && s.activeTabId !== prev.activeTabId) history = touch(history, s.activeTabId);
  });
}

/** How long Ctrl+Tab has to be held before the list appears — a quick flip should not flash it. */
const SHOW_AFTER_MS = 180;

interface Cycle {
  order: string[];
  index: number;
  shown: boolean;
}

const KIND_LABEL: Record<string, string> = { pdf: "PDF", md: "Markdown", html: "HTML" };

export default function TabSwitcher() {
  const tabs = useViewer((s) => s.tabs);
  const activeTabId = useViewer((s) => s.activeTabId);
  const [cycle, setCycleState] = useState<Cycle | null>(null);
  const cycleRef = useRef<Cycle | null>(null);
  const setCycle = (c: Cycle | null) => {
    cycleRef.current = c;
    setCycleState(c);
  };

  useEffect(() => {
    let showTimer: number | undefined;
    const end = (go: boolean) => {
      const c = cycleRef.current;
      window.clearTimeout(showTimer);
      if (!c) return;
      setCycle(null);
      const id = c.order[c.index];
      if (go && id) useViewer.getState().switchTab(id);
    };

    // Capture phase, so this runs before App's own shortcuts and before Tab moves the focus.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Tab" && e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        const { tabs, activeTabId } = useViewer.getState();
        if (tabs.length < 2) return;
        const dir = e.shiftKey ? -1 : 1;
        const c = cycleRef.current;
        if (c) {
          setCycle({ ...c, index: stepIndex(c.index, dir, c.order.length), shown: true });
          return;
        }
        // The tab on screen is always first, however it became the active one.
        const order = switchOrder(history, tabs.map((t) => t.id));
        if (activeTabId) order.splice(0, order.length, activeTabId, ...order.filter((id) => id !== activeTabId));
        setCycle({ order, index: stepIndex(0, dir, order.length), shown: false });
        showTimer = window.setTimeout(() => {
          const now = cycleRef.current;
          if (now) setCycle({ ...now, shown: true });
        }, SHOW_AFTER_MS);
      } else if (e.key === "Escape" && cycleRef.current) {
        e.preventDefault();
        e.stopPropagation();
        end(false);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Control") end(true);
    };
    // Focus leaving the window mid-switch means the Ctrl release will never arrive here.
    const onBlur = () => end(true);

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.clearTimeout(showTimer);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  if (!cycle?.shown) return null;
  const byId = new Map(tabs.map((t) => [t.id, t]));

  return (
    <div
      className="glass animate-fade-in fixed left-1/2 z-50 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-2xl"
      style={{ top: "calc(var(--caption-h, 0px) + 72px)" }}
      role="listbox"
      aria-label="Switch tab"
    >
      {cycle.order.map((id, i) => {
        const t = byId.get(id);
        if (!t) return null;
        const selected = i === cycle.index;
        return (
          <div
            key={id}
            role="option"
            aria-selected={selected}
            // Pointer as well as keys: hovering picks, clicking goes.
            onMouseEnter={() => setCycle({ ...cycle, index: i })}
            onMouseDown={(e) => {
              e.preventDefault();
              setCycle(null);
              useViewer.getState().switchTab(id);
            }}
            className={`flex cursor-pointer items-center gap-3 border-l-2 px-3 py-2 text-sm ${
              selected ? "border-accent bg-surface-2 text-text" : "border-transparent text-muted"
            }`}
          >
            <span className="min-w-0 flex-1 truncate">{t.fileName}</span>
            <span className="shrink-0 text-xs text-muted">
              {id === activeTabId ? "current" : (KIND_LABEL[t.kind] ?? "")}
            </span>
          </div>
        );
      })}
    </div>
  );
}
