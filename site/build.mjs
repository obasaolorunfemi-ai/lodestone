// Builds the Lodestone site into site/public. The error sentences, the trust verdicts and the file map are
// produced here from the real library (dist/) and the real source tree, so the page cannot drift from the code.
//   npm run build && node site/build.mjs        (or: npm run site)
import { execSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(here, 'public');
const lib = await import(join(root, 'dist/index.js'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const RUNS_ON = JSON.parse(readFileSync(join(here, 'src/runs-on.json'), 'utf8'));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const NAV = [['/', 'Home'], ['/providers/', 'Providers'], ['/model-lists/', 'Model lists'], ['/when-everything-fails/', 'When everything fails'], ['/where-it-runs/', 'Where it runs'], ['/runs-on-lodestone/', 'Runs on Lodestone'], ['/limits/', 'Honest limits'], ['/getting-smarter/', 'Getting smarter'], ['/using-it/', 'Using it'], ['/docs/', 'Docs'], ['/code-map/', 'Code map'], ['/changelog/', 'Changelog'], ['/security/', 'Security'], ['https://github.com/obasaolorunfemi-ai/lodestone', 'GitHub']];
/** The site links, the same on every page. Docs pages count as Docs, so the Docs link is marked while you read one. */
const SECTIONS = [['for', 'Who for'], ['problem', 'Problem'], ['watch', 'Watch a call'], ['measured', 'Measured'], ['weather', 'Weather']];
/** The menu, the same on every page: the site's pages, then the sections of the home page. On the home page a section link is an in-page anchor; elsewhere it points at the home page. Weather is hidden until the home page finds counts to show. */
const navHtml = (path) => {
  const home = path === '';
  const pages = NAV.map(([h, t]) => {
    const here = h === '/' ? home : h.startsWith('/') && (path === h.slice(1, -1) || (h === '/docs/' && path.startsWith('docs')));
    return `<a href="${h}"${here ? ' aria-current="page"' : ''}>${t}</a>`;
  }).join('');
  const sections = SECTIONS.map(([id, t]) => `<a href="${home ? '' : '/'}#${id}"${id === 'weather' ? ' id="nav-weather" hidden' : ''}>${t}</a>`).join('');
  return `<div class="menu-group"><span class="tag">Pages</span>${pages}</div><div class="menu-group"><span class="tag">The walkthrough</span>${sections}</div>`;
};

/** A logo from the Simple Icons set (CC0), drawn inline in the text colour so it follows the light and dark theme. The marks are their owners' trademarks, shown to say what Lodestone can call and where it runs. */
const LOGO_PATHS = (file) => [...readFileSync(join(here, 'src/logos', file + '.svg'), 'utf8').matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
const logo = (file, name) => {
  const d = LOGO_PATHS(file);
  return d.length ? `<svg class="logo" viewBox="0 0 24 24" role="img" aria-label="${name} logo" fill="currentColor">${d.map((x) => `<path d="${x}"/>`).join('')}</svg>` : '';
};
// The scroll of providers on the home page. A dot says how far each has been checked, the same as the Providers page.
const STRIP = [['OpenRouter', 'live', 'openrouter'], ['Groq', 'live', 'groq'], ['Requesty', 'list', 'requesty'], ['OmniaKey', 'list', 'omniakey'], ['Cerebras', 'preset', null], ['OpenAI', 'preset', 'openai'], ['Mistral', 'preset', 'mistralai'], ['Together', 'preset', null], ['Ollama', 'preset', 'ollama'], ['Anthropic', 'preset', 'anthropic'], ['Google', 'preset', 'google']];
const STRIP_WORDS = { live: 'answered a live call', list: 'model list read', preset: 'preset, not yet called live' };
// Three providers have no mark in Simple Icons, so their own mark is shown as an image (see site/src/logos/README.md).
const BRAND_IMG = { groq: '/logos/groq.svg', requesty: '/logos/requesty.png', omniakey: '/logos/omniakey.svg' };
const stripLogo = (l, n) => (BRAND_IMG[l] ? `<img class="logo logo-img" src="${BRAND_IMG[l]}" alt="" width="22" height="22">` : l ? logo(l, n) : '');
const stripItems = STRIP.map(([n, k, l]) => `<li><i class="dot ${k}"></i>${stripLogo(l, n)}${n}</li>`).join('');
// Models seen answering in our own live checks on 28 and 29 October 2026 (the Measured section and the checks since). More are added in the browser from KeyStone's live counts once they exist.
const MODELS = [['claude-haiku-5.5', 'OpenRouter', 'anthropic'], ['gemini-3.8-flash', 'OpenRouter', 'googlegemini'], ['gpt-oss-20b', 'Groq', 'openai'], ['nemotron-3.5-lightning (free)', 'OpenRouter', 'nvidia'], ['mistral-small', 'OpenRouter', 'mistralai']];
const modelItems = MODELS.map(([m, p, l]) => `<li><i class="dot live"></i>${logo(l, m)}${m}<small>${p}</small></li>`).join('');
// The lab logos, for models the browser adds from KeyStone's live counts.
const LAB_LOGOS = Object.fromEntries(['anthropic', 'googlegemini', 'openai', 'nvidia', 'mistralai'].map((f) => [f, LOGO_PATHS(f)]));
const providerStrip = `<section class="provider-strip" aria-labelledby="strip-h"><p class="tag" id="strip-h">Calls through</p><div class="marquee" aria-hidden="true"><ul class="marquee-track">${stripItems.repeat(4)}</ul></div><ul class="visually-hidden">${STRIP.map(([n, k]) => `<li>${n}: ${STRIP_WORDS[k]}</li>`).join('')}</ul><p class="cap"><span class="key"><i class="dot live"></i>answered a live call</span><span class="key"><i class="dot list"></i>model list read</span><span class="key"><i class="dot preset"></i>preset, not yet called live</span> <a href="/providers/">How far each was checked</a></p><p class="tag strip-2">Models seen answering</p><div class="marquee rev" aria-hidden="true"><ul class="marquee-track" id="model-track">${modelItems.repeat(4)}</ul></div><ul class="visually-hidden" id="model-list">${MODELS.map(([m, p]) => `<li>${m}, through ${p}</li>`).join('')}</ul><script type="application/json" id="lab-logos">${JSON.stringify(LAB_LOGOS)}</script></section>`;
const THEME_BTN = '<button type="button" class="icon-btn" id="theme" aria-label="Switch to dark mode"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg></button>';
const MENU_BTN = '<button type="button" class="icon-btn menu-btn" id="menu" aria-expanded="false" aria-controls="sections" aria-label="Open menu"><svg class="i-open" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg><svg class="i-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>';
/** The top row of the site bar, the same on every page including the 404: brand, the menu with every site link, the light/dark switch and the menu button. */
const siteBar = (path) => `<div class="col sitebar-in"><a class="brand" href="/">Lodestone</a><nav class="sections" id="sections" aria-label="Site">${navHtml(path)}</nav>${THEME_BTN}${MENU_BTN}</div>`;
/** The slim footer, the same on every page except the home page, which has the full one. */
/** Down in Nigeria's status badge for a service, in a light and a dark version; the theme shows one. */
const DOWN = 'https://down.extrafemi.com';
const badge = (slug, style, w, h, alt) => `<img class="b-light" src="${DOWN}/badge/${slug}.svg?style=${style}&amp;accent=6b1410&amp;bg=fffefb&amp;radius=16" width="${w}" height="${h}" alt="${alt}" loading="lazy" decoding="async"><img class="b-dark" src="${DOWN}/badge/${slug}.svg?style=${style}&amp;theme=dark" width="${w}" height="${h}" alt="${alt}" loading="lazy" decoding="async">`;
const STATUS_ALT = 'Lodestone status, monitored by Down in Nigeria';
/** The footer, the same on every page: the status badge, the brand, the walkthrough, the pages and the project. On the home page the walkthrough links are in-page anchors; elsewhere they point at the home page. The Pages column is read from NAV, so a new page cannot be left out of it. */
const footHtml = (home) => {
  const up = home ? '' : '/';
  const li = (h, t) => `<li><a href="${h}">${t}</a></li>`;
  const walk = SECTIONS.filter(([id]) => id !== 'weather').map(([id, t]) => li(`${up}#${id}`, t)).join('');
  const SKIP = new Set(['/', '/changelog/', '/security/', 'https://github.com/obasaolorunfemi-ai/lodestone']);
  const pages = NAV.filter(([h]) => !SKIP.has(h)).map(([h, t]) => li(h, t)).join('') + li('/docs/python/', 'Python port');
  const project = [['https://github.com/obasaolorunfemi-ai/lodestone', 'GitHub'], ['https://www.npmjs.com/package/@extrafemi-ai/lodestone', 'npm'], ['/changelog/', 'Changelog'], ['/security/', 'Security'], ['https://naija-eval.extrafemi.com/', 'Naija Eval'], ['https://keystone.extrafemi.com/', 'KeyStone']].map(([h, t]) => li(h, t)).join('');
  return `<footer class="site-foot">${statusBlock}
  <div class="col foot-cols">
    <div><div class="mark">Lodestone</div><p>A small library that keeps AI calls working when a model is withdrawn, slow, rate-limited or down.</p></div>
    <nav aria-label="The walkthrough"><h3>The walkthrough</h3><ul>${walk}</ul></nav>
    <nav aria-label="Pages"><h3>Pages</h3><ul>${pages}</ul></nav>
    <nav aria-label="Project"><h3>Project</h3><ul>${project}</ul></nav>
  </div>
  <div class="col foot-base">
    <p>Lodestone ${pkg.version} · built from commit ${commit} on ${date} · MIT licence. Cardo and Lora are set in the SIL Open Font Licence and are served from this site.</p>
    <p>© 2026 Extrafemi · No cookies, no tracking. Your light or dark choice is kept in your browser, nowhere else.</p>
  </div>
</footer>`;
};
const statusBlock = `<section class="col status" aria-labelledby="status-h"><div class="status-head"><h2 id="status-h">Live status</h2><p>Checked around the clock, independently, by <a href="${DOWN}/developers">Down in Nigeria</a>. Tap a badge for its full record.</p></div><div class="status-grid"><a class="stat" href="${DOWN}/s/lodestone"><span class="tag">This site</span><span class="badges">${badge('lodestone', 'card', 272, 84, STATUS_ALT)}${badge('lodestone', 'chip', 212, 36, STATUS_ALT)}</span></a></div></section>`;

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
  ['throttled', 'This caller has used their allowance (rateLimit). detail.retryAfterMs says when to try again.', E('throttled', { retryAfterMs: 20 * 60_000 })],
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
const cell = (v) => (v.ok ? '<span class="chip ok">used</span>' : `<span class="chip no">${esc(REASON[v.reason] ?? v.reason)}</span>`);
const vet = rows.map(([id, from, m]) => {
  const a = lib.vet(m, undefined, { discovered: true, now: NOW });
  const b = lib.vet(m, { requireNoTraining: true, maxRetentionDays: 30 }, { discovered: true, now: NOW });
  return `<tr><td><code>${esc(id)}</code><br><small>${esc(from)}</small></td><td>${cell(a)}</td><td>${cell(b)}</td></tr>`;
}).join('');

// 3. How far each provider preset has been checked. Edit this when that changes; it is a claim, so it is written by hand.
const providers = [
  ['groq()', 'Groq', 'ok', 'a chat call answered live on 28 Oct 2026 (openai/gpt-oss-20b, about 1 s); the model list was read, 11 entries of which 4 are chat models', 'the list also holds speech and safety models, which Lodestone now leaves out; the model Lodestone first listed, llama-3.3-70b-versatile, had been withdrawn (a 404, reported as withdrawn)'],
  ['requesty()', 'Requesty', 'warn', 'key accepted and the model list read live (807 chat models, with price, lab and data policy)', 'the chat call was refused with 402, payment required, because the account had no credit, so no answer has been seen from it'],
  ['llmapi()', 'LLM API', 'ok', 'model list read live (152 chat of 393 models; image, video, speech and embedding ignored)', 'chat call not made: no key'],
  ['omniakey()', 'OmniaKey', 'warn', 'key accepted and the model list read live on 29 Oct 2026 (98 entries)', 'the list mixes chat, image, video and music models with nothing to tell them apart, so name your models and do not use discovery with it; the chat call was refused with 403, insufficient quota, because the account had no credit, so no answer has been seen from it'],
  ['cerebras()', 'Cerebras', 'warn', 'endpoint answers (needs a key); free-tier terms not checked', 'untested with a key'],
  ['openai(), mistral(), together()', 'the providers themselves', 'warn', 'endpoint answers (needs a key)', 'untested with a key'],
  ['ollama()', 'a local server', 'warn', 'the standard local endpoint', 'untested here'],
  ['(built in) openrouter', 'OpenRouter', 'ok', 'used in production for the default path', 'catalogue, calls, cost and expiry dates all seen live'],
  ['anthropic(), google()', 'direct', 'warn', 'request shape tested against the documented format', 'not called live'],
].map(([preset, svc, tone, what, note]) => `<tr><td><code>${esc(preset)}</code></td><td>${esc(svc)}</td><td><span class="chip ${tone}">${tone === 'ok' ? 'checked' : 'partly'}</span> ${esc(what)}<br><small>${esc(note)}</small></td></tr>`).join('');

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
  'spend.ts': 'createSpendLimit: a daily and monthly limit that takes a hold per attempt, so a burst cannot overshoot',
  'limiter.ts': 'createRateLimiter: an allowance for each caller, stored as a hash',
  'util.ts': 'A hash, a mutex and shape checks, shared by the pieces above',
  'types.ts': 'Shared types',
  'index.ts': 'Public exports',
};
const src = join(root, 'src');
const hasTest = (f) => existsSync(join(src, f.replace(/\.ts$/, '.test.ts')));
const BASE = 'https://github.com/obasaolorunfemi-ai/lodestone/blob/main/';
const files = readdirSync(src).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).sort();
const providerFiles = readdirSync(join(src, 'providers')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => f.replace('.ts', ''));
const filemap = files.map((f) => `<a class="src" href="${BASE}src/${f}"><code>${f}</code>${hasTest(f) ? '<span class="t">+tests</span>' : ''}<p>${esc(DESC[f] ?? '')}</p></a>`).join('')
  + `<a class="src" href="${BASE}src/providers"><code>providers/</code><p>Adapters: ${providerFiles.join(', ')}</p></a>`
  + `<a class="src" href="${BASE}src/stores"><code>stores/</code><p>Adapters: Netlify Blobs, Cloudflare KV, Upstash, Deno KV</p></a>`
  + `<a class="src" href="${BASE}python"><code>python/</code><p>The Python port (alpha), with its own tests</p></a>`
  + `<a class="src" href="${BASE}scripts"><code>scripts/</code><p>The smoke checks that run on Node, Workers, Deno and Bun</p></a>`
  + `<a class="src" href="${BASE}examples"><code>examples/</code><p>A Netlify function, the daily check and a multi-provider setup, all type-checked in CI</p></a>`
  + `<a class="src" href="${BASE}.github/workflows"><code>.github/workflows</code><p>Tests, builds and publishes to npm with provenance on a version tag</p></a>`
  + `<a class="src" href="${BASE}docs/scorecards.md"><code>docs/scorecards.md</code><p>The two JSON formats in full</p></a>`;
const missing = files.filter((f) => !DESC[f]);
if (missing.length) throw new Error(`site/build.mjs has no description for: ${missing.join(', ')}`);

// 5. Write it out.
let commit = 'unknown';
try { commit = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim(); } catch { /* not a git checkout */ }
const date = new Date().toISOString().slice(0, 10);
const css = readFileSync(join(here, 'src/style.css'));
const js = readFileSync(join(here, 'src/app.js'));
const theme = readFileSync(join(here, 'src/theme.js'));
const menu = readFileSync(join(here, 'src/menu.js'));
const v = createHash('sha256').update(css).update(js).update(theme).update(menu).digest('hex').slice(0, 10);

// The ticker: facts that are written on the page below, so it says nothing the page does not. The one-day test is labelled as one day.
const kinds = errors.filter((e) => !e.hidden).length;
const WORD = { 10: 'Ten', 11: 'Eleven', 12: 'Twelve', 13: 'Thirteen', 14: 'Fourteen' };
const ticker = ['<b>0</b> dependencies', 'runs on Node, Workers, Deno and Bun', `<b>${kinds}</b> kinds of failure, each with plain advice`, 'paid model about <b>3 s</b> for under a tenth of a cent, measured 28 Oct 2026', 'in one day\'s test, <b>1 in 15</b> free answers was usable', 'MIT licence'].map((t) => `<span>${t}</span>`).join('');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const html = readFileSync(join(here, 'src/index.html'), 'utf8')
  .replaceAll('{{v}}', v).replaceAll('{{sitebar}}', siteBar('')).replaceAll('{{footer}}', footHtml(true)).replaceAll('{{provider_strip}}', providerStrip).replaceAll('{{ticker}}', ticker).replaceAll('{{kinds}}', String(kinds)).replaceAll('{{Kinds}}', WORD[kinds] ?? String(kinds)).replaceAll('{{version}}', pkg.version).replaceAll('{{commit}}', commit).replaceAll('{{date}}', date)
  .replace('{{providers}}', providers).replace('{{vet}}', vet).replace('{{filemap}}', filemap)
  .replace('{{data}}', JSON.stringify({ errors }).replace(/</g, '\\u003c'));
writeFileSync(join(out, 'index.html'), html);
copyFileSync(join(here, 'src/style.css'), join(out, 'style.css'));
copyFileSync(join(here, 'src/app.js'), join(out, 'app.js'));
copyFileSync(join(here, 'src/theme.js'), join(out, 'theme.js'));
copyFileSync(join(here, 'src/menu.js'), join(out, 'menu.js'));
cpSync(join(here, 'src/fonts'), join(out, 'fonts'), { recursive: true });
copyFileSync(join(here, 'src/favicon.svg'), join(out, 'favicon.svg'));
copyFileSync(join(here, 'src/runs-on.js'), join(out, 'runs-on.js'));
cpSync(join(here, 'src/logos'), join(out, 'logos'), { recursive: true, filter: (f) => !f.endsWith('README.md') });
// connect-src lists exactly the origins of the live summaries named in runs-on.json (the home page's weather reads KeyStone's too).
const connectOrigins = [...new Set([...RUNS_ON.map((r) => r.weather).filter(Boolean), 'https://keystone.extrafemi.com/api/ai-weather'].map((u) => new URL(u).origin))];
writeFileSync(join(out, '_headers'), readFileSync(join(here, 'src/_headers'), 'utf8').replace(/connect-src [^;]*;/, `connect-src ${connectOrigins.join(' ')};`));
copyFileSync(join(here, 'src/robots.txt'), join(out, 'robots.txt'));

// 6. Documentation pages, built from the repository's own markdown, so they cannot drift from it.
const SITE = 'https://lodestone.extrafemi.com';
const GH = 'https://github.com/obasaolorunfemi-ai/lodestone/blob/main/';
const DOCS = [
  { path: 'docs/stores', file: 'docs/stores.md', title: 'Stores', desc: 'Where Lodestone keeps the catalogue, the circuit breaker and counters: Netlify Blobs, Cloudflare KV, Upstash and Deno KV adapters.' },
  { path: 'docs/protecting-your-budget', file: 'docs/protecting-your-budget.md', title: 'Protecting your budget on a public tool', desc: 'Per-caller allowances, a spend limit that holds under a burst, and what is exact and what is approximate.' },
  { path: 'docs/runtimes', file: 'docs/runtimes.md', title: 'Runtimes', desc: 'Node, Cloudflare Workers, Deno and Bun: how each is checked and what that does and does not show.' },
  { path: 'docs/python', file: 'python/README.md', title: 'Lodestone for Python', desc: 'The alpha Python port: what it does and what it does not do yet.' },
  { path: 'docs/scorecards', file: 'docs/scorecards.md', title: 'Scorecards', desc: 'The two JSON formats that let an evaluator and Lodestone feed each other.' },
  { path: 'security', file: 'SECURITY.md', title: 'Security', desc: 'How to report a problem, what the package does for supply-chain safety, and exactly what is and is not checked.' },
  { path: 'changelog', file: 'CHANGELOG.md', title: 'Changelog', desc: 'What changed in each version, and what was breaking.' },
];
const byFile = new Map(DOCS.map((d) => [d.file, d]));
const slug = (t) => t.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9 -]/g, '').trim().replace(/ +/g, '-');

