// Builds the Lodestone site into site/public. The error sentences, the trust verdicts and the file map are
// produced here from the real library (dist/) and the real source tree, so the page cannot drift from the code.
//   npm run build && node site/build.mjs        (or: npm run site)
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(here, 'public');
const lib = await import(join(root, 'dist/index.js'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// 1. The failure kinds, with the library's own sentences.
const { LodestoneError, explain } = lib;
const E = (kind, detail = {}) => explain(new LodestoneError(kind, detail), { product: 'MyApp', settingsHint: 'in Settings' });
const errors = [
  ['auth', 'The key was rejected (401). Another model on the same key would fail the same way.', E('auth', { ownKey: false })],
  ['rate_limit', 'A limit was hit. detail.rateLimit says which: daily, per-minute, or a busy upstream.', E('rate_limit', { rateLimit: { kind: 'daily' }, ownKey: false })],
  ['slow', 'Every attempt timed out inside the time budget.', E('slow')],
  ['credit', 'The paid model needs credit that is not there (402).', E('credit')],
  ['withdrawn', 'The provider no longer has the model (404).', E('withdrawn')],
  ['unavailable', 'The provider returned a server error.', E('unavailable')],
  ['bad_output', 'Answers came back but none was usable: empty, not JSON, or failed your check.', E('bad_output')],
  ['budget', "The platform's spend limit stopped every paid option.", E('budget')],
  ['aborted', 'The caller stopped the call by aborting its signal.', E('aborted')],
  ['not_configured', 'No provider has a key.', E('not_configured')],
  ['other', "Anything else. detail.providerMessage keeps the provider's own words.", E('other')],
].map(([kind, what, say]) => ({ kind, what, say }));
errors.push({ kind: 'auth_own', what: '', say: E('auth', { ownKey: true }), hidden: true }); // for the simulator: a customer's own key was rejected
errors.push({ kind: 'rate_limit_own', what: '', say: E('rate_limit', { rateLimit: { kind: 'daily' }, ownKey: true }), hidden: true });

// 2. What the trust policy decides, on rows shaped like real lists, with the library's own vet().
const NOW = Date.parse('2026-10-28T12:00:00Z');
const rows = [
  ['google/gemma-4-31b-it:free', 'OpenRouter, publishes nothing on data use', { id: 'google/gemma-4-31b-it:free' }],
  ['shady-lab/free-llm:free', 'OpenRouter, a lab nobody has heard of', { id: 'shady-lab/free-llm:free' }],
  ['poolside/laguna-s-2.1:free', 'OpenRouter, retiring on 31 Oct 2026', { id: 'poolside/laguna-s-2.1:free', expiration_date: '2026-10-31' }],
  ['bedrock/claude-haiku-5-5', 'Requesty: not trained on, prompts kept 0 days', { id: 'bedrock/claude-haiku-5-5', publisher: 'anthropic', data_used_for_training: false, data_retention_days: 0 }],
  ['openai/gpt-6.1-terra:flex', 'Requesty: marked as trained on', { id: 'openai/gpt-6.1-terra:flex', publisher: 'openai', data_used_for_training: true, data_retention_days: 30 }],
  ['gemini-3.8-flash', 'LLM API, family "gemini-flash", publishes nothing on data use', { id: 'gemini-3.8-flash', publisher: 'gemini-flash' }],
];
const REASON = { 'untrusted-publisher': 'refused: lab not on the trusted list', 'unknown-data-policy': 'refused: provider does not say what happens to prompts', 'trains-on-data': 'refused: trained on', retention: 'refused: keeps prompts too long', expiring: 'refused: retiring within a week', blocked: 'refused: blocked' };
const cell = (v) => (v.ok ? '<span class="pill ok">used</span>' : `<span class="pill no">${esc(REASON[v.reason] ?? v.reason)}</span>`);
const vet = rows.map(([id, from, m]) => {
  const a = lib.vet(m, undefined, { discovered: true, now: NOW });
  const b = lib.vet(m, { requireNoTraining: true, maxRetentionDays: 30 }, { discovered: true, now: NOW });
  return `<tr><td><code>${esc(id)}</code><br><small>${esc(from)}</small></td><td>${cell(a)}</td><td>${cell(b)}</td></tr>`;
}).join('');

// 3. How far each provider preset has been checked. Edit this when that changes; it is a claim, so it is written by hand.
const providers = [
  ['requesty()', 'Requesty', 'ok', 'model list read live (807 chat models, with price, lab and data policy)', 'chat call not made: no key'],
  ['llmapi()', 'LLM API', 'ok', 'model list read live (152 chat of 393 models; image, video, speech and embedding ignored)', 'chat call not made: no key'],
  ['groq(), cerebras()', 'Groq, Cerebras', 'warn', 'endpoint answers (needs a key); free-tier terms not checked', 'untested with a key'],
  ['openai(), mistral(), together()', 'the providers themselves', 'warn', 'endpoint answers (needs a key)', 'untested with a key'],
  ['ollama()', 'a local server', 'warn', 'the standard local endpoint', 'untested here'],
  ['(built in) openrouter', 'OpenRouter', 'ok', 'used in production for the default path', 'catalogue, calls, cost and expiry dates all seen live'],
  ['anthropic(), google()', 'direct', 'warn', 'request shape tested against the documented format', 'not called live'],
].map(([preset, svc, tone, what, note]) => `<tr><td><code>${esc(preset)}</code></td><td>${esc(svc)}</td><td><span class="pill ${tone}">${tone === 'ok' ? 'checked' : 'partly'}</span> ${esc(what)}<br><small>${esc(note)}</small></td></tr>`).join('');

// 4. The code map, from the real tree.
const DESC = {
  'lodestone.ts': 'The core: createLodestone, the phases, the time budget, complete() and json()',
  'catalog.ts': "Reads a provider's catalogue; picks and ranks models; drops withdrawn ones",
  'trust.ts': 'The trust policy: trusted labs, block list, privacy and expiry checks',
  'discover.ts': "Keeps a provider's list alive and short: prune, then fill within a price limit",
  'health.ts': 'The circuit breaker: skips models that keep failing, shared across instances',
  'models.ts': 'Default free model lists per tier',
  'rateLimit.ts': 'Tells the four kinds of 429 apart',
  'errors.ts': 'LodestoneError, ProviderError and the failure kinds',
  'explain.ts': 'Turns an error into a sentence a person can read',
  'json.ts': 'Strips code fences and parses; json() uses it to skip bad answers',
  'scorecard.ts': 'Reads model-scorecard/1 and orders models by it',
  'stats.ts': 'Live success rate and speed per model, as a scorecard',
  'candidates.ts': 'model-candidates/1: the models in use, for an evaluator',
  'store.ts': 'A key-value store: memory by default, yours to share between functions',
  'types.ts': 'Shared types',
  'index.ts': 'Public exports',
};
const src = join(root, 'src');
const hasTest = (f) => existsSync(join(src, f.replace(/\.ts$/, '.test.ts')));
const BASE = 'https://github.com/obasaolorunfemi-ai/lodestone/blob/main/';
const files = readdirSync(src).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).sort();
const providerFiles = readdirSync(join(src, 'providers')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => f.replace('.ts', ''));
const filemap = files.map((f) => `<a class="file" href="${BASE}src/${f}"><code>${f}</code>${hasTest(f) ? '<span class="t">+tests</span>' : ''}<p>${esc(DESC[f] ?? '')}</p></a>`).join('')
  + `<a class="file" href="${BASE}src/providers"><code>providers/</code><p>Adapters: ${providerFiles.join(', ')}</p></a>`
  + `<a class="file" href="${BASE}examples"><code>examples/</code><p>A Netlify function, the daily check and a multi-provider setup, all type-checked in CI</p></a>`
  + `<a class="file" href="${BASE}.github/workflows"><code>.github/workflows</code><p>Tests, builds and publishes to npm with provenance on a version tag</p></a>`
  + `<a class="file" href="${BASE}docs/scorecards.md"><code>docs/scorecards.md</code><p>The two JSON formats in full</p></a>`;
const missing = files.filter((f) => !DESC[f]);
if (missing.length) throw new Error(`site/build.mjs has no description for: ${missing.join(', ')}`);

// 5. Write it out.
let commit = 'unknown';
try { commit = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim(); } catch { /* not a git checkout */ }
const date = new Date().toISOString().slice(0, 10);
const css = readFileSync(join(here, 'src/style.css'));
const js = readFileSync(join(here, 'src/app.js'));
const v = createHash('sha256').update(css).update(js).digest('hex').slice(0, 10);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const html = readFileSync(join(here, 'src/index.html'), 'utf8')
  .replaceAll('{{v}}', v).replaceAll('{{version}}', pkg.version).replaceAll('{{commit}}', commit).replaceAll('{{date}}', date)
  .replace('{{providers}}', providers).replace('{{vet}}', vet).replace('{{filemap}}', filemap)
  .replace('{{data}}', JSON.stringify({ errors }).replace(/</g, '\\u003c'));
writeFileSync(join(out, 'index.html'), html);
copyFileSync(join(here, 'src/style.css'), join(out, 'style.css'));
copyFileSync(join(here, 'src/app.js'), join(out, 'app.js'));
copyFileSync(join(here, 'src/favicon.svg'), join(out, 'favicon.svg'));
copyFileSync(join(here, 'src/_headers'), join(out, '_headers'));
copyFileSync(join(here, 'src/robots.txt'), join(out, 'robots.txt'));
writeFileSync(join(out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://lodestone.extrafemi.com/</loc><lastmod>${date}</lastmod></url></urlset>\n`);
writeFileSync(join(out, '404.html'), readFileSync(join(here, 'src/404.html'), 'utf8').replaceAll('{{v}}', v));
console.log(`site/public: Lodestone ${pkg.version} @ ${commit}, ${errors.length - 2} failure kinds, ${files.length} source files, ${rows.length} trust rows`);
