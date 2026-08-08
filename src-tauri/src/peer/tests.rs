/*
 * End-to-end tests: a real server, a real client, real TLS, over a real socket.
 *
 * The unit tests elsewhere check pieces in isolation; these exist because the things most likely to
 * be wrong — whether an unpinned peer is genuinely refused, whether the extension allowlist actually
 * hides a private file — only show up when the whole stack runs.
 */

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use super::client::PeerClient;
use super::identity::{now_millis, Identity, Peer};
use super::server::{bind, run_accept_loop, ShareState};
use super::tls::{client_config, server_config, TrustStore};

struct Fixture {
    dir: PathBuf,
    share: PathBuf,
}

impl Fixture {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("bode-e2e-{tag}"));
        let _ = std::fs::remove_dir_all(&dir);
        let share = dir.join("share");
        let _ = std::fs::create_dir_all(share.join("sub"));
        let _ = std::fs::create_dir_all(dir.join("server-id"));
        let _ = std::fs::create_dir_all(dir.join("client-id"));

        let _ = std::fs::write(share.join("thesis.pdf"), b"%PDF-1.7 pretend thesis");
        let _ = std::fs::write(share.join("sub/notes.md"), b"# notes");
        // Neither of these may ever appear in a listing or be fetchable.
        let _ = std::fs::write(share.join("secrets.txt"), b"not a document");
        let _ = std::fs::write(share.join(".hidden.pdf"), b"dotfile");

        Self { dir, share }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

struct Harness {
    client: PeerClient,
    addr: std::net::SocketAddr,
    server_device_id: String,
    client_device_id: String,
    /// Kept so a test can unpair mid-flight and prove trust is consulted per handshake.
    server_identity: Arc<Mutex<Identity>>,
    server_trust: Arc<TrustStore>,
    /// The server's own state, so a test can turn the inbox on and inspect what arrived.
    server_state: Arc<ShareState>,
}

/// Build a server and a client. `pair` controls whether they pin each other — the whole point of the
/// refusal test is to run the identical setup with that turned off.
async fn harness(fixture: &Fixture, pair: bool) -> Harness {
    let mut server_identity =
        Identity::load_or_create(&fixture.dir.join("server-id"), "Desktop").expect("server identity");
    let mut client_identity =
        Identity::load_or_create(&fixture.dir.join("client-id"), "Phone").expect("client identity");

    let server_fingerprint = server_identity.cert_sha256.clone();
    let client_fingerprint = client_identity.cert_sha256.clone();
    let server_device_id = server_identity.device_id.clone();

    if pair {
        server_identity
            .add_peer(Peer {
                device_id: client_identity.device_id.clone(),
                name: "Phone".into(),
                cert_sha256: client_fingerprint,
                added_at: now_millis(),
                last_addr: None,
                platform: Some("mobile".into()),
            })
            .expect("pin client");
        client_identity
            .add_peer(Peer {
                device_id: server_device_id.clone(),
                name: "Desktop".into(),
                cert_sha256: server_fingerprint,
                added_at: now_millis(),
                last_addr: None,
                platform: Some("desktop".into()),
            })
            .expect("pin server");
    }

    let server_trust = Arc::new(TrustStore::default());
    server_trust.sync_from(&server_identity);
    let client_trust = Arc::new(TrustStore::default());
    client_trust.sync_from(&client_identity);

    let tls_server = server_config(&server_identity, Arc::clone(&server_trust)).expect("server tls");
    let tls_client = client_config(&client_identity, Arc::clone(&client_trust)).expect("client tls");

    let client_device_id = client_identity.device_id.clone();
    let server_identity = Arc::new(Mutex::new(server_identity));
    let state = Arc::new(ShareState::new(
        Arc::clone(&server_identity),
        Arc::clone(&server_trust),
    ));
    state.set_share_root(Some(fixture.share.clone()));

    let server_state = Arc::clone(&state);
    let listener = bind(0).await.expect("bind");
    // The listener binds 0.0.0.0 (every interface), but that is not a connectable destination —
    // dial the loopback on the port it was actually given.
    let port = listener.local_addr().expect("local addr").port();
    let addr = std::net::SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, port));
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();

    tokio::spawn(async move {
        let _ = run_accept_loop(listener, state, tls_server, shutdown_rx).await;
    });
    // Leak the sender so the server outlives this function rather than shutting down immediately.
    std::mem::forget(shutdown_tx);

    Harness {
        client: PeerClient::new(tls_client),
        addr,
        server_device_id,
        client_device_id,
        server_identity,
        server_trust,
        server_state,
    }
}

