import type { CatalogModel } from './catalog.js';

/** What may be used, and what may be added by itself. There is no vulnerability feed for hosted models,
 *  so this does not claim one. It checks what can really be checked, from what providers publish in
 *  their model lists and what the app decides:
 *
 *  - who made it: a model found by discovery is only used if its publisher is on a list of well-known
 *    labs (the app's own curated lists are its own decision and are not held to this);
 *  - what happens to the prompt: a model its provider says is trained on, or keeps prompts longer than
 *    allowed, is refused (Requesty publishes both for every model);
 *  - that it is not about to disappear: a model with an expiry date within a week is dropped;
 *  - an explicit block list. */

/** Well-known labs. A discovered model from anyone else is not added by itself. */
export const DEFAULT_PUBLISHERS = ['anthropic', 'google', 'openai', 'meta-llama', 'mistralai', 'nvidia', 'qwen', 'deepseek', 'microsoft', 'cohere', 'x-ai', 'amazon'];

export interface TrustPolicy {
  /** Who a discovered model may come from. Default: DEFAULT_PUBLISHERS. 'any' turns the check off. */
  publishers?: string[] | 'any';
  /** Never use these: exact model ids, or a publisher followed by a slash ("shady-lab/"). Applies to every model, curated or discovered. */
  block?: string[];
  /** Refuse a model its provider says is used for training. Where the provider does not say, a discovered model is refused and a curated one is allowed. */
  requireNoTraining?: boolean;
  /** Refuse a model that keeps prompts longer than this. Unknown is treated like requireNoTraining treats it. */
  maxRetentionDays?: number;
  /** Drop a model that stops being offered within this many days. Default 7. */
  expiringWithinDays?: number;
}

export interface VetContext {
  /** Found by discovery, not named by the app. */
  discovered: boolean;
  /** Treat unknown privacy facts as a refusal even for a curated model (a call marked private). */
  strict?: boolean;
  now: number;
}

export type Verdict = { ok: true } | { ok: false; reason: 'blocked' | 'untrusted-publisher' | 'trains-on-data' | 'unknown-data-policy' | 'retention' | 'expiring' };

/** The same lab goes by different names in different lists (Requesty says "mistral", OpenRouter "mistralai"; LLM API says "gemini-flash"). */
const ALIASES: Record<string, string> = { mistral: 'mistralai', meta: 'meta-llama', xai: 'x-ai', 'x.ai': 'x-ai', claude: 'anthropic', gemini: 'google', 'gemini-flash': 'google', 'gemini-pro': 'google', gemma: 'google', gpt: 'openai' };
export const publisherOf = (m: { id: string; publisher?: string }): string => { const raw = (m.publisher ?? m.id.split('/')[0]).toLowerCase(); return ALIASES[raw] ?? raw; };

export function vet(m: CatalogModel, policy: TrustPolicy | undefined, ctx: VetContext): Verdict {
  const p = policy ?? {};
  const pub = publisherOf(m);
  if ((p.block ?? []).some((b) => (b.endsWith('/') ? m.id.toLowerCase().startsWith(b.toLowerCase()) || pub === b.slice(0, -1).toLowerCase() : m.id === b))) return { ok: false, reason: 'blocked' };

  if (m.expiration_date) {
    const at = Date.parse(m.expiration_date);
    if (Number.isFinite(at) && at - ctx.now < (p.expiringWithinDays ?? 7) * 86_400_000) return { ok: false, reason: 'expiring' };
  }

  const unknownRefused = ctx.discovered || ctx.strict;
  if (p.requireNoTraining) {
    if (m.data_used_for_training === true) return { ok: false, reason: 'trains-on-data' };
    if (m.data_used_for_training === undefined && unknownRefused) return { ok: false, reason: 'unknown-data-policy' };
  }
  if (p.maxRetentionDays !== undefined) {
    if (m.data_retention_days !== undefined && m.data_retention_days > p.maxRetentionDays) return { ok: false, reason: 'retention' };
    if (m.data_retention_days === undefined && unknownRefused) return { ok: false, reason: 'unknown-data-policy' };
  }

  if (ctx.discovered && p.publishers !== 'any' && !(p.publishers ?? DEFAULT_PUBLISHERS).map((x) => x.toLowerCase()).includes(pub)) return { ok: false, reason: 'untrusted-publisher' };
  return { ok: true };
}
