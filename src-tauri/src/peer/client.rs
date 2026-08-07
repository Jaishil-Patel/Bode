/*
 * The outbound half: talking to a peer's server.
 *
 * Connections are mutual TLS with the peer's certificate pinned (see `tls.rs`). The TLS server name
 * is a fixed placeholder because peers are reached by IP, which no certificate can meaningfully
 * assert — the pin is the identity, so the name is never consulted.
 *
 * Documents are fetched in bounded chunks with `Range` rather than in one response, which is what
 * keeps a 200 MB scan from being buffered whole at either end, and what makes a dropped transfer
 * resumable instead of restarting.
 */

use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use rustls::pki_types::ServerName;
use serde::{Deserialize, Serialize};
use tokio_rustls::TlsConnector;

/// Cap on any single response we will hold in memory. Matches the server's chunk size with room for
/// headers, so a well-behaved peer never trips it and a malicious one cannot exhaust us.
const MAX_RESPONSE: usize = 16 * 1024 * 1024;

/// Names nothing, by design — the pinned certificate is the identity.
const TLS_PLACEHOLDER_NAME: &str = "bode";

#[derive(Debug, Deserialize, Serialize, Clone)]
#[allow(dead_code)] // Fields are read by the tests and by the forthcoming clock-skew guard.
pub struct PeerInfo {
    pub device_id: String,
    pub name: String,
    pub protocol: u32,
    pub now: u64,
    pub root_name: Option<String>,
    pub sharing: bool,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub rel: String,
    pub kind: String,
    pub size: u64,
    pub mtime: u64,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct Listing {
    pub path: String,
    pub entries: Vec<Entry>,
    /// Files present but not shown, because they are not document types Bode opens. A count only —
    /// see the note on the server's `ListResponse`. Defaulted so an older peer still parses.
    #[serde(default)]
    pub skipped: usize,
}

#[derive(Debug, Serialize)]
struct PairRequest {
    device_id: String,
    name: String,
    code: String,
}

#[derive(Debug, Deserialize)]
pub struct PairResponse {
    pub device_id: String,
    pub name: String,
    pub fingerprint: String,
}

/// One chunk of a document, plus what the server said about the whole thing.
pub struct Chunk {
    pub bytes: Vec<u8>,
    pub total: u64,
    /// `size-mtime`. Recorded with the cached copy and compared on the next open, which is how a
    /// document edited on the other device gets noticed without hashing it.
    pub etag: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushAck {
    /// The name the receiving device chose. Later chunks must use this, not the one we proposed.
    pub name: String,
    pub received: u64,
    pub complete: bool,
    pub rel: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct StateBundle {
    pub documents: std::collections::HashMap<String, serde_json::Value>,
}

pub struct PeerClient {
    config: Arc<rustls::ClientConfig>,
}

/// A response, plus the certificate the peer actually presented — needed during pairing, when the
/// certificate is not yet pinned and has to be recorded.
struct Reply {
    status: StatusCode,
    body: Vec<u8>,
    headers: axum::http::HeaderMap,
    peer_cert: Option<Vec<u8>>,
}

impl PeerClient {
    pub fn new(config: rustls::ClientConfig) -> Self {
        Self { config: Arc::new(config) }
    }

    async fn send(&self, addr: SocketAddr, request: Request<Body>) -> Result<Reply, String> {
        let tcp = tokio::net::TcpStream::connect(addr)
            .await
            .map_err(|e| format!("Cannot reach {addr}: {e}"))?;

        let name = ServerName::try_from(TLS_PLACEHOLDER_NAME)
            .map_err(|e| format!("Bad TLS name: {e}"))?;
        let stream = TlsConnector::from(Arc::clone(&self.config))
            .connect(name, tcp)
            .await
            // The overwhelmingly likely cause is an unpinned peer, so say that rather than leaking
            // a TLS alert code to the user.
            .map_err(|e| format!("This device would not accept the connection ({e})"))?;

        let peer_cert = stream
            .get_ref()
            .1
            .peer_certificates()
            .and_then(|chain| chain.first())
            .map(|cert| cert.as_ref().to_vec());

        let (mut sender, connection) =
            hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(stream))
                .await
                .map_err(|e| format!("Handshake failed: {e}"))?;

        tauri::async_runtime::spawn(async move {
            let _ = connection.await;
        });

        let response = sender
            .send_request(request)
            .await
            .map_err(|e| format!("Request failed: {e}"))?;

        let (parts, body) = response.into_parts();
        let bytes = axum::body::to_bytes(Body::new(body), MAX_RESPONSE)
            .await
            .map_err(|e| format!("Response too large or truncated: {e}"))?;

        Ok(Reply {
            status: parts.status,
            headers: parts.headers,
            body: bytes.to_vec(),
            peer_cert,
        })
    }

    fn get(&self, path: &str) -> Result<Request<Body>, String> {
        Request::builder()
            .method("GET")
            .uri(path)
            .header(header::HOST, TLS_PLACEHOLDER_NAME)
            .body(Body::empty())
            .map_err(|e| format!("Cannot build request: {e}"))
    }

    /// Reachability and clock probe. Exercised by the end-to-end tests; the skew check that consumes
    /// `now` arrives with annotation sync.
    #[allow(dead_code)]
    pub async fn info(&self, addr: SocketAddr) -> Result<PeerInfo, String> {
        let reply = self.send(addr, self.get("/v1/info")?).await?;
        decode(reply.status, &reply.body)
    }

    pub async fn list(&self, addr: SocketAddr, rel: &str) -> Result<Listing, String> {
        let path = format!("/v1/files?path={}", urlencode(rel));
        let reply = self.send(addr, self.get(&path)?).await?;
        decode(reply.status, &reply.body)
    }

    /// The peer's current tag for a document, without downloading it. This is the whole revalidation
    /// path: one round trip decides whether a cached copy is still the current one.
    ///
    /// Only the ETag is returned because it is `size-mtime` — the size a HEAD also reports is
    /// already inside it, and returning it separately would just be a second thing to keep in step.
    pub async fn etag(&self, addr: SocketAddr, rel: &str) -> Result<String, String> {
        let path = format!("/v1/file?path={}", urlencode(rel));
        let request = Request::builder()
            .method("HEAD")
            .uri(&path)
            .header(header::HOST, TLS_PLACEHOLDER_NAME)
            .body(Body::empty())
            .map_err(|e| format!("Cannot build request: {e}"))?;

        let reply = self.send(addr, request).await?;
        if !reply.status.is_success() {
            return Err(error_message(reply.status, &reply.body));
        }
        Ok(header_str(&reply.headers, header::ETAG))
    }

    /// Send one chunk of a document to a peer's inbox. The reply carries the name the peer chose,
    /// which the caller must use for every subsequent chunk.
    pub async fn push(
        &self,
        addr: SocketAddr,
        name: &str,
        offset: u64,
        total: u64,
        bytes: Vec<u8>,
    ) -> Result<PushAck, String> {
        let path = format!(
            "/v1/push?name={}&offset={offset}&total={total}",
            urlencode(name)
        );
        let request = Request::builder()
            .method("POST")
            .uri(&path)
            .header(header::HOST, TLS_PLACEHOLDER_NAME)
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .body(Body::from(bytes))
            .map_err(|e| format!("Cannot build request: {e}"))?;

        let reply = self.send(addr, request).await?;
        decode(reply.status, &reply.body)
    }

    /// Pull a peer's reading state. An empty `keys` asks for everything it holds.
    pub async fn get_state(&self, addr: SocketAddr, keys: &[String]) -> Result<StateBundle, String> {
        let path = format!("/v1/state?path={}", urlencode(&keys.join(",")));
        let reply = self.send(addr, self.get(&path)?).await?;
        decode(reply.status, &reply.body)
    }

    /// Hand a peer our reading state for the documents in `bundle`.
    pub async fn put_state(&self, addr: SocketAddr, bundle: &StateBundle) -> Result<(), String> {
        let payload =
            serde_json::to_vec(bundle).map_err(|e| format!("Cannot encode state: {e}"))?;
        let request = Request::builder()
            .method("POST")
            .uri("/v1/state")
            .header(header::HOST, TLS_PLACEHOLDER_NAME)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(payload))
            .map_err(|e| format!("Cannot build request: {e}"))?;

        let reply = self.send(addr, request).await?;
        if !reply.status.is_success() {
            return Err(error_message(reply.status, &reply.body));
        }
        Ok(())
    }

