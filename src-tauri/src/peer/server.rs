/*
 * The HTTP side of Nearby.
 *
 * Every connection is mutual TLS with pinned certificates (see `tls.rs`), so by the time a request
 * reaches a handler the caller is already a known device. Which device is carried in a request
 * extension, taken from the certificate the TLS session actually used — not from anything the peer
 * claims in a header.
 *
 * Responses are bounded: no handler ever buffers a whole document. A single `/v1/file` response is
 * capped at `MAX_CHUNK`, and the client walks a large PDF with `Range` requests, which is also what
 * gives it progress and resume for free.
 *
 * Nothing here may panic — see the note in `mod.rs`.
 */

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, Request, Response, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tower::ServiceExt;

use super::identity::{now_millis, pair_fingerprint, sha256_hex, Identity, Peer};
use super::paths::{is_hidden, is_servable, resolve_in};
use super::tls::TrustStore;

/// Largest body any single response will produce. A 200 MB scan is fetched as a sequence of these.
const MAX_CHUNK: u64 = 8 * 1024 * 1024;

/// Ceiling on a pushed document. A paired device is trusted, but trust is not a reason to let one
/// fill the other's disk because of a bug at the far end.
const MAX_PUSH_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// How long a pairing window stays open, and how many wrong codes end it.
const PAIRING_WINDOW_MS: u64 = 3 * 60 * 1000;
const PAIRING_MAX_ATTEMPTS: u32 = 5;

pub struct PairingWindow {
    pub code: String,
    pub expires_at: u64,
    pub attempts_left: u32,
}

/// What the host shows after a device pairs with it: the same six characters the joiner sees.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingNotice {
    pub device_id: String,
    pub name: String,
    pub fingerprint: String,
    pub at: u64,
}

/// Everything the handlers need. One instance is shared by the whole server.
pub struct ShareState {
    pub identity: Arc<Mutex<Identity>>,
    pub trust: Arc<TrustStore>,
    pub root: Mutex<Option<PathBuf>>,
    /// Where documents pushed by a peer land. Separate from the share root because sharing is a
    /// read grant and receiving is a write grant, and the user should be able to give one without
    /// the other. `None` means this device accepts no pushes at all.
    pub inbox: Mutex<Option<PathBuf>>,
    pub pairing: Mutex<Option<PairingWindow>>,
    /// The most recent completed pairing, so the HOST can show the fingerprint too.
    ///
    /// Without this the host has no idea a pairing happened: `/v1/pair` runs on a connection task
    /// with no route back to the UI, so it would sit showing the numeric code while the joining
    /// device displayed six characters to compare against nothing.
    pub last_pairing: Mutex<Option<PairingNotice>>,
    /// THIS device's reading state, pushed down by its own frontend and served to peers.
    ///
    /// Kept strictly apart from `received` below. When both directions shared one map, a peer's
    /// `PUT` overwrote our entry for a document and its immediately-following `GET` read its own
    /// data straight back — a sync that reported success and exchanged nothing.
    pub published: Mutex<std::collections::HashMap<String, serde_json::Value>>,
    /// Reading state peers have pushed to us, waiting for our frontend to collect and merge.
    ///
    /// Never served to anyone: it is someone else's view of a document, and handing it on would
    /// make this device a conduit for state it has not merged and may disagree with.
    pub received: Mutex<std::collections::HashMap<String, serde_json::Value>>,
}

impl ShareState {
    pub fn new(identity: Arc<Mutex<Identity>>, trust: Arc<TrustStore>) -> Self {
        Self {
            identity,
            trust,
            root: Mutex::new(None),
            inbox: Mutex::new(None),
            pairing: Mutex::new(None),
            last_pairing: Mutex::new(None),
            published: Mutex::new(std::collections::HashMap::new()),
            received: Mutex::new(std::collections::HashMap::new()),
        }
    }

    fn share_root(&self) -> Option<PathBuf> {
        self.root.lock().ok().and_then(|r| r.clone())
    }

    pub fn set_share_root(&self, path: Option<PathBuf>) {
        if let Ok(mut root) = self.root.lock() {
            *root = path;
        }
    }

    fn inbox_dir(&self) -> Option<PathBuf> {
        self.inbox.lock().ok().and_then(|r| r.clone())
    }

    pub fn set_inbox(&self, path: Option<PathBuf>) {
        if let Ok(mut inbox) = self.inbox.lock() {
            *inbox = path;
        }
    }

