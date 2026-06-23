import { useViewer } from "../store/viewerStore";
import { IconClose } from "./icons";

/**
 * Strip of open-document tabs, shown only when more than one PDF is open in this window
 * (the "tabs" open mode). Click to switch, middle-click or the × to close.
 */
export default function TabBar() {
  const tabs = useViewer((s) => s.tabs);
  const activeTabId = useViewer((s) => s.activeTabId);
  const switchTab = useViewer((s) => s.switchTab);
  const closeTab = useViewer((s) => s.closeTab);

  if (tabs.length < 2) return null;

  return (
    <div className="no-select flex shrink-0 items-stretch gap-1 overflow-x-auto border-b border-border bg-surface px-2 py-1">
      {tabs.map((t) => {
        const active = t.id === activeTabId;
        return (
          <div
            key={t.id}
            onClick={() => switchTab(t.id)}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                closeTab(t.id);
              }
            }}
            title={t.filePath}
            className={`group flex max-w-[200px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
              active ? "bg-surface-2 text-text" : "text-muted hover:bg-surface-2/60"
            }`}
          >
            <span className="truncate">{t.fileName}</span>
            <button
              title="Close tab"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.id);
              }}
              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded transition-opacity hover:bg-border ${
                active ? "opacity-70" : "opacity-0 group-hover:opacity-70"
              }`}
            >
              <IconClose className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
