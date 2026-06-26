use std::sync::Mutex;
use tauri::{Manager, State};
#[cfg(desktop)]
use tauri::Emitter;

/// Holds the file path the app was launched with (e.g. via "Open with" / file association).
#[derive(Default)]
struct LaunchFile(Mutex<Option<String>>);

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
        .manage(LaunchFile(Mutex::new(launch_path)))
        .invoke_handler(tauri::generate_handler![
            read_file_bytes,
            write_file_bytes,
            take_launch_file,
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
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Bode");
}
