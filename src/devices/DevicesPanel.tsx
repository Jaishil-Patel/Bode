import { useEffect, useState } from "react";
import { useDevices, type DiscoveredDevice } from "./useDevices";
import { useViewer } from "../store/viewerStore";
import { isAndroid } from "../platform/files";
import { isRemote } from "../platform/docId";
import { IconClose, IconLaptop, IconPhone, IconPlus, IconFolder } from "../components/icons";
import { Section, Hint, Button, Card, StatusDot } from "./ui";
import { Transfers } from "./Transfers";
import { DeviceCard } from "./DeviceCard";
import { PairingFlow } from "./PairingFlow";
import { FileBrowser } from "./FileBrowser";
import { OfflineDocs } from "./OfflineDocs";
import { FirstRun } from "./FirstRun";

/*
 * The Devices panel.
 *
 * Two roles, deliberately asymmetric: a desktop shares a folder and stays reachable, a phone browses
 * it. The phone does not serve a folder of its own, which is what keeps this clear of Android's
 * background-execution limits — a listening socket there dies as soon as the app leaves the
 * foreground, so a "share from your phone" button would work only while you were staring at it.
 *
 * Documents still travel both ways: instead of serving, the phone PUSHES the document it has open
 * to the desktop's inbox. Same result, no background socket. Reading state (annotations, page
 * positions) syncs symmetrically, because that is a request-response exchange either side can start.
 *
 * The panel answers two questions in order — "what are my devices?", then "what's on them?" — so
 * the device list comes first and everything that is not a device sits below it. This assembles the
 * pieces; each one lives in its own file beside this.
 */

export { Transfers } from "./Transfers";

/**
 * The panel as a drawer, for when a document is open.
 *
 * The inline version in `EmptyState` is not enough on its own: half of what this panel does — send
 * the document you're reading, star it for offline, sync its annotations — is only meaningful WITH
 * a document open, which is exactly when the empty state isn't on screen.
 */
export function DevicesDrawer({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40" onClick={onClose}>
      <div
        className="flex h-full w-[380px] max-w-[92vw] flex-col bg-surface shadow-2xl animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-lg font-semibold text-text">Devices</h2>
          <button onClick={onClose} className="rounded p-1 text-muted hover:bg-surface-2">
            <IconClose />
          </button>
        </div>
        {/* Transfers sit above the scroll area on purpose: one outlives whichever sub-view started
            it, and progress that scrolls away is indistinguishable from progress that stopped. */}
        <TransferStrip />
        <div className="flex-1 overflow-auto p-5">
          <DevicesPanel />
        </div>
      </div>
    </div>
  );
}

function TransferStrip() {
  const transfers = useDevices((s) => s.transfers);
  if (Object.keys(transfers).length === 0) return null;
  return (
    <div className="border-b border-border px-5 py-3">
      <Transfers />
    </div>
  );
}

/**
 * Shown over a remote document when the owning device has newer bytes than the copy being read.
 *
 * Only ever appears for a document kept offline. An unpinned copy is simply replaced — there are no
 * annotations riding on it that a silent swap could displace. A pinned one is asked about, because
 * replacing the bytes under an annotation set moves every highlight on the page.
 */
export function StaleBanner() {
  const filePath = useViewer((s) => s.filePath);
  const reloadActive = useViewer((s) => s.reloadActive);
  const note = useDevices((s) => (filePath ? s.fetches[filePath] : undefined));
  const refetch = useDevices((s) => s.refetch);
  const [updating, setUpdating] = useState(false);

  if (!filePath || !isRemote(filePath) || !note) return null;

  // Reading a copy of a document whose device is not reachable. Worth saying, because it explains
  // why an edit made on the other device is not showing up here.
  if (note.offline) {
    return (
      <div className="border-b border-border bg-surface-2 px-4 py-2 text-xs text-muted">
        Reading the copy saved on this device — the device it came from isn't reachable right now.
      </div>
    );
  }

  if (!note.stale) return null;

  return (
    <div className="flex items-center gap-3 border-b border-border bg-surface-2 px-4 py-2 text-xs text-text">
      <span className="flex-1">
        There's a newer version of this document on the other device. Your annotations stay where
        they are, but they may not line up if the pages have changed.
      </span>
      <button
        disabled={updating}
        onClick={async () => {
          setUpdating(true);
          try {
            await refetch(filePath);
            await reloadActive();
          } finally {
            setUpdating(false);
          }
        }}
        className="shrink-0 rounded-md bg-accent px-3 py-1 font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40"
      >
        {updating ? "Updating…" : "Update"}
      </button>
    </div>
  );
}

