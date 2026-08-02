# Bode

Do you hate the ads and bloating some other pdf apps have, I've got the perfect alternative for you ;).

A clean, fast, customizable PDF reader **and** annotator — that also opens and edits Markdown and HTML — running on desktop (Windows/macOS/Linux) and Android, built with Tauri + React.

**Bode is free and open source.** Contributions are welcome — whether that's fixing a bug, adding a feature, improving the docs, or just opening an issue with an idea. See [Contributing](#contributing) below to get started.

## Features

### Viewing
- **Fast viewing** — virtualized continuous scroll renders only the pages near the
  viewport, so 500+ page PDFs stay smooth and light.
- **Search & select** — real text layer with in-document find (highlight + next/prev).
- **Navigation** — page thumbnails and document outline/bookmarks in the sidebar.
- **Zoom** — toolbar controls, `Ctrl`+scroll on desktop, and pinch-to-zoom on touch.
- **Customization** — Light / Dark / Sepia / OLED themes plus a fully custom theme
  (any colors), layout options (continuous vs single page, sidebar side, page gap),
  and a `Ctrl+K` command palette.
- **Remembers you** — recent files and last-read page per document, persisted to disk.

### Annotate & sign
- **Highlighter** — select text to highlight, with three editable colour presets.
- **Freehand pen, shapes & text boxes** — draw, add rectangles/ellipses (outlined or
  filled with adjustable opacity), and drop free text anywhere; tune colour and thickness.
- **Edit existing text** — whiteout + retype: tap a word, it's covered and replaced with an
  editable box pre-filled with the original text, font-matched and width-fitted so the edit
  blends in.
- **Sign documents** — draw a signature once, then place and resize it on any page.
- **Eraser** — tap or drag to selectively remove any annotation.
- **Undo / redo** — full history of every change (`Ctrl+Z` / `Ctrl+Shift+Z`).
- **Save** — flatten all annotations into a brand-new PDF via a save dialog (the original is
  never modified). Powered by `pdf-lib`.

### Markdown
- **Read Markdown** — open any `.md` / `.markdown` file (file-association, "Open with", or the
  open dialog) and read it as a clean, reflowed document that follows your active theme.
- **Edit & save** — toggle into a source editor (`Ctrl+E`), make changes with live preview on
  toggle-back, and save straight to the original file (`Ctrl+S`). External links open in your
  browser, not in the app.

### HTML
- **View HTML** — open any `.html` / `.htm` file and see the page as it was written, with its own
  styles and layout, rather than re-themed.
- **Sandboxed by default** — the page is rendered in a frame with scripts, forms, popups and
  navigation disabled, and Bode's strict CSP blocks remote resources. Opening an untrusted HTML
  file can't run anything.
- **Trusted pages** — a page that builds its UI in JavaScript is a blank shell in the sandbox, so
  the shield button in the toolbar lets you trust the open file and run it: scripts execute,
  `localStorage` persists across restarts, and relative images/stylesheets resolve. The choice is
  remembered, so a local tool you use often just opens working; click the shield again to sandbox
  it and forget it. Trusted pages stay offline (no network), only files in that page's own folder
  are served, and everything else is refused.
- **Edit & save** — the same source editor and in-place save as Markdown (`Ctrl+E` / `Ctrl+S`).
  Links in the page open in your browser.

### Platforms
- **Desktop** — Windows, macOS, Linux.
- **Android** — same app in a touch-friendly layout: in-app file picker, pinch-to-zoom,
  safe-area aware toolbars, and a sideloadable APK.

## Prerequisites

