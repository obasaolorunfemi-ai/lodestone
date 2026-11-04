# Lodestone: keeping AI calls working on free models, inside a time limit

*Technical paper, draft 0.1, November 2026. It describes Lodestone 0.8.1. Where a statement is a measurement it says what was measured and how small the sample was; where it is a design choice it says why.*

## Abstract

A tool that calls free AI models is built on something that changes without notice: models are withdrawn, rate-limited, slow, or accept the connection and never answer. Serverless platforms add a hard time limit, so one dead model can turn a working feature into an unreadable gateway error. Lodestone is a small library with no dependencies that sits between a tool and its models. It gives each attempt a slice of a time budget, falls over across models and providers, replaces withdrawn models from the provider's live catalogue, remembers which models are failing, keeps spending inside limits set by the owner and by each caller, and turns every failure into a sentence a person can act on. This paper describes the incident that motivated it, the design and the reasons for it, the security and privacy model, what was measured, and what Lodestone does not do.

## 1. The problem

On 28 October 2026, scoring a job posting in KeyStone started failing. The request ran its whole 24-second budget and then showed the person a gateway error. Nothing in the application had changed. The free models behind it had.

Before changing anything it was measured: three attempts each on five free OpenRouter models, 15 in all.

- **One usable answer in 15**, and it took 25 seconds.
- Two models were rate-limited (a 429) every time.
- Two held the connection open for 45 seconds and never answered.
- Once, the router chose a safety classifier, which replied "User Safety: safe".

The same job on a low-cost paid model, Claude Haiku 5.5 with reasoning switched off, took about three seconds and cost $0.0004.

One day, one posting and one CV: this is an example of the problem, not a benchmark of free models. A measurement error is also worth recording. The first speed table timed each model until the response *headers* arrived; OpenRouter sends headers early and the body seconds later, so every model looked much faster than it was. Anything measured on an API that can stream should be timed to the last byte.

The incident exposed several distinct failures that every tool had been solving separately:

1. a hard-coded model id breaks without warning when the model is withdrawn;
2. one slow model can use the whole time limit;
3. "429" means at least four different things that need four different messages: a daily limit, a per-minute limit, a busy upstream provider, and a spent budget;
4. a model that is down is paid for again, in time, by every request;
5. a public tool that reaches a paid model has an open wallet;
6. the answer is not always the shape the caller needs.

## 2. Design

### 2.1 Time is the scarce resource

Each call has a budget (24 seconds by default, under a typical 30-second gateway limit) and each attempt gets a slice of it. A slow or failing model is skipped for the next, so the call ends inside the limit with either an answer or an error that says what happened. For each call, in order, until one answers: OpenRouter's free models for the tier, then a paid OpenRouter model (only if the caller supplied their own key or the owner allowed it), then each fallback provider on its own key. When a later phase exists, the free models get a short turn (nine seconds in all by default), so time is always left for it.

### 2.2 Lists are preferences, not facts

A tool names the models it prefers per tier (`fast`, `strong`, `vision`). Lodestone checks those names against the provider's live catalogue, saved in a store the tool provides, and swaps a model that has gone for a current one of the same kind. A model with an expiry date within a week is left out. `discover` tops a short list up from the provider's own catalogue within a price limit, from a list of trusted publishers; discovery never lengthens what a request walks, because a request tries at most three of a ranked pool, so adding models adds choice, not delay.

For Anthropic, whose model list says where each model is in its life, a retired id is dropped by default, and with an explicit opt-in is replaced by the newest active model *of the same line* (a Sonnet is never swapped for an Opus). It is never silent: the daily check reports each replacement, and every answer says which model produced it. It is opt-in because a replacement can cost more or answer differently, and Anthropic's list carries no prices, so the spend limit cannot estimate a swapped-in model.

### 2.3 Remember that a model is down

Without memory, every request pays for the same dead models again. A circuit breaker, shared through the same store, skips a model whose last three attempts within ten minutes all failed, and lets one attempt through every two minutes to see whether it has recovered. A timeout, a rate limit, a server error and an unusable answer count as failures. A rejected key or missing credit (401, 402, 403) says nothing about the model and never counts.

### 2.4 Say what happened, in words

Failures are typed (`auth`, `rate_limit`, `slow`, `credit`, `withdrawn`, `unavailable`, `bad_output`, `aborted`, `budget`, `throttled`, `not_configured`, `other`) and `explain(err, { product, settingsHint })` turns any of them into a message for a person. The four kinds of 429 are told apart because the right advice differs: wait a minute, come back tomorrow, try again shortly, or add your own key. A provider with no credit left was for a time reported as the generic "something went wrong"; version 0.8.1 fixed that, which is a reminder that error wording needs the same testing as success paths.

### 2.5 The answer is untrusted input

`json()` skips a model whose answer is not valid JSON or does not pass the caller's validator (a type guard, or any schema with `safeParse`). This limits what a misbehaving model can hand to the rest of the code, but it does not make the content safe: the answer should be treated like user input.

### 2.6 No dependencies, web-standard APIs only

Lodestone uses `fetch`, `AbortSignal`, `URL` and `crypto.subtle`, and nothing else. This is a security decision as much as a portability one: installing it brings in nothing that could be taken over. It runs on Node 20, 22 and 24, on Cloudflare Workers inside `workerd` without the Node compatibility flag, and on Deno and Bun.

## 3. Money

A free public tool that reaches a paid model has one large risk: somebody finds the endpoint and calls it in a loop. Three layers, from the one that stops one person to the one that stops everyone:

