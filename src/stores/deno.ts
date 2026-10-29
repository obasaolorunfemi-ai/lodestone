import type { KeyValueStore } from '../types.js';

/** What it needs from a Deno KV database (`await Deno.openKv()`). */
export interface DenoKvLike {
  get(key: unknown[]): Promise<{ value: unknown }>;
  set(key: unknown[], value: unknown, opts?: { expireIn?: number }): Promise<unknown>;
}

/** Deno KV (Deno Deploy's built-in database) as a Lodestone store. Values expire on their own. */
export function denoKvStore(kv: DenoKvLike, o: { prefix?: string } = {}): KeyValueStore {
  const prefix = o.prefix ?? 'lodestone';
  return {
    async get(key) { return (await kv.get([prefix, key])).value ?? null; },
    async set(key, value, opts) { await kv.set([prefix, key], value, opts?.ttlMs ? { expireIn: opts.ttlMs } : undefined); },
  };
}
