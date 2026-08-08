import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { formatDocId } from "../platform/docId";
import { isShareableKey, rekey, type KeyContext } from "../platform/docKey";
import { useAnnotations, type Annotation } from "../annotations/useAnnotations";
import { useSettings, syncableSettings, type SyncableSettings } from "../settings/useSettings";

/*
 * Nearby devices — state for the Devices panel.
 *
 * Every call here crosses into Rust, which owns the network, the trust decisions and the paired-peer
 * list. This store never decides who is trusted; it only renders what the backend reports.
 */

export interface DiscoveredDevice {
  deviceId: string;
  name: string;
  /** The address to show. Display only — connecting uses `addrs`. */
  addr: string;
  /**
   * Every address the device advertised. A desktop running WSL, Docker or a VM advertises virtual
   * adapters no other device can reach, indistinguishable from the real one, so Rust tries each.
   */
  addrs: string[];
  port: number;
  certPrefix: string;
  /** Offering a folder to browse. Sent by Rust for paired and unpaired devices alike. */
  sharing: boolean;
  platform: DevicePlatform;
}

/** What kind of machine a device is, for the icon. Cosmetic — nothing is ever decided from it. */
export type DevicePlatform = "desktop" | "mobile";

export interface PairedDevice {
  deviceId: string;
  name: string;
  addedAt: number;
  online: boolean;
  /** Offering a folder to browse. A phone is reachable but never sharing. */
  sharing: boolean;
  platform: DevicePlatform;
}

export interface NearbyStatus {
  deviceId: string;
  name: string;
  sharing: boolean;
  port: number | null;
  shareRoot: string | null;
  inbox: string | null;
  /** Set when a device has just paired with this one; drives the host's confirmation screen. */
  lastPairing: { deviceId: string; name: string; fingerprint: string; at: number } | null;
  peers: PairedDevice[];
  discovered: DiscoveredDevice[];
}

export interface RemoteEntry {
  name: string;
  rel: string;
  kind: "dir" | "file";
  size: number;
  mtime: number;
}

/** A document held locally from a paired device. */
export interface CachedDoc {
  docId: string;
  deviceId: string;
  name: string;
  rel: string;
  size: number;
  pinned: boolean;
  fetchedAt: number;
  usedAt: number;
}

/** One transfer in flight, keyed by the document being moved. */
export interface Transfer {
  key: string;
  label: string;
  received: number;
  total: number;
  direction: "download" | "upload";
  /** Bytes per second, smoothed. Zero until two events have arrived. */
  rate: number;
  /** When the previous event landed, for the next rate sample. */
  sampledAt: number;
  /** Bytes at that sample, so a rate can be taken without keeping a history. */
  sampledBytes: number;
}

/** What the last fetch of a remote document reported. Mirrors Rust's `Fetched`, minus the path. */
export interface FetchNote {
  stale: boolean;
  offline: boolean;
  pinned: boolean;
  fromCache: boolean;
}

/**
 * Everything one device knows about reading one document. This is the unit `/v1/state` moves, and
 * Rust treats it as opaque — the merge lives in the frontend, where the annotation model is, so
 * there is only ever one implementation of it.
 */
export interface DocState {
  annotations: Annotation[];
  deleted: Record<string, number>;
  position?: { page: number; at?: number };
}

/** How a sync went, for the panel to report. */
export interface SyncReport {
  deviceName: string;
  documents: number;
  /** Set when the two clocks disagree enough that ordering edits is guesswork. */
  clockWarning: string | null;
  at: number;
}

/** What the user is doing in the pairing flow, so the panel can render one thing at a time. */
export type PairingStage =
  | { kind: "idle" }
  /** This device is sharing and waiting for another to enter the code. */
  | { kind: "hosting"; code: string }
  /** Joining: we've been given a device to pair with and need the code. */
  | { kind: "joining"; target: DiscoveredDevice }
  | { kind: "working" }
  /** Both devices should now show the same fingerprint. */
  | { kind: "confirm"; name: string; fingerprint: string };

