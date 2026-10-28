import { describe, expect, it } from 'vitest';
import type { CatalogModel } from './catalog.js';
import { DEFAULT_PUBLISHERS, publisherOf, vet } from './trust.js';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const m = (id: string, o: Partial<CatalogModel> = {}): CatalogModel => ({ id, ...o });
const found = { discovered: true, now: NOW };
const named = { discovered: false, now: NOW };

describe('vet: who made it', () => {
  it('accepts a discovered model from a well-known lab and refuses an unknown one', () => {
    expect(vet(m('google/gemma-4-31b-it:free'), undefined, found)).toEqual({ ok: true });
    expect(vet(m('shady-lab/free-llm:free'), undefined, found)).toEqual({ ok: false, reason: 'untrusted-publisher' });
  });
  it("does not hold a model the app named itself to the list: that is the app's decision", () => {
    expect(vet(m('poolside/laguna-s-2.1:free'), undefined, named)).toEqual({ ok: true });
  });
  it('uses the publisher the provider gives, not the host in the id (Requesty ids start with the host, such as vertex/)', () => {
    expect(publisherOf(m('vertex/gemini-x', { publisher: 'google' }))).toBe('google');
    expect(vet(m('bedrock/claude-x', { publisher: 'anthropic' }), undefined, found).ok).toBe(true);
    expect(vet(m('bedrock/unknown-x', { publisher: 'nobody' }), undefined, found).ok).toBe(false);
  });
  it('knows one lab by its different names (Requesty says mistral, OpenRouter mistralai, LLM API gemini-flash)', () => {
    expect(vet(m('mistral/mistral-small-latest', { publisher: 'mistral' }), undefined, found).ok).toBe(true);
    expect(vet(m('gemini-3.8-flash', { publisher: 'gemini-flash' }), undefined, found).ok).toBe(true);
    expect(publisherOf(m('x', { publisher: 'meta' }))).toBe('meta-llama');
  });
  it("can be widened or switched off, and the app's own list of labs replaces the default", () => {
    expect(vet(m('shady-lab/x'), { publishers: 'any' }, found).ok).toBe(true);
    expect(vet(m('shady-lab/x'), { publishers: ['shady-lab'] }, found).ok).toBe(true);
    expect(vet(m('google/x'), { publishers: ['shady-lab'] }, found).ok).toBe(false);
    expect(DEFAULT_PUBLISHERS).toContain('anthropic');
  });
});

describe('vet: the block list', () => {
  it('blocks an exact id or a whole publisher, for named and discovered models alike', () => {
    const p = { block: ['google/gemma-4-26b:free', 'bad-lab/'] };
    expect(vet(m('google/gemma-4-26b:free'), p, named)).toEqual({ ok: false, reason: 'blocked' });
    expect(vet(m('bad-lab/anything'), p, named)).toEqual({ ok: false, reason: 'blocked' });
    expect(vet(m('google/gemma-4-31b-it:free'), p, named).ok).toBe(true);
  });
});

describe('vet: retiring models', () => {
  it('drops a model that stops being offered within a week, and keeps one with longer to go', () => {
    expect(vet(m('google/a', { expiration_date: '2026-10-31' }), undefined, named)).toEqual({ ok: false, reason: 'expiring' });
    expect(vet(m('google/a', { expiration_date: '2026-12-31' }), undefined, named).ok).toBe(true);
    expect(vet(m('google/a', { expiration_date: '2026-11-20' }), { expiringWithinDays: 30 }, named).ok).toBe(false);
  });
  it('drops one already past its date', () => {
    expect(vet(m('google/a', { expiration_date: '2026-10-01' }), undefined, named).ok).toBe(false);
  });
});

describe('vet: what happens to the prompt', () => {
  const policy = { requireNoTraining: true, maxRetentionDays: 0 };
  it('refuses a model the provider says is trained on, or that keeps prompts', () => {
    expect(vet(m('google/a', { data_used_for_training: true, data_retention_days: 0 }), policy, named)).toEqual({ ok: false, reason: 'trains-on-data' });
    expect(vet(m('google/a', { data_used_for_training: false, data_retention_days: 30 }), policy, named)).toEqual({ ok: false, reason: 'retention' });
    expect(vet(m('google/a', { data_used_for_training: false, data_retention_days: 0 }), policy, named).ok).toBe(true);
  });
  it('refuses a discovered model whose privacy is unknown, but allows a named one, unless the call is private', () => {
    expect(vet(m('google/a'), policy, found)).toEqual({ ok: false, reason: 'unknown-data-policy' });
    expect(vet(m('google/a'), policy, named).ok).toBe(true);
    expect(vet(m('google/a'), policy, { ...named, strict: true })).toEqual({ ok: false, reason: 'unknown-data-policy' });
  });
});
