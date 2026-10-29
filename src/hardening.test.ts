import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { LodestoneError, ProviderError } from './errors.js';
import { explain } from './explain.js';
import { createHealth } from './health.js';
import { createRateLimiter } from './limiter.js';
import { createLodestone } from './lodestone.js';
import { mock } from './providers/mock.js';
import { fetchScorecard } from './scorecard.js';
import { createSpendLimit } from './spend.js';
import { memoryStore } from './store.js';
import { cloudflareKvStore, denoKvStore, netlifyBlobsStore, safeKey, upstashStore } from './stores/index.js';
import type { KeyValueStore, ProviderRequest } from './types.js';

const FREE = ['free-a:free', 'free-b:free', 'openrouter/free'];
const models = { fast: FREE, strong: FREE, vision: FREE };
const fail = (status: number) => { throw new ProviderError(status, ''); };
const quick = { minSliceMs: 5, freeSliceMs: 100, freeSliceWithLaterMs: 100, freePhaseWithLaterMs: 400 };

/** A store that records what is written, so a test can look at it. */
const spyStore = () => { const inner = memoryStore(); const writes: string[] = []; const s: KeyValueStore = { get: (k) => inner.get(k), set: async (k, v, o) => { writes.push(k); await inner.set(k, v, o); } }; return Object.assign(s, { writes }); };

describe('private calls and the cache', () => {
  it('never saves or serves a private answer, even with a cacheKey', async () => {
    const store = spyStore();
    const or = mock('answer about the cv');
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: or, models }, store });
    await ai.complete({ prompt: 'my cv', private: true, cacheKey: 'cv-1' });
    await ai.complete({ prompt: 'my cv', private: true, cacheKey: 'cv-1' });
    expect(or.calls).toHaveLength(2);
    expect(store.writes.filter((k) => k.startsWith('lodestone:cache:'))).toEqual([]);
  });
  it('does not serve a private call an answer cached by a normal call under the same key', async () => {
    const store = spyStore();
    const or = mock('x');
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: or, models }, store });
    await ai.complete({ prompt: 'same', cacheKey: 'k1' });
    const r = await ai.complete({ prompt: 'same', cacheKey: 'k1', private: true });
    expect(r.cached).toBeUndefined();
    expect(or.calls).toHaveLength(2);
  });
  it('still caches a normal call, and serves it for the same input', async () => {
    const or = mock('x');
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: or, models } });
    await ai.complete({ prompt: 'same', cacheKey: 'k1' });
    expect((await ai.complete({ prompt: 'same', cacheKey: 'k1' })).cached).toBe(true);
    expect(or.calls).toHaveLength(1);
  });
  it('treats a cacheKey that is too coarse as a miss, never as another input\'s answer', async () => {
    const or = mock((req: ProviderRequest) => `answer to ${JSON.stringify(req.messages)}`);
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: or, models } });
    const a = await ai.complete({ prompt: 'alice cv', cacheKey: 'cv' });
    const b = await ai.complete({ prompt: 'bob cv', cacheKey: 'cv' });
    expect(b.cached).toBeUndefined();
    expect(b.text).not.toBe(a.text);
    expect(b.text).toContain('bob');
  });
  it('gives the cached answer a lifetime in the store', async () => {
    const seen: (number | undefined)[] = [];
    const inner = memoryStore();
    const store: KeyValueStore = { get: (k) => inner.get(k), set: async (k, v, o) => { if (k.startsWith('lodestone:cache:')) seen.push(o?.ttlMs); await inner.set(k, v, o); } };
    await createLodestone({ openrouter: { apiKey: 'k', provider: mock('x'), models }, store }).complete({ prompt: 'p', cacheKey: 'a', cacheTtlMs: 5_000 });
    expect(seen).toEqual([5_000]);
  });
});

