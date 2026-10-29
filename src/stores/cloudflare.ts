import type { KeyValueStore } from '../types.js';
import { safeKey } from './safeKey.js';

/** What it needs from a Workers KV namespace binding. */
export interface KVNamespaceLike {
  get(key: string, type: 'json'): Promise<unknown>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<unknown>;
}

/** Workers KV as a Lodestone store. Good for the model catalogue and cached answers. Two limits to know: KV is eventually consistent, so what one location writes another sees after a short delay (the breaker learns a little slower), and one key can be written about once a second, so a model failing in a burst may lose some writes. Not for rate-limit or spend counters: use Upstash, or a Durable Object, for those. */
export function cloudflareKvStore(kv: KVNamespaceLike): KeyValueStore {
  return {
    async get(key) { return (await kv.get(await safeKey(key, 400), 'json')) ?? null; },
    async set(key, value, opts) {
      // KV refuses a lifetime under 60 seconds.
      await kv.put(await safeKey(key, 400), JSON.stringify(value), opts?.ttlMs ? { expirationTtl: Math.max(60, Math.ceil(opts.ttlMs / 1000)) } : undefined);
    },
  };
}
