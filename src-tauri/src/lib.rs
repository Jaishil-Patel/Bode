use std::borrow::Cow;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Manager, State};
#[cfg(desktop)]
use tauri::Emitter;

/// Holds the file path the app was launched with (e.g. via "Open with" / file association).
#[derive(Default)]
struct LaunchFile(Mutex<Option<String>>);

/*
 * "Trusted page" support for HTML tabs.
 *
 * By default an HTML document is shown in a scriptless sandbox (see HtmlView.tsx). A page that
 * builds itself with JavaScript renders as a blank shell there, so the user can explicitly trust a
 * file — which reloads it through the `bodehtml` custom protocol below instead of `srcdoc`.
 *
 * That buys three things a srcdoc frame can't have: the document gets its OWN origin (so it is not
 * governed by Bode's CSP and its inline scripts run), a real localStorage bucket for that origin,
 * and working relative URLs for sibling images/stylesheets.
 *
 * What keeps it contained:
 * - Only files under a directory the user has explicitly trusted this session are ever served;
 *   the set lives in memory and is never persisted, so trust does not survive a restart.
 * - The served origin is not Bode's, so the page cannot touch the app's DOM or storage.
 * - Tauri injects its IPC bootstrap (and the invoke key that `on_message` checks) into main frames
 *   only, so a page in a subframe cannot call Bode's commands however it is loaded.
 * - The response below carries a CSP that keeps the page offline: it may run its own inline code
 *   but cannot reach the network.
 */
#[derive(Default)]
struct TrustedHtml(Mutex<HashSet<PathBuf>>);

/// Windows canonicalization returns a `\\?\C:\...` extended-length path; strip that prefix so the
/// value reads (and URL-encodes) like a normal path.
fn plain_path(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    s.strip_prefix("//?/").map(str::to_owned).unwrap_or(s)
}

/// Base URL the custom protocol is served from, which differs by platform.
fn protocol_origin() -> &'static str {
    #[cfg(any(windows, target_os = "android"))]
    {
        "http://bodehtml.localhost"
    }
    #[cfg(not(any(windows, target_os = "android")))]
    {
        "bodehtml://localhost"
    }
}

/// Mark an HTML file as trusted for this session and return the URL that serves it. Trust is
/// granted to the file's own directory so that sibling images and stylesheets resolve too.
#[tauri::command]
fn trust_html_file(path: String, state: State<TrustedHtml>) -> Result<String, String> {
    let file = std::fs::canonicalize(&path).map_err(|e| format!("Cannot open {path}: {e}"))?;
    if !file.is_file() {
        return Err(format!("Not a file: {path}"));
    }
    let dir = file
        .parent()
        .ok_or_else(|| format!("{path} has no parent directory"))?
        .to_path_buf();
    state.0.lock().map_err(|_| "trust store poisoned")?.insert(dir);

    // `set_path` percent-encodes whatever the filesystem gave us (spaces, #, ...).
    let mut url = tauri::Url::parse(protocol_origin()).map_err(|e| e.to_string())?;
    url.set_path(&plain_path(&file));
    Ok(url.to_string())
}

/// Content type from the file extension. Only what a local page realistically references.
fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" | "xhtml" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn deny(status: u16, msg: &str) -> tauri::http::Response<Cow<'static, [u8]>> {
    tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(Cow::Owned(msg.as_bytes().to_vec()))
        .unwrap()
}

/// Serve a file for a trusted HTML page. Anything outside a trusted directory is refused, so the
/// protocol can't be used as a general "read any file" bridge even by a page we did serve.
fn serve_trusted_html<R: tauri::Runtime>(
    ctx: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Cow<'static, [u8]>> {
    let raw = request.uri().path().trim_start_matches('/');
    let decoded = percent_encoding::percent_decode_str(raw).decode_utf8_lossy();

    // Canonicalize before the check so `..` segments and symlinks can't walk out of a trusted dir.
    let file = match std::fs::canonicalize(PathBuf::from(decoded.as_ref())) {
        Ok(p) => p,
        Err(_) => return deny(404, "Not found"),
    };

    let state = ctx.app_handle().state::<TrustedHtml>();
    let trusted = match state.0.lock() {
        Ok(g) => g.iter().any(|dir| file.starts_with(dir)),
        Err(_) => false,
    };
    if !trusted {
        return deny(403, "This file is not part of a trusted page.");
    }

    let body = match std::fs::read(&file) {
        Ok(b) => b,
        Err(_) => return deny(404, "Not found"),
    };

    tauri::http::Response::builder()
        .status(200)
        .header("Content-Type", mime_for(&file))
        // The page may run its own inline code, but only against itself — no network, no framing
        // of anything else. This is the document's own policy; Bode's CSP does not apply here.
        .header(
            "Content-Security-Policy",
            "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; \
             img-src 'self' data: blob:; media-src 'self' data: blob:; \
             font-src 'self' data:; connect-src 'self' data: blob:; \
             frame-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'none'",
        )
        // Saving an edit rewrites the file in place, so the frame must never serve a stale copy.
        .header("Cache-Control", "no-store")
        .body(Cow::Owned(body))
        .unwrap()
}

/// First CLI/argv entry that looks like a real, openable path (skipping flags). The caller is
/// responsible for dropping argv[0] (the program path) first.
fn first_existing_path<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    args.into_iter()
        .find(|a| !a.starts_with('-') && std::path::Path::new(a).exists())
}

