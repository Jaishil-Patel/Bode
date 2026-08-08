/*
 * This device's permanent identity, and the set of devices it trusts.
 *
 * The TLS certificate's own keypair IS the device identity — there is no second signing key. A
 * device is pinned by the SHA-256 of its certificate DER, which is exactly the bytes rustls hands a
 * certificate verifier, so trust checking is a hash comparison with no X.509 parsing and no PKI.
 *
 * The certificate never expires (rcgen's default window is 1975..4096), because a rotation would
 * silently break every existing pin and read to the user as "my devices stopped talking".
 *
 * The private key lives in a file only Rust reads or writes. It must never travel through
 * `plugin-store`, because that would put it in reach of the frontend.
 */

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const IDENTITY_FILE: &str = "identity.json";

/// Unambiguous alphabet for the pairing fingerprint — no 0/O or 1/I/L to misread across a desk.
const FINGERPRINT_ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const FINGERPRINT_LEN: usize = 6;

/// A device this one has paired with. `cert_sha256` is the pin; everything else is presentation.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Peer {
    pub device_id: String,
    /// Display-only, chosen by the peer. Never trusted for anything.
    pub name: String,
    pub cert_sha256: String,
    pub added_at: u64,
    /// Where we last reached it, so a reconnect doesn't have to wait for mDNS.
    #[serde(default)]
    pub last_addr: Option<String>,
    /// `"desktop"` or `"mobile"`, learned at pairing. Stored rather than read from the live
    /// advertisement so an OFFLINE device still draws as the thing it is — a card that changed its
    /// icon on reconnect would read as a different device.
    #[serde(default)]
    pub platform: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Stored {
    cert_hex: String,
    key_hex: String,
    name: String,
    #[serde(default)]
    peers: Vec<Peer>,
    /// The folder this device was last sharing, so the share survives a restart.
    ///
    /// Kept here rather than in `settings.json` because it belongs with the identity: it is Rust-only
    /// state that the webview has no business writing, and it must be readable at startup without
    /// waiting for the frontend to hydrate.
    #[serde(default)]
    share_root: Option<String>,
}

pub struct Identity {
    /// `hex(sha256(cert_der)[..8])` — derived, so a `bode://` id can never name an unpinned key.
    pub device_id: String,
    pub cert_sha256: String,
    pub name: String,
    cert_der: Vec<u8>,
    key_der: Vec<u8>,
    peers: Vec<Peer>,
    path: PathBuf,
    /// Last folder shared, restored on startup. `None` means this device has never shared.
    share_root: Option<PathBuf>,
}

impl Identity {
    /// Load this device's identity, generating and persisting one on first use.
    pub fn load_or_create(dir: &Path, default_name: &str) -> Result<Self, String> {
        let path = dir.join(IDENTITY_FILE);

        if let Ok(text) = std::fs::read_to_string(&path) {
            match serde_json::from_str::<Stored>(&text) {
                Ok(stored) => {
                    let cert_der = from_hex(&stored.cert_hex)
                        .ok_or_else(|| "identity.json: malformed certificate".to_string())?;
                    let key_der = from_hex(&stored.key_hex)
                        .ok_or_else(|| "identity.json: malformed key".to_string())?;
                    let mut identity =
                        Self::assemble(cert_der, key_der, stored.name, stored.peers, path);
                    identity.share_root = stored.share_root.map(PathBuf::from);
                    return Ok(identity);
                }
                // A corrupt identity file would otherwise brick the feature with no way out. Losing
                // it costs re-pairing, which is recoverable; refusing to start is not.
                Err(_) => {
                    let _ = std::fs::rename(&path, path.with_extension("json.corrupt"));
                }
            }
        }

        let (cert_der, key_der) = generate()?;
        let identity = Self::assemble(cert_der, key_der, default_name.to_string(), Vec::new(), path);
        identity.save()?;
        Ok(identity)
    }

    fn assemble(
        cert_der: Vec<u8>,
        key_der: Vec<u8>,
        name: String,
        peers: Vec<Peer>,
        path: PathBuf,
    ) -> Self {
        let cert_sha256 = sha256_hex(&cert_der);
        let device_id = cert_sha256.get(..16).unwrap_or(&cert_sha256).to_string();
        Self { device_id, cert_sha256, name, cert_der, key_der, peers, path, share_root: None }
    }

    /// The folder to re-share on startup, if it still exists. A folder that has been deleted or is
    /// on an unplugged drive is silently forgotten rather than failing the launch.
    pub fn share_root(&self) -> Option<PathBuf> {
        self.share_root.as_ref().filter(|p| p.is_dir()).cloned()
    }

    pub fn set_share_root(&mut self, root: Option<PathBuf>) -> Result<(), String> {
        self.share_root = root;
        self.save()
    }

