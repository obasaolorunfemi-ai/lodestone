'use strict';
/* "Runs on Lodestone": for each tool that publishes a public summary of its attempts, one read of that summary.
   Counts and times only. If a summary cannot be read, the line says so and nothing else changes. */
document.querySelectorAll('[data-weather]').forEach((line) => {
  const say = (t) => { line.textContent = t; };
  fetch(line.dataset.weather, { headers: { Accept: 'application/json' } })
    .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
    .then((w) => {
      const models = Array.isArray(w.models) ? w.models : [];
      const tries = models.reduce((n, m) => n + (Number(m.tries) || 0), 0);
      const answered = models.reduce((n, m) => n + (Number(m.answered) || 0), 0);
      if (!tries) { say('Counting is under way. Nothing to show until a model has had five attempts.'); return; }
      const when = w.generatedAt ? ' Updated ' + new Date(w.generatedAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC.' : '';
      say('Last ' + (w.days || 7) + ' days: ' + tries + ' attempts, ' + answered + ' answered (' + (Math.round((answered / tries) * 1000) / 10) + '%).' + when);
      line.dataset.live = 'true';
    })
    .catch(() => say('The live counts could not be read just now.'));
});
