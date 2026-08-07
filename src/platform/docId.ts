/*
 * Document identity, local and remote.
 *
 * A local document is identified by its filesystem path, or by a `content://` URI on Android. A
 * document that lives on a paired device is identified by a `bode://` id:
 *
 *   bode://<device-id>/<url-encoded relative posix path>
 *   bode://d7f3a91c4b2e8a01/Papers/Fluid%20Mechanics.pdf
 *
 * The path is relative to the share root the owning device chose, never absolute. That keeps the
 * peer's real paths off the wire, and it makes the server's containment check a structural join
 * (root + rel, canonicalize, verify) rather than a comparison against a path the client supplied.
 *
 * Encoding is per SEGMENT — separators stay literal `/`. Decoding therefore has to re-check that a
 * segment didn't smuggle a separator or a traversal step back in through `%2F` or `%2E%2E`; the
 * Rust side repeats the same check, since neither side may trust the other.
 */

export const REMOTE_SCHEME = "bode://";

export interface RemoteDoc {
  deviceId: string;
  /** Share-root-relative, posix-separated, decoded. */
  relPath: string;
}

/** True for a document that lives on a paired device rather than this filesystem. */
export const isRemote = (id: string): boolean => id.startsWith(REMOTE_SCHEME);

/**
 * A path segment is unsafe if it is empty, a traversal step, or still contains a separator or NUL
 * after decoding — the cases `%2F`, `%5C`, `%2E%2E` and `%00` would otherwise slip past.
 */
const isUnsafeSegment = (s: string): boolean =>
  s === "" || s === "." || s === ".." || /[\\/\0]/.test(s);

/** Build a `bode://` id from a device and a share-root-relative path. */
export function formatDocId(deviceId: string, relPath: string): string {
  const segments = relPath
    .split(/[\\/]/)
    .filter((s) => s !== "")
    .map(encodeURIComponent);
  return `${REMOTE_SCHEME}${deviceId}/${segments.join("/")}`;
}

/** Parse a `bode://` id, or null if it is malformed or tries to escape the share root. */
export function parseDocId(id: string): RemoteDoc | null {
  if (!isRemote(id)) return null;

  const rest = id.slice(REMOTE_SCHEME.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;

  const deviceId = rest.slice(0, slash);
  const rawSegments = rest.slice(slash + 1).split("/");
  if (rawSegments.length === 0) return null;

  const segments: string[] = [];
  for (const raw of rawSegments) {
    if (raw === "") continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return null; // malformed percent-escape
    }
    if (isUnsafeSegment(decoded)) return null;
    segments.push(decoded);
  }
  if (segments.length === 0) return null;

  return { deviceId, relPath: segments.join("/") };
}

/** The owning device of a remote document, or null when the id is local. */
export const deviceIdOf = (id: string): string | null => parseDocId(id)?.deviceId ?? null;

/** The share-root-relative path of a remote document, or null when the id is local. */
export const relPathOf = (id: string): string | null => parseDocId(id)?.relPath ?? null;

/**
 * A human- and parser-friendly path for an id: remote ids collapse to their decoded relative path,
 * local ids pass through untouched. Anything sniffing an extension or a file name should read this
 * rather than the raw id, so percent-escapes never reach the UI or `kindForPath`.
 */
export function displayPathOf(id: string): string {
  return parseDocId(id)?.relPath ?? id;
}

/**
 * File name for display, correct for local paths, `content://` URIs and `bode://` ids alike.
 *
 * Decoding is deliberately NOT applied to plain filesystem paths: a local file may legitimately be
 * named `my%20file.pdf`, and decoding it would show the wrong name. Only the two forms that are
 * genuinely percent-encoded get decoded.
 */
export function baseNameOf(id: string): string {
  const remote = parseDocId(id);
  if (remote) {
    // `parseDocId` has already decoded each segment.
    const last = remote.relPath.split("/").pop() ?? "";
    return last === "" ? "document" : last;
  }

  const last = id.split(/[\\/]/).pop() ?? "";
  if (last === "") return "document";
  if (id.startsWith("content://")) {
    try {
      return decodeURIComponent(last);
    } catch {
      return last;
    }
  }
  return last;
}
