import { describe, expect, it } from 'vitest';
import { ProviderError } from './errors.js';
import { LodestoneError } from './errors.js';
import { createLodestone, type AttemptEvent } from './lodestone.js';
import { mock } from './providers/mock.js';
import { memoryStore } from './store.js';
import type { CatalogModel } from './catalog.js';
import type { ProviderRequest } from './types.js';

const FREE = ['free-a:free', 'free-b:free', 'openrouter/free'];
const models = { fast: FREE, strong: FREE, vision: FREE };
const fail = (status: number, body = '') => { throw new ProviderError(status, body); };
const quick = { minSliceMs: 5, freeSliceMs: 100, freeSliceWithLaterMs: 100, freePhaseWithLaterMs: 400 };

/** A fetch that only answers the catalogue request. */
const catalogFetch = (list: CatalogModel[]) => (async () => new Response(JSON.stringify({ data: list }))) as typeof fetch;

describe('complete: the free models', () => {
  it('answers from the first model when it works', async () => {
    const or = mock('hello');
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: or, models } });
    const r = await ai.complete({ prompt: 'hi' });
    expect(r).toMatchObject({ text: 'hello', provider: 'mock', model: 'free-a:free' });
    expect(or.calls).toHaveLength(1);
  });
  it('moves to the next model when one fails or is empty', async () => {
    const or = mock((req) => (req.model === 'free-a:free' ? fail(503) : req.model === 'free-b:free' ? '  ' : 'third'));
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: or, models } });
    expect((await ai.complete({ prompt: 'hi' })).model).toBe('openrouter/free');
    expect(or.calls.map((c) => c.model)).toEqual(FREE);
  });
  it('stops at a 401, because no other model on that key will differ', async () => {
    const or = mock(() => fail(401));
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: or, models } });
    await expect(ai.complete({ prompt: 'hi' })).rejects.toMatchObject({ kind: 'auth' });
    expect(or.calls).toHaveLength(1);
  });
  it('sends the system prompt, temperature and token limit through', async () => {
    const or = mock();
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: or, models } });
    await ai.complete({ prompt: 'hi', system: 'be brief', maxTokens: 50, temperature: 0.7 });
    expect(or.calls[0]).toMatchObject({ system: 'be brief', maxTokens: 50, temperature: 0.7, apiKey: 'k' });
  });
  it('a model that is too slow is cut off and the next one used', async () => {
    const or = mock((req: ProviderRequest) => req.model === 'free-a:free'
      ? new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(Object.assign(new Error('t'), { name: 'TimeoutError' }))))
      : 'fast enough');
    const events: AttemptEvent[] = [];
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: or, models }, budgetMs: 2000, timing: { ...quick, freeSliceMs: 50 }, onAttempt: (e) => events.push(e) });
    expect((await ai.complete({ prompt: 'hi' })).model).toBe('free-b:free');
    expect(events.map((e) => e.outcome)).toEqual(['timeout', 'ok']);
  });
  it('says the AI is slow when every attempt times out', async () => {
    const or = mock((req: ProviderRequest) => new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(Object.assign(new Error('t'), { name: 'TimeoutError' })))));
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: or, models }, budgetMs: 300, timing: { ...quick, freeSliceMs: 40 } });
    await expect(ai.complete({ prompt: 'hi' })).rejects.toMatchObject({ kind: 'slow' });
  });
});

