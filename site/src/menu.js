/* The menu: opens and closes the list of site links, at every width.
   Loaded on every page. Without JavaScript the links stay visible (see .js in style.css). */
(() => {
  const btn = document.getElementById('menu');
  const nav = document.getElementById('sections');
  if (!btn || !nav) return;
  const set = (open) => {
    nav.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', String(open));
    btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  };
  btn.addEventListener('click', () => set(btn.getAttribute('aria-expanded') !== 'true'));
  nav.addEventListener('click', (e) => { if (e.target.closest('a')) set(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && nav.classList.contains('open')) { set(false); btn.focus(); } });
  document.addEventListener('click', (e) => { if (nav.classList.contains('open') && !e.target.closest('.sitebar')) set(false); });
})();

/* The light/dark switch, on every page. theme.js applies a saved choice before paint; this changes it. */
(() => {
  const btn = document.getElementById('theme');
  if (!btn) return;
  const root = document.documentElement;
  const isDark = () => (root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches);
  const label = () => btn.setAttribute('aria-label', isDark() ? 'Switch to light mode' : 'Switch to dark mode');
  label();
  btn.addEventListener('click', () => {
    root.dataset.theme = isDark() ? 'light' : 'dark';
    try { localStorage.setItem('ls-theme', root.dataset.theme); } catch (e) { /* storage blocked: the choice lasts for this visit */ }
    label();
  });
})();
