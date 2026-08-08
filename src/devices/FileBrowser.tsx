import { useEffect } from "react";
import { useDevices, docIdFor, formatSize, type RemoteEntry } from "./useDevices";
import { useViewer } from "../store/viewerStore";
import { Hint, IconButton } from "./ui";
import {
  IconChevronRight,
  IconFolder,
  IconFile,
  IconStar,
  IconStarFilled,
} from "../components/icons";

/*
 * Browsing one device's shared folder.
 *
 * This is the half of the panel that moves FILES, as opposed to the sync button, which moves
 * highlights and reading positions. The two were routinely confused, so the entry point is now a
 * labelled button on a device card and this view announces which device it belongs to at the top.
 */

/** Clickable path segments. `rel` for each is the prefix up to and including it. */
function Breadcrumb({
  deviceName,
  path,
  onNavigate,
}: {
  deviceName: string;
  path: string;
  onNavigate: (rel: string) => void;
}) {
  const segments = path ? path.split("/") : [];
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-0.5 text-xs">
      <button
        onClick={() => onNavigate("")}
        className={`max-w-[9rem] truncate rounded px-1 py-0.5 transition-colors hover:bg-surface-2 ${
          segments.length === 0 ? "text-text" : "text-muted hover:text-text"
        }`}
      >
        {deviceName}
      </button>
      {segments.map((segment, i) => {
        const rel = segments.slice(0, i + 1).join("/");
        const last = i === segments.length - 1;
        return (
          <span key={rel} className="flex min-w-0 items-center gap-0.5">
            <IconChevronRight className="h-3 w-3 shrink-0 text-muted opacity-60" />
            <button
              onClick={() => onNavigate(rel)}
              className={`max-w-[9rem] truncate rounded px-1 py-0.5 transition-colors hover:bg-surface-2 ${
                last ? "text-text" : "text-muted hover:text-text"
              }`}
            >
              {segment}
            </button>
          </span>
        );
      })}
    </div>
  );
}

function Entry({
  entry,
  deviceId,
  deviceName,
  pinned,
}: {
  entry: RemoteEntry;
  deviceId: string;
  deviceName: string;
  pinned: boolean;
}) {
  const { browse, setPinned, transfers } = useDevices();
  const openPath = useViewer((s) => s.openPath);
  const docId = docIdFor(deviceId, entry.rel);
  const inFlight = Boolean(transfers[docId]);

  return (
    <div className="group flex items-center gap-1">
      <button
        onClick={() =>
          entry.kind === "dir" ? void browse(deviceId, deviceName, entry.rel) : void openPath(docId)
        }
        className={`flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-surface-2 ${
          inFlight ? "opacity-50" : ""
        }`}
      >
        <span className="shrink-0 text-muted">
          {entry.kind === "dir" ? <IconFolder className="h-4 w-4" /> : <IconFile className="h-4 w-4" />}
        </span>
        <span className="min-w-0 flex-1 truncate text-text">{entry.name}</span>
        {entry.kind === "file" ? (
          <span className="shrink-0 text-xs tabular-nums text-muted">{formatSize(entry.size)}</span>
        ) : (
          <IconChevronRight className="h-3.5 w-3.5 shrink-0 text-muted opacity-60" />
        )}
      </button>
      {entry.kind === "file" && (
        <IconButton
          active={pinned}
          onClick={() => void setPinned(docId, !pinned)}
          title={
            pinned
              ? "Kept on this device — tap to stop keeping it"
              : "Keep on this device, so it opens without the other one"
          }
        >
          {pinned ? <IconStarFilled className="h-4 w-4" /> : <IconStar className="h-4 w-4" />}
        </IconButton>
      )}
    </div>
  );
}

export function FileBrowser() {
  const { browsing, entries, skipped, loadingEntries, browse, closeBrowser, error, cached, refreshCache } =
    useDevices();

  useEffect(() => {
    void refreshCache();
  }, [refreshCache]);

  if (!browsing) return null;

  const pinnedRels = new Set(
    cached.filter((c) => c.pinned && c.deviceId === browsing.deviceId).map((c) => c.rel),
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <IconButton onClick={closeBrowser} title="Back to devices">
          <IconChevronRight className="h-4 w-4 rotate-180" />
        </IconButton>
        <Breadcrumb
          deviceName={browsing.name}
          path={browsing.path}
          onNavigate={(rel) => void browse(browsing.deviceId, browsing.name, rel)}
        />
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}
      {loadingEntries && <p className="px-2 py-6 text-center text-sm text-muted">Loading…</p>}

      {!loadingEntries && !error && (
        <div className="flex flex-col">
          {entries.map((entry) => (
            <Entry
              key={entry.rel}
              entry={entry}
              deviceId={browsing.deviceId}
              deviceName={browsing.name}
              pinned={pinnedRels.has(entry.rel)}
            />
          ))}
        </div>
      )}

      {/* An empty folder and a folder full of files Bode can't open look identical from here, and
          one of those is a broken setup while the other is working correctly. Say which. */}
      {!loadingEntries && !error && entries.length === 0 && (
        <p className="px-2 py-6 text-center text-sm text-muted">
          {skipped > 0 ? "Nothing here Bode can open." : "This folder is empty."}
        </p>
      )}

      {/* Also worth saying when the folder isn't empty, so a short list doesn't look like a bug. */}
      {!loadingEntries && !error && skipped > 0 && (
        <div className="border-t border-border pt-2">
          <Hint>
            {skipped} other file{skipped === 1 ? "" : "s"} hidden — only PDF, Markdown and HTML are
            shared.
          </Hint>
        </div>
      )}
    </div>
  );
}
