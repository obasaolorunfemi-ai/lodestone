import type { KeyValueStore } from './types.js';

/** A circuit breaker: remembers which models have been failing, so a request does not spend its
 *  time on a model that is down. A model whose last few attempts all failed is skipped; every
 *  couple of minutes one attempt is let through to see whether it has recovered, and one success
 *  closes the breaker again. With a store, every instance (every serverless function) shares what
 *  it has learned, so one request's failure saves the next request's time.
 *
 *  Counts a timeout, a rate limit, a server error and an unusable answer (empty, not JSON) as
 *  failures. A rejected key or missing credit (401, 402, 403) says nothing about the model and is
 *  never recorded. */

export interface HealthOptions {
  /** Where to keep what it has learned, shared across instances. Default: memory only. */
  store?: KeyValueStore;
  key?: string;
  /** A model is skipped when its last `failures` attempts all failed within `windowMs`. Default 3 and 10 minutes. */
  failures?: number;
  windowMs?: number;
  /** While a model is skipped, one attempt is let through this often. Default 2 minutes. */
  probeEveryMs?: number;
  now?: () => number;
}

export interface ModelHealth {
  provider: string;
  model: string;
  /** Skipped right now. */
  open: boolean;
  /** Failures among its last few attempts. */
  recentFailures: number;
  recentAttempts: number;
  lastFailureAt: string | null;
}

export interface Health {
  /** Should this model be skipped right now? */
  shouldSkip(provider: string, model: string): Promise<boolean>;
  record(provider: string, model: string, ok: boolean): Promise<void>;
  /** Every model it has seen, for a health page. Models not seen in the window are left out. */
  snapshot(): Promise<ModelHealth[]>;
}

/** When, whether it answered, and a short id so two instances recording in the same millisecond are not merged into one. */
type Sample = [at: number, ok: 0 | 1, id: string];
type State = Record<string, Sample[]>;
const KEEP = 6;
const SHARE_MS = 15_000;
const id = (provider: string, model: string) => `${provider}\u0000${model}`;

export function createHealth(opts: HealthOptions = {}): Health {
  const need = opts.failures ?? 3;
  const windowMs = opts.windowMs ?? 10 * 60_000;
  const probeMs = opts.probeEveryMs ?? 2 * 60_000;
  const now = opts.now ?? Date.now;
  const key = opts.key ?? 'lodestone:health';
  let state: State = {};
  let loadedAt = -Infinity;

  /** Brings in what other instances have saved, at most every 15 seconds. */
  async function refresh(): Promise<void> {
    if (!opts.store || now() - loadedAt < SHARE_MS) return;
    loadedAt = now();
    try { state = merge(state, ((await opts.store.get(key)) as State | null) ?? {}); } catch { /* an unreadable store is the same as an empty one */ }
  }
  const merge = (a: State, b: State): State => {
    const out: State = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const seen = new Set<string>();
      out[k] = [...(a[k] ?? []), ...(b[k] ?? [])].filter(([at, , sid]) => { const u = `${at}:${sid}`; return seen.has(u) ? false : (seen.add(u), true); }).sort((x, y) => x[0] - y[0]).slice(-KEEP);
    }
    return out;
  };
  const recent = (k: string): Sample[] => (state[k] ?? []).filter(([at]) => now() - at <= windowMs);
  const isOpen = (r: Sample[]): boolean => {
    const last = r.slice(-need);
    if (last.length < need || last.some(([, ok]) => ok === 1)) return false;
    return now() - last[last.length - 1][0] < probeMs; // after a while, let one attempt through to see if it has recovered
  };

  return {
    async shouldSkip(provider, model) {
      await refresh();
      return isOpen(recent(id(provider, model)));
    },
    async record(provider, model, ok) {
      const k = id(provider, model);
      const before = recent(k);
      const recovering = before.length > 0 && before[before.length - 1][1] === 0; // this success follows a failure
      state[k] = [...(state[k] ?? []), [now(), ok ? 1 : 0, Math.random().toString(36).slice(2, 8)] as Sample].slice(-KEEP);
      // Only failures, and a success right after a failure, change what anyone else needs to know;
      // a model that is simply working costs nothing extra.
      if (!opts.store || (ok && !recovering)) return;
      try {
        const theirs = ((await opts.store.get(key)) as State | null) ?? {};
        state = merge(state, theirs);
        await opts.store.set(key, state);
        loadedAt = now();
      } catch { /* not saved: the next instance just has to learn it again */ }
    },
    async snapshot() {
      await refresh();
      const out: ModelHealth[] = [];
      for (const k of Object.keys(state)) {
        const r = recent(k);
        if (!r.length) continue;
        const [provider, model] = k.split('\u0000');
        const fails = r.filter(([, ok]) => ok === 0);
        out.push({ provider, model, open: isOpen(r), recentFailures: fails.length, recentAttempts: r.length, lastFailureAt: fails.length ? new Date(fails[fails.length - 1][0]).toISOString() : null });
      }
      return out;
    },
  };
}