/** A small markdown renderer for the subset these files use: headings, paragraphs, lists, tables, fenced code, quotes, and inline code, bold, italic, links. */
function md(src, fromFile) {
  const dir = dirname(fromFile);
  const href = (h) => {
    if (/^(https?:|mailto:|#|\/)/.test(h)) return h;
    const [path, hash] = h.split('#');
    const target = join(dir, path).replace(/^\.\//, '');
    const doc = byFile.get(target);
    return (doc ? `/${doc.path}/` : GH + target) + (hash ? '#' + hash : '');
  };
  const inline = (t) => {
    const codes = [];
    let x = esc(t).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    x = x.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, h) => `<a href="${esc(href(h.replace(/&amp;/g, '&')))}">${text}</a>`)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    return x.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
  };
  const lines = src.replace(/\r/g, '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (l.startsWith('```')) { const code = []; i++; while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]); i++; out.push(`<pre${code.length <= 3 ? ' class="wrap"' : ''}><code>${esc(code.join('\n'))}</code></pre>`); continue; }
    const h = /^(#{1,4}) (.*)$/.exec(l);
    if (h) { const n = h[1].length; out.push(`<h${n} id="${slug(h[2])}">${inline(h[2])}</h${n}>`); i++; continue; }
    if (l.startsWith('|') && /^\|[\s:|-]+\|$/.test(lines[i + 1] ?? '')) {
      const cells = (r) => r.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
      const head = cells(l); i += 2; const body = [];
      while (i < lines.length && lines[i].startsWith('|')) body.push(cells(lines[i++]));
      out.push(`<div class="tablewrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^(- |\d+\. )/.test(l)) {
      const ordered = /^\d+\. /.test(l); const items = [];
      while (i < lines.length && (/^(- |\d+\. )/.test(lines[i]) || (/^ {2,}\S/.test(lines[i]) && items.length))) {
        if (/^(- |\d+\. )/.test(lines[i])) items.push(lines[i++].replace(/^(- |\d+\. )/, '')); else items[items.length - 1] += ' ' + lines[i++].trim();
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    if (l.startsWith('> ')) { const q = []; while (i < lines.length && lines[i].startsWith('> ')) q.push(lines[i++].slice(2)); out.push(`<blockquote>${inline(q.join(' '))}</blockquote>`); continue; }
    const para = []; while (i < lines.length && lines[i].trim() && !/^(```|#{1,4} |\||- |\d+\. |> )/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}

const css1 = `<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/fonts/fonts.css"><link rel="stylesheet" href="/style.css?v=${v}"><script src="/theme.js?v=${v}"></script><script src="/menu.js?v=${v}" defer></script>`;
const page = ({ path, title, desc, body, crumbs = true, wide = false, scripts = '', side = '' }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)} · Lodestone</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${SITE}/${path}${path ? '/' : ''}">
<meta property="og:type" content="article"><meta property="og:site_name" content="Lodestone"><meta property="og:title" content="${esc(title)} · Lodestone"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${SITE}/${path}/">
<meta name="theme-color" content="#fdfcf9" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#12110e" media="(prefers-color-scheme: dark)">
${css1}${scripts}</head>
<body><a class="skip" href="#main">Skip to content</a>
<header class="sitebar">${siteBar(path)}</header>
<main id="main" class="doc${wide ? ' wide' : ''}${side ? ' docs' : ''}">${side ? `<aside class="docs-side">${side}</aside><div class="docs-body">` : ''}${crumbs ? '<p class="crumbs tag"><a href="/docs/">Docs</a></p>' : ''}
${body}${side ? '</div>' : ''}
</main>
${footHtml(false)}
</body></html>
`;

const lastmod = (file) => { try { return execSync(`git log -1 --format=%cs -- "${file}"`, { cwd: root }).toString().trim() || date; } catch { return date; } };
const pages = [{ loc: '/', lastmod: date }];
for (const d of DOCS) {
  const dest = join(out, d.path);
  mkdirSync(dest, { recursive: true });
  let body = md(readFileSync(join(root, d.file), 'utf8'), d.file);
  if (!/^<h1/.test(body)) body = `<h1>${esc(d.title)}</h1>\n` + body;
  const heads = [...body.matchAll(/<h2 id="([^"]+)">(.*?)<\/h2>/g)].map(([, id, t]) => [id, t.replace(/<[^>]+>/g, '')]);
  const tocLinks = heads.map(([id, t]) => `<a href="#${id}">${t}</a>`).join('');
  const docsNav = `<nav class="docs-nav" aria-label="Docs"><span class="tag">Docs</span><a href="/docs/">All docs</a>${DOCS.map((x) => `<a href="/${x.path}/"${x.path === d.path ? ' aria-current="page"' : ''}>${esc(x.title)}</a>`).join('')}</nav>`;
  const side = docsNav + (heads.length ? `<nav class="toc-d" aria-label="On this page"><span class="tag">On this page</span>${tocLinks}</nav><details class="toc-m"><summary>On this page</summary>${tocLinks}</details>` : '');
  writeFileSync(join(dest, 'index.html'), page({ path: d.path, title: d.title, desc: d.desc, body, side }));
  pages.push({ loc: `/${d.path}/`, lastmod: lastmod(d.file) });
}
mkdirSync(join(out, 'docs'), { recursive: true });
writeFileSync(join(out, 'docs/index.html'), page({ path: 'docs', title: 'Docs', desc: 'Documentation for Lodestone: stores, protecting your budget, runtimes, the Python port, scorecards, security and the changelog.', crumbs: false, wide: true,
  body: `<h1>Docs</h1><p class="lead">Built from the markdown in the repository. The <a href="/">home page</a> is the walkthrough; these are the details.</p><ul class="doc-list">${DOCS.map((d) => `<li><a href="/${d.path}/"><b>${esc(d.title)}</b><span>${esc(d.desc)}</span></a></li>`).join('')}<li><a href="${GH}README.md"><b>README</b><span>The full reference for the TypeScript library, on GitHub.</span></a></li></ul>` }));
pages.splice(1, 0, { loc: '/docs/', lastmod: date });

// 6b. Pages that used to be sections of the home page, and the platforms page.
const providersCap = 'A "model list read" means Lodestone\'s reader was run against the service\'s real list and parsed it correctly. A chat call has been seen to answer only on Groq (and on OpenRouter, in production); the others are tested against fakes of the documented request, not against the service itself. A live check on 28 October 2026 is how the withdrawn Groq model and the non-chat entries in its list were found, which is why those are in the notes. Requesty and LLM API have no free models; they add redundancy on the paid path. Free redundancy comes from providers with free tiers, such as Groq and Cerebras.';

const failList = errors.filter((e) => !e.hidden).map((e) => `<details><summary><code>${esc(e.kind)}</code><span>${esc(e.what)}</span></summary><p class="say">“${esc(e.say)}”</p></details>`).join('');
const runCard = (r) => `<div class="fam-card"><span class="tag">${r.kind === 'runs' ? 'Runs on Lodestone' : 'Feeds scorecards to Lodestone'}</span><h2><a href="${esc(r.url)}">${esc(r.name)}</a></h2><p>${esc(r.description)}</p>${r.weather ? `<p class="live-line" data-weather="${esc(r.weather)}">Reading the live counts…</p>` : ''}<p class="go"><a href="${esc(r.url)}">${esc(r.url.replace(/^https:\/\//, '').replace(/\/$/, ''))}</a></p></div>`;
const extras = [
  { path: 'providers', title: 'Providers', desc: 'Every fallback provider Lodestone has a preset for, and exactly how far each has been checked.', wide: true,
    body: `<h1>Providers</h1><p class="lead">Any service that speaks OpenAI's chat API works through <code>openaiCompatible()</code>, and presets exist for the ones Lodestone has been checked against. Here is exactly how far each check went.</p><div class="tablewrap"><table><thead><tr><th>Preset</th><th>Service</th><th>What was checked</th></tr></thead><tbody>${providers}</tbody></table></div><p class="cap">${esc(providersCap)}</p><p class="cap">Checking a provider yourself: <code>node scripts/live-check.mjs</code> in the repository calls each one once with keys from your environment and prints what happened, without printing a key.</p>` },
  { path: 'model-lists', title: 'Model lists', desc: 'How Lodestone keeps a provider\'s model list alive, short and safe: models that are gone drop out, a pool of eight with three tried, and a trust policy checked by the library itself.', wide: true,
    body: `<h1>Lists that keep themselves alive</h1><p class="lead">A model list that nobody edits goes stale; one that fills itself can grow until it is slow, or admit something you would not choose. Lodestone does the first and bounds the second.</p>
<div class="three">
<div class="card"><span class="tag">Alive</span><h3>Outdated models drop out</h3><p>A daily <code>checkModels()</code> saves each provider's catalogue. A model it no longer lists is dropped. One with an expiry date within a week is left out (OpenRouter publishes the date; 14 models carried one the day this was written). One failing right now is skipped by the breaker.</p></div>
<div class="card"><span class="tag">Short</span><h3>A pool of 8, three tried</h3><p>The ranked pool lives in the background. Models that are down are filtered out, and a request tries at most three. When one fails, the next best takes its place for later requests, so adding models adds choice, not delay.</p></div>
<div class="card"><span class="tag">Safe</span><h3>Trust is checked, not assumed</h3><p>A discovered model must come from a trusted lab. You can block labs or models, refuse any a provider says is trained on or keeps prompts too long, and mark a single call <code>private</code>.</p></div>
</div>
<div class="pool" aria-label="Example pool"><span class="down">gemma-4-26b (429)</span><span class="down">nemotron-lightning (hung)</span><span class="live">nemotron-ultra</span><span class="live">gemma-4-31b</span><span class="live">qwen3.5-flash</span><span>mistral-small</span><span>deepseek-v4</span><span>phi-5-mini</span></div>
<p class="cap">Illustrative: a pool of eight. The two that are down are skipped; the next three live ones are tried.</p>
<h2>What the trust policy decides</h2>
<div class="tablewrap"><table><thead><tr><th>Model found by discovery</th><th>Default policy</th><th>Strict: no training, prompts kept ≤ 30 days</th></tr></thead><tbody>${vet}</tbody></table></div>
<p class="cap">Verdicts are computed by the library's own <code>vet()</code> as this page is built, on rows shaped like real lists. On 28 Oct 2026, of Requesty's 807 chat models, 205 came from a lab not on the default list and 9 were marked as trained on. LLM API publishes nothing about what happens to prompts, so under a strict policy none of its models can be <em>discovered</em>; models you name yourself still work.</p>
<p class="cap"><b>What this is not.</b> There is no vulnerability database for hosted AI models, so Lodestone does not claim to scan one. It checks what providers actually publish, and enforces your rules on it. Those facts are self-reported by providers. <a href="/security/">The security page</a> lists exactly what is and is not checked.</p>` },
  { path: 'when-everything-fails', title: 'When everything fails', desc: 'The kinds of failure Lodestone reports, and the plain-language sentence explain() gives a person for each.', wide: true,
    body: `<h1>${WORD[kinds] ?? kinds} kinds of failure, each with its own advice</h1><p class="lead"><code>complete()</code> and <code>json()</code> throw a <code>LodestoneError</code> with one of these <code>kind</code> values. Open one to read the sentence <code>explain(err, { product: 'MyApp', settingsHint: 'in Settings' })</code> gives a person.</p><div class="fail-list">${failList}</div><p class="cap">The sentences are the library's own: this page calls <code>explain()</code> for each kind when it is built, so they cannot drift from the code.</p>` },
  { path: 'limits', title: 'Honest limits', desc: 'What Lodestone does not do yet: streaming, tool calling, embeddings and speech, and what is missing from the alpha Python port.', wide: true,
    body: `<h1>What it does not do yet</h1><p class="lead">Lodestone is for one-shot text and JSON calls today. These are the gaps, stated plainly.</p>
<div class="three">
<div class="card"><h3>Streaming</h3><p><code>complete()</code> and <code>json()</code> wait for the whole answer. Streaming needs a rule for a model that fails halfway; the likely one is to fail over only before the first token.</p></div>
<div class="card"><h3>Tool calling, embeddings, speech</h3><p>Lodestone is for one-shot text and JSON calls today. It does not let a model call functions, and it has no tier for embeddings or speech.</p></div>
<div class="card"><h3>The Python port is alpha</h3><p>It can't read provider model lists other than OpenRouter's, so Requesty's price, lab and data-policy details and <code>discover</code> are TypeScript-only, and a private call uses a fallback only if you vouch for it. A hung request is cut off at its slice and the next model is tried, but its thread only ends at its socket timeout. Images, streaming, tool calling and scorecards do not exist in Python. It has been tested against a local HTTP server and fake providers, and has made live calls to Groq and OpenRouter, which both answered; Requesty was refused for lack of credit and no other provider has been tried live from Python, which is the main reason it is alpha. <a href="/docs/python/">Details</a>.</p></div>
</div>
<p class="cap">Also worth knowing: only Groq and OpenRouter have been seen to answer a live call, so every other provider is checked against fakes. <a href="/providers/">The Providers page</a> says exactly how far each check went, and <a href="/where-it-runs/">Where it runs</a> says what has been deployed where.</p>` },
  { path: 'runs-on-lodestone', title: 'Runs on Lodestone', desc: 'The tools that call AI models through Lodestone, and the evaluators that feed it scorecards.', wide: true, scripts: '<script src="/runs-on.js?v=' + v + '" defer></script>',
    body: `<h1>Runs on Lodestone</h1><p class="lead">The tools that use Lodestone, and the evaluators that feed it. This page is read from one file in the repository, so it grows as more tools join.</p>
<h2>Runs on Lodestone</h2><div class="fam-grid">${RUNS_ON.filter((r) => r.kind === 'runs').map(runCard).join('')}</div>
<h2>Feeds scorecards to Lodestone</h2><div class="fam-grid">${RUNS_ON.filter((r) => r.kind === 'feeds').map(runCard).join('')}</div>
<h2>Add yours</h2><p>Using Lodestone? <a href="https://github.com/obasaolorunfemi-ai/lodestone/issues/new">Open an issue</a> with the name, the address and what it uses Lodestone for, or send a pull request that adds a line to <code>site/src/runs-on.json</code>. Tools are added by hand, after checking that they really use it.</p>
<p>To get a live line like KeyStone's, publish a small public summary of your attempts: for each model, how many were tried, how many answered, how many timed out and how long the answers took. Counts and times only, never a prompt or an answer, with <code>Access-Control-Allow-Origin</code> set to this site. <a href="https://github.com/obasaolorunfemi-ai/lodestone/blob/main/docs/protecting-your-budget.md">KeyStone's is a good model to copy</a>. Lodestone itself never reports where it runs: it makes no network calls except to the providers you configure.</p>` },
  { path: 'getting-smarter', title: 'Getting smarter over time', desc: 'Scorecards: how an evaluator and Lodestone feed each other, and let measured quality choose the order models are tried in.', wide: true,
    body: `<h1>Scorecards: let measurements choose the order</h1><p class="lead">Two small JSON formats let an evaluator and Lodestone feed each other without sharing code. <a href="https://naija-eval.extrafemi.com">Naija Eval</a>, which measures translation and speech quality for Hausa, Igbo and Yoruba, is the first to use them. Its scores are translation quality, so they help tasks in those languages, not every task.</p>
<div class="loop">
    <div class="node"><h3>Evaluator (Naija Eval)</h3><p>Measures answer quality, such as chrF++ for English→Yoruba, per model.</p></div>
    <div class="arrows" aria-hidden="true"><div class="r">model-scorecard/1 →</div><div class="l">← model-candidates/1</div><div class="l">← live reliability</div></div>
    <div class="node"><h3>Lodestone (in your tool)</h3><p>Tries the best-measured models first for tasks you name, lists the models it can call, and records its own success rates and speeds.</p></div>
  </div>
  <ul class="method">
    <li>A scorecard only changes the <i>order</i> models are tried in. Nothing is added or dropped.</li>
    <li>Scores from fewer than 30 items, or over a year old, are ignored.</li>
    <li>Unmeasured models keep their slot, so a good unmeasured model is never pushed down.</li>
    <li>An explicit <code>route</code> is never reordered.</li>
    <li>If the scorecard fetch fails or takes over 1.5 s, the order is left alone.</li>
    <li>Live stats keep the last 200 attempts per model and never see prompts or answers.</li>
  </ul>` },
  { path: 'using-it', title: 'Using it', desc: 'What a tool writes with Lodestone: one setup, then task-named calls, with the stores, runtimes and Python port it can use.', wide: true,
    body: `<h1>What a tool writes</h1><p class="lead">Set it up once and share the store. Each call names a task, not a model; Lodestone picks the order, the time slices and the fallbacks.</p>
<div class="two">
<pre class="snip"><span class="c">// set up once, and share the store</span>
const ai = createLodestone({
  openrouter: { apiKey: OPENROUTER_KEY,
    allowPaid: true, paidFirst: true,
    paidModels: ['anthropic/claude-haiku-5.5'],
    reasoning: (m) => m.startsWith('anthropic/')
      ? { enabled: false } : { effort: 'low', exclude: true } },
  fallbacks: [
    { provider: requesty(), apiKey: REQUESTY_KEY,
      models: ['bedrock/claude-haiku-5-5'],
      discover: { fill: { maxPromptUsdPerMTok: 1,
                          maxCompletionUsdPerMTok: 5 } } },
    { provider: groq(), apiKey: GROQ_KEY,
      models: ['openai/gpt-oss-20b'], free: true },
  ],
  store, health: createHealth({ store }),
  spend: createSpendLimit({ store, dailyUsd: 2 }),
  rateLimit: { limiter: createRateLimiter({ store, max: 20 }),
               whenOver: 'free-only' },
  trust: { requireNoTraining: true },
});

<span class="c">// each call names a task, not a model</span>
try {
  const { data } = await ai.json({
    prompt, validate: isJob, signal: req.signal,
    caller: userId, private: true });   <span class="c">// a CV: do not keep or train on it</span>
} catch (err) {
  return explain(err, { product: 'MyApp' });
}</pre>
    <ol class="steps">
      <li><b>Tiers, not model ids.</b> A task maps to <code>fast</code>, <code>strong</code> or <code>vision</code> (picked automatically when a message has an image). Or pass a fixed <code>route</code> to name provider, model and key yourself.</li>
      <li><b>Customer keys stay separate.</b> A caller's own key replaces yours and unlocks the paid model, but your fallback providers and your spend ledger are never touched by that call.</li>
      <li><b>One person cannot empty the budget.</b> Name the <code>caller</code> and each one gets their own allowance (stored as a hash). Over it, they are refused or served from free models only. The spend limit takes a hold per attempt, so a burst cannot overshoot it. <a href="/docs/protecting-your-budget/">How, and what is approximate</a>.</li>
      <li><b>Daily upkeep.</b> <code>checkModels()</code> refreshes every provider's catalogue and reports what has gone or is retiring. <code>cacheKey</code> and <code>peek()</code> reuse answers for repeatable tasks.</li>
      <li><b>Cancelling.</b> Pass a <code>signal</code>; when the person leaves, the call and every model after it stop.</li>
      <li><b>Private by design.</b> <code>onAttempt</code> reports provider, model, outcome and timing only. Prompts and answers are never logged, and a <code>private</code> call is never cached.</li>
    </ol>
    <div class="three">
      <a class="card" href="/docs/stores/"><span class="tag">Shared state</span><h3>Stores for where you deploy</h3><p>Netlify Blobs, Cloudflare KV, Upstash (and Vercel KV) and Deno KV adapters, so the circuit breaker and rate limits are shared between functions.</p></a>
      <a class="card" href="/docs/runtimes/"><span class="tag">Checked, not assumed</span><h3>Node, Workers, Deno, Bun</h3><p>The same smoke checks run on all four in CI, Workers without the Node compatibility flag.</p></a>
      <a class="card" href="/docs/python/"><span class="tag">Alpha</span><h3>A Python port</h3><p>Failover, time budget, breaker, spend holds, per-caller limits and <code>explain()</code>, with the standard library only. What it lacks is listed.</p></a>
    </div>
  </div>` },
  { path: 'code-map', title: 'Code map', desc: 'Where each piece of Lodestone lives in src/, generated from the repository.', wide: true,
    body: `<h1>Code map</h1><p class="lead">Where each piece lives in <code>src/</code>. This is generated from the files in the repository when the site is built. <b>+tests</b> marks a file with its own test file; the others are covered by a shared one or by the call-path tests.</p><div class="map">${filemap}</div>` },
  { path: 'where-it-runs', title: 'Where it runs', desc: 'Netlify, Cloudflare Workers, Base44, Vercel and Render: which run Lodestone in production, which are checked in CI, and which are not tested yet.', wide: true,
    body: `<h1>Where it runs</h1><p class="lead">Lodestone uses only <code>fetch</code>, <code>AbortSignal</code> and <code>URL</code>, so it runs wherever your function does. This page says, for each platform, how much of that has been seen and not just assumed.</p>
<div class="legend-chips"><span><span class="chip ok">In production</span> a real app runs on it</span><span><span class="chip info">Runtime tested</span> the same checks run on that platform's runtime in CI, but nothing of ours is deployed there</span></div>
<div class="platforms">
<div class="plat prod"><div class="plat-head">${logo('netlify', 'Netlify')}<h2>Netlify</h2></div><span class="chip ok">In production</span><p>KeyStone calls AI models through Lodestone from Netlify Functions, with the 30 second function limit and a 24 second time budget.</p><p class="store">Shared state: <code>netlifyBlobsStore</code></p></div>
<div class="plat"><div class="plat-head">${logo('cloudflareworkers', 'Cloudflare Workers')}<h2>Cloudflare Workers</h2></div><span class="chip info">Runtime tested</span><p>The checks run inside <code>workerd</code>, Cloudflare's own runtime, with no Node compatibility flag, on every change. Not deployed to a live Worker yet.</p><p class="store">Shared state: <code>cloudflareKvStore</code> for the catalogue and cached answers; Upstash for counters</p></div>
<div class="plat"><div class="plat-head"><h2>Base44</h2></div><span class="chip info">Runtime tested</span><p>Base44 says <a href="https://docs.base44.com/developers/backend/resources/backend-functions/overview">its backend functions run on Deno</a>, and the checks run on Deno. Not deployed on Base44 yet. Import it with the <code>npm:</code> prefix.</p><p class="store">Shared state: <code>upstashStore</code> over HTTP, or memory</p></div>
<div class="plat"><div class="plat-head">${logo('vercel', 'Vercel')}<h2>Vercel</h2></div><span class="chip info">Runtime tested</span><p>Vercel's Node.js functions run the same code the checks run on Node 20, 22 and 24. Not deployed on Vercel yet, and its Edge runtime has not been checked separately.</p><p class="store">Shared state: <code>upstashStore</code> over HTTP, or memory</p></div>
<div class="plat"><div class="plat-head">${logo('render', 'Render')}<h2>Render</h2></div><span class="chip info">Runtime tested</span><p>A Render web service is a Node server, covered by the Node checks. Not deployed on Render yet. A server has no function time limit, but the time budget still protects the person who is waiting.</p><p class="store">Shared state: <code>upstashStore</code>, or memory on a single instance</p></div>
</div>
<h2>Runtimes checked on every change</h2>
<div class="runtimes-row"><span>Node 20</span><span>Node 22</span><span>Node 24</span><span>Cloudflare workerd</span><span>Deno</span><span>Bun</span><span>Python 3.10, 3.12, 3.13 (alpha port: live calls to Groq and OpenRouter answered; everything else tested against fakes)</span></div>
<p class="cap logo-note">Logos are from the <a href="https://simpleicons.org">Simple Icons</a> set (CC0) and belong to their owners; they are here to say where Lodestone runs, not to imply endorsement. Base44 has no mark in that set, so it appears as a name.</p>
<p class="cap">"Runtime tested" is a claim about the runtime, not the platform: a platform can add limits of its own, such as a smaller time limit or no writable disk. It moves to "In production" only when something real is deployed there.</p>
<p class="cap">Deployed it somewhere not listed, or on one of these? <a href="https://github.com/obasaolorunfemi-ai/lodestone/issues/new">Tell us in an issue</a>. More detail: <a href="/docs/runtimes/">Runtimes</a>, <a href="/docs/stores/">Stores</a>, <a href="/docs/python/">the Python port</a>.</p>` },
];
for (const x of extras) {
  mkdirSync(join(out, x.path), { recursive: true });
  writeFileSync(join(out, x.path, 'index.html'), page({ path: x.path, title: x.title, desc: x.desc, body: x.body, crumbs: false, wide: x.wide, scripts: x.scripts }));
  pages.push({ loc: `/${x.path}/`, lastmod: date });
}
writeFileSync(join(out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages.map((p) => `<url><loc>${SITE}${p.loc}</loc><lastmod>${p.lastmod}</lastmod></url>`).join('')}</urlset>\n`);

// 7. Files for machines: security.txt (RFC 9116), and llms.txt / llms-full.txt for AI assistants that read the site.
mkdirSync(join(out, '.well-known'), { recursive: true });
const expires = new Date(Date.now() + 330 * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z');
writeFileSync(join(out, '.well-known/security.txt'), `Contact: https://github.com/obasaolorunfemi-ai/lodestone/security/advisories/new
Expires: ${expires}
Preferred-Languages: en
Canonical: ${SITE}/.well-known/security.txt
Policy: ${SITE}/security/
`);
const summary = 'Lodestone is a small library (TypeScript, with an alpha Python port) that sits between a tool and AI models. When a model is withdrawn, slow, rate-limited or down it moves to the next one, stays inside a time limit, spends only what you allow, limits each caller, and if everything fails explains the failure in plain words. No dependencies; runs on Node, Cloudflare Workers, Deno and Bun. MIT.';
writeFileSync(join(out, 'llms.txt'), `# Lodestone

> ${summary}

## Start here

- [Home](${SITE}/): an interactive walkthrough with a simulator, measurements and the failure messages
- [README](${GH}README.md): the full reference for the TypeScript library
- [Python port](${SITE}/docs/python/): the alpha Python package and what it lacks
- [Providers](${SITE}/providers/): every fallback provider and how far each was checked
- [Model lists](${SITE}/model-lists/): how a model list drops what is gone, stays short and admits only trusted models
- [Where it runs](${SITE}/where-it-runs/): Netlify, Cloudflare Workers, Base44, Vercel and Render, and what has been verified on each
- [Code map](${SITE}/code-map/): where each piece lives in src/

## Docs

${DOCS.filter((d) => d.path.startsWith('docs/')).map((d) => `- [${d.title}](${SITE}/${d.path}/): ${d.desc}`).join('\n')}

## Project

- [Security](${SITE}/security/): reporting, supply chain, what is and is not checked
- [Changelog](${SITE}/changelog/)
- [Source](https://github.com/obasaolorunfemi-ai/lodestone)
- [npm](https://www.npmjs.com/package/@extrafemi-ai/lodestone)

## Optional

- [Everything in one file](${SITE}/llms-full.txt)
`);
writeFileSync(join(out, 'llms-full.txt'), ['README.md', ...DOCS.map((d) => d.file)].map((f) => `<!-- ${f} -->\n${readFileSync(join(root, f), 'utf8')}`).join('\n\n---\n\n'));
writeFileSync(join(out, '404.html'), readFileSync(join(here, 'src/404.html'), 'utf8').replaceAll('{{v}}', v).replaceAll('{{sitebar}}', siteBar('404')).replaceAll('{{foot}}', footHtml(false)));
console.log(`site/public: Lodestone ${pkg.version} @ ${commit}, ${kinds} failure kinds, ${pages.length} pages, ${files.length} source files, ${rows.length} trust rows`);
