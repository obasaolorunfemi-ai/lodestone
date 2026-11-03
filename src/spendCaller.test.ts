import { describe, expect, it } from 'vitest';
import { LodestoneError, ProviderError } from './errors.js';
import { explain } from './explain.js';
import { createLodestone } from './lodestone.js';
import { mock } from './providers/mock.js';
import { createSpendLimit } from './spend.js';
import { memoryStore } from './store.js';
import type { KeyValueStore, ProviderRequest } from './types.js';

const FREE = ['free-a:free', 'free-b:free', 'openrouter/free'];
const models = { fast: FREE, strong: FREE, vision: FREE };
const fail = (status: number) => { throw new ProviderError(status, ''); };
const quick = { minSliceMs: 5, freeSliceMs: 100, freeSliceWithLaterMs: 100, freePhaseWithLaterMs: 400 };
const info = (id: string, more: Record<string, unknown> = {}) => ({ id, provider: 'p', model: 'm', phase: 'paid' as const, ...more });
const NOW = Date.parse('2026-11-03T12:00:00Z');

describe('a share of the spend for each caller', () => {
  const make = (perCaller = { dailyUsd: 0.03 }, extra: Record<string, unknown> = {}) => createSpendLimit({ store: memoryStore(), dailyUsd: 1, holdUsd: 0.01, perCaller, ...extra });

  it('stops a caller at their share while everyone else carries on, and says whose limit it was', async () => {
    const spend = make();
    for (const id of ['1', '2', '3']) { expect(await spend.allow(info(id, { caller: 'ann' }))).toBe(true); await spend.record(info(id, { caller: 'ann', costUsd: 0.01 })); }
    expect(await spend.allow(info('4', { caller: 'ann' }))).toBe(false);
    expect(spend.refusal('4')).toBe('caller');
    expect(spend.refusal('4')).toBeUndefined();        // read once
    expect(await spend.allow(info('5', { caller: 'bob' }))).toBe(true);
    expect((await spend.report()).todayUsd).toBeCloseTo(0.03, 6);   // the pool counted ann's spending too
  });
  it('still holds everyone to the pool, and says so when the pool is what ran out', async () => {
    const spend = createSpendLimit({ store: memoryStore(), dailyUsd: 0.02, holdUsd: 0.01, perCaller: { dailyUsd: 1 } });
    expect(await spend.allow(info('1', { caller: 'ann' }))).toBe(true);
    expect(await spend.allow(info('2', { caller: 'bob' }))).toBe(true);
    expect(await spend.allow(info('3', { caller: 'cat' }))).toBe(false);
    expect(spend.refusal('3')).toBe('app');
  });
  it('holds under a burst from one caller', async () => {
    const spend = make({ dailyUsd: 0.05 });
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => spend.allow(info(`b${i}`, { caller: 'ann' }))));
    expect(results.filter(Boolean)).toHaveLength(5);
  });
  it('lets a person lower their own share but never raise it', async () => {
    const spend = make({ dailyUsd: 0.05 });
    expect(await spend.allow(info('a', { caller: 'ann', cap: { dailyUsd: 0.01 } }))).toBe(true);
    expect(await spend.allow(info('b', { caller: 'ann', cap: { dailyUsd: 0.01 } }))).toBe(false);   // their own lower cap: one hold of $0.01 is all
    const other = make({ dailyUsd: 0.01 });
    expect(await other.allow(info('a', { caller: 'bob', cap: { dailyUsd: 5 } }))).toBe(true);
    expect(await other.allow(info('b', { caller: 'bob', cap: { dailyUsd: 5 } }))).toBe(false);      // asking for more changes nothing
  });
  it('limits a call that names no caller only by the pool', async () => {
    const spend = make({ dailyUsd: 0.01 });
    for (const id of ['1', '2', '3']) expect(await spend.allow(info(id))).toBe(true);
  });
  it('starts a caller afresh each day', async () => {
    let t = NOW;
    const spend = make({ dailyUsd: 0.01 }, { now: () => t });
    await spend.allow(info('1', { caller: 'ann' })); await spend.record(info('1', { caller: 'ann', costUsd: 0.01 }));
    expect(await spend.allow(info('2', { caller: 'ann' }))).toBe(false);
    t += 86_400_000;
    expect(await spend.allow(info('3', { caller: 'ann' }))).toBe(true);
  });
  it('gives both holds back when an attempt does not answer', async () => {
    const spend = make();
    await spend.allow(info('a', { caller: 'ann' }));
    expect((await spend.callerReport('ann')).heldUsd).toBeCloseTo(0.01, 6);
    await spend.release(info('a', { caller: 'ann' }));
    expect((await spend.callerReport('ann')).heldUsd).toBe(0);
    expect((await spend.report()).heldUsd).toBe(0);
  });
  it('reports what a caller has used and may use', async () => {
    const spend = make({ dailyUsd: 0.1 });
    await spend.allow(info('a', { caller: 'ann' })); await spend.record(info('a', { caller: 'ann', costUsd: 0.04 }));
    expect(await spend.callerReport('ann')).toMatchObject({ todayUsd: 0.04, dailyUsd: 0.1 });
  });
  it('stores a hash of the caller, never the caller', async () => {
    const seen: string[] = [];
    const store: KeyValueStore = { get: async () => null, set: async (k) => { seen.push(k); } };
    await createSpendLimit({ store, perCaller: { dailyUsd: 1 } }).allow(info('a', { caller: '203.0.113.7' }));
    expect(seen.some((k) => k.includes('203.0.113.7'))).toBe(false);
    expect(seen.some((k) => k.includes(':caller:'))).toBe(true);
  });
});

