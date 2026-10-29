import type { AtomicStore } from '../types.js';

export interface UpstashOptions {
  /** The REST URL of the database, https://....upstash.io (also what Vercel KV gives you as KV_REST_API_URL). */
  url: string;
  /** The REST token. Keep it in an environment variable. */
  token: string;
  /** Put in front of every key. Default lodestone: */
  prefix?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Upstash Redis (and Vercel KV, which is Upstash) as a Lodestone store, over its REST API with plain fetch: no client library, so it runs on Workers, Deno, Bun and Node.
 *  It can count atomically, so a rate limiter that uses it is exact across every function, which no get/set store can offer. */
export function upstashStore(o: UpstashOptions): AtomicStore {
  const base = new URL(o.url);
  if (base.protocol !== 'https:') throw new Error('upstashStore: the URL must be https');
  const f = o.fetch ?? fetch;
  const prefix = o.prefix ?? 'lodestone:';

  async function send(path: string, body: unknown): Promise<unknown> {
    const res = await f(new URL(path, base), {
      method: 'POST',
      headers: { Authorization: `Bearer ${o.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(o.timeoutMs ?? 5_000),
    });
    if (!res.ok) throw new Error(`upstash: ${res.status}`); // the body is not included: it can echo a key
    return res.json();
  }
  const one = async (cmd: unknown[]): Promise<unknown> => {
    const r = (await send('/', cmd)) as { result?: unknown; error?: string };
    if (r.error) throw new Error('upstash: the command was refused');
    return r.result;
  };

  return {
    async get(key) {
      const raw = await one(['GET', prefix + key]);
      if (typeof raw !== 'string') return null;
      try { return JSON.parse(raw); } catch { return null; }
    },
    async set(key, value, opts) {
      await one(['SET', prefix + key, JSON.stringify(value), ...(opts?.ttlMs ? ['PX', String(Math.ceil(opts.ttlMs))] : [])]);
    },
    async incrBy(key, by, opts) {
      const k = prefix + key;
      const r = (await send('/pipeline', [['INCRBY', k, by], ['PEXPIRE', k, opts.ttlMs, 'NX']])) as { result?: unknown; error?: string }[];
      const n = r[0]?.result;
      if (r[0]?.error || typeof n !== 'number') throw new Error('upstash: the counter was refused');
      return n;
    },
  };
}
