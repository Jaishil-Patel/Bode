use std::path::{Component, Path, PathBuf};

/// Extensions the share will serve. Anything else is invisible to a peer, so pointing a share at a
/// folder can't hand over ssh keys or a password database by accident.
const SERVABLE: &[&str] = &["pdf", "md", "markdown", "mdown", "mkd", "markdn", "html", "htm", "xhtml"];

/// True for a file a peer is allowed to see. Dotfiles are always hidden.
pub fn is_servable(path: &Path) -> bool {
    if is_hidden(path) {
        return false;
    }
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => SERVABLE.contains(&ext.to_ascii_lowercase().as_str()),
        None => false,
    }
}

/// A dotfile or dot-directory. Peers never see these, listed or fetched.
pub fn is_hidden(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with('.'))
}

/// Resolve a share-root-relative path supplied by a peer into a real path inside `root`.
///
/// Returns `None` for anything that is not strictly inside `root`. Callers decide whether they
/// wanted a file or a directory; an empty `rel` resolves to the root itself so a listing can start
/// there.
///
/// Two layers, because neither is sufficient alone:
///
/// 1. **Structural rejection, before touching the filesystem.** A segment that is empty, `.`, `..`,
///    contains NUL or a backslash, or parses as anything other than one plain name (a drive letter,
///    a UNC prefix, a root) never reaches `join`. This is what stops `..` traversal.
/// 2. **Canonicalize, then verify containment.** This is what stops a *symlink* that lives inside
///    the root but points outside it — a case the structural check cannot see. `Path::starts_with`
///    is segment-aware, so `/a/bc` correctly does not start with `/a/b`.
pub fn resolve_in(root: &Path, rel: &str) -> Option<PathBuf> {
    let root = std::fs::canonicalize(root).ok()?;

    let mut joined = root.clone();
    for seg in rel.split('/') {
        if seg.is_empty() {
            continue;
        }
        if seg == "." || seg == ".." || seg.contains('\0') || seg.contains('\\') {
            return None;
        }
        // `Component::Normal` is the only shape a single path segment may take. A drive letter,
        // root, or prefix parses as something else and is refused.
        let mut components = Path::new(seg).components();
        match (components.next(), components.next()) {
            (Some(Component::Normal(_)), None) => {}
            _ => return None,
        }
        joined.push(seg);
    }

    let resolved = std::fs::canonicalize(&joined).ok()?;
    if !resolved.starts_with(&root) {
        return None;
    }
    Some(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Build a throwaway tree: <tmp>/bode-test-<n>/{root/{a.pdf,sub/b.pdf},outside.pdf}
    fn fixture(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("bode-paths-test-{tag}"));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("root/sub")).expect("create fixture");
        fs::write(base.join("root/a.pdf"), b"a").expect("write a");
        fs::write(base.join("root/sub/b.pdf"), b"b").expect("write b");
        fs::write(base.join("outside.pdf"), b"o").expect("write outside");
        base
    }

    #[test]
    fn resolves_a_nested_file() {
        let base = fixture("nested");
        let root = base.join("root");
        let got = resolve_in(&root, "sub/b.pdf").expect("should resolve");
        assert!(got.ends_with("b.pdf"));
        assert!(got.starts_with(fs::canonicalize(&root).unwrap()));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn empty_rel_resolves_to_the_root() {
        let base = fixture("empty");
        let root = base.join("root");
        assert_eq!(
            resolve_in(&root, ""),
            Some(fs::canonicalize(&root).expect("canonicalize root"))
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn rejects_traversal_and_absolute_and_separators() {
        let base = fixture("traversal");
        let root = base.join("root");
        // `..` must not escape, however it is spelled or nested.
        assert_eq!(resolve_in(&root, "../outside.pdf"), None);
        assert_eq!(resolve_in(&root, "sub/../../outside.pdf"), None);
        assert_eq!(resolve_in(&root, ".."), None);
        assert_eq!(resolve_in(&root, "."), None);
        // A backslash would be a separator on Windows, so a segment may never contain one.
        assert_eq!(resolve_in(&root, "sub\\..\\..\\outside.pdf"), None);
        // Absolute paths and drive letters are not relative segments.
        assert_eq!(resolve_in(&root, "/etc/passwd"), None);
        assert_eq!(resolve_in(&root, "C:/Windows/System32/config/SAM"), None);
        // NUL truncation tricks.
        assert_eq!(resolve_in(&root, "a.pdf\0.txt"), None);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn rejects_a_file_that_does_not_exist() {
        let base = fixture("missing");
        let root = base.join("root");
        assert_eq!(resolve_in(&root, "nope.pdf"), None);
        let _ = fs::remove_dir_all(&base);
    }

    /// The case the structural check cannot catch: a symlink inside the root pointing out of it.
    /// Unix-only because creating a symlink on Windows needs elevation or developer mode.
    #[cfg(unix)]
    #[test]
    fn rejects_a_symlink_escaping_the_root() {
        let base = fixture("symlink");
        let root = base.join("root");
        std::os::unix::fs::symlink(base.join("outside.pdf"), root.join("escape.pdf"))
            .expect("create symlink");
        assert_eq!(resolve_in(&root, "escape.pdf"), None);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn only_document_types_are_servable() {
        assert!(is_servable(Path::new("/a/thesis.pdf")));
        assert!(is_servable(Path::new("/a/notes.MD")));
        assert!(is_servable(Path::new("/a/page.html")));
        assert!(!is_servable(Path::new("/a/id_rsa")));
        assert!(!is_servable(Path::new("/a/secrets.kdbx")));
        assert!(!is_servable(Path::new("/a/.env")));
        // A dotfile is hidden even when its extension would otherwise qualify.
        assert!(!is_servable(Path::new("/a/.hidden.pdf")));
    }
}
