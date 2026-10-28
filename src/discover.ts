import { eligible, rank, type CatalogModel } from './catalog.js';
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
  now: number;
}

export function resolveProviderModels(curated: string[], catalog: CatalogModel[] | null, o: ResolveOptions): string[] {
  if (!catalog || catalog.length === 0) return curated; // nothing known about what exists: use what the app named
  const max = o.max ?? 3;
  const byId = new Map(catalog.map((m) => [m.id, m]));
  const kept = curated.filter((id) => { const m = byId.get(id); return m !== undefined && vet(m, o.policy, { discovered: false, strict: o.strict, now: o.now }).ok; });
  if (!o.fill || kept.length >= max) return kept;
  const fill = eligible(catalog, o.tier, { promptUsdPerMTok: o.fill.maxPromptUsdPerMTok, completionUsdPerMTok: o.fill.maxCompletionUsdPerMTok })
    .filter((m) => !kept.includes(m.id) && vet(m, o.policy, { discovered: true, strict: o.strict, now: o.now }).ok)
    .sort((a, b) => rank(o.tier, a, b));
  for (const m of fill) { if (kept.length >= max) break; kept.push(m.id); }
  return kept;
}