interface DevicesState {
  status: NearbyStatus | null;
  error: string | null;
  /**
   * Something worth saying that isn't a failure.
   *
   * Lives in the store rather than in a component because the thing that raises it — forgetting a
   * device that wasn't reachable to be told — destroys the card that would otherwise show it.
   */
  notice: string | null;
  setNotice: (notice: string | null) => void;
  pairing: PairingStage;

  /** Which device's folder is being browsed, and where in it. */
  browsing: { deviceId: string; name: string; path: string } | null;
  entries: RemoteEntry[];
  /** Files in this folder that aren't document types Bode opens. A count only, never names. */
  skipped: number;
  loadingEntries: boolean;

  /** Transfers in flight, keyed by document. Fed by the `nearby://progress` event. */
  transfers: Record<string, Transfer>;
  /** How the last open of each remote document went, so the viewer can say "there's a newer copy". */
  fetches: Record<string, FetchNote>;
  cached: CachedDoc[];
  /** Set while a push is being set up, so the UI can disable the button rather than double-send. */
  sending: boolean;

  refresh: () => Promise<void>;
  startSharing: () => Promise<void>;
  stopSharing: () => Promise<void>;
  rename: (name: string) => Promise<void>;
  /** Forget a device. Resolves to whether the other device was reachable and told to forget back. */
  unpair: (deviceId: string) => Promise<boolean>;

  beginHosting: () => Promise<void>;
  beginJoining: (target: DiscoveredDevice) => void;
  /** Pair with a typed `host` or `host:port`, for when multicast discovery is blocked. */
  beginManualJoin: (host: string) => void;
  submitCode: (code: string) => Promise<void>;
  cancelPairing: () => Promise<void>;
  dismissConfirmation: () => void;

  browse: (deviceId: string, name: string, path: string) => Promise<void>;
  closeBrowser: () => void;

  noteFetch: (docId: string, note: FetchNote) => void;
  /** Re-download a remote document, ignoring the cached copy. Backs the "Update" action. */
  refetch: (docId: string) => Promise<void>;
  refreshCache: () => Promise<void>;
  setPinned: (docId: string, pinned: boolean) => Promise<void>;
  forget: (docId: string) => Promise<void>;
  /** Send a local document to a paired device. Returns the name it landed under. */
  send: (deviceId: string, path: string) => Promise<string | null>;
  cancel: (key: string) => Promise<void>;
  setInbox: () => Promise<void>;

