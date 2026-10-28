import type { KeyValueStore, Tier } from './types.js';

/** Works out which models to ask for from OpenRouter's own catalogue, so a model
 *  that has been withdrawn is dropped and a current one takes its place without
 *  anyone editing a list. The lists you pass in are preferences: they are used
 *  while they exist. What is left over is filled from the catalogue. */

export interface CatalogModel {
  id: string;
  context_length?: number;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  pricing?: { prompt?: string | number; completion?: string | number };
}

export const ROUTER = 'openrouter/free';
const MAX_ENTRIES = 3;

const isFree = (m: CatalogModel) => m.id.endsWith(':free') || (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0 && m.id !== ROUTER);
const textOut = (m: CatalogModel) => (m.architecture?.output_modalities ?? ['text']).join() === 'text';
const takesImages = (m: CatalogModel) => (m.architecture?.input_modalities ?? []).includes('image');
// Safety classifiers, audio and music models, code-only models and embedders are not for writing or reading text.
const EXCLUDE = /safety|guard|moderation|lyria|embed|rerank|tts|whisper|code|coder|preview-audio|ocr/i;

/** "550b" or "26b" in an id: bigger is the stronger pick. */
const size = (id: string): number => Number(id.match(/(\d{2,4})b\b/i)?.[1] ?? 0);
const LIGHT = /lightning|flash|mini|small|nano|lite|fast/i;

export function eligible(catalog: CatalogModel[], tier: Tier): CatalogModel[] {
  return catalog.filter((m) => isFree(m) && textOut(m) && (m.context_length ?? 0) >= 32_000 && !EXCLUDE.test(m.id) && (tier !== 'vision' || takesImages(m)));
}

/** The ids to send, best first: preferred models that still exist, then the best
 *  others by tier, then the router; at most three. With no catalogue at all, the
 *  preferences are returned as they are. */
export function pickModels(tier: Tier, catalog: CatalogModel[] | null, preferences: string[]): string[] {
  if (!catalog || catalog.length === 0) return preferences.slice(0, MAX_ENTRIES);
  const ok = new Map(eligible(catalog, tier).map((m) => [m.id, m]));
  const out: string[] = preferences.filter((id) => id !== ROUTER && ok.has(id));
  const rest = [...ok.values()]
    .filter((m) => !out.includes(m.id))
    .sort((a, b) => (tier === 'strong' ? size(b.id) - size(a.id) : tier === 'fast' ? Number(LIGHT.test(b.id)) - Number(LIGHT.test(a.id)) || size(a.id) - size(b.id) : size(b.id) - size(a.id)) || (b.context_length ?? 0) - (a.context_length ?? 0));
  for (const m of rest) { if (out.length >= MAX_ENTRIES - 1) break; out.push(m.id); }
  return [...out.slice(0, MAX_ENTRIES - 1), ROUTER];
}

const KEY = 'lodestone:model-catalog';
const MEMORY_MS = 6 * 3_600_000;
const STALE_MS = 24 * 3_600_000;

interface Saved { at: string; models: CatalogModel[] }

export interface Catalog {
  /** Fetches OpenRouter's catalogue and saves it. Returns null if it can't be read. */
  refresh(): Promise<CatalogModel[] | null>;
  /** The saved catalogue (six-hour copy in memory; refreshed in the background if over a day old). Never waits on the network unless nothing is saved. */
  load(): Promise<CatalogModel[] | null>;
}

export function createCatalog(store: KeyValueStore, fetchImpl: typeof fetch, now: () => number = Date.now): Catalog {
  let memory: { at: number; models: CatalogModel[] } | null = null;

  const refresh = async (): Promise<CatalogModel[] | null> => {
    const res = await fetchImpl('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const models = (((await res.json()) as { data?: CatalogModel[] }).data ?? []).map((m) => ({
      id: m.id,
      context_length: m.context_length,
      architecture: m.architecture && { input_modalities: m.architecture.input_modalities, output_modalities: m.architecture.output_modalities },
      pricing: m.pricing && { prompt: m.pricing.prompt, completion: m.pricing.completion },
    }));
    if (models.length === 0) return null;
    await store.set(KEY, { at: new Date(now()).toISOString(), models } satisfies Saved).catch(() => {});
    memory = { at: now(), models };
    return models;
  };

  const load = async (): Promise<CatalogModel[] | null> => {
    if (memory && now() - memory.at < MEMORY_MS) return memory.models;
    try {
      const saved = (await store.get(KEY)) as Saved | null;
      if (saved?.models?.length) {
        memory = { at: now(), models: saved.models };
        if (now() - Date.parse(saved.at) > STALE_MS) refresh().catch(() => {});
        return saved.models;
      }
    } catch { /* an unreadable store is the same as an empty one */ }
    return null;
  };

  return { refresh, load };
}
