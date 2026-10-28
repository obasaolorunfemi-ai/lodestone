import { describe, expect, it } from 'vitest';
import { createHealth } from './health.js';
import { memoryStore } from './store.js';

const MIN = 60_000;
const setup = (o: Parameters<typeof createHealth>[0] = {}) => { const clock = { t: Date.parse('2026-10-28T12:00:00Z') }; return { clock, health: createHealth({ now: () => clock.t, ...o }) }; };
const fail = async (h: ReturnType<typeof createHealth>, n: number, model = 'm') => { for (let i = 0; i < n; i++) await h.record('p', model, false); };

describe('createHealth', () => {
  it('skips a model only after its last few attempts all failed', async () => {
    const { health } = setup();
    await fail(health, 2);
    expect(await health.shouldSkip('p', 'm')).toBe(false);
    await health.record('p', 'm', true); await fail(health, 2);
    expect(await health.shouldSkip('p', 'm')).toBe(false); // a success in between keeps it in use
    await fail(health, 1);
    expect(await health.shouldSkip('p', 'm')).toBe(true);
  });
  it('lets one attempt through after a while to see whether it has recovered, and one success closes it', async () => {
    const { clock, health } = setup();
    await fail(health, 3);
    expect(await health.shouldSkip('p', 'm')).toBe(true);
    clock.t += 2 * MIN;
    expect(await health.shouldSkip('p', 'm')).toBe(false); // the probe
    await health.record('p', 'm', false);                  // still down
    expect(await health.shouldSkip('p', 'm')).toBe(true);
    clock.t += 2 * MIN; await health.record('p', 'm', true);
    expect(await health.shouldSkip('p', 'm')).toBe(false);
  });
  it('forgets failures older than the window', async () => {
    const { clock, health } = setup();
    await fail(health, 3);
    clock.t += 11 * MIN;
    expect(await health.shouldSkip('p', 'm')).toBe(false);
  });
  it('keeps models, and the same model on different providers, apart', async () => {
    const { health } = setup();
    await fail(health, 3, 'bad');
    await health.record('other', 'bad', true);
    expect(await health.shouldSkip('p', 'bad')).toBe(true);
    expect(await health.shouldSkip('p', 'good')).toBe(false);
    expect(await health.shouldSkip('other', 'bad')).toBe(false);
  });
  it('shares what it learns through a store, so another instance skips the model without failing itself', async () => {
    const store = memoryStore();
    const { clock, health: a } = setup({ store });
    await fail(a, 3);
    const b = createHealth({ store, now: () => clock.t }); // a fresh instance: a new serverless function
    expect(await b.shouldSkip('p', 'm')).toBe(true);
  });
  it('writes to the store only for failures and the first success after trouble, not for a model that is just working', async () => {
    let writes = 0;
    const inner = memoryStore();
    const store = { get: inner.get, set: async (k: string, v: unknown) => { writes++; return inner.set(k, v); } };
    const { health } = setup({ store });
    for (let i = 0; i < 5; i++) await health.record('p', 'm', true);
    expect(writes).toBe(0);
    await health.record('p', 'm', false);
    expect(writes).toBe(1);
    await health.record('p', 'm', true);
    expect(writes).toBe(2); // recovery is saved
    await health.record('p', 'm', true);
    await health.record('p', 'm', true);
    expect(writes).toBe(2);
  });
  it('still works when the store cannot be read or written', async () => {
    const store = { get: async () => { throw new Error('down'); }, set: async () => { throw new Error('down'); } };
    const { health } = setup({ store });
    await fail(health, 3);
    expect(await health.shouldSkip('p', 'm')).toBe(true);
  });
  it('reports what it has seen, for a health page', async () => {
    const { health } = setup();
    await health.record('p', 'ok-model', true);
    await fail(health, 3, 'bad-model');
    const snap = await health.snapshot();
    expect(snap.find((m) => m.model === 'bad-model')).toMatchObject({ open: true, recentFailures: 3, recentAttempts: 3 });
    expect(snap.find((m) => m.model === 'ok-model')).toMatchObject({ open: false, recentFailures: 0, lastFailureAt: null });
  });
});
