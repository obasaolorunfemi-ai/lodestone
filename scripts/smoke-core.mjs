// The same checks, run on whatever runtime imports this file: Node, Deno, Bun and Cloudflare Workers all run it in CI.
// It uses the built library (dist/) with fake providers, so it needs no network and no keys. It touches only
// web-standard APIs (fetch, Response, AbortSignal, crypto.subtle, TextEncoder, ReadableStream), which is the point.

export async function smoke(lib) {
  const { createLodestone, createHealth, createSpendLimit, createRateLimiter, memoryStore, mock, explain, LodestoneError, ProviderError,
    upstashStore, cloudflareKvStore, fetchScorecard, safeKey } = lib;
  const done = [];
  const check = async (name, fn) => { try { await fn(); done.push(name); } catch (e) { throw new Error(`${name}: ${e && e.message ? e.message : e}`); } };
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
  const models = { fast: ['free-a:free', 'free-b:free', 'openrouter/free'], strong: ['free-a:free'], vision: ['free-a:free'] };
  const fail = (status) => { throw new ProviderError(status, ''); };
  const quick = { minSliceMs: 5, freeSliceMs: 150, freeSliceWithLaterMs: 150, freePhaseWithLaterMs: 400 };

  await check('fails over to the next model', async () => {
    const or = mock((req) => (req.model === 'free-a:free' ? fail(503) : 'second'));
    const r = await createLodestone({ openrouter: { apiKey: 'k', provider: or, models } }).complete({ prompt: 'hi' });
    assert(r.text === 'second' && r.model === 'free-b:free', `got ${r.model}`);
  });

  await check('cuts off a model that hangs (AbortSignal.timeout)', async () => {
    const or = mock((req) => (req.model === 'free-a:free' ? new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })))) : 'ok'));
    const started = Date.now();
    const r = await createLodestone({ openrouter: { apiKey: 'k', provider: or, models }, timing: quick }).complete({ prompt: 'hi' });
    assert(r.text === 'ok', 'no answer');
    assert(Date.now() - started < 2000, 'the slow model was not cut off');
  });

  await check('json() skips an answer that is not JSON', async () => {
    const or = mock((req) => (req.model === 'free-a:free' ? 'not json' : '{"n":1}'));
    const r = await createLodestone({ openrouter: { apiKey: 'k', provider: or, models } }).json({ prompt: 'x' });
    assert(r.data.n === 1, 'wrong data');
  });

  await check('explain() turns a failure into a sentence', async () => {
    const err = await createLodestone({ openrouter: { apiKey: 'k', provider: mock(() => fail(503)), models } }).complete({ prompt: 'x' }).catch((e) => e);
    assert(err instanceof LodestoneError && /provider/i.test(explain(err)), 'no sentence');
  });

  await check('the circuit breaker shares what it learns through a store', async () => {
    const store = memoryStore();
    const a = createHealth({ store });
    for (let i = 0; i < 3; i++) await a.record('p', 'm', false);
    assert(await createHealth({ store }).shouldSkip('p', 'm'), 'a second instance did not see the failures');
  });

  await check('a spend limit holds under a burst (crypto.randomUUID, crypto.subtle)', async () => {
    const spend = createSpendLimit({ store: memoryStore(), dailyUsd: 0.03, holdUsd: 0.01 });
    const or = mock((req) => (req.model.startsWith('paid') ? { text: 'ok', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 } } : fail(503)));
    const ai = createLodestone({ openrouter: { apiKey: 'p', provider: or, models, paidModels: ['paid-1'], allowPaid: true, paidFirst: true }, spend, timing: quick });
    const out = await Promise.allSettled(Array.from({ length: 8 }, () => ai.complete({ prompt: 'x' })));
    const paid = out.filter((o) => o.status === 'fulfilled' && o.value.model === 'paid-1').length;
    assert(paid === 3, `${paid} paid calls got through a limit of 3`);
  });

  await check('a per-caller rate limit stops one caller and not another', async () => {
    const rateLimit = { limiter: createRateLimiter({ store: memoryStore(), max: 1 }) };
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: mock('x'), models }, rateLimit });
    await ai.complete({ prompt: 'a', caller: 'u1' });
    const err = await ai.complete({ prompt: 'b', caller: 'u1' }).catch((e) => e);
    assert(err && err.kind === 'throttled', 'not throttled');
    await ai.complete({ prompt: 'c', caller: 'u2' });
  });

  await check('a private call is not cached', async () => {
    const or = mock('x');
    const ai = createLodestone({ openrouter: { apiKey: 'k', provider: or, models } });
    await ai.complete({ prompt: 'p', private: true, cacheKey: 'k' }); await ai.complete({ prompt: 'p', private: true, cacheKey: 'k' });
    assert(or.calls.length === 2, 'served from the cache');
  });

  await check('the Upstash adapter works over fetch', async () => {
    const data = new Map();
    const fake = async (url, init) => {
      const body = JSON.parse(init.body);
      if (String(url).endsWith('/pipeline')) { const n = (data.get(body[0][1]) ?? 0) + body[0][2]; data.set(body[0][1], n); return Response.json([{ result: n }, { result: 1 }]); }
      if (body[0] === 'SET') { data.set(body[1], body[2]); return Response.json({ result: 'OK' }); }
      return Response.json({ result: data.get(body[1]) ?? null });
    };
    const store = upstashStore({ url: 'https://x.upstash.io', token: 't', fetch: fake });
    await store.set('k', { a: 1 }); assert((await store.get('k')).a === 1, 'round trip');
    assert((await store.incrBy('c', 1, { ttlMs: 1000 })) === 1, 'counter');
  });

  await check('the Workers KV adapter and safeKey work', async () => {
    const kv = new Map();
    const store = cloudflareKvStore({ get: async (k) => (kv.has(k) ? JSON.parse(kv.get(k)) : null), put: async (k, v) => { kv.set(k, v); } });
    await store.set('lodestone:a', { n: 2 }, { ttlMs: 1000 });
    assert((await store.get('lodestone:a')).n === 2, 'round trip');
    assert((await safeKey('a b')) === 'a~20b', 'key');
  });

  await check('a scorecard is read through a size-limited stream', async () => {
    const card = JSON.stringify({ schema: 'model-scorecard/1', source: 's', generatedAt: '2026-10-01', scores: [] });
    const c = await fetchScorecard('https://x.example/c.json', { fetch: async () => new Response(card) });
    assert(c.source === 's', 'not read');
    const big = await fetchScorecard('https://x.example/c.json', { fetch: async () => new Response(card + ' '.repeat(2000)), maxBytes: 500 }).catch((e) => e);
    assert(big instanceof Error && /larger/.test(big.message), 'size limit');
  });

  return { ok: true, checks: done };
}
