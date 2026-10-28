import { describe, expect, it } from 'vitest';
import { baseModelId, fetchScorecard, parseScorecard, rankModels, scoreFor, SCORECARD_SCHEMA, ScorecardError, type ModelScore, type Scorecard } from './scorecard.js';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const opts = { now: () => NOW };
const q = { task: 'translate', metric: 'chrf++', language: 'yo' };
const s = (model: string, value: number, o: Partial<ModelScore> = {}): ModelScore => ({ model, task: 'translate', metric: 'chrf++', value, higherIsBetter: true, n: 100, measuredAt: '2026-10-08', language: 'yo', ...o });
const card = (scores: ModelScore[], source = 'naija-eval'): Scorecard => ({ schema: SCORECARD_SCHEMA, source, generatedAt: '2026-10-28', scores });

describe('parseScorecard', () => {
  it('accepts a valid scorecard', () => {
    expect(parseScorecard(card([s('a/b', 50)])).scores).toHaveLength(1);
  });
  it('lists everything that is wrong, not just the first thing', () => {
    const bad = { schema: 'model-scorecard/9', source: '', generatedAt: 'x', scores: [{ model: 'a', task: 't', metric: 'm', value: 'high', higherIsBetter: 'yes', n: -1, measuredAt: 'soon' }] };
    const err = (() => { try { parseScorecard(bad); } catch (e) { return e as ScorecardError; } })()!;
    expect(err).toBeInstanceOf(ScorecardError);
    expect(err.problems.join('\n')).toMatch(/schema is "model-scorecard\/9"/);
    expect(err.problems.join('\n')).toMatch(/source is missing/);
    expect(err.problems.join('\n')).toMatch(/scores\[0\]\.value/);
    expect(err.problems.join('\n')).toMatch(/scores\[0\]\.measuredAt/);
    expect(err.problems.length).toBeGreaterThanOrEqual(6);
  });
  it('refuses something that is not an object, and a missing list of scores', () => {
    expect(() => parseScorecard(null)).toThrow(ScorecardError);
    expect(() => parseScorecard({ schema: SCORECARD_SCHEMA, source: 'x', generatedAt: '2026-10-28' })).toThrow(/scores is not a list/);
  });
});

describe('fetchScorecard', () => {
  it('fetches and checks a scorecard', async () => {
    const f = (async () => new Response(JSON.stringify(card([s('a/b', 1)])))) as typeof fetch;
    expect((await fetchScorecard('https://x/scorecard.json', { fetch: f })).source).toBe('naija-eval');
  });
  it('throws on an HTTP error or an invalid body', async () => {
    await expect(fetchScorecard('https://x', { fetch: (async () => new Response('', { status: 404 })) as typeof fetch })).rejects.toThrow('404');
    await expect(fetchScorecard('https://x', { fetch: (async () => new Response('{}')) as typeof fetch })).rejects.toBeInstanceOf(ScorecardError);
  });
});

describe('scoreFor', () => {
  it('treats a :free variant as the same model', () => {
    expect(baseModelId('Anthropic/Claude-X:free')).toBe('anthropic/claude-x');
    expect(scoreFor([card([s('a/b', 40)])], 'a/b:free', q, opts)?.value).toBe(40);
  });
  it('ignores scores from too few items, or too old, or for another language or metric', () => {
    expect(scoreFor([card([s('a/b', 40, { n: 10 })])], 'a/b', q, opts)).toBeUndefined();
    expect(scoreFor([card([s('a/b', 40, { measuredAt: '2024-01-01' })])], 'a/b', q, opts)).toBeUndefined();
    expect(scoreFor([card([s('a/b', 40, { language: 'ha' })])], 'a/b', q, opts)).toBeUndefined();
    expect(scoreFor([card([s('a/b', 40, { metric: 'wer' })])], 'a/b', q, opts)).toBeUndefined();
  });
  it('lets the caller change what counts as enough', () => {
    expect(scoreFor([card([s('a/b', 40, { n: 10 })])], 'a/b', q, { ...opts, minN: 5 })?.value).toBe(40);
  });
  it('when two scorecards measured the same thing, takes the one based on more items', () => {
    const big = card([s('a/b', 44, { n: 500 })], 'other');
    expect(scoreFor([card([s('a/b', 40)]), big], 'a/b', q, opts)?.value).toBe(44);
  });
});

describe('rankModels', () => {
  const c = card([s('good/model', 60), s('mid/model', 45), s('weak/model', 20)]);

  it('puts the best measured model first', () => {
    expect(rankModels(['weak/model', 'good/model', 'mid/model'], [c], q, opts)).toEqual(['good/model', 'mid/model', 'weak/model']);
  });
  it('leaves a model nobody measured in its place, so it is not pushed down by a weaker measured one', () => {
    expect(rankModels(['weak/model', 'unknown/model', 'good/model'], [c], q, opts)).toEqual(['good/model', 'unknown/model', 'weak/model']);
  });
  it('keeps the router last, adds nothing and drops nothing', () => {
    const out = rankModels(['weak/model:free', 'good/model:free', 'openrouter/free'], [c], q, opts);
    expect(out).toEqual(['good/model:free', 'weak/model:free', 'openrouter/free']);
    expect([...out].sort()).toEqual(['good/model:free', 'openrouter/free', 'weak/model:free']);
  });
  it('orders by lowest first when lower is better', () => {
    const wer = (m: string, v: number) => s(m, v, { task: 'transcribe', metric: 'wer', higherIsBetter: false });
    const out = rankModels(['x/a', 'x/b', 'x/c'], [card([wer('x/a', 60), wer('x/b', 30), wer('x/c', 45)])], { task: 'transcribe', metric: 'wer', language: 'yo' }, opts);
    expect(out).toEqual(['x/b', 'x/c', 'x/a']);
  });
  it('changes nothing with fewer than two measured models, or no scorecards', () => {
    expect(rankModels(['a', 'good/model'], [c], q, opts)).toEqual(['a', 'good/model']);
    expect(rankModels(['weak/model', 'good/model'], [], q, opts)).toEqual(['weak/model', 'good/model']);
  });
  it('is stable for equal scores', () => {
    const tie = card([s('a/x', 50), s('b/x', 50)]);
    expect(rankModels(['b/x', 'a/x'], [tie], q, opts)).toEqual(['b/x', 'a/x']);
  });
});
