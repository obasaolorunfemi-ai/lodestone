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
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const NAV = [['/', 'Home'], ['/providers/', 'Providers'], ['/where-it-runs/', 'Where it runs'], ['/docs/', 'Docs'], ['/code-map/', 'Code map'], ['/changelog/', 'Changelog'], ['/security/', 'Security'], ['https://github.com/obasaolorunfemi-ai/lodestone', 'GitHub']];
/** The site links, the same on every page. Docs pages count as Docs, so the Docs link is marked while you read one. */
const navHtml = (path) => NAV.map(([h, t]) => {
  const here = h === '/' ? path === '' : h.startsWith('/') && (path === h.slice(1, -1) || (h === '/docs/' && path.startsWith('docs')));
  return `<a href="${h}"${here ? ' aria-current="page"' : ''}>${t}</a>`;
}).join('');

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
  .replaceAll('{{v}}', v).replaceAll('{{nav}}', navHtml('')).replaceAll('{{ticker}}', ticker).replaceAll('{{kinds}}', String(kinds)).replaceAll('{{Kinds}}', WORD[kinds] ?? String(kinds)).replaceAll('{{version}}', pkg.version).replaceAll('{{commit}}', commit).replaceAll('{{date}}', date)
  .replace('{{providers}}', providers).replace('{{vet}}', vet).replace('{{filemap}}', filemap)
  .replace('{{data}}', JSON.stringify({ errors }).replace(/</g, '\\u003c'));