describe('private calls and fallback providers', () => {
  const orDown = mock(() => fail(503));
  it('skips a fallback that nothing vouches for, even with no trust policy', async () => {
    const fb = mock('from fallback');
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: orDown, models }, fallbacks: [{ provider: fb, apiKey: 'g', models: ['m1'] }], timing: quick });
    await expect(ai.complete({ prompt: 'cv', private: true })).rejects.toBeInstanceOf(LodestoneError);
    expect(fb.calls).toHaveLength(0);
  });
  it('uses the same fallback when the call is not private', async () => {
    const fb = mock('from fallback');
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: orDown, models }, fallbacks: [{ provider: fb, apiKey: 'g', models: ['m1'] }], timing: quick });
    expect((await ai.complete({ prompt: 'x' })).text).toBe('from fallback');
  });
  it("uses a fallback the app vouches for with privacy: 'no-training'", async () => {
    const fb = mock('from fallback');
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: orDown, models }, fallbacks: [{ provider: fb, apiKey: 'g', models: ['m1'], privacy: 'no-training' }], timing: quick });
    expect((await ai.complete({ prompt: 'cv', private: true })).text).toBe('from fallback');
  });
  it('checks a fallback\'s own list with no trust policy set: only a model its list says is not trained on is used', async () => {
    const gw = mock('from gateway') as ReturnType<typeof mock> & { listModels?: unknown };
    const e = { context_length: 100000, pricing: { prompt: 1e-7, completion: 1e-7 } };
    gw.listModels = async () => [{ id: 'google/trained', data_used_for_training: true, ...e }, { id: 'google/unknown', ...e }, { id: 'google/safe', data_used_for_training: false, ...e }];
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: orDown, models }, timing: quick, fallbacks: [{ provider: gw, apiKey: 'g', models: ['google/trained', 'google/unknown', 'google/safe'] }], fetch: (async () => new Response(JSON.stringify({ data: [{ id: 'free-a:free', context_length: 100000 }] }))) as typeof fetch });
    await ai.checkModels();
    await ai.complete({ prompt: 'cv', private: true });
    expect(gw.calls.map((c) => c.model)).toEqual(['google/safe']);
  });
  it('skips a fallback with a list when the list has not been read yet', async () => {
    const gw = mock('x') as ReturnType<typeof mock> & { listModels?: unknown };
    gw.listModels = async () => null;
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: orDown, models }, timing: quick, fallbacks: [{ provider: gw, apiKey: 'g', models: ['a'] }] });
    await expect(ai.complete({ prompt: 'cv', private: true })).rejects.toBeInstanceOf(LodestoneError);
    expect(gw.calls).toHaveLength(0);
  });
});