    pub fn save(&self) -> Result<(), String> {
        let stored = Stored {
            cert_hex: to_hex(&self.cert_der),
            key_hex: to_hex(&self.key_der),
            name: self.name.clone(),
            peers: self.peers.clone(),
            share_root: self.share_root.as_ref().map(|p| p.to_string_lossy().to_string()),
        };
        let text = serde_json::to_string_pretty(&stored)
            .map_err(|e| format!("Cannot encode identity: {e}"))?;
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Cannot create {}: {e}", parent.display()))?;
        }
        std::fs::write(&self.path, text)
            .map_err(|e| format!("Cannot write {}: {e}", self.path.display()))?;
        restrict_permissions(&self.path);
        Ok(())
    }

    /// The certificate chain and key rustls needs, in its own types.
    pub fn tls_material(&self) -> (Vec<CertificateDer<'static>>, PrivateKeyDer<'static>) {
        let chain = vec![CertificateDer::from(self.cert_der.clone())];
        let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(self.key_der.clone()));
        (chain, key)
    }

    pub fn peers(&self) -> &[Peer] {
        &self.peers
    }

    /// The peer a presented certificate belongs to, or None if it was never pinned.
    ///
    /// The handshake itself only needs a yes/no, which `TrustStore` answers. This maps a
    /// certificate to *which* device it is — needed to attribute an inbound push, and the property
    /// the pinning tests assert against.
    #[allow(dead_code)]
    pub fn peer_for_cert(&self, cert_der: &[u8]) -> Option<&Peer> {
        let fingerprint = sha256_hex(cert_der);
        self.peers.iter().find(|p| p.cert_sha256 == fingerprint)
    }

    pub fn set_name(&mut self, name: String) -> Result<(), String> {
        self.name = name;
        self.save()
    }

    /// Pin a device. Re-pairing an existing device updates it in place rather than duplicating.
    pub fn add_peer(&mut self, peer: Peer) -> Result<(), String> {
        self.peers.retain(|p| p.cert_sha256 != peer.cert_sha256);
        self.peers.push(peer);
        self.save()
    }

    /// Unpin a device. Takes effect on the next handshake, since trust is checked per-connection.
    pub fn remove_peer(&mut self, device_id: &str) -> Result<(), String> {
        self.peers.retain(|p| p.device_id != device_id);
        self.save()
    }

}

/// Generate the self-signed certificate that is this device's identity.
fn generate() -> Result<(Vec<u8>, Vec<u8>), String> {
    // The SAN is a placeholder: peers are verified by pinned certificate hash, never by name, so
    // nothing ever checks it. It exists because a certificate without one is malformed.
    let certified = rcgen::generate_simple_self_signed(vec!["bode".to_string()])
        .map_err(|e| format!("Cannot generate device certificate: {e}"))?;
    let cert_der = certified.cert.der().to_vec();
    let key_der = certified.signing_key.serialize_der();
    Ok((cert_der, key_der))
}

/// The value both devices show during pairing so a human can confirm they match.
///
/// Derived from BOTH certificates, sorted so each side computes the same string, and rendered in an
/// unambiguous alphabet. This — not the typed code — is what actually defeats a man in the middle,
/// because it covers the keys the TLS session really used.
pub fn pair_fingerprint(a_cert_sha256: &str, b_cert_sha256: &str) -> String {
    let (first, second) = if a_cert_sha256 <= b_cert_sha256 {
        (a_cert_sha256, b_cert_sha256)
    } else {
        (b_cert_sha256, a_cert_sha256)
    };

    let mut hasher = Sha256::new();
    hasher.update(b"bode-pair-fingerprint-v1");
    hasher.update(first.as_bytes());
    hasher.update(second.as_bytes());
    let digest = hasher.finalize();

    let n = FINGERPRINT_ALPHABET.len();
    digest
        .iter()
        .take(FINGERPRINT_LEN)
        .map(|b| FINGERPRINT_ALPHABET[(*b as usize) % n] as char)
        .collect()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    to_hex(&Sha256::digest(bytes))
}

fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(char::from_digit((b >> 4) as u32, 16).unwrap_or('0'));
        out.push(char::from_digit((b & 0x0f) as u32, 16).unwrap_or('0'));
    }
    out
}