    pub fn open_pairing(&self, code: String) -> Result<(), String> {
        let mut pairing = self.pairing.lock().map_err(|_| "pairing state unavailable")?;
        *pairing = Some(PairingWindow {
            code,
            expires_at: now_millis() + PAIRING_WINDOW_MS,
            attempts_left: PAIRING_MAX_ATTEMPTS,
        });
        self.trust.set_pairing_open(true);
        Ok(())
    }

    pub fn close_pairing(&self) {
        if let Ok(mut pairing) = self.pairing.lock() {
            *pairing = None;
        }
        self.trust.set_pairing_open(false);
    }
}

/// The certificate the peer presented, injected per connection. Handlers identify the caller from
/// this and never from a request header.
#[derive(Clone)]
struct PeerCert(Vec<u8>);

#[derive(Serialize)]
struct InfoResponse {
    device_id: String,
    name: String,
    protocol: u32,
    /// Wall clock, so a peer can detect skew before trusting any timestamp we send.
    now: u64,
    root_name: Option<String>,
    sharing: bool,
}

#[derive(Serialize)]
struct Entry {
    name: String,
    /// Share-root-relative, posix-separated. The client percent-encodes each segment itself.
    rel: String,
    kind: &'static str,
    size: u64,
    mtime: u64,
}

#[derive(Serialize)]
struct ListResponse {
    path: String,
    entries: Vec<Entry>,
    /// How many visible files were filtered out for not being document types Bode opens.
    ///
    /// A COUNT, never names: the whole point of the allowlist is that a share pointed at a home
    /// folder does not reveal what else is in it. But "empty" and "full of things you can't open"
    /// look identical from the other device, and one of those is a broken setup while the other is
    /// working exactly as intended. The number is enough to tell them apart.
    skipped: usize,
}

#[derive(Deserialize)]
struct PathQuery {
    #[serde(default)]
    path: String,
}

#[derive(Deserialize)]
struct PushQuery {
    name: String,
    #[serde(default)]
    offset: u64,
    #[serde(default)]
    total: u64,
}