describe('createSpendLimit', () => {
  const info = (id: string) => ({ id, provider: 'p', model: 'm', phase: 'paid' as const });
  it('lets only as many concurrent attempts through as the limit has room for', async () => {
    const spend = createSpendLimit({ store: memoryStore(), dailyUsd: 0.05, holdUsd: 0.01 });
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => spend.allow(info(`a${i}`))));
    expect(results.filter(Boolean)).toHaveLength(5);
  });
  it('replaces a hold with the real cost, and hands one back when the attempt did not answer', async () => {
    const spend = createSpendLimit({ store: memoryStore(), dailyUsd: 1, holdUsd: 0.1 });
    await spend.allow(info('a')); await spend.allow(info('b'));
    expect(await spend.report()).toMatchObject({ heldUsd: 0.2, todayUsd: 0 });
    await spend.record({ ...info('a'), costUsd: 0.0004 });
    await spend.release(info('b'));
    const r = await spend.report();
    expect(r.todayUsd).toBeCloseTo(0.0004, 6);
    expect(r.heldUsd).toBe(0);
  });
  it('counts a hold as the cost when the provider reported none', async () => {
    const spend = createSpendLimit({ store: memoryStore(), dailyUsd: 1, holdUsd: 0.05 });
    await spend.allow(info('a'));
    await spend.record(info('a'));
    expect((await spend.report()).todayUsd).toBeCloseTo(0.05, 6);
  });
  it('starts the day and the month over', async () => {
    let t = Date.parse('2026-10-29T12:00:00Z');
    const spend = createSpendLimit({ store: memoryStore(() => t), dailyUsd: 0.02, monthlyUsd: 0.03, holdUsd: 0.01, now: () => t });
    for (const id of ['a', 'b']) { await spend.allow(info(id)); await spend.record({ ...info(id), costUsd: 0.01 }); }
    expect(await spend.allow(info('c'))).toBe(false);          // the day is full
    t = Date.parse('2026-10-30T12:00:00Z');
    expect(await spend.allow(info('d'))).toBe(true);           // a new day, same month
    await spend.record({ ...info('d'), costUsd: 0.01 });
    expect(await spend.allow(info('e'))).toBe(false);          // the month is full
    t = Date.parse('2026-11-01T00:00:01Z');
    expect(await spend.allow(info('f'))).toBe(true);
  });
  it('lets a hold that was never settled expire', async () => {
    let t = 1_000_000;
    const spend = createSpendLimit({ store: memoryStore(() => t), dailyUsd: 0.01, holdUsd: 0.01, holdTtlMs: 1000, now: () => t });
    expect(await spend.allow(info('a'))).toBe(true);
    expect(await spend.allow(info('b'))).toBe(false);
    t += 1500;
    expect(await spend.allow(info('b'))).toBe(true);
  });
  it('refuses the attempt when the ledger cannot be read, and ignores a ledger of the wrong shape', async () => {
    const broken: KeyValueStore = { get: async () => { throw new Error('down'); }, set: async () => {} };
    expect(await createSpendLimit({ store: broken, dailyUsd: 1 }).allow(info('a'))).toBe(false);
    const junk: KeyValueStore = { get: async () => ({ dayUsd: 'lots', holds: 7 }), set: async () => {} };
    expect(await createSpendLimit({ store: junk, dailyUsd: 1 }).allow(info('a'))).toBe(true);
  });
  it('is held to the limit by createLodestone: a burst cannot overshoot, and a failed attempt gives its hold back', async () => {
    const store = memoryStore();
    const spend = createSpendLimit({ store, dailyUsd: 0.03, holdUsd: 0.01 });
    const paid = mock((req: ProviderRequest) => (req.model.startsWith('paid') ? { text: 'ok', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 } } : fail(503)));
    const ai = createLodestone({ openrouter: { apiKey: 'p', provider: paid, models, paidModels: ['paid-1'], allowPaid: true, paidFirst: true }, spend, timing: quick });
    const outcomes = await Promise.allSettled(Array.from({ length: 10 }, () => ai.complete({ prompt: 'x' })));
    const fromPaid = outcomes.filter((o) => o.status === 'fulfilled' && (o.value as { model: string }).model === 'paid-1');
    expect(fromPaid).toHaveLength(3);
    expect((await spend.report()).todayUsd).toBeCloseTo(0.03, 6);
    expect((await spend.report()).heldUsd).toBe(0);
  });
  it('gives the hold back when the paid attempt fails', async () => {
    const spend = createSpendLimit({ store: memoryStore(), dailyUsd: 1, holdUsd: 0.1 });
    const ai = createLodestone({ openrouter: { apiKey: 'p', provider: mock(() => fail(503)), models, paidModels: ['paid-1'], allowPaid: true }, spend, timing: quick });
    await ai.complete({ prompt: 'x' }).catch(() => {});
    expect(await spend.report()).toMatchObject({ heldUsd: 0, todayUsd: 0 });
  });
});

describe('createRateLimiter', () => {
  it('gives each caller their own allowance', async () => {
    const rl = createRateLimiter({ store: memoryStore(), max: 2, windowMs: 60_000 });
    expect([(await rl.take('a')).ok, (await rl.take('a')).ok, (await rl.take('a')).ok]).toEqual([true, true, false]);
    expect((await rl.take('b')).ok).toBe(true);
  });
  it('says how long to wait, and starts a new window', async () => {
    let t = 10 * 60_000 + 5_000;
    const rl = createRateLimiter({ store: memoryStore(() => t), max: 1, windowMs: 60_000, now: () => t });
    await rl.take('a');
    const denied = await rl.take('a');
    expect(denied).toMatchObject({ ok: false, remaining: 0, retryAfterMs: 55_000 });
    t += 56_000;
    expect((await rl.take('a')).ok).toBe(true);
  });
  it('works on a store that can only get and set, and does not lose counts in one process', async () => {
    const inner = memoryStore();
    const plain: KeyValueStore = { get: (k) => inner.get(k), set: (k, v, o) => inner.set(k, v, o) };
    const rl = createRateLimiter({ store: plain, max: 5, windowMs: 60_000 });
    const all = await Promise.all(Array.from({ length: 20 }, () => rl.take('same')));
    expect(all.filter((r) => r.ok)).toHaveLength(5);
  });
  it('stores a hash of the caller, never the caller', async () => {
    const keys: string[] = [];
    const inner = memoryStore();
    const store = { ...inner, incrBy: (k: string, n: number, o: { ttlMs: number }) => { keys.push(k); return inner.incrBy(k, n, o); } };
    await createRateLimiter({ store, max: 1 }).take('203.0.113.7');
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain('203.0.113.7');
  });
  it('lets calls through when the store is down, unless told to refuse', async () => {
    const broken: KeyValueStore = { get: async () => { throw new Error('x'); }, set: async () => { throw new Error('x'); } };
    expect((await createRateLimiter({ store: broken, max: 1 }).take('a')).ok).toBe(true);
    expect((await createRateLimiter({ store: broken, max: 1, onStoreError: 'deny' }).take('a')).ok).toBe(false);
  });
});