/** A device seen on the network that hasn't been paired yet. */
function StrangerCard({ device, index }: { device: DiscoveredDevice; index: number }) {
  const beginJoining = useDevices((s) => s.beginJoining);
  const Glyph = device.platform === "mobile" ? IconPhone : IconLaptop;

  // A button styled as a card rather than a card containing a button: the whole row is the target,
  // and `<button>` may only hold phrasing content, so the card's own `<div>` cannot go inside one.
  return (
    <button
      onClick={() => beginJoining(device)}
      style={{ "--i": index } as React.CSSProperties}
      className="animate-rise flex items-center gap-3 rounded-xl border border-border bg-surface-2/40 p-3 text-left transition-colors hover:border-accent/50"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-muted">
        <Glyph />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-text">{device.name}</span>
        <span className="block truncate text-xs text-muted">{device.addr}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg">
        <IconPlus className="h-3.5 w-3.5" /> Pair
      </span>
    </button>
  );
}

/**
 * What this device is exposing.
 *
 * The single most consequential fact in the panel — it is the folder other machines can read — so it
 * gets its own bordered, tinted block rather than a line of muted text. The full path is spelled out
 * rather than hidden in a `title`: "Papers" alone does not distinguish `Documents\Papers` from
 * `Downloads\Papers`, and there is no hover on a phone to reveal the difference.
 *
 * The off state is given equal weight for the same reason. "Nothing is shared" is a fact worth being
 * able to confirm at a glance, not an absence to be inferred from a missing row.
 */
function SharedFolder() {
  const { status, setInbox } = useDevices();
  if (!status) return null;

  if (!status.sharing) {
    return (
      <div className="rounded-lg border border-dashed border-border p-3">
        <p className="text-sm text-muted">No folder shared</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted">
          Your documents aren't visible to any device.
        </p>
      </div>
    );
  }

  const folder = status.shareRoot?.split(/[\\/]/).filter(Boolean).pop();

  return (
    <div className="rounded-lg border border-accent/40 bg-accent/5 p-3">
      <div className="flex items-start gap-2.5">
        <IconFolder className="mt-px h-4 w-4 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-sm font-medium text-text">{folder}</span>
            <span className="flex shrink-0 items-center gap-1.5 text-xs text-text">
              <StatusDot presence="ready" /> Shared
            </span>
          </div>
          {/* Wrapped rather than truncated: cutting the right-hand end removes the parent folders,
              which are the only part that tells two same-named folders apart. */}
          <p className="mt-0.5 break-all text-[11px] leading-snug text-muted line-clamp-2">
            {status.shareRoot}
          </p>
        </div>
      </div>
      {status.inbox && (
        <p className="mt-2 border-t border-accent/20 pt-2 text-xs leading-relaxed text-muted">
          Documents sent here land in{" "}
          <b className="font-medium text-text">{status.inbox.split(/[\\/]/).pop()}</b> inside it.{" "}
          <button onClick={() => void setInbox()} className="underline hover:text-text">
            Change…
          </button>
        </p>
      )}
    </div>
  );
}