#[derive(Serialize)]
struct PushResponse {
    /// The name this device actually used, which the sender must quote on every later chunk.
    name: String,
    received: u64,
    complete: bool,
    /// Where the finished document can be browsed, when the inbox is inside the shared folder.
    rel: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct StateResponse {
    /// Doc key → whatever the frontend's reading state for it looks like. Opaque here on purpose.
    documents: std::collections::HashMap<String, serde_json::Value>,
}

#[derive(Deserialize)]
struct PairRequest {
    device_id: String,
    name: String,
    code: String,
}

#[derive(Serialize)]
struct PairResponse {
    device_id: String,
    name: String,
    /// Both devices display this; the user confirming it matches is what defeats a man in the middle.
    fingerprint: String,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: &'static str,
    message: String,
}

fn fail(status: StatusCode, error: &'static str, message: &str) -> Response<Body> {
    let body = serde_json::to_vec(&ErrorResponse { error, message: message.to_string() })
        .unwrap_or_else(|_| b"{\"error\":\"internal\"}".to_vec());
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

pub fn router(state: Arc<ShareState>) -> Router {
    Router::new()
        .route("/v1/info", get(handle_info))
        .route("/v1/files", get(handle_files))
        // `get` also answers HEAD; `handle_file` checks the method and skips reading the bytes,
        // which is what makes revalidating a cached copy cheap.
        .route("/v1/file", get(handle_file))
        .route("/v1/push", post(handle_push))
        .route("/v1/state", get(handle_get_state).post(handle_put_state))
        .route("/v1/pair", post(handle_pair))
        .with_state(state)
}

async fn handle_info(State(state): State<Arc<ShareState>>) -> Response<Body> {
    let (device_id, name) = match state.identity.lock() {
        Ok(identity) => (identity.device_id.clone(), identity.name.clone()),
        Err(_) => return fail(StatusCode::INTERNAL_SERVER_ERROR, "internal", "identity unavailable"),
    };
    let root = state.share_root();
    let info = InfoResponse {
        device_id,
        name,
        protocol: 1,
        now: now_millis(),
        root_name: root
            .as_ref()
            .and_then(|r| r.file_name().and_then(|n| n.to_str()).map(str::to_owned)),
        sharing: root.is_some(),
    };
    Json(info).into_response_or_error()
}

/// One level of the shared folder. The client walks the tree itself, so a response stays bounded
/// however large the folder is.
async fn handle_files(
    State(state): State<Arc<ShareState>>,
    Query(query): Query<PathQuery>,
) -> Response<Body> {
    let Some(root) = state.share_root() else {
        return fail(StatusCode::FORBIDDEN, "forbidden", "This device is not sharing a folder");
    };
    let Some(dir) = resolve_in(&root, &query.path) else {
        return fail(StatusCode::NOT_FOUND, "not-found", "No such folder");
    };
    let Ok(reader) = std::fs::read_dir(&dir) else {
        return fail(StatusCode::NOT_FOUND, "not-found", "No such folder");
    };

    let mut entries = Vec::new();
    let mut skipped = 0usize;
    for item in reader.flatten() {
        let path = item.path();
        // Dotfiles are not counted as skipped: they are meant to be invisible, and reporting a
        // number for them would leak that they exist.
        if is_hidden(&path) {
            continue;
        }
        let Ok(meta) = item.metadata() else { continue };
        let is_dir = meta.is_dir();
        // Only documents Bode can open are ever listed, so pointing a share at a folder cannot
        // expose whatever else happens to live there.
        if !is_dir && !is_servable(&path) {
            skipped += 1;
            continue;
        }
        let Some(name) = item.file_name().to_str().map(str::to_owned) else { continue };
        let rel = if query.path.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", query.path.trim_end_matches('/'), name)
        };
        entries.push(Entry {
            name,
            rel,
            kind: if is_dir { "dir" } else { "file" },
            size: if is_dir { 0 } else { meta.len() },
            mtime: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        });
    }

    // Folders first, then names, so the listing does not reorder itself between requests.
    entries.sort_by(|a, b| (a.kind, a.name.to_lowercase()).cmp(&(b.kind, b.name.to_lowercase())));

    Json(ListResponse { path: query.path, entries, skipped }).into_response_or_error()
}

/// A slice of a document. Always bounded by `MAX_CHUNK`, so the server never buffers a large file.
///
/// A HEAD request answers with the size and ETag only. That is the whole revalidation path: a device
/// with a cached copy asks this one question and, if the tag still matches, opens the local file
/// without transferring a byte.
async fn handle_file(
    State(state): State<Arc<ShareState>>,
    Query(query): Query<PathQuery>,
    method: axum::http::Method,
    headers: HeaderMap,
) -> Response<Body> {
    let Some(root) = state.share_root() else {
        return fail(StatusCode::FORBIDDEN, "forbidden", "This device is not sharing a folder");
    };
    let Some(file) = resolve_in(&root, &query.path) else {
        return fail(StatusCode::NOT_FOUND, "not-found", "No such document");
    };
    if !file.is_file() || !is_servable(&file) {
        return fail(StatusCode::FORBIDDEN, "forbidden", "Not a shareable document");
    }
    let Ok(meta) = std::fs::metadata(&file) else {
        return fail(StatusCode::NOT_FOUND, "not-found", "No such document");
    };

    let total = meta.len();
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    // Size+mtime, never a content hash: hashing 200 MB on every open would defeat the point.
    let etag = format!("\"{total}-{mtime}\"");

    if method == axum::http::Method::HEAD {
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::ETAG, &etag)
            // What a GET of the whole document would be, which is what a revalidating client is
            // asking about — not the length of the chunk a GET would happen to return first.
            .header(header::CONTENT_LENGTH, total)
            .body(Body::empty())
            .unwrap_or_else(|_| fail(StatusCode::INTERNAL_SERVER_ERROR, "internal", "response"));
    }

    let start = match parse_range_start(&headers) {
        Ok(start) => start,
        Err(()) => {
            return fail(StatusCode::RANGE_NOT_SATISFIABLE, "range-not-satisfiable", "Bad range")
        }
    };
    if start > total {
        return fail(StatusCode::RANGE_NOT_SATISFIABLE, "range-not-satisfiable", "Past end of file");
    }

    let length = MAX_CHUNK.min(total.saturating_sub(start));
    let partial = start > 0 || length < total;

    let bytes = match read_slice(&file, start, length) {
        Ok(bytes) => bytes,
        Err(message) => return fail(StatusCode::INTERNAL_SERVER_ERROR, "internal", &message),
    };

