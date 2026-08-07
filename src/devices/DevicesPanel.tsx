import { useEffect, useState } from "react";
import { useDevices, docIdFor, parentPath, formatSize, type DiscoveredDevice } from "./useDevices";
import { useViewer } from "../store/viewerStore";
import { isAndroid } from "../platform/files";
import { isRemote } from "../platform/docId";
import { IconClose } from "../components/icons";

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
 */

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
        className="h-full w-[380px] max-w-[92vw] overflow-auto bg-surface p-5 shadow-2xl animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between px-3">
          <h2 className="text-lg font-semibold text-text">Devices</h2>
          <button onClick={onClose} className="rounded p-1 text-muted hover:bg-surface-2">
            <IconClose />
          </button>
        </div>
        <DevicesPanel />
      </div>
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded px-3 py-2 text-sm text-text hover:bg-surface-2">
      {children}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="px-3 text-xs leading-relaxed text-muted">{children}</p>;
}

/**
 * Transfers in flight. Rendered wherever the panel is, because a large document over Wi-Fi takes
 * long enough that a bare spinner reads as a hang — and because chunking is what makes both the
 * progress and the cancel possible at all.
 */
export function Transfers() {
  const transfers = useDevices((s) => s.transfers);
  const cancel = useDevices((s) => s.cancel);
  const active = Object.values(transfers);
  if (active.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 px-3 py-1">
      {active.map((t) => {
        const pct = t.total > 0 ? Math.min(100, Math.round((t.received / t.total) * 100)) : 0;
        return (
          <div key={t.key} className="text-xs text-muted">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate">
                {t.direction === "upload" ? "Sending" : "Getting"} {t.label}
              </span>
              <button onClick={() => cancel(t.key)} className="shrink-0 hover:text-text">
                Cancel
              </button>
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded bg-surface-2">
              <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
            </div>
            <div className="mt-0.5 tabular-nums">
              {formatSize(t.received)} of {formatSize(t.total)}
            </div>
          </div>
        );
      })}
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
      <div className="border-b border-muted/30 bg-surface-2 px-4 py-2 text-xs text-muted">
        Reading the copy saved on this device — the device it came from isn't reachable right now.
      </div>
    );
  }

  if (!note.stale) return null;

  return (
    <div className="flex items-center gap-3 border-b border-muted/30 bg-surface-2 px-4 py-2 text-xs text-text">
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
        className="shrink-0 rounded bg-accent px-3 py-1 font-medium text-accent-fg disabled:opacity-40"
      >
        {updating ? "Updating…" : "Update"}
      </button>
    </div>
  );
}