- [Node.js](https://nodejs.org) 18+
- [Rust](https://rustup.rs) (stable, MSVC toolchain on Windows)
- On Windows: the **MSVC C++ build tools** and **WebView2 runtime**

For Android builds, additionally:
- **JDK 17** (the Android Gradle Plugin doesn't support newer JDKs)
- **Android Studio** with the SDK (API 34+), Platform-Tools, Build-Tools, and the **NDK**
- Rust Android targets: `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`
- `ANDROID_HOME` and `NDK_HOME` environment variables set

> If `cargo` isn't found in a new terminal, open a fresh shell so `~/.cargo/bin` is on PATH.

## Develop

```bash
npm install
npm run tauri dev          # desktop, with hot reload
npm run tauri android dev  # deploy to a connected Android device (USB debugging on)
```

## Build a distributable

```bash
npm run release            # both platforms
npm run release:android    # Android APK only
npm run release:desktop    # desktop installer only
```

Everything lands in `release/`, one file per platform, stamped with the version from
`src-tauri/tauri.conf.json`:

```
release/
  Bode-0.2.0-android-arm64.apk
  Bode-0.2.0-windows-x64-setup.exe
```

Each build replaces the previous file for that platform, so the folder never accumulates. Bump
`version` in `src-tauri/tauri.conf.json` and `package.json` together to cut a new one.

Install the APK on a connected phone with `adb install -r release/Bode-<version>-android-arm64.apk`.

Under the hood this is `scripts/release.mjs` wrapping `tauri build` and `tauri android build`, which
otherwise scatter their output across per-architecture Gradle flavor directories and
`src-tauri/target/release/bundle/`. Run those directly if you need a variant the script doesn't
cover — an `.aab` for Play, or a non-arm64 APK.

The APK is a **debug** build, which is why it's large (~160 MB of unstripped native symbols). Tauri
emits release APKs unsigned and Android refuses to install those, so a debug build is the only one
that goes straight onto a device. Producing a small signed release APK needs a keystore you generate
yourself with `keytool`, plus a `signingConfig` in the Gradle project.

## Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| Open file (PDF, Markdown or HTML) | `Ctrl+O` |
| Edit / preview source (Markdown, HTML) | `Ctrl+E` |
| Save (Markdown, HTML) | `Ctrl+S` |
| Find in document | `Ctrl+F` |
| Command palette | `Ctrl+K` |
| Toggle sidebar | `Ctrl+B` |
| Undo / redo | `Ctrl+Z` / `Ctrl+Shift+Z` |
| Zoom in / out | `Ctrl +` / `Ctrl -` |
| Reset zoom | `Ctrl+0` |
| Next / previous page (single-page mode) | `PageDown` / `PageUp` |
| Delete selected annotation | `Delete` |
| Tools: select / highlight / text / rectangle | `V` / `H` / `T` / `R` |
| Tools: ellipse / pen / edit text / sign / eraser | `O` / `P` / `E` / `S` / `X` |

## Project layout

```
src/                 React frontend
  pdf/               PDF.js worker, document loader, page renderer, viewer, search, PDF export
  markdown/          Markdown rendering (markdown-it) + reflowed reader view
  html/              HTML tab view (sandboxed frame)
  annotations/       annotation data model (Zustand) + overlay rendering/editing layer
  components/        Toolbar, AnnotationBar, Sidebar, SearchBar, CommandPalette, SignaturePad, icons
  platform/          cross-platform file I/O (desktop commands vs Android plugin-fs)
  settings/          theme definitions, settings store, settings panel
  store/             viewer state (Zustand)
  styles/            Tailwind entry + theme tokens (CSS variables)
src-tauri/           Rust shell (file reading/writing, launch-file handling, plugins)
  gen/android/       generated Android project (not committed; created by `tauri android init`)
```

## Architecture notes

- PDF.js runs entirely in the webview; Rust is a thin native shell (file dialogs, reading/writing
  bytes, persistence, `.pdf`/`.md`/`.html` file associations). This keeps the text layer free.
- **Markdown and HTML are text tab kinds** alongside PDFs. Both are read into `textSource`, share
  the source editor (`Ctrl+E`) and the in-place save (`Ctrl+S`), and have the PDF-only chrome
  (page nav, search, annotations, sidebar) gated off. They differ only in how the preview is
  produced:
  - **Markdown** is rendered with `markdown-it` (`html: false`, so raw HTML is escaped — safe to
    inject under the strict CSP with no extra sanitizer) into a reflowed view that follows the
    active theme.
  - **HTML** is shown as itself, so it goes into a `<iframe srcdoc>` rather than the app's DOM.
    Safety comes from the `sandbox` attribute (no `allow-scripts`: no scripts, forms, popups or
    navigation) rather than from sanitizing, with the inherited CSP blocking remote resources as
    a second layer. `allow-same-origin` is set purely so link clicks can be intercepted and routed
    to the OS browser — it must never be paired with `allow-scripts` on a srcdoc frame.
- **Trusted HTML pages get their own origin.** Running a page's scripts is impossible in a srcdoc
  frame — it inherits Bode's CSP, and `allow-scripts` there would hand the page Bode's origin. So
  trusting a file instead serves it over the `bodehtml` custom protocol (`serve_trusted_html` in
  `src-tauri/src/lib.rs`), which puts it on a separate origin with its own CSP and storage. What
  contains it: the backend only serves files under a directory the user trusted this session (held
  in memory, never persisted, canonicalized before the check so `..` can't escape); the response
  CSP allows the page's own inline code but no network; and Tauri registers its IPC bootstrap with
  `for_main_frame_only`, so a subframe never receives the invoke key and cannot call Bode's
  commands. The app-side CSP needs `frame-src` to list this origin — in `index.html` **and**
  `tauri.conf.json`, which must stay in sync. Trusted paths persist in `settings.json`, and are
  re-registered with the backend on open — which is why `loadTextTab` awaits `settingsReady()`
  before reading them, since a file passed at launch can start opening before hydration finishes.
- **Annotations are an overlay model.** Highlights, pen, shapes, text, edits and signatures are
  stored as scale-independent geometry (PDF points) in `annotations.json` and rendered over the
  page. They're only baked into the file on **Save**, which flattens them into a new PDF with
  `pdf-lib` — so the original is never touched and edits stay reversible until you export.
- Themes are pure CSS variables (`src/styles/themes.css`) — adding a theme is one block, no
  component changes.
- Scroll virtualization uses a uniform page-size model (page 1's dimensions) for layout; each page
  still renders at its own true size. Mixed-size documents are the one known simplification to
  refine later.
- **Cross-platform file access:** desktop reads/writes via narrow Rust commands (any path); Android
  goes through `@tauri-apps/plugin-fs` to handle the `content://` URIs returned by the system file
  picker (`src/platform/files.ts`).

## Contributing

Bode is open source and contributions of all kinds are welcome — code, docs, bug reports, and feature ideas.

1. **Open an issue first** for anything non-trivial, so we can discuss the approach before you build it.
2. **Fork** the repo and create a branch off `main` (`git checkout -b my-feature`).
3. Set up your environment by following [Prerequisites](#prerequisites) and [Develop](#develop), and make sure the app runs locally.
4. Keep changes focused and match the existing code style.
5. **Open a pull request** describing what you changed and why. Reference the issue it addresses.

Not sure where to start? Check the open issues for anything tagged "good first issue", or just open a discussion with your idea. Every bit helps.

## License

Bode is licensed under the [Apache License 2.0](LICENSE). You're free to use, modify, and distribute it, including commercially, provided you preserve the license and attribution notices. By contributing, you agree that your contributions will be licensed under the same terms.
