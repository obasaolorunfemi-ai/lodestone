# Runtimes

Lodestone uses only web-standard APIs (`fetch`, `Response`, `AbortSignal`, `URL`, `crypto.subtle`, `TextEncoder`) and has no dependencies, so it is not tied to Node.

| Runtime | How it is checked | Where |
|---|---|---|
| Node 20, 22 and 24 | the full test suite and the smoke checks | `npm test`, `npm run smoke` |
| Cloudflare Workers | the smoke checks run inside `workerd` through Miniflare, **without** the `nodejs_compat` flag | `npm run smoke:workers` |
| Deno | the smoke checks | `deno run --allow-read scripts/smoke.mjs` |
| Bun | the smoke checks | `bun scripts/smoke.mjs` |

All four run in CI on every push. The smoke checks (`scripts/smoke-core.mjs`) are the same on every runtime: failover, cutting off a model that hangs, `json()`, `explain()`, the circuit breaker, the spend limit under a burst, per-caller rate limiting, private calls not being cached, and the Upstash, Workers KV and scorecard code paths. They use fake providers, so they need no network and no keys.

This shows the library's code runs on those runtimes. It does not show that each provider's API behaves the same from each platform's network, which only your own deployment can tell you.

## Things to know on Workers

- Use `cloudflareKvStore(env.KV)` for the catalogue and cached answers. KV is eventually consistent and about one write per second per key, so use `upstashStore` for rate-limit and spend counters.
- A Worker has CPU and subrequest limits. A call that tries three models and two providers makes up to five subrequests; keep `ACTIVE` small, or set `budgetMs` under your plan's wall-clock limit.