describe('complete: failures are classified', () => {
  const only = (status: number, body = '') => createLodestone({ openrouter: { apiKey: 'k', provider: mock(() => fail(status, body)), models } });
  it('429 keeps its reading so the right advice can be given', async () => {
    const err = await only(429, JSON.stringify({ error: { message: 'Rate limit exceeded: free-models-per-day' } })).complete({ prompt: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(LodestoneError);
    expect(err).toMatchObject({ kind: 'rate_limit', detail: { rateLimit: { kind: 'daily' } } });
  });
  it('404 means withdrawn, 5xx means the provider is having issues', async () => {
    await expect(only(404).complete({ prompt: 'x' })).rejects.toMatchObject({ kind: 'withdrawn' });
    await expect(only(502).complete({ prompt: 'x' })).rejects.toMatchObject({ kind: 'unavailable' });
  });
  it('a 429 is reported even when a later model failed differently', async () => {
    const or = mock((req) => (req.model === 'free-a:free' ? fail(429, 'upstream') : fail(503)));
    const err = await createLodestone({ openrouter: { apiKey: 'k', provider: or, models } }).complete({ prompt: 'x' }).catch((e) => e);
    expect(err.kind).toBe('rate_limit');
  });
  it('says not_configured when there is no key at all', async () => {
    await expect(createLodestone().complete({ prompt: 'x' })).rejects.toMatchObject({ kind: 'not_configured' });
  });
});

describe('complete: paid fallback and bring-your-own-key', () => {
  const paid = ['paid-a'];
  const freeDown = (req: ProviderRequest) => (req.model.startsWith('paid') ? 'paid answer' : fail(429, 'upstream'));

  it('does not spend on the platform key unless allowed', async () => {
    const or = mock(freeDown);
    const ai = createLodestone({ openrouter: { apiKey: 'platform', provider: or, models, paidModels: paid } });
    await expect(ai.complete({ prompt: 'x' })).rejects.toMatchObject({ kind: 'rate_limit' });
    expect(or.calls.some((c) => c.model === 'paid-a')).toBe(false);
  });
  it('uses the paid model on the platform key when allowPaid is set', async () => {
    const ai = createLodestone({ openrouter: { apiKey: 'platform', provider: mock(freeDown), models, paidModels: paid, allowPaid: true }, timing: quick });
    expect((await ai.complete({ prompt: 'x' })).model).toBe('paid-a');
  });
  it("a caller's own key replaces the platform key and allows the paid fallback", async () => {
    const or = mock(freeDown);
    const ai = createLodestone({ openrouter: { apiKey: 'platform', provider: or, models, paidModels: paid }, timing: quick });
    const r = await ai.complete({ prompt: 'x', apiKey: 'theirs' });
    expect(r.model).toBe('paid-a');
    expect(new Set(or.calls.map((c) => c.apiKey))).toEqual(new Set(['theirs']));
  });
  it('flags a missing-credit refusal (402) so the message can say what to do', async () => {
    const or = mock((req) => (req.model === 'paid-a' ? fail(402) : fail(429, 'upstream')));
    const err = await createLodestone({ openrouter: { apiKey: 'k', provider: or, models, paidModels: paid, allowPaid: true }, timing: quick }).complete({ prompt: 'x' }).catch((e) => e);
    expect(err).toMatchObject({ kind: 'rate_limit', detail: { needsCredit: true } });
  });
  it('gives the free models a short turn when a later phase exists, so there is time for it', async () => {
    const or = mock((req: ProviderRequest) => req.model.startsWith('paid') ? 'paid answer' : new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(Object.assign(new Error('t'), { name: 'TimeoutError' })))));
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: or, models, paidModels: paid, allowPaid: true }, budgetMs: 1500, timing: { minSliceMs: 5, freeSliceMs: 5000, freeSliceWithLaterMs: 60, freePhaseWithLaterMs: 250 } });
    const started = Date.now();
    expect((await ai.complete({ prompt: 'x' })).model).toBe('paid-a');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('complete: other providers as a fallback', () => {
  it('uses a second provider, with its own key, when OpenRouter is down', async () => {
    const claude = mock('from claude');
    const ai = createLodestone({
      openrouter: { apiKey: 'or', provider: mock(() => fail(503)), models },
      fallbacks: [{ provider: claude, apiKey: 'anthropic-key', models: ['claude-x'] }],
      timing: quick,
    });
    const r = await ai.complete({ prompt: 'x' });
    expect(r).toMatchObject({ text: 'from claude', model: 'claude-x' });
    expect(claude.calls[0].apiKey).toBe('anthropic-key');
  });
  it('works with no OpenRouter key at all', async () => {
    const ai = createLodestone({ fallbacks: [{ provider: mock('only claude'), apiKey: 'k', models: ['m'] }] });
    expect((await ai.complete({ prompt: 'x' })).text).toBe('only claude');
  });
  it('skips a provider that cannot read images when the request has one', async () => {
    const blind = { ...mock('blind'), vision: false };
    const sighted = mock('sees it');
    const ai = createLodestone({ fallbacks: [{ provider: blind, apiKey: 'k', models: ['b'] }, { provider: sighted, apiKey: 'k', models: ['s'] }] });
    const r = await ai.complete({ messages: [{ role: 'user', content: [{ type: 'text', text: 'read' }, { type: 'image', dataUrl: 'data:image/png;base64,AAAA' }] }] });
    expect(r.text).toBe('sees it');
  });
  it('a wrong key on one provider does not stop the next', async () => {
    const ai = createLodestone({ fallbacks: [{ provider: mock(() => fail(401)), apiKey: 'bad', models: ['a', 'b'] }, { provider: mock('ok'), apiKey: 'k', models: ['c'] }] });
    expect((await ai.complete({ prompt: 'x' })).text).toBe('ok');
  });
});

describe('complete: tasks and tiers', () => {
  it('uses the tier from a task profile, and its limits', async () => {
    const or = mock();
    const ai = createLodestone({
      openrouter: { apiKey: 'k', provider: or, models: { fast: ['quick:free'], strong: ['smart:free'], vision: ['eyes:free'] } },
      profiles: { write: { tier: 'strong', maxTokens: 900, temperature: 0.5 } },
    });
    await ai.complete({ task: 'write', prompt: 'x' });
    expect(or.calls[0]).toMatchObject({ model: 'smart:free', maxTokens: 900, temperature: 0.5 });
  });
  it('picks the vision tier by itself when the request has an image', async () => {
    const or = mock();
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: or, models: { fast: ['quick:free'], strong: ['smart:free'], vision: ['eyes:free'] } } });
    await ai.complete({ messages: [{ role: 'user', content: [{ type: 'image', dataUrl: 'data:image/png;base64,AAAA' }] }] });
    expect(or.calls[0].model).toBe('eyes:free');
  });
  it('rejects an unknown task and an empty request', async () => {
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: mock() } });
    await expect(ai.complete({ task: 'nope', prompt: 'x' })).rejects.toThrow('Unknown task');
    await expect(ai.complete({})).rejects.toThrow('needs a prompt');
  });
});

describe('withdrawn models heal themselves', () => {
  const m = (id: string): CatalogModel => ({ id, context_length: 262144, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, pricing: { prompt: '0', completion: '0' } });

  it('asks for current models once the catalogue says the preferred one is gone', async () => {
    const or = mock();
    const ai = createLodestone({
      openrouter: { apiKey: 'k', provider: or, models: { fast: ['gone-1:free', 'gone-2:free', 'openrouter/free'] } },
      fetch: catalogFetch([m('google/newer-lightning:free'), m('google/another-mini:free')]),
    });
    await ai.refreshCatalog();
    await ai.complete({ prompt: 'x' });
    expect(or.calls[0].model).not.toContain('gone');
    expect(['google/newer-lightning:free', 'google/another-mini:free']).toContain(or.calls[0].model);
  });
  it('uses the preferences as given before any catalogue exists', async () => {
    const or = mock();
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: or, models } });
    await ai.complete({ prompt: 'x' });
    expect(or.calls[0].model).toBe('free-a:free');
  });
  it('checkModels reports what was withdrawn and whether a tier is short of models', async () => {
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: mock(), models: { fast: ['google/here:free', 'gone:free', 'openrouter/free'] }, paidModels: [] }, fetch: catalogFetch([m('google/here:free'), m('google/spare:free')]) });
    const r = await ai.checkModels();
    expect(r.withdrawn).toContain('gone:free');
    expect(r.shortTiers).toEqual(['vision']); // text and strong can use both models; neither takes images
    expect(r.ok).toBe(false);
  });
  it('checkModels fails clearly when the catalogue cannot be read', async () => {
    const ai = createLodestone({ fetch: (async () => new Response('', { status: 500 })) as typeof fetch });
    expect(await ai.checkModels()).toMatchObject({ ok: false, error: expect.stringContaining('catalogue') });
  });
});

describe('json', () => {
  const ai = (replies: string[]) => {
    let i = 0;
    return createLodestone({ openrouter: { apiKey: 'k', provider: mock(() => replies[i++] ?? '{}'), models } });
  };
  it('strips code fences and parses', async () => {
    const r = await ai(['```json\n{"a":1}\n```']).json<{ a: number }>({ prompt: 'x' });
    expect(r.data).toEqual({ a: 1 });
  });
  it('treats an unparseable answer as a failed attempt and tries the next model', async () => {
    const r = await ai(['sorry, here you go', '{"a":2}']).json<{ a: number }>({ prompt: 'x' });
    expect(r.data).toEqual({ a: 2 });
    expect(r.model).toBe('free-b:free');
  });
  it('treats an answer that fails validation the same way', async () => {
    const isA = (v: unknown): v is { a: number } => typeof (v as { a?: unknown })?.a === 'number';
    const r = await ai(['{"b":1}', '{"a":3}']).json({ prompt: 'x', validate: isA });
    expect(r.data.a).toBe(3);
  });
  it('accepts any schema with safeParse, skips answers it rejects, and returns what it parses', async () => {
    const schema = { safeParse: (v: unknown) => (typeof (v as { n?: unknown })?.n === 'string' ? { success: true as const, data: { n: Number((v as { n: string }).n) } } : { success: false as const }) };
    const r = await ai(['{"n":5}', '{"n":"7"}']).json({ prompt: 'x', schema });
    expect(r.data).toEqual({ n: 7 });
    expect(r.model).toBe('free-b:free');
  });
  it('gives bad_output when no model produces usable JSON', async () => {
    await expect(ai(['no', 'no', 'no']).json({ prompt: 'x' })).rejects.toMatchObject({ kind: 'bad_output' });
  });
});