writeFileSync(join(out, 'index.html'), html);
copyFileSync(join(here, 'src/style.css'), join(out, 'style.css'));
copyFileSync(join(here, 'src/app.js'), join(out, 'app.js'));
copyFileSync(join(here, 'src/theme.js'), join(out, 'theme.js'));
copyFileSync(join(here, 'src/menu.js'), join(out, 'menu.js'));
cpSync(join(here, 'src/fonts'), join(out, 'fonts'), { recursive: true });
copyFileSync(join(here, 'src/favicon.svg'), join(out, 'favicon.svg'));
copyFileSync(join(here, 'src/_headers'), join(out, '_headers'));
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
    if (l.startsWith('```')) { const code = []; i++; while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]); i++; out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); continue; }
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
const page = ({ path, title, desc, body, crumbs = true, wide = false }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)} · Lodestone</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${SITE}/${path}${path ? '/' : ''}">
<meta property="og:type" content="article"><meta property="og:site_name" content="Lodestone"><meta property="og:title" content="${esc(title)} · Lodestone"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${SITE}/${path}/">
<meta name="theme-color" content="#fdfcf9" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#12110e" media="(prefers-color-scheme: dark)">
${css1}</head>
<body><a class="skip" href="#main">Skip to content</a>
<header class="sitebar"><div class="col sitebar-in"><a class="brand" href="/">Lodestone</a><nav class="sections" id="sections" aria-label="Site">${navHtml(path)}</nav><button type="button" class="icon-btn menu-btn" id="menu" aria-expanded="false" aria-controls="sections" aria-label="Open menu"><svg class="i-open" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg><svg class="i-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div></header>
<main id="main" class="doc${wide ? ' wide' : ''}">${crumbs ? '<p class="crumbs tag"><a href="/docs/">Docs</a></p>' : ''}
${body}
</main>
<footer class="site-foot slim"><div class="col foot-base"><p>${NAV.map(([h, t]) => `<a href="${h}">${t}</a>`).join(' · ')}</p><p>Lodestone ${pkg.version} · built from commit ${commit} on ${date} · MIT licence. This page is built from <a href="${GH}">the repository</a>'s own markdown.</p><p>© 2026 Extrafemi · No cookies, no tracking.</p></div></footer>
</body></html>
`;

const lastmod = (file) => { try { return execSync(`git log -1 --format=%cs -- "${file}"`, { cwd: root }).toString().trim() || date; } catch { return date; } };
const pages = [{ loc: '/', lastmod: date }];
for (const d of DOCS) {
  const dest = join(out, d.path);
  mkdirSync(dest, { recursive: true });
  let body = md(readFileSync(join(root, d.file), 'utf8'), d.file);
  if (!/^<h1/.test(body)) body = `<h1>${esc(d.title)}</h1>\n` + body;
  writeFileSync(join(dest, 'index.html'), page({ path: d.path, title: d.title, desc: d.desc, body }));
  pages.push({ loc: `/${d.path}/`, lastmod: lastmod(d.file) });
}
mkdirSync(join(out, 'docs'), { recursive: true });
writeFileSync(join(out, 'docs/index.html'), page({ path: 'docs', title: 'Docs', desc: 'Documentation for Lodestone: stores, protecting your budget, runtimes, the Python port, scorecards, security and the changelog.', crumbs: false,
  body: `<h1>Docs</h1><p>Built from the markdown in the repository. The <a href="/">home page</a> is the walkthrough; these are the details.</p><ul class="doc-list">${DOCS.map((d) => `<li><a href="/${d.path}/"><b>${esc(d.title)}</b><span>${esc(d.desc)}</span></a></li>`).join('')}<li><a href="${GH}README.md"><b>README</b><span>The full reference for the TypeScript library, on GitHub.</span></a></li></ul>` }));
pages.splice(1, 0, { loc: '/docs/', lastmod: date });

// 6b. Pages that used to be sections of the home page, and the platforms page.
const providersCap = 'A "model list read" means Lodestone\'s reader was run against the service\'s real list and parsed it correctly. A chat call has been seen to answer only on Groq (and on OpenRouter, in production); the others are tested against fakes of the documented request, not against the service itself. A live check on 28 October 2026 is how the withdrawn Groq model and the non-chat entries in its list were found, which is why those are in the notes. Requesty and LLM API have no free models; they add redundancy on the paid path. Free redundancy comes from providers with free tiers, such as Groq and Cerebras.';
const extras = [
  { path: 'providers', title: 'Providers', desc: 'Every fallback provider Lodestone has a preset for, and exactly how far each has been checked.', wide: true,
    body: `<h1>Providers</h1><p class="lead">Any service that speaks OpenAI's chat API works through <code>openaiCompatible()</code>, and presets exist for the ones Lodestone has been checked against. Here is exactly how far each check went.</p><div class="tablewrap"><table><thead><tr><th>Preset</th><th>Service</th><th>What was checked</th></tr></thead><tbody>${providers}</tbody></table></div><p class="cap">${esc(providersCap)}</p><p class="cap">Checking a provider yourself: <code>node scripts/live-check.mjs</code> in the repository calls each one once with keys from your environment and prints what happened, without printing a key.</p>` },
  { path: 'code-map', title: 'Code map', desc: 'Where each piece of Lodestone lives in src/, generated from the repository.', wide: true,
    body: `<h1>Code map</h1><p class="lead">Where each piece lives in <code>src/</code>. This is generated from the files in the repository when the site is built. <b>+tests</b> marks a file with its own test file; the others are covered by a shared one or by the call-path tests.</p><div class="map">${filemap}</div>` },
  { path: 'where-it-runs', title: 'Where it runs', desc: 'Netlify, Cloudflare Workers, Base44, Vercel and Render: which run Lodestone in production, which are checked in CI, and which are not tested yet.', wide: true,
    body: `<h1>Where it runs</h1><p class="lead">Lodestone uses only <code>fetch</code>, <code>AbortSignal</code> and <code>URL</code>, so it runs wherever your function does. This page says, for each platform, how much of that has been seen and not just assumed.</p>
<div class="legend-chips"><span><span class="chip ok">In production</span> a real app runs on it</span><span><span class="chip info">Runtime tested</span> the same checks run on that platform's runtime in CI, but nothing of ours is deployed there</span></div>
<div class="platforms">
<div class="plat prod"><h2>Netlify</h2><span class="chip ok">In production</span><p>KeyStone calls AI models through Lodestone from Netlify Functions, with the 30 second function limit and a 24 second time budget.</p><p class="store">Shared state: <code>netlifyBlobsStore</code></p></div>
<div class="plat"><h2>Cloudflare Workers</h2><span class="chip info">Runtime tested</span><p>The checks run inside <code>workerd</code>, Cloudflare's own runtime, with no Node compatibility flag, on every change. Not deployed to a live Worker yet.</p><p class="store">Shared state: <code>cloudflareKvStore</code> for the catalogue and cached answers; Upstash for counters</p></div>
<div class="plat"><h2>Base44</h2><span class="chip info">Runtime tested</span><p>Base44 says <a href="https://docs.base44.com/developers/backend/resources/backend-functions/overview">its backend functions run on Deno</a>, and the checks run on Deno. Not deployed on Base44 yet. Import it with the <code>npm:</code> prefix.</p><p class="store">Shared state: <code>upstashStore</code> over HTTP, or memory</p></div>
<div class="plat"><h2>Vercel</h2><span class="chip info">Runtime tested</span><p>Vercel's Node.js functions run the same code the checks run on Node 20, 22 and 24. Not deployed on Vercel yet, and its Edge runtime has not been checked separately.</p><p class="store">Shared state: <code>upstashStore</code> over HTTP, or memory</p></div>
<div class="plat"><h2>Render</h2><span class="chip info">Runtime tested</span><p>A Render web service is a Node server, covered by the Node checks. Not deployed on Render yet. A server has no function time limit, but the time budget still protects the person who is waiting.</p><p class="store">Shared state: <code>upstashStore</code>, or memory on a single instance</p></div>
</div>
<h2>Runtimes checked on every change</h2>
<div class="runtimes-row"><span>Node 20</span><span>Node 22</span><span>Node 24</span><span>Cloudflare workerd</span><span>Deno</span><span>Bun</span><span>Python 3.10, 3.12, 3.13 (alpha port, tested only against fakes, not live providers)</span></div>
<p class="cap">"Runtime tested" is a claim about the runtime, not the platform: a platform can add limits of its own, such as a smaller time limit or no writable disk. It moves to "In production" only when something real is deployed there.</p>
<p class="cap">Deployed it somewhere not listed, or on one of these? <a href="https://github.com/obasaolorunfemi-ai/lodestone/issues/new">Tell us in an issue</a>. More detail: <a href="/docs/runtimes/">Runtimes</a>, <a href="/docs/stores/">Stores</a>, <a href="/docs/python/">the Python port</a>.</p>` },
];
for (const x of extras) {
  mkdirSync(join(out, x.path), { recursive: true });
  writeFileSync(join(out, x.path, 'index.html'), page({ path: x.path, title: x.title, desc: x.desc, body: x.body, crumbs: false, wide: x.wide }));
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
writeFileSync(join(out, '404.html'), readFileSync(join(here, 'src/404.html'), 'utf8').replaceAll('{{v}}', v));
console.log(`site/public: Lodestone ${pkg.version} @ ${commit}, ${kinds} failure kinds, ${pages.length} pages, ${files.length} source files, ${rows.length} trust rows`);
