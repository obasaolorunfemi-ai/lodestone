import { describe, expect, it } from 'vitest';
import { createStats } from './stats.js';
import { parseScorecard, scoreFor } from './scorecard.js';
import type { AttemptEvent } from './lodestone.js';

const ev = (model: string, outcome: AttemptEvent['outcome'], ms: number, provider = 'openrouter'): AttemptEvent => ({ provider, model, phase: 'free', outcome, ms });
const NOW = Date.parse('2026-10-28T12:00:00Z');

describe('createStats', () => {
  it('reports how often each model answered, and how fast, as a valid scorecard', () => {
    const st = createStats({ now: () => NOW });
    for (const ms of [100, 200, 300, 400]) st.record(ev('a/m', 'ok', ms));
    st.record(ev('a/m', 'timeout', 5000));
    st.record(ev('b/m', 'failed', 50));
    const card = parseScorecard(st.scorecard());
    expect(card.source).toBe('lodestone-live');
    const get = (model: string, metric: string) => card.scores.find((x) => x.model === model && x.metric === metric);
    expect(get('a/m', 'success_rate')).toMatchObject({ value: 80, n: 5, higherIsBetter: true, task: 'availability', slice: 'openrouter', measuredAt: '2026-10-28' });
    expect(get('a/m', 'latency_p50_ms')).toMatchObject({ value: 200, higherIsBetter: false, n: 4 });
    expect(get('a/m', 'latency_p95_ms')?.value).toBe(400);
    expect(get('b/m', 'success_rate')?.value).toBe(0);
    expect(get('b/m', 'latency_p50_ms')).toBeUndefined(); // it never answered, so there is no speed to report
  });
  it('keeps only the most recent attempts per model', () => {
    const st = createStats({ window: 3, now: () => NOW });
    st.record(ev('a/m', 'failed', 1)); st.record(ev('a/m', 'failed', 1));
    for (let i = 0; i < 3; i++) st.record(ev('a/m', 'ok', 10));
    expect(st.scorecard().scores.find((x) => x.metric === 'success_rate')).toMatchObject({ value: 100, n: 3 });
  });
  it('keeps the same model on different providers apart', () => {
    const st = createStats({ now: () => NOW });
    st.record(ev('claude-x', 'ok', 10, 'anthropic')); st.record(ev('claude-x', 'failed', 10, 'openrouter'));
    const rates = st.scorecard().scores.filter((x) => x.metric === 'success_rate');
    expect(rates.map((x) => [x.slice, x.value]).sort()).toEqual([['anthropic', 100], ['openrouter', 0]]);
  });
  it('survives a restart through toJSON and load', () => {
    const a = createStats({ now: () => NOW });
    a.record(ev('a/m', 'ok', 120));
    const b = createStats({ now: () => NOW });
    b.load(JSON.parse(JSON.stringify(a.toJSON())));
    expect(b.scorecard().scores).toEqual(a.scorecard().scores);
  });
  it('can feed ranking: a model that keeps failing is put behind one that answers', () => {
    const st = createStats({ now: () => NOW });
    for (let i = 0; i < 40; i++) { st.record(ev('flaky/m', i % 4 === 0 ? 'ok' : 'failed', 100)); st.record(ev('steady/m', 'ok', 100)); }
    const q = { task: 'availability', metric: 'success_rate' };
    expect(scoreFor([st.scorecard()], 'flaky/m', q, { now: () => NOW })?.value).toBe(25);
    expect(scoreFor([st.scorecard()], 'steady/m', q, { now: () => NOW })?.value).toBe(100);
  });
});