describe('cache', () => {
  it('returns the saved answer for the same key without calling a model', async () => {
    const or = mock('first');
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: or, models }, store: memoryStore() });
    await ai.complete({ prompt: 'x', cacheKey: 'job:1' });
    const again = await ai.complete({ prompt: 'x', cacheKey: 'job:1' });
    expect(again).toMatchObject({ text: 'first', cached: true });
    expect(or.calls).toHaveLength(1);
  });
  it('does not reuse an answer past its lifetime, and never caches a failure', async () => {
    let t = 1_000;
    const or = mock((_: ProviderRequest) => 'fresh');
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: or, models }, now: () => t });
    await ai.complete({ prompt: 'x', cacheKey: 'k1', cacheTtlMs: 100 });
    t += 500;
    await ai.complete({ prompt: 'x', cacheKey: 'k1', cacheTtlMs: 100 });
    expect(or.calls).toHaveLength(2);

    const bad = createLodestone({ openrouter: { apiKey: 'k', provider: mock(() => fail(503)), models } });
    await bad.complete({ prompt: 'x', cacheKey: 'f' }).catch(() => {});
    const good = mock('now fine');
    const ai2 = createLodestone({ openrouter: { apiKey: 'k', provider: good, models }, store: memoryStore() });
    expect((await ai2.complete({ prompt: 'x', cacheKey: 'f' })).cached).toBeUndefined();
  });
});

describe('route: an explicit provider and model', () => {
  const route = (...steps: { provider: string; model: string; apiKey: string }[]) => steps;

  it('calls exactly the named provider and model with its key, and leaves temperature to the provider', async () => {
    const a = mock('from a');
    const ai = createLodestone({ providers: { a } });
    const r = await ai.complete({ prompt: 'x', system: 'sys', maxTokens: 900, route: route({ provider: 'a', model: 'm1', apiKey: 'key-a' }) });
    expect(r).toMatchObject({ text: 'from a', provider: 'mock', model: 'm1' });
    expect(a.calls[0]).toMatchObject({ model: 'm1', apiKey: 'key-a', system: 'sys', maxTokens: 900 });
    expect(a.calls[0].temperature).toBeUndefined();
  });
  it('uses a temperature when one is given', async () => {
    const a = mock();
    await createLodestone({ providers: { a } }).complete({ prompt: 'x', temperature: 0.4, route: route({ provider: 'a', model: 'm', apiKey: 'k' }) });
    expect(a.calls[0].temperature).toBe(0.4);
  });
  it('moves to the next step when one fails, and never touches the tier lists or the catalogue', async () => {
    const a = mock(() => fail(503));
    const b = mock('from b');
    let catalogCalls = 0;
    const ai = createLodestone({ providers: { a, b }, fetch: (async () => { catalogCalls++; return new Response('{}'); }) as typeof fetch });
    const r = await ai.complete({ prompt: 'x', route: route({ provider: 'a', model: 'm1', apiKey: 'ka' }, { provider: 'b', model: 'm2', apiKey: 'kb' }) });
    expect(r.text).toBe('from b');
    expect(catalogCalls).toBe(0);
  });
  it('skips a step with no key, so a missing fallback key is not an error', async () => {
    const a = mock('only a');
    const b = mock('b');
    const r = await createLodestone({ providers: { a, b } }).complete({ prompt: 'x', route: route({ provider: 'a', model: 'm', apiKey: 'ka' }, { provider: 'b', model: 'm', apiKey: '' }) });
    expect(r.text).toBe('only a');
    expect(b.calls).toHaveLength(0);
  });
  it('reports why the first step failed, and passes on the provider\'s own message', async () => {
    const a = mock(() => fail(400, JSON.stringify({ error: { message: 'max_tokens too large' } })));
    const b = mock(() => fail(503));
    const err = await createLodestone({ providers: { a, b } }).complete({ prompt: 'x', route: route({ provider: 'a', model: 'm', apiKey: 'ka' }, { provider: 'b', model: 'm', apiKey: 'kb' }) }).catch((e) => e);
    expect(err).toMatchObject({ kind: 'other', detail: { status: 400, providerMessage: 'max_tokens too large' } });
  });
  it('says the AI is slow when the route timed out, and not_configured when no step has a key', async () => {
    const slow = mock((req: ProviderRequest) => new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(Object.assign(new Error('t'), { name: 'TimeoutError' })))));
    await expect(createLodestone({ providers: { slow }, budgetMs: 100 }).complete({ prompt: 'x', route: route({ provider: 'slow', model: 'm', apiKey: 'k' }) })).rejects.toMatchObject({ kind: 'slow' });
    await expect(createLodestone({ providers: { a: mock() } }).complete({ prompt: 'x', route: route({ provider: 'a', model: 'm', apiKey: '' }) })).rejects.toMatchObject({ kind: 'not_configured' });
  });
  it('rejects a route that names a provider that is not registered', async () => {
    await expect(createLodestone().complete({ prompt: 'x', route: route({ provider: 'nope', model: 'm', apiKey: 'k' }) })).rejects.toThrow('Unknown provider "nope"');
  });
  it('has openrouter, anthropic and google ready without being registered', async () => {
    const seen: string[] = [];
    const ai = createLodestone({ fetch: (async (url: string | URL | Request) => { seen.push(String(url)); return new Response('{}', { status: 500 }); }) as typeof fetch });
    for (const provider of ['openrouter', 'anthropic', 'google']) await ai.complete({ prompt: 'x', route: route({ provider, model: 'm', apiKey: 'k' }) }).catch(() => {});
    expect(seen.map((u) => new URL(u).hostname)).toEqual(['openrouter.ai', 'api.anthropic.com', 'generativelanguage.googleapis.com']);
  });
  it('lets one provider be replaced, for example OpenRouter without low reasoning', async () => {
    const sent: unknown[] = [];
    const { openrouter } = await import('./providers/openrouter.js');
    const f = (async (_u: unknown, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] })); }) as typeof fetch;
    await createLodestone({ providers: { openrouter: openrouter({ fetch: f, lowReasoning: false }) } }).complete({ prompt: 'x', route: route({ provider: 'openrouter', model: 'anthropic/claude-x', apiKey: 'k' }) });
    expect(sent[0]).not.toHaveProperty('reasoning');
    expect(sent[0]).not.toHaveProperty('temperature');
  });
});