  /** Exchange annotations and reading positions with a peer, then merge what comes back. */
  syncWith: (deviceId: string) => Promise<void>;
  /** Take a peer's theme and reading history. Deliberately manual — see `mergeSettings`. */
  syncSettingsFrom: (deviceId: string) => Promise<void>;
  /**
   * Which device is being synced with, or null. Per-device rather than a flag: with one card per
   * peer, a global boolean put a spinner on every card at once and made it impossible to tell which
   * one you had pressed.
   */
  syncingWith: string | null;
  /** The last exchange with each device, keyed by device id. Not persisted — session only. */
  lastSync: Record<string, SyncReport>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Module-level so a second notice replaces the first's timer rather than racing it. */
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

export const useDevices = create<DevicesState>((set, get) => ({
  status: null,
  error: null,
  notice: null,
  pairing: { kind: "idle" },
  browsing: null,
  entries: [],
  skipped: 0,
  loadingEntries: false,
  transfers: {},
  fetches: {},
  cached: [],
  sending: false,
  syncingWith: null,
  lastSync: {},

  refresh: async () => {
    try {
      const status = await invoke<NearbyStatus>("nearby_status");
      set({ status, error: null });

      // A device paired with US. The host has no other way to learn this — `/v1/pair` runs on a
      // connection task with no route to the UI — so without this the host sits showing the numeric
      // code while the other device displays a fingerprint to compare against nothing.
      const notice = status.lastPairing;
      if (notice && get().pairing.kind !== "confirm") {
        set({
          pairing: { kind: "confirm", name: notice.name, fingerprint: notice.fingerprint },
        });
      }
      // Cached into settings so `docKey` can answer at startup without initialising Nearby — which
      // would generate a certificate for a user who may never share anything.
      const before = useSettings.getState().nearbyContext;
      const after = keyContextOf(status);
      useSettings.getState().setNearbyContext(after);

      // Re-key immediately when the context changes, not lazily at sync time.
      //
      // `docKey` answers differently once this device knows what it shares, so a document annotated
      // beforehand is filed under its absolute path while the annotation layer starts looking under
      // the shared key. The highlights are not lost, but they VANISH from the page until something
      // migrates them — and the first thing a user does after sharing is open this panel, so the
      // disappearance lands exactly when they are watching.
      if (before?.deviceId !== after.deviceId || before?.shareRoot !== after.shareRoot) {
        migrateDocKeys(after);
      }
      // A peer pulling from us finds only what we have published, so publishing has to happen
      // whether or not this device ever presses Sync itself.
      await publishOwnState();
      await collectPushedState();
    } catch (e) {
      set({ error: message(e) });
    }
  },

  startSharing: async () => {
    try {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked !== "string") return;
      await invoke("nearby_start_sharing", { root: picked });
      await get().refresh();
    } catch (e) {
      set({ error: message(e) });
    }
  },

  stopSharing: async () => {
    try {
      await invoke("nearby_stop_sharing");
      set({ pairing: { kind: "idle" } });
      await get().refresh();
    } catch (e) {
      set({ error: message(e) });
    }
  },

  rename: async (name) => {
    try {
      await invoke("nearby_rename", { name });
      await get().refresh();
    } catch (e) {
      set({ error: message(e) });
    }
  },

  unpair: async (deviceId) => {
    // Captured before the removal, because afterwards there is nothing left to read it from.
    const name = get().status?.peers.find((p) => p.deviceId === deviceId)?.name ?? "That device";
    try {
      // Rust reports whether it managed to tell the other device. A peer that was off keeps its own
      // pin and will go on listing this one until someone unpairs there too — worth saying, because
      // the symptom over there is a handshake failure that looks like a network fault.
      const told = await invoke<boolean>("nearby_unpair", { deviceId });
      if (!told) {
        get().setNotice(
          `${name} was forgotten here, but it wasn't reachable to be told. It will still show this ` +
            `device as paired until you forget it there too.`,
        );
      }
      await get().refresh();
      return told;
    } catch (e) {
      set({ error: message(e) });
      return false;
    }
  },

  setNotice: (notice) => {
    set({ notice });
    if (noticeTimer !== null) clearTimeout(noticeTimer);
    if (notice === null) return;
    // Long enough to read twice. Not a modal, because nothing needs deciding — the local half of
    // the unpair has already happened either way.
    noticeTimer = setTimeout(() => set({ notice: null }), 12000);
  },

  beginHosting: async () => {
    try {
      const code = await invoke<string>("nearby_begin_pairing");
      set({ pairing: { kind: "hosting", code }, error: null });
    } catch (e) {
      set({ error: message(e) });
    }
  },

  beginJoining: (target) => set({ pairing: { kind: "joining", target }, error: null }),

  beginManualJoin: (host) => {
    // Typed by hand when multicast is blocked — guest and hotel networks routinely drop it while
    // still allowing direct connections, so this has to work with discovery finding nothing.
    const [addr, port] = host.includes(":") ? host.split(":") : [host, ""];
    set({
      pairing: {
        kind: "joining",
        target: {
          deviceId: "",
          name: addr,
          addr,
          addrs: [host],
          port: Number(port) || 0,
          certPrefix: "",
          // Nothing is known about a device typed by hand until it answers. Both fields are
          // cosmetic and are replaced by what the peer reports once pairing succeeds.
          sharing: false,
          platform: "desktop",
        },
      },
      error: null,
    });
  },

  submitCode: async (code) => {
    const stage = get().pairing;
    if (stage.kind !== "joining") return;
    const { target } = stage;
    set({ pairing: { kind: "working" }, error: null });
    try {
      const outcome = await invoke<{ name: string; fingerprint: string }>("nearby_pair", {
        addrs: target.addrs,
        port: target.port,
        code,
      });
      set({ pairing: { kind: "confirm", name: outcome.name, fingerprint: outcome.fingerprint } });
      await get().refresh();
    } catch (e) {
      // Back to the code entry so a mistyped code can be corrected without starting over.
      set({ pairing: { kind: "joining", target }, error: message(e) });
    }
  },

  cancelPairing: async () => {
    try {
      await invoke("nearby_cancel_pairing");
    } catch {
      // Cancelling is best-effort; the window expires on its own regardless.
    }
    set({ pairing: { kind: "idle" } });
  },

  dismissConfirmation: () => {
    set({ pairing: { kind: "idle" } });
    // Clear it on the backend too, or the next status poll would re-open the screen the user just
    // dismissed. Strictly ordered: refreshing before the ack lands would read the stale notice and
    // do exactly that.
    void (async () => {
      try {
        await invoke("nearby_ack_pairing");
      } catch {
        // Nothing to recover; the notice is cosmetic once the pin is stored.
      }
      await get().refresh();
    })();
  },

  browse: async (deviceId, name, path) => {
    set({ browsing: { deviceId, name, path }, loadingEntries: true, error: null });
    try {
      const listing = await invoke<{ entries: RemoteEntry[]; skipped: number }>("nearby_list", {
        deviceId,
        path,
      });
      set({ entries: listing.entries, skipped: listing.skipped ?? 0, loadingEntries: false });
    } catch (e) {
      set({ entries: [], skipped: 0, loadingEntries: false, error: message(e) });
    }
  },

  closeBrowser: () => set({ browsing: null, entries: [], skipped: 0 }),

  noteFetch: (docId, note) =>
    set((st) => ({ fetches: { ...st.fetches, [docId]: note } })),

  refetch: async (docId) => {
    set({ error: null });
    try {
      await invoke("nearby_fetch", { docId, force: true });
      set((st) => ({
        fetches: { ...st.fetches, [docId]: { ...st.fetches[docId], stale: false } },
      }));
      await get().refreshCache();
    } catch (e) {
      set({ error: message(e) });
    }
  },

  refreshCache: async () => {
    try {
      set({ cached: await invoke<CachedDoc[]>("nearby_cache_list") });
    } catch (e) {
      set({ error: message(e) });
    }
  },

  setPinned: async (docId, pinned) => {
    // Pinning a document that has never been opened downloads it, so this can take a while and has
    // to show progress like any other transfer.
    set({ error: null });
    try {
      await invoke("nearby_pin", { docId, pinned });
      await get().refreshCache();
    } catch (e) {
      set({ error: message(e) });
    }
  },

  forget: async (docId) => {
    try {
      await invoke("nearby_cache_remove", { docId });
      await get().refreshCache();
    } catch (e) {
      set({ error: message(e) });
    }
  },

  send: async (deviceId, path) => {
    set({ sending: true, error: null });
    try {
      const outcome = await invoke<{ name: string }>("nearby_push", { deviceId, path });
      return outcome.name;
    } catch (e) {
      set({ error: message(e) });
      return null;
    } finally {
      set({ sending: false });
      clearTransfer(path);
    }
  },

  cancel: async (key) => {
    try {
      await invoke("nearby_cancel", { docId: key });
    } catch {
      // The transfer may already have finished; there is nothing useful to say about that.
    }
  },

  setInbox: async () => {
    try {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked !== "string") return;
      await invoke("nearby_set_inbox", { path: picked });
      await get().refresh();
    } catch (e) {
      set({ error: message(e) });
    }
  },

  syncWith: async (deviceId) => {
    const status = get().status;
    if (!status) return;
    const peer = status.peers.find((p) => p.deviceId === deviceId);

    set({ syncingWith: deviceId, error: null });
    try {
      // Nothing may be read from or written to the stores until they have loaded from disk — see
      // `whenStoresReady`. Syncing seconds after launch is exactly when a user would do it.
      await whenStoresReady();

      // Anything still keyed by an absolute path is re-keyed first, or a document annotated before
      // the folder was shared would sync as a different document from the same file afterwards.
      migrateDocKeys(keyContextOf(status));

      const documents = collectState();
      // Publishing first means a peer that syncs towards US finds current state rather than
      // whatever was there when the app started.
      await publishOwnState(true);

      const outcome = await invoke<{
        documents: Record<string, DocState>;
        skewMs: number;
        clockSuspect: boolean;
      }>("nearby_sync_state", { deviceId, payload: { documents } });

      applyRemoteState(outcome.documents);

      set((st) => ({
        lastSync: {
          ...st.lastSync,
          [deviceId]: {
            deviceName: peer?.name ?? "that device",
            // Only real documents. The settings blob rides the same map under a reserved key, and
            // counting it made an empty sync report "1 document" — which reads as a failure to show
            // something rather than as there being nothing to show.
            documents: Object.keys(outcome.documents).filter(isShareableKey).length,
            clockWarning: outcome.clockSuspect
              ? `That device's clock is ${describeSkew(outcome.skewMs)}. Where the same annotation ` +
                `was edited on both, the wrong one may have won — check anything that looks off.`
              : null,
            at: Date.now(),
          },
        },
      }));
    } catch (e) {
      set({ error: message(e) });
    } finally {
      set({ syncingWith: null });
    }
  },

  syncSettingsFrom: async (deviceId) => {
    set({ syncingWith: deviceId, error: null });
    try {
      await whenStoresReady();
      const mine = syncableSettings(useSettings.getState());
      // Settings ride the same channel as reading state under a reserved key. A separate endpoint
      // would be a second thing to version, for one small object.
      await publishOwnState(true);
      const outcome = await invoke<{ documents: Record<string, unknown> }>("nearby_sync_state", {
        deviceId,
        payload: { documents: { [SETTINGS_KEY]: mine } },
      });

      const theirs = outcome.documents[SETTINGS_KEY] as SyncableSettings | undefined;
      if (theirs) useSettings.getState().applyRemoteSettings(theirs);
    } catch (e) {
      set({ error: message(e) });
    } finally {
      set({ syncingWith: null });
    }
  },
}));

