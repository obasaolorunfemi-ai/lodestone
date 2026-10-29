'use strict';
// The simulator, the failure kinds and the reveal-on-scroll. No network, no storage, no third parties.
const DATA = JSON.parse(document.getElementById('data').textContent);
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

const BUDGET = 24, FREE = 9;
let SPAN = 12; // the axis fits each scenario, so short calls are not drawn as slivers
const pct = (s) => (s / SPAN * 100) + '%';
const say = (kind) => (DATA.errors.find((e) => e.kind === kind) || {}).say || '';

// Rules, not guesses: free-first is the default; paid-first is the shared-key mode; a free phase gets a short share when something follows it.
const S = [
  { id: 'smooth', t: 'A normal day', s: 'a free model answers', call: "ai.complete({ prompt })", cfg: 'default: free models first', freeFirst: true, pre: [],
    att: [{ p: 'free', m: 'gemma-4-31b-it:free', o: 'ok', d: 2.6 }], res: { win: true, txt: 'The first free model answered in 2.6 s. Nothing was spent.' } },
  { id: 'withdrawn', t: 'A model was withdrawn', s: 'the catalogue swaps it', call: "ai.complete({ prompt, tier: 'fast' })", cfg: 'default: free models first', freeFirst: true,
    pre: ['<span class="k">catalogue</span> preferred <b>llama-3.3-70b:free</b> is no longer listed', '<span class="k">catalogue</span> replaced with <b>qwen3.5-flash:free</b> (same tier, trusted lab)'],
    att: [{ p: 'free', m: 'qwen3.5-flash:free', o: 'ok', d: 1.8 }], res: { win: true, txt: 'The hard-coded model no longer exists, but the call never noticed: it was replaced by a current one of the same kind before anything was sent.' } },
  { id: 'badday', t: 'Free models are down', s: 'paid first (measured)', call: "ai.json({ prompt, validate: isJob })", cfg: 'openrouter: { paidFirst: true }  (the shared key)', freeFirst: false,
    pre: ['<span class="k">paidFirst</span> the free models are the backup, not the first try', '<span class="d">28 Oct 2026: free models gave 1 usable answer in 15 attempts</span>'],
    att: [{ p: 'paid', m: 'claude-haiku-5.5', o: 'ok', d: 3.1 }], res: { win: true, txt: 'Answered in 3.1 s (the measured time for reading a job posting) for about $0.0004. The free models were never tried, so their hangs cost nothing.' } },
  { id: 'breaker', t: 'A model keeps failing', s: 'the breaker skips it', call: "ai.complete({ prompt })  // the next request", cfg: 'health: createHealth({ store })', freeFirst: true,
    pre: ['<span class="k">breaker</span> gemma-4-31b and nemotron-lightning each failed 3 times in 10 min', '<span class="k">breaker</span> both are skipped; the next best from the pool takes their place'],
    att: [{ p: 'free', skip: 'skipped by the breaker: gemma-4-31b, nemotron-lightning' }, { p: 'free', m: 'nemotron-ultra (next best)', o: 'ok', d: 2.4 }],
    res: { win: true, txt: 'The two models that kept failing cost 0 s. Every two minutes one attempt is let through to see whether they have recovered; one success closes the breaker.' } },
  { id: 'outage', t: 'OpenRouter is down', s: 'another provider answers', call: "ai.complete({ prompt })", cfg: 'paidFirst + fallbacks: [requesty()]', freeFirst: false,
    pre: [],
    att: [{ p: 'paid', m: 'claude-haiku-5.5', o: 'fail', d: 0.6, note: '503' }, { p: 'free', m: 'gemma-4-31b-it:free', o: 'fail', d: 0.5, note: '503' }, { p: 'free', m: 'nemotron-lightning', o: 'slow', d: 5.0 }, { p: 'fallback', m: 'requesty · bedrock/claude-haiku-5-5', o: 'ok', d: 3.4 }],
    res: { win: true, txt: 'With another provider waiting, the free models got a short share (5 s) instead of the whole budget, so Requesty still had time. Whole call: 9.5 s of 24 s.' } },
  { id: 'json', t: "Answer isn't valid JSON", s: 'json() skips it', call: "ai.json({ prompt, validate: isJob })", cfg: 'default: free models first', freeFirst: true, pre: [],
    att: [{ p: 'free', m: 'mistral-small:free', o: 'bad', d: 2.3, note: 'not JSON' }, { p: 'free', m: 'qwen3.5-flash:free', o: 'bad', d: 1.9, note: 'failed isJob()' }, { p: 'free', m: 'gemma-4-31b-it:free', o: 'ok', d: 2.4 }],
    res: { win: true, txt: "Two answers came back and were rejected: one wasn't JSON, one failed your check. The third was returned as typed data." } },
  { id: 'ownkey', t: 'A customer brings their own key', s: 'their money, not yours', call: "ai.complete({ prompt, apiKey: customerKey })", cfg: 'their key replaces yours; your fallbacks and ledger are not used', freeFirst: true,
    pre: ['<span class="k">key</span> the caller\'s key replaces the platform key; the paid model is allowed', '<span class="k">key</span> platform fallbacks and the spend ledger are not used for this call'],
    att: [{ p: 'free', m: 'gemma-4-31b-it:free', o: 'fail', d: 0.4, note: '429 per-minute' }, { p: 'free', m: 'deepseek-v4:free', o: 'fail', d: 0.5, note: '429 upstream busy' }, { p: 'paid', m: 'claude-haiku-5.5 (their key)', o: 'ok', d: 3.0 }],
    res: { win: true, txt: "The paid model answered on the customer's own key. Your Requesty and Groq keys were never touched, and nothing was added to your spend." } },
  { id: 'budget', t: 'The spend limit is reached', s: 'free models keep answering', call: "ai.complete({ prompt })", cfg: "paidFirst + spend: { allow, record }", freeFirst: false,
    pre: ['<span class="k">spend</span> allow() says no: today\'s limit is used up'],
    att: [{ p: 'paid', skip: 'skipped: spend limit reached' }, { p: 'free', m: 'gemma-4-31b-it:free', o: 'ok', d: 3.8 }],
    res: { win: true, txt: 'Instead of failing, the call fell back to the free models. If those had failed too, the error would be kind "budget".' } },
  { id: 'private', t: 'A private call', s: 'a CV must not be kept', call: "ai.complete({ prompt: cv, private: true })", cfg: "OpenRouter is told: provider.data_collection = 'deny'", freeFirst: true,
    pre: ['<span class="k">private</span> only providers that do not keep or train on the prompt may be used'],
    att: [{ p: 'free', m: 'gemma-4-31b-it:free', o: 'fail', d: 0.4, note: 'no provider meets the policy' }, { p: 'free', m: 'nemotron-ultra', o: 'fail', d: 0.4, note: 'no provider meets the policy' }, { p: 'paid', m: 'claude-haiku-5.5', o: 'ok', d: 3.2 }],
    res: { win: true, txt: "Few free models can meet that rule, so the paid model answered. These failures are not counted against the free models, because they say nothing about whether the models work." } },
  { id: 'abort', t: 'The person leaves', s: 'cancel everything', call: "ai.complete({ prompt, signal })", cfg: 'req.on("close", () => controller.abort())', freeFirst: true, pre: [],
    att: [{ p: 'free', m: 'gemma-4-31b-it:free', o: 'fail', d: 1.2, note: 'aborted' }],
    res: { win: false, kind: 'aborted', detail: 'the call and every model after it stop', msg: say('aborted') } },
  { id: 'daily', t: 'The daily limit is hit', s: 'a typed error, plain advice', call: "ai.complete({ prompt })", cfg: 'default: free models first; no paid, no fallback', freeFirst: true, pre: [],
    att: [{ p: 'free', m: 'gemma-4-31b-it:free', o: 'fail', d: 0.3, note: '429 daily' }, { p: 'free', m: 'qwen3.5-flash:free', o: 'fail', d: 0.3, note: '429 daily' }, { p: 'paid', skip: 'skipped: not allowed on the shared key' }],
    res: { win: false, kind: 'rate_limit', detail: 'detail.rateLimit.kind = "daily"', msg: say('rate_limit') } },
  { id: 'auth', t: 'A bad API key', s: '401, not blamed on a model', call: "ai.complete({ prompt, apiKey: customerKey })", cfg: 'default', freeFirst: true, pre: [],
    att: [{ p: 'free', m: 'gemma-4-31b-it:free', o: 'fail', d: 0.2, note: '401' }],
    res: { win: false, kind: 'auth', detail: 'not counted against any model', msg: say('auth_own') } },
];
const LANES = [['free', 'Free'], ['paid', 'Paid'], ['fallback', 'Fallback']];