describe('rateLimit in createLodestone', () => {
  const limiter = () => createRateLimiter({ store: memoryStore(), max: 2, windowMs: 3_600_000 });
  it('rejects a caller over their allowance with kind throttled and a way to explain it', async () => {
    const or = mock('x');
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: or, models }, rateLimit: { limiter: limiter() } });
    await ai.complete({ prompt: '1', caller: 'u1' }); await ai.complete({ prompt: '2', caller: 'u1' });
    const err = await ai.complete({ prompt: '3', caller: 'u1' }).catch((e) => e);
    expect(err).toBeInstanceOf(LodestoneError);
    expect(err.kind).toBe('throttled');
    expect(err.detail.retryAfterMs).toBeGreaterThan(0);
    expect(explain(err)).toMatch(/lot of requests/);
    expect(or.calls).toHaveLength(2);
    expect((await ai.complete({ prompt: '4', caller: 'u2' })).text).toBe('x'); // another caller is unaffected
  });
  it('does not limit a call without a caller, or one on the caller\'s own key', async () => {
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: mock('x'), models }, rateLimit: { limiter: createRateLimiter({ store: memoryStore(), max: 0 }) } });
    await expect(ai.complete({ prompt: 'a' })).resolves.toBeTruthy();
    await expect(ai.complete({ prompt: 'a', caller: 'u', apiKey: 'their-own' })).resolves.toBeTruthy();
  });
  it('with free-only, serves a caller over their allowance from free models and never spends the platform\'s money', async () => {
    const or = mock((req: ProviderRequest) => (req.model.startsWith('paid') ? { text: 'paid answer', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 } } : fail(503)));
    const spent: string[] = [];
    const ai = createLodestone({ openrouter: { apiKey: 'p', provider: or, models, paidModels: ['paid-1'], allowPaid: true, paidFirst: true }, timing: quick,
      spend: { allow: (i) => { spent.push(i.model); return true; }, record: () => {} }, rateLimit: { limiter: createRateLimiter({ store: memoryStore(), max: 0 }), whenOver: 'free-only' } });
    const err = await ai.complete({ prompt: 'x', caller: 'abuser' }).catch((e) => e);
    expect(err.kind).toBe('throttled');
    expect(spent).toEqual([]);
    expect(or.calls.every((c) => !c.model.startsWith('paid'))).toBe(true);
    const okFree = createLodestone({ openrouter: { apiKey: 'p', provider: mock('free answer'), models, paidModels: ['paid-1'], allowPaid: true, paidFirst: true }, rateLimit: { limiter: createRateLimiter({ store: memoryStore(), max: 0 }), whenOver: 'free-only' } });
    expect((await okFree.complete({ prompt: 'x', caller: 'abuser' })).text).toBe('free answer');
  });
});

describe('errors do not carry the provider\'s body into logs', () => {
  it('leaves the body out of JSON and console output, but keeps it on the error', () => {
    const e = new ProviderError(400, 'echo: my secret prompt text');
    expect(JSON.stringify(e)).not.toContain('secret');
    expect(inspect(e)).not.toContain('secret');
    expect(e.body).toBe('echo: my secret prompt text');
    expect(e.status).toBe(400);
  });
});