/**
 * Where settings live in the state map. Prefixed so it can never collide with a doc key — a device
 * id is sixteen hex characters, so no real key starts with an underscore.
 */
const SETTINGS_KEY = "_settings";

const keyContextOf = (status: NearbyStatus | null): KeyContext => ({
  deviceId: status?.deviceId ?? null,
  shareRoot: status?.shareRoot ?? null,
});

/*
 * Hand Rust our current reading state and preferences, so a peer that pulls from us gets something
 * current rather than whatever existed at startup.
 *
 * Zustand replaces these object references on every mutation, so comparing references is an exact
 * and free dirty-check — this runs on a three-second poll, and re-serialising every annotation in
 * the library each time would be wasteful for nothing.
 */
let published: { byFile: unknown; deleted: unknown; positions: unknown; settingsAt: number } | null =
  null;

async function publishOwnState(force = false): Promise<void> {
  // Publishing an un-hydrated store would tell a peer this device has almost nothing, and the peer
  // would believe it. The subscriptions below re-run this the moment hydration completes.
  if (!useAnnotations.getState().hydrated || !useSettings.getState().hydrated) return;

  const annotations = useAnnotations.getState();
  const settings = useSettings.getState();
  const signature = {
    byFile: annotations.byFile,
    deleted: annotations.deleted,
    positions: settings.lastPositions,
    settingsAt: settings.settingsUpdatedAt,
  };
  if (
    !force &&
    published &&
    published.byFile === signature.byFile &&
    published.deleted === signature.deleted &&
    published.positions === signature.positions &&
    published.settingsAt === signature.settingsAt
  ) {
    return;
  }

  const documents: Record<string, unknown> = collectState();
  documents[SETTINGS_KEY] = syncableSettings(settings);
  try {
    await invoke("nearby_publish_state", { payload: { documents } });
    published = signature;
  } catch {
    // Nearby may not be initialised yet; the next refresh will try again.
  }
}

