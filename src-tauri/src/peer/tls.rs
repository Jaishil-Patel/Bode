/*
 * Mutual TLS with pinned certificates, in both directions.
 *
 * There is no PKI here and no certificate authority. A peer is trusted if and only if the SHA-256
 * of the certificate it presents is one this device pinned during pairing. That makes the trust
 * decision a hash-set lookup, and it means an unpaired peer is refused *during the handshake* —
 * before a single byte of HTTP is parsed, which is the strongest place to reject it.
 *
 * The signature checks are NOT skipped. Only the chain-to-a-root and name-matching steps are
 * replaced; the peer must still prove it holds the private key for the certificate it presented,
 * which is what stops someone replaying a certificate they copied off the wire.
 *
 * Unpinning takes effect immediately, because trust is consulted per handshake rather than baked
 * into the config at startup.
 */

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{
    verify_tls12_signature, verify_tls13_signature, CryptoProvider, WebPkiSupportedAlgorithms,
};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::{
    CertificateError, ClientConfig, DigitallySignedStruct, DistinguishedName, Error as TlsError,
    ServerConfig, SignatureScheme,
};

use super::identity::{sha256_hex, Identity};

/// Requiring an ALPN protocol gives free versioning and makes a stray browser hitting the port fail
/// immediately rather than reaching a route.
pub const ALPN: &[u8] = b"bode/1";

/// The set of certificates this device currently trusts, shared with the running server so that
/// pairing and unpairing take effect without a restart.
#[derive(Debug, Default)]
pub struct TrustStore {
    pinned: Mutex<HashSet<String>>,
    /// While a pairing window is open, an unknown certificate is allowed to complete a handshake so
    /// it can reach `/v1/pair`. The typed code and the confirmed fingerprint — not TLS — are what
    /// authenticate that exchange.
    pairing_open: AtomicBool,
}

impl TrustStore {
    pub fn sync_from(&self, identity: &Identity) {
        if let Ok(mut pinned) = self.pinned.lock() {
            *pinned = identity.peers().iter().map(|p| p.cert_sha256.clone()).collect();
        }
    }

    pub fn set_pairing_open(&self, open: bool) {
        self.pairing_open.store(open, Ordering::SeqCst);
    }

    pub fn is_pairing_open(&self) -> bool {
        self.pairing_open.load(Ordering::SeqCst)
    }

    fn accepts(&self, cert_der: &[u8]) -> bool {
        if self.is_pairing_open() {
            return true;
        }
        let fingerprint = sha256_hex(cert_der);
        // A poisoned lock denies rather than allows — failing closed is the only safe direction.
        self.pinned.lock().map(|p| p.contains(&fingerprint)).unwrap_or(false)
    }
}

#[derive(Debug)]
struct PinnedVerifier {
    trust: Arc<TrustStore>,
    algorithms: WebPkiSupportedAlgorithms,
    /// Sending no hints tells a client to offer whatever certificate it has, which is what we want:
    /// there are no CA subjects to hint at.
    no_hints: Vec<DistinguishedName>,
}

impl PinnedVerifier {
    fn check(&self, end_entity: &CertificateDer<'_>) -> Result<(), TlsError> {
        if self.trust.accepts(end_entity.as_ref()) {
            Ok(())
        } else {
            Err(TlsError::InvalidCertificate(CertificateError::ApplicationVerificationFailure))
        }
    }
}

