# Stores

Lodestone keeps a little state: the model catalogue, which models are failing (the circuit breaker), saved answers, and, if you use them, rate-limit and spend counters. By default that state lives in memory, which is lost when a serverless function ends and is not shared between functions. For anything real, give Lodestone a store.

A store is two methods:

```ts
interface KeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, opts?: { ttlMs?: number }): Promise<void>;
}
```

`ttlMs` says how long a value is worth keeping; a store that cannot expire values may ignore it. A store that can also count atomically (`incrBy`) makes the rate limiter exact across every function. Ready-made adapters need no client library: they take the binding or token you already have.

```ts
import { createHealth, createLodestone, netlifyBlobsStore } from '@extrafemi-ai/lodestone';
import { getStore } from '@netlify/blobs';

const store = netlifyBlobsStore(getStore('lodestone'));
const ai = createLodestone({ store, health: createHealth({ store }), /* ... */ });
```

| Adapter | Use it on | Expires values | Counts atomically | Notes |
|---|---|---|---|---|
| `netlifyBlobsStore(getStore('x'))` | Netlify Functions | by Lodestone (a value carries its own expiry) | no | Fine for the catalogue, cached answers and the breaker. No atomic add, and writes from separate functions can overwrite each other. |
| `cloudflareKvStore(env.KV)` | Cloudflare Workers | by KV | no | Eventually consistent, and one key can be written about once a second. Fine for the catalogue and cached answers; the breaker learns a little slower. Not for counters. |
| `upstashStore({ url, token })` | anywhere with `fetch`, including Vercel KV | by Redis | **yes** | The one to use for per-caller rate limits and spend counters. Plain `fetch`, so it runs on Workers, Deno, Bun and Node. |
| `denoKvStore(await Deno.openKv())` | Deno and Deno Deploy | by Deno KV | no | |
| `memoryStore()` | tests, one long-running process | yes | yes (in this process) | The default. |

## Which store for which job

| Job | A plain store (Blobs, KV, Deno KV) | Upstash |
|---|---|---|
| Model catalogue, cached answers | fine | fine |
| Circuit breaker | fine | fine |
| Per-caller rate limit | exact inside one process, approximate between processes | exact |
| Spend limit (`createSpendLimit`) | exact inside one process, approximate between processes | as good as a get/set ledger can be (see [protecting your budget](protecting-your-budget.md)) |

## Writing your own

Anything that gets and sets JSON by key will do. Keys contain colons (`lodestone:health`); if your store dislikes them, `safeKey(key)` returns a version it will accept (anything outside letters, digits, `.`, `_` and `-` becomes `~` and two hex digits, so two different keys never collide).

What comes back from a store is checked before it is used: a catalogue, breaker record or ledger of the wrong shape or an absurd size is ignored, so a store that someone else can write to cannot make Lodestone hide every model or grow without limit.