    let mut builder = Response::builder()
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ETAG, &etag)
        .header(header::CONTENT_LENGTH, bytes.len());

    if partial {
        let last = start + length.saturating_sub(1);
        builder = builder
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_RANGE, format!("bytes {start}-{last}/{total}"));
    } else {
        builder = builder.status(StatusCode::OK);
    }

    builder
        .body(Body::from(bytes))
        .unwrap_or_else(|_| fail(StatusCode::INTERNAL_SERVER_ERROR, "internal", "response"))
}

/// Receive one chunk of a document a peer is sending us.
///
/// The name is chosen by THIS device, not the sender: the first chunk proposes a name, the server
/// picks a free one and returns it, and later chunks quote it back. That keeps two decisions here
/// where they belong — that the name is a single safe segment, and that it does not overwrite
/// something already in the inbox.
async fn handle_push(
    State(state): State<Arc<ShareState>>,
    Query(query): Query<PushQuery>,
    request: Request<Body>,
) -> Response<Body> {
    let Some(inbox) = state.inbox_dir() else {
        return fail(StatusCode::FORBIDDEN, "forbidden", "This device is not accepting documents");
    };
    if query.total > MAX_PUSH_BYTES {
        return fail(StatusCode::PAYLOAD_TOO_LARGE, "too-large", "That document is too large");
    }
    // A name is one path segment, never a path. Everything a sender could use to climb out of the
    // inbox — separators, `..`, a drive letter, a NUL — fails here before any file is touched.
    let Some(proposed) = safe_file_name(&query.name) else {
        return fail(StatusCode::BAD_REQUEST, "unsupported", "That file name is not allowed");
    };
    if !is_servable(std::path::Path::new(&proposed)) {
        return fail(StatusCode::FORBIDDEN, "forbidden", "Bode can only receive documents it opens");
    }
    if std::fs::create_dir_all(&inbox).is_err() {
        return fail(StatusCode::INTERNAL_SERVER_ERROR, "internal", "Cannot open the inbox folder");
    }

    // At offset 0 the name is settled; afterwards the sender is resuming into a file we already
    // named, so the proposal is taken literally and the offset check below catches any mismatch.
    let name = if query.offset == 0 {
        // Abandoned part-files are cleared first. `free_name` has to treat a `.part` as taken —
        // otherwise two devices sending the same name would both pick it and interleave their
        // chunks into one corrupt file — but without this sweep, one interrupted transfer would
        // reserve that name for good and every later send would land as "note (2).md".
        sweep_abandoned(&inbox);
        free_name(&inbox, &proposed)
    } else {
        proposed
    };
    let partial = inbox.join(format!("{name}.part"));

    let existing = std::fs::metadata(&partial).map(|m| m.len()).unwrap_or(0);
    if query.offset == 0 && existing > 0 {
        // A previous attempt died partway. Start clean rather than appending to its remains.
        let _ = std::fs::remove_file(&partial);
    } else if query.offset != existing {
        return fail(
            StatusCode::RANGE_NOT_SATISFIABLE,
            "range-not-satisfiable",
            "Restart the transfer — the two devices disagree about how much has arrived",
        );
    }

    let body = match axum::body::to_bytes(request.into_body(), MAX_CHUNK as usize + 4096).await {
        Ok(body) => body,
        Err(_) => return fail(StatusCode::PAYLOAD_TOO_LARGE, "too-large", "Chunk too large"),
    };

    if let Err(message) = append(&partial, &body) {
        return fail(StatusCode::INTERNAL_SERVER_ERROR, "internal", &message);
    }
    let received = query.offset + body.len() as u64;

    let mut complete = false;
    if received >= query.total {
        if std::fs::rename(&partial, inbox.join(&name)).is_err() {
            return fail(StatusCode::INTERNAL_SERVER_ERROR, "internal", "Cannot finish the transfer");
        }
        complete = true;
    }

    // The relative path is only meaningful to the sender if the inbox happens to sit inside the
    // share root; when it does not, there is nothing to browse to and `None` says so honestly.
    let rel = state
        .share_root()
        .and_then(|root| inbox.join(&name).strip_prefix(&root).ok().map(to_posix))
        .filter(|_| complete);

    Json(PushResponse { name, received, complete, rel }).into_response_or_error()
}

