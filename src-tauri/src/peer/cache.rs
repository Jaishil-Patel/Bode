/*
 * The local copy of a peer's documents.
 *
 * Two roots, and the split is load-bearing rather than tidy-minded:
 *
 *   transient  app_cache_dir()/nearby/…   the OS may delete this at any time
 *   durable    app_data_dir()/nearby/…    the OS never touches it
 *
 * On Android the system empties the cache directory whenever storage runs low, so a document the
 * user asked to "keep offline" cannot live there — the promise would quietly stop being true on
 * exactly the day it mattered. Pinning therefore MOVES the entry between the two roots rather than
 * setting a flag in place.
 *
 * Within a root, an entry is `<device-id>/<sha256(rel)[..16]>/` holding the document under its real
 * name plus a `meta.json`. Hashing the relative path avoids recreating the peer's directory tree —
 * which on Windows would reintroduce the 260-character path limit the peer already worked around —
 * while the real file name is kept so save dialogs and tab titles have something to show.
 */

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::identity::{now_millis, sha256_hex};

/// How much unpinned cache to keep before evicting least-recently-used entries. Pinned entries live
/// in the other root and are never counted or evicted.
pub const TRANSIENT_LIMIT_BYTES: u64 = 512 * 1024 * 1024;

const META_FILE: &str = "meta.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheMeta {
    pub device_id: String,
    /// Share-root-relative path on the owning device.
    pub rel: String,
    /// File name as stored on disk here.
    pub name: String,
    /// The peer's `size-mtime` tag at the time we fetched. Revalidation compares against this.
    pub etag: String,
    pub size: u64,
    pub fetched_at: u64,
    /// Last time this was opened, which is what eviction sorts on.
    pub used_at: u64,
    pub pinned: bool,
}

pub struct Cache {
    transient: PathBuf,
    durable: PathBuf,
}

/// A located cache entry: where its folder is, and what we know about it.
pub struct Entry {
    pub folder: PathBuf,
    pub meta: CacheMeta,
}

impl Entry {
    pub fn file(&self) -> PathBuf {
        self.folder.join(&self.meta.name)
    }
}

impl Cache {
    pub fn new(transient: PathBuf, durable: PathBuf) -> Self {
        Self { transient, durable }
    }

    fn root_for(&self, pinned: bool) -> &Path {
        if pinned {
            &self.durable
        } else {
            &self.transient
        }
    }

    fn folder_in(root: &Path, device_id: &str, rel: &str) -> PathBuf {
        let digest = sha256_hex(rel.as_bytes());
        // `sha256_hex` always returns 64 characters, but slicing is done defensively so a future
        // change to that function can never panic inside a spawned task.
        let short = digest.get(..16).unwrap_or(&digest).to_string();
        root.join(device_id).join(short)
    }

    /// Find an existing entry. Durable is checked first: if a document was somehow present in both
    /// roots, the pinned copy is the one the user asked to keep.
    pub fn find(&self, device_id: &str, rel: &str) -> Option<Entry> {
        for pinned in [true, false] {
            let folder = Self::folder_in(self.root_for(pinned), device_id, rel);
            if let Some(meta) = read_meta(&folder) {
                // A meta file whose document has vanished (an OS cache sweep takes the bytes, and
                // may leave the folder) is not an entry — treat it as a miss and re-fetch.
                if folder.join(&meta.name).is_file() {
                    return Some(Entry { folder, meta });
                }
            }
        }
        None
    }

    /// The folder a fresh download should be written into.
    pub fn prepare(&self, device_id: &str, rel: &str, pinned: bool) -> Result<PathBuf, String> {
        let folder = Self::folder_in(self.root_for(pinned), device_id, rel);
        std::fs::create_dir_all(&folder).map_err(|e| format!("Cannot create cache folder: {e}"))?;
        Ok(folder)
    }

    pub fn write_meta(&self, folder: &Path, meta: &CacheMeta) -> Result<(), String> {
        let body = serde_json::to_vec_pretty(meta).map_err(|e| format!("Cannot encode: {e}"))?;
        std::fs::write(folder.join(META_FILE), body).map_err(|e| format!("Cannot record: {e}"))
    }