impl ClientCertVerifier for PinnedVerifier {
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &self.no_hints
    }

    fn verify_client_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _now: UnixTime,
    ) -> Result<ClientCertVerified, TlsError> {
        self.check(end_entity)?;
        Ok(ClientCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify_tls12_signature(message, cert, dss, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify_tls13_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

impl ServerCertVerifier for PinnedVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        // The server name is deliberately ignored: peers are reached by IP, which no certificate
        // can meaningfully assert. The pin is the identity.
        self.check(end_entity)?;
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify_tls12_signature(message, cert, dss, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify_tls13_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

/// Accepts whatever server certificate is presented. Used for the pairing exchange ONLY.
#[derive(Debug)]
struct AcceptAnyServer {
    algorithms: WebPkiSupportedAlgorithms,
}

impl ServerCertVerifier for AcceptAnyServer {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        // Still enforced: the peer must hold the private key for what it presented. Only the
        // question "is this certificate one I already know" is deferred.
        verify_tls12_signature(message, cert, dss, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify_tls13_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

/// Client config for the pairing exchange, and nothing else.
///
/// The peer's certificate cannot be pinned yet — learning it IS pairing — so this accepts what it
/// presents. That is not a hole: the exchange is gated by the typed code, and a man in the middle is
/// caught by the six-character fingerprint, which is derived from BOTH certificates and therefore
/// differs on the two screens if anyone is sitting between them.
///
/// Deliberately a separate config rather than opening this device's `TrustStore`: that flag is also
/// read by the server, so flipping it would briefly admit an unpinned device into a share this
/// device is hosting. Scoping the permissiveness to one outbound connection keeps it where it
/// belongs — and keeps the normal client strict while a pairing is in flight.
pub fn pairing_client_config(identity: &Identity) -> Result<ClientConfig, String> {
    let provider = provider();
    let verifier =
        Arc::new(AcceptAnyServer { algorithms: provider.signature_verification_algorithms });
    let (chain, key) = identity.tls_material();

    let mut config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("TLS versions unsupported: {e}"))?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_client_auth_cert(chain, key)
        .map_err(|e| format!("Cannot load device certificate: {e}"))?;

    config.alpn_protocols = vec![ALPN.to_vec()];
    config.resumption = rustls::client::Resumption::disabled();

    Ok(config)
}

fn provider() -> Arc<CryptoProvider> {
    // `ring` rather than `aws-lc-rs`: it cross-compiles to the Android NDK without cmake or clang.
    Arc::new(rustls::crypto::ring::default_provider())
}

fn verifier(trust: Arc<TrustStore>, provider: &CryptoProvider) -> Arc<PinnedVerifier> {
    Arc::new(PinnedVerifier {
        trust,
        algorithms: provider.signature_verification_algorithms,
        no_hints: Vec::new(),
    })
}

/// Server side: require a client certificate and accept only pinned ones.
pub fn server_config(identity: &Identity, trust: Arc<TrustStore>) -> Result<ServerConfig, String> {
    let provider = provider();
    let verifier = verifier(trust, &provider);
    let (chain, key) = identity.tls_material();

    let mut config = ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("TLS versions unsupported: {e}"))?
        .with_client_cert_verifier(verifier)
        .with_single_cert(chain, key)
        .map_err(|e| format!("Cannot load device certificate: {e}"))?;

    config.alpn_protocols = vec![ALPN.to_vec()];

    // Session resumption must be off. A resumed session skips certificate verification and reuses
    // the identity established by the original handshake — which would mean an unpaired device kept
    // working until its ticket expired. Trust is per-handshake only if every connection IS one.
    // The cost is a full handshake per request, which on a LAN is nothing next to the guarantee.
    config.session_storage = Arc::new(rustls::server::NoServerSessionStorage {});
    config.send_tls13_tickets = 0;

    Ok(config)
}

/// Client side: present our certificate, and accept only a pinned one in return.
pub fn client_config(identity: &Identity, trust: Arc<TrustStore>) -> Result<ClientConfig, String> {
    let provider = provider();
    let verifier = verifier(trust, &provider);
    let (chain, key) = identity.tls_material();

    let mut config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("TLS versions unsupported: {e}"))?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_client_auth_cert(chain, key)
        .map_err(|e| format!("Cannot load device certificate: {e}"))?;

    config.alpn_protocols = vec![ALPN.to_vec()];
    // Symmetric with the server: never resume, so the peer's certificate is re-checked every time
    // and a device we unpinned stops being accepted immediately.
    config.resumption = rustls::client::Resumption::disabled();

    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trust_store_admits_only_pinned_certificates() {
        let store = TrustStore::default();
        let cert = b"pretend-certificate-der";

        assert!(!store.accepts(cert), "nothing is trusted by default");

        if let Ok(mut pinned) = store.pinned.lock() {
            pinned.insert(sha256_hex(cert));
        }
        assert!(store.accepts(cert));
        assert!(!store.accepts(b"a different certificate"));
    }

    #[test]
    fn an_open_pairing_window_admits_an_unknown_certificate() {
        let store = TrustStore::default();
        let stranger = b"unknown-certificate-der";

        assert!(!store.accepts(stranger));

        store.set_pairing_open(true);
        assert!(store.accepts(stranger), "pairing must be reachable before a pin exists");

        // ...and the window closing must revoke that immediately.
        store.set_pairing_open(false);
        assert!(!store.accepts(stranger));
    }
}
