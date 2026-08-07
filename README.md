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

### Nearby devices
- **Read your desktop's documents on your phone** — share one folder on the desktop, pair the two
  devices once, and that folder shows up on the phone. Tap a document and it opens.
- **No account, no cloud, no server** — the two devices talk directly over your Wi-Fi. Nothing is
  uploaded anywhere and no third party ever holds your files. It works with the internet off.
- **Paired devices only** — each device generates a certificate on first use and pins the other's
  during pairing. Everything is end-to-end encrypted, and an unpaired device is refused during the
  TLS handshake, before it can send a single request. Unpairing takes effect immediately.
- **You confirm the pairing** — both screens show the same six characters; you check they match.
  That is what rules out someone intercepting the first exchange.
- **Only documents are visible** — just PDF, Markdown and HTML in the folder you chose, never
  dotfiles and never anything above it. Remote documents open read-only.
- **Send a document the other way** — open anything on your phone and send it to the desktop, where
  it lands in a `Received` folder inside the one being shared. A name already in use is never
  overwritten; the copy arrives as `notes (2).pdf`.
- **Keep documents offline** — star one and it stays on your device, readable with the other one
  switched off. Everything else is cached: Bode holds up to 512 MB and clears the oldest first.
  Starred documents are stored where Android's automatic cache clearing cannot reach them.
- **Nothing changes underneath you** — a cached document is revalidated in a single round trip, so
  reopening it usually transfers nothing at all. If the original has changed and you kept the
  document offline, Bode says so and waits — it will not swap the pages under your annotations
  without asking.
- **Highlights and reading position follow you** — press Sync and annotations, notes and the page
  you stopped on merge in both directions. Edits to different annotations both survive; the same
  one edited on both devices resolves to the most recent. Deleting stays deleted rather than being
  resurrected by the next sync. If the two clocks disagree badly enough to make that ordering
  unreliable, you are told.
- **Transfers show progress and can be cancelled** — large documents move in chunks, so a dropped
  Wi-Fi connection resumes where it left off instead of starting over.
- **Match another device's look** — copy the theme and recent-file list across on request. It is
  never automatic, and your window layout and trusted-HTML list never travel.
- **Works from anywhere over your own VPN** — it's plain IP, so Tailscale or WireGuard users can
  reach their desktop off the local network with no extra setup and still no third party involved.

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

npm test                   # frontend unit tests (annotation/settings merge, document keys)
cargo test --manifest-path src-tauri/Cargo.toml   # Rust, including end-to-end TLS/pairing tests
```

To try Nearby you need both halves running at once — `npm run tauri dev` on the desktop and
`npm run tauri android dev` on a phone joined to the same Wi-Fi.

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
  annotations/       annotation data model (Zustand), cross-device merge, overlay rendering/editing
  components/        Toolbar, AnnotationBar, Sidebar, SearchBar, CommandPalette, SignaturePad, icons
  devices/           Nearby devices panel: pairing, device list, remote browser, transfers, sync
  platform/          cross-platform file I/O (desktop, Android plugin-fs, paired devices), doc ids
                     and the cross-device document key
  settings/          theme definitions, settings store, settings panel
  store/             viewer state (Zustand)
  styles/            Tailwind entry + theme tokens (CSS variables)
src-tauri/           Rust shell (file reading/writing, launch-file handling, plugins)
  src/peer/          Nearby devices: identity, pinned mTLS, HTTP server, mDNS, client, cache
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
- **Nearby keeps all networking in Rust.** The webview never opens a socket — it calls a command and
  Rust does the request. That is partly forced (a webview hard-rejects the self-signed certificate a
  LAN peer must present, with no bypass) and partly the point: Bode's CSP stays exactly as strict as
  it was, with no `connect-src` opened up for this.
  - A document on a peer is just a path with a different scheme, `bode://<device-id>/<rel-path>`,
    handled by one extra branch in `src/platform/files.ts`. It fetches to a local cache file and
    then reads that back through the ordinary local path, so `openPath`, PDF.js, the Markdown reader
    and the annotated-PDF export are all untouched. The path is relative to the shared folder, so a
    peer's real filesystem layout never crosses the wire.
  - **Trust is a pinned certificate hash, not a PKI.** `sha256(cert_der)` is exactly what rustls
    hands a verifier, so the check is a hash comparison. Signature verification is still enforced —
    only chain-building and name-matching are replaced — so a certificate copied off the wire is
    useless without its private key. TLS session resumption is disabled on both sides, because a
    resumed session skips verification and would let an unpaired device keep working until its
    ticket expired.
  - Path containment reuses the `serve_trusted_html` pattern: reject `..`, absolute and separator-
    bearing segments structurally, then canonicalize and verify the result is still inside the share,
    which is what also catches a symlink pointing out of it. An incoming push is contained the same
    way from the other end: the receiver, not the sender, decides the file name, and it must be a
    single ordinary path segment or the transfer is refused rather than sanitised.
  - **Documents move in bounded chunks, both directions.** No handler ever buffers a whole file, so a
    200 MB scan costs 8 MB of memory rather than 200 on each machine. Progress, cancellation and
    resume-after-a-dropped-connection all fall out of that rather than needing machinery of their own.
  - **Staleness is `size-mtime`, never a content hash.** Hashing 200 MB on every open would cost more
    than the transfer it saves. A `HEAD` returns the tag; a match means the cached copy is served with
    no transfer at all. Cached documents live in `app_cache_dir()` and pinned ones in `app_data_dir()`,
    which is not tidiness — Android empties the cache directory under storage pressure, so "keep
    offline" would be a promise the OS could break. Pinning moves the bytes between the two.
  - **A document's cross-device identity is `<device-id>/<path under the share root>`** (`docKey.ts`).
    Absolute paths cannot work: the same PDF is `C:\Users\…` on one device and
    `/storage/emulated/0/…` on the other, so annotations would never line up. Both sides compute the
    key independently and get the same string. A document in no shared folder keeps its path as its
    key and simply never syncs, because no other device could name it.
  - **Annotation merge is a union by UUID, not a CRDT.** Annotations already carry `crypto.randomUUID`
    ids, which is what makes identity stable across devices and removes the need for an operation log.
    Later `updatedAt` wins; a tombstone at least as new as its annotation keeps it deleted, which is
    the only way a merge can tell "you deleted this" from "I haven't seen it yet". Ties resolve to the
    local copy, so merging is idempotent and order-independent — two devices converge whichever syncs
    first. Tombstones are pruned after 90 days. `src/annotations/merge.ts` is pure and takes `now` as
    a parameter, so all of this is tested (`npm test`).
  - **Reading state syncs; local security decisions do not.** `trustedHtml` is never sent — it is a
    judgement about paths on one machine, and importing another device's list would grant script
    execution the user never agreed to here. Window layout is not sent either: a phone's sidebar and
    page gap are wrong for a desktop. Theme and recents sync only when explicitly asked for.
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
