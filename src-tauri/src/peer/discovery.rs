/*
 * Finding other Bode devices on the same network, over mDNS.
 *
 * The advertised port is whatever the OS handed us, because binding a fixed port invites collisions
 * and earns a fresh firewall prompt every release. The TXT record carries a prefix of the device's
 * certificate hash, so the UI can label a discovered device "paired" or "new" before connecting to
 * it — a pinned peer is recognised without a round trip.
 *
 * Discovery is a convenience, never a requirement: manual address entry has to work on its own,
 * because guest networks routinely drop multicast while still allowing direct connections.
 */

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use serde::Serialize;

pub const SERVICE_TYPE: &str = "_bode._tcp.local.";

/// A device seen on the network. `paired` is filled in by the caller, which knows the pin set.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovered {
    pub device_id: String,
    pub name: String,
    /// The address to show a user. First of `addrs`, which is only a display choice.
    pub addr: String,
    /// EVERY address the device advertised, in the order it gave them.
    ///
    /// A machine has more than one, and some of them are lies: a Windows desktop running WSL or
    /// Docker advertises a virtual interface (`172.x`, `192.168.x`) that no other device can reach,
    /// alongside the real Wi-Fi one. Nothing on the advertising side can tell them apart — the
    /// virtual address is a perfectly ordinary private IPv4 — so the caller tries each until one
    /// answers rather than guessing.
    pub addrs: Vec<String>,
    pub port: u16,
    /// First 16 hex characters of the peer's certificate hash, for recognising a pinned device.
    pub cert_prefix: String,
}

pub struct Discovery {
    daemon: ServiceDaemon,
    /// Keyed by mDNS fullname so a device that changes address replaces its own entry.
    seen: Arc<Mutex<HashMap<String, Discovered>>>,
    registered: Mutex<Option<String>>,
}

impl Discovery {
    pub fn start() -> Result<Self, String> {
        let daemon = ServiceDaemon::new().map_err(|e| format!("Cannot start mDNS: {e}"))?;
        Ok(Self { daemon, seen: Arc::new(Mutex::new(HashMap::new())), registered: Mutex::new(None) })
    }

    /// Publish this device. Replaces any previous advertisement, so re-enabling sharing on a new
    /// port does not leave a stale record pointing at a closed socket.
    pub fn advertise(
        &self,
        device_id: &str,
        name: &str,
        port: u16,
        cert_prefix: &str,
    ) -> Result<(), String> {
        self.stop_advertising();

        let addresses = local_addresses();
        if addresses.is_empty() {
            return Err("No usable network interface — are you connected to Wi-Fi?".to_string());
        }

        let properties = [
            ("id", device_id),
            ("name", name),
            ("v", "1"),
            ("cert", cert_prefix),
        ];
        // The instance name must be unique on the network; the device id already is.
        let host = format!("bode-{device_id}.local.");
        let info = ServiceInfo::new(SERVICE_TYPE, device_id, &host, &addresses[..], port, &properties[..])
            .map_err(|e| format!("Cannot build mDNS record: {e}"))?;

        // The advertised address list is the single most useful thing to see when a peer can find
        // this device but cannot connect to it — a virtual adapter looks identical to a real one.
        super::trace!(
            "advertising {device_id} as {name:?} on port {port} at {:?}",
            addresses.iter().map(|a| a.to_string()).collect::<Vec<_>>()
        );

        let fullname = info.get_fullname().to_string();
        self.daemon.register(info).map_err(|e| format!("Cannot advertise: {e}"))?;
        if let Ok(mut registered) = self.registered.lock() {
            *registered = Some(fullname);
        }
        Ok(())
    }

    pub fn stop_advertising(&self) {
        let previous = self.registered.lock().ok().and_then(|mut r| r.take());
        if let Some(fullname) = previous {
            let _ = self.daemon.unregister(&fullname);
        }
    }

