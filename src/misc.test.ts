import { describe, expect, it } from 'vitest';
import { CANDIDATES_SCHEMA } from './candidates.js';
import { LodestoneError, messageFrom, ProviderError } from './errors.js';
import { explain } from './explain.js';
import { memoryStore } from './store.js';

describe('explain', () => {
  const kinds = ['auth', 'rate_limit', 'slow', 'credit', 'withdrawn', 'unavailable', 'bad_output', 'budget', 'aborted', 'not_configured', 'other'] as const;
  it('has a plain sentence for every kind of failure, and never shows a developer message', () => {
    for (const k of kinds) { const t = explain(new LodestoneError(k)); expect(t.length).toBeGreaterThan(5); expect(t).not.toMatch(/undefined|\[object|LodestoneError/); }
  });
  it('names the product and the place to add a key, only when given', () => {
    expect(explain(new LodestoneError('auth', { ownKey: false }), { product: 'KeyStone' })).toContain("KeyStone's");
    expect(explain(new LodestoneError('budget'), { product: 'KeyStone', settingsHint: 'in Settings' })).toContain('in Settings');
    expect(explain(new LodestoneError('budget'))).not.toContain('Settings');
  });
  it('blames the key only when it is the person\'s own, and the provider otherwise', () => {
    expect(explain(new LodestoneError('auth', { ownKey: true }))).toContain('Your OpenRouter key');
    expect(explain(new LodestoneError('auth', { ownKey: false }))).not.toContain('Your OpenRouter key');
  });
  it('gives a safe message for an error that is not Lodestone\'s', () => {
    expect(explain(new TypeError('x is undefined'))).toBe('Something went wrong talking to the AI provider. Try again in a moment.');
    expect(explain('a string')).toContain('Something went wrong');
  });
});

describe('errors', () => {
  it('reads the message out of the shapes providers use', () => {
    expect(messageFrom('{"error":{"message":"invalid x-api-key"}}')).toBe('invalid x-api-key');
    expect(messageFrom('{"error":"plain string"}')).toBe('plain string');
    expect(messageFrom('{"message":"top level"}')).toBe('top level');
  });
  it('returns nothing for a body without one, and keeps a long one to a sensible length', () => {
    for (const body of ['', 'not json', '{}', '{"error":{}}', '{"error":{"message":"   "}}']) expect(messageFrom(body)).toBeUndefined();
    expect(messageFrom(JSON.stringify({ error: { message: 'x'.repeat(1000) } }))!.length).toBe(300);
  });
  it('carries the status and body on a provider error and the kind on a Lodestone one', () => {
    const e = new ProviderError(429, 'body');
    expect([e.name, e.status, e.body]).toEqual(['ProviderError', 429, 'body']);
    const l = new LodestoneError('rate_limit', { status: 429 });
    expect([l.name, l.kind, l.detail.status]).toEqual(['LodestoneError', 'rate_limit', 429]);
  });
});

describe('memoryStore', () => {
  it('returns what was set, null for what was not, and replaces a value', async () => {
    const s = memoryStore();
    expect(await s.get('a')).toBeNull();
    await s.set('a', { n: 1 });
    expect(await s.get('a')).toEqual({ n: 1 });
    await s.set('a', 2);
    expect(await s.get('a')).toBe(2);
  });
  it('keeps keys apart, and each store separate from another', async () => {
    const a = memoryStore(); const b = memoryStore();
    await a.set('k', 1);
    expect(await b.get('k')).toBeNull();
  });
});

describe('candidates', () => {
  it('has a stable schema name that evaluators can check', () => { expect(CANDIDATES_SCHEMA).toBe('model-candidates/1'); });
});
