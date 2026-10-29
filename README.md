# Lodestone

**[lodestone.extrafemi.com](https://lodestone.extrafemi.com)**: an interactive walkthrough of what it does.

Calls AI models so your tool keeps working when a model is withdrawn, slow or rate-limited.

Free and cheap models come and go. A hard-coded model id breaks without warning, one slow model can use your whole time limit, and "429" can mean four different things that need four different messages. Lodestone handles those so each tool doesn't have to.

- **Replaces withdrawn models by itself.** Your lists are preferences. They are checked against OpenRouter's live catalogue, and any model that has gone is swapped for a current one of the same kind.
- **Keeps inside a time budget.** Each model gets a slice of it. A slow or failing model is skipped for the next, so a function never hits its gateway limit with an unreadable error.
- **Falls back across providers.** OpenRouter's free models, then a low-cost paid model, then Anthropic or Google on their own keys.
- **Explains failures in plain words.** A daily limit, a per-minute limit, a busy upstream provider, a bad key and a slow model are different errors with different advice.
- **Checks the answer.** `json()` skips a model whose answer isn't valid JSON, or doesn't pass your validator.
- **Bring your own key.** A caller's key replaces the platform's and allows the paid fallback, without touching the platform's budget.
- **No dependencies.** Plain `fetch`. Node 20+.

## Use

```ts
import { anthropic, createLodestone, explain } from '@extrafemi-ai/lodestone';

const ai = createLodestone({
  openrouter: { apiKey: process.env.OPENROUTER_API_KEY },
  fallbacks: [
    { provider: anthropic(), apiKey: process.env.ANTHROPIC_API_KEY!, models: ['claude-haiku-5-5'] },
  ],
  profiles: {
    'extract-job': { tier: 'fast', maxTokens: 1500 },
    'write-cv': { tier: 'strong', maxTokens: 3500, temperature: 0.4 },
  },
});

try {
  const { data } = await ai.json<Job>({ task: 'extract-job', prompt, validate: isJob });
} catch (err) {
  // A message you can show a person.
  return explain(err, { product: 'MyApp', settingsHint: 'in Settings' });
}
```

`validate` is a type guard you write. Or pass a schema, anything with `safeParse` (Zod, for example), and `data` is what it returns:

```ts
const Job = z.object({ title: z.string(), remote: z.boolean().default(false) });
const { data } = await ai.json({ task: 'extract-job', prompt, schema: Job }); // data: { title: string; remote: boolean }
```

`import { anthropic, google, openrouter, mock } from '@extrafemi-ai/lodestone'` for the provider adapters.

### Tiers

`fast` (extraction, classification), `strong` (writing, judgement) and `vision` (reading images). A call picks one through its `task` profile or `tier`, and uses `vision` by itself when the messages contain an image.

### Choosing the provider and model yourself (`route`)

Tiers are for tools that don't care which model answers. A tool that picks its own provider and model per request (a paid model, a customer's own key) passes a `route` instead: exactly these steps, in order, until one answers.

```ts
await ai.complete({
  system, messages, maxTokens: 900,
  route: [
    { provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: customerKey },
    { provider: 'openrouter', model: 'anthropic/claude-sonnet-4-5', apiKey: backupKey },
  ],
});
```

A step with no key is skipped. A route skips the model lists and the catalogue, leaves temperature to the provider unless you set one, and still gets the time budget, typed failures and usage. `detail.providerMessage` on the error carries the provider's own message. Replace or add provider adapters with the `providers` option, for example `providers: { openrouter: openrouter({ lowReasoning: false }) }`.

Keep a customer's own key out of any fallback step: build the route from their key only.

### Your own key

