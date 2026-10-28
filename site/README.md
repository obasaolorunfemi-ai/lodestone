# The Lodestone site

One static page, built from the real library so it cannot drift from the code: the failure sentences come from `explain()`, the trust table from `vet()`, and the code map from `src/`.

```bash
npm run site          # builds the library, then site/public
node site/build.mjs   # just the site, if dist/ is already built
npx wrangler deploy   # publishes site/public to Cloudflare (see ../wrangler.jsonc)
```

- `src/` is the source: `index.html` (with `{{placeholders}}`), `style.css`, `app.js`, `theme.js` and `fonts/` (Cardo and Lora, SIL OFL, copied from Naija Eval so the two sites match).
- Same rules as Naija Eval: no inline scripts, no third-party requests, a strict content-security policy (`src/_headers`).
- Claims about how far each provider has been checked are written by hand in `build.mjs` (`providers`). Update them when that changes.
- Served at https://lodestone.extrafemi.com (the `routes` entry in `wrangler.jsonc`). The canonical URL and sitemap are written by the build.
