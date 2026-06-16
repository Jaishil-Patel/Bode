# Bode

Do you hate the ads and bloating some other pdf apps have, I've got the perfect alternative for you ;).

## Features

- **Fast viewing** — virtualized continuous scroll renders only the pages near the
  viewport, so 500+ page PDFs stay smooth and light.
- **Search & select** — real text layer with in-document find (highlight + next/prev).
- **Navigation** — page thumbnails and document outline/bookmarks in the sidebar.
- **Customization** — Light / Dark / Sepia / OLED themes plus a fully custom theme
  (any colors), layout options (continuous vs single page, sidebar side, page gap),
  zen mode, and a `Ctrl+K` command palette.
- **Remembers you** — recent files and last-read page per document, persisted to disk.

## Prerequisites

- [Node.js](https://nodejs.org) 18+
- [Rust](https://rustup.rs) (stable, MSVC toolchain) — already installed in this environment
- On Windows: the **MSVC C++ build tools** and **WebView2 runtime** (both present here)

> If `cargo` isn't found in a new terminal, open a fresh shell so `~/.cargo/bin` is on PATH.

## Develop

```bash
npm install
npm run tauri dev      # launches the app with hot reload
```

## Build a distributable

```bash
npm run tauri build    # produces an installer in src-tauri/target/release/bundle/
```

## Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| Open PDF | `Ctrl+O` |
| Find in document | `Ctrl+F` |
| Command palette | `Ctrl+K` |
| Toggle sidebar | `Ctrl+B` |
| Zoom in / out | `Ctrl +` / `Ctrl -` |
| Reset zoom | `Ctrl+0` |
| Next / previous page (single-page mode) | `PageDown` / `PageUp` |

## Project layout

```
src/                 React frontend
  pdf/               PDF.js worker, document loader, page renderer, viewer, search
  components/        Toolbar, Sidebar, SearchBar, CommandPalette, icons
  settings/          theme definitions, settings store, settings panel
  store/             viewer state (Zustand)
  styles/            Tailwind entry + theme tokens (CSS variables)
src-tauri/           Rust shell (file reading, launch-file handling, plugins)
```

## Architecture notes

- PDF.js runs entirely in the webview; Rust is a thin native shell (file dialogs,
  reading bytes, persistence, `.pdf` file association). This keeps the text layer free.
- Themes are pure CSS variables (`src/styles/themes.css`) — adding a theme is one block,
  no component changes.
- Scroll virtualization uses a uniform page-size model (page 1's dimensions) for layout;
  each page still renders at its own true size. Mixed-size documents are the one known
  simplification to refine later.
- Editing/annotation/forms are out of scope for v1 but extend cleanly via PDF.js's
  annotation editor layer and `pdf-lib`.