    /// Fetch one chunk starting at `start`. The caller loops until it has `total` bytes.
    pub async fn fetch(&self, addr: SocketAddr, rel: &str, start: u64) -> Result<Chunk, String> {
        let path = format!("/v1/file?path={}", urlencode(rel));
        let request = Request::builder()
            .method("GET")
            .uri(&path)
            .header(header::HOST, TLS_PLACEHOLDER_NAME)
            .header(header::RANGE, format!("bytes={start}-"))
            .body(Body::empty())
            .map_err(|e| format!("Cannot build request: {e}"))?;

        let reply = self.send(addr, request).await?;
        if reply.status != StatusCode::OK && reply.status != StatusCode::PARTIAL_CONTENT {
            return Err(error_message(reply.status, &reply.body));
        }

        let etag = header_str(&reply.headers, header::ETAG);

        // Prefer Content-Range's total; a 200 means the body is the whole document.
        let total = reply
            .headers
            .get(header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.rsplit('/').next().and_then(|t| t.parse::<u64>().ok()))
            .unwrap_or(reply.body.len() as u64);

        Ok(Chunk { bytes: reply.body, total, etag })
    }

    /// Complete a pairing, returning the peer's reply and the certificate it presented so the caller
    /// can pin it. Only works while the peer has a pairing window open.
    pub async fn pair(
        &self,
        addr: SocketAddr,
        device_id: &str,
        name: &str,
        code: &str,
    ) -> Result<(PairResponse, Vec<u8>), String> {
        let payload = serde_json::to_vec(&PairRequest {
            device_id: device_id.to_string(),
            name: name.to_string(),
            code: code.to_string(),
        })
        .map_err(|e| format!("Cannot encode pairing request: {e}"))?;

        let request = Request::builder()
            .method("POST")
            .uri("/v1/pair")
            .header(header::HOST, TLS_PLACEHOLDER_NAME)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(payload))
            .map_err(|e| format!("Cannot build request: {e}"))?;

