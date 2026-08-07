/*
 * The Tauri command surface for Nearby, and the only place the frontend touches this module.
 *
 * All networking stays on this side of the IPC boundary. The webview never opens a socket, which is
 * what lets Bode's CSP stay exactly as strict as it was — and is also the only workable option,
 * since a webview will not accept the self-signed certificate a LAN peer must present.
 *
 * Everything is initialised lazily: a user who never opens the Devices panel never gets a
 * certificate generated or a port bound.
 */

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use super::cache::{Cache, CacheMeta, TRANSIENT_LIMIT_BYTES};
use super::client::{Listing, PeerClient, StateBundle};
use super::discovery::{socket_addr, Discovered, Discovery};
use super::docid;
use super::identity::{now_millis, sha256_hex, Identity, Peer};
use super::server::{bind, run_accept_loop, ShareState};
use super::tls::{client_config, pairing_client_config, server_config, TrustStore};

/// Pairing codes are six digits: enough to make an online guess hopeless within the 3-minute window
/// and the 5-attempt limit, short enough to read aloud.
const CODE_DIGITS: u32 = 6;

/// Bytes sent per push request. Matches the server's read chunk so neither side buffers a whole
/// document, and so a failed transfer resumes from the last whole chunk rather than from zero.
const PUSH_CHUNK: u64 = 8 * 1024 * 1024;

/// Folder created under the share root to receive documents from a phone.
const INBOX_FOLDER: &str = "Received";

/// Beyond this much clock difference, timestamps from the other device cannot be ordered against
/// ours and last-write-wins becomes a coin toss — so the user is told rather than quietly losing an
/// edit. Five minutes is far more than NTP drift and far less than a wrong time zone.
const MAX_CLOCK_SKEW_MS: u64 = 5 * 60 * 1000;

pub struct Nearby(Mutex<Option<Inner>>);

