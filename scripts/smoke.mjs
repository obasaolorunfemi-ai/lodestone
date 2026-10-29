// Node, Deno and Bun:  node scripts/smoke.mjs   |   deno run --allow-read scripts/smoke.mjs   |   bun scripts/smoke.mjs
import * as lib from '../dist/index.js';
import { smoke } from './smoke-core.mjs';

const runtime = typeof Deno !== 'undefined' ? `Deno ${Deno.version.deno}` : typeof Bun !== 'undefined' ? `Bun ${Bun.version}` : `Node ${process.versions.node}`;
try {
  const r = await smoke(lib);
  console.log(`ok on ${runtime}: ${r.checks.length} checks`);
} catch (e) {
  console.error(`FAILED on ${runtime}: ${e.message}`);
  (typeof Deno !== 'undefined' ? Deno.exit : process.exit)(1);
}