/// Hand a peer whatever reading state we hold for the documents it names.
async fn handle_get_state(
    State(state): State<Arc<ShareState>>,
    Query(query): Query<PathQuery>,
) -> Response<Body> {
    // Only what this device published about its OWN reading. Never anything a peer pushed us.
    let Ok(held) = state.published.lock() else {
        return fail(StatusCode::INTERNAL_SERVER_ERROR, "internal", "state unavailable");
    };
    // An empty query means "everything you have"; otherwise it is a comma-separated key list, so a
    // device syncing one open document does not pull its whole library's annotations.
    let wanted: Vec<&str> = query.path.split(',').filter(|k| !k.is_empty()).collect();
    let documents: std::collections::HashMap<String, serde_json::Value> = if wanted.is_empty() {
        held.clone()
    } else {
        wanted
            .iter()
            .filter_map(|k| held.get(*k).map(|v| ((*k).to_string(), v.clone())))
            .collect()
    };
    Json(StateResponse { documents }).into_response_or_error()
}

/// Take a peer's reading state. Stored verbatim: the merge is the frontend's job, because the
/// annotation model lives there and duplicating it in Rust would mean two implementations of the
/// one algorithm where a disagreement silently loses someone's work.
async fn handle_put_state(
    State(state): State<Arc<ShareState>>,
    request: Request<Body>,
) -> Response<Body> {
    let body = match axum::body::to_bytes(request.into_body(), MAX_CHUNK as usize).await {
        Ok(body) => body,
        Err(_) => return fail(StatusCode::PAYLOAD_TOO_LARGE, "too-large", "Too much state at once"),
    };
    let Ok(payload) = serde_json::from_slice::<StateResponse>(&body) else {
        return fail(StatusCode::BAD_REQUEST, "unsupported", "Malformed state");
    };
    // Into the inbox, not what we serve. Our frontend collects this and merges it into the
    // annotation store, which is the only place that knows how to reconcile two versions.
    let Ok(mut inbox) = state.received.lock() else {
        return fail(StatusCode::INTERNAL_SERVER_ERROR, "internal", "state unavailable");
    };
    for (key, value) in payload.documents {
        inbox.insert(key, value);
    }
    Json(StateResponse { documents: std::collections::HashMap::new() }).into_response_or_error()
}

/// Accept a file name only if it is a single, ordinary path segment. Anything with structure in it
/// is refused rather than sanitised — quietly rewriting a hostile name into a harmless one hides
/// the fact that something tried.
fn safe_file_name(name: &str) -> Option<String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 200 || name == "." || name == ".." {
        return None;
    }
    if name.starts_with('.') {
        return None; // no writing dotfiles into the inbox
    }
    if name.contains(['/', '\\', '\0', ':']) {
        return None;
    }
    // Control characters would produce a name no file manager can show or delete.
    if name.chars().any(|c| c.is_control()) {
        return None;
    }
    Some(name.to_string())
}

/// How long a `.part` file may sit untouched before it is treated as a dead transfer. Comfortably
/// longer than any gap between chunks of a live one, short enough that a name is not held hostage.
const ABANDONED_PART_MS: u64 = 10 * 60 * 1000;

/// Delete part-files from transfers that plainly are not coming back.
fn sweep_abandoned(inbox: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(inbox) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("part") {
            continue;
        }
        let idle = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        if idle > ABANDONED_PART_MS {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// A name not already taken, by a finished file or an in-flight one.
fn free_name(inbox: &std::path::Path, name: &str) -> String {
    let taken = |candidate: &str| {
        inbox.join(candidate).exists() || inbox.join(format!("{candidate}.part")).exists()
    };
    if !taken(name) {
        return name.to_string();
    }
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem, format!(".{ext}")),
        _ => (name, String::new()),
    };
    for n in 2..1000 {
        let candidate = format!("{stem} ({n}){extension}");
        if !taken(&candidate) {
            return candidate;
        }
    }
    format!("{stem} ({}){extension}", now_millis())
}

fn append(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("Cannot open for writing: {e}"))?;
    file.write_all(bytes).map_err(|e| format!("Cannot write: {e}"))
}

fn to_posix(path: &std::path::Path) -> String {
    path.components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect::<Vec<_>>()
        .join("/")
}