impl Default for Nearby {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

struct Inner {
    identity: Arc<Mutex<Identity>>,
    trust: Arc<TrustStore>,
    share: Arc<ShareState>,
    discovery: Arc<Discovery>,
    client: Arc<PeerClient>,
    cache: Arc<Cache>,
    /// Document ids whose transfer the user has asked to stop. The transfer loop checks this
    /// between chunks — which is why chunking is what makes cancel possible at all, rather than
    /// leaving the user watching a single unstoppable request.
    cancelled: Arc<Mutex<HashSet<String>>>,
    port: Option<u16>,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    device_id: String,
    name: String,
    sharing: bool,
    port: Option<u16>,
    share_root: Option<String>,
    /// Where a peer's pushed documents land, or `None` when this device accepts none.
    inbox: Option<String>,
    /// Set when a device has just paired WITH this one, so the host can show the fingerprint too.
    last_pairing: Option<super::server::PairingNotice>,
    peers: Vec<PeerView>,
    discovered: Vec<Discovered>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerView {
    device_id: String,
    name: String,
    added_at: u64,
    /// Whether this peer is currently visible on the network.
    online: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairOutcome {
    device_id: String,
    name: String,
    /// Show this to the user on BOTH devices; matching values are what rule out a man in the middle.
    fingerprint: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    doc_id: String,
    received: u64,
    total: u64,
    /// "download" or "upload", so one indicator can describe both directions.
    direction: &'static str,
}

/// The result of opening a remote document: where it is locally, and how it got there.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fetched {
    pub path: String,
    /// True when the peer was never contacted for bytes — either the cached copy revalidated, or
    /// the device is unreachable and we fell back to what we had.
    pub from_cache: bool,
    /// True when the peer holds a newer version that we deliberately did not take. Only happens for
    /// a pinned document, where replacing the bytes under an annotation set is the user's call.
    pub stale: bool,
    pub pinned: bool,
    /// True when we served a cached copy because the device could not be reached.
    pub offline: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedDoc {
    pub doc_id: String,
    pub device_id: String,
    pub name: String,
    pub rel: String,
    pub size: u64,
    pub pinned: bool,
    pub fetched_at: u64,
    pub used_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushOutcome {
    /// The name the receiving device chose, which may differ from ours if it had one already.
    pub name: String,
    pub bytes: u64,
    /// Where to browse to it, when the peer's inbox sits inside its shared folder.
    pub doc_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    /// What the peer holds, for the frontend to merge into its own store.
    pub documents: HashMap<String, serde_json::Value>,
    /// Milliseconds the peer's clock is ahead of (positive) or behind (negative) ours.
    pub skew_ms: i64,
    /// True when the skew is large enough that ordering two devices' edits is unreliable.
    pub clock_suspect: bool,
}

#[derive(Deserialize)]
pub struct StatePayload {
    pub documents: HashMap<String, serde_json::Value>,
}

fn init(app: &AppHandle, nearby: &Nearby) -> Result<(), String> {
    let mut guard = nearby.0.lock().map_err(|_| "Nearby state unavailable")?;
    if guard.is_some() {
        return Ok(());
    }

    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Cannot locate config directory: {e}"))?;
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Cannot locate cache directory: {e}"))?;
    // Documents kept offline go here instead. The OS reclaims the cache directory under storage
    // pressure, so "keep offline" would be a promise it could break.
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot locate data directory: {e}"))?;

    let identity = Identity::load_or_create(&config_dir, &default_device_name())?;
    let trust = Arc::new(TrustStore::default());
    trust.sync_from(&identity);

    let tls_client = client_config(&identity, Arc::clone(&trust))?;
    let discovery = Arc::new(Discovery::start()?);
    discovery.browse(identity.device_id.clone())?;

    let identity = Arc::new(Mutex::new(identity));
    *guard = Some(Inner {
        share: Arc::new(ShareState::new(Arc::clone(&identity), Arc::clone(&trust))),
        identity,
        trust,
        discovery,
        client: Arc::new(PeerClient::new(tls_client)),
        cache: Arc::new(Cache::new(cache_dir.join("nearby"), data_dir.join("nearby"))),
        cancelled: Arc::new(Mutex::new(HashSet::new())),
        port: None,
        shutdown: None,
    });
    Ok(())
}

fn default_device_name() -> String {
    #[cfg(target_os = "android")]
    {
        "Android phone".to_string()
    }
    #[cfg(not(target_os = "android"))]
    {
        std::env::var("COMPUTERNAME")
            .or_else(|_| std::env::var("HOSTNAME"))
            .unwrap_or_else(|_| "This computer".to_string())
    }
}

/// Six digits from the OS random source. `rand` is deliberately not a dependency — ring's system
/// randomness is already in the tree via rustls.
fn pairing_code() -> Result<String, String> {
    use ring::rand::SecureRandom;
    let mut bytes = [0u8; 4];
    ring::rand::SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| "Cannot generate a pairing code".to_string())?;
    let value = u32::from_be_bytes(bytes) % 10u32.pow(CODE_DIGITS);
    Ok(format!("{value:0width$}", width = CODE_DIGITS as usize))
}

#[tauri::command]
pub async fn nearby_status(app: AppHandle, nearby: State<'_, Nearby>) -> Result<Status, String> {
    init(&app, &nearby)?;
    let guard = nearby.0.lock().map_err(|_| "Nearby state unavailable")?;
    let inner = guard.as_ref().ok_or("Nearby not initialised")?;

    let discovered = inner.discovery.found();
    let identity = inner.identity.lock().map_err(|_| "Identity unavailable")?;

    let peers = identity
        .peers()
        .iter()
        .map(|p| PeerView {
            online: discovered.iter().any(|d| d.device_id == p.device_id),
            device_id: p.device_id.clone(),
            name: p.name.clone(),
            added_at: p.added_at,
        })
        .collect();

    let share_root = inner
        .share
        .root
        .lock()
        .ok()
        .and_then(|r| r.as_ref().map(|p| p.to_string_lossy().to_string()));
    let inbox = inner
        .share
        .inbox
        .lock()
        .ok()
        .and_then(|r| r.as_ref().map(|p| p.to_string_lossy().to_string()));

    Ok(Status {
        device_id: identity.device_id.clone(),
        name: identity.name.clone(),
        sharing: inner.port.is_some(),
        port: inner.port,
        share_root,
        inbox,
        last_pairing: inner.share.last_pairing.lock().ok().and_then(|n| n.clone()),
        peers,
        discovered,
    })
}

/// Start sharing a folder. Binding happens here, on an explicit user action, so the Windows Firewall
/// prompt is causally attached to a click rather than appearing at startup out of nowhere.
#[tauri::command]
pub async fn nearby_start_sharing(
    app: AppHandle,
    nearby: State<'_, Nearby>,
    root: String,
) -> Result<u16, String> {
    init(&app, &nearby)?;

    let path = PathBuf::from(&root);
    if !path.is_dir() {
        return Err(format!("{root} is not a folder"));
    }

    let (share, tls, identity_bits, discovery) = {
        let guard = nearby.0.lock().map_err(|_| "Nearby state unavailable")?;
        let inner = guard.as_ref().ok_or("Nearby not initialised")?;
        let mut identity = inner.identity.lock().map_err(|_| "Identity unavailable")?;
        // Remembered so the share survives a restart. Without this, every launch silently stops
        // sharing while still looking paired from the other device — which is indistinguishable
        // from a broken connection.
        identity.set_share_root(Some(path.clone()))?;
        (
            Arc::clone(&inner.share),
            server_config(&identity, Arc::clone(&inner.trust))?,
            (identity.device_id.clone(), identity.name.clone(), identity.cert_sha256.clone()),
            Arc::clone(&inner.discovery),
        )
    };

    // Documents a phone sends land in a subfolder of the shared one, so they show up in the same
    // browser the user is already looking at rather than somewhere they have to be told about.
    // Created lazily — an empty folder appearing in someone's Documents before anything is sent
    // would be clutter.
    share.set_inbox(Some(path.join(INBOX_FOLDER)));
    share.set_share_root(Some(path));

    let listener = bind(0).await?;
    let port = listener.local_addr().map_err(|e| format!("No local address: {e}"))?.port();
    super::trace!("sharing on port {port}");
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();

    tauri::async_runtime::spawn(async move {
        let _ = run_accept_loop(listener, share, tls, shutdown_rx).await;
    });

    let (device_id, name, cert_sha256) = identity_bits;
    let cert_prefix = cert_sha256.get(..16).unwrap_or(&cert_sha256).to_string();
    discovery.advertise(&device_id, &name, port, &cert_prefix)?;

    let mut guard = nearby.0.lock().map_err(|_| "Nearby state unavailable")?;
    if let Some(inner) = guard.as_mut() {
        // Replace any previous server rather than leaving it bound to an orphaned port.
        if let Some(previous) = inner.shutdown.take() {
            let _ = previous.send(());
        }
        inner.port = Some(port);
        inner.shutdown = Some(shutdown_tx);
    }
    Ok(port)
}

#[tauri::command]
pub async fn nearby_stop_sharing(nearby: State<'_, Nearby>) -> Result<(), String> {
    let mut guard = nearby.0.lock().map_err(|_| "Nearby state unavailable")?;
    if let Some(inner) = guard.as_mut() {
        if let Some(shutdown) = inner.shutdown.take() {
            let _ = shutdown.send(());
        }
        // Turning sharing off is a decision, not a crash, so forget the folder — otherwise the next
        // launch would quietly start sharing again something the user chose to stop sharing.
        if let Ok(mut identity) = inner.identity.lock() {
            let _ = identity.set_share_root(None);
        }
        inner.discovery.stop_advertising();
        inner.share.set_share_root(None);
        // Stop accepting pushes too: sharing off should mean nothing can write here either.
        inner.share.set_inbox(None);
        inner.share.close_pairing();
        inner.port = None;
    }
    Ok(())
}

/// Open a pairing window on the sharing device and return the code to display.
#[tauri::command]
pub async fn nearby_begin_pairing(nearby: State<'_, Nearby>) -> Result<String, String> {
    let code = pairing_code()?;
    let guard = nearby.0.lock().map_err(|_| "Nearby state unavailable")?;
    let inner = guard.as_ref().ok_or("Turn on sharing first")?;
    if inner.port.is_none() {
        return Err("Turn on sharing before adding a device".to_string());
    }
    inner.share.open_pairing(code.clone())?;
    Ok(code)
}

#[tauri::command]
pub async fn nearby_cancel_pairing(nearby: State<'_, Nearby>) -> Result<(), String> {
    let guard = nearby.0.lock().map_err(|_| "Nearby state unavailable")?;
    if let Some(inner) = guard.as_ref() {
        inner.share.close_pairing();
    }
    Ok(())
}

/// Clear the "a device just paired" notice once the user has compared the fingerprint.
#[tauri::command]
pub async fn nearby_ack_pairing(nearby: State<'_, Nearby>) -> Result<(), String> {
    let guard = nearby.0.lock().map_err(|_| "Nearby state unavailable")?;
    if let Some(inner) = guard.as_ref() {
        if let Ok(mut notice) = inner.share.last_pairing.lock() {
            *notice = None;
        }
    }
    Ok(())
}

/// Pair with a device by address. `addr` may come from discovery or be typed by hand, which is the
/// fallback whenever multicast is blocked.
#[tauri::command]
pub async fn nearby_pair(
    app: AppHandle,
    nearby: State<'_, Nearby>,
    addrs: Vec<String>,
    port: u16,
    code: String,
) -> Result<PairOutcome, String> {
    init(&app, &nearby)?;

    let (client, device_id, name, our_fingerprint) = {
        let guard = nearby.0.lock().map_err(|_| "Nearby state unavailable")?;
        let inner = guard.as_ref().ok_or("Nearby not initialised")?;
        let identity = inner.identity.lock().map_err(|_| "Identity unavailable")?;
        (
            // A throwaway client that accepts the peer's not-yet-known certificate. The ordinary
            // one cannot be used: it only trusts pinned certificates, and the whole purpose of this
            // call is to LEARN one. Using a separate config rather than relaxing the shared trust
            // store keeps this device's own server strict while the exchange is in flight.
            PeerClient::new(pairing_client_config(&identity)?),
            identity.device_id.clone(),
            identity.name.clone(),
            identity.cert_sha256.clone(),
        )
    };

    // The peer is not pinned yet, so `resolve_peer` cannot help here — it looks the device up among
    // the paired ones. Probe the advertised addresses directly for the same reason it does: a
    // multi-homed desktop advertises virtual adapters that nothing outside it can reach.
    let target = first_reachable(&addrs, port).await?;

    let (response, peer_cert) = client.pair(target, &device_id, &name, &code).await?;
    let their_fingerprint = sha256_hex(&peer_cert);

    // Both devices independently derive this from the two certificates; the user comparing them is
    // what rules out someone sitting in the middle of the first exchange.
    let fingerprint = super::identity::pair_fingerprint(&our_fingerprint, &their_fingerprint);
    if fingerprint != response.fingerprint {
        return Err("Security check failed — the two devices disagree. Do not continue.".to_string());
    }

    let guard = nearby.0.lock().map_err(|_| "Nearby state unavailable")?;
    let inner = guard.as_ref().ok_or("Nearby not initialised")?;
    let mut identity = inner.identity.lock().map_err(|_| "Identity unavailable")?;
    identity.add_peer(Peer {
        device_id: response.device_id.clone(),
        name: response.name.clone(),
        cert_sha256: their_fingerprint,
        added_at: now_millis(),
        // The address that actually answered, not the whole advertised list — this is the fallback
        // used when mDNS goes quiet, so it should be one known to have worked.
        last_addr: Some(target.to_string()),
    })?;
    inner.trust.sync_from(&identity);

    Ok(PairOutcome {
        device_id: response.device_id,
        name: response.name,
        fingerprint,
    })
}

#[tauri::command]
pub async fn nearby_unpair(nearby: State<'_, Nearby>, device_id: String) -> Result<(), String> {
    let guard = nearby.0.lock().map_err(|_| "Nearby state unavailable")?;
    let inner = guard.as_ref().ok_or("Nearby not initialised")?;
    let mut identity = inner.identity.lock().map_err(|_| "Identity unavailable")?;
    identity.remove_peer(&device_id)?;
    // Trust is consulted per handshake, so this takes effect on the peer's next connection.
    inner.trust.sync_from(&identity);
    // Their documents go too, pinned ones included. Copies that outlive the trust that justified
    // holding them are exactly what "remove this device" is meant to prevent.
    inner.cache.forget_device(&device_id);
    Ok(())
}

#[tauri::command]
pub async fn nearby_rename(nearby: State<'_, Nearby>, name: String) -> Result<(), String> {
    let guard = nearby.0.lock().map_err(|_| "Nearby state unavailable")?;
    let inner = guard.as_ref().ok_or("Nearby not initialised")?;
    let mut identity = inner.identity.lock().map_err(|_| "Identity unavailable")?;
    identity.set_name(name)
}

#[tauri::command]
pub async fn nearby_list(
    app: AppHandle,
    nearby: State<'_, Nearby>,
    device_id: String,
    path: String,
) -> Result<Listing, String> {
    init(&app, &nearby)?;
    let (client, addr) = resolve_peer(&nearby, &device_id).await?;
    let listing = client.list(addr, &path).await;
    // Whether a listing came back — and how much was in it — is the difference between "the wrong
    // folder is shared", "the request failed" and "it worked", which are indistinguishable from an
    // empty panel. Paths are not logged; only counts.
    match &listing {
        Ok(l) => super::trace!("listed {} entries, {} skipped", l.entries.len(), l.skipped),
        Err(e) => super::trace!("listing failed: {e}"),
    }
    listing
}

/// Fetch a remote document into the local cache and return where it landed.
///
/// This is the whole of the frontend seam: `files.ts` calls it for a `bode://` id and then reads the
/// returned path through its existing local branch, so every caller downstream is unchanged.
///
/// The order of the checks is the interesting part:
///
/// 1. A cached copy is revalidated with a single HEAD. Matching tag, no transfer.
/// 2. If the peer cannot be reached but we have a copy, that copy is used. Being on a train is not
///    a reason to be unable to read a document already sitting on the disk.
/// 3. If the peer has newer bytes and the copy is PINNED, the old copy is kept and reported stale.
///    Silently swapping the bytes under an annotation set would move every highlight on the page.
/// 4. Otherwise, download.
#[tauri::command]
pub async fn nearby_fetch(
    app: AppHandle,
    nearby: State<'_, Nearby>,
    doc_id: String,
    force: Option<bool>,
) -> Result<Fetched, String> {
    init(&app, &nearby)?;

    let (device_id, rel) = docid::parse(&doc_id).ok_or("Not a valid device document")?;
    let (cache, cancelled) = {
        let guard = nearby.0.lock().map_err(|_| "Nearby state unavailable")?;
        let inner = guard.as_ref().ok_or("Nearby not initialised")?;
        (Arc::clone(&inner.cache), Arc::clone(&inner.cancelled))
    };

    let existing = cache.find(&device_id, &rel);
    let pinned = existing.as_ref().map(|e| e.meta.pinned).unwrap_or(false);
    let force = force.unwrap_or(false);

    // Reaching the peer is itself allowed to fail: the cache is what makes that survivable.
    let peer = resolve_peer(&nearby, &device_id).await;
    let (client, addr) = match peer {
        Ok(peer) => peer,
        Err(message) => {
            let Some(entry) = existing else { return Err(message) };
            cache.touch(&entry);
            return Ok(Fetched {
                path: entry.file().to_string_lossy().to_string(),
                from_cache: true,
                stale: false,
                pinned: entry.meta.pinned,
                offline: true,
            });
        }
    };

    if let Some(entry) = &existing {
        if !force {
            match client.etag(addr, &rel).await {
                Ok(etag) if etag == entry.meta.etag && !etag.is_empty() => {
                    super::trace!("{} is unchanged; opening the local copy", docid::base_name(&rel));
                    cache.touch(entry);
                    return Ok(Fetched {
                        path: entry.file().to_string_lossy().to_string(),
                        from_cache: true,
                        stale: false,
                        pinned,
                        offline: false,
                    });
                }
                Ok(_) if pinned => {
                    // Newer bytes exist, but this document was kept offline deliberately. Report it
                    // and let the user press Update rather than moving their annotations for them.
                    cache.touch(entry);
                    return Ok(Fetched {
                        path: entry.file().to_string_lossy().to_string(),
                        from_cache: true,
                        stale: true,
                        pinned,
                        offline: false,
                    });
                }
                Ok(_) => {}
                Err(e) => {
                    // The device answered discovery but not this request. Prefer what we have.
                    super::trace!("could not revalidate ({e}); using the saved copy");
                    cache.touch(entry);
                    return Ok(Fetched {
                        path: entry.file().to_string_lossy().to_string(),
                        from_cache: true,
                        stale: false,
                        pinned,
                        offline: true,
                    });
                }
            }
        }
    }

    clear_cancel(&cancelled, &doc_id);
    let folder = cache.prepare(&device_id, &rel, pinned)?;
    let name = docid::base_name(&rel).to_string();
    let destination = folder.join(&name);
    let partial = folder.join(format!("{name}.part"));

    let mut received: u64 = 0;
    let mut buffer: Vec<u8> = Vec::new();
    // Unknown until the first response tells us; a document of length 0 is legitimately complete.
    let mut total: Option<u64> = None;
    let mut etag = String::new();

    loop {
        if is_cancelled(&cancelled, &doc_id) {
            clear_cancel(&cancelled, &doc_id);
            let _ = std::fs::remove_file(&partial);
            return Err("Transfer cancelled".to_string());
        }

        let chunk = client.fetch(addr, &rel, received).await?;
        // Fixed by the first response and not revisited: a peer that changed the length mid-transfer
        // would either be confused or trying something, and neither deserves to be followed.
        let expected = *total.get_or_insert(chunk.total);
        if etag.is_empty() {
            etag = chunk.etag.clone();
        } else if !chunk.etag.is_empty() && chunk.etag != etag {
            // The document changed while we were reading it. Half of each version is not a document.
            return Err("That document changed while it was being copied. Try again.".to_string());
        }
        if chunk.bytes.is_empty() {
            break;
        }
        received += chunk.bytes.len() as u64;
        buffer.extend_from_slice(&chunk.bytes);

        let _ = app.emit(
            "nearby://progress",
            Progress {
                doc_id: doc_id.clone(),
                received,
                total: expected,
                direction: "download",
            },
        );

        if received >= expected {
            break;
        }
    }

    // A short transfer must fail loudly: a truncated PDF that silently "opens" is worse than an
    // error, because the damage only shows up as a corrupt document later.
    if let Some(expected) = total {
        if received != expected {
            return Err(format!("Transfer incomplete: got {received} of {expected} bytes"));
        }
    }

    super::trace!("downloaded {name} ({received} bytes)");

    // Write aside and rename, so a cancelled or crashed transfer never leaves a truncated file
    // sitting where a complete one is expected.
    std::fs::write(&partial, &buffer).map_err(|e| format!("Cannot write cache file: {e}"))?;
    std::fs::rename(&partial, &destination).map_err(|e| format!("Cannot finish download: {e}"))?;

    let now = now_millis();
    cache.write_meta(
        &folder,
        &CacheMeta {
            device_id: device_id.clone(),
            rel: rel.clone(),
            name,
            etag,
            size: received,
            fetched_at: now,
            used_at: now,
            pinned,
        },
    )?;

    // Only the transient root is bounded; pinned documents are the user's explicit promise.
    cache.evict(TRANSIENT_LIMIT_BYTES);

    Ok(Fetched {
        path: destination.to_string_lossy().to_string(),
        from_cache: false,
        stale: false,
        pinned,
        offline: false,
    })
}

/// Ask an in-flight transfer to stop. Takes effect at the next chunk boundary.
#[tauri::command]
pub async fn nearby_cancel(nearby: State<'_, Nearby>, doc_id: String) -> Result<(), String> {
    let guard = nearby.0.lock().map_err(|_| "Nearby state unavailable")?;
    if let Some(inner) = guard.as_ref() {
        if let Ok(mut cancelled) = inner.cancelled.lock() {
            cancelled.insert(doc_id);
        }
    }
    Ok(())
}

/// Keep a document available offline, or stop doing so. Moves the bytes between the reclaimable
/// cache directory and the durable data directory — see `cache.rs` for why that is not a flag.
#[tauri::command]
pub async fn nearby_pin(
    app: AppHandle,
    nearby: State<'_, Nearby>,
    doc_id: String,
    pinned: bool,
) -> Result<String, String> {
    init(&app, &nearby)?;
    let (device_id, rel) = docid::parse(&doc_id).ok_or("Not a valid device document")?;
    let cache = {
        let guard = nearby.0.lock().map_err(|_| "Nearby state unavailable")?;
        Arc::clone(&guard.as_ref().ok_or("Nearby not initialised")?.cache)
    };

    // Pinning something never opened would otherwise fail; fetch it first so "keep offline" works
    // straight from a listing.
    if cache.find(&device_id, &rel).is_none() {
        if !pinned {
            return Err("That document is not downloaded".to_string());
        }
        nearby_fetch(app, nearby.clone(), doc_id.clone(), Some(false)).await?;
    }

    let path = cache.set_pinned(&device_id, &rel, pinned)?;
    Ok(path.to_string_lossy().to_string())
}

/// Everything held locally from paired devices, newest use first.
#[tauri::command]
pub async fn nearby_cache_list(
    app: AppHandle,
    nearby: State<'_, Nearby>,
) -> Result<Vec<CachedDoc>, String> {
    init(&app, &nearby)?;
    let cache = {
        let guard = nearby.0.lock().map_err(|_| "Nearby state unavailable")?;
        Arc::clone(&guard.as_ref().ok_or("Nearby not initialised")?.cache)
    };

    let mut docs: Vec<CachedDoc> = cache
        .entries()
        .into_iter()
        .map(|e| CachedDoc {
            doc_id: docid::format(&e.meta.device_id, &e.meta.rel),
            device_id: e.meta.device_id,
            name: e.meta.name,
            rel: e.meta.rel,
            size: e.meta.size,
            pinned: e.meta.pinned,
            fetched_at: e.meta.fetched_at,
            used_at: e.meta.used_at,
        })
        .collect();
    docs.sort_by(|a, b| b.used_at.cmp(&a.used_at));
    Ok(docs)
}

/// Remove one cached document, pinned or not. An explicit request, so it ignores the pin.
#[tauri::command]
pub async fn nearby_cache_remove(
    app: AppHandle,
    nearby: State<'_, Nearby>,
    doc_id: String,
) -> Result<(), String> {
    init(&app, &nearby)?;
    let (device_id, rel) = docid::parse(&doc_id).ok_or("Not a valid device document")?;
    let cache = {
        let guard = nearby.0.lock().map_err(|_| "Nearby state unavailable")?;
        Arc::clone(&guard.as_ref().ok_or("Nearby not initialised")?.cache)
    };
    cache.remove(&device_id, &rel)
}

/// Send a local document to a paired device's inbox.
#[tauri::command]
pub async fn nearby_push(
    app: AppHandle,
    nearby: State<'_, Nearby>,
    device_id: String,
    path: String,
) -> Result<PushOutcome, String> {
    init(&app, &nearby)?;

    let source = PathBuf::from(&path);
    let bytes = std::fs::read(&source).map_err(|e| format!("Cannot read that document: {e}"))?;
    let proposed = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("That document has no usable name")?
        .to_string();

    let (client, addr) = resolve_peer(&nearby, &device_id).await?;
    let cancelled = {
        let guard = nearby.0.lock().map_err(|_| "Nearby state unavailable")?;
        Arc::clone(&guard.as_ref().ok_or("Nearby not initialised")?.cancelled)
    };
    clear_cancel(&cancelled, &path);

    let total = bytes.len() as u64;
    let mut offset: u64 = 0;
    // The receiver names the file; from the second chunk on we quote back whatever it chose.
    let mut name = proposed;
    let mut rel: Option<String> = None;

    loop {
        if is_cancelled(&cancelled, &path) {
            clear_cancel(&cancelled, &path);
            return Err("Transfer cancelled".to_string());
        }

        let end = total.min(offset + PUSH_CHUNK);
        let slice = bytes
            .get(offset as usize..end as usize)
            .ok_or("Internal error slicing the document")?
            .to_vec();

        let complete = {
            let ack = client.push(addr, &name, offset, total, slice).await?;
            name = ack.name;
            offset = ack.received;
            let complete = ack.complete || offset >= total;
            // Only meaningful once the document is whole, so it is taken at that point rather than
            // being carried and overwritten each round.
            if complete {
                rel = ack.rel;
            }
            complete
        };

        let _ = app.emit(
            "nearby://progress",
            Progress { doc_id: path.clone(), received: offset, total, direction: "upload" },
        );

        if complete {
            break;
        }
    }

    Ok(PushOutcome {
        name,
        bytes: total,
        doc_id: rel.map(|r| docid::format(&device_id, &r)),
    })
}

/// Choose where documents pushed by a peer land. Passing `None` stops accepting them.
#[tauri::command]
pub async fn nearby_set_inbox(
    app: AppHandle,
    nearby: State<'_, Nearby>,
    path: Option<String>,
) -> Result<(), String> {
    init(&app, &nearby)?;
    let folder = match path {
        Some(path) => {
            let folder = PathBuf::from(path);
            std::fs::create_dir_all(&folder)
                .map_err(|e| format!("Cannot use that folder: {e}"))?;
            Some(folder)
        }
        None => None,
    };
    let guard = nearby.0.lock().map_err(|_| "Nearby state unavailable")?;
    guard.as_ref().ok_or("Nearby not initialised")?.share.set_inbox(folder);
    Ok(())
}

/// Publish this device's reading state so a peer can pull it. The frontend owns the annotation
/// model, so it hands the shape over rather than Rust reconstructing it.
#[tauri::command]
pub async fn nearby_publish_state(
    app: AppHandle,
    nearby: State<'_, Nearby>,
    payload: StatePayload,
) -> Result<(), String> {
    init(&app, &nearby)?;
    let guard = nearby.0.lock().map_err(|_| "Nearby state unavailable")?;
    let inner = guard.as_ref().ok_or("Nearby not initialised")?;
    let mut held = inner.share.published.lock().map_err(|_| "State unavailable")?;
    for (key, value) in payload.documents {
        held.insert(key, value);
    }
    Ok(())
}

/// Collect and clear whatever peers have pushed to this device.
///
/// Draining rather than reading: once the frontend has merged an entry, leaving it here would mean
/// re-merging the same stale snapshot on every poll, indefinitely overriding newer local edits.
#[tauri::command]
pub async fn nearby_take_received(
    app: AppHandle,
    nearby: State<'_, Nearby>,
) -> Result<HashMap<String, serde_json::Value>, String> {
    init(&app, &nearby)?;
    let guard = nearby.0.lock().map_err(|_| "Nearby state unavailable")?;
    let inner = guard.as_ref().ok_or("Nearby not initialised")?;
    let mut inbox = inner.share.received.lock().map_err(|_| "State unavailable")?;
    Ok(std::mem::take(&mut *inbox))
}

/// Exchange reading state with a peer: push ours for the given documents, then take back theirs.
///
/// Both directions in one command because a sync that only pushed would leave the two devices
/// disagreeing until the other one happened to sync back, which users read as "it didn't work".
#[tauri::command]
pub async fn nearby_sync_state(
    app: AppHandle,
    nearby: State<'_, Nearby>,
    device_id: String,
    payload: StatePayload,
) -> Result<SyncOutcome, String> {
    init(&app, &nearby)?;
    let (client, addr) = resolve_peer(&nearby, &device_id).await?;

    let keys: Vec<String> = payload.documents.keys().cloned().collect();

    // Ask the time first: if the clocks disagree wildly, last-write-wins is meaningless and the
    // caller needs to know before it merges anything.
    let before = now_millis();
    let info = client.info(addr).await?;
    let after = now_millis();
    // Halfway through our own round trip is the fairest point to compare their clock against.
    let midpoint = before + (after.saturating_sub(before)) / 2;
    let skew_ms = info.now as i64 - midpoint as i64;

    // The counts are the whole diagnosis when a sync "works" but nothing appears: sending 0 means
    // this device has no reading state under a shared key, receiving 0 means the peer has none for
    // the documents we named. Those are different problems with the same symptom. Keys are not
    // logged — they contain the peer's file paths.
    super::trace!("syncing: sending {} document(s)", keys.len());

    // Read BEFORE writing. The two directions now use separate maps on the peer, so the order is no
    // longer load-bearing — but reading first is still the honest sequence, and it means a failed
    // push cannot leave us having overwritten state we never managed to read.
    let theirs = client.get_state(addr, &keys).await?;
    client.put_state(addr, &StateBundle { documents: payload.documents }).await?;

    super::trace!("syncing: received {} document(s), clock skew {skew_ms}ms", theirs.documents.len());

    Ok(SyncOutcome {
        documents: theirs.documents,
        skew_ms,
        clock_suspect: skew_ms.unsigned_abs() > MAX_CLOCK_SKEW_MS,
    })
}

/// Resume sharing the folder this device was sharing when it last closed.
///
/// Called once at launch. It reads `identity.json` FIRST and returns immediately if no folder was
/// ever shared — which keeps the laziness that matters: a user who has never used Nearby still gets
/// no certificate generated, no port bound, and no firewall prompt.
///
/// Anyone who HAS shared already answered that prompt, and expects the folder they chose to still be
/// shared. Making them re-pick it on every launch is the kind of small wrongness that reads as the
/// feature being broken.
pub fn restore_sharing(app: &AppHandle) {
    let Ok(config_dir) = app.path().app_config_dir() else { return };
    // A cheap existence check before doing anything that would create an identity.
    if !config_dir.join("identity.json").is_file() {
        return;
    }
    let Ok(identity) = Identity::load_or_create(&config_dir, &default_device_name()) else {
        return;
    };
    let Some(root) = identity.share_root() else { return };
    drop(identity);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let nearby = app.state::<Nearby>();
        if let Err(e) = nearby_start_sharing(
            app.clone(),
            nearby,
            root.to_string_lossy().to_string(),
        )
        .await
        {
            super::trace!("could not resume sharing: {e}");
        }
    });
}

/// Stop everything Nearby is running, in order: the accept loop, then the mDNS daemon.
///
/// Called from the app's `Exit` event. Nothing here may assume the state was ever initialised — a
/// user who never opened the Devices panel has no daemon and no listener to stop.
pub fn shutdown(nearby: &State<'_, Nearby>) {
    let Ok(mut guard) = nearby.0.lock() else { return };
    let Some(inner) = guard.as_mut() else { return };

    if let Some(stop) = inner.shutdown.take() {
        let _ = stop.send(());
    }
    inner.discovery.shutdown();
    inner.port = None;
}

fn is_cancelled(cancelled: &Mutex<HashSet<String>>, key: &str) -> bool {
    cancelled.lock().map(|c| c.contains(key)).unwrap_or(false)
}

fn clear_cancel(cancelled: &Mutex<HashSet<String>>, key: &str) {
    if let Ok(mut cancelled) = cancelled.lock() {
        cancelled.remove(key);
    }
}

/// How long to wait for one candidate address before trying the next. Short: these are all on the
/// local network, where a reachable host answers in single-digit milliseconds and an unreachable
/// one usually fails instantly. The timeout only covers the case that black-holes instead.
const PROBE_TIMEOUT_MS: u64 = 700;

/// Every address a peer might be at: whatever mDNS currently advertises, then the one that last
/// worked. Order is preference order.
fn peer_candidates(
    nearby: &State<'_, Nearby>,
    device_id: &str,
) -> Result<(Arc<PeerClient>, Vec<std::net::SocketAddr>), String> {
    let guard = nearby.0.lock().map_err(|_| "Nearby state unavailable")?;
    let inner = guard.as_ref().ok_or("Nearby not initialised")?;

    let mut candidates: Vec<std::net::SocketAddr> = Vec::new();
    if let Some(found) = inner.discovery.found().into_iter().find(|d| d.device_id == device_id) {
        for addr in &found.addrs {
            if let Ok(socket) = socket_addr(addr, found.port) {
                candidates.push(socket);
            }
        }
    }

    let identity = inner.identity.lock().map_err(|_| "Identity unavailable")?;
    let peer = identity
        .peers()
        .iter()
        .find(|p| p.device_id == device_id)
        .ok_or("That device is not paired with this one")?;

    // The last address that worked is tried after anything currently advertised, so a device that
    // moved networks is still reachable if mDNS is being blocked.
    if let Some(last) = peer.last_addr.as_ref() {
        if let Some((addr, port)) = last.rsplit_once(':') {
            if let Ok(port) = port.parse::<u16>() {
                if let Ok(socket) = socket_addr(addr, port) {
                    if !candidates.contains(&socket) {
                        candidates.push(socket);
                    }
                }
            }
        }
    }

    if candidates.is_empty() {
        return Err("That device isn't on this network right now".to_string());
    }
    Ok((Arc::clone(&inner.client), candidates))
}

/// The first of `addrs` that accepts a TCP connection on `port`.
async fn first_reachable(addrs: &[String], port: u16) -> Result<std::net::SocketAddr, String> {
    let mut parsed: Vec<std::net::SocketAddr> = Vec::new();
    for addr in addrs {
        // A typed address may carry its own port; honour it over the advertised one.
        let socket = match addr.rsplit_once(':') {
            Some((host, p)) if p.parse::<u16>().is_ok() && !host.is_empty() => {
                socket_addr(host, p.parse().unwrap_or(port))
            }
            _ => socket_addr(addr, port),
        };
        if let Ok(socket) = socket {
            parsed.push(socket);
        }
    }
    if parsed.is_empty() {
        return Err("No usable address for that device".to_string());
    }
    if parsed.len() == 1 {
        return Ok(parsed[0]);
    }

    for addr in &parsed {
        let attempt = tokio::time::timeout(
            std::time::Duration::from_millis(PROBE_TIMEOUT_MS),
            tokio::net::TcpStream::connect(addr),
        )
        .await;
        if matches!(attempt, Ok(Ok(_))) {
            super::trace!("pairing against {addr}");
            return Ok(*addr);
        }
        super::trace!("no answer at {addr} while pairing");
    }
    Err(format!(
        "Couldn't reach that device. Tried {}.",
        parsed.iter().map(|a| a.to_string()).collect::<Vec<_>>().join(", ")
    ))
}

/// Pick the address a peer actually answers on.
///
/// A plain TCP connect is used to choose, not the real request: probing has no side effects, so
/// walking the list cannot push a document twice or half-apply a sync. Once one answers, everything
/// else this call does goes to that address.
async fn resolve_peer(
    nearby: &State<'_, Nearby>,
    device_id: &str,
) -> Result<(Arc<PeerClient>, std::net::SocketAddr), String> {
    let (client, candidates) = peer_candidates(nearby, device_id)?;

    // One candidate is the common case; skip the probe and let the real request report the error,
    // which is more specific than "could not connect".
    if candidates.len() == 1 {
        return Ok((client, candidates[0]));
    }

    // An address already known to work this session is used directly. Probing every time meant a
    // throwaway TCP connection before every listing, fetch and sync — wasteful, and each one looks
    // to the far end like a client that connected and vanished.
    if let Some(known) = working_address(&candidates) {
        return Ok((client, known));
    }

    for addr in &candidates {
        let attempt = tokio::time::timeout(
            std::time::Duration::from_millis(PROBE_TIMEOUT_MS),
            tokio::net::TcpStream::connect(addr),
        )
        .await;
        if matches!(attempt, Ok(Ok(_))) {
            super::trace!("reached {device_id} at {addr}");
            remember_address(*addr);
            return Ok((client, *addr));
        }
        super::trace!("no answer from {device_id} at {addr}");
    }

    Err(format!(
        "Couldn't reach that device. Tried {}.",
        candidates.iter().map(|a| a.to_string()).collect::<Vec<_>>().join(", ")
    ))
}

/// Addresses that answered a probe this session.
///
/// Not persisted and not authoritative: it is only consulted when the address is still among the
/// candidates mDNS is currently advertising, so a device that moves or restarts on a new port falls
/// straight back to probing rather than being remembered wrongly.
static REACHED: Mutex<Vec<std::net::SocketAddr>> = Mutex::new(Vec::new());

fn working_address(candidates: &[std::net::SocketAddr]) -> Option<std::net::SocketAddr> {
    let reached = REACHED.lock().ok()?;
    candidates.iter().find(|a| reached.contains(a)).copied()
}

fn remember_address(addr: std::net::SocketAddr) {
    if let Ok(mut reached) = REACHED.lock() {
        if !reached.contains(&addr) {
            // Bounded: a long session on a flaky network must not accumulate addresses forever.
            if reached.len() >= 16 {
                reached.remove(0);
            }
            reached.push(addr);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_codes_are_six_digits() {
        for _ in 0..200 {
            let code = pairing_code().expect("generate");
            assert_eq!(code.len(), 6, "got {code}");
            assert!(code.chars().all(|c| c.is_ascii_digit()), "got {code}");
        }
    }

    #[test]
    fn pairing_codes_are_not_all_identical() {
        let first = pairing_code().expect("generate");
        // A constant code would be catastrophic and is exactly the kind of thing a stub introduces.
        assert!(
            (0..50).any(|_| pairing_code().unwrap_or_default() != first),
            "codes must vary"
        );
    }
}
