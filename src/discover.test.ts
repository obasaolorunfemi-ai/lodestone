import { describe, expect, it } from 'vitest';
import type { CatalogModel } from './catalog.js';
import { resolveProviderModels } from './discover.js';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const m = (id: string, price = 0, o: Partial<CatalogModel> = {}): CatalogModel => ({ id, context_length: 128_000, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, pricing: { prompt: price / 1e6, completion: price / 1e6 }, ...o });
const base = { tier: 'fast' as const, now: NOW };

describe('resolveProviderModels', () => {
  it('returns the models the app named when nothing is known about what exists', () => {
    expect(resolveProviderModels(['a/x', 'b/y'], null, base)).toEqual(['a/x', 'b/y']);
    expect(resolveProviderModels(['a/x'], [], base)).toEqual(['a/x']);
  });
  it('drops a model the provider no longer lists', () => {
    expect(resolveProviderModels(['google/gone', 'google/here'], [m('google/here')], base)).toEqual(['google/here']);
  });
  it('drops a model that is retiring, or that the policy refuses', () => {
    const cat = [m('google/soon', 0, { expiration_date: '2026-10-30' }), m('google/ok'), m('bad-lab/x')];
    expect(resolveProviderModels(['google/soon', 'google/ok', 'bad-lab/x'], cat, { ...base, policy: { block: ['bad-lab/'] } })).toEqual(['google/ok']);
  });
  it('tops a short list up with trusted models within the price limit, after the ones the app named, and never above max', () => {
    const cat = [m('google/named', 0.5), m('google/cheap-a-mini', 0.2), m('anthropic/cheap-b-flash', 0.3), m('openai/pricey', 20), m('shady/cheap', 0.1), m('google/cheap-c-lite', 0.1)];
    const out = resolveProviderModels(['google/named'], cat, { ...base, fill: { maxPromptUsdPerMTok: 1, maxCompletionUsdPerMTok: 1 }, max: 3 });
    expect(out[0]).toBe('google/named');
    expect(out).toHaveLength(3);
    expect(out).not.toContain('openai/pricey');   // over the price limit
    expect(out).not.toContain('shady/cheap');     // not a trusted publisher
  });
  it('does not fill when the list is already full, or when no fill is asked for', () => {
    const cat = [m('google/a'), m('google/b'), m('google/c'), m('google/d')];
    expect(resolveProviderModels(['google/a', 'google/b', 'google/c'], cat, { ...base, fill: { maxPromptUsdPerMTok: 1, maxCompletionUsdPerMTok: 1 } })).toEqual(['google/a', 'google/b', 'google/c']);
    expect(resolveProviderModels(['google/a'], cat, base)).toEqual(['google/a']);
  });
  it("'free' means a price of zero: a paid model is never added by a free fill", () => {
    const out = resolveProviderModels([], [m('google/paid', 1), m('google/free-flash', 0)], { ...base, fill: { maxPromptUsdPerMTok: 0, maxCompletionUsdPerMTok: 0 } });
    expect(out).toEqual(['google/free-flash']);
  });
  it('for a call marked private, fills only with models the provider says are not trained on', () => {
    const cat = [m('google/trains-flash', 0, { data_used_for_training: true }), m('google/safe-flash', 0, { data_used_for_training: false, data_retention_days: 0 }), m('google/unknown-flash')];
    const out = resolveProviderModels([], cat, { ...base, strict: true, policy: { requireNoTraining: true }, fill: { maxPromptUsdPerMTok: 0, maxCompletionUsdPerMTok: 0 } });
    expect(out).toEqual(['google/safe-flash']);
  });
});