/** This device: its name, and the folder it offers — sharing is desktop only. */
function ThisDevice() {
  const { status, startSharing, stopSharing, beginHosting } = useDevices();
  if (!status) return null;

  return (
    <Section title="This device">
      <Card>
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-text">
            {isAndroid() ? <IconPhone /> : <IconLaptop />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-text">{status.name}</p>
            <p className="truncate text-xs text-muted">
              {isAndroid()
                ? "Browses and syncs — phones don't share folders"
                : "Other devices see only what you share"}
            </p>
          </div>
        </div>

        {/* Sharing a folder is desktop-only: a phone cannot hold a listening socket open in the
            background. Pairing is NOT — that only needs a socket for three minutes with the app in
            front of you — so "Add a device" belongs on both. */}
        {!isAndroid() && (
          <div className="mt-3">
            <SharedFolder />
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {/* Whichever device shows the code, the other one types it. Offering this on both is what
              makes pairing work in either direction. */}
          <Button
            variant={isAndroid() || status.sharing ? "primary" : "ghost"}
            onClick={() => void beginHosting()}
          >
            <IconPlus className="h-4 w-4" /> Add a device
          </Button>
          {!isAndroid() &&
            (status.sharing ? (
              <>
                <Button onClick={() => void startSharing()}>
                  <IconFolder className="h-4 w-4" /> Change…
                </Button>
                <Button variant="quiet" onClick={() => void stopSharing()}>
                  Stop sharing
                </Button>
              </>
            ) : (
              <Button variant="primary" onClick={() => void startSharing()}>
                <IconFolder className="h-4 w-4" /> Share a folder…
              </Button>
            ))}
        </div>

        {!isAndroid() && !status.sharing && (
          <div className="mt-2">
            <Hint>
              Your firewall will ask to allow Bode — accept it for the network you're on. Only{" "}
              <b>PDF, Markdown and HTML</b> files in the folder you pick are ever visible, and only
              to devices you've paired with.
            </Hint>
          </div>
        )}
      </Card>
    </Section>
  );
}

export function DevicesPanel() {
  const { status, error, notice, setNotice, pairing, browsing, refresh } = useDevices();

  useEffect(() => {
    void refresh();
    // Discovery arrives asynchronously, so poll while the panel is open rather than showing a list
    // that silently stops updating.
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  if (browsing) return <FileBrowser />;
  if (pairing.kind !== "idle") return <PairingFlow />;

  if (!status) {
    return <p className="py-6 text-center text-sm text-muted">{error ?? "Starting…"}</p>;
  }

  const pairedIds = new Set(status.peers.map((p) => p.deviceId));
  const strangers: DiscoveredDevice[] = status.discovered.filter((d) => !pairedIds.has(d.deviceId));
  const nothingYet = status.peers.length === 0 && strangers.length === 0;

  return (
    <div className="flex flex-col gap-5">
      {error && <p className="text-xs text-red-400">{error}</p>}

      {notice && (
        <div className="animate-fade-in flex items-start gap-2 rounded-lg border border-amber-400/40 bg-amber-400/5 p-3">
          <p className="flex-1 text-xs leading-relaxed text-text">{notice}</p>
          <button
            onClick={() => setNotice(null)}
            aria-label="Dismiss"
            className="shrink-0 text-muted hover:text-text"
          >
            <IconClose className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {nothingYet && <FirstRun sharing={status.sharing} />}

      {/* First, not last. What this device is exposing is the fact with consequences, and it was
          sitting below the fold under everything else. */}
      <ThisDevice />

      {status.peers.length > 0 && (
        <Section title={status.peers.length === 1 ? "Paired device" : "Paired devices"}>
          <div className="flex flex-col gap-2">
            {status.peers.map((peer, i) => (
              // Capped so a long list doesn't feel like it is loading slowly.
              <DeviceCard key={peer.deviceId} peer={peer} index={Math.min(i, 5)} />
            ))}
          </div>
        </Section>
      )}

      {strangers.length > 0 && (
        <Section title="Found nearby">
          <div className="flex flex-col gap-2">
            {strangers.map((device, i) => (
              <StrangerCard key={device.deviceId} device={device} index={Math.min(i, 5)} />
            ))}
          </div>
        </Section>
      )}

      <OfflineDocs />
      <ManualPair />
    </div>
  );
}

/**
 * Typing an address by hand.
 *
 * Discovery is a convenience and must never be the only way in: multicast is dropped outright on
 * plenty of networks that happily carry a direct TCP connection, and a device reachable over a VPN
 * will never be discovered at all. The sharing device shows its address and port for this.
 */
function ManualPair() {
  const { beginManualJoin, status } = useDevices();
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState("");

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="self-start text-xs text-muted transition-colors hover:text-text"
      >
        Connect by address instead…
      </button>
    );
  }

  return (
    <div className="animate-fade-in rounded-xl border border-border p-3">
      <Hint>
        Enter the address shown on the other device, including the port — for example
        <code className="mx-1">10.0.0.106:52413</code>.
      </Hint>
      <input
        value={host}
        onChange={(e) => setHost(e.target.value.trim())}
        autoFocus
        placeholder="10.0.0.106:52413"
        className="mt-2 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 font-mono text-sm text-text outline-none focus:border-accent"
      />
      <div className="mt-2 flex items-center gap-2">
        <Button
          variant="primary"
          disabled={!host.includes(":")}
          onClick={() => beginManualJoin(host)}
        >
          Connect
        </Button>
        <Button variant="quiet" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      {status?.port && (
        <div className="mt-2">
          <Hint>This device is reachable on port {status.port}.</Hint>
        </div>
      )}
    </div>
  );
}
