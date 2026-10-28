import { createCatalog, pickModels, ROUTER, type CatalogModel } from './catalog.js';
import { LodestoneError, ProviderError, type FailureKind } from './errors.js';
import { tryParseJson } from './json.js';
import { DEFAULT_MODELS, DEFAULT_PAID_MODELS } from './models.js';
import { readRateLimit, type RateLimitReading } from './rateLimit.js';
import { openrouter } from './providers/openrouter.js';
import { memoryStore } from './store.js';
import type { ContentPart, KeyValueStore, Message, Provider, ProviderReply, Tier, Usage } from './types.js';

export interface Profile { tier: Tier; maxTokens?: number; temperature?: number }

export interface FallbackConfig {
  provider: Provider;
  apiKey: string;
  /** Tried in order. */
  models: string[];
}

export interface AttemptEvent {
  provider: string;
  model: string;
  phase: 'free' | 'paid' | 'fallback';
  outcome: 'ok' | 'timeout' | 'failed';
  status?: number;
  ms: number;
}

export interface LodestoneConfig {
  openrouter?: {
    /** The platform's key. A caller's own key (`apiKey` on a call) takes priority. */
    apiKey?: string;
    /** Use the paid models after the free ones fail, on the platform's key. A caller's own key always allows it. */
    allowPaid?: boolean;
    models?: Partial<Record<Tier, string[]>>;
    paidModels?: string[];
    /** Replace the OpenRouter adapter (tests, proxies). */
    provider?: Provider;
  };
  /** Other providers, each with its own key, tried after OpenRouter has failed. */
  fallbacks?: FallbackConfig[];
  /** Named tasks, so calls say what they are doing and not which model to use. */
  profiles?: Record<string, Profile>;
  /** Where the model catalogue and cached answers are kept. Default: memory. */
  store?: KeyValueStore;
  /** Everything has to finish inside this. Default 24 000 ms, under a 30 s gateway limit. */
  budgetMs?: number;
  /** Time limits for tuning and tests. */
  timing?: { freeSliceMs?: number; freeSliceWithLaterMs?: number; freePhaseWithLaterMs?: number; minSliceMs?: number };
  fetch?: typeof fetch;
  now?: () => number;
  /** Called after every model attempt: for logs and metrics. Never receives prompts or answers. */
  onAttempt?: (e: AttemptEvent) => void;
}

export interface CompleteOptions {
  /** A key in `profiles`. */
  task?: string;
  /** Overrides the profile's tier. Default: 'vision' if the messages contain an image, else 'fast'. */
  tier?: Tier;
  prompt?: string;
  messages?: Message[];
  system?: string;
  maxTokens?: number;
  temperature?: number;
  /** The caller's own OpenRouter key (bring your own key). Used instead of the platform's, and allows the paid fallback. */
  apiKey?: string;
  /** An answer that fails this check counts as a failed attempt, and the next model is tried. */
  accept?: (text: string) => boolean;
  /** Same key, same answer: the answer is saved and reused. Only for pure, repeatable tasks. */
  cacheKey?: string;
  cacheTtlMs?: number;
}

export interface CompleteResult {
  text: string;
  provider: string;
  model: string;
  usage?: Usage;
  cached?: boolean;
}

type Outcome =
  | { kind: 'ok'; reply: ProviderReply }
  | { kind: 'fail'; status: number; body: string; unusable?: boolean }
  | { kind: 'timeout' };

const hasImage = (messages: Message[]) => messages.some((m) => Array.isArray(m.content) && m.content.some((p: ContentPart) => p.type === 'image'));

