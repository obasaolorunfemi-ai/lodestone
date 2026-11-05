import { eligible, rank, takesImages, type CatalogModel } from './catalog.js';
import { vet, type TrustPolicy } from './trust.js';
import type { Tier } from './types.js';

/** Keeps a provider's list of models alive without anyone editing it: a model the provider no
 *  longer lists is dropped, one that is retiring soon or that the trust policy refuses is dropped,
 *  and if the list is then short, it is filled from the provider's own catalogue with models that are
 *  within a price limit and made by a trusted publisher. Filling only ever adds models after the
 *  app's own, and never above `max`, so the list a request walks stays short however many models
 *  a provider offers. */

export interface FillOptions {
  /** The most a filled-in model may cost, in US dollars per million tokens. { prompt: 0, completion: 0 } is "free". */
  maxPromptUsdPerMTok: number;
  maxCompletionUsdPerMTok: number;
}

export interface ResolveOptions {
  tier: Tier;
  policy?: TrustPolicy;
  strict?: boolean;
  fill?: FillOptions;
  /** The most models to return. Default 3. */
  max?: number;
  /** When a model the app named has gone (retired, no longer listed, or about to be), put the provider's newest current model of the same line in its place. Off by default: a replacement can cost more, answer differently, or need other settings, so it is something you switch on, and it is always reported (see healProviderModels). Needs a provider that publishes a `line` for its models (Anthropic does). */
  replaceRetired?: boolean;
  /** The provider's way of reading a line from an id, for a named model it no longer lists. */
  lineOf?: (id: string) => string | undefined;
  now: number;
}

export interface Healed {
  models: string[];
  /** A named model that was swapped for the newest current model of its line. */
  replaced: { from: string; to: string; reason: GoneReason }[];
  /** A named model that has gone and could not be replaced, with why. */
  unreplaced: { id: string; reason: GoneReason; note?: string }[];
}
export type GoneReason = 'withdrawn' | 'retired' | 'expiring';

/** Why a named model cannot be used any more, or undefined if it still can. A model the trust policy refuses for another reason is dropped by the caller, not replaced. */
function gone(id: string, byId: Map<string, CatalogModel>, o: ResolveOptions): GoneReason | undefined | 'refused' {
  const m = byId.get(id);
  if (!m) return 'withdrawn';
  if (m.lifecycle === 'retired') return 'retired';
  const v = vet(m, o.policy, { discovered: false, strict: o.strict, now: o.now });
  return v.ok ? undefined : v.reason === 'expiring' ? 'expiring' : 'refused';
}

const released = (m: CatalogModel): number => { const t = Date.parse(m.created_at ?? ''); return Number.isFinite(t) ? t : 0; };
/** Compares two dotted version numbers ("3.10" is newer than "3.8"); a model with no version sorts as oldest. */
const versionOf = (m: CatalogModel): number[] => (m.version ?? '').split('.').map(Number).filter(Number.isFinite);
const newerVersion = (a: CatalogModel, b: CatalogModel): number => {
  const x = versionOf(a), y = versionOf(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (y[i] ?? 0) - (x[i] ?? 0); if (d !== 0) return d; }
  return 0;
};

/** The list to use, and what was changed in it: a gone model is dropped, and with `replaceRetired` swapped
 *  for the newest model of the same line (never one the app already named, never a deprecated or retired
 *  one, and only one the trust policy accepts and that can read images when the tier needs it). */
export function healProviderModels(curated: string[], catalog: CatalogModel[] | null, o: ResolveOptions): Healed {
  if (!catalog || catalog.length === 0) return { models: curated, replaced: [], unreplaced: [] }; // nothing known about what exists: use what the app named
  const max = o.max ?? 3;
  const byId = new Map(catalog.map((m) => [m.id, m]));
  const kept: string[] = [];
  const replaced: Healed['replaced'] = [];
  const unreplaced: Healed['unreplaced'] = [];
  for (const id of curated) {
    const why = gone(id, byId, o);
    if (why === undefined) { kept.push(id); continue; }
    if (why === 'refused') continue;
    if (!o.replaceRetired) continue;
    const line = byId.get(id)?.line ?? o.lineOf?.(id);
    if (!line) { unreplaced.push({ id, reason: why, note: byId.has(id) ? 'the provider names no line for it' : 'no longer listed, so its line is unknown' }); continue; }
    const to = catalog
      .filter((m) => m.line === line && (m.lifecycle === undefined || m.lifecycle === 'active') && !curated.includes(m.id) && !kept.includes(m.id) && !replaced.some((r) => r.to === m.id)
        && (o.tier !== 'vision' || takesImages(m)) && vet(m, o.policy, { discovered: true, strict: o.strict, now: o.now }).ok)
      .sort((a, b) => released(b) - released(a) || newerVersion(a, b) || a.id.localeCompare(b.id))[0];
    if (!to) { unreplaced.push({ id, reason: why, note: `no current ${line} model to take its place` }); continue; }
    kept.push(to.id);
    replaced.push({ from: id, to: to.id, reason: why });
  }
  if (!o.fill || kept.length >= max) return { models: kept, replaced, unreplaced };
  const fill = eligible(catalog, o.tier, { promptUsdPerMTok: o.fill.maxPromptUsdPerMTok, completionUsdPerMTok: o.fill.maxCompletionUsdPerMTok })
    .filter((m) => !kept.includes(m.id) && m.lifecycle !== 'retired' && vet(m, o.policy, { discovered: true, strict: o.strict, now: o.now }).ok)
    .sort((a, b) => rank(o.tier, a, b));
  for (const m of fill) { if (kept.length >= max) break; kept.push(m.id); }
  return { models: kept, replaced, unreplaced };
}

export const resolveProviderModels = (curated: string[], catalog: CatalogModel[] | null, o: ResolveOptions): string[] => healProviderModels(curated, catalog, o).models;
