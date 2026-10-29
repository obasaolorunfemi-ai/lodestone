import type { AtomicStore } from './types.js';

/** A store that lives in memory. The default; lost when the process ends. */
export function memoryStore(now: () => number = Date.now): AtomicStore {
  const data = new Map<string, { v: unknown; exp: number }>();
  const live = (key: string) => {
    const e = data.get(key);
    if (!e) return undefined;
    if (e.exp <= now()) { data.delete(key); return undefined; }
    return e;
  };
  return {
    get: async (key) => live(key)?.v ?? null,
    set: async (key, value, opts) => { data.set(key, { v: value, exp: opts?.ttlMs ? now() + opts.ttlMs : Infinity }); },
    incrBy: async (key, by, opts) => {
      const e = live(key);
      const total = (typeof e?.v === 'number' ? e.v : 0) + by;
      data.set(key, { v: total, exp: e ? e.exp : now() + opts.ttlMs });
      return total;
    },
  };
}
