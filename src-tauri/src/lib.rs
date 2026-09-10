mod peer;

use std::borrow::Cow;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

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

/// Appended to trusted HTML documents. The page has its own origin, so key presses inside it never
/// reach Bode's window; this forwards just the fullscreen keys, which is what makes F11 work there
/// the way it does in the sandboxed frame (HtmlView listens for the message). Appending *after* the
/// document, rather than injecting into <head>, keeps the doctype — and so standards mode — intact.
const KEY_FORWARDER: &[u8] = b"<script>(function(){addEventListener('keydown',function(e){\
if(e.key!=='F11'&&e.key!=='Escape')return;\
try{top.postMessage({__bode:'key',key:e.key},'*')}catch(_){}\
if(e.key==='F11')e.preventDefault();},true);})();</script>";

/// Whether a request is for a document to display, as opposed to a subresource or something the
/// page fetched itself — only the former should get the key forwarder appended. An engine that
/// sends no `Sec-Fetch-Dest` counts as a document: a stray script tag is a far smaller problem
/// than a fullscreen key that silently does nothing.
fn is_document_request(request: &tauri::http::Request<Vec<u8>>) -> bool {
    request
        .headers()
        .get("Sec-Fetch-Dest")
        .and_then(|v| v.to_str().ok())
        .map_or(true, |d| matches!(d, "document" | "iframe" | "frame"))
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

    let mut body = match std::fs::read(&file) {
        Ok(b) => b,
        Err(_) => return deny(404, "Not found"),
    };

    let mime = mime_for(&file);
    if mime.starts_with("text/html") && is_document_request(&request) {
        body.extend_from_slice(KEY_FORWARDER);
    }

    tauri::http::Response::builder()
        .status(200)
        .header("Content-Type", mime)
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

/*
 * Dragging a tab between windows.
 *
 * A tab torn out of the strip is dropped somewhere on the desktop, and only the backend knows what
 * is under that point — a webview cannot see past its own window, and HTML drag-and-drop does not
 * cross OS windows. So the frontend reports where the pointer was released and asks these two
 * questions: is another Bode window there, and if so, please hand it this document.
 */

/// Label of another Bode window whose frame contains the given physical screen point, if any.
/// `exclude` is the dragging window's own label — dropping a tab back on its own window is a
/// no-op, not a hand-off.
#[tauri::command]
fn window_at_point(app: tauri::AppHandle, x: i32, y: i32, exclude: String) -> Option<String> {
    // A focused window is the one most likely to be on top where frames overlap, and the stacking
    // order itself isn't something Tauri exposes. Check it first, then everything else.
    let mut labels: Vec<String> = app
        .webview_windows()
        .into_iter()
        .filter(|(label, w)| *label != exclude && !w.is_minimized().unwrap_or(false))
        .filter(|(_, w)| {
            match (w.outer_position(), w.outer_size()) {
                (Ok(p), Ok(s)) => {
                    x >= p.x && y >= p.y && x < p.x + s.width as i32 && y < p.y + s.height as i32
                }
                _ => false,
            }
        })
        .map(|(label, _)| label)
        .collect();
    labels.sort_by_key(|label| {
        let focused = app
            .get_webview_window(label)
            .and_then(|w| w.is_focused().ok())
            .unwrap_or(false);
        (!focused, label.clone())
    });
    labels.into_iter().next()
}

/// Hand a document to another Bode window and bring that window forward, on the same event the
/// OS uses to open a file into a running Bode.
#[tauri::command]
fn send_file_to_window(app: tauri::AppHandle, label: String, path: String) -> Result<(), String> {
    let win = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("No window named {label}"))?;
    // Desktop only: `unminimize` does not exist on Android, which has no minimised state for a
    // window to be in. It matters on desktop — handing a document to a minimised window would
    // otherwise open it somewhere the user cannot see.
    #[cfg(desktop)]
    let _ = win.unminimize();
    let _ = win.set_focus();
    win.emit("open-file", path).map_err(|e| e.to_string())
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

/*
 * Snap Layouts for a window that has no native caption.
 *
 * With `decorations: false` the caption is drawn by the frontend (see TitleBar.tsx), and Windows
 * stops offering the tiling flyout that appears when you hover a real maximise button. It is not a
 * thing a web page can put back: the flyout is the shell's, and the shell decides to show it by
 * asking the *window* — WM_NCHITTEST — and being told HTMAXBUTTON. So the window has to answer, and
 * to answer it has to know where the frontend drew the button. That is the whole of this module.
 *
 * Everything else undecorating costs is already handled elsewhere: dragging and double-click to
 * maximise come from `data-tauri-drag-region`, and tao hit-tests the resize edges itself for
 * undecorated resizable windows.
 *
 * One caveat is worth stating plainly rather than discovering later. WebView2 is a child window
 * covering the client area, so whether the top-level window is asked about a point over the button
 * at all is up to how that child hit-tests it. If the flyout does not appear, that is why, and the
 * fix is on the webview side rather than here. Nothing below changes what a click does: the button
 * in the frontend keeps working either way, because HTMAXBUTTON is only ever returned in place of
 * HTCLIENT, and the WM_NCLBUTTON* arms only fire for messages the shell itself sent us.
 */
#[cfg(windows)]
mod snap_layout {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::ScreenToClient;
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        IsZoomed, ShowWindow, HTCLIENT, HTMAXBUTTON, SW_MAXIMIZE, SW_RESTORE, WM_NCHITTEST,
        WM_NCLBUTTONDOWN, WM_NCLBUTTONUP,
    };

    /// Keyed by HWND: every window draws its own caption, and the button sits at the right edge, so
    /// two windows of different widths do not share a rect.
    fn rects() -> &'static Mutex<HashMap<isize, RECT>> {
        static RECTS: OnceLock<Mutex<HashMap<isize, RECT>>> = OnceLock::new();
        RECTS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// An arbitrary but fixed id; re-subclassing with the same pair is a no-op update rather than a
    /// second subclass, which is what makes it safe to call this on every rect report.
    const SUBCLASS_ID: usize = 0xB0DE;

    unsafe extern "system" fn proc_(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        match msg {
            WM_NCHITTEST => {
                let hit = DefSubclassProc(hwnd, msg, wparam, lparam);
                // Only ever upgrade a plain client hit. Anything tao already claimed — a resize
                // edge, most importantly — must be left exactly as it decided.
                if hit != HTCLIENT as LRESULT {
                    return hit;
                }
                // lparam carries screen coordinates as two signed 16-bit halves.
                let mut pt = POINT {
                    x: (lparam & 0xFFFF) as i16 as i32,
                    y: ((lparam >> 16) & 0xFFFF) as i16 as i32,
                };
                if ScreenToClient(hwnd, &mut pt) == 0 {
                    return hit;
                }
                let inside = rects()
                    .lock()
                    .ok()
                    .and_then(|m| m.get(&(hwnd as isize)).copied())
                    .is_some_and(|r| {
                        pt.x >= r.left && pt.x < r.right && pt.y >= r.top && pt.y < r.bottom
                    });
                if inside {
                    HTMAXBUTTON as LRESULT
                } else {
                    hit
                }
            }
            // Swallowed so the default handler does not draw its own pressed caption button over
            // ours; the actual toggle happens on release, as it does for a real caption button.
            WM_NCLBUTTONDOWN if wparam == HTMAXBUTTON as WPARAM => 0,
            WM_NCLBUTTONUP if wparam == HTMAXBUTTON as WPARAM => {
                ShowWindow(hwnd, if IsZoomed(hwnd) != 0 { SW_RESTORE } else { SW_MAXIMIZE });
                0
            }
            _ => DefSubclassProc(hwnd, msg, wparam, lparam),
        }
    }

    /// Record where the frontend drew the maximise button, and make sure we are subclassed.
    pub fn set_rect(hwnd: HWND, x: i32, y: i32, w: i32, h: i32) {
        if let Ok(mut m) = rects().lock() {
            m.insert(
                hwnd as isize,
                RECT { left: x, top: y, right: x + w, bottom: y + h },
            );
        }
        unsafe { SetWindowSubclass(hwnd, Some(proc_), SUBCLASS_ID, 0) };
    }

    /// Drop a closed window's rect so the map does not grow for the life of the process.
    pub fn forget(hwnd: HWND) {
        if let Ok(mut m) = rects().lock() {
            m.remove(&(hwnd as isize));
        }
    }
}

