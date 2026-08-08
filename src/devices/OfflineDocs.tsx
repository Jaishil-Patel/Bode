import { useEffect } from "react";
import { useDevices, formatSize } from "./useDevices";
import { useViewer } from "../store/viewerStore";
import { Section, Hint, IconButton } from "./ui";
import { IconStar, IconStarFilled, IconTrash, IconFile } from "../components/icons";

/*
 * Documents held on this device, and the star that decides whether the OS may reclaim them.
 *
 * The distinction is real and load-bearing on Android: unstarred copies live in the cache directory,
 * which the system empties under storage pressure, and starred ones live in app data, which it does
 * not. A "keep offline" file sitting in the reclaimable half would be a lie, so pinning physically
 * moves the bytes between the two roots.
 */

/** Must match `TRANSIENT_LIMIT_BYTES` in `peer/cache.rs` — the point at which Bode evicts. */
const TRANSIENT_LIMIT_BYTES = 512 * 1024 * 1024;

export function OfflineDocs() {
  const { cached, refreshCache, setPinned, forget } = useDevices();
  const openPath = useViewer((s) => s.openPath);

  useEffect(() => {
    void refreshCache();
  }, [refreshCache]);

  if (cached.length === 0) return null;

  const kept = cached.filter((c) => c.pinned);
  const transient = cached.filter((c) => !c.pinned).reduce((sum, c) => sum + c.size, 0);
  const total = cached.reduce((sum, c) => sum + c.size, 0);
  const fraction = Math.min(1, transient / TRANSIENT_LIMIT_BYTES);

  return (
    <Section title="Kept here" trailing={formatSize(total)}>
      <div className="flex flex-col">
        {cached.map((doc) => (
          <div key={doc.docId} className="flex items-center gap-1">
            <button
              onClick={() => void openPath(doc.docId)}
              className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-surface-2"
            >
              <IconFile className="h-4 w-4 shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate text-text">{doc.name}</span>
              <span className="shrink-0 text-xs tabular-nums text-muted">
                {formatSize(doc.size)}
              </span>
            </button>
            <IconButton
              active={doc.pinned}
              onClick={() => void setPinned(doc.docId, !doc.pinned)}
              title={
                doc.pinned
                  ? "Kept until you remove it"
                  : "Cached — may be cleared automatically. Tap to keep."
              }
            >
              {doc.pinned ? <IconStarFilled className="h-4 w-4" /> : <IconStar className="h-4 w-4" />}
            </IconButton>
            <IconButton onClick={() => void forget(doc.docId)} title="Remove from this device">
              <IconTrash className="h-4 w-4" />
            </IconButton>
          </div>
        ))}
      </div>

      {/* The starred half has no ceiling; only the cache does. Showing the budget makes "Bode
          cleared my file" a predictable event rather than a mystery. */}
      {transient > 0 && (
        <div className="mt-1 flex flex-col gap-1">
          <div className="h-1 overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full bg-muted transition-[width] duration-300"
              style={{ width: `${Math.max(2, fraction * 100)}%` }}
            />
          </div>
          <Hint>
            {formatSize(transient)} of {formatSize(TRANSIENT_LIMIT_BYTES)} cache used.{" "}
            {kept.length > 0 &&
              `${kept.length} starred document${kept.length === 1 ? "" : "s"} kept separately, and never cleared.`}
          </Hint>
        </div>
      )}
    </Section>
  );
}
