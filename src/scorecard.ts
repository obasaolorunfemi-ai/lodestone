/** A model scorecard: measured results about models, in one format that anyone can
 *  produce and Lodestone can read. Naija Eval publishes one (translation and speech
 *  quality for Hausa, Igbo and Yoruba); Lodestone produces one of its own from live
 *  traffic (how often each model answered, and how fast). Lodestone uses a scorecard
 *  to put better models first, for tasks the scorecard measured. See docs/scorecards.md. */

export const SCORECARD_SCHEMA = 'model-scorecard/1';

export interface ModelScore {
  /** An OpenRouter model id (for example anthropic/claude-sonnet-5.5), or local/<name> for a model that is not routable. */
  model: string;
  /** What was measured: translate, transcribe, availability, latency... */
  task: string;
  /** How it was scored: chrf++, wer, success_rate, latency_p50_ms... */
  metric: string;
  value: number;
  higherIsBetter: boolean;
  /** How many items the score is based on. */
  n: number;
  /** The day it was measured, ISO (2026-10-08). */
  measuredAt: string;
  /** ISO 639-1 code of the language measured, when the task is about one. */
  language?: string;
  /** A finer cut, for example en->yo, or the provider for live stats. */
  slice?: string;
}

export interface Scorecard {
  schema: typeof SCORECARD_SCHEMA;
  /** Who measured it: naija-eval, lodestone-live... */
  source: string;
  generatedAt: string;
  scores: ModelScore[];
}

/** Which scores to look at when ordering models for a task. */
export interface QualityQuery {
  task: string;
  metric: string;
  language?: string;
  slice?: string;
}

export interface RankOptions {
  /** Ignore scores based on fewer items than this. Default 30. */
  minN?: number;
  /** Ignore scores older than this. Default 365. */
  maxAgeDays?: number;
  now?: () => number;
}

export class ScorecardError extends Error {
  constructor(public problems: string[]) {
    super(`not a valid model scorecard: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? `; and ${problems.length - 3} more` : ''}`);
    this.name = 'ScorecardError';
  }
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v));

/** Checks a scorecard from outside (a file, a URL) and returns it typed. Throws a
 *  ScorecardError listing what is wrong. A scorecard with a schema version this
 *  library doesn't know is refused, not guessed at. */
export function parseScorecard(raw: unknown): Scorecard {
  const problems: string[] = [];
  const c = raw as Partial<Scorecard> | null;
  if (!c || typeof c !== 'object') throw new ScorecardError(['not an object']);
  if (c.schema !== SCORECARD_SCHEMA) problems.push(`schema is ${JSON.stringify(c.schema)}, expected ${SCORECARD_SCHEMA}`);
  if (!isStr(c.source)) problems.push('source is missing');
  if (!isDay(c.generatedAt)) problems.push('generatedAt is missing or not a date');
  if (!Array.isArray(c.scores)) problems.push('scores is not a list');
  else c.scores.forEach((s, i) => {
    const at = `scores[${i}]`;
    if (!isStr(s?.model)) problems.push(`${at}.model is missing`);
    if (!isStr(s?.task)) problems.push(`${at}.task is missing`);
    if (!isStr(s?.metric)) problems.push(`${at}.metric is missing`);
    if (!isNum(s?.value)) problems.push(`${at}.value is not a number`);
    if (typeof s?.higherIsBetter !== 'boolean') problems.push(`${at}.higherIsBetter is not true or false`);
    if (!isNum(s?.n) || s.n < 0) problems.push(`${at}.n is not a count`);
    if (!isDay(s?.measuredAt)) problems.push(`${at}.measuredAt is not a date`);
  });
  if (problems.length) throw new ScorecardError(problems);
  return c as Scorecard;
}

/** Fetches and checks a scorecard from a URL. Throws if it can't be read or isn't valid. */
export async function fetchScorecard(url: string, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<Scorecard> {
  const res = await (opts.fetch ?? fetch)(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 8_000) });
  if (!res.ok) throw new Error(`scorecard ${url}: ${res.status}`);
  return parseScorecard(await res.json());
}

/** An id without its variant suffix: anthropic/claude-x:free is the same model as anthropic/claude-x. */
export const baseModelId = (id: string): string => id.split(':')[0].toLowerCase();

function matches(s: ModelScore, q: QualityQuery): boolean {
  return s.task === q.task && s.metric === q.metric && (q.language === undefined || s.language === q.language) && (q.slice === undefined || s.slice === q.slice);
}

/** The score for a model on a query, or undefined if nobody measured it well enough.
 *  Where several scorecards measured the same thing, the one based on most items wins. */
export function scoreFor(cards: Scorecard[], model: string, q: QualityQuery, opts: RankOptions = {}): ModelScore | undefined {
  const minN = opts.minN ?? 30;
  const oldest = (opts.now ?? Date.now)() - (opts.maxAgeDays ?? 365) * 86_400_000;
  const id = baseModelId(model);
  let best: ModelScore | undefined;
  for (const card of cards) for (const s of card.scores) {
    if (baseModelId(s.model) !== id || !matches(s, q) || s.n < minN || Date.parse(s.measuredAt) < oldest) continue;
    if (!best || s.n > best.n || (s.n === best.n && s.measuredAt > best.measuredAt)) best = s;
  }
  return best;
}

/** Puts measured models in order of their score, without moving anything else. The
 *  measured models take turns in the slots they already occupy; a model nobody has
 *  measured stays exactly where it was, so a good unmeasured model is never pushed
 *  down by a weaker measured one. Nothing is added or dropped. */
export function rankModels(models: string[], cards: Scorecard[], q: QualityQuery, opts: RankOptions = {}): string[] {
  const measured = models.map((m, i) => ({ m, i, s: scoreFor(cards, m, q, opts) })).filter((x): x is { m: string; i: number; s: ModelScore } => x.s !== undefined);
  if (measured.length < 2) return models;
  const sorted = [...measured].sort((a, b) => (a.s.higherIsBetter ? b.s.value - a.s.value : a.s.value - b.s.value) || a.i - b.i);
  const out = [...models];
  measured.forEach((slot, k) => { out[slot.i] = sorted[k].m; });
  return out;
}