let cur = 'badday', timers = [];
const scen = $('scen');
S.forEach((x) => { const b = el('button'); b.type = 'button'; b.dataset.id = x.id; b.setAttribute('aria-pressed', 'false'); b.append(x.t, el('small', '', x.s)); scen.appendChild(b); });
scen.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) run(b.dataset.id); });
$('replay').addEventListener('click', () => run(cur));
const scale = $('scale');

function run(id) {
  timers.forEach(clearTimeout); timers = []; cur = id;
  const sc = S.find((x) => x.id === id);
  const total = sc.att.reduce((n, a) => n + (a.skip ? 0 : a.d), 0);
  SPAN = Math.max(12, Math.ceil((total + 0.5) / 3) * 3);
  scale.textContent = '';
  for (let s = 0; s <= SPAN; s += 3) { const sp = el('span', '', s + 's'); sp.style.left = pct(s); scale.appendChild(sp); }
  scen.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === id)));
  $('stitle').textContent = sc.t; $('scall').textContent = sc.call; $('scfg').textContent = sc.cfg; $('clock').textContent = '0.0 s of 24 s';

  const lanes = $('lanes'); lanes.textContent = '';
  LANES.forEach(([k, l]) => {
    const lane = el('div', 'lane'); lane.appendChild(el('div', 'lab', l));
    const tr = el('div', 'track'); tr.id = 'tr-' + k;
    if (k === 'free' && sc.freeFirst) { const z = el('div', 'zone'); z.style.left = '0'; z.style.width = pct(FREE); tr.appendChild(z); }
    lane.appendChild(tr); lanes.appendChild(lane);
  });
  const mk = (cls, s) => { const d = el('div', cls); d.style.left = 'calc(96px + (100% - 96px) * ' + (s / SPAN) + ')'; return d; };
  if (sc.freeFirst && FREE <= SPAN) lanes.appendChild(mk('freeline', FREE));
  if (BUDGET <= SPAN) lanes.appendChild(mk('budgetline', BUDGET));
  else { const n = el('span', 'budgetnote', 'budget: 24 s →'); scale.appendChild(n); }

  const log = $('log'); log.textContent = ''; const res = $('result'); res.className = 'result'; res.textContent = '';
  let t = 0, delay = 0;
  const line = (html) => timers.push(setTimeout(() => { const d = el('div'); d.innerHTML = html; log.appendChild(d); requestAnimationFrame(() => d.classList.add('in')); log.scrollTop = 1e6; }, delay));
  line('<span class="d">→ ' + sc.call.replace(/</g, '&lt;') + '</span>'); delay += 400;
  sc.pre.forEach((p) => { line(p); delay += 600; });

  const hasBar = {}; sc.att.forEach((a) => { if (!a.skip) hasBar[a.p] = true; });
  sc.att.forEach((a) => {
    const tr = $('tr-' + a.p);
    if (a.skip) {
      // A lane that is never used says why; one that is used gets the reason in the log, so the two do not overlap.
      if (!hasBar[a.p]) { const sk = el('div', 'lane-skip', a.skip); tr.appendChild(sk); timers.push(setTimeout(() => { sk.style.opacity = 1; }, delay)); }
      line('<span class="d">' + a.p + ' phase ' + a.skip + '</span>'); delay += 500; return;
    }
    const b = el('div', 'bar ' + a.o, a.m); b.title = a.m + ' · ' + a.d.toFixed(1) + ' s'; b.style.left = pct(t); tr.appendChild(b);
    const w = pct(a.d), start = t;
    timers.push(setTimeout(() => { b.style.width = w; $('clock').textContent = (start + a.d).toFixed(1) + ' s of 24 s'; }, delay));
    t += a.d; delay += 900;
    const out = { ok: '<span class="g">answered</span>', slow: '<span class="k">too slow, moving on</span>', fail: '<span class="r">' + (a.note || 'failed') + '</span>', bad: '<span class="k">answer rejected: ' + a.note + '</span>' }[a.o];
    line('<span class="k">attempt</span> ' + a.p + ' · ' + a.m + ' · ' + a.d.toFixed(1) + 's · ' + out);
  });
  timers.push(setTimeout(() => {
    const r = sc.res;
    if (r.win) { res.classList.add('win', 'show'); const tg = el('span', 'tag', '✓ answered'); res.append(tg, el('p', '', r.txt)); }
    else {
      res.classList.add('lose', 'show');
      res.append(el('span', 'tag', '✕ LodestoneError · kind: ' + r.kind), el('p', 'mono', r.detail), el('p', '', 'explain(err) gives the person something like:'), el('blockquote', '', r.msg));
    }
  }, delay + 200));
}
run('badday');

