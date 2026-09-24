import { describe, expect, it } from "vitest";
import { sharedStore, type Field, type KV } from "./sharedStore";

/**
 * The store file as the Rust side holds it: one instance for the whole app, telling every window
 * about each change — which is what the store plugin does.
 */
function fakeFile(initial: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(initial));
  const listeners = new Set<(k: string, v: unknown) => void>();
  let saves = 0;
  const kv = (): KV => ({
    get: async <T,>(k: string) => structuredClone(data.get(k)) as T | undefined,
    set: async (k, v) => {
      data.set(k, structuredClone(v));
      // Delivered asynchronously, as a Tauri event is.
      for (const l of listeners) setTimeout(() => l(k, structuredClone(v)), 0);
    },
    delete: async (k) => data.delete(k),
    save: async () => {
      saves++;
    },
    onChange: async <T,>(cb: (k: string, v: T | undefined) => void) => {
      const l = cb as (k: string, v: unknown) => void;
      listeners.add(l);
      return () => listeners.delete(l);
    },
  });
  return { kv, data, saves: () => saves };
}

type Positions = Record<string, { page: number; at: number }>;

/** One window's state: a theme, a list with no merge rule, and positions that merge per key. */
function window_(file: ReturnType<typeof fakeFile>, legacy = false) {
  const state = { theme: "dark", recents: [] as string[], positions: {} as Positions };
  const field = <K extends keyof typeof state>(k: K, extra: Partial<Field<(typeof state)[K]>> = {}) => ({
    read: () => state[k],
    apply: (v: (typeof state)[K]) => {
      state[k] = v;
    },
    ...extra,
  });
  const store = sharedStore({
    open: async () => file.kv(),
    fields: {
      theme: field("theme"),
      recents: field("recents", {
        merge: (stored, local) => [...new Set([...local, ...stored])],
      }),
      positions: field("positions", {
        merge: (stored, local) => {
          const out = { ...stored };
          for (const [k, v] of Object.entries(local)) if (!out[k] || v.at > out[k].at) out[k] = v;
          return out;
        },
        mergeOnWrite: true,
      }),
    },
    legacy: legacy
      ? { key: "state", split: (b: typeof state) => ({ theme: b.theme, recents: b.recents, positions: b.positions }) }
      : undefined,
  });
  return { state, store };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("sharedStore", () => {
  it("loads what was saved", async () => {
    const file = fakeFile({ theme: "glass", recents: ["a.pdf"] });
    const w = window_(file);
    await w.store.hydrate();
    expect(w.state.theme).toBe("glass");
    expect(w.state.recents).toEqual(["a.pdf"]);
  });

  it("does not overwrite the saved theme with a change made before it was read", async () => {
    const file = fakeFile({ theme: "glass", recents: ["old.pdf"] });
    const w = window_(file);
    // Opening a PDF at launch records it before the settings have loaded.
    w.state.recents = ["new.pdf"];
    w.store.persist();
    await w.store.hydrate();
    await tick();
    expect(file.data.get("theme")).toBe("glass");
    expect(w.state.theme).toBe("glass");
    // And the startup change is merged in, not lost and not clobbering what was there.
    expect(file.data.get("recents")).toEqual(["new.pdf", "old.pdf"]);
  });

  it("carries a change from one window to another", async () => {
    const file = fakeFile({ theme: "dark" });
    const a = window_(file);
    const b = window_(file);
    await a.store.hydrate();
    await b.store.hydrate();

    a.state.theme = "light";
    a.store.persist();
    await tick();
    await tick();
    expect(b.state.theme).toBe("light");
  });

  it("never writes a stale field back when another field changes", async () => {
    const file = fakeFile({ theme: "dark" });
    const a = window_(file);
    const b = window_(file);
    await a.store.hydrate();
    await b.store.hydrate();

    a.state.theme = "light";
    a.store.persist();
    await tick();
    // Window B scrolls: only its positions change, and only they are written.
    b.state.positions = { "doc.pdf": { page: 4, at: 1 } };
    b.store.persist();
    await tick();
    await tick();
    expect(file.data.get("theme")).toBe("light");
    expect(a.state.theme).toBe("light");
    expect(b.state.theme).toBe("light");
  });

  it("merges reading positions two windows write at the same time", async () => {
    const file = fakeFile({});
    const a = window_(file);
    const b = window_(file);
    await a.store.hydrate();
    await b.store.hydrate();

    a.state.positions = { "x.pdf": { page: 2, at: 1 } };
    b.state.positions = { "y.pdf": { page: 9, at: 2 } };
    a.store.persist();
    b.store.persist();
    await tick();
    await tick();
    expect(file.data.get("positions")).toEqual({
      "x.pdf": { page: 2, at: 1 },
      "y.pdf": { page: 9, at: 2 },
    });
  });

  it("writes only fields that changed", async () => {
    const file = fakeFile({ theme: "dark" });
    const w = window_(file);
    await w.store.hydrate();
    await tick();
    const before = file.saves();
    w.store.persist(); // nothing changed
    await tick();
    expect(file.saves()).toBe(before);
  });

  it("splits an old whole-state blob into fields and drops it", async () => {
    const file = fakeFile({ state: { theme: "glass", recents: ["a.pdf"], positions: {} } });
    const w = window_(file, true);
    await w.store.hydrate();
    await tick();
    expect(w.state.theme).toBe("glass");
    expect(file.data.get("theme")).toBe("glass");
    expect(file.data.get("recents")).toEqual(["a.pdf"]);
    expect(file.data.has("state")).toBe(false);
  });

  it("runs on defaults when there is no store", async () => {
    const w = window_(fakeFile());
    const broken = sharedStore({
      open: async () => {
        throw new Error("no tauri");
      },
      fields: { theme: { read: () => w.state.theme, apply: () => {} } },
    });
    await expect(broken.hydrate()).resolves.toBeUndefined();
    broken.persist();
    await expect(broken.flush()).resolves.toBeUndefined();
  });
});
