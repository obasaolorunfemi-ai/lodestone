// Runs scripts/worker/index.mjs in workerd (the Cloudflare Workers runtime) through Miniflare:  npm run smoke:workers
import { Miniflare } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mf = new Miniflare({ modules: true, scriptPath: join(root, 'scripts/worker/index.mjs'), modulesRoot: root, compatibilityDate: '2026-08-01',
  // dist/ is ES modules with a .js extension; Miniflare assumes CommonJS for .js unless told.
  modulesRules: [{ type: 'ESModule', include: ['**/*.js', '**/*.mjs'] }] });
try {
  const res = await mf.dispatchFetch('http://worker.test/');
  const text = await res.text();
  if (!res.ok) { console.error(`FAILED on Cloudflare Workers (workerd):\n${text}`); process.exitCode = 1; }
  else console.log(`ok on Cloudflare Workers (workerd): ${JSON.parse(text).checks.length} checks`);
} finally { await mf.dispose(); }
