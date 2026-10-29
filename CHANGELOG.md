# Changelog

Versions before 1.0 may change between minor releases; each change that could break a caller is marked **breaking**.

## Unreleased

- **`omniakey()` preset** (TypeScript and Python) for [OmniaKey](https://omniakey.com), a prepaid gateway with an OpenAI-compatible text endpoint. Use it as a `fallbacks` entry. It is a preset only: a key was accepted and its model list read (98 entries, with image, video and music models mixed in and nothing to tell them apart, so name your models and do not use `discover` with it), but the first chat call was refused with `insufficient_user_quota`, so it has not been seen to answer, and the Providers page says so. Text and JSON calls only; OmniaKey's image, video and music models are outside what Lodestone does.

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
