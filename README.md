# Lodestone

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

### Phases

For each call, in order, until one answers:

1. OpenRouter's free models for the tier (current ones, per the catalogue).
2. A low-cost paid OpenRouter model, only if the caller supplied their own key or you set `allowPaid`. With no credit OpenRouter refuses it and nothing is spent.
3. Each `fallbacks` provider, with its own key.

When a later phase exists, the free models get a short turn (9 s in all by default), so there is always time left for it. The whole call stays inside `budgetMs` (24 s by default, under a 30 s gateway limit).

### Keeping the catalogue fresh

Give it somewhere to keep the catalogue (anything that can get and set JSON by key; the default is memory), and run `checkModels()` once a day:

```ts
const ai = createLodestone({ store: { get: (k) => blobs.get(k, { type: 'json' }), set: (k, v) => blobs.setJSON(k, v) }, /* ... */ });

// daily
const { ok, withdrawn, shortTiers } = await ai.checkModels();
```

`withdrawn` lists preferred models that have gone. That is harmless, they are already replaced. `ok` is false only when the catalogue can't be read or a tier is left with fewer than two real models. Without a daily run, a request that finds the saved catalogue over a day old refreshes it in the background.

### Letting measurements decide the order

A scorecard (a small JSON file of measured results) can put the models that did best on your kind of task first, and Lodestone can publish its own live success rates and speeds in the same format. [Naija Eval](https://naija-eval.extrafemi.com) publishes translation and speech quality for Hausa, Igbo and Yoruba this way. It is opt-in, per task, and only changes the order models are tried in. See [docs/scorecards.md](docs/scorecards.md).

### Caching

Pass `cacheKey` for a pure, repeatable task (for example a hash of a job page) and the answer is saved in the store and reused for `cacheTtlMs` (a day by default). Failures are never cached.

### Observing it

`onAttempt` is called after every model attempt with the provider, model, phase, outcome, status and time. It never receives prompts or answers. Lodestone doesn't log prompts or answers anywhere.

## Errors

`complete()` and `json()` throw a `LodestoneError` whose `kind` is one of `auth`, `rate_limit`, `slow`, `credit`, `withdrawn`, `unavailable`, `bad_output`, `not_configured` or `other`. `detail` carries the HTTP status and, for rate limits, which kind it was. `explain(err, { product, settingsHint })` turns any of them into a message for a person.

## Develop

```bash
npm install
npm test
npm run build
```

Releases: bump `version` in `package.json`, then push a tag (`git tag v0.1.0 && git push --tags`). The release workflow tests, builds and publishes to npm with provenance. It needs an `NPM_TOKEN` secret on the repository.

## Licence

MIT