1. **Per caller (`rateLimit`).** Each named caller has an allowance; over it, the call is rejected with a message that says when to return, or answered from free models only, so the abuser can never cost anything. Only a SHA-256 hash of the caller is stored.
2. **Everyone together (`createSpendLimit`).** A plain "is the total under the limit?" check lets a burst through: fifty requests read the same total, all pass, all spend. Lodestone takes a *hold* for each paid attempt as it is allowed and counts holds against the limit, so concurrent requests see each other. The hold is replaced by the real cost on an answer and given back on failure. `perCaller` gives each person their own share of the pool, per day and per month.
3. **The ceiling on one call.** `maxTokens` and `budgetMs` bound what one call can produce and how long it can run.

A caller's *own* key is their money: it never touches the owner's fallbacks or pool, and any cap on it is one the person chose, counted in a ledger of its own. The documentation states the limits of all this. With a plain get/set store, counters are exact inside one process and approximate between processes; for a tool that is attacked, use a store with atomic increments. The limit set on the key at the provider is the one that really holds, and Lodestone's count is a best-effort second layer.

## 4. Privacy

A call marked `private` is for prompts that must not be kept or trained on, such as a CV or a medical note. It asks OpenRouter for providers that do not keep or train on the prompt; uses a fallback only if the provider's own list says the model is not trained on or the owner has vouched for it; never reads or writes the cache; and does not count its failures against a model. The honest limit is that Lodestone cannot see what a provider does with a prompt unless the provider says, so it refuses providers that say nothing rather than guessing.

## 5. Letting measurements decide

A scorecard, a small JSON file of measured results, can put the models that did best on a task first, and Lodestone can publish its own live success rates and speeds in the same format. Naija Eval, which scores translation and speech quality for Hausa, Igbo and Yoruba, is the first evaluator to use it. The format is built so that a wrong number cannot do much harm: a scorecard changes only the order models are tried in, for tasks the owner names. It never adds, drops or calls a model the owner did not list, and one fetched from a URL must be https, under a size limit, and from a named host, including after a redirect. Each score carries its metric, the number of items it rests on and the day it was measured. Naija Eval's own scores rest on 100 items per language and direction and it calls itself a first pass, not a leaderboard.

## 6. Security

- **Supply chain.** No runtime dependencies. Releases are built by a pinned GitHub Actions workflow and published to npm with provenance through trusted publishing, from a protected environment that waits for a named human; there is no npm token to leak. CodeQL scans the TypeScript and Python on every push.
- **Keys.** Keys are passed in by the caller's code and sent only to the provider named. They are never stored or logged, and prompts and answers are never logged; the `onAttempt` hook reports provider, model, outcome and timing only.
- **Shared stores.** Anything read back from a store (catalogue, breaker state, spend ledger, rate-limit counters) is checked for shape and size before use, so a store someone else can write to cannot hide every model or grow without limit.
- **Errors.** The provider's raw response body is not an enumerable property of the error, so logging or serialising the error leaves it out.
- **Caching.** A cached answer is tied to a fingerprint of the system prompt, messages and tier as well as the caller's key, so a key that is too coarse gives a miss, never another input's answer. Private calls are never cached. (Both were fixed in 0.7.0 after a review of 0.6.0 found them.)
- **What it does not check.** There is no vulnerability database for hosted models, so none is claimed. Publisher, data-handling and expiry checks rest on what providers report about themselves.

## 7. What was measured

- **The incident** in section 1: 15 attempts, one day, one posting and one CV. After the changes described, reading a posting took 2.6 to 3.1 seconds and scoring a CV against it 4.5 to 4.9, instead of failing after 24. That is an example of the effect, not a benchmark.
- **Live checks found what fakes could not.** The first real calls to the fallback providers found that a model listed for Groq, `llama-3.3-70b-versatile`, had been withdrawn and returned a 404, and that Groq's model list mixes speech, text-to-speech and safety-classifier models with its chat models. Both are the kind of fact only a live call reveals.
- **Tests.** 263 automated tests, and the same smoke checks (failover, cutting off a model that hangs, `json()`, `explain()`, the breaker, the spend limit under a burst, per-caller limits, private calls not cached) run on Node 20, 22 and 24, on `workerd`, on Deno and on Bun in CI. These show that the code runs on those runtimes, not that each provider behaves the same from each platform's network.

## 8. What it does not do

- **No streaming, no tool calling, no embeddings or speech.** Lodestone is for one-shot text and JSON calls. Streaming needs a rule for a model that fails halfway; the likely rule is to fail over only before the first token.
- **It cannot tell a person from a script.** `caller` is whatever the tool passes, and an IP address is a weak identity. A public tool under attack needs a bot check in front of it.
- **Counters are approximate between processes** on a plain get/set store, as above.
- **`private` cannot make a provider keep a promise it does not publish.**
- **Some providers are presets only.** The README records that a key was accepted and a model list read for OmniaKey but that its first chat call was refused for insufficient quota, so it is not yet called live; and that the Anthropic model-list reader was tested on fake responses following Anthropic's reference.
- **The Python port is alpha**: it does not yet read provider model lists or support images.

## 9. Open questions

- **How reliable are free models, over time?** The incident is one day. A public probe harness exists (the Free Model Index) but runs no schedule yet, so there is no long series.
- **Failover during a stream.** What the caller should see when a model fails after the first token.
- **Better identity for callers**, so per-caller limits mean more than per-address limits.
- **Cost knowledge for replacements.** Replacing a retired model safely needs prices that some providers do not publish.

## Appendices

[README](../README.md), [protecting your budget](protecting-your-budget.md), [stores](stores.md), [runtimes](runtimes.md), [scorecards](scorecards.md), [SECURITY](../SECURITY.md) and the [changelog](../CHANGELOG.md).
