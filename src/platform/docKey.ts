import { parseDocId } from "./docId";

/*
 * The identity a document has across devices.
 *
 * Annotations and reading positions have always been keyed by absolute local path, which is fine on
 * one machine and useless across two: `C:\Users\jaish\Papers\thesis.pdf` and
 * `/storage/emulated/0/…/thesis.pdf` are the same document with no way to tell. A doc key is what
 * both devices can compute independently and agree on:
 *
 *   <owning device id>/<path relative to that device's share root>
 *
 * The desktop derives it from its own id and the folder it chose to share; the phone derives it from
 * the `bode://` id it was given, which already carries both halves. No hashing, no negotiation, and
 * the same answer on each side.
 *
 * A document that is not in any shared folder keeps its plain path as its key. It cannot be synced —
 * no other device can name it — and pretending otherwise would only invent collisions.
 *
 * Renaming a file still orphans its annotations. That is already true today, and fixing it properly
 * means content hashing, which means reading 200 MB to open a document. Not worth it here.
 */

export interface KeyContext {
  /** This device's id, or null before Nearby has ever been initialised. */
  deviceId: string | null;
  /** The folder this device shares, or null when it is not sharing. */
  shareRoot: string | null;
}

const toPosix = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");

/**
 * Windows paths are case-insensitive and Android's are not. Comparing case-insensitively is wrong on
 * exactly one of the two, and the failure modes are not symmetric: a false match would key two
 * different documents the same (silent data mixing), while a false miss just leaves a document
 * unsynced. Case-sensitive comparison is the one that fails safely.
 */
function relativeTo(root: string, path: string): string | null {
  const r = toPosix(root);
  const p = toPosix(path);
  if (p === r) return "";
  if (!p.startsWith(`${r}/`)) return null;
  return p.slice(r.length + 1);
}

/**
 * The cross-device key for a document, or its plain path when it is not in a shared folder.
 *
 * Note the deliberate asymmetry with `bode://` ids: a remote document's key drops the scheme and
 * keeps the DECODED relative path, so the desktop's key for its own file and the phone's key for the
 * same file are byte-identical strings.
 */
export function docKeyFor(id: string, ctx: KeyContext): string {
  const remote = parseDocId(id);
  if (remote) return `${remote.deviceId}/${remote.relPath}`;

  if (ctx.deviceId && ctx.shareRoot) {
    const rel = relativeTo(ctx.shareRoot, id);
    if (rel) return `${ctx.deviceId}/${rel}`;
  }
  return id;
}

/**
 * True for a key that names a document some device shares, and can therefore be synced.
 *
 * Checked by shape rather than by re-deriving it: a device id is sixteen lowercase hex characters,
 * which no absolute path starts with. A looser test — "contains a slash" — would call
 * `/storage/emulated/0/a.pdf` shareable and send a phone's private paths over the wire.
 */
export function isShareableKey(key: string): boolean {
  return /^[0-9a-f]{16}\/./.test(key);
}

/**
 * Re-key a record from absolute paths to doc keys, once this device knows what it shares.
 *
 * Merging rather than overwriting matters: if a user annotated a document before sharing the folder
 * and again after, both sets exist under two keys and dropping either loses real work. The caller
 * supplies how to combine them.
 */
export function rekey<T>(
  byPath: Record<string, T>,
  ctx: KeyContext,
  combine: (existing: T, incoming: T) => T,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [path, value] of Object.entries(byPath)) {
    const key = docKeyFor(path, ctx);
    const existing = out[key];
    out[key] = existing === undefined ? value : combine(existing, value);
  }
  return out;
}
