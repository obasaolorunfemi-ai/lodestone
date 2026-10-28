import { createCatalog, pickModels, ROUTER, type Catalog, type CatalogModel } from './catalog.js';
import { resolveProviderModels, type FillOptions } from './discover.js';
import type { TrustPolicy } from './trust.js';
import { CANDIDATES_SCHEMA, type Candidates, type Candidate } from './candidates.js';
import { LodestoneError, messageFrom, ProviderError, type FailureKind } from './errors.js';
import { tryParseJson } from './json.js';
import { DEFAULT_MODELS, DEFAULT_PAID_MODELS } from './models.js';
import { readRateLimit, type RateLimitReading } from './rateLimit.js';
import { anthropic } from './providers/anthropic.js';
import { google } from './providers/google.js';
import { openrouter } from './providers/openrouter.js';
import type { Health } from './health.js';
import { rankModels, type QualityQuery, type Scorecard } from './scorecard.js';
import type { Stats } from './stats.js';
import { memoryStore } from './store.js';
import type { ContentPart, KeyValueStore, Message, Provider, ProviderReply, Tier, Usage } from './types.js';

export interface Profile {
  tier: Tier;
  maxTokens?: number;
  temperature?: number;
  /** Put the models a scorecard measured best on this first. See `scorecards`. */
  quality?: QualityQuery;
}

export interface FallbackConfig {
  provider: Provider;
  apiKey: string;
  /** Tried in order. */
  models: string[];
  /** This provider costs nothing (a free tier, a local server): its calls are not counted against, or stopped by, the spend limit. */
  free?: boolean;
  /** Keep this provider's list alive from its own catalogue (needs a provider that can list its models): models it no longer offers, or that are retiring or refused by `trust`, are dropped, and with `fill` a short list is topped up with trusted models within a price limit, never above `max` (default 3). */
  discover?: { fill?: FillOptions; max?: number };
  /** Also use this provider when the caller supplied their own OpenRouter key. Default false: a fallback has the platform's key, and a caller's own key must never lead to the platform's money being spent. */
  allowWithCallerKey?: boolean;
}

export interface AttemptEvent {
  provider: string;
  model: string;
  phase: 'free' | 'paid' | 'fallback' | 'route';
  /** 'skipped': not tried, because the breaker had it down or the spend limit was reached. */
  outcome: 'ok' | 'timeout' | 'failed' | 'skipped';
  status?: number;
  ms: number;
}

/** Where the platform's money is counted. Only attempts that spend it go through: the paid models and the
 *  fallback providers on the platform's keys. A call on the caller's own key never does. */
export interface SpendControl {
  /** Asked before each such attempt. Return false once the limit is reached and that model is not used. */
  allow(info: { provider: string; model: string; phase: 'paid' | 'fallback' }): boolean | Promise<boolean>;
  /** Told after each such attempt that answered, with what it cost: the provider's own figure when it gives one (OpenRouter does), otherwise an estimate from the model's catalogue price, otherwise nothing. */
  record(info: { provider: string; model: string; phase: 'paid' | 'fallback'; usage?: Usage; costUsd?: number }): void | Promise<void>;
}