fn from_hex(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 {
        return None;
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(text.len() / 2);
    for pair in bytes.chunks_exact(2) {
        let hi = (pair[0] as char).to_digit(16)?;
        let lo = (pair[1] as char).to_digit(16)?;
        out.push(((hi << 4) | lo) as u8);
    }
    Some(out)
}

pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Owner-only on unix. On Windows the file inherits the app-data ACL, which is the same protection
/// `annotations.json` and `settings.json` already rely on — the threat model here is the LAN, not a
/// second local user, so no DPAPI/Keychain work in v1.
#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bode-identity-test-{tag}"));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    #[test]
    fn hex_round_trips() {
        let bytes = vec![0x00, 0x0f, 0xa5, 0xff, 0x10];
        assert_eq!(to_hex(&bytes), "000fa5ff10");
        assert_eq!(from_hex("000fa5ff10"), Some(bytes));
        assert_eq!(from_hex("odd"), None);
        assert_eq!(from_hex("zz"), None);
    }

    #[test]
    fn a_shared_folder_survives_a_restart() {
        // The whole point: without this, every launch silently stops sharing while still looking
        // paired from the other device — which is indistinguishable from a broken connection.
        let dir = std::env::temp_dir().join(format!("bode-share-root-{}", now_millis()));
        let _ = std::fs::create_dir_all(&dir);
        let shared = dir.join("shared");
        let _ = std::fs::create_dir_all(&shared);

        {
            let mut identity = Identity::load_or_create(&dir, "Desktop").expect("create");
            assert!(identity.share_root().is_none(), "nothing is shared to begin with");
            identity.set_share_root(Some(shared.clone())).expect("set");
        }

        let reloaded = Identity::load_or_create(&dir, "Desktop").expect("reload");
        assert_eq!(reloaded.share_root(), Some(shared.clone()));

        // A folder that has gone away — deleted, or on an unplugged drive — must not be resumed,
        // and must not fail the launch either.
        let _ = std::fs::remove_dir_all(&shared);
        let gone = Identity::load_or_create(&dir, "Desktop").expect("reload again");
        assert!(gone.share_root().is_none(), "a missing folder is forgotten, not fatal");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn turning_sharing_off_forgets_the_folder() {
        let dir = std::env::temp_dir().join(format!("bode-share-off-{}", now_millis()));
        let _ = std::fs::create_dir_all(dir.join("shared"));

        {
            let mut identity = Identity::load_or_create(&dir, "Desktop").expect("create");
            identity.set_share_root(Some(dir.join("shared"))).expect("set");
            // Stopping is a deliberate choice; the next launch must not undo it.
            identity.set_share_root(None).expect("clear");
        }

        assert!(Identity::load_or_create(&dir, "Desktop").expect("reload").share_root().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn identity_persists_across_loads() {
        let dir = temp_dir("persist");
        let first = Identity::load_or_create(&dir, "Test").expect("create");
        let second = Identity::load_or_create(&dir, "Other").expect("reload");

        // A regenerated identity would silently invalidate every pin the peer holds.
        assert_eq!(first.device_id, second.device_id);
        assert_eq!(first.cert_sha256, second.cert_sha256);
        assert_eq!(second.name, "Test", "stored name should win over the default");
        assert_eq!(first.device_id.len(), 16);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_identity_file_is_replaced_rather_than_fatal() {
        let dir = temp_dir("corrupt");
        std::fs::write(dir.join(IDENTITY_FILE), "{ not json").expect("write junk");
        let identity = Identity::load_or_create(&dir, "Test").expect("should recover");
        assert_eq!(identity.device_id.len(), 16);
        assert!(dir.join("identity.json.corrupt").exists(), "bad file should be kept aside");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_pinned_certificates_resolve_to_a_peer() {
        let dir = temp_dir("pinning");
        let mut identity = Identity::load_or_create(&dir, "Test").expect("create");
        let (other_cert, _) = generate().expect("second identity");

        assert!(identity.peer_for_cert(&other_cert).is_none(), "unpinned must not resolve");

        identity
            .add_peer(Peer {
                device_id: "abc".into(),
                name: "Phone".into(),
                cert_sha256: sha256_hex(&other_cert),
                added_at: now_millis(),
                last_addr: None,
                platform: None,
            })
            .expect("pin");

        assert_eq!(identity.peer_for_cert(&other_cert).map(|p| p.name.as_str()), Some("Phone"));

        identity.remove_peer("abc").expect("unpin");
        assert!(identity.peer_for_cert(&other_cert).is_none(), "unpinned must stop resolving");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pair_fingerprint_is_order_independent_and_readable() {
        let a = sha256_hex(b"cert-a");
        let b = sha256_hex(b"cert-b");

        // Both devices must display the same string regardless of who initiated.
        assert_eq!(pair_fingerprint(&a, &b), pair_fingerprint(&b, &a));
        assert_ne!(pair_fingerprint(&a, &b), pair_fingerprint(&a, &sha256_hex(b"cert-c")));

        let fingerprint = pair_fingerprint(&a, &b);
        assert_eq!(fingerprint.len(), FINGERPRINT_LEN);
        assert!(
            fingerprint.bytes().all(|c| FINGERPRINT_ALPHABET.contains(&c)),
            "must avoid ambiguous characters, got {fingerprint}"
        );
    }
}