/** Pairing needs the user to compare a value on both screens, so it takes over the panel. */
function Pairing() {
  const { pairing, submitCode, cancelPairing, dismissConfirmation, error, status } = useDevices();
  const [code, setCode] = useState("");
  const port = status?.port;

  if (pairing.kind === "idle") return null;

  if (pairing.kind === "hosting") {
    return (
      <div className="rounded-lg border border-muted/30 p-4">
        <h3 className="text-sm font-semibold text-text">Enter this code on your other device</h3>
        <div className="my-3 text-center font-mono text-3xl tracking-[0.3em] text-text">
          {pairing.code}
        </div>
        <Hint>Expires in three minutes. It works once, for one device.</Hint>
        {/* Shown so the other device can be pointed here by hand when multicast is blocked. */}
        {port && <Hint>Not showing up? Enter this device's IP with port {port}.</Hint>}
        <button onClick={cancelPairing} className="mt-3 text-xs text-muted hover:text-text">
          Cancel
        </button>
      </div>
    );
  }

  if (pairing.kind === "working") {
    return <div className="p-4 text-sm text-muted">Connecting…</div>;
  }

  if (pairing.kind === "confirm") {
    return (
      <div className="rounded-lg border border-muted/30 p-4">
        <h3 className="text-sm font-semibold text-text">Check both screens match</h3>
        <div className="my-3 text-center font-mono text-3xl tracking-[0.3em] text-text">
          {pairing.fingerprint}
        </div>
        <Hint>
          {pairing.name} should be showing the same six characters. If it isn't, something is
          intercepting the connection — unpair immediately and try again on a network you trust.
        </Hint>
        {/* The value is derived from BOTH certificates, so a device in the middle — holding a
            different key to each side — cannot make the two screens agree. */}
        <Hint>
          Both devices work this out independently from each other's keys. They can only match if
          nothing is in between.
        </Hint>
        <button
          onClick={dismissConfirmation}
          className="mt-3 rounded bg-accent px-4 py-1.5 text-sm font-medium text-accent-fg"
        >
          They match
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-muted/30 p-4">
      <h3 className="text-sm font-semibold text-text">Pair with {pairing.target.name}</h3>
      <Hint>Enter the six-digit code shown on that device.</Hint>
      <input
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
        inputMode="numeric"
        autoFocus
        placeholder="000000"
        className="mt-3 w-full rounded border border-muted/40 bg-surface px-3 py-2 text-center font-mono text-2xl tracking-[0.3em] text-text"
      />
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      <div className="mt-3 flex gap-2">
        <button
          disabled={code.length !== 6}
          onClick={() => submitCode(code)}
          className="rounded bg-accent px-4 py-1.5 text-sm font-medium text-accent-fg disabled:opacity-40"
        >
          Pair
        </button>
        <button onClick={cancelPairing} className="text-xs text-muted hover:text-text">
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Browsing one device's shared folder. */
function Browser() {
  const {
    browsing,
    entries,
    skipped,
    loadingEntries,
    browse,
    closeBrowser,
    error,
    cached,
    refreshCache,
    setPinned,
  } = useDevices();
  const openPath = useViewer((s) => s.openPath);

  useEffect(() => {
    void refreshCache();
  }, [refreshCache]);

  if (!browsing) return null;

  const up = parentPath(browsing.path);
  const pinnedRels = new Set(cached.filter((c) => c.pinned && c.deviceId === browsing.deviceId).map((c) => c.rel));

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 px-3 py-1">
        <button onClick={closeBrowser} className="text-xs text-muted hover:text-text">
          ← Devices
        </button>
        <span className="truncate text-xs text-muted">
          {browsing.name}
          {browsing.path && ` / ${browsing.path}`}
        </span>
      </div>

      <Transfers />

      {up !== null && (
        <button
          onClick={() => browse(browsing.deviceId, browsing.name, up)}
          className="rounded px-3 py-2 text-left text-sm text-muted hover:bg-surface-2"
        >
          ../
        </button>
      )}

      {loadingEntries && <p className="px-3 py-2 text-sm text-muted">Loading…</p>}

      {/* An empty folder and a folder full of files Bode can't open look identical from here, and
          one of those is a broken setup while the other is working correctly. Say which. */}
      {!loadingEntries && !error && entries.length === 0 && (
        <Hint>
          {skipped > 0
            ? `Nothing here Bode can open. ${skipped} other file${skipped === 1 ? "" : "s"} ${
                skipped === 1 ? "was" : "were"
              } skipped — only PDF, Markdown and HTML are shared.`
            : "This folder is empty."}
        </Hint>
      )}

      {/* Also worth saying when the folder isn't empty, so a short list doesn't look like a bug. */}
      {!loadingEntries && !error && entries.length > 0 && skipped > 0 && (
        <Hint>
          {skipped} other file{skipped === 1 ? "" : "s"} hidden — only PDF, Markdown and HTML are
          shared.
        </Hint>
      )}

      {entries.map((entry) => {
        const docId = docIdFor(browsing.deviceId, entry.rel);
        const pinned = pinnedRels.has(entry.rel);
        return (
          <div key={entry.rel} className="flex items-center gap-1">
            <button
              onClick={() =>
                entry.kind === "dir"
                  ? browse(browsing.deviceId, browsing.name, entry.rel)
                  : openPath(docId)
              }
              className="flex flex-1 items-center justify-between gap-3 rounded px-3 py-2 text-left text-sm text-text hover:bg-surface-2"
            >
              <span className="truncate">
                {entry.kind === "dir" ? "📁 " : ""}
                {entry.name}
              </span>
              {entry.kind === "file" && (
                <span className="shrink-0 text-xs text-muted">{formatSize(entry.size)}</span>
              )}
            </button>
            {entry.kind === "file" && (
              <button
                onClick={() => setPinned(docId, !pinned)}
                title={
                  pinned
                    ? "Kept on this device — tap to stop keeping it"
                    : "Keep on this device so it opens without the other one"
                }
                className={`shrink-0 px-2 text-sm ${pinned ? "text-accent" : "text-muted hover:text-text"}`}
              >
                {pinned ? "★" : "☆"}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Documents held locally, with the pin that decides whether the OS may reclaim them. */
function Offline() {
  const { cached, refreshCache, setPinned, forget } = useDevices();
  const openPath = useViewer((s) => s.openPath);

  useEffect(() => {
    void refreshCache();
  }, [refreshCache]);

  if (cached.length === 0) return null;

  const kept = cached.filter((c) => c.pinned);
  const total = cached.reduce((sum, c) => sum + c.size, 0);

  return (
    <>
      <div className="px-3 pt-2 text-xs uppercase tracking-wide text-muted">
        On this device · {formatSize(total)}
      </div>
      {cached.map((doc) => (
        <div key={doc.docId} className="flex items-center gap-1">
          <button
            onClick={() => openPath(doc.docId)}
            className="flex flex-1 items-center justify-between gap-3 rounded px-3 py-2 text-left text-sm text-text hover:bg-surface-2"
          >
            <span className="truncate">{doc.name}</span>
            <span className="shrink-0 text-xs text-muted">{formatSize(doc.size)}</span>
          </button>
          <button
            onClick={() => setPinned(doc.docId, !doc.pinned)}
            className={`shrink-0 px-2 text-sm ${doc.pinned ? "text-accent" : "text-muted hover:text-text"}`}
            title={doc.pinned ? "Kept offline" : "Cached — may be cleared automatically"}
          >
            {doc.pinned ? "★" : "☆"}
          </button>
          <button
            onClick={() => forget(doc.docId)}
            className="shrink-0 px-2 text-xs text-muted hover:text-text"
          >
            Remove
          </button>
        </div>
      ))}
      <Hint>
        Starred documents stay until you remove them. The rest are a cache: Bode clears the oldest
        when it grows past half a gigabyte, and on Android the system may clear them sooner.
        {kept.length > 0 && ` ${kept.length} kept offline.`}
      </Hint>
    </>
  );
}

/** Send the document currently open to a paired device. */
function SendOpenDocument() {
  const filePath = useViewer((s) => s.filePath);
  const fileName = useViewer((s) => s.fileName);
  const { status, send, sending } = useDevices();
  const [sent, setSent] = useState<string | null>(null);

  // A document already on another device has nothing to send anywhere.
  if (!filePath || isRemote(filePath) || !status) return null;
  const online = status.peers.filter((p) => p.online);
  if (online.length === 0) return null;

  return (
    <>
      <div className="px-3 pt-2 text-xs uppercase tracking-wide text-muted">Send this document</div>
      <Hint>{fileName}</Hint>
      <div className="flex flex-wrap gap-2 px-3">
        {online.map((peer) => (
          <button
            key={peer.deviceId}
            disabled={sending}
            onClick={async () => {
              const name = await send(peer.deviceId, filePath);
              if (name) setSent(`Sent as ${name}`);
            }}
            className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-40"
          >
            {sending ? "Sending…" : `To ${peer.name}`}
          </button>
        ))}
      </div>
      {sent && <Hint>{sent}</Hint>}
    </>
  );
}

export function DevicesPanel() {
  const {
    status,
    error,
    pairing,
    browsing,
    refresh,
    startSharing,
    stopSharing,
    unpair,
    beginHosting,
    beginJoining,
    browse,
    syncWith,
    syncSettingsFrom,
    syncing,
    lastSync,
    setInbox,
  } = useDevices();

  useEffect(() => {
    void refresh();
    // Discovery arrives asynchronously, so poll while the panel is open rather than showing a list
    // that silently stops updating.
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  if (browsing) return <Browser />;
  if (pairing.kind !== "idle") return <Pairing />;

  if (!status) {
    return <p className="px-3 py-2 text-sm text-muted">{error ?? "Starting…"}</p>;
  }

  const pairedIds = new Set(status.peers.map((p) => p.deviceId));
  const strangers: DiscoveredDevice[] = status.discovered.filter((d) => !pairedIds.has(d.deviceId));

  return (
    <div className="flex flex-col gap-2">
      {error && <p className="px-3 text-xs text-red-400">{error}</p>}

      <Transfers />

      <div className="px-3 pt-1 text-xs uppercase tracking-wide text-muted">This device</div>
      <Row>
        <span className="truncate">{status.name}</span>
      </Row>

      {/* Sharing is desktop-only: a phone cannot hold a listening socket open in the background. */}
      {!isAndroid() && (
        <>
          {status.sharing ? (
            <>
              <Row>
                <span className="truncate text-muted">Sharing {status.shareRoot}</span>
              </Row>
              {status.inbox && (
                <Hint>
                  Documents sent from your other devices arrive in{" "}
                  <b>{status.inbox.split(/[\\/]/).pop()}</b> inside that folder.{" "}
                  <button onClick={setInbox} className="underline hover:text-text">
                    Change…
                  </button>
                </Hint>
              )}
              <div className="flex gap-2 px-3">
                <button
                  onClick={beginHosting}
                  className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg"
                >
                  Add a device
                </button>
                <button onClick={stopSharing} className="text-xs text-muted hover:text-text">
                  Stop sharing
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="px-3">
                <button
                  onClick={startSharing}
                  className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg"
                >
                  Share a folder…
                </button>
              </div>
              <Hint>
                Your firewall will ask to allow Bode on your network — accept for the network you're
                on. Only <b>PDF, Markdown and HTML</b> files in the folder you choose are ever
                visible, and only to devices you pair with; pick a folder that has some, or it will
                look empty on your other device.
              </Hint>
            </>
          )}
        </>
      )}

      {lastSync && (
        <div className="px-3">
          <p className="text-xs text-muted">
            {lastSync.documents === 0
              ? // "Synced 0 documents" reads as a failure. Nothing to exchange is the normal state
                // until both devices have actually opened the same file — and it must not be
                // mistaken for "no files were found", which is a different action entirely.
                `No notes or reading positions to exchange with ${lastSync.deviceName} yet. This doesn't fetch documents — tap the device above to browse them.`
              : `Synced notes for ${lastSync.documents} document${lastSync.documents === 1 ? "" : "s"} with ${lastSync.deviceName}.`}
          </p>
          {/* Wall-clock timestamps decide which edit wins, so a badly wrong clock is worth saying
              out loud rather than silently resolving in favour of the wrong device. */}
          {lastSync.clockWarning && (
            <p className="mt-1 text-xs text-amber-400">{lastSync.clockWarning}</p>
          )}
        </div>
      )}

      {status.peers.length > 0 && (
        <>
          <div className="px-3 pt-2 text-xs uppercase tracking-wide text-muted">Paired</div>
          {status.peers.map((peer) => (
            <div key={peer.deviceId} className="flex items-center gap-2">
              {/* Browsing is the primary action, so it needs to look like one. Rendering the device
                  name as bare text left the only route to another device's documents invisible. */}
              <button
                disabled={!peer.online}
                onClick={() => browse(peer.deviceId, peer.name, "")}
                className="flex min-w-0 flex-1 items-center gap-2 rounded px-3 py-2 text-left hover:bg-surface-2 disabled:opacity-40"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-text">{peer.name}</span>
                  <span className="block truncate text-xs text-muted">
                    {peer.online ? "Tap to browse its documents" : "Not on this network right now"}
                  </span>
                </span>
                {peer.online && <span className="shrink-0 text-muted">›</span>}
              </button>
              {/* Named for what it moves. A bare "Sync" reads as "fetch this device's files",
                  which is what browsing does — and sending the user here instead finds nothing. */}
              <button
                disabled={!peer.online || syncing}
                onClick={() => syncWith(peer.deviceId)}
                title="Exchange highlights, notes and reading positions — not files"
                className="shrink-0 px-2 text-xs text-muted hover:text-text disabled:opacity-30"
              >
                {syncing ? "Syncing…" : "Sync notes"}
              </button>
              <button
                onClick={() => unpair(peer.deviceId)}
                className="px-3 text-xs text-muted hover:text-text"
              >
                Unpair
              </button>
            </div>
          ))}
        </>
      )}

      <SendOpenDocument />
      <Offline />

      {status.peers.some((p) => p.online) && (
        <>
          <div className="px-3 pt-2 text-xs uppercase tracking-wide text-muted">Appearance</div>
          <Hint>
            Copy the theme and recent-file list from another device. This is a one-off on purpose —
            preferences drifting between devices on their own is more surprising than useful, and
            your window layout and trusted-HTML list never travel.
          </Hint>
          <div className="flex flex-wrap gap-2 px-3">
            {status.peers
              .filter((p) => p.online)
              .map((peer) => (
                <button
                  key={peer.deviceId}
                  disabled={syncing}
                  onClick={() => syncSettingsFrom(peer.deviceId)}
                  className="rounded border border-muted/40 px-3 py-1.5 text-xs text-text hover:bg-surface-2 disabled:opacity-40"
                >
                  Match {peer.name}
                </button>
              ))}
          </div>
        </>
      )}

      {strangers.length > 0 && (
        <>
          <div className="px-3 pt-2 text-xs uppercase tracking-wide text-muted">Found nearby</div>
          {strangers.map((device) => (
            <button
              key={device.deviceId}
              onClick={() => beginJoining(device)}
              className="truncate rounded px-3 py-2 text-left text-sm text-text hover:bg-surface-2"
            >
              {device.name} <span className="text-xs text-muted">— tap to pair</span>
            </button>
          ))}
        </>
      )}

      {status.peers.length === 0 && strangers.length === 0 && (
        <Hint>
          No devices yet. Open Bode on your other device, share a folder there, and it will appear
          here. If nothing shows up, both devices must be on the same Wi-Fi — guest and hotel
          networks usually block devices from seeing each other, and a VPN will too.
        </Hint>
      )}

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
        className="px-3 py-2 text-left text-xs text-muted hover:text-text"
      >
        Connect by address instead…
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-muted/30 p-3">
      <Hint>
        Enter the address shown on the other device, including the port — for example
        <code className="mx-1">10.0.0.106:52413</code>.
      </Hint>
      <input
        value={host}
        onChange={(e) => setHost(e.target.value.trim())}
        autoFocus
        placeholder="10.0.0.106:52413"
        className="mt-2 w-full rounded border border-muted/40 bg-surface px-3 py-2 font-mono text-sm text-text"
      />
      <div className="mt-2 flex gap-2">
        <button
          disabled={!host.includes(":")}
          onClick={() => beginManualJoin(host)}
          className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-40"
        >
          Connect
        </button>
        <button onClick={() => setOpen(false)} className="text-xs text-muted hover:text-text">
          Cancel
        </button>
      </div>
      {status?.sharing && status.port && (
        <Hint>This device is reachable on port {status.port}.</Hint>
      )}
    </div>
  );
}