export interface LodestoneConfig {
  openrouter?: {
    /** The platform's key. A caller's own key (`apiKey` on a call) takes priority. */
    apiKey?: string;
    /** Use the paid models after the free ones fail, on the platform's key. A caller's own key always allows it. */
    allowPaid?: boolean;
    /** On the platform's key, try the paid models first and the free ones only if they fail or the spend limit is reached. For when the free models are too unreliable to be worth waiting for. Not applied to a caller's own key: it is their money, so their free models are still tried first. */
    paidFirst?: boolean;
    models?: Partial<Record<Tier, string[]>>;
    paidModels?: string[];
    /** Replace the OpenRouter adapter (tests, proxies). */
    provider?: Provider;
  };
  /** Provider adapters by name, for `route` steps. Defaults: openrouter, anthropic and google. Replace one (for example `openrouter({ lowReasoning: false })`) or add your own. */
  providers?: Record<string, Provider>;
  /** Other providers, each with its own key, tried after OpenRouter has failed. */
  fallbacks?: FallbackConfig[];
  /** Measured results about models (see scorecard.ts). With a `quality` query on the task
   *  or the call, the free, paid and fallback models are put in order of their score. Models
   *  nobody has measured keep their place. A function is called per request, so it can fetch
   *  and cache; if it fails or takes over 1.5 s the order is left alone. */
  scorecards?: Scorecard[] | (() => Promise<Scorecard[]>);
  /** What may be used, and what discovery may add by itself: trusted publishers, a block list, what providers say they do with prompts, retiring models. See trust.ts. */
  trust?: TrustPolicy;
  /** Skips models that have been failing, so a request does not spend its time on them (see health.ts). */
  health?: Health;
  /** Counts and limits the platform's spend. Without it nothing is counted or limited. */
  spend?: SpendControl;
  /** Records every attempt so you can publish how each model does (stats.scorecard()). */
  stats?: Stats;
  /** Named tasks, so calls say what they are doing and not which model to use. */
  profiles?: Record<string, Profile>;
  /** Where the model catalogue and cached answers are kept. Default: memory. */
  store?: KeyValueStore;
  /** Everything has to finish inside this. Default 24 000 ms, under a 30 s gateway limit. */
  budgetMs?: number;
  /** Time limits for tuning and tests. */
  timing?: { freeSliceMs?: number; freeSliceWithLaterMs?: number; freePhaseWithLaterMs?: number; minSliceMs?: number; paidSliceMs?: number };
  fetch?: typeof fetch;
  now?: () => number;
  /** Called after every model attempt: for logs and metrics. Never receives prompts or answers. */
  onAttempt?: (e: AttemptEvent) => void;
}

/** One attempt in an explicit route: this provider, this model, this key. */
export interface RouteStep {
  /** A name in `providers` (openrouter, anthropic, google by default). */
  provider: string;
  model: string;
  apiKey: string;
  /** Longest this step may take. Default: most of what is left, keeping some for the steps after it. */
  timeoutMs?: number;
}

/** What `json({ schema })` needs from a schema: Zod, Valibot (via its adapter) and ArkType-style libraries have it. */
export interface SafeParser<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