#[tokio::test]
async fn a_paired_device_can_read_the_share() {
    let fixture = Fixture::new("paired");
    let h = harness(&fixture, true).await;
    let (client, addr, server_device_id) = (&h.client, h.addr, h.server_device_id.clone());

    let info = client.info(addr).await.expect("info should succeed");
    assert_eq!(info.device_id, server_device_id);
    assert!(info.sharing);
    assert_eq!(info.root_name.as_deref(), Some("share"));

    let listing = client.list(addr, "").await.expect("list should succeed");
    let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();

    // Directories sort ahead of files, and only documents appear.
    assert_eq!(names, vec!["sub", "thesis.pdf"]);
    assert!(!names.contains(&"secrets.txt"), "a non-document must not be listed");
    assert!(!names.contains(&".hidden.pdf"), "a dotfile must not be listed");

    let chunk = client.fetch(addr, "thesis.pdf", 0).await.expect("fetch should succeed");
    assert_eq!(chunk.bytes, b"%PDF-1.7 pretend thesis");
    assert_eq!(chunk.total, 23);
    assert!(!chunk.etag.is_empty(), "an ETag is needed for staleness checks");

    // Nested paths resolve, and a mid-file offset returns the tail.
    let nested = client.fetch(addr, "sub/notes.md", 2).await.expect("nested fetch");
    assert_eq!(nested.bytes, b"notes");
    assert_eq!(nested.total, 7);
}

#[tokio::test]
async fn an_unpaired_device_is_refused_at_the_handshake() {
    let fixture = Fixture::new("unpaired");
    let h = harness(&fixture, false).await;
    let (client, addr) = (&h.client, h.addr);

    // Identical setup to the passing test except for the pinning, so this isolates trust.
    let result = client.info(addr).await;
    assert!(result.is_err(), "an unpinned peer must not get a response");
}

#[tokio::test]
async fn traversal_and_private_files_are_refused_over_the_wire() {
    let fixture = Fixture::new("containment");
    let h = harness(&fixture, true).await;
    let (client, addr) = (&h.client, h.addr);

    // The structural checks are unit-tested; this proves they are actually reached by a request.
    for attempt in ["../secrets.txt", "sub/../../secrets.txt", "/etc/passwd"] {
        assert!(
            client.fetch(addr, attempt, 0).await.is_err(),
            "traversal must be refused: {attempt}"
        );
    }

    // Inside the share, but not a document type we serve.
    assert!(client.fetch(addr, "secrets.txt", 0).await.is_err());
    assert!(client.fetch(addr, ".hidden.pdf", 0).await.is_err());
}

#[tokio::test]
async fn unpairing_takes_effect_on_the_very_next_connection() {
    let fixture = Fixture::new("unpin");
    let h = harness(&fixture, true).await;
    assert!(h.client.info(h.addr).await.is_ok(), "should start out trusted");

    // Unpair on the server, exactly as the command layer will.
    {
        let mut identity = h.server_identity.lock().expect("lock identity");
        identity.remove_peer(&h.client_device_id).expect("unpin");
        h.server_trust.sync_from(&identity);
    }

    // No restart, no config rebuild: trust is consulted per handshake, so this must bite at once.
    assert!(
        h.client.info(h.addr).await.is_err(),
        "an unpaired device must be refused immediately"
    );
}

#[tokio::test]
async fn a_device_can_ask_to_be_forgotten_but_cannot_forget_anyone_else() {
    // Forgetting is only half done when one side does it: the other keeps listing the device and
    // every action fails at the handshake, which reads as a broken network rather than a deliberate
    // act. `/v1/unpair` is what makes the two views agree.
    let fixture = Fixture::new("mutual-unpair");
    let h = harness(&fixture, true).await;
    assert!(h.client.info(h.addr).await.is_ok(), "should start out trusted");

    // A third device the server also trusts. The security property is that the caller cannot touch
    // it — the request names nobody, so there is no field in which to try.
    let bystander = Identity::load_or_create(&fixture.dir.join("bystander-id"), "Laptop")
        .expect("bystander identity");
    {
        let mut identity = h.server_identity.lock().expect("lock");
        identity
            .add_peer(Peer {
                device_id: bystander.device_id.clone(),
                name: "Laptop".into(),
                cert_sha256: bystander.cert_sha256.clone(),
                added_at: now_millis(),
                last_addr: None,
                platform: Some("desktop".into()),
            })
            .expect("pin bystander");
        h.server_trust.sync_from(&identity);
    }

    h.client.unpair(h.addr).await.expect("the peer should accept being forgotten");

    {
        let identity = h.server_identity.lock().expect("lock");
        assert!(
            !identity.peers().iter().any(|p| p.device_id == h.client_device_id),
            "the caller must have been removed"
        );
        assert!(
            identity.peers().iter().any(|p| p.device_id == bystander.device_id),
            "no one else may be removed — the caller is identified by its certificate, not by \
             anything it can put in a request"
        );
    }

    // And the removal must bite on the handshake straight away, not at the next restart — the pin
    // lives in the trust store as well as on disk.
    assert!(
        h.client.info(h.addr).await.is_err(),
        "a device that asked to be forgotten must no longer be admitted"
    );
}

