// Calls each fallback provider once, live, through Lodestone, and prints what happened. Keys come from the
// environment and are never printed. Run it with the keys you want to test:
//   GROQ_API_KEY=... REQUESTY_API_KEY=... LLMAPI_API_KEY=... node scripts/live-check.mjs
// It makes one tiny request per key (a few tokens), so the cost is a fraction of a cent.
import { createLodestone, groq, requesty, llmapi, cerebras, explain } from '../dist/index.js';

const checks = [
  ['groq()', process.env.GROQ_API_KEY, groq, ['llama-3.3-70b-versatile']],
  ['requesty()', process.env.REQUESTY_API_KEY, requesty, ['bedrock/claude-haiku-5-5']],
  ['llmapi()', process.env.LLMAPI_API_KEY, llmapi, ['gemini-3.8-flash']],
  ['cerebras()', process.env.CEREBRAS_API_KEY, cerebras, ['llama-3.3-70b']],
];
const rows = [];
for (const [name, key, preset, models] of checks) {
  if (!key) { rows.push({ preset: name, result: 'skipped: no key set' }); continue; }
  const attempts = [];
  const ai = createLodestone({ fallbacks: [{ provider: preset(), apiKey: key, models, free: name === 'groq()' || name === 'cerebras()' }], onAttempt: (e) => attempts.push(e) });
  const t0 = Date.now();
  try {
    const r = await ai.json({ prompt: 'Reply with only this JSON: {"ok":true}', maxTokens: 20, validate: (v) => v?.ok === true });
    rows.push({ preset: name, result: 'answered', model: r.model, seconds: +((Date.now() - t0) / 1000).toFixed(1), usage: r.usage ?? null });
  } catch (err) {
    rows.push({ preset: name, result: 'failed', kind: err.kind, seconds: +((Date.now() - t0) / 1000).toFixed(1), say: explain(err, { product: 'check' }), attempts: attempts.map((a) => `${a.model}: ${a.outcome}${a.status ? ' ' + a.status : ''}`) });
  }
  // The model-list reader too: does it parse the service's real list?
  try {
    const list = await ai.checkModels();
    rows.push({ preset: name + ' list', result: list.ok ? 'read' : 'not read', detail: JSON.stringify(list).slice(0, 160) });
  } catch (err) { rows.push({ preset: name + ' list', result: 'error', detail: String(err.message).slice(0, 120) }); }
}
console.table(rows.map((r) => ({ ...r, usage: r.usage ? JSON.stringify(r.usage) : '' , attempts: r.attempts?.join('; ') ?? '' })));