describe('quality-aware ordering', () => {
  const NOW = Date.parse('2026-10-28T12:00:00Z');
  const score = (model: string, value: number) => ({ model, task: 'translate', metric: 'chrf++', value, higherIsBetter: true, n: 100, measuredAt: '2026-10-08', language: 'yo' });
  const card = { schema: 'model-scorecard/1' as const, source: 'naija-eval', generatedAt: '2026-10-28', scores: [score('free-a', 20), score('free-b', 55)] };
  const quality = { task: 'translate', metric: 'chrf++', language: 'yo' };
  const list = { fast: ['free-a:free', 'free-b:free', 'openrouter/free'], strong: ['free-a:free', 'free-b:free', 'openrouter/free'], vision: ['free-a:free', 'free-b:free', 'openrouter/free'] };

  it('tries the model the scorecard measured best first', async () => {
    const or = mock();
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: or, models: list }, scorecards: [card], now: () => NOW });
    await ai.complete({ prompt: 'x', quality });
    expect(or.calls[0].model).toBe('free-b:free');
  });
  it('uses the quality query from a task profile', async () => {
    const or = mock();
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: or, models: list }, scorecards: [card], now: () => NOW, profiles: { 'translate-yo': { tier: 'strong', quality } } });
    await ai.complete({ task: 'translate-yo', prompt: 'x' });
    expect(or.calls[0].model).toBe('free-b:free');
  });
  it('leaves the order alone with no query, and with a query nobody measured', async () => {
    const or = mock();
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: or, models: list }, scorecards: [card], now: () => NOW });
    await ai.complete({ prompt: 'x' });
    await ai.complete({ prompt: 'x', quality: { ...quality, language: 'ig' } });
    expect(or.calls.map((c) => c.model)).toEqual(['free-a:free', 'free-a:free']);
  });
  it('orders the paid and fallback models too', async () => {
    const down = (req: ProviderRequest) => (req.model.startsWith('paid') || req.model.startsWith('fb') ? 'ok' : fail(503));
    const or = mock(down);
    const fb = mock('ok');
    const cards = [{ ...card, scores: [score('paid-1', 10), score('paid-2', 70), score('fb-1', 10), score('fb-2', 70)] }];
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: or, models: list, paidModels: ['paid-1', 'paid-2'], allowPaid: true }, fallbacks: [{ provider: fb, apiKey: 'k', models: ['fb-1', 'fb-2'] }], scorecards: cards, now: () => NOW, timing: quick });
    expect((await ai.complete({ prompt: 'x', quality })).model).toBe('paid-2');
    const ai2 = createLodestone({ openrouter: { apiKey: 'k', provider: mock(() => fail(503)), models: list }, fallbacks: [{ provider: fb, apiKey: 'k', models: ['fb-1', 'fb-2'] }], scorecards: cards, now: () => NOW, timing: quick });
    expect((await ai2.complete({ prompt: 'x', quality })).model).toBe('fb-2');
  });
  it('fetches scorecards per request when given a function, and ignores one that fails or is slow', async () => {
    const or = mock();
    let calls = 0;
    const ok = createLodestone({ openrouter: { apiKey: 'k', provider: or, models: list }, scorecards: async () => { calls++; return [card]; }, now: () => NOW });
    await ok.complete({ prompt: 'x', quality });
    expect([calls, or.calls[0].model]).toEqual([1, 'free-b:free']);

    const broken = mock();
    await createLodestone({ openrouter: { apiKey: 'k', provider: broken, models: list }, scorecards: async () => { throw new Error('down'); } }).complete({ prompt: 'x', quality });
    expect(broken.calls[0].model).toBe('free-a:free');
  });
  it('does not reorder a route, which is exactly what the caller asked for', async () => {
    const a = mock(() => fail(503)); const b = mock('b');
    const cards = [{ ...card, scores: [score('m1', 10), score('m2', 90)] }];
    const ai = createLodestone({ providers: { a, b }, scorecards: cards, now: () => NOW });
    await ai.complete({ prompt: 'x', quality, route: [{ provider: 'a', model: 'm1', apiKey: 'k' }, { provider: 'b', model: 'm2', apiKey: 'k' }] });
    expect(a.calls[0].model).toBe('m1');
  });
});

describe('stats and candidates', () => {
  it('records every attempt, so live results can be published as a scorecard', async () => {
    const { createStats } = await import('./stats.js');
    const stats = createStats();
    const or = mock((req: ProviderRequest) => (req.model === 'free-a:free' ? fail(503) : 'ok'));
    await createLodestone({ openrouter: { apiKey: 'k', provider: or, models }, stats }).complete({ prompt: 'x' });
    const rates = stats.scorecard().scores.filter((s) => s.metric === 'success_rate').map((s) => [s.model, s.value]);
    expect(rates).toEqual([['free-a:free', 0], ['free-b:free', 100]]);
  });
  it('lists every model it could call, with where each is used, for an evaluator to benchmark', async () => {
    const ai = createLodestone({
      openrouter: { apiKey: 'k', provider: mock(), models: { fast: ['f1:free', 'shared:free', 'openrouter/free'], strong: ['s1:free', 'shared:free', 'openrouter/free'], vision: ['v1:free', 'openrouter/free'] }, paidModels: ['p1'] },
      fallbacks: [{ provider: { ...mock(), name: 'anthropic' }, apiKey: 'k', models: ['claude-x'] }],
    });
    const c = await ai.candidates();
    expect(c.schema).toBe('model-candidates/1');
    const by = Object.fromEntries(c.models.map((m) => [m.id, m]));
    expect(by['shared:free'].roles).toEqual(['free:fast', 'free:strong']);
    expect(by['p1']).toMatchObject({ provider: 'openrouter', roles: ['paid'] });
    expect(by['claude-x']).toMatchObject({ provider: 'anthropic', roles: ['fallback'] });
    expect(by).not.toHaveProperty('openrouter/free');
  });
});