/// Report the maximise button's position, in physical pixels relative to the window's client area.
///
/// Called by TitleBar.tsx whenever the caption is laid out or the window resized. Only Windows has
/// anything to do with it; everywhere else the frontend button is the entire mechanism.
#[tauri::command]
fn set_caption_button_rect(window: tauri::WebviewWindow, x: i32, y: i32, w: i32, h: i32) {
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        snap_layout::set_rect(hwnd.0 as _, x, y, w, h);
    }
    #[cfg(not(windows))]
    let _ = (window, x, y, w, h);
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
        .manage(peer::commands::Nearby::default())
        .register_uri_scheme_protocol("bodehtml", serve_trusted_html)
        .invoke_handler(tauri::generate_handler![
            read_file_bytes,
            write_file_bytes,
            decrypt_pdf,
            take_launch_file,
            trust_html_file,
            window_at_point,
            send_file_to_window,
            set_titlebar_color,
            set_caption_button_rect,
            peer::commands::nearby_status,
            peer::commands::nearby_start_sharing,
            peer::commands::nearby_stop_sharing,
            peer::commands::nearby_begin_pairing,
            peer::commands::nearby_cancel_pairing,
            peer::commands::nearby_ack_pairing,
            peer::commands::nearby_pair,
            peer::commands::nearby_unpair,
            peer::commands::nearby_rename,
            peer::commands::nearby_list,
            peer::commands::nearby_fetch,
            peer::commands::nearby_cancel,
            peer::commands::nearby_pin,
            peer::commands::nearby_cache_list,
            peer::commands::nearby_cache_remove,
            peer::commands::nearby_push,
            peer::commands::nearby_set_inbox,
            peer::commands::nearby_publish_state,
            peer::commands::nearby_take_received,
            peer::commands::nearby_sync_state
        ])
        // A tear-off window is a real OS window that can be closed on its own, so the caption rect
        // it registered has to go with it rather than sit in the map for the life of the process.
        .on_window_event(|_window, _event| {
            #[cfg(windows)]
            if matches!(_event, tauri::WindowEvent::Destroyed) {
                if let Ok(hwnd) = _window.hwnd() {
                    snap_layout::forget(hwnd.0 as _);
                }
            }
        })
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                // Devtools are available in a debug build but no longer opened for you. Chromium
                // draws a dimensions readout in the top-right corner of the viewport whenever the
                // window resizes while they are open, and with the caption drawn by the page that
                // readout lands squarely on top of minimise, maximise and close. Open them with
                // F12 when they are wanted.
                //
                // Default dark title bar so it never flashes the OS accent before the
                // frontend applies the active theme's colours.
                #[cfg(windows)]
                apply_caption(&window, colorref(0x1a, 0x1b, 0x1e), colorref(0xe6, 0xe7, 0xea));
                // Every use above is compiled out on a mobile release build; keep it "used" there.
                #[cfg(not(any(debug_assertions, windows)))]
                let _ = window;
            }
            // Resume a share from the last session. A no-op for anyone who has never shared, so
            // this costs nothing — no key, no socket, no firewall prompt — until it is wanted.
            peer::commands::restore_sharing(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running Bode")
        .run(|app, event| {
            // Stop the mDNS daemon before the process unwinds. Its background thread outlives a
            // plain drop, and tearing the app down around a running thread is what produces a
            // native abort at exit rather than a clean quit.
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(nearby) = app.try_state::<peer::commands::Nearby>() {
                    peer::commands::shutdown(&nearby);
                }
            }
        });
}
