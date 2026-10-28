/* Runs in <head> before paint: applies a saved light/dark choice and marks JS as available. */
(() => {
  const r = document.documentElement;
  r.classList.add('js');
  try { const t = localStorage.getItem('ls-theme'); if (t === 'light' || t === 'dark') r.dataset.theme = t; } catch (e) {}
})();