/// Read a file's raw bytes. Used by the frontend to hand PDF data to PDF.js.
/// A dedicated command avoids wiring broad filesystem-scope permissions for arbitrary paths.
#[tauri::command]
fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| format!("Failed to read {path}: {e}"))
}

/// Write raw bytes to a file. Used to save an exported (flattened) PDF chosen via a save dialog.
/// A dedicated command keeps filesystem access narrow, matching `read_file_bytes`.
#[tauri::command]
fn write_file_bytes(path: String, bytes: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, bytes).map_err(|e| format!("Failed to write {path}: {e}"))
}

/// Decrypt a password-protected PDF and return the bytes of an unencrypted copy. The frontend
/// hands us the original file bytes plus the password the user already unlocked the document with,
/// so we can write a plaintext copy that opens without any password.
#[tauri::command]
fn decrypt_pdf(bytes: Vec<u8>, password: String) -> Result<Vec<u8>, String> {
    // Loading with the password authenticates and decrypts the objects in memory.
    let opts = lopdf::LoadOptions::with_password(&password);
    let mut doc = lopdf::Document::load_mem_with_options(&bytes, opts)
        .map_err(|e| format!("Could not unlock this PDF: {e}"))?;

    // Strip all encryption so the saved copy needs no password: drop the in-memory encryption
    // state (otherwise save_to would re-encrypt) and remove the trailer's /Encrypt reference.
    doc.encryption_state = None;
    doc.trailer.remove(b"Encrypt");

    let mut out = Vec::new();
    doc.save_to(&mut out)
        .map_err(|e| format!("Could not write the unlocked PDF: {e}"))?;
    Ok(out)
}

/// Return the path Bode was launched with, if any (consumed once).
#[tauri::command]
fn take_launch_file(state: State<LaunchFile>) -> Option<String> {
    state.0.lock().ok().and_then(|mut g| g.take())
}

/// Tint the native window title bar (Windows 11) to match the app theme, so it doesn't
/// inherit the OS accent colour. `caption`/`text` are 0x00BBGGRR COLORREF values.
#[cfg(windows)]
fn apply_caption(window: &tauri::WebviewWindow, caption: u32, text: u32) {
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR,
    };
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            DwmSetWindowAttribute(
                hwnd.0,
                DWMWA_CAPTION_COLOR as u32,
                &caption as *const u32 as *const core::ffi::c_void,
                4,
            );
            DwmSetWindowAttribute(
                hwnd.0,
                DWMWA_TEXT_COLOR as u32,
                &text as *const u32 as *const core::ffi::c_void,
                4,
            );
            // Match the thin window border so it doesn't show the OS accent either.
            DwmSetWindowAttribute(
                hwnd.0,
                DWMWA_BORDER_COLOR as u32,
                &caption as *const u32 as *const core::ffi::c_void,
                4,
            );
        }
    }
}

// Only the Windows caption code consumes this, so it's dead weight on every other target.
#[cfg(windows)]
#[inline]
fn colorref(r: u8, g: u8, b: u8) -> u32 {
    (r as u32) | ((g as u32) << 8) | ((b as u32) << 16)
}

/// Set the title bar background + text colours from RGB (called by the frontend per theme).
#[tauri::command]
fn set_titlebar_color(window: tauri::WebviewWindow, r: u8, g: u8, b: u8, tr: u8, tg: u8, tb: u8) {
    #[cfg(windows)]
    apply_caption(&window, colorref(r, g, b), colorref(tr, tg, tb));
    #[cfg(not(windows))]
    let _ = (window, r, g, b, tr, tg, tb);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // First CLI arg that looks like a real path is treated as a file to open (cold start).
    let launch_path = first_existing_path(std::env::args().skip(1));

    let builder = tauri::Builder::default();

    // Single-instance must be registered before any other plugin. When the OS launches Bode
    // again (e.g. opening a PDF while it's already running), this fires in the EXISTING process
    // with the new argv and the second process exits — so the file lands in the open window
    // instead of spawning another one. Desktop-only (no mobile support).
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        let path = first_existing_path(argv.into_iter().skip(1)); // argv[0] is the exe path
        // Bring an existing window forward — prefer "main", else any surviving window (in
        // "windows" open-mode the original "main" may have been closed).
        let target = app
            .get_webview_window("main")
            .or_else(|| app.webview_windows().into_values().next());
        if let Some(win) = target {
            let _ = win.unminimize();
            let _ = win.set_focus();
            // Emit to exactly ONE window; app.emit() would broadcast and double-open the file.
            if let Some(p) = path {
                let _ = win.emit("open-file", p);
            }
        }
    }));

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(LaunchFile(Mutex::new(launch_path)))
        .manage(TrustedHtml::default())
        .register_uri_scheme_protocol("bodehtml", serve_trusted_html)
        .invoke_handler(tauri::generate_handler![
            read_file_bytes,
            write_file_bytes,
            decrypt_pdf,
            take_launch_file,
            trust_html_file,
            set_titlebar_color
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                #[cfg(debug_assertions)]
                window.open_devtools();
                // Default dark title bar so it never flashes the OS accent before the
                // frontend applies the active theme's colours.
                #[cfg(windows)]
                apply_caption(&window, colorref(0x1a, 0x1b, 0x1e), colorref(0xe6, 0xe7, 0xea));
                // Every use above is compiled out on a mobile release build; keep it "used" there.
                #[cfg(not(any(debug_assertions, windows)))]
                let _ = window;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Bode");
}