describe('a store somebody else can write to', () => {
  it('does not let a malformed health record break the breaker, or hide models it should not', async () => {
    const store = memoryStore();
    await store.set('lodestone:health', { 'p\u0000m': [[Date.now(), 0, 'x'], [Date.now(), 0, 'y'], 'junk', [1, 2, 3]], bad: 'nope', worse: [[NaN, 0, 'z']], ...Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`k${i}`, [[Date.now(), 0, 'a']]])) });
    const health = createHealth({ store });
    await expect(health.shouldSkip('p', 'm')).resolves.toBe(false);   // two good samples are not enough to open it
    expect((await health.snapshot()).length).toBeLessThanOrEqual(400);
  });
  it('ignores a catalogue of the wrong shape', async () => {
    const store = memoryStore();
    await store.set('lodestone:model-catalog', { at: new Date().toISOString(), models: [{ id: 7 }, null, 'x', { nope: true }] });
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: mock('ok'), models }, store });
    await expect(ai.resolveModels('fast')).resolves.toEqual(FREE);
  });
});

describe('fetchScorecard', () => {
  const card = JSON.stringify({ schema: 'model-scorecard/1', source: 's', generatedAt: '2026-10-01', scores: [] });
  const ok = (body = card, headers: Record<string, string> = {}) => (async () => { const r = new Response(body, { headers }); return r; }) as typeof fetch;
  it('reads a small https scorecard', async () => { await expect(fetchScorecard('https://x.example/c.json', { fetch: ok() })).resolves.toMatchObject({ source: 's' }); });
  it('refuses plain http, except to localhost', async () => {
    await expect(fetchScorecard('http://x.example/c.json', { fetch: ok() })).rejects.toThrow(/https/);
    await expect(fetchScorecard('http://localhost:8080/c.json', { fetch: ok() })).resolves.toBeTruthy();
  });
  it('refuses a body over the limit, declared or streamed', async () => {
    await expect(fetchScorecard('https://x.example/c', { fetch: ok(card, { 'content-length': '99999999' }) })).rejects.toThrow(/larger/);
    await expect(fetchScorecard('https://x.example/c', { fetch: ok(card + ' '.repeat(5000)), maxBytes: 1000 })).rejects.toThrow(/larger/);
  });
  it('only reads from hosts you allowed', async () => {
    await expect(fetchScorecard('https://evil.example/c', { fetch: ok(), allowedHosts: ['naija-eval.extrafemi.com'] })).rejects.toThrow(/not allowed/);
    await expect(fetchScorecard('https://naija-eval.extrafemi.com/c', { fetch: ok(), allowedHosts: ['naija-eval.extrafemi.com'] })).resolves.toBeTruthy();
  });
  it('refuses a scorecard with too many entries', async () => {
    const big = JSON.stringify({ schema: 'model-scorecard/1', source: 's', generatedAt: '2026-10-01', scores: Array.from({ length: 20_001 }, () => 0) });
    await expect(fetchScorecard('https://x.example/c', { fetch: ok(big), maxBytes: 5_000_000 })).rejects.toThrow(/more than/);
  });
});

