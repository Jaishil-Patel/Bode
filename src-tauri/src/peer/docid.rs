/*
 * The Rust half of `src/platform/docId.ts`. Both sides must agree exactly, so the rules are
 * repeated here rather than inferred: per-segment percent encoding, literal `/` separators, and a
 * decoded segment that may not reintroduce a separator or a traversal step.
 *
 * Neither side trusts the other's validation — the frontend rejects a malformed id so the UI can
 * explain itself, and this rejects it again because a request could arrive from anywhere.
 */

pub const SCHEME: &str = "bode://";

/// Split a `bode://` id into its device and its share-root-relative path.
pub fn parse(id: &str) -> Option<(String, String)> {
    let rest = id.strip_prefix(SCHEME)?;
    let (device_id, encoded) = rest.split_once('/')?;
    if device_id.is_empty() {
        return None;
    }

    let mut segments = Vec::new();
    for raw in encoded.split('/') {
        if raw.is_empty() {
            continue;
        }
        // `percent_decode_str` is lenient and passes a malformed escape through as literal bytes,
        // whereas the frontend's `decodeURIComponent` throws. Reject it here too, so a given id is
        // valid on both sides or neither.
        if !escapes_well_formed(raw) {
            return None;
        }
        let decoded = percent_encoding::percent_decode_str(raw).decode_utf8().ok()?;
        // `%2F`, `%5C`, `%2E%2E` and `%00` all have to be caught here, after decoding.
        if decoded.is_empty()
            || decoded == "."
            || decoded == ".."
            || decoded.contains('/')
            || decoded.contains('\\')
            || decoded.contains('\0')
        {
            return None;
        }
        segments.push(decoded.into_owned());
    }

    if segments.is_empty() {
        return None;
    }
    Some((device_id.to_string(), segments.join("/")))
}

/// Every `%` must introduce exactly two hex digits, matching `decodeURIComponent`.
fn escapes_well_formed(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 3 > bytes.len()
                || !bytes[i + 1].is_ascii_hexdigit()
                || !bytes[i + 2].is_ascii_hexdigit()
            {
                return false;
            }
            i += 3;
        } else {
            i += 1;
        }
    }
    true
}

/// Build a `bode://` id, byte-for-byte identically to the frontend's `formatDocId`.
///
/// Matching exactly matters more than it looks: an id is a document's identity, so if Rust escaped
/// `(` where JavaScript did not, the same PDF would produce two different ids, open in two tabs and
/// look up two different cache entries. Hence the unreserved set below is `encodeURIComponent`'s,
/// not the shorter RFC 3986 one.
pub fn format(device_id: &str, rel: &str) -> String {
    let encoded: Vec<String> = rel
        .split(['/', '\\'])
        .filter(|s| !s.is_empty())
        .map(encode_segment)
        .collect();
    format!("{SCHEME}{device_id}/{}", encoded.join("/"))
}

fn encode_segment(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.as_bytes() {
        match byte {
            // Exactly what `encodeURIComponent` leaves alone.
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(*byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// The file name a document should be saved under locally.
pub fn base_name(rel: &str) -> &str {
    rel.rsplit('/').next().unwrap_or(rel)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_matches_the_frontends_encoding() {
        // These are `encodeURIComponent`'s exact answers. A difference here would silently split
        // one document into two identities across the IPC boundary.
        assert_eq!(
            format("d7f3a91c4b2e8a01", "Papers/Fluid Mechanics.pdf"),
            "bode://d7f3a91c4b2e8a01/Papers/Fluid%20Mechanics.pdf"
        );
        assert_eq!(format("dev", "caf\u{e9}.pdf"), "bode://dev/caf%C3%A9.pdf");
        assert_eq!(format("dev", "a&b#c.pdf"), "bode://dev/a%26b%23c.pdf");
        // Left alone by encodeURIComponent, so they must be left alone here too.
        assert_eq!(format("dev", "a!~*'().pdf"), "bode://dev/a!~*'().pdf");
        assert_eq!(format("dev", "100%.pdf"), "bode://dev/100%25.pdf");
    }

    #[test]
    fn format_and_parse_round_trip() {
        for rel in ["a.pdf", "A B/c d.pdf", "caf\u{e9}/\u{4e2d}\u{6587}.md", "100%/a&b.html"] {
            let id = format("dev1", rel);
            assert_eq!(parse(&id), Some(("dev1".to_string(), rel.to_string())), "for {rel}");
        }
    }

    #[test]
    fn parses_a_well_formed_id() {
        assert_eq!(
            parse("bode://d7f3a91c4b2e8a01/Papers/Fluid%20Mechanics.pdf"),
            Some(("d7f3a91c4b2e8a01".into(), "Papers/Fluid Mechanics.pdf".into()))
        );
        assert_eq!(
            parse("bode://abc/thesis.pdf"),
            Some(("abc".into(), "thesis.pdf".into()))
        );
    }

    #[test]
    fn rejects_escapes_that_decode_into_traversal() {
        // The whole point of decoding per segment: these must not slip through.
        assert_eq!(parse("bode://abc/%2E%2E/secrets.txt"), None);
        assert_eq!(parse("bode://abc/a%2F..%2Fb.pdf"), None);
        assert_eq!(parse("bode://abc/a%5C..%5Cb.pdf"), None);
        assert_eq!(parse("bode://abc/a%00.pdf"), None);
        assert_eq!(parse("bode://abc/../x.pdf"), None);
    }

    #[test]
    fn rejects_malformed_ids() {
        assert_eq!(parse("C:/Users/jaish/thesis.pdf"), None);
        assert_eq!(parse("content://media/1234"), None);
        assert_eq!(parse("bode://"), None);
        assert_eq!(parse("bode:///thesis.pdf"), None, "empty device id");
        assert_eq!(parse("bode://abc/"), None, "no path");
        assert_eq!(parse("bode://abc/%ZZ.pdf"), None, "bad escape");
    }

    #[test]
    fn base_name_takes_the_last_segment() {
        assert_eq!(base_name("Papers/Fluid Mechanics.pdf"), "Fluid Mechanics.pdf");
        assert_eq!(base_name("thesis.pdf"), "thesis.pdf");
    }
}
