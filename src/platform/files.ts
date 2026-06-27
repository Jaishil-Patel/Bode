import { invoke } from "@tauri-apps/api/core";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";

/*
 * Cross-platform PDF byte I/O.
 *
 * Desktop: the custom `read_file_bytes`/`write_file_bytes` commands read/write any absolute path
 * via std::fs — needed for recents and file-association launches that never go through a dialog,
 * and so we don't have to wire a broad static fs scope.
 *
 * Android: the file picker hands back `content://` URIs that std::fs cannot open, so we go through
 * the fs plugin, which resolves them via the Android content resolver. Files chosen through the
 * dialog are granted to the fs scope at runtime.
 */
export const isAndroid = () => /android/i.test(navigator.userAgent);

export async function readPdfBytes(path: string): Promise<Uint8Array> {
  if (isAndroid()) return await readFile(path);
  const raw = await invoke<number[] | Uint8Array>("read_file_bytes", { path });
  return raw instanceof Uint8Array ? raw : Uint8Array.from(raw);
}

/** Read a text file (e.g. Markdown) as a UTF-8 string, via the same path-or-content-URI plumbing. */
export async function readTextFile(path: string): Promise<string> {
  const bytes = await readPdfBytes(path);
  return new TextDecoder("utf-8").decode(bytes);
}

export async function writePdfBytes(path: string, bytes: Uint8Array): Promise<void> {
  if (isAndroid()) {
    await writeFile(path, bytes);
    return;
  }
  await invoke("write_file_bytes", { path, bytes: Array.from(bytes) });
}

/** Write a string back to a text file (e.g. saving an edited Markdown file) as UTF-8. */
export async function writeTextFile(path: string, text: string): Promise<void> {
  await writePdfBytes(path, new TextEncoder().encode(text));
}