describe('store adapters', () => {
  it('safeKey is stable, injective and store-safe', async () => {
    expect(await safeKey('lodestone:cache:a/b c')).toBe('lodestone~3acache~3aa~2fb~20c');
    expect(await safeKey('a~b')).toBe('a~7eb');
    expect(await safeKey('a~b')).not.toBe(await safeKey('a b'));
    expect(await safeKey('x'.repeat(500))).toMatch(/^h-[0-9a-f]{64}$/);
  });
  it('netlifyBlobsStore round-trips, expires values, and reads values written without a wrapper', async () => {
    const data = new Map<string, unknown>(); let t = 1000;
    const store = netlifyBlobsStore({ get: async (k) => data.get(k) ?? null, setJSON: async (k, v) => { data.set(k, v); } }, { now: () => t });
    await store.set('lodestone:a', { n: 1 }, { ttlMs: 500 });
    expect([...data.keys()]).toEqual(['lodestone~3aa']);
    expect(await store.get('lodestone:a')).toEqual({ n: 1 });
    t += 600;
    expect(await store.get('lodestone:a')).toBeNull();
    data.set('lodestone~3araw', { old: true });
    expect(await store.get('lodestone:raw')).toEqual({ old: true });
  });
  it('cloudflareKvStore stores JSON and turns the lifetime into seconds, never under KV\'s 60', async () => {
    const puts: { k: string; v: string; o?: { expirationTtl?: number } }[] = [];
    const kv = { get: async (k: string) => { const p = puts.find((x) => x.k === k); return p ? JSON.parse(p.v) : null; }, put: async (k: string, v: string, o?: { expirationTtl?: number }) => { puts.push({ k, v, o }); } };
    const store = cloudflareKvStore(kv);
    await store.set('a:b', [1], { ttlMs: 5_000 });
    await store.set('c', 2, { ttlMs: 3_600_000 });
    expect(puts.map((p) => p.o?.expirationTtl)).toEqual([60, 3600]);
    expect(await store.get('a:b')).toEqual([1]);
    expect(await store.get('missing')).toBeNull();
  });
  it('upstashStore speaks the REST API, counts atomically, and does not echo a failure body', async () => {
    const calls: { url: string; body: unknown; auth: string | null }[] = [];
    const redis = new Map<string, string>();
    const fake = (async (url: URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); calls.push({ url: String(url), body, auth: new Headers(init.headers).get('authorization') });
      if (String(url).endsWith('/pipeline')) { const k = body[0][1] as string; const n = Number(redis.get(k) ?? 0) + body[0][2]; redis.set(k, String(n)); return Response.json([{ result: n }, { result: 1 }]); }
      const [cmd, k, v] = body as string[];
      if (cmd === 'SET') { redis.set(k, v); return Response.json({ result: 'OK' }); }
      if (cmd === 'GET') return Response.json({ result: redis.get(k) ?? null });
      return new Response('secret detail', { status: 500 });
    }) as unknown as typeof fetch;
    const store = upstashStore({ url: 'https://eu1.upstash.io', token: 'tok', fetch: fake });
    await store.set('k', { a: 1 }, { ttlMs: 1500 });
    expect(await store.get('k')).toEqual({ a: 1 });
    expect(calls[0].body).toEqual(['SET', 'lodestone:k', '{"a":1}', 'PX', '1500']);
    expect(calls[0].auth).toBe('Bearer tok');
    expect(await store.incrBy('c', 1, { ttlMs: 1000 })).toBe(1);
    expect(await store.incrBy('c', 1, { ttlMs: 1000 })).toBe(2);
    const bad = upstashStore({ url: 'https://eu1.upstash.io', token: 't', fetch: (async () => new Response('secret detail', { status: 500 })) as typeof fetch });
    await expect(bad.get('k')).rejects.toThrow(/^upstash: 500$/);
    expect(() => upstashStore({ url: 'http://insecure.example', token: 't' })).toThrow(/https/);
  });
  it('a rate limiter on upstash counts exactly across calls', async () => {
    const redis = new Map<string, number>();
    const fake = (async (_u: URL, init: RequestInit) => { const b = JSON.parse(String(init.body)); const k = b[0][1]; const n = (redis.get(k) ?? 0) + b[0][2]; redis.set(k, n); return Response.json([{ result: n }, { result: 1 }]); }) as unknown as typeof fetch;
    const rl = createRateLimiter({ store: upstashStore({ url: 'https://x.upstash.io', token: 't', fetch: fake }), max: 3 });
    const results = await Promise.all(Array.from({ length: 8 }, () => rl.take('u')));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
  });
  it('denoKvStore uses a key path and an expiry', async () => {
    const seen: unknown[] = []; const data = new Map<string, unknown>();
    const kv = { get: async (k: unknown[]) => ({ value: data.get(k.join('/')) ?? null }), set: async (k: unknown[], v: unknown, o?: { expireIn?: number }) => { seen.push([k, o]); data.set(k.join('/'), v); } };
    const store = denoKvStore(kv);
    await store.set('a', 1, { ttlMs: 900 });
    expect(seen).toEqual([[['lodestone', 'a'], { expireIn: 900 }]]);
    expect(await store.get('a')).toBe(1);
  });
});