export interface CompleteOptions {
  /** Skip tiers and phases: try exactly these steps, in order, until one answers. For callers that choose their own provider and model per request. Temperature is left to the provider unless set. */
  route?: RouteStep[];
  /** A key in `profiles`. */
  task?: string;
  /** Overrides the profile's quality query. */
  quality?: QualityQuery;
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
  /** The prompt must not be kept or trained on (a CV, say). OpenRouter is told to use only providers that do not; other models are used only if their provider's list says so. Many free models cannot meet this, and the paid ones are used instead. */
  private?: boolean;
  /** Stops the call when the caller no longer wants the answer (the person left the page). */
  signal?: AbortSignal;
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
  | { kind: 'fail'; status: number; body: string; unusable?: boolean; message?: string }
  | { kind: 'timeout' }
  | { kind: 'aborted' };

const hasImage = (messages: Message[]) => messages.some((m) => Array.isArray(m.content) && m.content.some((p: ContentPart) => p.type === 'image'));

export interface CheckResult {
  ok: boolean;
  error?: string;
  catalogSize?: number;
  /** Preferred models the catalogue no longer lists (already replaced). */
  withdrawn?: string[];
  /** Models that stop being offered within a week (already left out). */
  expiring?: string[];
  shortTiers?: Tier[];
  /** The same check for each other provider that can list its models. */
  providers?: Record<string, { models: number; withdrawn: string[]; expiring: string[]; error?: string }>;
}

/** How many candidates are kept in the background for a tier. A request still tries at most three. */
const POOL = 8;
const ACTIVE = 3;

export function createLodestone(config: LodestoneConfig = {}) {
  const budget = config.budgetMs ?? 24_000;
  const t = {
    freeSlice: config.timing?.freeSliceMs ?? 11_000,
    freeSliceLater: config.timing?.freeSliceWithLaterMs ?? 5_000,
    freePhaseLater: config.timing?.freePhaseWithLaterMs ?? 9_000,
    minSlice: config.timing?.minSliceMs ?? 3_000,
    paidSlice: config.timing?.paidSliceMs ?? 12_000,
  };
  const now = config.now ?? Date.now;
  const store = config.store ?? memoryStore();
  const fetchImpl = config.fetch ?? fetch;
  const catalog = createCatalog(store, fetchImpl, now);
  const policy = config.trust;
  /** One catalogue per fallback provider that can list its models, kept in the same store. */
  const fbCatalogs = new Map<FallbackConfig, Catalog>();
  for (const fb of config.fallbacks ?? []) {
    if (fb.provider.listModels) fbCatalogs.set(fb, createCatalog(store, fetchImpl, now, { key: `lodestone:catalog:${fb.provider.name}`, list: () => fb.provider.listModels!(fb.apiKey) }));
  }
  const router = config.openrouter?.provider ?? openrouter({ fetch: fetchImpl });
  const prefs: Record<Tier, string[]> = { ...DEFAULT_MODELS, ...config.openrouter?.models };
  const paidModels = config.openrouter?.paidModels ?? DEFAULT_PAID_MODELS;
  const fallbacks = config.fallbacks ?? [];
  const registry: Record<string, Provider> = { openrouter: router, anthropic: anthropic({ fetch: fetchImpl }), google: google({ fetch: fetchImpl }), ...config.providers };

  /** The ids to send for a tier: preferences that still exist, plus current replacements. Never throws, never waits on the network. */
  async function resolveModels(tier: Tier): Promise<string[]> {
    try { return pickModels(tier, await catalog.load(), prefs[tier], { policy, now: now() }); } catch { return prefs[tier]; }
  }
  /** A longer, ranked list of live candidates for a tier, to choose from when some are down: the best models for the tier that exist, are allowed, and are not retiring. */
  async function resolvePool(tier: Tier, strict: boolean): Promise<string[]> {
    try { return pickModels(tier, await catalog.load(), prefs[tier], { policy, strict, depth: POOL, now: now() }); } catch { return prefs[tier]; }
  }
  /** A fallback provider's models for a tier: the app's own, pruned and topped up from the provider's catalogue. */
  async function resolveFallback(fb: FallbackConfig, tier: Tier, strict: boolean): Promise<string[]> {
    const cat = fbCatalogs.get(fb);
    if (!cat) return fb.models;
    try { return resolveProviderModels(fb.models, await cat.load(), { tier, policy, strict, fill: fb.discover?.fill, max: fb.discover?.max, now: now() }); } catch { return fb.models; }
  }

  /** The scorecards, or none: never throws and never holds a request up for long. */
  async function cards(): Promise<Scorecard[]> {
    const src = config.scorecards;
    if (!src) return [];
    if (Array.isArray(src)) return src;
    try { return await Promise.race([src(), new Promise<Scorecard[]>((resolve) => setTimeout(() => resolve([]), 1_500).unref?.())]); } catch { return []; }
  }

  /** What a call cost, estimated from the model's catalogue price, for providers that do not report it. */
  async function estimateCost(model: string, usage?: Usage): Promise<number | undefined> {
    if (!usage) return undefined;
    const m = (await catalog.load().catch(() => null))?.find((x) => x.id === model);
    const inP = Number(m?.pricing?.prompt);
    const outP = Number(m?.pricing?.completion);
    return Number.isFinite(inP) && Number.isFinite(outP) ? usage.inputTokens * inP + usage.outputTokens * outP : undefined;
  }

  async function complete(opts: CompleteOptions): Promise<CompleteResult> {
    const messages: Message[] = opts.messages ?? (opts.prompt !== undefined ? [{ role: 'user', content: opts.prompt }] : []);
    if (messages.length === 0) throw new Error('complete() needs a prompt or messages');
    const profile = opts.task ? config.profiles?.[opts.task] : undefined;
    if (opts.task && !profile) throw new Error(`Unknown task "${opts.task}"`);
    const images = hasImage(messages);
    const tier: Tier = opts.tier ?? profile?.tier ?? (images ? 'vision' : 'fast');
    const maxTokens = opts.maxTokens ?? profile?.maxTokens ?? 3500;
    const temperature = opts.temperature ?? profile?.temperature ?? (opts.route ? undefined : 0.2);

    const strict = Boolean(opts.private);
    if (opts.signal?.aborted) throw new LodestoneError('aborted');
    const quality = opts.quality ?? profile?.quality;
    const order = async (models: string[]) => (quality && models.length > 1 ? rankModels(models, await cards(), quality, { now }) : models);

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
    const fbs = fallbacks.filter((f) => f.apiKey && (!images || f.provider.vision) && (!opts.apiKey || f.allowWithCallerKey));
    const paidAvailable = Boolean(orKey) && paidAllowed && paidModels.length > 0;
    const later = paidAvailable || fbs.length > 0;
    const freeEnds = later ? t.freePhaseLater : budget;
    const freeLeft = () => Math.min(left(), freeEnds - (now() - started));

    let attempted = false;
    let last: Outcome | null = null;
    let rateLimited: Extract<Outcome, { kind: 'fail' }> | null = null;
    let authFailed = false;
    let needsCredit = false;
    let spendBlocked = false;
    const callerKey = Boolean(opts.apiKey);

    /** Drops the models the breaker has down, saying so. */
    const healthy = async (provider: Provider, list: string[], phase: AttemptEvent['phase']): Promise<string[]> => {
      if (!config.health) return list;
      const keep: string[] = [];
      for (const m of list) {
        if (await config.health.shouldSkip(provider.name, m)) config.onAttempt?.({ provider: provider.name, model: m, phase, outcome: 'skipped', ms: 0 });
        else keep.push(m);
      }
      return keep;
    };
    /** May the platform's money be spent on this attempt? A caller's own key is their money, not ours. */
    const mayUse = async (provider: Provider, model: string, phase: 'paid' | 'fallback', free = false): Promise<boolean> => {
      if (callerKey || free || !config.spend) return true;
      if (await config.spend.allow({ provider: provider.name, model, phase })) return true;
      spendBlocked = true;
      config.onAttempt?.({ provider: provider.name, model, phase, outcome: 'skipped', ms: 0 });
      return false;
    };

    const attempt = async (provider: Provider, apiKey: string, model: string, phase: AttemptEvent['phase'], ms: number): Promise<Outcome> => {
      attempted = true;
      const at = now();
      let out: Outcome;
      try {
        const timeout = AbortSignal.timeout(ms);
        const signal = opts.signal ? (typeof AbortSignal.any === 'function' ? AbortSignal.any([timeout, opts.signal]) : timeout) : timeout;
        const reply = await provider.call({ model, system: opts.system, messages, maxTokens, temperature, apiKey, signal, ...(strict ? { privacy: 'strict' as const } : {}) });
        if (!reply.text.trim()) out = { kind: 'fail', status: 502, body: 'empty answer', unusable: true };
        else if (opts.accept && !opts.accept(reply.text)) out = { kind: 'fail', status: 422, body: 'answer failed the check', unusable: true };
        else out = { kind: 'ok', reply };
      } catch (e) {
        const name = (e as Error).name;
        if (opts.signal?.aborted) out = { kind: 'aborted' };
        else if (name === 'TimeoutError' || name === 'AbortError') out = { kind: 'timeout' };
        else if (e instanceof ProviderError) out = { kind: 'fail', status: e.status, body: e.body, message: messageFrom(e.body) };
        else out = { kind: 'fail', status: 599, body: (e as Error).message };
      }
      if (out.kind === 'aborted') throw new LodestoneError('aborted'); // the person left: nothing more to try
      const event: AttemptEvent = { provider: provider.name, model, phase, outcome: out.kind === 'ok' ? 'ok' : out.kind === 'timeout' ? 'timeout' : 'failed', status: out.kind === 'fail' ? out.status : undefined, ms: now() - at };
      // A key or credit problem (401, 402, 403) says nothing about the model, so it is not counted against it.
      const credential = out.kind === 'fail' && [401, 402, 403].includes(out.status);
      // A call marked private can fail because few providers meet the rule: that says nothing about the model.
      if (!credential && !strict) { config.stats?.record(event); await config.health?.record(provider.name, model, out.kind === 'ok'); }
      config.onAttempt?.(event);
      last = out;
      return out;
    };

    const finish = async (provider: Provider, model: string, reply: ProviderReply, phase?: 'paid' | 'fallback', free = false): Promise<CompleteResult> => {
      const result: CompleteResult = { text: reply.text, provider: provider.name, model, usage: reply.usage };
      if (phase && !callerKey && !free && config.spend) {
        const costUsd = reply.usage?.costUsd ?? (await estimateCost(model, reply.usage));
        // A ledger that fails must never fail an answer the person is waiting for.
        try { await config.spend.record({ provider: provider.name, model, phase, usage: reply.usage, costUsd }); } catch { /* not counted */ }
      }
      if (cacheSlot) await store.set(cacheSlot, { ...result, at: now() }).catch(() => {});
      return result;
    };

    // An explicit route: exactly the steps the caller named, in order.
    if (opts.route?.length) {
      const steps = opts.route.filter((st) => st.apiKey);
      let firstFail: Extract<Outcome, { kind: 'fail' }> | null = null;
      for (let i = 0; i < steps.length; i++) {
        const st = steps[i];
        const provider = registry[st.provider];
        if (!provider) throw new Error(`Unknown provider "${st.provider}" in route`);
        if (images && !provider.vision) continue;
        if (left() <= 0) break;
        const isLast = i === steps.length - 1;
        const ms = Math.min(left(), st.timeoutMs ?? (isLast ? left() : Math.max(t.minSlice, Math.floor(left() * 0.6))));
        const out = await attempt(provider, st.apiKey, st.model, 'route', ms);
        if (out.kind === 'ok') return finish(provider, st.model, out.reply);
        if (out.kind === 'fail' && !firstFail) firstFail = out;
      }
      if (!attempted) throw new LodestoneError('not_configured');
      const lastRoute = last as Outcome | null;
      if (!firstFail && lastRoute?.kind === 'timeout') throw new LodestoneError('slow');
      throw classify(firstFail ?? (lastRoute?.kind === 'fail' ? lastRoute : null), Boolean(opts.apiKey), false, false);
    }

    // OpenRouter: the free models and the low-cost paid ones. Free first by default; paid first when the
    // platform's key is used and the free models are not worth waiting for (see paidFirst).
    const paidFirst = Boolean(config.openrouter?.paidFirst) && !callerKey && paidAvailable;

    /** The free models. A withdrawn one has already been replaced by resolveModels. */
    const runFree = async (): Promise<CompleteResult | null> => {
      const all = await order(await resolvePool(tier, strict));
      // Choose the live ones from the pool: a model that is down is replaced by the next best, so the
      // list a request walks stays short however long the pool is.
      const live = await healthy(router, all, 'free');
      const routerLive = live.includes(ROUTER);
      let models = [...live.filter((m) => m !== ROUTER).slice(0, ACTIVE - (routerLive ? 1 : 0)), ...(routerLive ? [ROUTER] : [])];
      // With nothing after the free models to fall back on, a model that may be down is still better than no attempt.
      if (models.length === 0 && !later && !paidFirst) models = all.slice(0, ACTIVE);
      // Behind a paid-first attempt the free models are a backup, and other providers may still be waiting their turn: an OpenRouter outage must not use up the whole budget on free models.
      const freeStartedAt = now();
      const leftHere = () => (paidFirst ? (fbs.length ? Math.min(left(), t.freePhaseLater - (now() - freeStartedAt)) : left()) : freeLeft());
      for (let i = 0; i < models.length && leftHere() >= t.minSlice; i++) {
        const slice = i >= models.length - 1 ? leftHere() : Math.min(later && !paidFirst ? t.freeSliceLater : t.freeSlice, leftHere());
        const out = await attempt(router, orKey!, models[i], 'free', slice);
        if (out.kind === 'ok') return finish(router, models[i], out.reply);
        if (out.kind === 'fail') {
          if (out.status === 401) { authFailed = true; break; } // the key is wrong: no other model will differ
          if (out.status === 429) rateLimited = out;
        }
      }
      return null;
    };

    /** A low-cost paid model, which is not under the free-model limits. */
    const runPaid = async (): Promise<CompleteResult | null> => {
      const paidAll = await order(paidModels);
      let paidList = await healthy(router, paidAll, 'paid');
      if (paidList.length === 0) paidList = paidAll; // never leave no paid attempt because of the breaker
      for (let i = 0; i < paidList.length; i++) {
        const m = paidList[i];
        if (left() < t.minSlice) break;
        if (!(await mayUse(router, m, 'paid'))) continue;
        // Going first, a paid model may not use all the time: the free models and other providers come after it and need some.
        const ms = paidFirst ? Math.min(left(), t.paidSlice) : left();
        const out = await attempt(router, orKey!, m, 'paid', ms);
        if (out.kind === 'ok') return finish(router, m, out.reply, 'paid');
        if (out.kind === 'fail') {
          if (out.status === 402) { needsCredit = true; break; }
          if (out.status === 401) break;
        }
      }
      return null;
    };

    if (orKey) {
      if (paidFirst) {
        const a = await runPaid(); if (a) return a;
        const b = authFailed ? null : await runFree(); if (b) return b;
      } else {
        const b = await runFree(); if (b) return b;
        if (paidAvailable && !authFailed) { const a = await runPaid(); if (a) return a; }
      }
    }

    // Phase 3: other providers, with their own keys.
    for (const fb of fbs) {
      const fbAll = await order(await resolveFallback(fb, tier, strict));
      let fbList = await healthy(fb.provider, fbAll, 'fallback');
      if (fbList.length === 0) fbList = fbAll;
      for (const m of fbList) {
        if (left() < t.minSlice) break;
        if (!(await mayUse(fb.provider, m, 'fallback', fb.free))) continue;
        const out = await attempt(fb.provider, fb.apiKey, m, 'fallback', left());
        if (out.kind === 'ok') return finish(fb.provider, m, out.reply, 'fallback', fb.free);
        if (out.kind === 'fail' && out.status === 401) break; // this provider's key is wrong: skip its other models
      }
    }

    // Nothing answered. Say why, using what the first useful failure told us.
    const ownKey = Boolean(opts.apiKey);
    if (spendBlocked) throw new LodestoneError('budget');
    if (!attempted) throw new LodestoneError('not_configured');
    const lastFail = last as Outcome | null;
    if (!rateLimited && lastFail?.kind === 'timeout') throw new LodestoneError('slow');
    throw classify(rateLimited ?? (lastFail?.kind === 'fail' ? lastFail : null), ownKey, authFailed, needsCredit);
  }

  /** Turns the failure that explains why nothing answered into a LodestoneError. */
  function classify(failure: Extract<Outcome, { kind: 'fail' }> | null, ownKey: boolean, authFailed: boolean, needsCredit: boolean): LodestoneError {
    const status = failure?.status ?? 0;
    const kind: FailureKind =
      failure?.unusable ? 'bad_output'
      : authFailed || status === 401 ? 'auth'
      : status === 429 ? 'rate_limit'
      : status === 404 ? 'withdrawn'
      : status >= 500 ? 'unavailable'
      : 'other';
    const rateLimit: RateLimitReading | undefined = status === 429 && failure ? readRateLimit(failure.body) : undefined;
    return new LodestoneError(kind, { status, rateLimit, ownKey, needsCredit, providerMessage: failure?.message });
  }

  /** Like complete(), but the answer must be JSON, and pass `validate` or `schema` if given. A model whose answer
   *  isn't is skipped for the next. `schema` is anything with a `safeParse` method, such as a Zod schema; `data`
   *  is then what the schema returns, so its defaults and transforms apply. */
  async function json<T = unknown>(opts: CompleteOptions & { validate?: (value: unknown) => value is T; schema?: SafeParser<T> }): Promise<CompleteResult & { data: T }> {
    const parse = (text: string): { ok: true; data: T } | { ok: false } => {
      const v = tryParseJson(text);
      if (v === undefined) return { ok: false };
      if (opts.validate && !opts.validate(v)) return { ok: false };
      if (opts.schema) {
        const r = opts.schema.safeParse(v);
        return r.success ? { ok: true, data: r.data } : { ok: false };
      }
      return { ok: true, data: v as T };
    };
    const { validate: _v, schema: _s, ...rest } = opts;
    const accept = opts.accept ? (s: string) => parse(s).ok && opts.accept!(s) : (s: string) => parse(s).ok;
    const result = await complete({ ...rest, accept });
    const done = parse(result.text);
    return { ...result, data: (done.ok ? done.data : tryParseJson<T>(result.text)) as T };
  }

  /** Fetches and saves OpenRouter's current catalogue. Run it daily. */
  const refreshCatalog = (): Promise<CatalogModel[] | null> => catalog.refresh();

  /** The daily health check: saves the catalogue, and says which preferred models have
   *  been withdrawn (harmless, they are replaced) and which tiers are left with fewer
   *  than two real models to try (not harmless). `ok` is false only when the
   *  catalogue cannot be read or a tier is short. */
  async function checkModels(): Promise<CheckResult> {
    const models = await catalog.refresh().catch(() => null);
    if (!models) return { ok: false, error: 'could not read the OpenRouter catalogue' };
    const ids = new Set(models.map((m) => m.id));
    const byId = new Map(models.map((m) => [m.id, m]));
    const all = [...new Set([...Object.values(prefs).flat(), ...paidModels])].filter((m) => m !== ROUTER);
    const withdrawn = all.filter((m) => !ids.has(m));
    const horizon = (policy?.expiringWithinDays ?? 7) * 86_400_000;
    const expiring = all.filter((m) => { const d = byId.get(m)?.expiration_date; return d !== undefined && Date.parse(d) - now() < horizon; });
    const shortTiers = (Object.keys(prefs) as Tier[]).filter((tier) => pickModels(tier, models, prefs[tier], { policy, now: now() }).filter((m) => m !== ROUTER).length < 2);

    // Every other provider that can list its models gets the same check: what has gone, and what is retiring.
    const providers: NonNullable<CheckResult['providers']> = {};
    for (const [fb, cat] of fbCatalogs) {
      const listed = await cat.refresh().catch(() => null);
      if (!listed) { providers[fb.provider.name] = { models: 0, withdrawn: [], expiring: [], error: 'could not read its model list' }; continue; }
      const have = new Map(listed.map((m) => [m.id, m]));
      providers[fb.provider.name] = {
        models: listed.length,
        withdrawn: fb.models.filter((m) => !have.has(m)),
        expiring: fb.models.filter((m) => { const d = have.get(m)?.expiration_date; return d !== undefined && Date.parse(d) - now() < horizon; }),
      };
    }
    return { ok: shortTiers.length === 0, catalogSize: models.length, withdrawn, expiring, shortTiers, ...(Object.keys(providers).length ? { providers } : {}) };
  }

  /** An answer already saved under this key, without calling any model: so a caller can serve it without counting it as a request. */
  async function peek(cacheKey: string, ttlMs = 24 * 3_600_000): Promise<CompleteResult | null> {
    try {
      const hit = (await store.get(`lodestone:cache:${cacheKey}`)) as (CompleteResult & { at: number }) | null;
      return hit?.text && now() - hit.at < ttlMs ? { text: hit.text, provider: hit.provider, model: hit.model, cached: true } : null;
    } catch { return null; }
  }

  /** Every model this instance can call, for an evaluator to benchmark (see candidates.ts). */
  async function candidates(): Promise<Candidates> {
    const byKey = new Map<string, Candidate>();
    const add = (id: string, provider: string, role: string) => {
      if (id === ROUTER) return;
      const k = `${provider}\u0000${id}`;
      const c = byKey.get(k) ?? { id, provider, roles: [] };
      if (!c.roles.includes(role)) c.roles.push(role);
      byKey.set(k, c);
    };
    for (const tier of Object.keys(prefs) as Tier[]) for (const id of await resolveModels(tier)) add(id, 'openrouter', `free:${tier}`);
    for (const id of paidModels) add(id, 'openrouter', 'paid');
    for (const fb of fallbacks) for (const id of fb.models) add(id, fb.provider.name, 'fallback');
    return { schema: CANDIDATES_SCHEMA, source: 'lodestone', generatedAt: new Date(now()).toISOString(), models: [...byKey.values()] };
  }

  return { complete, json, resolveModels, refreshCatalog, checkModels, candidates, peek };
}

export type Lodestone = ReturnType<typeof createLodestone>;
