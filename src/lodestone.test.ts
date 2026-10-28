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
      fetch: catalogFetch([m('newer-lightning:free'), m('another-mini:free')]),
    });
    await ai.refreshCatalog();
    await ai.complete({ prompt: 'x' });
    expect(or.calls[0].model).not.toContain('gone');
    expect(['newer-lightning:free', 'another-mini:free']).toContain(or.calls[0].model);
  });
  it('uses the preferences as given before any catalogue exists', async () => {
    const or = mock();
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: or, models } });
    await ai.complete({ prompt: 'x' });
    expect(or.calls[0].model).toBe('free-a:free');
  });
  it('checkModels reports what was withdrawn and whether a tier is short of models', async () => {
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: mock(), models: { fast: ['here:free', 'gone:free', 'openrouter/free'] }, paidModels: [] }, fetch: catalogFetch([m('here:free'), m('spare:free')]) });
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
