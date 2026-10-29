import type { KeyValueStore } from '../types.js';
import { safeKey, unwrap, wrap } from './safeKey.js';

/** What it needs from a Netlify Blobs store (`getStore('name')` from @netlify/blobs). */
export interface NetlifyBlobsLike {
  get(key: string, opts: { type: 'json' }): Promise<unknown>;
  setJSON(key: string, value: unknown): Promise<unknown>;
}

/** Netlify Blobs as a Lodestone store. Blobs cannot expire values, so each is saved with the time it stops being good and ignored after that. Fine for the catalogue, cached answers and which models are failing. Not a good home for rate-limit or spend counters under load: Blobs has no atomic add, and writes from separate functions can overwrite each other. Use Upstash for those. */
export function netlifyBlobsStore(blobs: NetlifyBlobsLike, o: { now?: () => number } = {}): KeyValueStore {
  const now = o.now ?? Date.now;
  return {
    async get(key) { return unwrap(await blobs.get(await safeKey(key), { type: 'json' }), now()); },
    async set(key, value, opts) { await blobs.setJSON(await safeKey(key), wrap(value, opts?.ttlMs, now())); },
  };
}
