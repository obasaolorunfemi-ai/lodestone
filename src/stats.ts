import type { AttemptEvent } from './lodestone.js';
import { SCORECARD_SCHEMA, type ModelScore, type Scorecard } from './scorecard.js';

/** Records how each model does in live traffic and reports it as a scorecard: how often
 *  it answered, and how fast. This is the other half of Naija Eval's measurements: that
 *  says how good an answer is, this says whether you get one at all. Keeps the last
 *  `window` attempts per model, in memory. Save `toJSON()` in your store if you want it
 *  to survive restarts. Never sees prompts or answers. */

export interface StatsOptions {
  /** Attempts kept per model and provider. Default 200. */
  window?: number;
  /** The `source` of the scorecard it produces. Default lodestone-live. */
  source?: string;
  now?: () => number;
}

interface Sample { ok: boolean; ms: number; at: number }
export type StatsState = Record<string, Sample[]>;

export interface Stats {
  record(e: AttemptEvent): void;
  scorecard(): Scorecard;
  toJSON(): StatsState;
  load(state: StatsState): void;
}

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const key = (provider: string, model: string) => `${provider}\u0000${model}`;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function createStats(opts: StatsOptions = {}): Stats {
  const window = opts.window ?? 200;
  const now = opts.now ?? Date.now;
  let state: StatsState = {};

  return {
    record(e) {
      if (e.outcome === 'skipped') return; // not tried, so nothing to count
      const k = key(e.provider, e.model);
      const list = (state[k] ??= []);
      list.push({ ok: e.outcome === 'ok', ms: e.ms, at: now() });
      if (list.length > window) list.splice(0, list.length - window);
    },
    toJSON: () => state,
    load(s) { state = s; },
    scorecard() {
      const scores: ModelScore[] = [];
      for (const [k, list] of Object.entries(state)) {
        if (!list.length) continue;
        const [provider, model] = k.split('\u0000');
        const measuredAt = day(Math.max(...list.map((s) => s.at)));
        const base = { model, n: list.length, measuredAt, slice: provider };
        scores.push({ ...base, task: 'availability', metric: 'success_rate', value: Math.round((list.filter((s) => s.ok).length / list.length) * 1000) / 10, higherIsBetter: true });
        const times = list.filter((s) => s.ok).map((s) => s.ms).sort((a, b) => a - b);
        if (times.length) {
          scores.push({ ...base, n: times.length, task: 'latency', metric: 'latency_p50_ms', value: percentile(times, 50), higherIsBetter: false });
          scores.push({ ...base, n: times.length, task: 'latency', metric: 'latency_p95_ms', value: percentile(times, 95), higherIsBetter: false });
        }
      }
      return { schema: SCORECARD_SCHEMA, source: opts.source ?? 'lodestone-live', generatedAt: new Date(now()).toISOString(), scores };
    },
  };
}
