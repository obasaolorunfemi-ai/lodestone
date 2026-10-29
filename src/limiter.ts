import type { AtomicStore, KeyValueStore } from './types.js';
import { createMutex, isNonNegative, isRecord, sha256Hex } from './util.js';

/** Per-caller rate limiting. The spend limit is one pot for everybody, so one person calling a public tool in a
 *  loop can empty it for everyone else. This gives each caller (a user id, an IP address, an API key) their own
 *  allowance: `max` calls in every `windowMs`. Pass the caller on each call (`caller: userId`) and give the
 *  limiter to createLodestone as `rateLimit`.
 *
 *  What is stored is a hash of the caller, never the caller: an IP address does not end up in your store.
 *  With a store that can count atomically (Upstash, the memory store) the count is exact across functions.
 *  With a plain get/set store it is exact inside one process and approximate between processes: two functions
 *  answering the same caller in the same moment can let a call or two through. */

export interface RateLimiterOptions {
  store: KeyValueStore | AtomicStore;
  /** Calls allowed per caller in each window. */
  max: number;
  /** Default one hour. */
  windowMs?: number;
  /** Prefix for the keys. Default lodestone:rl */
  key?: string;
  /** What to do when the store cannot be reached. Default 'allow': a broken store should not take the tool down. The spend limit is the backstop. */
  onStoreError?: 'allow' | 'deny';
  now?: () => number;
}

export interface RateLimitResult {
  ok: boolean;
  /** Calls left in this window, after this one. */
  remaining: number;
  /** When the window ends, if `ok` is false: how long this caller has to wait. */
  retryAfterMs: number;
}

export interface RateLimiter {
  /** Counts one call for this caller and says whether it is within the allowance. */
  take(caller: string): Promise<RateLimitResult>;
}

const isAtomic = (s: KeyValueStore): s is AtomicStore => typeof (s as AtomicStore).incrBy === 'function';

export function createRateLimiter(o: RateLimiterOptions): RateLimiter {
  const windowMs = o.windowMs ?? 3_600_000;
  const now = o.now ?? Date.now;
  const prefix = o.key ?? 'lodestone:rl';
  const exclusive = createMutex();
  const failure: RateLimitResult = o.onStoreError === 'deny' ? { ok: false, remaining: 0, retryAfterMs: 60_000 } : { ok: true, remaining: o.max, retryAfterMs: 0 };

  return {
    async take(caller) {
      const who = await sha256Hex(caller);
      const t = now();
      const windowStart = Math.floor(t / windowMs) * windowMs;
      const retryAfterMs = windowStart + windowMs - t;
      try {
        if (isAtomic(o.store)) {
          const n = await o.store.incrBy(`${prefix}:${who}:${windowStart}`, 1, { ttlMs: windowMs * 2 });
          return { ok: n <= o.max, remaining: Math.max(0, o.max - n), retryAfterMs };
        }
        return await exclusive(async () => {
          const key = `${prefix}:${who}`;
          const saved = await o.store.get(key);
          const n = isRecord(saved) && saved.w === windowStart && isNonNegative(saved.n) ? saved.n : 0;
          if (n >= o.max) return { ok: false, remaining: 0, retryAfterMs };
          await o.store.set(key, { w: windowStart, n: n + 1 }, { ttlMs: windowMs * 2 });
          return { ok: true, remaining: o.max - n - 1, retryAfterMs };
        });
      } catch {
        return failure;
      }
    },
  };
}