/// Complete a pairing. Reachable only while a window is open, because that is the only time the
/// TLS layer admits an unpinned certificate.
async fn handle_pair(
    State(state): State<Arc<ShareState>>,
    request: Request<Body>,
) -> Response<Body> {
    let peer_cert = request.extensions().get::<PeerCert>().map(|c| c.0.clone());
    let Some(peer_cert) = peer_cert else {
        return fail(StatusCode::FORBIDDEN, "forbidden", "No client certificate");
    };

    let body = match axum::body::to_bytes(request.into_body(), 64 * 1024).await {
        Ok(body) => body,
        Err(_) => return fail(StatusCode::BAD_REQUEST, "unsupported", "Body too large"),
    };
    let Ok(payload) = serde_json::from_slice::<PairRequest>(&body) else {
        return fail(StatusCode::BAD_REQUEST, "unsupported", "Malformed pairing request");
    };

    // Check and consume an attempt under one lock, so concurrent guesses cannot outrun the counter.
    let verdict = {
        let Ok(mut pairing) = state.pairing.lock() else {
            return fail(StatusCode::INTERNAL_SERVER_ERROR, "internal", "pairing unavailable");
        };
        match pairing.as_mut() {
            None => Err("closed"),
            Some(window) if now_millis() > window.expires_at => Err("expired"),
            Some(window) => {
                if constant_time_eq(window.code.as_bytes(), payload.code.as_bytes()) {
                    Ok(())
                } else {
                    window.attempts_left = window.attempts_left.saturating_sub(1);
                    if window.attempts_left == 0 {
                        *pairing = None;
                        Err("locked-out")
                    } else {
                        Err("bad-code")
                    }
                }
            }
        }
    };

    if let Err(reason) = verdict {
        if reason != "bad-code" {
            state.close_pairing();
        }
        return fail(StatusCode::FORBIDDEN, "bad-code", "That code is not valid");
    }

    let response = {
        let Ok(mut identity) = state.identity.lock() else {
            return fail(StatusCode::INTERNAL_SERVER_ERROR, "internal", "identity unavailable");
        };
        let their_fingerprint = sha256_hex(&peer_cert);
        let fingerprint = pair_fingerprint(&identity.cert_sha256, &their_fingerprint);

        // Recorded before the window closes, so this device's own UI can show the user the same six
        // characters the other one is displaying. Comparing them is the whole point.
        if let Ok(mut notice) = state.last_pairing.lock() {
            *notice = Some(PairingNotice {
                device_id: payload.device_id.clone(),
                name: payload.name.clone(),
                fingerprint: fingerprint.clone(),
                at: now_millis(),
            });
        }

        if let Err(message) = identity.add_peer(Peer {
            device_id: payload.device_id,
            name: payload.name,
            cert_sha256: their_fingerprint,
            added_at: now_millis(),
            last_addr: None,
        }) {
            return fail(StatusCode::INTERNAL_SERVER_ERROR, "internal", &message);
        }
        state.trust.sync_from(&identity);

        PairResponse {
            device_id: identity.device_id.clone(),
            name: identity.name.clone(),
            fingerprint,
        }
    };

    // One code pairs one device. Leaving the window open would let a second device walk in on a
    // code the user has already used and stopped watching.
    state.close_pairing();
    Json(response).into_response_or_error()
}

/// Only the start of a single range is honoured; the response length is ours to choose. A syntax we
/// do not understand is an error rather than a silent full-body response.
fn parse_range_start(headers: &HeaderMap) -> Result<u64, ()> {
    let Some(value) = headers.get(header::RANGE) else { return Ok(0) };
    let Ok(text) = value.to_str() else { return Err(()) };
    let Some(spec) = text.trim().strip_prefix("bytes=") else { return Err(()) };
    // Multipart ranges are refused rather than half-honoured.
    if spec.contains(',') {
        return Err(());
    }
    let Some((start, _end)) = spec.split_once('-') else { return Err(()) };
    if start.is_empty() {
        return Err(()); // suffix ranges ("-500") are not supported
    }
    start.trim().parse::<u64>().map_err(|_| ())
}

fn read_slice(path: &std::path::Path, start: u64, length: u64) -> Result<Vec<u8>, String> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(path).map_err(|e| format!("Cannot open: {e}"))?;
    file.seek(SeekFrom::Start(start)).map_err(|e| format!("Cannot seek: {e}"))?;

    let mut buffer = vec![0u8; length as usize];
    let mut filled = 0usize;
    while filled < buffer.len() {
        match file.read(&mut buffer[filled..]) {
            Ok(0) => break, // file shrank under us
            Ok(n) => filled += n,
            Err(e) => return Err(format!("Cannot read: {e}")),
        }
    }
    buffer.truncate(filled);
    Ok(buffer)
}