    /// Note that an entry was just opened. Best-effort: failing to record a read is not worth
    /// failing the read itself, it only makes eviction slightly less well-informed.
    pub fn touch(&self, entry: &Entry) {
        let mut meta = entry.meta.clone();
        meta.used_at = now_millis();
        let _ = self.write_meta(&entry.folder, &meta);
    }

    /// Everything currently cached, pinned and not.
    pub fn entries(&self) -> Vec<Entry> {
        let mut out = Vec::new();
        for root in [&self.durable, &self.transient] {
            let Ok(devices) = std::fs::read_dir(root) else { continue };
            for device in devices.flatten() {
                let Ok(docs) = std::fs::read_dir(device.path()) else { continue };
                for doc in docs.flatten() {
                    let folder = doc.path();
                    if let Some(meta) = read_meta(&folder) {
                        if folder.join(&meta.name).is_file() {
                            out.push(Entry { folder, meta });
                        }
                    }
                }
            }
        }
        out
    }

    /// Move an entry between the two roots. Copy-then-remove rather than `rename`, because the cache
    /// and data directories are not guaranteed to be on the same volume and a cross-device rename
    /// fails outright.
    pub fn set_pinned(&self, device_id: &str, rel: &str, pinned: bool) -> Result<PathBuf, String> {
        let Some(entry) = self.find(device_id, rel) else {
            return Err("That document is not downloaded".to_string());
        };
        if entry.meta.pinned == pinned {
            return Ok(entry.file());
        }

        let target = Self::folder_in(self.root_for(pinned), device_id, rel);
        std::fs::create_dir_all(&target).map_err(|e| format!("Cannot create folder: {e}"))?;

        let from = entry.file();
        let to = target.join(&entry.meta.name);
        std::fs::copy(&from, &to).map_err(|e| format!("Cannot move the document: {e}"))?;

        let mut meta = entry.meta.clone();
        meta.pinned = pinned;
        meta.used_at = now_millis();
        // Written only after the bytes are safely in place: a crash between the two leaves a
        // complete copy in each root, which `find` resolves, rather than a meta file with no bytes.
        self.write_meta(&target, &meta)?;
        let _ = std::fs::remove_dir_all(&entry.folder);

        Ok(to)
    }

    pub fn remove(&self, device_id: &str, rel: &str) -> Result<(), String> {
        let Some(entry) = self.find(device_id, rel) else { return Ok(()) };
        std::fs::remove_dir_all(&entry.folder).map_err(|e| format!("Cannot remove: {e}"))
    }

    /// Drop least-recently-used unpinned entries until the transient root is under the limit.
    /// Returns how many bytes were reclaimed.
    pub fn evict(&self, limit: u64) -> u64 {
        let mut unpinned: Vec<Entry> = self.entries().into_iter().filter(|e| !e.meta.pinned).collect();
        let mut total: u64 = unpinned.iter().map(|e| e.meta.size).sum();
        if total <= limit {
            return 0;
        }

        // Oldest use first, so the document read this morning outlives the one opened in March.
        unpinned.sort_by_key(|e| e.meta.used_at);

        let mut freed = 0;
        for entry in unpinned {
            if total <= limit {
                break;
            }
            if std::fs::remove_dir_all(&entry.folder).is_ok() {
                total = total.saturating_sub(entry.meta.size);
                freed += entry.meta.size;
            }
        }
        freed
    }

    /// Forget everything cached from one device. Used when unpairing: leaving a former peer's
    /// documents sitting on disk would outlive the trust that justified having them.
    pub fn forget_device(&self, device_id: &str) {
        for root in [&self.durable, &self.transient] {
            let _ = std::fs::remove_dir_all(root.join(device_id));
        }
    }
}

