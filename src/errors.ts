import type { RateLimitReading } from './rateLimit.js';

/** A provider answered with an error status (or the request itself failed: status 599). */
export class ProviderError extends Error {
  constructor(public status: number, public body: string) {
    super(`provider error ${status}`);
    this.name = 'ProviderError';
  }
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
  /** No provider has a key. */
  | 'not_configured'
  | 'other';

/** Thrown when no model could answer. `kind` says why, so the caller can decide what
 *  to tell the person; `explain()` has a ready-made plain-language message. */
export class LodestoneError extends Error {
  constructor(
    public kind: FailureKind,
    public detail: { status?: number; rateLimit?: RateLimitReading; ownKey?: boolean; needsCredit?: boolean } = {}
  ) {
    super(`no model could answer: ${kind}`);
    this.name = 'LodestoneError';
  }
}