/// Compare without an early return, so a wrong code cannot be narrowed down by timing.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// `Json` builds an infallible response in practice, but serialising could fail; this keeps that on
/// the `Result` path instead of panicking inside a connection task.
trait IntoResponseOrError {
    fn into_response_or_error(self) -> Response<Body>;
}

impl<T: Serialize> IntoResponseOrError for Json<T> {
    fn into_response_or_error(self) -> Response<Body> {
        match serde_json::to_vec(&self.0) {
            Ok(body) => Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body))
                .unwrap_or_else(|_| Response::new(Body::empty())),
            Err(e) => fail(StatusCode::INTERNAL_SERVER_ERROR, "internal", &e.to_string()),
        }
    }
}

/// Bind a listener. Callers pass 0 for an ephemeral port and publish whatever they were given over
/// mDNS, rather than fixing a port that could collide or earn a fresh firewall prompt each release.
pub async fn bind(port: u16) -> Result<tokio::net::TcpListener, String> {
    tokio::net::TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], port)))
        .await
        .map_err(|e| format!("Cannot bind: {e}"))
}

pub async fn run_accept_loop(
    listener: tokio::net::TcpListener,
    state: Arc<ShareState>,
    tls: rustls::ServerConfig,
    mut shutdown: tokio::sync::oneshot::Receiver<()>,
) -> Result<(), String> {
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(tls));
    let app = router(state);

    loop {
        let accepted = tokio::select! {
            _ = &mut shutdown => return Ok(()),
            accepted = listener.accept() => accepted,
        };
        let Ok((tcp, _addr)) = accepted else { continue };

        let acceptor = acceptor.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            // An unpinned peer fails here, before any HTTP is parsed.
            let stream = match acceptor.accept(tcp).await {
                Ok(stream) => stream,
                Err(e) => {
                    // Two very different things land here and the wording has to keep them apart.
                    // A client that closes without sending anything is almost always our OWN
                    // reachability probe (see `resolve_peer`), which connects and drops on purpose;
                    // calling that "refused" invents a security event out of routine behaviour.
                    // A client that sends a handshake we reject is the real thing.
                    let kind = e.kind();
                    if kind == std::io::ErrorKind::UnexpectedEof
                        || kind == std::io::ErrorKind::ConnectionReset
                    {
                        super::trace!("{_addr} connected and closed without a handshake (probe?)");
                    } else {
                        super::trace!("refused an untrusted connection from {_addr}: {e}");
                    }
                    return;
                }
            };

            // Identify the caller from the certificate the session actually used.
            let peer_cert = stream
                .get_ref()
                .1
                .peer_certificates()
                .and_then(|chain| chain.first())
                .map(|cert| PeerCert(cert.as_ref().to_vec()));

            let service = hyper::service::service_fn(move |request: Request<hyper::body::Incoming>| {
                let app = app.clone();
                let peer_cert = peer_cert.clone();
                async move {
                    let mut request = request.map(Body::new);
                    if let Some(cert) = peer_cert {
                        request.extensions_mut().insert(cert);
                    }
                    app.oneshot(request).await
                }
            });

            let _ = hyper::server::conn::http1::Builder::new()
                .serve_connection(hyper_util::rt::TokioIo::new(stream), service)
                .await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers_with_range(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        if let Ok(value) = HeaderValue::from_str(value) {
            headers.insert(header::RANGE, value);
        }
        headers
    }

    #[test]
    fn absent_range_starts_at_zero() {
        assert_eq!(parse_range_start(&HeaderMap::new()), Ok(0));
    }

    #[test]
    fn open_and_closed_ranges_parse() {
        assert_eq!(parse_range_start(&headers_with_range("bytes=0-")), Ok(0));
        assert_eq!(parse_range_start(&headers_with_range("bytes=1024-")), Ok(1024));
        assert_eq!(parse_range_start(&headers_with_range("bytes=100-200")), Ok(100));
    }

    #[test]
    fn unsupported_range_syntax_is_refused_not_ignored() {
        // Silently serving the whole body would corrupt a resumed download.
        assert_eq!(parse_range_start(&headers_with_range("bytes=-500")), Err(()));
        assert_eq!(parse_range_start(&headers_with_range("bytes=0-1,5-9")), Err(()));
        assert_eq!(parse_range_start(&headers_with_range("items=0-")), Err(()));
        assert_eq!(parse_range_start(&headers_with_range("bytes=abc-")), Err(()));
    }

    #[test]
    fn constant_time_eq_matches_only_identical_input() {
        assert!(constant_time_eq(b"418902", b"418902"));
        assert!(!constant_time_eq(b"418902", b"418903"));
        assert!(!constant_time_eq(b"418902", b"41890"));
        assert!(!constant_time_eq(b"", b"1"));
    }

    #[test]
    fn an_in_flight_transfer_reserves_its_name_but_a_dead_one_does_not() {
        let inbox = std::env::temp_dir().join(format!("bode-sweep-{}", now_millis()));
        std::fs::create_dir_all(&inbox).expect("create inbox");

        // A live transfer's part-file must hold its name, or a second sender would pick the same
        // one and the two would interleave chunks into a single corrupt document.
        std::fs::write(inbox.join("note.md.part"), b"half").expect("write part");
        sweep_abandoned(&inbox);
        assert!(inbox.join("note.md.part").exists(), "a fresh part-file must survive the sweep");
        assert_eq!(free_name(&inbox, "note.md"), "note (2).md");

        // Backdate it past the threshold: now it is a dead transfer, and holding the name forever
        // would mean every later send of that file landed as "note (2).md".
        let old = std::time::SystemTime::now() - std::time::Duration::from_millis(ABANDONED_PART_MS + 1000);
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(inbox.join("note.md.part"))
            .expect("open part");
        file.set_modified(old).expect("backdate");
        drop(file);

        sweep_abandoned(&inbox);
        assert!(!inbox.join("note.md.part").exists(), "an abandoned part-file must be cleared");
        assert_eq!(free_name(&inbox, "note.md"), "note.md");

        let _ = std::fs::remove_dir_all(&inbox);
    }

    #[test]
    fn a_finished_document_always_reserves_its_name() {
        let inbox = std::env::temp_dir().join(format!("bode-freename-{}", now_millis()));
        std::fs::create_dir_all(&inbox).expect("create inbox");

        assert_eq!(free_name(&inbox, "a.pdf"), "a.pdf");
        std::fs::write(inbox.join("a.pdf"), b"x").expect("write");
        assert_eq!(free_name(&inbox, "a.pdf"), "a (2).pdf");
        std::fs::write(inbox.join("a (2).pdf"), b"x").expect("write");
        assert_eq!(free_name(&inbox, "a.pdf"), "a (3).pdf");
        // A name with no extension must not lose its dot handling.
        assert_eq!(free_name(&inbox, "README"), "README");

        let _ = std::fs::remove_dir_all(&inbox);
    }

    #[test]
    fn safe_file_name_accepts_only_plain_segments() {
        assert_eq!(safe_file_name("Fluid Mechanics.pdf").as_deref(), Some("Fluid Mechanics.pdf"));
        assert_eq!(safe_file_name("café.md").as_deref(), Some("café.md"));
        // Everything with structure is refused rather than sanitised — rewriting a hostile name
        // into a harmless one hides that something tried.
        for hostile in ["../a.pdf", "a/b.pdf", "a\\b.pdf", "..", ".", ".hidden.pdf", "C:a.pdf", ""] {
            assert!(safe_file_name(hostile).is_none(), "must refuse {hostile:?}");
        }
        assert!(safe_file_name("a\u{0}b.pdf").is_none());
        assert!(safe_file_name("a\nb.pdf").is_none());
        assert!(safe_file_name(&"x".repeat(300)).is_none());
    }

    #[test]
    fn read_slice_respects_offset_and_length() {
        let path = std::env::temp_dir().join("bode-read-slice-test.bin");
        std::fs::write(&path, b"0123456789").expect("write fixture");

        assert_eq!(read_slice(&path, 0, 4), Ok(b"0123".to_vec()));
        assert_eq!(read_slice(&path, 4, 3), Ok(b"456".to_vec()));
        // Asking past the end yields what exists rather than erroring.
        assert_eq!(read_slice(&path, 8, 100), Ok(b"89".to_vec()));

        let _ = std::fs::remove_file(&path);
    }
}