/**
 * Take whatever peers have pushed and merge it in.
 *
 * This is the other half of a sync: the device that presses the button reads its peer directly, but
 * the peer only learns about the initiator's work through what was pushed to it. Collecting here
 * means both devices converge, rather than each having to press the button in turn.
 */
/**
 * Resolve once both stores have finished loading from disk.
 *
 * Everything to do with syncing has to wait for this. Reading the annotation store early publishes
 * an almost-empty set, so a peer learns nothing — but the serious half is writing: `hydrate` replaces
 * `byFile` wholesale, so a merge that lands before it finishes is silently thrown away. Neither
 * failure reports anything; the sync says "success" and the work is gone.
 */
function whenStoresReady(): Promise<void> {
  const ready = () => useAnnotations.getState().hydrated && useSettings.getState().hydrated;
  if (ready()) return Promise.resolve();

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done || !ready()) return;
      done = true;
      stopAnnotations();
      stopSettings();
      resolve();
    };
    const stopAnnotations = useAnnotations.subscribe(finish);
    const stopSettings = useSettings.subscribe(finish);
    // One store may have hydrated between the check above and these subscriptions.
    finish();
  });
}

async function collectPushedState(): Promise<void> {
  await whenStoresReady();
  try {
    const documents = await invoke<Record<string, DocState>>("nearby_take_received");
    if (Object.keys(documents).length > 0) applyRemoteState(documents);
  } catch {
    // Nearby may not be initialised; the next refresh will try again.
  }
}

