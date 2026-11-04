# Changelog

Versions before 1.0 may change between minor releases; each change that could break a caller is marked **breaking**.

## 0.8.1

- **`cencori()` preset** (TypeScript and Python) for [Cencori](https://cencori.com), a gateway to chat models from several labs with an OpenAI-compatible endpoint (`api.cencori.com/v1`). Use it as a `fallbacks` entry. It is a preset only: a key was accepted and its model list read on 4 Nov 2026 (95 entries: Lodestone keeps the available chat models, with price and context, and leaves out image and unavailable ones, so `discover: { fill }` works with it), but the first chat call was refused with 403 `credit_balance_exhausted`, so no answer has been seen from it. Its docs say it logs the full prompt and response of every request and are silent on training and retention, so a `private` call skips it unless you vouch for it. `scripts/live-check.mjs` takes `CENCORI_API_KEY` (and `CENCORI_MODEL`).
- **Fixed: a provider with no credit left is now reported as `kind: 'credit'`.** The kind existed, with a sentence for the person, but was never produced, so a provider's "credit exhausted" came out as `other` and the generic "something went wrong". It is now produced for a 402, and for a 403 whose own words are about credit, balance, quota or billing (Cencori and OmniaKey both answer 403); any other 403 is still `other`. Python: the same.

## 0.8.0

- **A spend share for each caller.** `createSpendLimit({ perCaller: { dailyUsd, monthlyUsd } })` gives each caller (`caller` on the call; only a hash is stored) their own share of the pool, so one person cannot use it up for everyone. A call over its share fails with `kind: 'budget'` and `detail.scope: 'caller'` (`'app'` when the whole pool ran out); `explain()` words each. `spendCap` on a call lets a person lower their own share, never raise it. `spend.callerReport(caller)` says what they have used. A custom `SpendControl` can implement `refusal(id)` to report the scope.
- **An optional cap on a person's own key, off by default.** `spendCap` on a call that carries the person's own `apiKey` counts their paid calls on that key in a ledger of their own (never the pool's) and stops at the number they chose (`scope: 'own-key'`). Without `spendCap` a caller's own key is still neither counted nor limited. A `spendCap` that cannot be kept (no `caller`, or a spend limit not made by `createSpendLimit`) throws a `TypeError` instead of being ignored. The provider's own limit on the key is the one that really holds; the docs say so. Python: `SpendLimit(per_caller=...)`, `spend_cap=` on a call, `caller_report()`.
- **Anthropic self-healing.** `anthropic()` can now list Anthropic's models (`listModels`), so a fallback on the direct API keeps its chain alive like OpenRouter's: a retired id, or one retiring within a week, is dropped. New opt-in `discover: { replaceRetired: true }` swaps a gone model for the newest active model of the same `line` (never another line, never deprecated, trust policy applied, image-capable for vision calls) and `checkModels()` reports every swap (`replaced`, `unreplaced`). `CatalogModel` gains `lifecycle`, `line` and `created_at`; `healProviderModels()` is exported. Python port: `Anthropic.list_models`, `Fallback(discover=Discover(replace_retired=True))`, `heal_provider_models`, and `Lodestone.check_providers()`. Tested on fake responses only: the real Models API has not been called.

## 0.7.1

- **`omniakey()` preset** (TypeScript and Python) for [OmniaKey](https://omniakey.com), a prepaid gateway with an OpenAI-compatible text endpoint. Use it as a `fallbacks` entry. It is a preset only: a key was accepted and its model list read (98 entries, with image, video and music models mixed in and nothing to tell them apart, so name your models and do not use `discover` with it), but the first chat call was refused with `insufficient_user_quota`, so it has not been seen to answer, and the Providers page says so. Text and JSON calls only; OmniaKey's image, video and music models are outside what Lodestone does.

- **Fixed: the direct Anthropic adapter no longer sends a temperature.** Anthropic's current models reject one: Claude 4.7 and later answer 400 to a non-default value, and API version 2026-10-21 removes the parameter for every model. Lodestone's calls default to 0.2, so a direct call to a current Claude model would have failed. `anthropic()` now leaves it out and the model's own setting applies; `anthropic({ sendTemperature: true })` restores it for an older model. The Python port's `Anthropic(send_temperature=...)` works the same way. Calls through OpenRouter are unaffected. This was found by reading Anthropic's deprecations page, not from a failure: no live call to Anthropic has been made.
- README: the route example used `claude-sonnet-4-5`, which Anthropic has deprecated; it now uses `claude-sonnet-5-5`.

## 0.7.0

Security fixes, shared state that works on every platform, per-caller limits, and runtimes beyond Node. Found in a review of 0.6.0.

**Security**
- **Private calls are never cached.** Before, a call with `private: true` and a `cacheKey` saved its answer (made from a CV, say) in the shared store for a day. Now it is neither read from nor written to the cache. **Breaking** for anyone who relied on caching private calls.
- **A cached answer is tied to its input.** The cache stores a fingerprint of the system prompt, messages and tier with each answer; a `cacheKey` that is too coarse gives a miss, never another input's answer. Answers saved by 0.6.0 have no fingerprint and are treated as misses.
- **`private` now holds for fallback providers with no `trust` policy.** A fallback is used for a private call only if its own model list says the model is not trained on, or you vouch for it with the new `privacy: 'no-training'`. **Breaking** if you used `private: true` with an `anthropic()`, `google()` or other fallback that publishes nothing: add `privacy: 'no-training'` once you have checked that provider's terms.
- **The spend limit holds under a burst.** `createSpendLimit()` takes a hold for each paid attempt, settles it with the real cost, and gives it back when the attempt fails. `SpendControl` gains an optional `release()`, and `allow`/`record` receive an `id`.
- **Per-caller rate limits.** `createRateLimiter()` and `rateLimit` in the config; `caller` on a call; new failure kind `throttled` (with `detail.retryAfterMs` and an `explain()` sentence); `whenOver: 'free-only'` keeps serving an over-limit caller from free models. Only a hash of the caller is stored.
- **Anything read from a store is checked** (catalogue, circuit-breaker state, spend ledger, rate-limit counters) for shape and size.
- **`ProviderError.body` is no longer an enumerable property**, so logging the error does not print a provider's echo of the prompt.
- **`fetchScorecard`** now requires https (http only for localhost), reads at most `maxBytes` (1 MB default), and takes `allowedHosts`, checked again after a redirect. A scorecard with more than 20,000 entries is refused.
- **Supply chain.** GitHub Actions are pinned to commits, Dependabot and CodeQL are on, and the release job runs in a protected environment. The site sends `Strict-Transport-Security` with `includeSubDomains`, no longer allows inline style attributes in its Content-Security-Policy, and publishes `/.well-known/security.txt`.

**Reach**
- **Store adapters:** `netlifyBlobsStore`, `cloudflareKvStore`, `upstashStore` (which can count atomically) and `denoKvStore`, plus `safeKey`. `KeyValueStore.set` takes an optional `{ ttlMs }`; `AtomicStore` adds `incrBy`.
- **Runtimes.** CI now runs the same smoke checks on Node 20, 22 and 24, Cloudflare Workers (`workerd`, no Node compatibility flag), Deno and Bun. Nothing in the library needed to change to pass.
- **Python port** in `python/` (alpha; not on PyPI yet, install from the repository): failover, time budget, circuit breaker, spend holds, rate limits, private calls, `explain()`, standard library only.
- The site gains a docs section (stores, protecting your budget, runtimes, Python, security), `llms.txt`, and a sitemap that lists them; the live "Free model weather" section appears only once there are counts.

## 0.6.0

- **Schemas.** `json({ schema })` accepts anything with a `safeParse` method, such as a Zod schema, as well as a hand-written `validate` function. A model whose answer the schema rejects is skipped for the next, as before, and `data` is what the schema returns, so its defaults and transforms apply. Lodestone does not depend on any schema library; the `SafeParser` type is exported.

- **Groq's model list no longer includes non-chat models.** A live check on 28 Oct 2026 showed Groq lists speech (whisper), text-to-speech (orpheus) and safety-classifier (prompt-guard, safeguard) models beside its chat models, and `groq()` counted all 11 as chat. `normalizeGroq` leaves them out, so discovery cannot pick one. The same check showed `llama-3.3-70b-versatile` is no longer offered by Groq (a 404, reported as `withdrawn`).

## 0.5.1

No change to the library's behaviour.

- **Published with npm trusted publishing.** The release workflow no longer holds an npm token: npm trusts this repository and `release.yml` directly, so there is no secret to leak or to expire.
- The Lodestone site, at https://lodestone.extrafemi.com, built from the real code (failure sentences from `explain()`, trust verdicts from `vet()`, the code map from `src/`) and checked in CI.

## 0.5.0

Redundancy across providers, and model lists that keep themselves alive and safe.

- **Other providers.** `openaiCompatible()` and presets for [Requesty](https://www.requesty.ai) (`requesty()`, with an EU region), [LLM API](https://llmapi.ai) (`llmapi()`), Groq, Cerebras, OpenAI, Mistral, Together and Ollama. Each preset reads that service's model list, so a model it no longer offers is dropped. Use them as `fallbacks` so one provider's outage does not stop the tool.
- **Discovery that stays short.** A provider's list can be topped up from its own catalogue (`discover: { fill }`) with trusted models within a price limit, and never above `max`. For OpenRouter, a longer pool is kept and the live models are chosen from it, so a model that is down is replaced by the next best while a request still tries at most three.
- **Trust policy** (`trust`). Discovered models must come from a trusted lab (a default list, yours to change); a block list; refuse models a provider says are trained on, or that keep prompts too long (Requesty publishes both); drop models retiring within a week (OpenRouter publishes the date). **Breaking:** a free model from a lab that is not on the default list is no longer added by itself. Name it in your own list, or set `trust: { publishers: 'any' }`.
- **Private calls** (`private: true`). OpenRouter is told to use only providers that do not keep or train on the prompt; other models are used only if their provider's list says so.
- `checkModels()` now checks every provider that can list its models and reports models that are retiring (`expiring`).
- **Cancelling.** `signal` stops a call, and every model after it, when the caller no longer wants the answer.
- `peek(cacheKey)` reads a saved answer without calling a model.
- `free: true` on a fallback: a free tier or local server is not counted against, or stopped by, the spend limit.
- Fixed: an OpenRouter outage could use the whole time budget on free models before another provider got a turn.
- Fixed: a model's catalogue is fetched in the background the first time it is needed, not only by the daily check.

## 0.4.0

- **Circuit breaker** (`createHealth`): a model whose last three attempts failed is skipped by every function until it recovers; one attempt is let through every two minutes to see.
- **Spend control** (`spend`): asked before the platform's money is used, told what each call cost (OpenRouter reports it; otherwise estimated from catalogue price). A caller's own key never goes through it.
- `openrouter.paidFirst`: try the paid models first on the platform's key and use the free ones as backup, for when free models are not worth waiting for.
- `openrouter({ reasoning })`: set how much each model thinks. Measured: turning it off for `claude-haiku-5.5` halved scoring time with the same answers; Gemini refuses to run with it off.
- New failure kind `budget`.

## 0.3.1

- A call on the caller's own key no longer reaches the platform's fallback providers unless a fallback sets `allowWithCallerKey`.
- Attempts that fail with 401, 402 or 403 are not counted against a model in live stats.

## 0.3.0

- **Scorecards**: a `model-scorecard/1` file of measured results (for example from [Naija Eval](https://naija-eval.extrafemi.com)) can put the best-measured model first, per task. `parseScorecard`, `fetchScorecard`, `rankModels`.
- `createStats()` publishes live success rate and speed in the same format. `ai.candidates()` lists the models in use for an evaluator. See `docs/scorecards.md`.

## 0.2.0

- `route`: try exactly these providers, models and keys, in order, for callers that choose their own.
- Errors carry the provider's own message (`detail.providerMessage`). Temperature is sent only when set.

## 0.1.0

- First release: `complete()` and `json()` with time-boxed attempts across OpenRouter's free models, a model list that replaces withdrawn models from the live catalogue, four kinds of rate limit told apart, a paid fallback, plain-language `explain()`, bring-your-own-key, and Anthropic, Google and mock adapters.
