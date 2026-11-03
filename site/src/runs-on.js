'use strict';
/* "Runs on Lodestone": for each tool that publishes a public summary of its attempts, one read of that summary, shown as a few numbers
   and a bar. Counts and times only. A small sample is labelled as one. If the summary cannot be read, the card says so and nothing else changes. */
const SMALL_SAMPLE = 30; // the same floor Lodestone applies to a scorecard score: fewer than 30 attempts says little

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function when(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const date = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }).format(d);
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  const ago = mins < 2 ? 'just now' : mins < 90 ? `${mins} minutes ago` : mins < 48 * 60 ? `${Math.round(mins / 60)} hours ago` : null;
  return `${date}, ${time} UTC${ago ? ` (${ago})` : ''}`;
}

function stat(label, value) {
  const wrap = el('div');
  wrap.append(el('dt', '', label), el('dd', 'num', value));
  return wrap;
}

/** The same facts for a table cell: the rate, what it is out of, a bar, and where to read more. */
function renderCompact(box, w, { tries, answered, rate, days, models }) {
  const withTimes = models.filter((m) => Number.isFinite(Number(m.medianMs)));
  const top = el('p', 'live-rate');
  top.append(el('span', 'num', `${Math.round(rate * 10) / 10}%`), el('span', 'of', ` ${answered} of ${tries} answered`));
  if (tries < SMALL_SAMPLE) top.append(el('span', 'live-badge', 'Small sample'));
  const bar = el('div', 'live-bar');
  bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', `${Math.round(rate)} percent of attempts answered`);
  const fill = el('span');
  bar.append(fill);
  box.dataset.level = rate >= 95 ? 'good' : rate >= 80 ? 'warn' : 'bad';
  const note = el('p', 'live-note');
  const bits = [];
  if (days !== 7) bits.push(`Last ${days} days.`);
  if (models.length === 1 && withTimes.length === 1) bits.push(`Median ${(Number(withTimes[0].medianMs) / 1000).toFixed(1)} s.`);
  const stamp = when(w.generatedAt);
  if (stamp) bits.push(`Updated ${stamp}.`);
  note.append(document.createTextNode(bits.join(' ') + ' '));
  const a = el('a', '', 'See the data');
  a.href = box.dataset.weather;
  note.append(a);
  box.textContent = '';
  box.append(top, bar, note);
  box.dataset.live = 'true';
  requestAnimationFrame(() => { fill.style.width = `${Math.max(0, Math.min(100, rate))}%`; });
}

function render(box, w) {
  const models = Array.isArray(w.models) ? w.models : [];
  const tries = models.reduce((n, m) => n + (Number(m.tries) || 0), 0);
  const answered = models.reduce((n, m) => n + (Number(m.answered) || 0), 0);
  const name = box.dataset.name || 'this tool';
  const days = Number(w.days) || 7;
  box.textContent = '';
  if (!tries) {
    box.append(el('p', 'live-note', 'Counting is under way. Nothing to show until a model has had five attempts.'));
    return;
  }
  const rate = (answered / tries) * 100;
  if (box.dataset.compact) return renderCompact(box, w, { tries, answered, rate, days, models });
  const head = el('p', 'live-head');
  head.append(el('span', 'dot'), document.createTextNode(`Live from ${name}`), el('span', 'span', `last ${days} days`));
  if (tries < SMALL_SAMPLE) head.append(el('span', 'live-badge', 'Small sample'));
  const stats = el('dl', 'live-stats');
  stats.append(stat('Attempts', String(tries)), stat('Answered', String(answered)), stat('Answer rate', `${Math.round(rate * 10) / 10}%`));
  const withTimes = models.filter((m) => Number.isFinite(Number(m.medianMs)));
  if (models.length === 1 && withTimes.length === 1) stats.append(stat('Median answer', `${(Number(withTimes[0].medianMs) / 1000).toFixed(1)} s`));
  else stats.append(stat(models.length === 1 ? 'Model' : 'Models', String(models.length)));
  const bar = el('div', 'live-bar');
  bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', `${Math.round(rate)} percent of attempts answered`);
  const fill = el('span');
  bar.append(fill);
  box.dataset.level = rate >= 95 ? 'good' : rate >= 80 ? 'warn' : 'bad';
  const note = el('p', 'live-note');
  const bits = [];
  if (tries < SMALL_SAMPLE) bits.push(`Only ${plural(tries, 'attempt', 'attempts')} so far, too few to read much into.`);
  if (Number.isFinite(Number(w.daysWithData))) bits.push(`Counted on ${Number(w.daysWithData)} of the last ${days} days.`);
  const stamp = when(w.generatedAt);
  if (stamp) bits.push(`Updated ${stamp}.`);
  note.append(document.createTextNode(bits.join(' ') + ' '));
  const a = el('a', '', 'See the data');
  a.href = box.dataset.weather;
  note.append(a);
  box.append(head, stats, bar, note);
  box.dataset.live = 'true';
  requestAnimationFrame(() => { fill.style.width = `${Math.max(0, Math.min(100, rate))}%`; }); // set through the style object: the page's CSP allows that, not a style attribute
}

document.querySelectorAll('[data-weather]').forEach((box) => {
  fetch(box.dataset.weather, { headers: { Accept: 'application/json' } })
    .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
    .then((w) => render(box, w))
    .catch(() => { box.textContent = ''; box.append(el('p', 'live-note', 'The live counts could not be read just now.')); });
});