/*
 * Publish whenever reading state changes, not only while the Devices panel happens to be open.
 *
 * A peer syncing towards this device reads what was last published. Tying that to panel visibility
 * meant a device with its panel closed served nothing — so a sync reported success and exchanged
 * nothing, which is the worst possible failure for something whose job is not to lose work.
 *
 * Guarded on `status` so it stays inert for anyone who has never used Nearby: no publish, no
 * `init()`, and therefore still no certificate generated and no port bound.
 */
let publishTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePublish() {
  if (publishTimer !== null) return;
  publishTimer = setTimeout(() => {
    publishTimer = null;
    if (useDevices.getState().status) void publishOwnState();
  }, 1500);
}

useAnnotations.subscribe(schedulePublish);
useSettings.subscribe(schedulePublish);

/*
 * Bring Nearby up once at startup, but only for a device that has used it before.
 *
 * `nearbyContext` is persisted, so it is the honest test for "this user pairs devices" — and it is
 * only readable after settings hydrate, hence waiting for that rather than running at import.
 * Without this the desktop serves nothing until someone opens the Devices panel, which is exactly
 * the state that made a sync silently exchange nothing.
 */
let startupChecked = false;
const stopStartupWatch = useSettings.subscribe((s) => {
  if (startupChecked || !s.hydrated) return;
  startupChecked = true;
  stopStartupWatch();
  if (s.nearbyContext?.deviceId) void useDevices.getState().refresh();
});