Pass the customer's OpenRouter key as `apiKey` on a call. It replaces the platform's key, allows the paid fallback, and is never stored. The platform's `fallbacks` are **not** used on a call with a customer's own key (they carry the platform's money), unless a fallback sets `allowWithCallerKey`. Attempts that fail with 401, 402 or 403 are not counted in live stats, because they say nothing about the model.

### Phases

For each call, in order, until one answers:

1. OpenRouter's free models for the tier (current ones, per the catalogue).
2. A low-cost paid OpenRouter model, only if the caller supplied their own key or you set `allowPaid`. With no credit OpenRouter refuses it and nothing is spent.
3. Each `fallbacks` provider, with its own key.

When a later phase exists, the free models get a short turn (9 s in all by default), so there is always time left for it. The whole call stays inside `budgetMs` (24 s by default, under a 30 s gateway limit).

### Keeping the catalogue fresh

Give it somewhere to keep the catalogue (anything that can get and set JSON by key; the default is memory). Adapters for Netlify Blobs, Cloudflare KV, Upstash (and Vercel KV) and Deno KV are included, see [docs/stores.md](docs/stores.md). Run `checkModels()` once a day:

```ts
const ai = createLodestone({ store: netlifyBlobsStore(getStore('lodestone')), /* ... */ });

// daily
const { ok, withdrawn, shortTiers } = await ai.checkModels();
```

`withdrawn` lists preferred models that have gone. That is harmless, they are already replaced. `ok` is false only when the catalogue can't be read or a tier is left with fewer than two real models. Without a daily run, a request that finds the saved catalogue over a day old refreshes it in the background.

### Free models that are not worth waiting for (`paidFirst`)

Free models can be down for hours (rate-limited, or holding a connection open for 45 seconds and never answering). On the platform's own key, `openrouter: { paidFirst: true }` tries the low-cost paid model first and the free ones only if it fails or the spend limit is reached, so a request is not slowed by free models that are not going to answer. A caller's own key is not affected: the paid models are their money, so their free models still come first. Reasoning is set per model with `openrouter({ reasoning: (model) => ... })`, because models differ: one thinks for a thousand tokens unless told not to (measured: turning it off halved scoring time, 10 s to 5 s, with the same answers), another refuses to run with reasoning off.

### Not waiting on a model that is down (circuit breaker)

Free models fail in bursts: rate-limited, stuck, or answering nothing. Without memory, every request pays for the same dead models again. `createHealth()` remembers:

```ts
import { createHealth } from '@extrafemi-ai/lodestone';
const health = createHealth({ store });   // the same store as the catalogue: every serverless function shares it
const ai = createLodestone({ /* ... */, health });
```

A model whose last three attempts (within ten minutes) all failed is skipped, so the next request goes straight to one that works. Every two minutes one attempt is let through to see whether it has recovered, and one success closes it again. A timeout, a rate limit, a server error and an unusable answer count as failures; a rejected key or missing credit (401, 402, 403) say nothing about the model and never do. If every free model looks down and a paid one can follow, the free ones are skipped entirely; if nothing can follow, they are still tried, because trying is better than not answering. `health.snapshot()` lists what it has seen, for a health page.

### Limiting what the platform spends

```ts
const spend = createSpendLimit({ store, dailyUsd: 2, monthlyUsd: 30 });
const ai = createLodestone({ /* ... */, spend });
```

`allow` is asked before each attempt that spends the platform's money (the paid models and fallback providers on the platform's keys), and a `false` means that model is not used. `record` is told what each such call cost: the provider's own figure when it gives one (OpenRouter does), otherwise an estimate from the model's catalogue price. Free models and a caller's own key (their money, not yours) never go through either. When the limit stops every paid option the error is `kind: 'budget'`. A `record` that throws never fails the answer.

`createSpendLimit` takes a **hold** for each paid attempt as it is allowed and counts holds against the limit, so a burst of concurrent requests cannot all pass the check before any has been counted. The hold is swapped for the real cost on an answer and given back (`release`) when the attempt fails. You can write your own `{ allow, record, release? }`; each receives an `id` naming the attempt.

### One person emptying the budget (`rateLimit`)

A spend limit is one pot for everybody. Give each caller their own allowance, and name the caller on each call:

```ts
const ai = createLodestone({ /* ... */, rateLimit: { limiter: createRateLimiter({ store, max: 20, windowMs: 3_600_000 }), whenOver: 'free-only' } });
await ai.complete({ prompt, caller: userId ?? clientIp });
```

Over their allowance a caller gets `kind: 'throttled'` (`'reject'`, the default) or free models only (`'free-only'`). Only a hash of the caller is stored. See [docs/protecting-your-budget.md](docs/protecting-your-budget.md) for what is exact and what is approximate.

### Providers, and not depending on one

OpenRouter is the default, but one provider's outage should not stop your tool. Give Lodestone others as `fallbacks`, each with its own key. Any service that speaks OpenAI's chat API works through `openaiCompatible()`, and presets exist for the ones Lodestone has been checked against:

