import { describe, expect, it } from 'vitest';
import { LodestoneError } from './errors.js';
import { explain } from './explain.js';
import { readRateLimit } from './rateLimit.js';

const daily = JSON.stringify({ error: { message: 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day', code: 429, metadata: { headers: { 'X-RateLimit-Limit': '50', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1793232000000' } } } });
const upstream = JSON.stringify({ error: { message: 'Provider returned error', code: 429, metadata: { raw: 'model is temporarily rate-limited upstream', provider_name: 'Venice' } } });

describe('readRateLimit', () => {
  it('knows the daily free-model allowance and when it resets', () => {
    const r = readRateLimit(daily);
    expect(r.kind).toBe('daily');
    expect(r.limit).toBe(50);
    expect(r.resetAt?.toISOString()).toBe('2026-10-29T00:00:00.000Z');
  });
  it("knows an upstream provider limit, which is not the key's fault", () => {
    expect(readRateLimit(upstream).kind).toBe('upstream');
  });
  it('knows a per-minute limit, and falls back to other for anything else', () => {
    expect(readRateLimit(JSON.stringify({ error: { message: 'Rate limit exceeded: 20 requests per minute' } })).kind).toBe('minute');
    expect(readRateLimit('nonsense').kind).toBe('other');
  });
});

describe('explain', () => {
  const rl = (body: string, ownKey: boolean, needsCredit = false) => explain(new LodestoneError('rate_limit', { status: 429, rateLimit: readRateLimit(body), ownKey, needsCredit }), { product: 'KeyStone', settingsHint: 'in Settings' });

  it('does not blame the key for an upstream limit', () => {
    const msg = rl(upstream, true);
    expect(msg).toContain('not your key');
    expect(msg).not.toContain('own rate limit');
  });
  it('explains the daily allowance with a reset time and the remedy', () => {
    const msg = rl(daily, true);
    expect(msg).toContain('50 requests');
    expect(msg).toContain('00:00 UTC');
    expect(msg).toContain('credit');
  });
  it('offers the shared-budget advice to people without their own key, naming the product', () => {
    const msg = rl('nonsense', false);
    expect(msg).toContain('KeyStone');
    expect(msg).toContain('in Settings');
  });
  it('does not mention settings when the product has none', () => {
    expect(explain(new LodestoneError('rate_limit', { rateLimit: { kind: 'other' } }))).not.toContain('Settings');
  });
  it('has a message for every kind of failure', () => {
    for (const k of ['auth', 'rate_limit', 'slow', 'credit', 'withdrawn', 'unavailable', 'bad_output', 'not_configured', 'other'] as const) {
      expect(explain(new LodestoneError(k)).length).toBeGreaterThan(10);
    }
    expect(explain(new Error('x'))).toContain('Something went wrong');
  });
});