/** This device's reading state, for every document another device could name. */
function collectState(): Record<string, DocState> {
  const { byFile, deleted } = useAnnotations.getState();
  const { lastPositions } = useSettings.getState();

  const documents: Record<string, DocState> = {};
  const keys = new Set([
    ...Object.keys(byFile),
    ...Object.keys(deleted),
    ...Object.keys(lastPositions),
  ]);

  for (const key of keys) {
    // Documents outside every shared folder are skipped rather than sent: the other device could
    // not name them, and their paths would leak this one's directory layout.
    if (!isShareableKey(key)) continue;
    const annotations = byFile[key] ?? [];
    const tombstones = deleted[key] ?? {};
    const position = lastPositions[key];
    if (annotations.length === 0 && Object.keys(tombstones).length === 0 && !position) continue;
    documents[key] = { annotations, deleted: tombstones, position };
  }
  return documents;
}

/** Fold a peer's state into ours. One merge and one undo step for the whole exchange. */
function applyRemoteState(documents: Record<string, DocState>) {
  const annotations: Record<string, { annotations: Annotation[]; deleted: Record<string, number> }> =
    {};
  const positions: Record<string, { page: number; at?: number }> = {};

  for (const [key, state] of Object.entries(documents)) {
    // Never let a peer invent keys of its own shape — `_settings` and anything path-like are
    // handled elsewhere or not at all, and must not become documents.
    if (!isShareableKey(key)) continue;
    annotations[key] = { annotations: state.annotations ?? [], deleted: state.deleted ?? {} };
    if (state.position) positions[key] = state.position;
  }

  useAnnotations.getState().mergeAll(annotations);
  useSettings.getState().mergePositions(positions);
}

/**
 * Move annotations and positions from absolute paths onto doc keys.
 *
 * Runs before every sync rather than once at startup, because the answer changes the moment the user
 * picks a folder to share — and a document annotated before that point must not end up with two
 * separate sets of annotations afterwards.
 */
function migrateDocKeys(ctx: KeyContext) {
  if (!ctx.deviceId || !ctx.shareRoot) return;

  const annotations = useAnnotations.getState();
  const byFile = rekey(annotations.byFile, ctx, (a, b) => {
    // Two paths for one document: keep both sets, preferring the newer copy of any shared id.
    const seen = new Map(a.map((x) => [x.id, x]));
    for (const x of b) {
      const existing = seen.get(x.id);
      if (!existing || (x.updatedAt ?? 0) > (existing.updatedAt ?? 0)) seen.set(x.id, x);
    }
    return [...seen.values()];
  });
  const deleted = rekey(annotations.deleted, ctx, (a, b) => {
    const out = { ...a };
    for (const [id, at] of Object.entries(b)) out[id] = Math.max(out[id] ?? 0, at);
    return out;
  });

  const settings = useSettings.getState();
  const lastPositions = rekey(settings.lastPositions, ctx, (a, b) =>
    (b.at ?? 0) > (a.at ?? 0) ? b : a,
  );

  // Through the stores' own actions, so the re-keyed data reaches disk. A bare `setState` would
  // leave memory and `annotations.json` disagreeing until the next unrelated edit happened to save.
  useAnnotations.getState().rekeyAll(byFile, deleted);
  useSettings.getState().setPositions(lastPositions);
}

function describeSkew(skewMs: number): string {
  const minutes = Math.round(Math.abs(skewMs) / 60000);
  const amount = minutes >= 60 ? `${Math.round(minutes / 60)} hours` : `${minutes} minutes`;
  return skewMs > 0 ? `${amount} ahead of this one` : `${amount} behind this one`;
}

/*
 * Transfer progress arrives as a Rust event rather than a command result, because a command does not
 * return until it finishes — which is precisely when progress stops being interesting.
 *
 * The listener is registered once at module load and never torn down. It is process-wide state, and
 * attaching it to a component would mean progress only being tracked while that component happened
 * to be mounted — the opposite of what a background transfer needs.
 */
