import type { RateLimitReading } from './rateLimit.js';

/** A provider answered with an error status (or the request itself failed: status 599). */
export class ProviderError extends Error {
  /** The provider's raw response. Some providers repeat part of the prompt in an error, so this is not an own enumerable property:
   *  `console.log(err)` and JSON.stringify(err) leave it out. Read it deliberately, as `err.body`. */
  declare body: string;
  constructor(public status: number, body: string) {
    super(`provider error ${status}`);
    this.name = 'ProviderError';
    Object.defineProperty(this, 'body', { value: body, enumerable: false, writable: true, configurable: true });
  }
}

/** The human-readable message inside a provider's error body ({"error":{"message":"..."}} or {"message":"..."}), if it has one. */
export function messageFrom(body: string): string | undefined {
  try {
    const j = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    const m = typeof j.error === 'string' ? j.error : j.error?.message ?? j.message;
    return typeof m === 'string' && m.trim() ? m.trim().slice(0, 300) : undefined;
  } catch { return undefined; }
}

export type FailureKind =
  /** The key was rejected. Another model on the same key will not differ. */
  | 'auth'
  /** Rate limited. See `rateLimit` for which kind. */
  | 'rate_limit'
  /** Every attempt timed out. */
  | 'slow'
  /** The account has no credit for the paid fallback. */
  | 'credit'
  /** Models the provider no longer has (404). */
  | 'withdrawn'
  /** The provider returned a server error. */
  | 'unavailable'
  /** A model answered but the answer was not usable (empty, not valid JSON, failed validation). */
  | 'bad_output'
  /** The caller stopped the call (it passed a signal that was aborted). */
  | 'aborted'
  /** The platform's spend limit has been reached, so no paid model was used. */
  | 'budget'
  /** This caller has made too many calls in the time allowed (see `rateLimit`). `detail.retryAfterMs` says when to try again. */
  | 'throttled'
  /** No provider has a key. */
  | 'not_configured'
  | 'other';

/** Thrown when no model could answer. `kind` says why, so the caller can decide what
 *  to tell the person; `explain()` has a ready-made plain-language message. */
export class LodestoneError extends Error {
  constructor(
    public kind: FailureKind,
    public detail: { status?: number; rateLimit?: RateLimitReading; ownKey?: boolean; needsCredit?: boolean; providerMessage?: string; retryAfterMs?: number } = {}
  ) {
    super(`no model could answer: ${kind}`);
    this.name = 'LodestoneError';
  }
}