#[tokio::test]
async fn two_unpaired_devices_can_actually_pair() {
    // The gap that let a fatal bug ship: every other test here pre-pins both sides, so none of them
    // exercised the one exchange where NEITHER device knows the other's certificate yet. The joining
    // side's ordinary client trusts only pinned certificates, so using it here fails the handshake
    // with `InvalidCertificate` before `/v1/pair` is ever reached.
    let fixture = Fixture::new("pairing");
    let h = harness(&fixture, false).await;

    // Sanity: unpaired, the normal client cannot get through at all.
    assert!(h.client.info(h.addr).await.is_err(), "should start out untrusted");

    // The host opens a window; only then may an unknown certificate complete a handshake.
    h.server_state.open_pairing("418902".to_string()).expect("open pairing");

    // THE REGRESSION. An open window on the host is not enough, because the failure is on the
    // JOINER's side: its verifier trusts only pinned certificates, so it rejects the host's
    // certificate before any request is sent. This is what surfaced as "invalid certificate" and
    // made pairing impossible in both directions.
    assert!(
        h.client.info(h.addr).await.is_err(),
        "the ordinary client must still refuse — it cannot trust an unpinned host, which is exactly \
         why pairing needs its own config rather than relying on the host's window"
    );

    let joiner_identity = Identity::load_or_create(&fixture.dir.join("client-id"), "Phone")
        .expect("joiner identity");
    let pairing_client = PeerClient::new(
        super::tls::pairing_client_config(&joiner_identity).expect("pairing config"),
    );

    // A wrong code is refused even with the window open — TLS is not what authenticates this.
    assert!(
        pairing_client
            .pair(h.addr, &joiner_identity.device_id, "Phone", "000000")
            .await
            .is_err(),
        "a wrong code must be refused"
    );

    h.server_state.close_pairing();
    h.server_state.open_pairing("418902".to_string()).expect("reopen");

    let (response, peer_cert) = pairing_client
        .pair(h.addr, &joiner_identity.device_id, "Phone", "418902")
        .await
        .expect("pairing should succeed");

    assert_eq!(response.device_id, h.server_device_id);

    // Both sides must independently derive the SAME six characters from the two certificates —
    // that equality is the entire man-in-the-middle defence, and it is what the user compares.
    let ours = super::identity::pair_fingerprint(
        &joiner_identity.cert_sha256,
        &super::identity::sha256_hex(&peer_cert),
    );
    assert_eq!(ours, response.fingerprint, "the two devices must agree on the fingerprint");
    assert_eq!(ours.len(), 6);

    // And the host must now have pinned the joiner, so an ordinary connection works next time.
    {
        let identity = h.server_identity.lock().expect("lock");
        let pinned = identity
            .peers()
            .iter()
            .find(|p| p.device_id == joiner_identity.device_id)
            .expect("the host should have pinned the joiner");

        // Both sides learn what kind of machine the other is DURING pairing, and store it. Reading
        // it live from the mDNS advertisement instead would leave an offline device with no icon —
        // and a card that changed its icon on reconnect reads as a different device.
        assert_eq!(
            pinned.platform.as_deref(),
            Some(super::discovery::THIS_PLATFORM),
            "the host must record what the joiner said it was"
        );
    }
    assert_eq!(
        response.platform.as_deref(),
        Some(super::discovery::THIS_PLATFORM),
        "and the joiner must learn the same about the host"
    );

    // The HOST must be able to show the same fingerprint. `/v1/pair` runs on a connection task with
    // no route to the UI, so without this recorded the host would display the numeric code while
    // the joiner showed six characters to compare against nothing — making the man-in-the-middle
    // check, which is the entire security of pairing, impossible to actually perform.
    let notice = h
        .server_state
        .last_pairing
        .lock()
        .expect("lock notice")
        .clone()
        .expect("the host must record the pairing");
    assert_eq!(notice.fingerprint, response.fingerprint, "both screens must show the same value");
    assert_eq!(notice.device_id, joiner_identity.device_id);
}