describe('a cap a person sets on their own key', () => {
  it('is counted apart from the pool and stops at the number they chose', async () => {
    const spend = createSpendLimit({ store: memoryStore(), dailyUsd: 1, holdUsd: 0.01 });
    const own = (id: string, more: Record<string, unknown> = {}) => info(id, { caller: 'ann', ownKey: true, cap: { dailyUsd: 0.02 }, ...more });
    for (const id of ['1', '2']) { expect(await spend.allow(own(id))).toBe(true); await spend.record(own(id, { costUsd: 0.01 })); }
    expect(await spend.allow(own('3'))).toBe(false);
    expect(spend.refusal('3')).toBe('own-key');
    expect((await spend.report()).todayUsd).toBe(0);   // never touches the pool
    expect(await spend.callerReport('ann', { ownKey: true, cap: { dailyUsd: 0.02 } })).toMatchObject({ todayUsd: 0.02, dailyUsd: 0.02 });
  });
});

describe('through createLodestone', () => {
  /** Free models are down; the paid one answers and costs a cent. */
  const paid = () => mock((req: ProviderRequest) => (req.model.startsWith('paid') ? { text: 'ok', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 } } : fail(503)));
  const cfg = (spend: ReturnType<typeof createSpendLimit>) => ({ openrouter: { apiKey: 'platform', provider: paid(), models, paidModels: ['paid-1'], allowPaid: true }, spend, timing: quick });

  it("one caller using up their share gets a 'budget' error naming the caller's limit, and another caller is still served", async () => {
    const spend = createSpendLimit({ store: memoryStore(), dailyUsd: 10, holdUsd: 0.01, perCaller: { dailyUsd: 0.02 } });
    const ai = createLodestone(cfg(spend));
    await ai.complete({ prompt: 'x', caller: 'ann' }); await ai.complete({ prompt: 'x', caller: 'ann' });
    const err = await ai.complete({ prompt: 'x', caller: 'ann' }).catch((e) => e);
    expect(err).toBeInstanceOf(LodestoneError);
    expect(err).toMatchObject({ kind: 'budget', detail: { scope: 'caller' } });
    expect(explain(err, { product: 'Acme', settingsHint: 'in Settings' })).toContain("used your share of Acme's AI");
    expect((await ai.complete({ prompt: 'x', caller: 'bob' })).text).toBe('ok');
  });
  it('a person can lower their share with spendCap', async () => {
    const spend = createSpendLimit({ store: memoryStore(), dailyUsd: 10, holdUsd: 0.01, perCaller: { dailyUsd: 1 } });
    const ai = createLodestone(cfg(spend));
    await ai.complete({ prompt: 'x', caller: 'ann', spendCap: { dailyUsd: 0.01 } });
    await expect(ai.complete({ prompt: 'x', caller: 'ann', spendCap: { dailyUsd: 0.01 } })).rejects.toMatchObject({ kind: 'budget', detail: { scope: 'caller' } });
  });
  it('a caller on their own key is not counted and not limited unless they set a cap', async () => {
    const spend = createSpendLimit({ store: memoryStore(), dailyUsd: 0.01, holdUsd: 0.01, perCaller: { dailyUsd: 0.01 } });
    const ai = createLodestone(cfg(spend));
    for (let i = 0; i < 4; i++) expect((await ai.complete({ prompt: 'x', caller: 'ann', apiKey: 'their-key' })).text).toBe('ok');
    expect(await spend.report()).toMatchObject({ todayUsd: 0, heldUsd: 0 });
  });
  it("with a cap of their own, their key's spending stops at it, without touching the pool", async () => {
    const spend = createSpendLimit({ store: memoryStore(), dailyUsd: 10, holdUsd: 0.01 });
    const ai = createLodestone(cfg(spend));
    const call = () => ai.complete({ prompt: 'x', caller: 'ann', apiKey: 'their-key', spendCap: { dailyUsd: 0.02 } });
    await call(); await call();
    const err = await call().catch((e) => e);
    expect(err).toMatchObject({ kind: 'budget', detail: { scope: 'own-key' } });
    expect(explain(err)).toContain('spending limit you set');
    expect(await spend.report()).toMatchObject({ todayUsd: 0 });
    expect(await spend.callerReport('ann', { ownKey: true, cap: { dailyUsd: 0.02 } })).toMatchObject({ todayUsd: 0.02 });
  });
  it('refuses a spendCap it cannot keep, instead of quietly ignoring it', async () => {
    const spend = createSpendLimit({ store: memoryStore(), dailyUsd: 1 });
    await expect(createLodestone(cfg(spend)).complete({ prompt: 'x', spendCap: { dailyUsd: 1 } })).rejects.toThrow(/needs a caller/);
    await expect(createLodestone(cfg(spend)).complete({ prompt: 'x', caller: 'a', spendCap: { dailyUsd: -1 } })).rejects.toThrow(/zero or more/);
    const plain = createLodestone({ ...cfg(spend), spend: { allow: () => true, record: () => {} } });
    await expect(plain.complete({ prompt: 'x', caller: 'a', spendCap: { dailyUsd: 1 } })).rejects.toThrow(/createSpendLimit/);
    await expect(createLodestone({ openrouter: { apiKey: 'p', provider: mock('ok'), models } }).complete({ prompt: 'x', caller: 'a', spendCap: { dailyUsd: 1 } })).rejects.toThrow(/createSpendLimit/);
  });
  it('leaves a custom spend limit as it was: it is never asked about a caller\'s own key', async () => {
    const seen: string[] = [];
    const custom = { allow: (i: { id: string }) => { seen.push(i.id); return true; }, record: () => {} };
    const ai = createLodestone({ ...cfg(createSpendLimit({ store: memoryStore() })), spend: custom });
    await ai.complete({ prompt: 'x', apiKey: 'their-key' });
    expect(seen).toEqual([]);
  });
});
