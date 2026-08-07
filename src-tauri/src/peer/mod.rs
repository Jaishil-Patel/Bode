/*
 * Nearby devices — LAN document access between a desktop and a phone running Bode.
 *
 * The desktop shares one folder and answers requests; the phone browses it and fetches documents.
 * Both sides compile this module: the phone still answers `/v1/info` and takes part in pairing, so
 * the asymmetry (only the desktop turns sharing on) is runtime policy, never a `cfg`.
 *
 * Everything on the wire is mutual TLS with certificates pinned at pairing, so an unpaired peer is
 * refused during the handshake and never reaches a route.
 *
 * IMPORTANT: the crate is built with `panic = "abort"`, so a panic in a spawned connection handler
 * takes down the whole app and cannot be caught. Nothing in this module may `unwrap`, `expect`, or
 * index a slice that might be short — every fallible step returns `Result`/`Option` and maps to a
 * status code.
 */

/// Diagnostics for the one part of Bode that cannot be debugged by looking at it.
///
/// Everything else here either works or shows the user an error. Discovery does neither: when mDNS
/// is dropped by the network, or a peer advertises an address nothing can reach, the symptom is an
/// empty list — indistinguishable from "the other device isn't running". These lines are how that
/// gets diagnosed on a phone, where `println!` lands in logcat under `RustStdoutStderr`.
///
/// Deliberately not a logging crate: this is a fixed handful of lines at decision points, and no
/// dependency earns its place for that. Nothing here may log a document's contents or a full local
/// path — addresses and counts only.
macro_rules! trace {
    ($($arg:tt)*) => {
        println!("[bode.peer] {}", format_args!($($arg)*))
    };
}
pub(crate) use trace;

#[cfg(test)]
mod tests;

pub mod cache;
pub mod client;
pub mod commands;
pub mod discovery;
pub mod docid;
pub mod identity;
pub mod paths;
pub mod server;
pub mod tls;
