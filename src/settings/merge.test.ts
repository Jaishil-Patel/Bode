import { describe, expect, it } from "vitest";
import { mergePositions, mergeSettings, type SyncableSettings } from "./useSettings";
import { DEFAULT_CUSTOM_THEME } from "./themes";

/*
 * Settings are one blob rewritten whole, so syncing them needs per-field rules. These tests pin the
 * two that would quietly lose something if they were wrong: recents must union rather than replace,
 * and the fields that are deliberately NOT syncable must not appear at all.
 */

const base = (over: Partial<SyncableSettings> = {}): SyncableSettings => ({
  theme: "dark",
  customTheme: DEFAULT_CUSTOM_THEME,
  recents: [],
  settingsUpdatedAt: 1000,
  ...over,
});

describe("mergeSettings", () => {
  it("takes the newer device's theme", () => {
    const local = base({ theme: "dark", settingsUpdatedAt: 1000 });
    const remote = base({ theme: "light", settingsUpdatedAt: 2000 });
    expect(mergeSettings(local, remote).theme).toBe("light");
  });

  it("keeps the local theme when this device changed more recently", () => {
    const local = base({ theme: "dark", settingsUpdatedAt: 3000 });
    const remote = base({ theme: "light", settingsUpdatedAt: 2000 });
    expect(mergeSettings(local, remote).theme).toBe("dark");
  });

  it("keeps the local theme on a tie, so merging is stable", () => {
    const local = base({ theme: "dark", settingsUpdatedAt: 2000 });
    const remote = base({ theme: "light", settingsUpdatedAt: 2000 });
    expect(mergeSettings(local, remote).theme).toBe("dark");
  });

  it("unions recents rather than replacing them", () => {
    // Both devices' reading histories are real; taking one wholesale throws away the other.
    const local = base({ recents: [{ path: "a.pdf", name: "a", openedAt: 100 }] });
    const remote = base({ recents: [{ path: "b.pdf", name: "b", openedAt: 200 }] });
    const merged = mergeSettings(local, remote);
    expect(merged.recents.map((r) => r.path)).toEqual(["b.pdf", "a.pdf"]);
  });

  it("keeps the most recent open of a document present on both", () => {
    const local = base({ recents: [{ path: "a.pdf", name: "a", openedAt: 100 }] });
    const remote = base({ recents: [{ path: "a.pdf", name: "a", openedAt: 500 }] });
    const merged = mergeSettings(local, remote);
    expect(merged.recents).toHaveLength(1);
    expect(merged.recents[0].openedAt).toBe(500);
  });

  it("re-caps recents at twelve", () => {
    const many = (offset: number) =>
      Array.from({ length: 10 }, (_, i) => ({
        path: `${offset + i}.pdf`,
        name: `${offset + i}`,
        openedAt: offset + i,
      }));
    const merged = mergeSettings(base({ recents: many(0) }), base({ recents: many(100) }));
    expect(merged.recents).toHaveLength(12);
    // Newest first, so the cap drops the oldest rather than an arbitrary slice.
    expect(merged.recents[0].openedAt).toBe(109);
  });

  it("carries no layout or trusted-HTML fields at all", () => {
    // Not "they are ignored" but "they are not in the shape" — trustedHtml is a local security
    // decision about local paths, and importing another device's would grant script execution the
    // user never agreed to here.
    const merged = mergeSettings(base(), base());
    expect(merged).not.toHaveProperty("layout");
    expect(merged).not.toHaveProperty("trustedHtml");
    expect(Object.keys(merged).sort()).toEqual([
      "customTheme",
      "recents",
      "settingsUpdatedAt",
      "theme",
    ]);
  });

  it("advances the timestamp to the later of the two", () => {
    const merged = mergeSettings(base({ settingsUpdatedAt: 5 }), base({ settingsUpdatedAt: 9 }));
    expect(merged.settingsUpdatedAt).toBe(9);
  });
});

describe("mergePositions", () => {
  it("takes the newer position per document", () => {
    const merged = mergePositions(
      { "dev/a.pdf": { page: 4, at: 100 } },
      { "dev/a.pdf": { page: 90, at: 200 } },
    );
    expect(merged["dev/a.pdf"].page).toBe(90);
  });

  it("keeps the local position when it is newer", () => {
    const merged = mergePositions(
      { "dev/a.pdf": { page: 90, at: 300 } },
      { "dev/a.pdf": { page: 4, at: 200 } },
    );
    expect(merged["dev/a.pdf"].page).toBe(90);
  });

  it("treats a position with no timestamp as oldest", () => {
    // Written before sync existed, so it must not beat a real edit.
    const merged = mergePositions({ "dev/a.pdf": { page: 4 } }, { "dev/a.pdf": { page: 90, at: 1 } });
    expect(merged["dev/a.pdf"].page).toBe(90);
  });

  it("keeps documents only one side knows about", () => {
    const merged = mergePositions(
      { "dev/a.pdf": { page: 1, at: 1 } },
      { "dev/b.pdf": { page: 2, at: 2 } },
    );
    expect(Object.keys(merged).sort()).toEqual(["dev/a.pdf", "dev/b.pdf"]);
  });
});