describe("a caller's own key", () => {
  it("never leads to the platform's fallback providers", async () => {
    const platform = mock('spent the platform\'s money');
    const ai = createLodestone({
      openrouter: { apiKey: 'platform', provider: mock(() => fail(503)), models },
      fallbacks: [{ provider: platform, apiKey: 'platform-anthropic-key', models: ['claude-x'] }],
      timing: quick,
    });
    await expect(ai.complete({ prompt: 'x', apiKey: 'theirs' })).rejects.toMatchObject({ kind: 'unavailable' });
    expect(platform.calls).toHaveLength(0);
    // The same request on the platform's own key does use the fallback.
    expect((await ai.complete({ prompt: 'x' })).text).toBe('spent the platform\'s money');
  });
  it('can be allowed per fallback, for a fallback that is not the platform\'s money', async () => {
    const free = mock('ok');
    const ai = createLodestone({ openrouter: { apiKey: 'p', provider: mock(() => fail(503)), models }, fallbacks: [{ provider: free, apiKey: 'k', models: ['m'], allowWithCallerKey: true }], timing: quick });
    expect((await ai.complete({ prompt: 'x', apiKey: 'theirs' })).text).toBe('ok');
  });
  it("a rejected key is not counted against the model in live stats", async () => {
    const { createStats } = await import('./stats.js');
    const stats = createStats();
    const ai = createLodestone({ openrouter: { apiKey: 'p', provider: mock(() => fail(401)), models }, stats });
    await ai.complete({ prompt: 'x', apiKey: 'bad' }).catch(() => {});
    expect(stats.scorecard().scores).toEqual([]);
    const busy = createLodestone({ openrouter: { apiKey: 'p', provider: mock(() => fail(503)), models: { fast: ['only:free'], strong: ['only:free'], vision: ['only:free'] } }, stats });
    await busy.complete({ prompt: 'x' }).catch(() => {});
    expect(stats.scorecard().scores.find((s) => s.metric === 'success_rate')?.value).toBe(0); // a busy model still counts
  });
});

describe('circuit breaker', () => {
  const MIN = 60_000;
  const brokenFree = (req: ProviderRequest) => (req.model.startsWith('free') ? fail(503) : 'answer');

  it('skips a model that keeps failing, so the next request does not wait on it', async () => {
    const { createHealth } = await import('./health.js');
    const health = createHealth();
    const or = mock((req: ProviderRequest) => (req.model === 'free-a:free' ? fail(503) : 'ok'));
    const events: AttemptEvent[] = [];
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: or, models }, health, onAttempt: (e) => events.push(e) });
    for (let i = 0; i < 3; i++) await ai.complete({ prompt: 'x' });                // free-a fails three times, free-b answers
    or.calls.length = 0; events.length = 0;
    expect((await ai.complete({ prompt: 'x' })).model).toBe('free-b:free');
    expect(or.calls.map((c) => c.model)).toEqual(['free-b:free']);                   // free-a was not even tried
    expect(events.find((e) => e.model === 'free-a:free')).toMatchObject({ outcome: 'skipped', ms: 0 });
  });
  it('goes straight to a paid model when every free model is down', async () => {
    const { createHealth } = await import('./health.js');
    const health = createHealth();
    const or = mock((req: ProviderRequest) => (req.model.startsWith('free') ? fail(503) : req.model === 'openrouter/free' ? fail(503) : 'paid ok'));
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: or, models, paidModels: ['paid-1'], allowPaid: true }, health, timing: quick });
    for (let i = 0; i < 3; i++) await ai.complete({ prompt: 'x' });
    or.calls.length = 0;
    expect((await ai.complete({ prompt: 'x' })).model).toBe('paid-1');
    expect(or.calls.map((c) => c.model)).toEqual(['paid-1']);
  });
  it('still tries the free models when nothing else could answer, even if they look down', async () => {
    const { createHealth } = await import('./health.js');
    const health = createHealth();
    let healed = false;
    const or = mock(() => (healed ? 'back' : fail(503)));
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: or, models }, health });
    for (let i = 0; i < 3; i++) await ai.complete({ prompt: 'x' }).catch(() => {});
    healed = true;
    expect((await ai.complete({ prompt: 'x' })).text).toBe('back');
  });
  it('probes a skipped model again after a while, and uses it once it answers', async () => {
    const { createHealth } = await import('./health.js');
    const clock = { t: Date.parse('2026-10-28T12:00:00Z') };
    const health = createHealth({ now: () => clock.t });
    let aUp = false;
    const or = mock((req: ProviderRequest) => (req.model === 'free-a:free' && !aUp ? fail(503) : 'ok'));
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: or, models }, health });
    for (let i = 0; i < 3; i++) await ai.complete({ prompt: 'x' });
    expect((await ai.complete({ prompt: 'x' })).model).toBe('free-b:free');
    clock.t += 2 * MIN; aUp = true;
    expect((await ai.complete({ prompt: 'x' })).model).toBe('free-a:free');
  });
  it("does not blame a model for a rejected key or missing credit", async () => {
    const { createHealth } = await import('./health.js');
    const health = createHealth();
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: mock(() => fail(401)), models }, health });
    for (let i = 0; i < 4; i++) await ai.complete({ prompt: 'x' }).catch(() => {});
    expect(await health.snapshot()).toEqual([]);
  });
  it('does not count skipped attempts in live stats', async () => {
    const { createHealth } = await import('./health.js');
    const { createStats } = await import('./stats.js');
    const health = createHealth(); const stats = createStats();
    const or = mock((req: ProviderRequest) => (req.model === 'free-a:free' ? fail(503) : 'ok'));
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: or, models }, health, stats });
    for (let i = 0; i < 5; i++) await ai.complete({ prompt: 'x' });
    expect(stats.scorecard().scores.find((s) => s.model === 'free-a:free' && s.metric === 'success_rate')?.n).toBe(3);
  });
});

