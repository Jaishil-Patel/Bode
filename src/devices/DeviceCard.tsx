import { useState } from "react";
import { useDevices, relativeTime, type PairedDevice, type DevicePlatform } from "./useDevices";
import { useViewer } from "../store/viewerStore";
import { isRemote } from "../platform/docId";
import { Button, Card, Disclosure, StatusChip, type Presence } from "./ui";
import {
  IconLaptop,
  IconPhone,
  IconFolder,
  IconSync,
  IconSend,
  IconChevronRight,
} from "../components/icons";

/*
 * One paired device.
 *
 * The panel this replaces listed four verbs — browse, sync notes, send a document, copy appearance —
 * as near-identical grey links spread across three separate sections, so nothing indicated which
 * was the thing you had come to do, and "Sync notes" was routinely pressed by someone expecting
 * files. The fix is structural rather than more explanatory text: the two verbs that are genuinely
 * alternatives sit side by side on the same card with icons, and the two that are rare live behind
 * a disclosure.
 */

/** The glyph tile. The fastest way to tell two cards apart before reading either name. */
function PlatformTile({ platform, dim }: { platform: DevicePlatform; dim: boolean }) {
  const Glyph = platform === "mobile" ? IconPhone : IconLaptop;
  return (
    <span
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface transition-colors ${
        dim ? "text-muted" : "text-text"
      }`}
    >
      <Glyph />
    </span>
  );
}

/**
 * What the card says about the connection, in one word plus one line.
 *
 * Reachable and sharing are separate facts — a phone is always the first and never the second — and
 * conflating them is what made a perfectly healthy phone read as a broken desktop.
 */
function describe(peer: PairedDevice, busy: boolean): { presence: Presence; chip: string; line: string } {
  if (busy) return { presence: "busy", chip: "Syncing…", line: "Exchanging highlights and pages" };
  if (!peer.online) {
    return {
      presence: "away",
      chip: "Away",
      line: "Not on this network right now",
    };
  }
  if (peer.sharing) {
    return { presence: "ready", chip: "Ready", line: "Sharing a folder you can browse" };
  }
  // Two different situations wearing the same flag. A phone is working exactly as designed and will
  // never share; a desktop that isn't sharing is one setting away from doing so, and saying which is
  // the difference between "nothing is wrong" and "go turn it on over there".
  return {
    presence: "connected",
    chip: "Connected",
    line:
      peer.platform === "mobile"
        ? "Phones sync notes, not folders"
        : "No folder shared on that device yet",
  };
}

export function DeviceCard({ peer, index }: { peer: PairedDevice; index: number }) {
  const {
    browse,
    syncWith,
    syncSettingsFrom,
    unpair,
    send,
    sending,
    syncingWith,
    lastSync,
  } = useDevices();
  const filePath = useViewer((s) => s.filePath);
  const fileName = useViewer((s) => s.fileName);
  const [sent, setSent] = useState<string | null>(null);
  const [justSynced, setJustSynced] = useState(false);

  const busy = syncingWith === peer.deviceId;
  const { presence, chip, line } = describe(peer, busy);
  const report = lastSync[peer.deviceId];

  // Only offered where it can actually succeed. A device offering a folder is exactly a device with
  // an inbox, so a phone — which never shares — is never a target, and the button that used to sit
  // on the desktop failing every time it was pressed simply does not render there.
  const canReceive = peer.online && peer.sharing;
  const sendable = filePath && !isRemote(filePath) && canReceive;
  // Whether this device could EVER have a folder to browse, as opposed to not having one right now.
  const canEverBrowse = peer.platform !== "mobile";

  return (
    <Card index={index}>
      <div className="flex items-center gap-3">
        <PlatformTile platform={peer.platform} dim={!peer.online} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span
              className={`truncate text-sm font-medium ${peer.online ? "text-text" : "text-muted"}`}
            >
              {peer.name}
            </span>
            <StatusChip presence={presence} label={chip} />
          </div>
          <p className="truncate text-xs text-muted">{line}</p>
        </div>
      </div>

      <div className="mt-3 flex gap-2">
        {/* Not rendered at all for a phone. A disabled Browse there would never become enabled —
            an Android listening socket dies as soon as the app leaves the foreground, which is why
            the phone pushes rather than serves — so it is dead UI, not a temporary state. On a
            desktop peer it stays and simply disables, because "offline" and "not sharing yet" both
            resolve on their own. */}
        {canEverBrowse && (
          <Button
            block
            disabled={!peer.online || !peer.sharing}
            onClick={() => void browse(peer.deviceId, peer.name, "")}
            title={
              !peer.online
                ? "This device isn't on the network right now"
                : !peer.sharing
                  ? "This device isn't sharing a folder yet"
                  : "Open its shared folder"
            }
          >
            <IconFolder className="h-4 w-4" /> Browse
            {peer.online && peer.sharing && <IconChevronRight className="h-3.5 w-3.5 opacity-60" />}
          </Button>
        )}
        <Button
          block
          disabled={!peer.online || busy}
          onClick={async () => {
            await syncWith(peer.deviceId);
            // A one-off turn of the icon, so a sync that exchanged nothing still visibly happened.
            setJustSynced(true);
            setTimeout(() => setJustSynced(false), 700);
          }}
          title="Exchange highlights, notes and reading positions. Files stay where they are."
        >
          <IconSync className={`h-4 w-4 ${justSynced ? "animate-spin-once" : ""}`} />
          {busy ? "Syncing…" : "Sync notes"}
        </Button>
      </div>

      {sendable && (
        <button
          disabled={sending}
          onClick={async () => {
            const name = await send(peer.deviceId, filePath);
            if (!name) return;
            // Clears itself: a confirmation that never leaves stops being a confirmation and starts
            // being part of the card.
            setSent(name);
            setTimeout(() => setSent(null), 6000);
          }}
          className="mt-2 flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-xs text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-40"
        >
          <IconSend className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">
            {sending ? "Sending…" : `Send “${fileName}” to ${peer.name}`}
          </span>
        </button>
      )}
      {sent && (
        <p className="animate-fade-in mt-1 text-xs text-muted">
          Sent — it arrived as <b className="text-text">{sent}</b>.
        </p>
      )}

      {/* One slot, two jobs. Before the first sync it says what the button on the right actually
          does — the single most misread thing in the old panel, where "Sync notes" was pressed by
          someone expecting files and then reported as broken. Afterwards the same line carries the
          result, so the explanation costs nothing once it is no longer needed. A tooltip would not
          do: there is no hover on the phone, which is where this is read. */}
      <p className="animate-fade-in mt-2 text-xs leading-relaxed text-muted">
        {!report ? (
          <>
            <b className="font-medium text-text">Browse</b> opens its files.{" "}
            <b className="font-medium text-text">Sync notes</b> exchanges your highlights and reading
            positions — the files themselves stay put.
          </>
        ) : (
          <>
            {report.documents === 0
              ? // "Synced 0 documents" reads as a failure. Having nothing to exchange is the normal
                // state until both devices have opened the same file, and it must not be confused
                // with "no files were found" — a different thing, reached by a different button.
                "Already up to date — nothing new to exchange."
              : `Notes for ${report.documents} document${report.documents === 1 ? "" : "s"}`}
            {" · "}
            {relativeTime(report.at)}
          </>
        )}
      </p>
      {/* Wall-clock timestamps decide which edit wins, so a badly wrong clock is worth saying out
          loud rather than silently resolving in favour of the wrong device. */}
      {report?.clockWarning && (
        <p className="mt-1 text-xs leading-relaxed text-amber-400">{report.clockWarning}</p>
      )}

      <div className="mt-3 border-t border-border pt-2">
        <Disclosure label="More">
          <Button
            variant="quiet"
            disabled={!peer.online || busy}
            onClick={() => void syncSettingsFrom(peer.deviceId)}
            title="One-off copy. Your window layout and trusted-HTML list never travel."
          >
            Copy theme and recent files from {peer.name}
          </Button>
          <Button
            variant="quiet"
            onClick={() => void unpair(peer.deviceId)}
            title={
              peer.online
                ? "Both devices forget each other, and any documents kept from it are removed here"
                : "This device forgets it now; it will still need forgetting on the other device"
            }
          >
            Forget this device{peer.online ? "" : " (it's away)"}
          </Button>
        </Disclosure>
      </div>
    </Card>
  );
}
