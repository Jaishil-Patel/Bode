# Bode

Do you hate the ads and bloating some other pdf apps have, I've got the perfect alternative for you ;).

A clean, fast, customizable PDF reader **and** annotator that runs on desktop (Windows/macOS/Linux) and Android — built with Tauri + React.

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
  zen mode, and a `Ctrl+K` command palette.
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
npm run tauri build                    # desktop installer → src-tauri/target/release/bundle/
npm run tauri android build --apk      # Android APK → src-tauri/gen/android/app/build/outputs/apk/
```

Install a built APK on a connected phone with `adb install -r <path-to.apk>`.

## Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| Open PDF | `Ctrl+O` |
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
  bytes, persistence, `.pdf` file association). This keeps the text layer free.
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
