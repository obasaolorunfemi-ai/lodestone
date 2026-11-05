import { describe, expect, it } from 'vitest';
import type { CatalogModel } from './catalog.js';
import { healProviderModels, resolveProviderModels } from './discover.js';

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

describe('healProviderModels: Google, which gives a version and no release date', () => {
  const g = (id: string, line: string, version: string): CatalogModel => ({ id, line, version, publisher: 'google', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } });
  const cat = [g('gemini-3.6-flash', 'flash', '3.6'), g('gemini-3.10-flash', 'flash', '3.10'), g('gemini-3.8-flash', 'flash', '3.8'), g('gemini-3.1-flash-lite', 'flash-lite', '3.1'), g('gemini-3.1-pro', 'pro', '3.1')];
  const lineOf = (id: string) => /^gemini-[\d.]+-(flash-lite|flash|pro)$/.exec(id)?.[1];
  it('swaps a model Google no longer lists, reading its line from its id, for the highest version of that line', () => {
    const h = healProviderModels(['gemini-2.0-flash'], cat, { tier: 'strong', now: NOW, replaceRetired: true, lineOf });
    expect(h.replaced).toEqual([{ from: 'gemini-2.0-flash', to: 'gemini-3.10-flash', reason: 'withdrawn' }]);
    expect(h.models).toEqual(['gemini-3.10-flash']);
  });
  it('never crosses lines: a flash-lite is replaced by a flash-lite, not a flash', () => {
    expect(healProviderModels(['gemini-2.0-flash-lite'], cat, { tier: 'strong', now: NOW, replaceRetired: true, lineOf }).replaced).toEqual([{ from: 'gemini-2.0-flash-lite', to: 'gemini-3.1-flash-lite', reason: 'withdrawn' }]);
  });
  it('does nothing without the opt-in, and guesses nothing for an id that names no line', () => {
    expect(healProviderModels(['gemini-2.0-flash'], cat, { tier: 'strong', now: NOW, lineOf }).replaced).toEqual([]);
    expect(healProviderModels(['gemini-flash-latest'], cat, { tier: 'strong', now: NOW, replaceRetired: true, lineOf }).unreplaced[0]).toMatchObject({ id: 'gemini-flash-latest' });
  });
  it('swaps a listed-then-retired model of a known line for the newest version, never crossing lines', () => {
    const h = healProviderModels(['gemini-3.6-flash'], [{ ...g('gemini-3.6-flash', 'flash', '3.6'), lifecycle: 'retired' }, ...cat.slice(1)], { tier: 'strong', now: NOW, replaceRetired: true });
    expect(h.replaced).toEqual([{ from: 'gemini-3.6-flash', to: 'gemini-3.10-flash', reason: 'retired' }]);
  });
});

describe('healProviderModels: a gone model of a known line', () => {
  const claude = (id: string, line: string, created: string, o: Partial<CatalogModel> = {}): CatalogModel => ({ id, publisher: 'anthropic', line, created_at: created, lifecycle: 'active', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, ...o });
  const cat = [
    claude('claude-sonnet-4-20250514', 'sonnet', '2025-05-14T00:00:00Z', { lifecycle: 'retired' }),
    claude('claude-sonnet-4-5-20250929', 'sonnet', '2025-09-29T00:00:00Z', { lifecycle: 'deprecated', expiration_date: '2026-11-30T00:00:00Z' }),
    claude('claude-sonnet-5-5', 'sonnet', '2026-09-21T00:00:00Z'),
    claude('claude-sonnet-5-4', 'sonnet', '2026-06-01T00:00:00Z'),
    claude('claude-opus-5-5', 'opus', '2026-09-21T00:00:00Z'),
  ];
  const o = { tier: 'strong' as const, now: NOW, replaceRetired: true };

  it('drops a retired model by default and does not replace it', () => {
    const h = healProviderModels(['claude-sonnet-4-20250514', 'claude-opus-5-5'], cat, { tier: 'strong', now: NOW });
    expect(h.models).toEqual(['claude-opus-5-5']);
    expect(h.replaced).toEqual([]);
  });
  it('with replaceRetired, puts the newest current model of the same line in its place and says so', () => {
    const h = healProviderModels(['claude-sonnet-4-20250514'], cat, o);
    expect(h.models).toEqual(['claude-sonnet-5-5']);
    expect(h.replaced).toEqual([{ from: 'claude-sonnet-4-20250514', to: 'claude-sonnet-5-5', reason: 'retired' }]);
  });
  it('never crosses to another line, and never picks a deprecated model or one the app already named', () => {
    const h = healProviderModels(['claude-sonnet-4-20250514', 'claude-sonnet-5-5'], cat, o);
    expect(h.models).toEqual(['claude-sonnet-5-4', 'claude-sonnet-5-5']);   // takes the retired one's place in the list
    expect(h.replaced[0].to).toBe('claude-sonnet-5-4');
    expect(h.models).not.toContain('claude-opus-5-5');
    expect(h.models).not.toContain('claude-sonnet-4-5-20250929');
  });
  it('treats a model about to retire as gone', () => {
    const h = healProviderModels(['claude-sonnet-4-5-20250929'], cat, { ...o, now: Date.parse('2026-11-28T00:00:00Z') });
    expect(h.replaced).toEqual([{ from: 'claude-sonnet-4-5-20250929', to: 'claude-sonnet-5-5', reason: 'expiring' }]);
  });
  it('cannot place a model the provider no longer lists at all, because its line is unknown, and says so', () => {
    const h = healProviderModels(['claude-sonnet-3-7'], cat, o);
    expect(h.models).toEqual([]);
    expect(h.unreplaced).toEqual([{ id: 'claude-sonnet-3-7', reason: 'withdrawn', note: 'no longer listed, so its line is unknown' }]);
  });
  it('says so when the line has nothing current, and does not swap for a model the policy refuses', () => {
    const only = [claude('claude-haiku-3', 'haiku', '2024-03-01T00:00:00Z', { lifecycle: 'retired' })];
    expect(healProviderModels(['claude-haiku-3'], only, o).unreplaced[0].note).toBe('no current haiku model to take its place');
    const blocked = healProviderModels(['claude-sonnet-4-20250514'], cat, { ...o, policy: { block: ['claude-sonnet-5-5'] } });
    expect(blocked.replaced[0].to).toBe('claude-sonnet-5-4');
  });
  it('for the vision tier, only a model that reads images takes the place', () => {
    const noImg = cat.map((m) => (m.id === 'claude-sonnet-5-5' ? { ...m, architecture: { input_modalities: ['text'], output_modalities: ['text'] } } : m));
    expect(healProviderModels(['claude-sonnet-4-20250514'], noImg, { ...o, tier: 'vision' }).replaced[0].to).toBe('claude-sonnet-5-4');
  });
});