        let reply = self.send(addr, request).await?;
        let cert = reply
            .peer_cert
            .clone()
            .ok_or_else(|| "The other device presented no certificate".to_string())?;
        let response: PairResponse = decode(reply.status, &reply.body)?;
        Ok((response, cert))
    }
}

fn header_str(headers: &axum::http::HeaderMap, name: header::HeaderName) -> String {
    headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or_default().to_string()
}

fn decode<T: for<'de> Deserialize<'de>>(status: StatusCode, body: &[u8]) -> Result<T, String> {
    if !status.is_success() {
        return Err(error_message(status, body));
    }
    serde_json::from_slice(body).map_err(|e| format!("Unexpected reply: {e}"))
}

/// Prefer the peer's own error text; fall back to the status when it sent something unparseable.
fn error_message(status: StatusCode, body: &[u8]) -> String {
    #[derive(Deserialize)]
    struct Wire {
        message: String,
    }
    match serde_json::from_slice::<Wire>(body) {
        Ok(wire) => wire.message,
        Err(_) => format!("Request failed ({status})"),
    }
}

/// Percent-encode a query value. Deliberately conservative: anything outside unreserved characters
/// is escaped, so a `#`, `&` or space in a file name cannot split the query.
fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urlencode_escapes_query_breaking_characters() {
        assert_eq!(urlencode("Papers/thesis.pdf"), "Papers/thesis.pdf");
        assert_eq!(urlencode("Fluid Mechanics.pdf"), "Fluid%20Mechanics.pdf");
        // These would otherwise terminate or split the query string.
        assert_eq!(urlencode("a&b.pdf"), "a%26b.pdf");
        assert_eq!(urlencode("a#b.pdf"), "a%23b.pdf");
        assert_eq!(urlencode("a?b.pdf"), "a%3Fb.pdf");
        assert_eq!(urlencode("100%.pdf"), "100%25.pdf");
    }

    #[test]
    fn urlencode_handles_non_ascii() {
        // Multi-byte UTF-8 must be escaped per byte, not per character.
        assert_eq!(urlencode("café.pdf"), "caf%C3%A9.pdf");
    }

    #[test]
    fn error_message_prefers_the_peer_text() {
        let body = br#"{"error":"forbidden","message":"This device is not sharing a folder"}"#;
        assert_eq!(
            error_message(StatusCode::FORBIDDEN, body),
            "This device is not sharing a folder"
        );
    }

    #[test]
    fn error_message_falls_back_when_the_body_is_not_ours() {
        let message = error_message(StatusCode::BAD_GATEWAY, b"<html>nope</html>");
        assert!(message.contains("502"), "should surface the status, got {message}");
    }
}
