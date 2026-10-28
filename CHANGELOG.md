# Changelog

Versions before 1.0 may change between minor releases; each change that could break a caller is marked **breaking**.

## 0.6.0 (not yet published)

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