fn read_meta(folder: &Path) -> Option<CacheMeta> {
    let body = std::fs::read(folder.join(META_FILE)).ok()?;
    serde_json::from_slice(&body).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_cache(tag: &str) -> (Cache, PathBuf) {
        let base = std::env::temp_dir().join(format!("bode-cache-test-{tag}-{}", now_millis()));
        let cache = Cache::new(base.join("transient"), base.join("durable"));
        (cache, base)
    }

    fn store(cache: &Cache, device: &str, rel: &str, bytes: &[u8], pinned: bool) {
        let folder = cache.prepare(device, rel, pinned).expect("prepare");
        let name = rel.rsplit('/').next().unwrap_or(rel).to_string();
        std::fs::write(folder.join(&name), bytes).expect("write");
        cache
            .write_meta(
                &folder,
                &CacheMeta {
                    device_id: device.to_string(),
                    rel: rel.to_string(),
                    name,
                    etag: "\"1-2\"".to_string(),
                    size: bytes.len() as u64,
                    fetched_at: now_millis(),
                    used_at: now_millis(),
                    pinned,
                },
            )
            .expect("meta");
    }

    #[test]
    fn an_entry_round_trips() {
        let (cache, base) = temp_cache("roundtrip");
        store(&cache, "dev1", "Papers/thesis.pdf", b"hello", false);

        let found = cache.find("dev1", "Papers/thesis.pdf").expect("found");
        assert_eq!(found.meta.size, 5);
        assert_eq!(std::fs::read(found.file()).expect("read"), b"hello");
        assert!(cache.find("dev1", "Papers/other.pdf").is_none());
        assert!(cache.find("dev2", "Papers/thesis.pdf").is_none());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn pinning_moves_the_bytes_between_roots() {
        // The point of the split: a pinned document must not sit in a directory the OS may empty.
        let (cache, base) = temp_cache("pin");
        store(&cache, "dev1", "a.pdf", b"keep me", false);

        let unpinned = cache.find("dev1", "a.pdf").expect("found").file();
        assert!(unpinned.starts_with(base.join("transient")));

        let pinned = cache.set_pinned("dev1", "a.pdf", true).expect("pin");
        assert!(pinned.starts_with(base.join("durable")), "pinned copy must be in the durable root");
        assert_eq!(std::fs::read(&pinned).expect("read"), b"keep me");
        assert!(!unpinned.exists(), "the transient copy should be gone");

        let entry = cache.find("dev1", "a.pdf").expect("still found");
        assert!(entry.meta.pinned);

        let back = cache.set_pinned("dev1", "a.pdf", false).expect("unpin");
        assert!(back.starts_with(base.join("transient")));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn eviction_drops_the_least_recently_used_and_never_the_pinned() {
        let (cache, base) = temp_cache("evict");
        store(&cache, "dev1", "old.pdf", &vec![0u8; 100], false);
        store(&cache, "dev1", "new.pdf", &vec![0u8; 100], false);
        store(&cache, "dev1", "kept.pdf", &vec![0u8; 100], true);

        // Make "old" genuinely older than "new".
        let old = cache.find("dev1", "old.pdf").expect("old");
        let mut meta = old.meta.clone();
        meta.used_at = 1;
        cache.write_meta(&old.folder, &meta).expect("rewrite");

        let freed = cache.evict(150);
        assert_eq!(freed, 100, "exactly one unpinned entry should go");
        assert!(cache.find("dev1", "old.pdf").is_none(), "the stale one should be evicted");
        assert!(cache.find("dev1", "new.pdf").is_some());
        // A pinned document is the user's explicit promise of offline access; eviction must not
        // touch it however tight the budget is.
        assert!(cache.find("dev1", "kept.pdf").is_some());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_meta_file_with_no_document_is_a_miss() {
        // Exactly what an Android cache sweep leaves behind. Trusting the meta file alone would
        // hand back a path to nothing.
        let (cache, base) = temp_cache("orphan");
        store(&cache, "dev1", "gone.pdf", b"bytes", false);
        let entry = cache.find("dev1", "gone.pdf").expect("found");
        std::fs::remove_file(entry.file()).expect("remove document");

        assert!(cache.find("dev1", "gone.pdf").is_none());
        assert!(cache.entries().is_empty());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn unpairing_forgets_only_that_devices_documents() {
        let (cache, base) = temp_cache("forget");
        store(&cache, "dev1", "a.pdf", b"a", false);
        store(&cache, "dev1", "b.pdf", b"b", true);
        store(&cache, "dev2", "c.pdf", b"c", false);

        cache.forget_device("dev1");

        assert!(cache.find("dev1", "a.pdf").is_none());
        assert!(cache.find("dev1", "b.pdf").is_none(), "pinned copies go too");
        assert!(cache.find("dev2", "c.pdf").is_some());

        let _ = std::fs::remove_dir_all(&base);
    }
}
