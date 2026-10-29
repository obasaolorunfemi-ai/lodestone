# Protecting your budget on a public tool

A free public tool that calls a paid model has one big risk: somebody finds the endpoint and calls it in a loop. Lodestone gives you three layers, from the one that stops one person to the one that stops everyone.

## 1. Per caller: `rateLimit`

```ts
import { createLodestone, createRateLimiter, upstashStore } from '@extrafemi-ai/lodestone';

const store = upstashStore({ url: process.env.UPSTASH_URL!, token: process.env.UPSTASH_TOKEN! });
const ai = createLodestone({
  /* ... */
  rateLimit: {
    limiter: createRateLimiter({ store, max: 20, windowMs: 3_600_000 }),   // 20 calls an hour each
    whenOver: 'free-only',                                                 // or 'reject' (the default)
  },
});

await ai.complete({ prompt, caller: userId ?? clientIp });
```

- A call that names a `caller` counts against that caller's allowance. A call with no `caller`, a call on the caller's own key (their money) and an explicit `route` are not limited. **Pass `caller` on every public call.**
- Over the allowance, `whenOver: 'reject'` fails with `kind: 'throttled'` and `err.detail.retryAfterMs`; `explain(err)` says "Try again in about N minutes". `'free-only'` still answers, from free models only, so the abuser can never cost you anything.
- Only a SHA-256 hash of the caller is stored, never the caller, so an IP address does not end up in your store.
- Exactness depends on the store. With `upstashStore` (or `memoryStore` in one process) the count is atomic. With a plain get/set store it is exact inside one process and approximate between processes: two functions answering the same caller at the same moment can let a call or two through. For a tool that is attacked, use Upstash.
- If the store cannot be reached the limiter lets the call through by default (`onStoreError: 'allow'`) so a broken store does not take your tool down; the spend limit below is the backstop. Set `'deny'` to fail closed.

## 2. Everyone together: `createSpendLimit`

```ts
const spend = createSpendLimit({ store, dailyUsd: 2, monthlyUsd: 30, holdUsd: 0.01 });
const ai = createLodestone({ /* ... */, spend });
await spend.report();   // { todayUsd, monthUsd, heldUsd, ... }
```

A plain "is the total under the limit?" check lets a burst through: fifty requests all read the same total, all pass, all spend. `createSpendLimit` takes a **hold** (`holdUsd`, roughly the most one call can cost) for each paid attempt when it is allowed, and counts holds against the limit, so concurrent requests see each other. The hold is replaced by the real cost when the attempt answers and given back when it does not; a hold that is never settled (the function was killed) expires after two minutes.

Be honest about the limits of it: inside one process it is exact. Between processes, with a get/set store, two functions can each take a hold the other did not see, so leave headroom (set the limit a little under what you can afford). If the ledger cannot be read, the paid attempt is refused.

Bring your own: `spend` is just `{ allow, record, release? }`, and `allow`/`record`/`release` receive an `id` that names one attempt so you can do the same with a database that has transactions.

## 3. The ceiling on one call

`maxTokens` (3,500 by default) bounds what one call can produce, and `budgetMs` bounds how long it can run. Set `maxTokens` per task (`profiles`) to what the task needs.

## What this does not do

Lodestone cannot tell a real person from a script: `caller` is whatever you pass. If your callers are anonymous, an IP address is a weak identity (shared networks, rotating addresses). For a tool that is attacked, put a bot check (a CAPTCHA or a signed token) in front of the endpoint, and treat the layers above as the part that limits the damage when one gets through.