describe('spend control', () => {
  const paidOnly = (req: ProviderRequest) => (req.model.startsWith('paid') ? { text: 'ok', usage: { inputTokens: 1000, outputTokens: 200, costUsd: 0.0004 } } : fail(503));
  const setup = (spend: Parameters<typeof createLodestone>[0] extends infer C ? C extends { spend?: infer S } ? S : never : never, extra = {}) =>
    createLodestone({ openrouter: { apiKey: 'platform', provider: mock(paidOnly), models, paidModels: ['paid-1'], allowPaid: true }, spend, timing: quick, ...extra });

  it('asks before spending the platform\'s money, and records what the call cost', async () => {
    const seen: unknown[] = [];
    const ai = setup({ allow: () => true, record: (i) => { seen.push(i); } });
    expect((await ai.complete({ prompt: 'x' })).model).toBe('paid-1');
    expect(seen).toEqual([{ provider: 'mock', model: 'paid-1', phase: 'paid', usage: { inputTokens: 1000, outputTokens: 200, costUsd: 0.0004 }, costUsd: 0.0004 }]);
  });
  it('does not use a paid model once the limit is reached, and says it is the budget', async () => {
    const or = mock(paidOnly);
    const ai = createLodestone({ openrouter: { apiKey: 'platform', provider: or, models, paidModels: ['paid-1'], allowPaid: true }, spend: { allow: () => false, record: () => {} }, timing: quick });
    await expect(ai.complete({ prompt: 'x' })).rejects.toMatchObject({ kind: 'budget' });
    expect(or.calls.some((c) => c.model === 'paid-1')).toBe(false);
  });
  it('never counts or limits the free models', async () => {
    let asked = 0; let recorded = 0;
    const ai = createLodestone({ openrouter: { apiKey: 'platform', provider: mock('free answer'), models, paidModels: ['paid-1'], allowPaid: true }, spend: { allow: () => { asked++; return false; }, record: () => { recorded++; } } });
    expect((await ai.complete({ prompt: 'x' })).text).toBe('free answer');
    expect([asked, recorded]).toEqual([0, 0]);
  });
  it("never counts or limits a caller's own key, which is their money", async () => {
    let asked = 0; let recorded = 0;
    const ai = createLodestone({ openrouter: { apiKey: 'platform', provider: mock(paidOnly), models, paidModels: ['paid-1'] }, spend: { allow: () => { asked++; return false; }, record: () => { recorded++; } }, timing: quick });
    expect((await ai.complete({ prompt: 'x', apiKey: 'theirs' })).model).toBe('paid-1');
    expect([asked, recorded]).toEqual([0, 0]);
  });
  it("estimates the cost from the catalogue's price when the provider does not report one", async () => {
    const seen: number[] = [];
    const or = mock((req: ProviderRequest) => (req.model.startsWith('paid') ? { text: 'ok', usage: { inputTokens: 1000, outputTokens: 500 } } : fail(503)));
    const priced = (async () => new Response(JSON.stringify({ data: [{ id: 'paid-1', context_length: 100000, pricing: { prompt: '0.000001', completion: '0.000004' } }] }))) as typeof fetch;
    const ai = createLodestone({ openrouter: { apiKey: 'platform', provider: or, models, paidModels: ['paid-1'], allowPaid: true }, spend: { allow: () => true, record: (i) => { seen.push(i.costUsd as number); } }, fetch: priced, timing: quick });
    await ai.refreshCatalog();
    await ai.complete({ prompt: 'x' });
    expect(seen[0]).toBeCloseTo(1000 * 0.000001 + 500 * 0.000004, 10); // $0.003
  });
  it('counts and limits a fallback provider on the platform\'s key', async () => {
    const seen: string[] = [];
    const fb = mock('from fallback');
    const ai = createLodestone({ openrouter: { apiKey: 'p', provider: mock(() => fail(503)), models }, fallbacks: [{ provider: fb, apiKey: 'k', models: ['claude-x'] }], spend: { allow: () => true, record: (i) => { seen.push(i.phase); } }, timing: quick });
    await ai.complete({ prompt: 'x' });
    expect(seen).toEqual(['fallback']);
    const blocked = createLodestone({ openrouter: { apiKey: 'p', provider: mock(() => fail(503)), models }, fallbacks: [{ provider: mock('x'), apiKey: 'k', models: ['claude-x'] }], spend: { allow: () => false, record: () => {} }, timing: quick });
    await expect(blocked.complete({ prompt: 'x' })).rejects.toMatchObject({ kind: 'budget' });
  });
  it('a recording that fails does not fail the answer', async () => {
    const ai = setup({ allow: () => true, record: () => { throw new Error('ledger down'); } });
    expect((await ai.complete({ prompt: 'x' })).model).toBe('paid-1');
  });
});

describe('paidFirst', () => {
  const answerBy = (prefix: string) => (req: ProviderRequest) => (req.model.startsWith(prefix) ? `from ${req.model}` : fail(503));
  const cfg = (or: ReturnType<typeof mock>, extra: object = {}) => ({ openrouter: { apiKey: 'platform', provider: or, models, paidModels: ['paid-1', 'paid-2'], allowPaid: true, paidFirst: true }, timing: quick, ...extra });

  it("tries the paid model first on the platform's key and never touches the free ones when it answers", async () => {
    const or = mock(answerBy('paid'));
    const r = await createLodestone(cfg(or)).complete({ prompt: 'x' });
    expect(r.model).toBe('paid-1');
    expect(or.calls.map((c) => c.model)).toEqual(['paid-1']);
  });
  it('falls back to the free models if the paid ones fail', async () => {
    const or = mock(answerBy('free-b'));
    const r = await createLodestone(cfg(or)).complete({ prompt: 'x' });
    expect(r.model).toBe('free-b:free');
    expect(or.calls.map((c) => c.model)).toEqual(['paid-1', 'paid-2', 'free-a:free', 'free-b:free']);
  });
  it('keeps answering from the free models when the spend limit is reached, instead of failing', async () => {
    const or = mock(answerBy('free-a'));
    const ai = createLodestone(cfg(or, { spend: { allow: () => false, record: () => {} } }));
    expect((await ai.complete({ prompt: 'x' })).model).toBe('free-a:free');
    expect(or.calls.some((c) => c.model.startsWith('paid'))).toBe(false);
  });
  it("says it is the budget only when the limit stopped the paid models and the free ones failed too", async () => {
    const ai = createLodestone(cfg(mock(() => fail(503)), { spend: { allow: () => false, record: () => {} } }));
    await expect(ai.complete({ prompt: 'x' })).rejects.toMatchObject({ kind: 'budget' });
  });
  it("is not applied to a caller's own key: their free models come first, because the paid ones are their money", async () => {
    const or = mock(answerBy('free-a'));
    const r = await createLodestone(cfg(or)).complete({ prompt: 'x', apiKey: 'theirs' });
    expect(r.model).toBe('free-a:free');
    expect(or.calls.map((c) => c.model)).toEqual(['free-a:free']);
  });
  it('does nothing when paid models are not allowed, so free models are never skipped by mistake', async () => {
    const or = mock(answerBy('free-a'));
    const r = await createLodestone({ openrouter: { apiKey: 'platform', provider: or, models, paidModels: ['paid-1'], paidFirst: true } }).complete({ prompt: 'x' });
    expect(r.model).toBe('free-a:free');
  });
  it('limits how long a paid model going first may take, so the next one still gets its turn', async () => {
    const or = mock((req: ProviderRequest) => (req.model === 'paid-1'
      ? new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(Object.assign(new Error('t'), { name: 'TimeoutError' }))))
      : `from ${req.model}`));
    const started = Date.now();
    const r = await createLodestone({ ...cfg(or), budgetMs: 3000, timing: { minSliceMs: 5, paidSliceMs: 80, freeSliceMs: 100 } }).complete({ prompt: 'x' });
    expect(r.model).toBe('paid-2');
    expect(Date.now() - started).toBeLessThan(1000);
  });
  it('counts what a paid call cost, and not the free fallback', async () => {
    const seen: string[] = [];
    const or = mock((req: ProviderRequest) => (req.model.startsWith('paid') ? fail(503) : 'free ok'));
    await createLodestone(cfg(or, { spend: { allow: () => true, record: (i: { phase: string }) => { seen.push(i.phase); } } })).complete({ prompt: 'x' });
    expect(seen).toEqual([]);
  });
});

