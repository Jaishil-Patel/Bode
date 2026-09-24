/*
 * One settings file per device, shared by every Bode window.
 *
 * Each window runs its own copy of the frontend, with its own copy of the state in memory. The
 * stores used to write that copy out as a single blob, whole, on every change — so a window that
 * had not heard about a change made in another one (a new theme, a rearranged toolbar, a highlight)
 * would write its stale copy straight back over it the next time it saved anything at all, even
 * just the page it had scrolled to. The same blob could also be written before the saved one had
 * been read, putting the defaults on disk.
 *
 * Three rules fix that, and this module is all three:
 *   - **Per-field keys.** Each field is its own key in the file, and only the fields that actually
 *     changed are written. Scrolling writes reading positions and nothing else.
 *   - **Live sync.** The store plugin keeps one instance of the file for the whole app and tells
 *     every window when a key changes; each window takes the new value in, so no window's copy
 *     goes stale.
 *   - **Nothing is written before the file has been read.** A change made during startup is held
 *     until then, and merged with what was saved rather than replacing it.
 */

/** The slice of the store plugin this needs — narrow, so tests can supply a fake. */
export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  save(): Promise<void>;
  onChange<T>(cb: (key: string, value: T | undefined) => void): Promise<() => void>;
}

export interface Field<V> {
  /** The value as the app holds it now. */
  read(): V;
  /** Take a value from the file or from another window. */
  apply(value: V): void;
  /**
   * Combine a stored value with a local one that changed at the same time, instead of letting
   * one side win. Used when a change made during startup meets the saved value, and when another
   * window changes the field while a local change is still waiting to be written.
   */
  merge?(stored: V, local: V): V;
  /**
   * Also merge with what is on disk at the moment of writing. For fields two windows routinely
   * change at once (reading positions, one per document) — not for ones where a removal must
   * stick, since a merge would bring the removed entries back.
   */
  mergeOnWrite?: boolean;
}

export interface SharedStore {
  /** Read the file and start listening to other windows. Runs once; later calls share it. */
  hydrate(): Promise<void>;
  /** Write every field whose value differs from the file's, after a short debounce. */
  persist(): void;
  /** Write anything pending now. */
  flush(): Promise<void>;
}

const json = (v: unknown) => JSON.stringify(v);

export function sharedStore(opts: {
  open: () => Promise<KV>;
  fields: Record<string, Field<any>>;
  /** A whole-state blob written by older versions, split into fields the first time it is seen. */
  legacy?: { key: string; split: (blob: any) => Record<string, unknown> };
  debounceMs?: number;
}): SharedStore {
  const keys = Object.keys(opts.fields);
  const debounce = opts.debounceMs ?? 0;
  let kv: KV | null = null;
  let ready = false;
  let hydrating: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dropLegacy = false;
  const dirty = new Set<string>();
  /**
   * The serialized value each field last had in the file, as far as this window knows. A field
   * whose value differs from it has changed here. Seeded with the starting values, so a change
   * made before the file is read is still recognised as one.
   */
  const known = new Map<string, string>(keys.map((k) => [k, json(opts.fields[k].read())]));

  /** A value arrived from the file or from another window. */
  const take = (key: string, value: unknown) => {
    const f = opts.fields[key];
    const incoming = json(value);
    if (dirty.has(key)) {
      // A local change is waiting to be written. Merge where that makes sense; otherwise the
      // local change is the newer one and will overwrite this when it lands.
      if (f.merge) {
        const merged = f.merge(value, f.read());
        if (json(merged) !== json(f.read())) f.apply(merged);
      }
      known.set(key, incoming);
      return;
    }
    known.set(key, incoming);
    if (incoming !== json(f.read())) f.apply(value);
  };

  const schedule = () => {
    if (!ready || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, debounce);
  };

  const hydrate = () =>
    (hydrating ??= (async () => {
      try {
        kv = await opts.open();
        let stored: Record<string, unknown> = {};
        for (const k of keys) {
          const v = await kv.get(k);
          if (v !== undefined) stored[k] = v;
        }
        if (Object.keys(stored).length === 0 && opts.legacy) {
          const blob = await kv.get(opts.legacy.key);
          if (blob !== undefined && blob !== null) {
            stored = opts.legacy.split(blob);
            dropLegacy = true;
          }
        }
        // Work out what changed during startup before taking anything in.
        for (const k of keys) if (json(opts.fields[k].read()) !== known.get(k)) dirty.add(k);
        for (const [k, v] of Object.entries(stored)) if (v !== undefined) take(k, v);
        // A migrated blob is written back out as fields, all of them, the first time round.
        if (dropLegacy) for (const k of Object.keys(stored)) dirty.add(k);
        await kv.onChange((key, value) => {
          if (value !== undefined && key in opts.fields) take(key, value);
        });
      } catch {
        // No store (a plain browser, or the plugin failed): run on in-memory state.
      } finally {
        ready = true;
        if (dirty.size || dropLegacy) schedule();
      }
    })());

  const persist = () => {
    for (const k of keys) {
      if (json(opts.fields[k].read()) !== known.get(k)) dirty.add(k);
    }
    if (dirty.size) schedule();
  };

  const flush = async () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (!ready || !kv) return;
    persist(); // pick up anything changed since the last call
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const pending = [...dirty];
    dirty.clear();
    if (pending.length === 0 && !dropLegacy) return;
    try {
      for (const k of pending) {
        const f = opts.fields[k];
        let value = f.read();
        if (f.merge && f.mergeOnWrite) {
          const onDisk = await kv.get(k);
          if (onDisk !== undefined) {
            const merged = f.merge(onDisk, value);
            if (json(merged) !== json(value)) {
              f.apply(merged);
              value = merged;
            }
          }
        }
        known.set(k, json(value));
        await kv.set(k, value);
      }
      if (dropLegacy && opts.legacy) {
        await kv.delete(opts.legacy.key);
        dropLegacy = false;
      }
      await kv.save();
    } catch {
      // Best-effort: whatever failed is still in memory and goes out with the next change.
      for (const k of pending) known.delete(k);
    }
  };

  return { hydrate, persist, flush };
}