    /// Begin browsing. Results accumulate in the background; call `found` for a snapshot.
    pub fn browse(&self, self_device_id: String) -> Result<(), String> {
        let receiver = self
            .daemon
            .browse(SERVICE_TYPE)
            .map_err(|e| format!("Cannot browse: {e}"))?;
        // If this line appears and no "discovered" line ever follows, multicast is not reaching us:
        // on Android that is a missing MulticastLock, on a network it is client isolation.
        super::trace!("browsing {SERVICE_TYPE} as {self_device_id}");
        let seen = Arc::clone(&self.seen);

        tauri::async_runtime::spawn(async move {
            while let Ok(event) = receiver.recv_async().await {
                match event {
                    ServiceEvent::ServiceResolved(service) => {
                        let properties = service.get_properties();
                        let device_id = properties
                            .get_property_val_str("id")
                            .unwrap_or_default()
                            .to_string();
                        // Our own advertisement comes back to us; it is not a peer.
                        if device_id.is_empty() || device_id == self_device_id {
                            continue;
                        }
                        // Every advertised address is kept. Taking just one would be a coin flip on
                        // any machine with a virtual adapter, and the wrong side of it looks
                        // exactly like "the other device isn't there".
                        let mut addrs: Vec<String> =
                            service.get_addresses_v4().into_iter().map(|a| a.to_string()).collect();
                        if addrs.is_empty() {
                            continue;
                        }
                        // Stable order, so the panel does not reshuffle between polls.
                        addrs.sort();
                        let Some(first) = addrs.first().cloned() else { continue };
                        let discovered = Discovered {
                            device_id,
                            name: properties
                                .get_property_val_str("name")
                                .unwrap_or("Unknown device")
                                .to_string(),
                            addr: first,
                            addrs,
                            port: service.get_port(),
                            cert_prefix: properties
                                .get_property_val_str("cert")
                                .unwrap_or_default()
                                .to_string(),
                        };
                        super::trace!(
                            "discovered {:?} at {:?} port {}",
                            discovered.name,
                            discovered.addrs,
                            discovered.port
                        );
                        if let Ok(mut seen) = seen.lock() {
                            seen.insert(service.get_fullname().to_string(), discovered);
                        }
                    }
                    ServiceEvent::ServiceRemoved(_, fullname) => {
                        if let Ok(mut seen) = seen.lock() {
                            seen.remove(&fullname);
                        }
                    }
                    _ => {}
                }
            }
        });
        Ok(())
    }

    pub fn found(&self) -> Vec<Discovered> {
        self.seen.lock().map(|s| s.values().cloned().collect()).unwrap_or_default()
    }

    /// Stop the daemon and the thread it runs on.
    ///
    /// This is not optional tidying. `ServiceDaemon` owns a background thread that keeps using its
    /// internal synchronisation after the handle is dropped; letting it be torn down implicitly is
    /// how you get `FORTIFY: pthread_mutex_lock called on a destroyed mutex` and an abort during
    /// shutdown. Telling it to stop first is what makes the teardown ordered.
    pub fn shutdown(&self) {
        self.stop_advertising();
        // Best-effort: a daemon that has already stopped returns an error, which is the state we
        // wanted anyway.
        let _ = self.daemon.shutdown();
    }
}

impl Drop for Discovery {
    fn drop(&mut self) {
        // Belt and braces. Android destroys the activity without warning and Rust's drop order at
        // process teardown is not something to bet a native abort on, so the daemon is stopped here
        // as well as at every explicit exit point.
        self.shutdown();
    }
}

/// Real IPv4 interfaces only. Loopback would advertise an address no peer can reach.
fn local_addresses() -> Vec<IpAddr> {
    let Ok(interfaces) = if_addrs::get_if_addrs() else { return Vec::new() };
    interfaces
        .into_iter()
        .filter(|i| !i.is_loopback())
        .map(|i| i.ip())
        .filter(|ip| ip.is_ipv4())
        .collect()
}

/// Address to dial a discovered device on.
pub fn socket_addr(addr: &str, port: u16) -> Result<SocketAddr, String> {
    let ip: IpAddr = addr.parse().map_err(|_| format!("Not an IP address: {addr}"))?;
    Ok(SocketAddr::new(ip, port))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_addr_parses_and_rejects() {
        assert!(socket_addr("192.168.1.42", 45871).is_ok());
        assert_eq!(
            socket_addr("192.168.1.42", 45871).map(|a| a.to_string()),
            Ok("192.168.1.42:45871".to_string())
        );
        assert!(socket_addr("not-an-ip", 1).is_err());
        assert!(socket_addr("", 1).is_err());
    }

    #[test]
    fn local_addresses_excludes_loopback() {
        // Whatever the machine has, 127.0.0.1 must never be advertised — no peer could reach it.
        for ip in local_addresses() {
            assert!(!ip.is_loopback(), "advertised a loopback address: {ip}");
            assert!(ip.is_ipv4());
        }
    }
}
