import { LodestoneError } from './errors.js';

export interface ExplainOptions {
  /** What to call the product in messages. Default: "the app". */
  product?: string;
  /** Where a person can add their own key, e.g. "in Settings". Omit if there is none. */
  settingsHint?: string;
}

/** A plain-language message a person can be shown for a failure. Written for the
 *  person, not the developer: it says what happened and what to try. */
export function explain(err: unknown, opts: ExplainOptions = {}): string {
  const product = opts.product ?? 'the app';
  const settings = opts.settingsHint ? ` ${opts.settingsHint}` : '';
  if (!(err instanceof LodestoneError)) return 'Something went wrong talking to the AI provider. Try again in a moment.';
  const { kind, detail } = err;
  const own = Boolean(detail.ownKey);
  switch (kind) {
    case 'slow':
      return 'The AI is slow right now and did not answer in time. Try again in a minute.';
    case 'auth':
      return own
        ? `Your OpenRouter key was rejected. Double-check it${settings}, or remove it to use ${product}'s shared AI.`
        : `${product}'s AI provider isn't configured correctly right now. This isn't something you can fix. Try again shortly.`;
    case 'rate_limit': {
      const r = detail.rateLimit;
      const when = r?.resetAt ? ` It resets around ${r.resetAt.toUTCString().slice(17, 22)} UTC.` : '';
      const credit = detail.needsCredit && own ? ' If you add a little credit (even $1) on openrouter.ai, a very low-cost model will be used on your key whenever the free ones are busy.' : '';
      switch (r?.kind) {
        case 'daily':
          return (own
            ? `Your OpenRouter account has used its free-model allowance for today${r.limit ? ` (${r.limit} requests)` : ''}.${when} Adding a little credit on openrouter.ai raises it a lot, or try again tomorrow.`
            : `${product}'s shared AI budget for today is used up. Try again after midnight UTC${opts.settingsHint ? `, or add your own OpenRouter key${settings}` : ''}.`) + credit;
        case 'minute':
          return 'Too many AI requests in a minute. Wait about a minute and try again.' + credit;
        case 'upstream':
          return 'The free AI models are busy right now: the provider behind them is limiting requests, not your key. Try again in a minute.' + credit;
        default:
          return (own
            ? 'OpenRouter is limiting requests for your key right now. This is often the free models being busy rather than your own limit, so try again in a minute.'
            : `${product}'s shared AI budget is under heavy load right now. Try again shortly${opts.settingsHint ? `, or add your own OpenRouter key${settings} to skip the wait` : ''}.`) + credit;
      }
    }
    case 'withdrawn':
      return `The AI models ${product} uses just changed on the provider's side. Try again in a few minutes.`;
    case 'unavailable':
      return `The AI provider is having issues right now, not ${product}. Try again in a few minutes.`;
    case 'bad_output':
      return "The AI gave back something that couldn't be read. Try again; it usually works on a second attempt.";
    case 'credit':
      return 'The AI account has no credit for the backup model. Add a little credit and try again.';
    case 'aborted':
      return 'Cancelled.';
    case 'budget':
      return `${product}'s AI budget for now is used up, and the free models are busy. Try again later${opts.settingsHint ? `, or add your own OpenRouter key ${opts.settingsHint.replace(/^in /, 'in ')} to keep going` : ''}.`;
    case 'not_configured':
      return `${product}'s AI isn't set up yet.`;
    default:
      return 'Something went wrong talking to the AI provider. Try again in a moment.';
  }
}