| Preset | Service | Notes |
|---|---|---|
| `requesty()` | [Requesty](https://www.requesty.ai) | Gateway to 800+ models with failover. Publishes price, lab, whether a model is trained on and how long prompts are kept. `requesty({ region: 'eu' })` keeps prompts in the EU. No free models; a 5% markup. |
| `llmapi()` | [LLM API](https://llmapi.ai) | Gateway to 150+ chat models. Lists price; ignores its image, video and speech models. |
| `groq()`, `cerebras()` | Groq, Cerebras | Fast inference with free tiers. Use `free: true` so they are not counted against a spend limit. |
| `omniakey()` | [OmniaKey](https://omniakey.com) | A prepaid gateway for text, image, video and music models, with an OpenAI-compatible text endpoint. Text and JSON calls only here. Its model list needs a key and mixes chat with image, video and music models, so name your models. Not yet called live: the account's first chat call was refused for insufficient quota. |
| `openai()`, `mistral()`, `together()` | the providers themselves | |
| `ollama()` | a local server | Free and private. |
| `anthropic()`, `google()` | direct | Not OpenAI-style, so they have their own adapters. |

```ts
fallbacks: [
  { provider: requesty(), apiKey: process.env.REQUESTY_API_KEY!, models: ['bedrock/claude-haiku-5-5'], discover: { fill: { maxPromptUsdPerMTok: 1, maxCompletionUsdPerMTok: 5 }, max: 3 } },
  { provider: groq(), apiKey: process.env.GROQ_API_KEY!, models: ['llama-3.3-70b-versatile'], free: true },
]
```

Model ids are each service's own. See [examples/multi-provider.ts](examples/multi-provider.ts).

### Model lists that keep themselves alive, and short

- **Outdated or shut down.** The daily `checkModels()` saves each provider's current catalogue. A model the provider no longer lists is dropped; one with an expiry date within a week (OpenRouter publishes it) is left out; one that is failing right now is skipped by the circuit breaker. Nobody edits a list.
- **New models.** `discover: { fill }` tops a short list up from the provider's own catalogue with models within a price limit ("free" is a limit of zero) from trusted labs. For OpenRouter's free models this happens by itself.
- **Not a longer wait.** Discovery never lengthens what a request walks. A background pool (up to 8 per tier) is ranked, the models that are down are filtered out, and a request tries at most three. When one fails, the next best takes its place for later requests, so adding models adds choice, not delay.
- **Safe by default.** A discovered model is used only if its publisher is on the trust list; `trust` also takes a block list, refuses models a provider says are trained on or that keep prompts too long, and `private: true` applies the same to one call (see below). There is no vulnerability database for hosted models, so none is claimed: see [SECURITY.md](SECURITY.md) for exactly what is and is not checked.

### Private calls (`private: true`)

For a prompt that must not be kept or trained on (a CV, a medical note). What it does, exactly:

- OpenRouter is told to use only providers that do not keep or train on the prompt (`data_collection: deny`).
- A fallback provider is used only if its own model list says the model is not trained on (Requesty publishes this), **or** you vouched for it with `privacy: 'no-training'` on that fallback. A provider that publishes nothing and that you have not vouched for is skipped, even if you set no `trust` policy. Lodestone cannot see what a provider does with a prompt unless the provider says.
- The answer is never read from or written to the cache.
- Its failures are not counted against a model (few providers can meet the rule, and that says nothing about the model).
- An explicit `route` is your own choice of provider and is passed through as told.

### Cancelling

```ts
const controller = new AbortController();
req.on('close', () => controller.abort());           // the person left the page
await ai.complete({ prompt, signal: controller.signal });   // throws a LodestoneError of kind 'aborted'
```

### Where it runs

Lodestone uses only web-standard APIs and has no dependencies. CI runs the same smoke checks on Node 20, 22 and 24, on Cloudflare Workers (in `workerd`, without the Node compatibility flag), on Deno and on Bun. See [docs/runtimes.md](docs/runtimes.md) for what that does and does not show.

### Python

`python/` holds a Python port of the core: failover, the time budget, the circuit breaker, spend holds, per-caller rate limits, private calls and `explain()`, using only the standard library. It is alpha and does not yet read provider model lists or support images. See [python/README.md](python/README.md).

### Not yet

- **Streaming.** `complete()` and `json()` wait for the whole answer. Streaming needs a decision about a model that fails halfway; the likely rule is to fail over only before the first token.
- **Tool calling** (functions the model can call), and **embeddings or speech**. Lodestone is for one-shot text and JSON calls today.

### Letting measurements decide the order

A scorecard (a small JSON file of measured results) can put the models that did best on your kind of task first, and Lodestone can publish its own live success rates and speeds in the same format. [Naija Eval](https://naija-eval.extrafemi.com) publishes translation and speech quality for Hausa, Igbo and Yoruba this way. It is opt-in, per task, and only changes the order models are tried in. See [docs/scorecards.md](docs/scorecards.md).

### Caching

Pass `cacheKey` for a pure, repeatable task (for example a hash of a job page) and the answer is saved in the store and reused for `cacheTtlMs` (a day by default). The key must stand for the whole input; as a safeguard an answer is also tied to a fingerprint of the system prompt, messages and tier, so a key that is too coarse gives a miss, never another input's answer. Failures are never cached, and **a call marked `private` is never read from or written to the cache**.

### Observing it

`onAttempt` is called after every model attempt with the provider, model, phase, outcome, status and time. It never receives prompts or answers. Lodestone doesn't log prompts or answers anywhere.

## Errors

`complete()` and `json()` throw a `LodestoneError` whose `kind` is one of `auth`, `rate_limit`, `slow`, `credit`, `withdrawn`, `unavailable`, `bad_output`, `aborted`, `budget`, `throttled`, `not_configured` or `other`. `detail` carries the HTTP status and, for rate limits, which kind it was. `explain(err, { product, settingsHint })` turns any of them into a message for a person.

## Develop

```bash
npm install
npm test
npm run build
```

`npm run smoke` and `npm run smoke:workers` run the cross-runtime checks. Releases: bump `version` in `package.json`, then push a tag (`git tag v0.1.0 && git push --tags`). The release workflow tests, builds and publishes to npm with provenance. It uses npm trusted publishing, so there is no token to keep: npm trusts this repository and `release.yml` directly (set up under the package's Settings on npmjs.com).

## Licence

MIT
