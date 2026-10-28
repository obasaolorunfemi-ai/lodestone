/** Says which kind of 429 OpenRouter returned, because they mean different things
 *  and need different advice: a brand-new key is far more likely to meet the free
 *  models being busy upstream, or the account's daily free-model allowance, than a
 *  per-key limit of its own. Reads only the error body the provider sends. */

export type RateLimitKind = 'daily' | 'minute' | 'upstream' | 'other';

export interface RateLimitReading { kind: RateLimitKind; resetAt?: Date; limit?: number }

export function readRateLimit(rawBody: string): RateLimitReading {
  let body: { error?: { message?: string; metadata?: { headers?: Record<string, string>; raw?: string; provider_name?: string } } } = {};
  try { body = JSON.parse(rawBody); } catch { /* not JSON: judged by its text */ }
  const msg = `${body.error?.message ?? ''} ${body.error?.metadata?.raw ?? ''} ${rawBody.slice(0, 400)}`.toLowerCase();
  const headers = body.error?.metadata?.headers ?? {};
  const resetMs = Number(headers['X-RateLimit-Reset'] ?? headers['x-ratelimit-reset']);
  const limit = Number(headers['X-RateLimit-Limit'] ?? headers['x-ratelimit-limit']);
  const resetAt = Number.isFinite(resetMs) && resetMs > 1e12 ? new Date(resetMs) : undefined;
  const extra = { ...(resetAt ? { resetAt } : {}), ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}) };

  if (/per-day|per day|free-models-per-day|daily/.test(msg)) return { kind: 'daily', ...extra };
  if (/per-minute|per minute|requests per minute/.test(msg)) return { kind: 'minute', ...extra };
  if (/upstream|provider returned error|temporarily rate-limited|provider_name/.test(msg) || body.error?.metadata?.provider_name) return { kind: 'upstream', ...extra };
  return { kind: 'other', ...extra };
}
