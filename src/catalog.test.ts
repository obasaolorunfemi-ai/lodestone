import { describe, expect, it } from 'vitest';
import { createCatalog, pickModels, ROUTER, type CatalogModel } from './catalog.js';
import { DEFAULT_MODELS } from './models.js';
import { memoryStore } from './store.js';

const m = (id: string, o: Partial<CatalogModel> = {}): CatalogModel => ({ id, context_length: 262144, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, pricing: { prompt: '0', completion: '0' }, ...o });
const img = { architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } };
const { fast, strong, vision } = DEFAULT_MODELS;

const catalog: CatalogModel[] = [
  m('google/gemma-4-26b-a4b-it:free', img), m('google/gemma-4-31b-it:free', img),
  m('nvidia/nemotron-3-ultra-550b-a55b:free'), m('nvidia/nemotron-3.5-lightning:free'), m('poolside/laguna-s-2.1:free'),
  m('nvidia/nemotron-3.5-super-vl:free', img),
  m('nvidia/nemotron-3.5-content-safety:free'), m('google/lyria-3-pro-preview', { architecture: { input_modalities: ['text'], output_modalities: ['audio'] } }),
  m('cohere/north-mini-code:free'), m('tiny/model:free', { context_length: 8000 }), m('qwen/qwen3.7-flash', { pricing: { prompt: '0.00000003', completion: '0.0000001' } }),
];

describe('pickModels', () => {
  it('keeps preferred models that still exist, in order, and ends with the router', () => {
    const list = pickModels('strong', catalog, strong);
    expect(list[0]).toBe('nvidia/nemotron-3-ultra-550b-a55b:free');
    expect(list.at(-1)).toBe(ROUTER);
    expect(list.length).toBeLessThanOrEqual(3);
  });
  it('replaces a withdrawn model with a current one of the same kind', () => {
    const without = catalog.filter((c) => c.id !== 'nvidia/nemotron-3-ultra-550b-a55b:free' && c.id !== 'google/gemma-4-31b-it:free');
    const list = pickModels('strong', without, strong);
    expect(list).not.toContain('nvidia/nemotron-3-ultra-550b-a55b:free');
    expect(list.length).toBe(3);
    expect(list.slice(0, 2).every((id) => without.some((c) => c.id === id))).toBe(true);
  });
  it('never picks a safety, audio, code, tiny or paid model', () => {
    const list = pickModels('fast', catalog.filter((c) => !fast.includes(c.id)), fast);
    for (const bad of ['content-safety', 'lyria', 'north-mini-code', 'tiny/model', 'qwen/qwen3.7-flash']) expect(list.join()).not.toContain(bad);
  });
  it('picks only models that take images for the vision tier', () => {
    const list = pickModels('vision', catalog.filter((c) => !vision.includes(c.id)), vision);
    for (const id of list.filter((x) => x !== ROUTER)) expect(catalog.find((c) => c.id === id)?.architecture?.input_modalities).toContain('image');
  });
  it('falls back to the preferences when there is no catalogue', () => {
    expect(pickModels('fast', null, fast)).toEqual(fast);
    expect(pickModels('fast', [], fast)).toEqual(fast);
  });
});

describe('createCatalog', () => {
  const body = (models: CatalogModel[]) => new Response(JSON.stringify({ data: models }));

  it('fetches, saves and then serves the catalogue from the store', async () => {
    let fetches = 0;
    const store = memoryStore();
    const fetchImpl = (async () => { fetches++; return body(catalog); }) as typeof fetch;
    const c = createCatalog(store, fetchImpl);
    expect((await c.refresh())?.length).toBe(catalog.length);
    expect(fetches).toBe(1);
    // A second instance (a cold start) reads what was saved without going to the network.
    expect((await createCatalog(store, fetchImpl).load())?.length).toBe(catalog.length);
    expect(fetches).toBe(1);
  });
  it('returns null when the catalogue is unreadable or empty, and saves nothing', async () => {
    const store = memoryStore();
    expect(await createCatalog(store, (async () => new Response('x', { status: 500 })) as typeof fetch).refresh()).toBeNull();
    expect(await createCatalog(store, (async () => body([])) as typeof fetch).refresh()).toBeNull();
    expect(await createCatalog(store, (async () => body(catalog)) as typeof fetch).load()).toBeNull();
  });
  it('refreshes in the background when the saved copy is over a day old', async () => {
    let t = Date.parse('2026-10-28T00:00:00Z');
    let fetches = 0;
    const store = memoryStore();
    const fetchImpl = (async () => { fetches++; return body(catalog); }) as typeof fetch;
    await createCatalog(store, fetchImpl, () => t).refresh();
    t += 25 * 3_600_000;
    await createCatalog(store, fetchImpl, () => t).load();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetches).toBe(2);
  });
});