#[tokio::test]
async fn an_etag_survives_a_read_and_changes_after_a_write() {
    let fixture = Fixture::new("etag");
    let h = harness(&fixture, true).await;
    let (client, addr) = (&h.client, h.addr);

    let first = client.etag(addr, "thesis.pdf").await.expect("head should succeed");
    assert!(!first.is_empty());
    // The revalidation contract: reading a document must not change its tag, or every open would
    // re-download and the cache would be decorative.
    let _ = client.fetch(addr, "thesis.pdf", 0).await.expect("fetch");
    assert_eq!(client.etag(addr, "thesis.pdf").await.expect("head"), first);

    // The tag is size+mtime, and mtime has millisecond resolution, so a same-size rewrite within the
    // same millisecond could collide. Change the size, which is the half that cannot tie.
    std::fs::write(fixture.share.join("thesis.pdf"), b"%PDF-1.7 a longer pretend thesis")
        .expect("rewrite");
    let second = client.etag(addr, "thesis.pdf").await.expect("head after write");
    assert_ne!(second, first, "an edited document must not revalidate as unchanged");
}

#[tokio::test]
async fn a_pushed_document_lands_in_the_inbox_and_never_outside_it() {
    let fixture = Fixture::new("push");
    let h = harness(&fixture, true).await;
    let (client, addr) = (&h.client, h.addr);

    // With no inbox set, a push is refused outright — sharing a folder for reading must not imply
    // consent to be written to.
    assert!(
        client.push(addr, "note.md", 0, 5, b"hello".to_vec()).await.is_err(),
        "a device with no inbox must refuse a push"
    );

    let inbox = fixture.dir.join("inbox");
    h.server_state.set_inbox(Some(inbox.clone()));

    let ack = client
        .push(addr, "note.md", 0, 5, b"hello".to_vec())
        .await
        .expect("push should succeed");
    assert!(ack.complete);
    assert_eq!(ack.name, "note.md");
    assert_eq!(std::fs::read(inbox.join("note.md")).expect("read"), b"hello");

    // A second document of the same name must not overwrite the first; the receiver renames it and
    // says so, and the sender is expected to use the returned name.
    let again = client
        .push(addr, "note.md", 0, 5, b"world".to_vec())
        .await
        .expect("second push");
    assert_eq!(again.name, "note (2).md");
    assert_eq!(std::fs::read(inbox.join("note.md")).expect("read"), b"hello");
    assert_eq!(std::fs::read(inbox.join("note (2).md")).expect("read"), b"world");

    // The name is one path segment. Anything with structure is refused rather than sanitised.
    for hostile in ["../escaped.md", "sub/nested.md", "..", ".hidden.md", "C:evil.md"] {
        assert!(
            client.push(addr, hostile, 0, 3, b"bad".to_vec()).await.is_err(),
            "a structured name must be refused: {hostile}"
        );
    }
    assert!(!fixture.dir.join("escaped.md").exists(), "nothing may be written outside the inbox");

    // Only document types Bode can open are accepted.
    assert!(client.push(addr, "payload.exe", 0, 3, b"bad".to_vec()).await.is_err());
}

#[tokio::test]
async fn a_chunked_push_resumes_and_refuses_a_wrong_offset() {
    let fixture = Fixture::new("push-chunks");
    let h = harness(&fixture, true).await;
    let (client, addr) = (&h.client, h.addr);

    let inbox = fixture.dir.join("inbox");
    h.server_state.set_inbox(Some(inbox.clone()));

    let first = client.push(addr, "big.md", 0, 10, b"12345".to_vec()).await.expect("first half");
    assert!(!first.complete, "half a document is not a document");
    assert_eq!(first.received, 5);
    // Until it is whole it stays a .part file, so a crash mid-transfer never leaves something that
    // looks like a complete document.
    assert!(!inbox.join("big.md").exists());
    assert!(inbox.join("big.md.part").exists());

    // A sender that loses track of how much arrived must be told, not silently allowed to corrupt
    // the file by writing the same bytes twice.
    assert!(
        client.push(addr, "big.md", 2, 10, b"xx".to_vec()).await.is_err(),
        "a mismatched offset must be refused"
    );

    let second = client.push(addr, "big.md", 5, 10, b"67890".to_vec()).await.expect("second half");
    assert!(second.complete);
    assert_eq!(std::fs::read(inbox.join("big.md")).expect("read"), b"1234567890");
}

