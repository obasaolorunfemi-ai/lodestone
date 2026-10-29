import type { SpendControl } from './lodestone.js';
import type { KeyValueStore } from './types.js';
import { createMutex, isNonNegative, isRecord } from './util.js';

/** A daily and a monthly spend limit that holds under load. A bare `allow()` then `record()` lets a burst of
 *  requests all pass the check before any of them has been counted. This takes a hold for each paid attempt
 *  when it is allowed, and counts the holds against the limit, so concurrent requests see each other. The
 *  hold is replaced by the real cost when the attempt answers, and handed back when it does not. A hold that
 *  is never settled (the function was killed) expires by itself.
 *
 *  Exact inside one process. Between processes it is as good as the store: with a plain get/set store, two
 *  functions allowing at the same moment can each take a hold the other did not see, so size `holdUsd` and
 *  the limit with that in mind. If the store cannot be read, the attempt is refused (the money is yours). */

export interface SpendLimitOptions {
  store: KeyValueStore;
  dailyUsd?: number;
  monthlyUsd?: number;
  /** Held for each paid attempt until it settles: roughly the most one call can cost. Default $0.01. */
  holdUsd?: number;
  /** A hold that is never settled goes away after this. Default 2 minutes. */
  holdTtlMs?: number;
  /** Where the ledger is kept. Default lodestone:spend */
  key?: string;
  now?: () => number;
}

export interface SpendReport { todayUsd: number; monthUsd: number; heldUsd: number; dailyUsd?: number; monthlyUsd?: number }

interface Ledger { day: string; dayUsd: number; month: string; monthUsd: number; holds: Record<string, [usd: number, expires: number]> }
const MAX_HOLDS = 500;

export function createSpendLimit(o: SpendLimitOptions): Required<SpendControl> & { report(): Promise<SpendReport> } {
  const now = o.now ?? Date.now;
  const key = o.key ?? 'lodestone:spend';
  const hold = o.holdUsd ?? 0.01;
  const ttl = o.holdTtlMs ?? 120_000;
  const exclusive = createMutex();

  /** What is in the store, checked: a ledger somebody else wrote is not trusted to be the right shape. */
  async function load(): Promise<Ledger> {
    const t = new Date(now());
    const day = t.toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    const raw = await o.store.get(key);
    const s = isRecord(raw) ? raw : {};
    const holds: Ledger['holds'] = {};
    if (isRecord(s.holds)) {
      for (const [id, h] of Object.entries(s.holds).slice(0, MAX_HOLDS)) {
        if (Array.isArray(h) && isNonNegative(h[0]) && isNonNegative(h[1]) && h[1] > now()) holds[id] = [h[0], h[1]];
      }
    }
    return {
      day, month, holds,
      dayUsd: s.day === day && isNonNegative(s.dayUsd) ? s.dayUsd : 0,
      monthUsd: s.month === month && isNonNegative(s.monthUsd) ? s.monthUsd : 0,
    };
  }
  const held = (l: Ledger) => Object.values(l.holds).reduce((a, h) => a + h[0], 0);
  const save = (l: Ledger) => o.store.set(key, l);

  return {
    allow: (info) => exclusive(async () => {
      try {
        const l = await load();
        const pending = held(l) + hold;
        if (o.dailyUsd !== undefined && l.dayUsd + pending > o.dailyUsd) return false;
        if (o.monthlyUsd !== undefined && l.monthUsd + pending > o.monthlyUsd) return false;
        if (Object.keys(l.holds).length >= MAX_HOLDS) return false;
        l.holds[info.id] = [hold, now() + ttl];
        await save(l);
        return true;
      } catch { return false; }
    }),
    record: (info) => exclusive(async () => {
      const l = await load();
      const taken = l.holds[info.id]?.[0] ?? hold;
      delete l.holds[info.id];
      // A cost nobody reported counts as the hold: better to over-count than to let a free ride through.
      const cost = isNonNegative(info.costUsd) ? info.costUsd : taken;
      l.dayUsd += cost; l.monthUsd += cost;
      await save(l);
    }),
    release: (info) => exclusive(async () => {
      const l = await load();
      if (!(info.id in l.holds)) return;
      delete l.holds[info.id];
      await save(l);
    }),
    report: () => exclusive(async () => {
      const l = await load();
      return { todayUsd: l.dayUsd, monthUsd: l.monthUsd, heldUsd: held(l), dailyUsd: o.dailyUsd, monthlyUsd: o.monthlyUsd };
    }),
  };
}