export function createLodestone(config: LodestoneConfig = {}) {
  const budget = config.budgetMs ?? 24_000;
  const t = {
    freeSlice: config.timing?.freeSliceMs ?? 11_000,
    freeSliceLater: config.timing?.freeSliceWithLaterMs ?? 5_000,
    freePhaseLater: config.timing?.freePhaseWithLaterMs ?? 9_000,
    minSlice: config.timing?.minSliceMs ?? 3_000,
  };
  const now = config.now ?? Date.now;
  const store = config.store ?? memoryStore();
  const fetchImpl = config.fetch ?? fetch;
  const catalog = createCatalog(store, fetchImpl, now);
  const router = config.openrouter?.provider ?? openrouter({ fetch: fetchImpl });
  const prefs: Record<Tier, string[]> = { ...DEFAULT_MODELS, ...config.openrouter?.models };
  const paidModels = config.openrouter?.paidModels ?? DEFAULT_PAID_MODELS;
  const fallbacks = config.fallbacks ?? [];

  /** The ids to send for a tier: preferences that still exist, plus current replacements. Never throws, never waits on the network. */
  async function resolveModels(tier: Tier): Promise<string[]> {
    try { return pickModels(tier, await catalog.load(), prefs[tier]); } catch { return prefs[tier]; }
  }

  async function complete(opts: CompleteOptions): Promise<CompleteResult> {
    const messages: Message[] = opts.messages ?? (opts.prompt !== undefined ? [{ role: 'user', content: opts.prompt }] : []);
    if (messages.length === 0) throw new Error('complete() needs a prompt or messages');
    const profile = opts.task ? config.profiles?.[opts.task] : undefined;
    if (opts.task && !profile) throw new Error(`Unknown task "${opts.task}"`);
    const images = hasImage(messages);
    const tier: Tier = opts.tier ?? profile?.tier ?? (images ? 'vision' : 'fast');
    const maxTokens = opts.maxTokens ?? profile?.maxTokens ?? 3500;
    const temperature = opts.temperature ?? profile?.temperature ?? 0.2;

    const cacheSlot = opts.cacheKey ? `lodestone:cache:${opts.cacheKey}` : null;
    if (cacheSlot) {
      try {
        const hit = (await store.get(cacheSlot)) as (CompleteResult & { at: number }) | null;
        if (hit?.text && now() - hit.at < (opts.cacheTtlMs ?? 24 * 3_600_000) && (!opts.accept || opts.accept(hit.text))) return { text: hit.text, provider: hit.provider, model: hit.model, cached: true };
      } catch { /* a store that cannot be read is a cache miss */ }
    }

    const started = now();
    const left = () => budget - (now() - started);
    const orKey = opts.apiKey || config.openrouter?.apiKey;
    const paidAllowed = Boolean(opts.apiKey) || Boolean(config.openrouter?.allowPaid);
    const fbs = fallbacks.filter((f) => f.apiKey && (!images || f.provider.vision));
    const paidAvailable = Boolean(orKey) && paidAllowed && paidModels.length > 0;
    const later = paidAvailable || fbs.length > 0;
    const freeEnds = later ? t.freePhaseLater : budget;
    const freeLeft = () => Math.min(left(), freeEnds - (now() - started));

    let attempted = false;
    let last: Outcome | null = null;
    let rateLimited: Extract<Outcome, { kind: 'fail' }> | null = null;
    let authFailed = false;
    let needsCredit = false;

    const attempt = async (provider: Provider, apiKey: string, model: string, phase: AttemptEvent['phase'], ms: number): Promise<Outcome> => {
      attempted = true;
      const at = now();
      let out: Outcome;
      try {
        const reply = await provider.call({ model, system: opts.system, messages, maxTokens, temperature, apiKey, signal: AbortSignal.timeout(ms) });
        if (!reply.text.trim()) out = { kind: 'fail', status: 502, body: 'empty answer', unusable: true };
        else if (opts.accept && !opts.accept(reply.text)) out = { kind: 'fail', status: 422, body: 'answer failed the check', unusable: true };
        else out = { kind: 'ok', reply };
      } catch (e) {
        const name = (e as Error).name;
        if (name === 'TimeoutError' || name === 'AbortError') out = { kind: 'timeout' };
        else if (e instanceof ProviderError) out = { kind: 'fail', status: e.status, body: e.body };
        else out = { kind: 'fail', status: 599, body: (e as Error).message };
      }
      config.onAttempt?.({ provider: provider.name, model, phase, outcome: out.kind === 'ok' ? 'ok' : out.kind === 'timeout' ? 'timeout' : 'failed', status: out.kind === 'fail' ? out.status : undefined, ms: now() - at });
      last = out;
      return out;
    };

    const finish = async (provider: Provider, model: string, reply: ProviderReply): Promise<CompleteResult> => {
      const result: CompleteResult = { text: reply.text, provider: provider.name, model, usage: reply.usage };
      if (cacheSlot) await store.set(cacheSlot, { ...result, at: now() }).catch(() => {});
      return result;
    };

    // Phase 1: OpenRouter's free models. A withdrawn one has already been replaced by resolveModels.
    if (orKey) {
      const models = await resolveModels(tier);
      for (let i = 0; i < models.length && freeLeft() >= t.minSlice; i++) {
        const slice = i >= models.length - 1 ? freeLeft() : Math.min(later ? t.freeSliceLater : t.freeSlice, freeLeft());
        const out = await attempt(router, orKey, models[i], 'free', slice);
        if (out.kind === 'ok') return finish(router, models[i], out.reply);
        if (out.kind === 'fail') {
          if (out.status === 401) { authFailed = true; break; } // the key is wrong: no other model will differ
          if (out.status === 429) rateLimited = out;
        }
      }

      // Phase 2: a low-cost paid model, which is not under the free-model limits.
      if (paidAvailable && !authFailed) {
        for (const m of paidModels) {
          if (left() < t.minSlice) break;
          const out = await attempt(router, orKey, m, 'paid', left());
          if (out.kind === 'ok') return finish(router, m, out.reply);
          if (out.kind === 'fail') {
            if (out.status === 402) { needsCredit = true; break; }
            if (out.status === 401) break;
          }
        }
      }
    }

    // Phase 3: other providers, with their own keys.
    for (const fb of fbs) {
      for (const m of fb.models) {
        if (left() < t.minSlice) break;
        const out = await attempt(fb.provider, fb.apiKey, m, 'fallback', left());
        if (out.kind === 'ok') return finish(fb.provider, m, out.reply);
        if (out.kind === 'fail' && out.status === 401) break; // this provider's key is wrong: skip its other models
      }
    }

    // Nothing answered. Say why, using what the first useful failure told us.
    const ownKey = Boolean(opts.apiKey);
    if (!attempted) throw new LodestoneError('not_configured');
    const lastFail = last as Outcome | null;
    if (!rateLimited && lastFail?.kind === 'timeout') throw new LodestoneError('slow');
    const failure = rateLimited ?? (lastFail?.kind === 'fail' ? lastFail : null);
    const status = failure?.status ?? 0;
    const kind: FailureKind =
      failure?.unusable ? 'bad_output'
      : authFailed || status === 401 ? 'auth'
      : status === 429 ? 'rate_limit'
      : status === 404 ? 'withdrawn'
      : status >= 500 ? 'unavailable'
      : 'other';
    const rateLimit: RateLimitReading | undefined = status === 429 && failure ? readRateLimit(failure.body) : undefined;
    throw new LodestoneError(kind, { status, rateLimit, ownKey, needsCredit });
  }

  /** Like complete(), but the answer must be JSON (and pass `validate`, if given). A model whose answer isn't is skipped for the next. */
  async function json<T = unknown>(opts: CompleteOptions & { validate?: (value: unknown) => value is T }): Promise<CompleteResult & { data: T }> {
    const ok = (text: string) => {
      const v = tryParseJson(text);
      return v !== undefined && (!opts.validate || opts.validate(v));
    };
    const { validate: _v, ...rest } = opts;
    const accept = opts.accept ? (s: string) => ok(s) && opts.accept!(s) : ok;
    const result = await complete({ ...rest, accept });
    return { ...result, data: tryParseJson<T>(result.text) as T };
  }

  /** Fetches and saves OpenRouter's current catalogue. Run it daily. */
  const refreshCatalog = (): Promise<CatalogModel[] | null> => catalog.refresh();

  /** The daily health check: saves the catalogue, and says which preferred models have
   *  been withdrawn (harmless, they are replaced) and which tiers are left with fewer
   *  than two real models to try (not harmless). `ok` is false only when the
   *  catalogue cannot be read or a tier is short. */
  async function checkModels(): Promise<{ ok: boolean; error?: string; catalogSize?: number; withdrawn?: string[]; shortTiers?: Tier[] }> {
    const models = await catalog.refresh().catch(() => null);
    if (!models) return { ok: false, error: 'could not read the OpenRouter catalogue' };
    const ids = new Set(models.map((m) => m.id));
    const all = [...new Set([...Object.values(prefs).flat(), ...paidModels])].filter((m) => m !== ROUTER);
    const withdrawn = all.filter((m) => !ids.has(m));
    const shortTiers = (Object.keys(prefs) as Tier[]).filter((tier) => pickModels(tier, models, prefs[tier]).filter((m) => m !== ROUTER).length < 2);
    return { ok: shortTiers.length === 0, catalogSize: models.length, withdrawn, shortTiers };
  }

  return { complete, json, resolveModels, refreshCatalog, checkModels };
}

export type Lodestone = ReturnType<typeof createLodestone>;