#[tokio::test]
async fn reading_state_round_trips_between_devices() {
    let fixture = Fixture::new("state");
    let h = harness(&fixture, true).await;
    let (client, addr) = (&h.client, h.addr);

    // What the host's own frontend has published. A GET serves THIS, never anything pushed to it —
    // the previous version of this test pushed state and read it back, which looked like a passing
    // round trip but was actually the peer echoing the client's own data to itself.
    {
        let mut published = h.server_state.published.lock().expect("lock");
        published.insert("dev1/thesis.pdf".to_string(), serde_json::json!({ "page": 42 }));
        published.insert("dev1/notes.md".to_string(), serde_json::json!({ "page": 3 }));
    }

    // Asking for one key must not hand back the whole library — a phone syncing the document in
    // front of it should not pull every annotation the desktop has ever made.
    let one = client
        .get_state(addr, &["dev1/thesis.pdf".to_string()])
        .await
        .expect("get one");
    assert_eq!(one.documents.len(), 1);
    assert_eq!(one.documents["dev1/thesis.pdf"]["page"], 42);

    let all = client.get_state(addr, &[]).await.expect("get all");
    assert_eq!(all.documents.len(), 2);

    // An unknown key is simply absent rather than an error, so a document the other device has
    // never opened does not fail the sync for every other document in the batch.
    let missing = client
        .get_state(addr, &["dev1/nothing.pdf".to_string()])
        .await
        .expect("get missing");
    assert!(missing.documents.is_empty());
}

#[tokio::test]
async fn a_device_sharing_nothing_still_answers_and_syncs() {
    // A phone never shares a folder, so it must still be reachable for its notes to be syncable.
    // Conflating "reachable" with "sharing" meant the desktop saw the phone as permanently offline
    // and greyed out sync — a whole direction of the feature that could never run.
    let fixture = Fixture::new("no-share");
    let h = harness(&fixture, true).await;
    let (client, addr) = (&h.client, h.addr);

    h.server_state.set_share_root(None);

    // Reachable: it answers, and honestly reports that it is not sharing.
    let info = client.info(addr).await.expect("a paired device must still answer");
    assert!(!info.sharing);
    assert!(info.root_name.is_none());

    // Reading state still flows in both directions.
    use super::client::StateBundle;
    let key = "dev1/thesis.pdf".to_string();
    h.server_state
        .published
        .lock()
        .expect("lock")
        .insert(key.clone(), serde_json::json!({ "page": 12 }));

    let got = client.get_state(addr, &[key.clone()]).await.expect("get state");
    assert_eq!(got.documents[&key]["page"], 12);

    let mut mine = std::collections::HashMap::new();
    mine.insert(key.clone(), serde_json::json!({ "page": 30 }));
    client.put_state(addr, &StateBundle { documents: mine }).await.expect("put state");

    // But nothing about files is exposed by being reachable.
    assert!(client.list(addr, "").await.is_err(), "listing must refuse with no share root");
    assert!(client.fetch(addr, "thesis.pdf", 0).await.is_err(), "fetching must refuse too");
}

#[tokio::test]
async fn pushing_state_never_overwrites_what_the_peer_serves() {
    // The bug this exists for: both directions shared one map, so a client's PUT replaced the
    // server's own entry for a document and the GET that followed handed the client its own data
    // straight back. The sync reported success, exchanged nothing, and merged a device with itself.
    let fixture = Fixture::new("state-isolation");
    let h = harness(&fixture, true).await;
    let (client, addr) = (&h.client, h.addr);

    use super::client::StateBundle;
    let key = "dev1/thesis.pdf".to_string();

    // What the HOST knows about the document — as its own frontend would have published it.
    h.server_state
        .published
        .lock()
        .expect("lock")
        .insert(key.clone(), serde_json::json!({ "owner": "host" }));

    // The client pushes its differing view of the same document.
    let mut mine = std::collections::HashMap::new();
    mine.insert(key.clone(), serde_json::json!({ "owner": "client" }));
    client.put_state(addr, &StateBundle { documents: mine }).await.expect("put");

    // The host must still serve ITS version. Serving the client's back is the failure.
    let got = client.get_state(addr, &[key.clone()]).await.expect("get");
    assert_eq!(got.documents[&key]["owner"], "host", "a push must not clobber what the peer serves");

    // And the pushed version must be waiting for the host's own frontend to merge, not discarded.
    let received = h.server_state.received.lock().expect("lock");
    assert_eq!(received[&key]["owner"], "client");
}
