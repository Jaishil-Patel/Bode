import { useDevices, formatSize, formatRate, formatRemaining } from "./useDevices";
import { ProgressBar, IconButton } from "./ui";
import { IconClose } from "../components/icons";

/*
 * Transfers in flight.
 *
 * Rendered as a strip directly under the drawer header rather than inside whichever sub-view
 * happens to be open. A transfer outlives the screen that started it — you tap a document in the
 * browser and immediately go back to the device list — and progress that disappears when you
 * navigate is indistinguishable from progress that stopped.
 *
 * Chunking is what makes both the progress and the cancel possible at all; without it the only
 * honest UI would be a spinner, and over Wi-Fi a spinner on a 200 MB PDF reads as a hang.
 */

function Row({ transferKey }: { transferKey: string }) {
  const transfer = useDevices((s) => s.transfers[transferKey]);
  const cancel = useDevices((s) => s.cancel);
  if (!transfer) return null;

  const { received, total, rate, direction, label } = transfer;
  const done = total > 0 && received >= total;
  const fraction = total > 0 ? received / total : 0;

  // Rate and time remaining are dropped rather than shown as zero until two samples have arrived,
  // so the line does not begin life reading "0 B/s".
  const detail = [
    total > 0 ? `${formatSize(received)} of ${formatSize(total)}` : formatSize(received),
    done ? "" : formatRate(rate),
    done ? "" : formatRemaining(total - received, rate),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-text">
          <span className="text-muted">{direction === "upload" ? "Sending" : "Getting"} </span>
          {label}
        </span>
        {!done && (
          <IconButton onClick={() => void cancel(transferKey)} title="Cancel this transfer">
            <IconClose className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </div>
      <ProgressBar fraction={fraction} done={done} />
      <div className="text-[11px] tabular-nums text-muted">{done ? "Done" : detail}</div>
    </div>
  );
}

/** Every transfer currently running. Renders nothing when there are none. */
export function Transfers({ className = "" }: { className?: string }) {
  // Select the map, derive the keys here. A selector returning a fresh array on every call breaks
  // the snapshot caching `useSyncExternalStore` relies on.
  const transfers = useDevices((s) => s.transfers);
  const keys = Object.keys(transfers);
  if (keys.length === 0) return null;

  return (
    <div
      className={`animate-fade-in flex flex-col gap-3 rounded-lg border border-border bg-surface-2/50 p-3 ${className}`}
    >
      {keys.map((key) => (
        <Row key={key} transferKey={key} />
      ))}
    </div>
  );
}