describe('the list stays short however many models exist', () => {
  const NOW = Date.parse('2026-10-28T12:00:00Z');
  const cm = (id: string, o: Record<string, unknown> = {}) => ({ id, context_length: 262144, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, pricing: { prompt: '0', completion: '0' }, ...o });
  const many = Array.from({ length: 20 }, (_, i) => cm(`google/gemma-${i}-mini:free`));
  const withCatalog = (list: unknown[]) => (async () => new Response(JSON.stringify({ data: list }))) as typeof fetch;

  it('tries at most three models, however many the catalogue has', async () => {
    const or = mock(() => fail(503));
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: or, models: { fast: ['google/gemma-0-mini:free', 'openrouter/free'], strong: [], vision: [] } }, fetch: withCatalog(many), now: () => NOW });
    await ai.refreshCatalog();
    await ai.complete({ prompt: 'x' }).catch(() => {});
    expect(or.calls.length).toBeLessThanOrEqual(3);
  });
  it('replaces a model that is down with the next best from the pool, so three live models are still tried', async () => {
    const { createHealth } = await import('./health.js');
    const health = createHealth({ now: () => NOW });
    for (let i = 0; i < 3; i++) await health.record('mock', 'google/gemma-0-mini:free', false);
    const or = mock(() => fail(503));
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: or, models: { fast: ['google/gemma-0-mini:free', 'openrouter/free'], strong: [], vision: [] } }, fetch: withCatalog(many), health, now: () => NOW });
    await ai.refreshCatalog();
    await ai.complete({ prompt: 'x' }).catch(() => {});
    const tried = or.calls.map((c) => c.model);
    expect(tried).not.toContain('google/gemma-0-mini:free');   // the one that is down is skipped
    expect(tried.filter((m) => m !== 'openrouter/free').length).toBe(2); // and another takes its place
  });
  it('does not add a model from a publisher it does not know, by default', async () => {
    const or = mock(() => fail(503));
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: or, models: { fast: ['gone:free', 'openrouter/free'], strong: [], vision: [] } }, fetch: withCatalog([cm('shady-lab/sneaky:free'), cm('google/gemma-1-mini:free')]), now: () => NOW });
    await ai.refreshCatalog();
    await ai.complete({ prompt: 'x' }).catch(() => {});
    expect(or.calls.map((c) => c.model)).not.toContain('shady-lab/sneaky:free');
    expect(or.calls.map((c) => c.model)).toContain('google/gemma-1-mini:free');
  });
  it('can be told to trust another publisher, or to block one', async () => {
    const run = async (trust: object) => {
      const or = mock(() => fail(503));
      const ai = createLodestone({ openrouter: { apiKey: 'k', provider: or, models: { fast: ['gone:free', 'openrouter/free'], strong: [], vision: [] } }, trust, fetch: withCatalog([cm('shady-lab/sneaky:free'), cm('google/gemma-1-mini:free')]), now: () => NOW });
      await ai.refreshCatalog(); await ai.complete({ prompt: 'x' }).catch(() => {});
      return or.calls.map((c) => c.model);
    };
    expect(await run({ publishers: ['shady-lab'] })).toContain('shady-lab/sneaky:free');
    expect(await run({ block: ['google/'] })).not.toContain('google/gemma-1-mini:free');
  });
  it('leaves out a free model that is about to be retired', async () => {
    const or = mock(() => fail(503));
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: or, models: { fast: ['google/retiring-mini:free', 'google/staying-mini:free', 'openrouter/free'], strong: [], vision: [] } }, fetch: withCatalog([cm('google/retiring-mini:free', { expiration_date: '2026-10-31' }), cm('google/staying-mini:free')]), now: () => NOW });
    await ai.refreshCatalog();
    await ai.complete({ prompt: 'x' }).catch(() => {});
    expect(or.calls.map((c) => c.model)).not.toContain('google/retiring-mini:free');
  });
});

describe('other providers keep their lists alive', () => {
  const NOW = Date.parse('2026-10-28T12:00:00Z');
  const gateway = (rows: CatalogModel[], reply: (r: ProviderRequest) => string | Promise<never> = () => 'from gateway') => {
    const p = mock(reply as never) as ReturnType<typeof mock> & { listModels?: unknown };
    p.listModels = async () => rows;
    return p;
  };
  const row = (id: string, o: Record<string, unknown> = {}) => ({ id, context_length: 128000, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, pricing: { prompt: 3e-7, completion: 6e-7 }, ...o });
  const down = () => mock(() => fail(503));

  it("drops a fallback model the provider no longer lists, using the catalogue it saved", async () => {
    const gw = gateway([row('google/here-flash')]);
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: down(), models }, fallbacks: [{ provider: gw, apiKey: 'g', models: ['google/gone-flash', 'google/here-flash'] }], now: () => NOW, timing: quick });
    await ai.checkModels().catch(() => {});
    await ai.complete({ prompt: 'x' });
    expect(gw.calls.map((c) => c.model)).toEqual(['google/here-flash']);
  });
  it('fills a short list with trusted models within the price limit', async () => {
    const gw = gateway([row('google/cheap-flash'), row('anthropic/cheap-mini', { pricing: { prompt: 4e-7, completion: 8e-7 } }), row('openai/pricey', { pricing: { prompt: 2e-5, completion: 6e-5 } }), row('shady-lab/cheap')]);
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: down(), models }, fallbacks: [{ provider: gw, apiKey: 'g', models: ['google/gone'], discover: { fill: { maxPromptUsdPerMTok: 1, maxCompletionUsdPerMTok: 2 }, max: 2 } }], now: () => NOW, timing: quick });
    await ai.refreshCatalog(); await ai.checkModels();
    await ai.complete({ prompt: 'x' });
    expect(['google/cheap-flash', 'anthropic/cheap-mini']).toContain(gw.calls[0].model);
  });
  it('reports, for every provider, what has gone and what is retiring', async () => {
    const gw = gateway([row('google/here-flash'), row('google/leaving-flash', { expiration_date: '2026-10-30' })]);
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: down(), models }, fallbacks: [{ provider: gw, apiKey: 'g', models: ['google/gone', 'google/here-flash', 'google/leaving-flash'] }], now: () => NOW,
      fetch: (async () => new Response(JSON.stringify({ data: [{ id: 'free-a:free', context_length: 100000, expiration_date: '2026-10-30' }, { id: 'free-b:free', context_length: 100000 }] }))) as typeof fetch });
    const r = await ai.checkModels();
    expect(r.providers?.mock).toEqual({ models: 2, withdrawn: ['google/gone'], expiring: ['google/leaving-flash'] });
    expect(r.expiring).toContain('free-a:free');
  });
  it('says so when a provider cannot list its models, and still works with the models the app named', async () => {
    const gw = mock('from gateway') as ReturnType<typeof mock> & { listModels?: unknown };
    gw.listModels = async () => null;
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: down(), models }, fallbacks: [{ provider: gw, apiKey: 'g', models: ['google/x'] }], timing: quick, fetch: (async () => new Response(JSON.stringify({ data: [{ id: 'free-a:free', context_length: 100000 }] }))) as typeof fetch });
    expect((await ai.checkModels()).providers?.mock).toMatchObject({ error: expect.stringContaining('could not read') });
    expect((await ai.complete({ prompt: 'x' })).text).toBe('from gateway');
  });
});

