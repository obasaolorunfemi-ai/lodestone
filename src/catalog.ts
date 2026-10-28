import { vet, type TrustPolicy } from './trust.js';
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
  /** The lab that made it, when the provider says (Requesty's model_lab); otherwise the first part of the id. */
  publisher?: string;
  /** The day the provider stops offering it (OpenRouter publishes this for models being retired). */
  expiration_date?: string;
  /** What the provider says happens to prompts (Requesty publishes these for every model). */
  data_used_for_training?: boolean;
  data_retention_days?: number;
  /** Zero price, as the provider says it. */
  free?: boolean;
}

export const ROUTER = 'openrouter/free';
const MAX_ENTRIES = 3;

const isFree = (m: CatalogModel) => m.id.endsWith(':free') || (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0 && m.id !== ROUTER);
/** US dollars per million tokens, or undefined if the provider gives no price. */
export const promptPerMTok = (m: CatalogModel): number | undefined => { const n = Number(m.pricing?.prompt); return m.pricing?.prompt !== undefined && m.pricing?.prompt !== '' && Number.isFinite(n) ? n * 1e6 : undefined; };
export const completionPerMTok = (m: CatalogModel): number | undefined => { const n = Number(m.pricing?.completion); return m.pricing?.completion !== undefined && m.pricing?.completion !== '' && Number.isFinite(n) ? n * 1e6 : undefined; };
const textOut = (m: CatalogModel) => (m.architecture?.output_modalities ?? ['text']).join() === 'text';
const takesImages = (m: CatalogModel) => (m.architecture?.input_modalities ?? []).includes('image');
// Safety classifiers, audio and music models, code-only models and embedders are not for writing or reading text.
const EXCLUDE = /safety|guard|moderation|lyria|embed|rerank|tts|whisper|code|coder|preview-audio|ocr/i;

/** "550b" or "26b" in an id: bigger is the stronger pick. */
const size = (id: string): number => Number(id.match(/(\d{2,4})b\b/i)?.[1] ?? 0);
const LIGHT = /lightning|flash|mini|small|nano|lite|fast/i;

/** Text models fit for the tier. Free ones, unless `price` allows more (then at most that, per million tokens). */
export function eligible(catalog: CatalogModel[], tier: Tier, price?: { promptUsdPerMTok: number; completionUsdPerMTok: number }): CatalogModel[] {
  return catalog.filter((m) => {
    const affordable = price
      ? (promptPerMTok(m) ?? Infinity) <= price.promptUsdPerMTok && (completionPerMTok(m) ?? Infinity) <= price.completionUsdPerMTok
      : isFree(m);
    return affordable && textOut(m) && (m.context_length ?? 0) >= 32_000 && !EXCLUDE.test(m.id) && (tier !== 'vision' || takesImages(m));
  });
}

/** How the candidates for a tier are ranked: bigger is stronger, lighter is faster, then longer context. */
export function rank(tier: Tier, a: CatalogModel, b: CatalogModel): number {
  return (tier === 'strong' ? size(b.id) - size(a.id) : tier === 'fast' ? Number(LIGHT.test(b.id)) - Number(LIGHT.test(a.id)) || size(a.id) - size(b.id) : size(b.id) - size(a.id)) || (b.context_length ?? 0) - (a.context_length ?? 0);
}

export interface PickOptions {
  policy?: TrustPolicy;
  /** Treat unknown privacy facts as a refusal even for a preferred model (a call marked private). */
  strict?: boolean;
  /** How many to return, the router included. Default 3. A larger number gives a pool to choose live models from. */
  depth?: number;
  now?: number;
}

/** The ids to send, best first: preferred models that still exist, then the best
 *  others by tier, then the router; at most `depth` (three by default). With no catalogue at all, the
 *  preferences are returned as they are. A model the trust policy refuses, or that is about to be
 *  retired, is left out. */
export function pickModels(tier: Tier, catalog: CatalogModel[] | null, preferences: string[], opts: PickOptions = {}): string[] {
  const depth = opts.depth ?? MAX_ENTRIES;
  if (!catalog || catalog.length === 0) return preferences.slice(0, depth);
  const now = opts.now ?? Date.now();
  const ok = new Map(eligible(catalog, tier).map((m) => [m.id, m]));
  const out: string[] = preferences.filter((id) => id !== ROUTER && ok.has(id) && vet(ok.get(id)!, opts.policy, { discovered: false, strict: opts.strict, now }).ok);
  const rest = [...ok.values()].filter((m) => !out.includes(m.id) && vet(m, opts.policy, { discovered: true, strict: opts.strict, now }).ok).sort((a, b) => rank(tier, a, b));
  for (const m of rest) { if (out.length >= depth - 1) break; out.push(m.id); }
  return [...out.slice(0, depth - 1), ROUTER];
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

/** OpenRouter's catalogue, as a list of CatalogModel. */
export async function listOpenRouter(fetchImpl: typeof fetch): Promise<CatalogModel[] | null> {
  const res = await fetchImpl('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) return null;
  const models = (((await res.json()) as { data?: CatalogModel[] }).data ?? []).map((m): CatalogModel => ({
    id: m.id,
    context_length: m.context_length,
    architecture: m.architecture && { input_modalities: m.architecture.input_modalities, output_modalities: m.architecture.output_modalities },
    pricing: m.pricing && { prompt: m.pricing.prompt, completion: m.pricing.completion },
    ...(m.expiration_date ? { expiration_date: m.expiration_date } : {}),
  }));
  return models.length ? models : null;
}

export interface CatalogSource {
  /** Where it is saved. Default: the OpenRouter catalogue's own key. */
  key?: string;
  /** How to read the provider's list. Default: OpenRouter's. */
  list?: () => Promise<CatalogModel[] | null>;
}

export function createCatalog(store: KeyValueStore, fetchImpl: typeof fetch, now: () => number = Date.now, source: CatalogSource = {}): Catalog {
  let memory: { at: number; models: CatalogModel[] } | null = null;
  let lastKick = -Infinity;
  const KEY_ = source.key ?? KEY;

  const refresh = async (): Promise<CatalogModel[] | null> => {
    const models = await (source.list ? source.list() : listOpenRouter(fetchImpl));
    if (!models || models.length === 0) return null;
    await store.set(KEY_, { at: new Date(now()).toISOString(), models } satisfies Saved).catch(() => {});
    memory = { at: now(), models };
    return models;
  };

  const load = async (): Promise<CatalogModel[] | null> => {
    if (memory && now() - memory.at < MEMORY_MS) return memory.models;
    try {
      const saved = (await store.get(KEY_)) as Saved | null;
      if (saved?.models?.length) {
        memory = { at: now(), models: saved.models };
        if (now() - Date.parse(saved.at) > STALE_MS) refresh().catch(() => {});
        return saved.models;
      }
      // Nothing saved yet: use the preferences this time, and fetch it for the next request.
      if (now() - lastKick > 5 * 60_000) { lastKick = now(); refresh().catch(() => {}); }
    } catch { /* an unreadable store is the same as an empty one */ }
    return null;
  };

  return { refresh, load };
}
