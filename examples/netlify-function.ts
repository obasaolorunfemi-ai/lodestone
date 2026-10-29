// A Netlify function that asks a model for JSON, written so it keeps working when a model is
// withdrawn, slow or rate-limited. Needs OPENROUTER_API_KEY (and, for a second route, GROQ_API_KEY).
import { createHealth, createLodestone, createRateLimiter, createSpendLimit, explain, groq, LodestoneError, netlifyBlobsStore, upstashStore } from '@extrafemi-ai/lodestone';
import { getStore } from '@netlify/blobs';
import type { Handler } from '@netlify/functions';

// Where Lodestone keeps what it learns: the model catalogue, which models are failing, saved answers.
// Netlify Blobs cannot count atomically, so the per-caller limit and the spend ledger go in Upstash when it is set up
// (UPSTASH_URL and UPSTASH_TOKEN); without it they are exact inside one function instance and approximate between instances.
export const store = netlifyBlobsStore(getStore('lodestone'));
const counters = process.env.UPSTASH_URL ? upstashStore({ url: process.env.UPSTASH_URL, token: process.env.UPSTASH_TOKEN! }) : store;

export const ai = createLodestone({
  openrouter: { apiKey: process.env.OPENROUTER_API_KEY },
  fallbacks: process.env.GROQ_API_KEY ? [{ provider: groq(), apiKey: process.env.GROQ_API_KEY, models: ['llama-3.3-70b-versatile'], free: true }] : [],
  store,
  health: createHealth({ store }),   // a model that keeps failing is skipped by every function until it recovers
  spend: createSpendLimit({ store: counters, dailyUsd: 2 }),   // holds, so a burst cannot overshoot
  rateLimit: { limiter: createRateLimiter({ store: counters, max: 20 }), whenOver: 'free-only' },   // one person cannot empty it
  budgetMs: 24_000,                  // Netlify cuts a function off at 30 seconds
});

interface Summary { title: string; points: string[] }
const isSummary = (v: unknown): v is Summary => typeof v === 'object' && v !== null && typeof (v as Summary).title === 'string' && Array.isArray((v as Summary).points);

export const handler: Handler = async (event) => {
  try {
    const { text } = JSON.parse(event.body ?? '{}') as { text?: string };
    if (!text) return { statusCode: 400, body: JSON.stringify({ error: 'text is required' }) };
    // A model whose answer is not valid JSON of this shape is skipped for the next one.
    const caller = event.headers['x-nf-client-connection-ip'] ?? 'unknown';   // name who is calling, so each caller has their own allowance
    const r = await ai.json<Summary>({ prompt: `Summarise as JSON {"title": string, "points": string[]}:\n\n${text}`, tier: 'fast', validate: isSummary, caller });
    return { statusCode: 200, body: JSON.stringify(r.data) };
  } catch (err) {
    // A sentence a person can be shown, not a stack trace.
    return { statusCode: err instanceof LodestoneError && (err.kind === 'rate_limit' || err.kind === 'throttled') ? 429 : 502, body: JSON.stringify({ error: explain(err, { product: 'MyApp' }) }) };
  }
};