describe('private calls', () => {
  const NOW = Date.parse('2026-10-28T12:00:00Z');
  it('tells OpenRouter to use only providers that do not keep or train on the prompt', async () => {
    const or = mock('ok');
    await createLodestone({ openrouter: { apiKey: 'k', provider: or, models } }).complete({ prompt: 'my cv', private: true });
    expect(or.calls[0].privacy).toBe('strict');
    const normal = mock('ok');
    await createLodestone({ openrouter: { apiKey: 'k', provider: normal, models } }).complete({ prompt: 'x' });
    expect(normal.calls[0].privacy).toBeUndefined();
  });
  it("uses a fallback model only if its provider says it is not trained on, when the call is private", async () => {
    const gw = mock('from gateway') as ReturnType<typeof mock> & { listModels?: unknown };
    gw.listModels = async () => [
      { id: 'google/trained-flash', data_used_for_training: true, data_retention_days: 0, context_length: 100000, pricing: { prompt: 1e-7, completion: 1e-7 } },
      { id: 'google/unknown-flash', context_length: 100000, pricing: { prompt: 1e-7, completion: 1e-7 } },
      { id: 'google/safe-flash', data_used_for_training: false, data_retention_days: 0, context_length: 100000, pricing: { prompt: 1e-7, completion: 1e-7 } },
    ];
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: mock(() => fail(503)), models }, trust: { requireNoTraining: true }, now: () => NOW, timing: quick,
      fallbacks: [{ provider: gw, apiKey: 'g', models: ['google/trained-flash', 'google/unknown-flash', 'google/safe-flash'] }], fetch: (async () => new Response(JSON.stringify({ data: [{ id: 'free-a:free', context_length: 100000 }] }))) as typeof fetch });
    await ai.checkModels();
    await ai.complete({ prompt: 'my cv', private: true });
    expect(gw.calls.map((c) => c.model)).toEqual(['google/safe-flash']);
  });
  it("does not count a private call's failures against a model, since few providers can meet the rule", async () => {
    const { createHealth } = await import('./health.js');
    const health = createHealth();
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: mock(() => fail(404)), models }, health });
    for (let i = 0; i < 4; i++) await ai.complete({ prompt: 'x', private: true }).catch(() => {});
    expect(await health.snapshot()).toEqual([]);
  });
});

describe('cancelling, and peeking', () => {
  it('stops at once when the caller has already given up, and calls no model', async () => {
    const or = mock('x');
    const c = new AbortController(); c.abort();
    await expect(createLodestone({ openrouter: { apiKey: 'k', provider: or, models } }).complete({ prompt: 'x', signal: c.signal })).rejects.toMatchObject({ kind: 'aborted' });
    expect(or.calls).toHaveLength(0);
  });
  it('stops the call in flight and tries no further model when the caller gives up', async () => {
    const c = new AbortController();
    const or = mock((req: ProviderRequest) => new Promise((_, reject) => { req.signal.addEventListener('abort', () => reject(Object.assign(new Error('a'), { name: 'AbortError' }))); setTimeout(() => c.abort(), 20); }));
    await expect(createLodestone({ openrouter: { apiKey: 'k', provider: or, models }, budgetMs: 5000 }).complete({ prompt: 'x', signal: c.signal })).rejects.toMatchObject({ kind: 'aborted' });
    expect(or.calls).toHaveLength(1);
  });
  it('returns a saved answer without calling any model, and nothing when there is none', async () => {
    const or = mock('first');
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: or, models } });
    expect(await ai.peek('job:1')).toBeNull();
    await ai.complete({ prompt: 'x', cacheKey: 'job:1' });
    expect(await ai.peek('job:1')).toMatchObject({ text: 'first', cached: true });
    expect(or.calls).toHaveLength(1);
    expect(await ai.peek('job:1', -1)).toBeNull(); // past its lifetime
  });
});

describe('redundancy across providers', () => {
  it('does not let free models eat the whole budget when another provider is waiting its turn (an OpenRouter outage)', async () => {
    const hang = (req: ProviderRequest) => new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(Object.assign(new Error('t'), { name: 'TimeoutError' }))));
    const or = mock(hang as never);
    const gw = mock('from the other provider');
    const ai = createLodestone({
      openrouter: { apiKey: 'k', provider: or, models, paidModels: ['paid-1'], allowPaid: true, paidFirst: true },
      fallbacks: [{ provider: gw, apiKey: 'g', models: ['google/x'] }],
      budgetMs: 4000, timing: { minSliceMs: 5, paidSliceMs: 100, freeSliceMs: 5000, freeSliceWithLaterMs: 100, freePhaseWithLaterMs: 300 },
    });
    const started = Date.now();
    expect((await ai.complete({ prompt: 'x' })).text).toBe('from the other provider');
    expect(Date.now() - started).toBeLessThan(2000);
  });
  it("does not count a free-tier provider's calls against the spend limit, or stop them when the limit is reached", async () => {
    let asked = 0; let recorded = 0;
    const groqLike = mock('from the free tier');
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: mock(() => fail(503)), models }, fallbacks: [{ provider: groqLike, apiKey: 'g', models: ['llama-x'], free: true }], spend: { allow: () => { asked++; return false; }, record: () => { recorded++; } }, timing: quick });
    expect((await ai.complete({ prompt: 'x' })).text).toBe('from the free tier');
    expect([asked, recorded]).toEqual([0, 0]);
  });
  it('moves from one gateway to the next, each with its own key', async () => {
    const a = mock(() => fail(503)); const b = mock('from b');
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: mock(() => fail(503)), models }, fallbacks: [{ provider: a, apiKey: 'key-a', models: ['m'] }, { provider: b, apiKey: 'key-b', models: ['m'] }], timing: quick });
    expect((await ai.complete({ prompt: 'x' })).text).toBe('from b');
    expect([a.calls[0].apiKey, b.calls[0].apiKey]).toEqual(['key-a', 'key-b']);
  });
});
