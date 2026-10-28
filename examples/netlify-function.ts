// A Netlify function that asks a model for JSON, written so it keeps working when a model is
// withdrawn, slow or rate-limited. Needs OPENROUTER_API_KEY (and, for a second route, GROQ_API_KEY).
import { createHealth, createLodestone, explain, groq, LodestoneError } from '@extrafemi-ai/lodestone';
import { getStore } from '@netlify/blobs';
import type { Handler } from '@netlify/functions';

// Where Lodestone keeps what it learns: the model catalogue, which models are failing, saved answers.
// Blob keys cannot contain colons, so they are made simple.
const blobs = getStore('lodestone');
const simple = (k: string) => k.replace(/[^a-z0-9._-]/gi, '-');
export const store = { get: (k: string) => blobs.get(simple(k), { type: 'json' }), set: (k: string, v: unknown) => blobs.setJSON(simple(k), v) };

export const ai = createLodestone({
  openrouter: { apiKey: process.env.OPENROUTER_API_KEY },
  fallbacks: process.env.GROQ_API_KEY ? [{ provider: groq(), apiKey: process.env.GROQ_API_KEY, models: ['llama-3.3-70b-versatile'], free: true }] : [],
  store,
  health: createHealth({ store }),   // a model that keeps failing is skipped by every function until it recovers
  budgetMs: 24_000,                  // Netlify cuts a function off at 30 seconds
});

interface Summary { title: string; points: string[] }
const isSummary = (v: unknown): v is Summary => typeof v === 'object' && v !== null && typeof (v as Summary).title === 'string' && Array.isArray((v as Summary).points);

export const handler: Handler = async (event) => {
  try {
    const { text } = JSON.parse(event.body ?? '{}') as { text?: string };
    if (!text) return { statusCode: 400, body: JSON.stringify({ error: 'text is required' }) };
    // A model whose answer is not valid JSON of this shape is skipped for the next one.
    const r = await ai.json<Summary>({ prompt: `Summarise as JSON {"title": string, "points": string[]}:\n\n${text}`, tier: 'fast', validate: isSummary });
    return { statusCode: 200, body: JSON.stringify(r.data) };
  } catch (err) {
    // A sentence a person can be shown, not a stack trace.
    return { statusCode: err instanceof LodestoneError && err.kind === 'rate_limit' ? 429 : 502, body: JSON.stringify({ error: explain(err, { product: 'MyApp' }) }) };
  }
};