const errs = $('errs');
DATA.errors.filter((e) => !e.hidden).forEach((e) => {
  const b = el('button', 'err'); b.type = 'button'; b.setAttribute('aria-expanded', 'false');
  b.append(el('code', '', e.kind), el('span', 'what', e.what), el('span', 'say', '“' + e.say + '”'));
  b.addEventListener('click', () => b.setAttribute('aria-expanded', String(b.getAttribute('aria-expanded') !== 'true')));
  errs.appendChild(b);
});

// Reveal on scroll: content is visible by default; the .js class (set in theme.js) only adds the starting state.
const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.08 });
document.querySelectorAll('.rise').forEach((n) => io.observe(n));
window.addEventListener('beforeprint', () => document.querySelectorAll('.rise').forEach((n) => n.classList.add('in')));

// Site chrome: reading progress and the section being read (the menu and theme switch are in menu.js, on every page).
(() => {
  const root = document.documentElement;
  const bar = $('progress');
  let ticking = false;
  const update = () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    bar.style.setProperty('--p', max > 0 ? Math.min(1, scrollY / max) : 0);
    ticking = false;
  };
  addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
  addEventListener('resize', update);
  update();

  const links = [...document.querySelectorAll('.onpage a[href^="#"]')];
  const targets = links.map((a) => $(a.hash.slice(1))).filter(Boolean);
  const so = new IntersectionObserver((es) => {
    const vis = es.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
    if (!vis[0]) return;
    links.forEach((a) => {
      if (a.hash === '#' + vis[0].target.id) {
        a.setAttribute('aria-current', 'location');
        const nav = a.parentElement, l = a.offsetLeft - nav.offsetLeft;
        if (l < nav.scrollLeft || l + a.offsetWidth > nav.scrollLeft + nav.clientWidth) nav.scrollTo({ left: l - 12, behavior: 'smooth' });
      } else a.removeAttribute('aria-current');
    });
  }, { rootMargin: '-35% 0px -60% 0px' });
  targets.forEach((t) => so.observe(t));

  // In-page links move focus to the section, so keyboard and screen-reader users land there.
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const t = $(a.hash.slice(1));
    if (!t) return;
    e.preventDefault();
    t.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    if (!t.hasAttribute('tabindex')) t.setAttribute('tabindex', '-1');
    t.focus({ preventScroll: true });
    try { history.pushState(null, '', '#' + t.id); } catch (err) { /* ignore */ }
  });
})();

// Free model weather: one read of KeyStone's public summary. The section stays hidden until there is something to show:
// a live panel with nothing in it is worse than no panel.
(() => {
  const rows = $('weather-rows');
  const row = (cells) => { const tr = el('tr'); cells.forEach(([text, cls]) => tr.appendChild(el('td', cls, text))); return tr; };
  fetch('https://keystone.extrafemi.com/api/ai-weather', { headers: { Accept: 'application/json' } })
    .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
    .then((w) => {
      if (!Array.isArray(w.models) || !w.models.length) return;
      w.models.forEach((m) => rows.appendChild(row([
        [m.model], [m.provider], [String(m.tries), 'num2'], [m.successRate + '%', 'num2'], [String(m.timedOut), 'num2'],
        [m.medianMs == null ? 'none answered' : (m.medianMs / 1000).toFixed(1) + ' s', 'num2'],
      ])));
      $('weather-note').append(' Updated ' + new Date(w.generatedAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC, from ' + w.daysWithData + ' of the last ' + w.days + ' days.');
      $('weather').hidden = false;
      $('nav-weather').hidden = false;
    })
    .catch(() => { /* not readable just now: the section stays hidden */ });
})();
