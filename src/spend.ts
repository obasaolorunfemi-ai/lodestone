import type { SpendCap, SpendControl, SpendScope } from './lodestone.js';
import type { KeyValueStore } from './types.js';
import { createMutex, isNonNegative, isRecord, sha256Hex } from './util.js';

/** A daily and a monthly spend limit that holds under load. A bare `allow()` then `record()` lets a burst of
 *  requests all pass the check before any of them has been counted. This takes a hold for each paid attempt
 *  when it is allowed, and counts the holds against the limit, so concurrent requests see each other. The
 *  hold is replaced by the real cost when the attempt answers, and handed back when it does not. A hold that
 *  is never settled (the function was killed) expires by itself.
 *
 *  Exact inside one process. Between processes it is as good as the store: with a plain get/set store, two
 *  functions allowing at the same moment can each take a hold the other did not see, so size `holdUsd` and
 *  the limit with that in mind. If the store cannot be read, the attempt is refused (the money is yours).
 *
 *  Each caller can have an allowance of their own (`perCaller`), so one person cannot use up the pool for
 *  everyone. It needs the call to name the caller (`caller: userId`); a call without one is only held to the
 *  pool. A caller's own key is their money and never counts here, unless they asked for a limit of their own
 *  (`spendCap` on the call): then their paid calls on that key are counted separately, in a ledger that never
 *  touches yours, and stopped when they reach the number they chose.
 *
 *  What is stored under a caller is a hash of the caller, never the caller. */

export interface SpendLimitOptions {
  store: KeyValueStore;
  dailyUsd?: number;
  monthlyUsd?: number;
  /** What each caller may spend of the pool's money, per day and per month. A call names its caller with `caller`. A call may carry a lower `spendCap` of its own (a person lowering their own allowance); it never raises this. */
  perCaller?: SpendCap;
  /** Held for each paid attempt until it settles: roughly the most one call can cost. Default $0.01. */
  holdUsd?: number;
  /** A hold that is never settled goes away after this. Default 2 minutes. */
  holdTtlMs?: number;
  /** Where the ledger is kept. Default lodestone:spend */
  key?: string;
  now?: () => number;
}

export interface SpendReport { todayUsd: number; monthUsd: number; heldUsd: number; dailyUsd?: number; monthlyUsd?: number }

const lowest = (a?: number, b?: number): number | undefined => (a === undefined ? b : b === undefined ? a : Math.min(a, b));

interface Ledger { day: string; dayUsd: number; month: string; monthUsd: number; holds: Record<string, [usd: number, expires: number]> }
const MAX_HOLDS = 500;

export function createSpendLimit(o: SpendLimitOptions): Required<SpendControl> & { report(): Promise<SpendReport>; callerReport(caller: string, opts?: { ownKey?: boolean; cap?: SpendCap }): Promise<SpendReport> } {
  const now = o.now ?? Date.now;
  const key = o.key ?? 'lodestone:spend';
  const hold = o.holdUsd ?? 0.01;
  const ttl = o.holdTtlMs ?? 120_000;
  const exclusive = createMutex();
  /** Which limit refused an attempt, until Lodestone asks. */
  const refusals = new Map<string, SpendScope>();
  const refuse = (id: string, scope: SpendScope): false => {
    if (refusals.size >= 100) refusals.delete(refusals.keys().next().value as string);
    refusals.set(id, scope);
    return false;
  };

  /** What is in the store at `at`, checked: a ledger somebody else wrote is not trusted to be the right shape. */
  async function load(at: string): Promise<Ledger> {
    const t = new Date(now());
    const day = t.toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    const raw = await o.store.get(at);
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
  const save = (at: string, l: Ledger) => o.store.set(at, l);
  /** Would one more hold go over the day or month limit? */
  const over = (l: Ledger, limit: SpendCap | undefined) => {
    const pending = held(l) + hold;
    return (limit?.dailyUsd !== undefined && l.dayUsd + pending > limit.dailyUsd) || (limit?.monthlyUsd !== undefined && l.monthUsd + pending > limit.monthlyUsd);
  };
  const settle = (l: Ledger, id: string, costUsd: number | undefined) => {
    const taken = l.holds[id]?.[0] ?? hold;
    delete l.holds[id];
    // A cost nobody reported counts as the hold: better to over-count than to let a free ride through.
    const cost = isNonNegative(costUsd) ? costUsd : taken;
    l.dayUsd += cost; l.monthUsd += cost;
  };

  /** Where this attempt is counted besides the pool: the caller's allowance, or, on their own key, the cap they chose. */
  async function target(info: { caller?: string; ownKey?: boolean; cap?: SpendCap }): Promise<{ at: string; limit: SpendCap | undefined } | null> {
    if (!info.caller) return null;
    if (info.ownKey) return info.cap ? { at: `${key}:own:${await sha256Hex(info.caller)}`, limit: info.cap } : null;
    if (!o.perCaller && !info.cap) return null;
    return { at: `${key}:caller:${await sha256Hex(info.caller)}`, limit: { dailyUsd: lowest(o.perCaller?.dailyUsd, info.cap?.dailyUsd), monthlyUsd: lowest(o.perCaller?.monthlyUsd, info.cap?.monthlyUsd) } };
  }

  return {
    handlesOwnKey: true,
    refusal: (id) => { const s = refusals.get(id); refusals.delete(id); return s; },
    allow: (info) => exclusive(async () => {
      try {
        const mine = await target(info);
        const taken: [string, Ledger][] = [];
        if (!info.ownKey) {
          const l = await load(key);
          if (over(l, o) || Object.keys(l.holds).length >= MAX_HOLDS) return refuse(info.id, 'app');
          taken.push([key, l]);
        }
        if (mine) {
          const c = await load(mine.at);
          if (over(c, mine.limit) || Object.keys(c.holds).length >= MAX_HOLDS) return refuse(info.id, info.ownKey ? 'own-key' : 'caller');
          taken.push([mine.at, c]);
        }
        for (const [at, l] of taken) { l.holds[info.id] = [hold, now() + ttl]; await save(at, l); }
        return true;
      } catch { return false; }
    }),
    record: (info) => exclusive(async () => {
      const mine = await target(info);
      for (const at of [...(info.ownKey ? [] : [key]), ...(mine ? [mine.at] : [])]) {
        const l = await load(at);
        settle(l, info.id, info.costUsd);
        await save(at, l);
      }
    }),
    release: (info) => exclusive(async () => {
      const mine = await target(info);
      for (const at of [...(info.ownKey ? [] : [key]), ...(mine ? [mine.at] : [])]) {
        const l = await load(at);
        if (!(info.id in l.holds)) continue;
        delete l.holds[info.id];
        await save(at, l);
      }
    }),
    report: () => exclusive(async () => {
      const l = await load(key);
      return { todayUsd: l.dayUsd, monthUsd: l.monthUsd, heldUsd: held(l), dailyUsd: o.dailyUsd, monthlyUsd: o.monthlyUsd };
    }),
    /** What one caller has spent and may spend: on the pool's money, or on their own key with `ownKey` and the `cap` they chose. For showing "$0.04 of $0.10 used today". */
    callerReport: (caller, opts = {}) => exclusive(async () => {
      const mine = await target({ caller, ownKey: opts.ownKey, cap: opts.cap });
      const l = await load(mine?.at ?? `${key}:caller:${await sha256Hex(caller)}`);
      return { todayUsd: l.dayUsd, monthUsd: l.monthUsd, heldUsd: held(l), dailyUsd: mine?.limit?.dailyUsd, monthlyUsd: mine?.limit?.monthlyUsd };
    }),
  };
}