interface ProgressEvent {
  docId: string;
  received: number;
  total: number;
  direction: "download" | "upload";
}

const labelFor = (key: string) => key.split(/[\\/]/).pop() ?? key;

/** Drop a finished transfer after a moment, so a completed bar is visible before it disappears. */
function clearTransfer(key: string) {
  setTimeout(() => {
    useDevices.setState((st) => {
      if (!st.transfers[key]) return st;
      const transfers = { ...st.transfers };
      delete transfers[key];
      return { transfers };
    });
  }, 1200);
}

/**
 * How much of the previous rate estimate survives each new sample.
 *
 * Chunks arrive unevenly — a burst of eight over the loopback, then a stall behind a slow radio —
 * so the instantaneous rate swings by an order of magnitude between events. Smoothing hard is what
 * makes the number readable; the cost is that it takes a second or two to reflect a real change,
 * which for a figure a human is glancing at is the right trade.
 */
const RATE_SMOOTHING = 0.75;

void listen<ProgressEvent>("nearby://progress", ({ payload }) => {
  const now = Date.now();
  useDevices.setState((st) => {
    const previous = st.transfers[payload.docId];
    // Sub-100ms gaps are dominated by scheduling noise, so they are folded into the next sample
    // rather than producing an absurd rate.
    const elapsed = previous ? now - previous.sampledAt : 0;
    const moved = previous ? payload.received - previous.sampledBytes : 0;
    const usable = previous && elapsed >= 100 && moved > 0;
    const instant = usable ? (moved * 1000) / elapsed : 0;

    return {
      transfers: {
        ...st.transfers,
        [payload.docId]: {
          key: payload.docId,
          label: labelFor(payload.docId),
          received: payload.received,
          total: payload.total,
          direction: payload.direction,
          rate: usable
            ? previous.rate > 0
              ? previous.rate * RATE_SMOOTHING + instant * (1 - RATE_SMOOTHING)
              : instant
            : (previous?.rate ?? 0),
          sampledAt: usable ? now : (previous?.sampledAt ?? now),
          sampledBytes: usable ? payload.received : (previous?.sampledBytes ?? payload.received),
        },
      },
    };
  });
  if (payload.total > 0 && payload.received >= payload.total) clearTransfer(payload.docId);
});

/** The `bode://` id for an entry in a device's shared folder. */
export const docIdFor = (deviceId: string, rel: string) => formatDocId(deviceId, rel);

/** Parent of a browse path, or null at the root. */
export const parentPath = (path: string): string | null => {
  if (path === "") return null;
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "" : path.slice(0, cut);
};

/**
 * "just now" / "4 min ago". Coarse on purpose — the exact second is never the question.
 *
 * Lives here with the other formatters rather than in `ui.tsx`: a module that exports both
 * components and plain functions cannot be Fast Refreshed, so every edit to a button reloaded the
 * whole panel's state during development.
 */
export function relativeTime(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** "2.4 MB/s". Empty while no rate is known yet, so the caller can simply omit it. */
export function formatRate(bytesPerSecond: number): string {
  if (!(bytesPerSecond > 0)) return "";
  return `${formatSize(bytesPerSecond)}/s`;
}

/**
 * Roughly how long is left. Deliberately coarse: a figure that ticks 41s, 39s, 44s reads as broken,
 * so anything over a minute rounds to whole minutes and anything under ten seconds stops counting.
 */
export function formatRemaining(bytesLeft: number, bytesPerSecond: number): string {
  if (!(bytesPerSecond > 0) || bytesLeft <= 0) return "";
  const seconds = Math.round(bytesLeft / bytesPerSecond);
  if (seconds <= 10) return "almost done";
  if (seconds < 60) return `${Math.round(seconds / 5) * 5}s left`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} min left`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
