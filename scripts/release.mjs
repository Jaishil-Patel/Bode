#!/usr/bin/env node
/*
 * One build command, one output folder, one file per platform.
 *
 * Tauri scatters its output: the Android Gradle project emits a separate APK per "abi" product
 * flavor (apk/arm64/, apk/universal/, …) times two build types, and the desktop bundler buries the
 * installer under target/release/bundle/nsis/. Finding the artifact you actually want means
 * knowing which of those paths the last invocation happened to write to.
 *
 * This script runs the build, locates whatever it produced, and copies it to release/ under a
 * predictable, version-stamped name — deleting the previous file for that platform so exactly one
 * survives. release/ is the only place you ever need to look.
 *
 *   npm run release            both platforms
 *   npm run release:android    Bode-<version>-android-arm64.apk
 *   npm run release:desktop    Bode-<version>-windows-x64-setup.exe
 *
 * The version comes from src-tauri/tauri.conf.json, which is what Tauri stamps into the app
 * itself, so the filename can never disagree with what the About box would say. Bump it there
 * (and in package.json) and the next build lands under a new name.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, copyFileSync, rmSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "release");

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const version = readJson(join(root, "src-tauri", "tauri.conf.json")).version;
const pkgVersion = readJson(join(root, "package.json")).version;

/** Recursively collect files under `dir` matching `test`, newest first. Missing dir -> []. */
function findFiles(dir, test) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findFiles(full, test));
    else if (test(entry.name)) out.push(full);
  }
  return out.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

/** Run a Tauri CLI command, streaming its output. Exits the process on failure. */
function tauri(args) {
  console.log(`\n> tauri ${args.join(" ")}\n`);
  // shell:true so Windows resolves the npx/tauri .cmd shim; npm run's own arg parsing eats
  // flags like --debug, which is why this calls npx rather than an npm script.
  const r = spawnSync("npx", ["tauri", ...args], { cwd: root, stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.error(`\nBuild failed (exit ${r.status ?? "signal " + r.signal}) — nothing copied.`);
    process.exit(r.status ?? 1);
  }
}

/**
 * Choose which built artifact to publish.
 *
 * Prefer one written during this run, but fall back to the newest on disk: Gradle and Cargo both
 * skip repackaging when nothing changed, so an up-to-date build legitimately leaves the artifact's
 * mtime untouched. Always print the file and its timestamp so a stale pick is visible rather than
 * silent.
 */
function pickArtifact(files, started, what) {
  if (!files.length) {
    console.error(`\nBuild reported success but no ${what} exists under the output tree.`);
    process.exit(1);
  }
  const fresh = files.filter((f) => statSync(f).mtimeMs >= started);
  const chosen = fresh[0] ?? files[0];
  // Local time, not toISOString's UTC — this is read next to timestamps from the file explorer.
  const t = statSync(chosen).mtime;
  const pad = (n) => String(n).padStart(2, "0");
  const when =
    `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ` +
    `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
  console.log(`\n  source: ${chosen.slice(root.length + 1)}`);
  console.log(`  built:  ${when}${fresh.length ? "" : "  (unchanged — build was up to date)"}`);
  return chosen;
}

/**
 * Copy `src` into release/ as `name`, first removing any older file for the same platform so the
 * folder never accumulates one APK per version.
 */
function publish(src, name, replacePattern) {
  mkdirSync(outDir, { recursive: true });
  for (const old of readdirSync(outDir)) {
    if (replacePattern.test(old) && old !== name) rmSync(join(outDir, old));
  }
  const dest = join(outDir, name);
  copyFileSync(src, dest);
  const mb = (statSync(dest).size / 1024 / 1024).toFixed(1);
  console.log(`\n  release/${name}  (${mb} MB)`);
  return dest;
}

function buildAndroid() {
  // Debug, not release: Tauri produces release APKs unsigned, and Android refuses to install an
  // APK with no signing block. Debug builds are auto-signed with the local debug keystore, so
  // this is the only variant that can go straight onto a phone. The cost is size — debug keeps
  // full native symbols. Wiring a real release keystore is what shrinks it to ~25 MB.
  const started = Date.now();
  tauri(["android", "build", "--debug", "--apk", "--target", "aarch64"]);

  // Which flavor directory Gradle used depends on how the CLI narrowed abiFilters, so scan for
  // whatever this run actually produced rather than assuming a path.
  const apks = findFiles(join(root, "src-tauri", "gen", "android", "app", "build", "outputs"), (n) =>
    n.endsWith(".apk"),
  );
  const apk = pickArtifact(apks, started, "APK");
  publish(apk, `Bode-${version}-android-arm64.apk`, /^Bode-.*-android-arm64\.apk$/);
}

function buildDesktop() {
  const started = Date.now();
  tauri(["build"]);

  const exes = findFiles(join(root, "src-tauri", "target", "release", "bundle"), (n) =>
    n.endsWith("-setup.exe"),
  );
  const exe = pickArtifact(exes, started, "installer");
  publish(exe, `Bode-${version}-windows-x64-setup.exe`, /^Bode-.*-windows-x64-setup\.exe$/);
}

const targets = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const want = targets.length ? targets : ["android", "desktop"];
const unknown = want.filter((t) => t !== "android" && t !== "desktop");
if (unknown.length) {
  console.error(`Unknown target(s): ${unknown.join(", ")}. Use "android", "desktop", or neither.`);
  process.exit(1);
}

if (pkgVersion !== version) {
  console.warn(
    `Warning: package.json says ${pkgVersion} but tauri.conf.json says ${version}. ` +
      `Using ${version} (the version compiled into the app); sync them to silence this.`,
  );
}

console.log(`Building Bode ${version} -> release/`);
if (want.includes("android")) buildAndroid();
if (want.includes("desktop")) buildDesktop();
console.log("\nDone.");
