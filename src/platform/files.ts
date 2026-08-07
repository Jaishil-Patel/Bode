import { invoke } from "@tauri-apps/api/core";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { baseNameOf, isRemote } from "./docId";
import { useDevices } from "../devices/useDevices";

/*
 * Cross-platform PDF byte I/O.
 *
 * Real filesystem paths (desktop, and the Android cache files MainActivity writes for "Open with"
 * launches) go through the custom `read_file_bytes`/`write_file_bytes` commands, which use std::fs
 * directly with no fs-scope wiring.
 *
 * `content://` URIs (what Android's file picker / share sheet hand back) can't be opened by std::fs,
 * so they go through the fs plugin, which resolves them via the Android content resolver. Files
 * chosen through the dialog are granted to the fs scope at runtime.
 *
 * `bode://` ids name a document on a paired device. Those are fetched into the local cache by Rust
 * and then read back as an ordinary local path, so the remote case collapses into the local one
 * after a single extra step. All networking lives in Rust: the webview never opens a socket, which
 * is why Bode's CSP needs no `connect-src` for this and why a peer's self-signed certificate — which
 * a webview would refuse outright — is never the webview's problem.
 */
export const isAndroid = () => /android/i.test(navigator.userAgent);

// Android content-resolver URIs need the fs plugin; everything else is a real path for std::fs.
const isContentUri = (path: string) => path.startsWith("content://");

/** Where a remote document ended up locally, and how it got there. Mirrors Rust's `Fetched`. */
export interface Fetched {
  path: string;
  /** The peer was not asked for bytes — the cached copy revalidated, or we are offline. */
  fromCache: boolean;
  /** The peer has a newer version we deliberately did not take. Only ever true for a pinned copy. */
  stale: boolean;
  pinned: boolean;
  /** We served a cached copy because the device could not be reached. */
  offline: boolean;
}

/**
 * Bring a paired device's document onto this filesystem and report what happened.
 *
 * `force` skips revalidation and re-downloads — what the "Update" action on a stale pinned document
 * calls. Everything else about staleness is decided in Rust, which is the only side that knows what
 * is cached.
 */
export async function fetchRemote(docId: string, force = false): Promise<Fetched> {
  const fetched = await invoke<Fetched>("nearby_fetch", { docId, force });
  // Recorded here rather than returned up the chain because `readPdfBytes` has one job and a dozen
  // callers, none of which should have to learn about staleness to keep working. The store is where
  // the banner reads it from.
  useDevices.getState().noteFetch(docId, fetched);
  return fetched;
}

/** Ask an in-flight transfer to stop. Takes effect at the next chunk boundary. */
export async function cancelTransfer(docId: string): Promise<void> {
  await invoke("nearby_cancel", { docId });
}

export async function readPdfBytes(path: string): Promise<Uint8Array> {
  // A document on a paired device is fetched into the local cache first, then read back through the
  // ordinary local path below. Doing it this way — rather than streaming bytes over IPC — means
  // every caller downstream (PDF.js, the Markdown reader, the annotated-PDF export) is unchanged.
  if (isRemote(path)) {
    const fetched = await fetchRemote(path);
    return await readPdfBytes(fetched.path);
  }
  if (isContentUri(path)) return await readFile(path);
  const raw = await invoke<number[] | Uint8Array>("read_file_bytes", { path });
  return raw instanceof Uint8Array ? raw : Uint8Array.from(raw);
}

/** Read a text file (e.g. Markdown) as a UTF-8 string, via the same path-or-content-URI plumbing. */
export async function readTextFile(path: string): Promise<string> {
  const bytes = await readPdfBytes(path);
  return new TextDecoder("utf-8").decode(bytes);
}

export async function writePdfBytes(path: string, bytes: Uint8Array): Promise<void> {
  // Writing back to a paired device is not supported yet. Without this guard the id would fall
  // through to `write_file_bytes` and create a local file literally named `bode:` — a silent
  // corruption rather than a refusal.
  if (isRemote(path)) {
    throw new Error(
      `"${baseNameOf(path)}" is on another device and can't be saved in place yet. ` +
        `Use Save as to keep a copy here.`,
    );
  }
  if (isContentUri(path)) {
    await writeFile(path, bytes);
    return;
  }
  await invoke("write_file_bytes", { path, bytes: Array.from(bytes) });
}

/** Write a string back to a text file (e.g. saving an edited Markdown file) as UTF-8. */
export async function writeTextFile(path: string, text: string): Promise<void> {
  await writePdfBytes(path, new TextEncoder().encode(text));
}
