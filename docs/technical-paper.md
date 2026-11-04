# Lodestone: Keeping AI Calls Working on Unreliable Free Models Inside a Serverless Time Limit

**Authors:** Obasa Olorunfemi, MBA; Precious Olusegun, PhD

*Technical report, version 1.0 (draft for author review), November 2026. It describes Lodestone 0.8.1. Affiliations and author contributions are to be completed by the authors.*

## Abstract

**Background.** Small applications increasingly call hosted language models, often on free tiers whose models are withdrawn, rate-limited, slow or silent without notice. Serverless platforms add a hard wall-clock limit, so a single unresponsive model can turn a working feature into an unreadable gateway error. **Problem.** General work on serving and routing language models optimises cost and quality; the practical problem for an application developer is different and narrower: finish inside a fixed time budget with either an answer or an honest, human-readable explanation, without exceeding a spending limit, without leaking private text, and without trusting what comes back. **Approach.** We present Lodestone, a dependency-free library that sits between an application and its models. It allots each attempt a slice of a time budget and fails over across models and providers; treats the application's model lists as preferences to be reconciled with each provider's live catalogue; remembers failing models with a circuit breaker; separates the several causes of an HTTP 429 and explains every failure in plain words; validates structured answers and skips a model whose answer fails validation; controls spending with *holds* so that concurrent requests cannot overspend; gives each caller an allowance; restricts private prompts to providers that say they do not keep or train on them; and optionally reorders models by published evaluation scorecards. **Results.** In an incident that motivated the work, one usable answer was obtained from 15 attempts on five free models, in 25 seconds; after the changes, reading a posting took 2.6 to 3.1 seconds and scoring 4.5 to 4.9 seconds, instead of failing after 24. These are measurements from one day, one posting and one CV and are reported as an illustration, not a benchmark. The library's 263 tests and its cross-runtime smoke checks run on Node 20, 22 and 24, Cloudflare Workers, Deno and Bun. **Conclusion.** Reliability for free-tier model calls is largely a matter of treating time, money, privacy and the model's output as separately budgeted and separately untrusted resources. We state the design's limits, including that spending counters are approximate across processes on a simple store and that privacy controls rest on what providers report about themselves.

**Keywords:** large language models, reliability engineering, failover, circuit breaker, serverless, rate limiting, cost control, privacy

## 1 Introduction

On 28 October 2026, scoring a job posting in an existing application began failing. The request ran its whole 24-second budget and then showed the person a gateway error. Nothing in the application had changed; the free models behind it had.

Before changing anything, the problem was measured: three attempts each on five free models served through OpenRouter, 15 in all. One attempt returned a usable answer, and it took 25 seconds. Two models were rate-limited (HTTP 429) every time. Two held the connection open for 45 seconds and never answered. On one attempt the router selected a safety classifier, which replied "User Safety: safe". The same job on a low-cost paid model (Claude Haiku 5.5, with reasoning switched off) took about three seconds and cost $0.0004.

Free tiers are attractive for small tools, and they are also constrained by design: at the time of writing, OpenRouter limits models whose identifiers end in `:free` to 20 requests per minute and, for an account that has purchased fewer than 10 credits, to 50 requests per day, with a higher daily ceiling after a purchase (OpenRouter, n.d.). Models on such tiers are withdrawn and added frequently. The incident exposed several distinct failures that each tool had been solving, or failing to solve, separately:

1. a hard-coded model identifier breaks without warning when the model is withdrawn;
2. one slow model can consume the whole time limit, a tail-latency problem (Dean & Barroso, 2013) in its simplest form;
3. a 429 response can mean a daily limit, a per-minute limit or a busy upstream provider, each needing different advice;
4. a model that is down is paid for again, in time, by every request;
5. a public tool that can reach a paid model has an open wallet;
6. the answer is not always the shape the caller needs, and is not trustworthy as input;
7. some prompts, such as a CV or a medical note, must not be kept or trained on.

### 1.1 Contributions

1. An analysis of calling free-tier models as a problem of four budgets (time, money, privacy, trust) and a design that treats each separately (Sections 3 and 4).
2. A time-budgeting scheme that allots attempts slices of a fixed budget across phases, so that an outage in one provider cannot starve the next (Section 4.1).
3. Reconciliation of preference lists with live catalogues, including an opt-in, never-silent replacement of retired models within the same model line (Section 4.2).
4. *Hold-based* spend control that removes the check-then-spend race between concurrent requests, with per-caller shares and caller-chosen caps (Section 4.6).
5. A privacy rule for private prompts that refuses providers that publish nothing, rather than assuming (Section 4.8).
6. An account of security and privacy properties and their stated limits (Section 5), and a transparent evaluation that says how small it is (Section 6).

## 2 Background and related work

**Routing and cascades.** Chen et al. (2023) propose FrugalGPT, which cascades through models of increasing cost, stopping at the first answer judged good enough, to reduce cost at comparable quality; Ong et al. (2024) learn a router from preference data to choose between a strong and a weak model. These works optimise a cost–quality trade-off using learned judgements of query difficulty. Lodestone's problem is a different one: to *finish*, within a hard time limit, against providers that are intermittently unavailable, with deterministic, inspectable rules. The two are complementary; a learned router could supply the order in which Lodestone's phases try models, and Section 4.9 shows a simpler way of letting measurements reorder them.

**Model change over time.** Chen et al. (2024) measured substantial changes in the behaviour of the same named models over a few months. Providers also withdraw models outright. Both argue against binding an application to a model identifier, and for checking what is actually offered at call time (Section 4.2).

**Reliability patterns.** The design draws on established patterns: circuit breakers (Nygard, 2018; Fowler, 2014), timeouts, bounded retries with backoff and jitter (Brooker, n.d.), honouring server-supplied waits (RFC 9110, §10.2.3; RFC 6585), serving a stale answer when the origin fails (the intent of RFC 5861), tail-tolerant design (Dean & Barroso, 2013) and the general discipline of designing for failure (Beyer et al., 2016). What is specific here is the combination of these patterns with a shared *wall-clock budget* across heterogeneous providers and with the money and privacy constraints of model calls.

**Security of LLM-integrated applications.** Greshake et al. (2023) analyse how text retrieved by or fed to a model can carry instructions that compromise the application, and the OWASP project catalogues risks including improper handling of model output (OWASP GenAI Security Project, n.d.). Lodestone's response is modest and explicit: a model's answer is untrusted input, and structured calls are validated before use (Section 4.5); it does not, and cannot, make a model's content safe.

**Evaluation and scorecards.** Public evaluations of model quality for particular languages use standard test sets and metrics: FLEURS for speech (Conneau et al., 2023), FLORES-based translation evaluation (NLLB Team et al., 2024), and the chrF++ metric (Popović, 2017). Lodestone defines a small file format in which such results can reorder the models it tries (Section 4.9).

**Supply chain.** Studies of the npm ecosystem show how far one compromised or malicious package can reach (Zimmermann et al., 2019; Ohm et al., 2020). Lodestone has no runtime dependencies and is published with signed provenance; signed build provenance is discussed by Newman et al. (2022).

## 3 Problem analysis and requirements

The setting is a small tool, usually serverless, that calls models on behalf of its users. We state seven requirements, each answering one of the failures of Section 1.

| Requirement | Answers |
|---|---|
| R1. Finish inside a stated time budget, with an answer or an explanation. | slow and silent models |
| R2. Keep working when a named model is withdrawn. | stale identifiers |
| R3. Do not pay again, in time, for a model that is known to be down. | repeated failure |
| R4. Tell the user what went wrong, in a form that supports a decision. | ambiguous 429s |
| R5. Never spend more than the owner allows, even under concurrency; give each caller a share. | open wallet |
| R6. Treat the model's answer as untrusted and validate structured answers. | unusable output |
| R7. Send a private prompt only where the provider says it is not kept or trained on. | privacy |

*Table 1. Requirements and the failures they answer.*

Two non-requirements shape the design. Lodestone does not aim to choose the best model, only a *working* one; and it makes no claim about the quality or safety of an answer's content.

## 4 Design

### 4.1 Time is the scarce resource

Every call has a budget, 24 seconds by default (`budgetMs`), chosen to sit under a typical 30-second gateway limit; this is an assumption about the deployment, and is configurable. Each attempt receives a slice of the remaining budget, and a slow or failing attempt is abandoned for the next. Attempts proceed in phases: first OpenRouter's free models for the requested tier, as given by the live catalogue; then a paid OpenRouter model, only if the caller supplied their own key or the owner allowed paid use; then each fallback provider on its own key. When a later phase exists, the free phase receives a short turn (nine seconds in all by default), so that time always remains for it. An early version allowed an OpenRouter outage to consume the entire budget on free models before another provider was tried; that defect was found in use and corrected in 0.5.0, and the rule above is its fix.

*Budget invariant.* Because every attempt carries a slice and the loop checks the remaining budget before each attempt, a call returns, with an answer or a typed error, no later than its budget plus the time to return. A caller may also abort a call, and every later attempt, with an `AbortSignal`, so that a person who left the page does not leave paid calls running.

### 4.2 Preference lists are preferences

An application names the models it prefers for each tier (`fast`, `strong`, `vision`). Lodestone reconciles them with each provider's live catalogue, saved in a store the application supplies, refreshed daily by `checkModels()` or in the background when found stale. A model the provider no longer lists is dropped; a model with an expiry date within a week is left out; and where the provider's list allows, `discover` tops a short list up with models within a price limit from a list of trusted publishers (a free model is a price limit of zero). Discovery does not lengthen what a request walks: a ranked pool of up to eight models per tier is kept, models that are down are filtered out, and a request tries at most three, so adding models adds choice, not delay.

For Anthropic, whose model list reports each model's life-cycle state, retirement date and model line, a retired identifier is dropped by default and, only with an explicit opt-in, replaced by the newest *active* model of the same line (a Sonnet is never replaced by an Opus), never by a deprecated one, never by one the owner's trust policy rejects, and for image calls only by one that reads images. The replacement is never silent: the daily check reports each one, and every answer states which model produced it. The feature is opt-in because a replacement can cost more or answer differently, and Anthropic's list carries no prices, so the spend limit cannot estimate a swapped-in model.

### 4.3 Remembering failure: the circuit breaker

Without memory, every request pays for the same dead models again. A circuit breaker, shared through the same store so that every serverless function sees it, skips a model whose last three attempts within ten minutes all failed, and lets a single attempt through every two minutes to see whether it has recovered; one success closes it. A timeout, a rate limit, a server error and an unusable answer count as failures. A rejected key or missing credit (HTTP 401, 402, 403) says nothing about the model and never counts, because it would otherwise ban a healthy model for a configuration fault.

### 4.4 Saying what happened

Failures are typed (`auth`, `rate_limit`, `slow`, `credit`, `withdrawn`, `unavailable`, `bad_output`, `aborted`, `budget`, `throttled`, `not_configured`, `other`), and `explain(err, { product, settingsHint })` turns any of them into a message for a person. A 429 is read as daily, per-minute, upstream or unrecognised, because the right advice differs: come back tomorrow, wait a minute, or try again shortly. A provider that has no credit left was for a time reported only as the generic "something went wrong", because the kind existed but was never produced; version 0.8.1 corrected that. We note it because error wording needs the same testing as success paths.

### 4.5 The answer is untrusted input

`json()` skips a model whose answer is not valid JSON or fails the caller's validator, a type guard or any object with a `safeParse` method such as a Zod schema. The data returned is what the schema returns, so its defaults and transformations apply. This limits what a misbehaving model can hand to the rest of the code. It does not make the content safe, and the documentation says so.

### 4.6 Money: holds, shares and caps

A free public tool that can reach a paid model has one large risk: somebody finds the endpoint and calls it in a loop. Lodestone offers three layers.

*Per-caller allowance.* Each named caller has an allowance of calls in a window. Over it, the call is rejected with a message saying when to return, or answered from free models only, so the abuser can never cost anything. Only a SHA-256 hash of the caller is stored, so that an IP address is not kept.

*A shared limit with holds.* A plain check, "is the total under the limit?", admits a burst: fifty concurrent requests read the same total, all pass, and all spend. This is a classic time-of-check-to-time-of-use race. Lodestone instead takes a *hold* for each paid attempt at the moment it is allowed and counts holds against the limit, so concurrent requests see each other; the hold is replaced by the real cost when the attempt answers (the provider's own figure when given, otherwise an estimate from catalogue price) and given back when it fails. *Argument:* within one process, admission is a single synchronous reserve-then-settle step, so the sum of settled cost and outstanding holds never exceeds the limit at the moment of any admission. Between processes, on a plain get/set store, two functions can each take a hold the other did not see, so the guarantee is approximate; the documentation recommends headroom and an atomic store (such as one with atomic increment) where it matters. If the ledger cannot be read, a paid attempt is refused.

*A share for each person.* `perCaller` gives each caller a share of the pool per day and per month, so one heavy user cannot exhaust it, and the explanation of a refusal distinguishes "you have used your share" from "the app has used its pool". A person may lower their own share, never raise it.

*A person's own key.* When someone brings their own key the money is theirs: it never touches the owner's fallbacks or pool, and any cap on it is one the person chose, counted in a ledger of its own. The limit set on the key at the provider is the one that really holds, and Lodestone's count is a best-effort second layer; the documentation says so.

### 4.7 The ceiling on one call

`maxTokens` (3,500 by default) bounds what a call can produce and `budgetMs` bounds how long it can run; both can be set per task.

### 4.8 Private prompts

A call marked `private` is for prompts that must not be kept or trained on. It asks OpenRouter to use only providers that do not retain or train on the prompt; uses a fallback provider only if that provider's own model list says the model is not trained on, or the owner has vouched for it; never reads or writes the cache; and does not count its failures against a model, since few providers can meet the rule and that says nothing about the model. The central design decision is the treatment of silence: *a provider that publishes nothing about retention, and that the owner has not vouched for, is skipped*, not assumed safe. The honest limit is that Lodestone cannot see what a provider does with a prompt unless the provider says.

### 4.9 Letting measurements decide

A scorecard, a small JSON file of measured results in which each score carries its metric, its direction, the number of items it rests on and the date measured, can put the models that did best on a task first. Lodestone can also publish its own live success rates and speeds in the same format. A public evaluation of translation and speech quality for Hausa, Igbo and Yoruba (Naija Eval) is the first producer. The format is built so that a wrong number cannot do much harm: a scorecard changes only the *order* models are tried in, for tasks the owner names, and never adds, drops or calls a model the owner did not list; one fetched from a URL must use https, be under a size limit and, if the owner names allowed hosts, come from one of them even after a redirect. Naija Eval's own scores rest on 100 items per language and direction, and it describes itself as a first pass rather than a leaderboard; the format carries that number so that nothing downstream mistakes it for more.

### 4.10 Portability

Lodestone uses only web-standard APIs (`fetch`, `AbortSignal`, `URL`, `crypto.subtle`, `TextEncoder`), has no runtime dependencies, and ships store adapters for several platforms' key-value stores. A Python port of the core exists and is marked alpha.

## 5 Security and privacy analysis

### 5.1 Threat model

| Adversary or fault | Asset at risk | Principal mitigation |
|---|---|---|
| anonymous caller of a public endpoint | owner's money | per-caller allowance; shared limit with holds; free-only fallback |
| a caller's own key being misused by a loop or bug | the person's money | optional caller-chosen cap; limit on the key at the provider |
| a misbehaving or hostile model | the application, through its output | validation of structured answers; answer treated as untrusted input |
| a provider that keeps or trains on prompts | private text | `private` mode; refusal of providers that publish nothing |
| a writer to the shared store | availability and cost | shape and size checks on everything read back |
| compromise of the package or its release | every downstream user | no dependencies; pinned build; provenance; protected release environment |
| leakage through logs | prompts, keys | no logging of prompts or answers; keys never stored; error bodies not enumerable |

*Table 2. Threat model.*

### 5.2 Properties and their limits

*Shared stores.* Anything read back from a store (catalogue, breaker state, spend ledger, counters) is checked for shape and size before use, so a store that someone else can write to cannot hide every model, grow without limit, or silently disable a limit.

*Caching.* A cached answer is tied to a fingerprint of the system prompt, messages and tier in addition to the caller's key, so that a key which is too coarse yields a miss, never another input's answer; and private calls are never cached. Both properties were added in 0.7.0 after a review of 0.6.0 found that a private call with a cache key had saved its answer for a day in a shared store.

*Errors and logs.* The provider's raw response body is not an enumerable property of the error, so logging or serialising an error does not print a provider's echo of the prompt. Prompts and answers are never logged; the observation hook reports provider, model, outcome and timing only.

*Scorecards.* Fetched scorecards are bounded and host-restricted as in Section 4.9, and one with more than 20,000 entries is refused.

*Supply chain.* No runtime dependencies; third-party actions pinned to commits; static analysis (CodeQL) on the TypeScript and Python code on every push and weekly; releases through trusted publishing from a protected environment that requires a human reviewer, so no long-lived publishing token exists; signed provenance.

*What is not claimed.* There is no vulnerability database for hosted models, so none is claimed; the publisher, data-handling and expiry checks rest on what providers report about themselves. Lodestone cannot tell a person from a script: `caller` is whatever the application passes, and an IP address is a weak identity. A public tool under attack needs a bot check in front of it; the layers above limit the damage when one gets through. A model's answer is untrusted input and must be treated as such by the application.

## 6 Evaluation

### 6.1 The incident, measured

The measurement in Section 1 is the evidence for the problem: of 15 attempts on five free models over one day, one produced a usable answer, in 25 seconds; two models answered 429 every time, two held the connection for 45 seconds without answering, and the router once selected a safety classifier. A paid low-cost model answered the same job in about three seconds for $0.0004. *We made an error worth recording.* The first speed table timed each model until the response *headers* arrived. OpenRouter sends headers early and the body seconds later, so every model appeared much faster than it was. Anything measured on an API that can stream should be timed to the last byte, and all figures here are.

### 6.2 After the changes

With the library in place, reading a posting took 2.6 to 3.1 seconds and scoring a CV against it 4.5 to 4.9 seconds, instead of failing after 24 seconds. In an earlier release the effect of turning model reasoning off for one paid model was measured: it halved scoring time with the same answers, while one provider's model refused to run with reasoning off, which is why the setting is exposed rather than fixed.

### 6.3 Live checks found what fakes could not

Most of the library's tests use fake providers. The first real calls to the fallback providers, on 28 October 2026, found that a model listed for one provider had been withdrawn and returned 404, and that its model list mixes speech, text-to-speech and safety-classifier models with chat models, so that a naive reader counted all 11 entries as chat models. The list reader now excludes the non-chat models. Both facts could only be learned from a live call. Two providers are present as presets only: one account's first chat call was refused for insufficient quota, and the Anthropic model-list reader was tested on fake responses following Anthropic's reference, with no live call recorded at the time the documentation was written.

### 6.4 Tests and runtimes

The library has 263 automated tests. The same smoke checks (failover, cutting off a model that hangs, `json()`, `explain()`, the breaker, the spend limit under a burst, per-caller limits, private calls not being cached, and the store and scorecard code paths) run in continuous integration on Node 20, 22 and 24, on Cloudflare Workers inside `workerd` without the Node compatibility flag, and on Deno and Bun. This shows that the code runs on those runtimes; it does not show that each provider's API behaves the same from each platform's network, which only a deployment can show.

### 6.5 Threats to validity

*Sample size and representativeness.* The incident is one day, one posting and one CV, on one set of free models; it is an example of the problem, not a measurement of free-model reliability in general. *Selection.* We investigated because something failed, so the incident is a worst-ish case. *Measurement.* The header-timing error above shows how easily latency is mismeasured; we corrected it for the figures reported, but the earlier release notes record the discovery rather than rewriting history. *Authorship.* The authors built the library and chose what to measure. *Reproducibility.* Provider behaviour changes daily; the incident cannot be re-run, only repeated against whatever the providers do on the day, and the scripts that do so are published.

## 7 Limitations

- **Scope.** Lodestone serves one-shot text and JSON calls. There is no streaming (which needs a rule for a model that fails halfway; the likely rule is to fail over only before the first token), no tool calling and no embeddings or speech.
- **Identity.** Per-caller limits are only as strong as the identity the application supplies.
- **Approximate counters.** On a plain get/set store, counters are exact inside one process and approximate between processes.
- **Self-reported privacy.** `private` cannot make a provider honour a promise it does not publish; it can only refuse providers that say nothing.
- **Provider coverage.** Some providers are presets whose first live call was not completed, and the Python port is alpha: it does not yet read provider model lists or support images.
- **Model quality.** Lodestone chooses a working model, not the best one; a scorecard can improve the order, not the answer.

## 8 Responsible use

Free tiers are shared resources, and a library that retries across several of them should not become a way of extracting more than a fair share. Lodestone's defaults are conservative: a bounded number of attempts, a circuit breaker that stops asking a failing model, a per-caller allowance, and an explicit refusal rather than silent degradation when a limit is reached. The per-caller design also aims at fairness between the users of a public tool, so that one cannot exhaust a pool others share. Privacy controls are honest about their basis, and the documentation tells owners what a provider's silence means. Where Lodestone speaks to a person, `explain()` is written to help them decide what to do, not to reassure them.

## 9 Open questions

- **How reliable are free models over time?** The incident is one day. A public probe harness exists but has no schedule yet, so there is no long series from which to say how often models fail, in what ways, and how fast the population turns over.
- **Failover during a stream.** What the caller should see when a model fails after the first token, and whether any rule is better than "only before it".
- **Better identity for callers**, so that per-caller limits mean more than per-address limits.
- **Safe replacement of retired models** needs prices and capabilities that some providers do not publish.
- **Learned routing.** Whether routers of the kind proposed by Ong et al. (2024) can supply Lodestone's phase order without compromising the determinism that makes its failures explainable.

## 10 Conclusion

Calling free-tier models from a small serverless tool is unreliable in specific, repeatable ways. We have argued that the remedy is to budget four things separately, time, money, privacy and trust, and described a small library that does so with deterministic rules and plain-language errors: attempts are sliced from a fixed time budget; lists are reconciled with live catalogues; failure is remembered; spending is reserved before it is spent; private prompts go only where a provider says they are safe; and the answer is treated as untrusted input. The evidence for the effect is a single incident, and we have tried to say plainly how little that establishes. A longer series of measurements, and independent scrutiny of the privacy and spend controls, are the next steps.

## Declarations

**Competing interests.** The software described is developed and maintained by the first author and is released under the MIT licence. **Funding.** None is stated for this draft; the authors should complete this section. **Data and code availability.** The source code, tests, documentation and change history are at https://github.com/obasaolorunfemi-ai/lodestone; the version described is 0.8.1. **Use of AI tools.** Parts of the software and of this draft were produced with the assistance of an AI model; every reference was verified against Crossref, arXiv, the RFC Editor or the publisher, as noted below. **Author contributions and affiliations.** To be completed by the authors.

## References

**Note on the references.** Each reference with a DOI was retrieved from Crossref and checked against the cited title, authors, year and venue; arXiv preprints were checked against arXiv; RFCs were checked against the RFC Editor; web pages were checked to resolve or, where a site blocks automated requests, to be the publisher's page, at the time of writing.

- Beyer, B., Jones, C., Petoff, J., & Murphy, N. R. (Eds.). (2016). *Site reliability engineering: How Google runs production systems*. O'Reilly Media.
- Brooker, M. (n.d.). Timeouts, retries, and backoff with jitter. *Amazon Builders' Library*. https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/
- Chen, L., Zaharia, M., & Zou, J. (2023). FrugalGPT: How to use large language models while reducing cost and improving performance. *arXiv preprint* arXiv:2305.05176. https://arxiv.org/abs/2305.05176
- Chen, L., Zaharia, M., & Zou, J. (2024). How is ChatGPT's behavior changing over time? *Harvard Data Science Review*, *6*(2). https://doi.org/10.1162/99608f92.5317da47
- Conneau, A., Ma, M., Khanuja, S., Zhang, Y., Axelrod, V., Dalmia, S., Riesa, J., Rivera, C., & Bapna, A. (2023). FLEURS: Few-shot learning evaluation of universal representations of speech. In *2022 IEEE Spoken Language Technology Workshop (SLT)* (pp. 798–805). IEEE. https://doi.org/10.1109/SLT54892.2023.10023141
- Dean, J., & Barroso, L. A. (2013). The tail at scale. *Communications of the ACM*, *56*(2), 74–80. https://doi.org/10.1145/2408776.2408794
- Fowler, M. (2014). CircuitBreaker. *martinfowler.com*. https://martinfowler.com/bliki/CircuitBreaker.html
- Greshake, K., Abdelnabi, S., Mishra, S., Endres, C., Holz, T., & Fritz, M. (2023). Not what you've signed up for: Compromising real-world LLM-integrated applications with indirect prompt injection. In *Proceedings of the 16th ACM Workshop on Artificial Intelligence and Security* (pp. 79–90). ACM. https://doi.org/10.1145/3605764.3623985
- Newman, Z., Meyers, J. S., & Torres-Arias, S. (2022). Sigstore: Software signing for everybody. In *Proceedings of the 2022 ACM SIGSAC Conference on Computer and Communications Security* (pp. 2353–2367). ACM. https://doi.org/10.1145/3548606.3560596
- NLLB Team, Costa-jussà, M. R., Cross, J., Çelebi, O., Elbayad, M., Heafield, K., Heffernan, K., Kalbassi, E., Lam, J., Licht, D., Maillard, J., Sun, A., Wang, S., Wenzek, G., Youngblood, A., Akula, B., Barrault, L., Gonzalez, G. M., Hansanti, P., …, & Wang, J. (2024). Scaling neural machine translation to 200 languages. *Nature*, *630*, 841–846. https://doi.org/10.1038/s41586-024-07335-x
- Nygard, M. T. (2018). *Release it! Design and deploy production-ready software* (2nd ed.). Pragmatic Bookshelf.
- Ohm, M., Plate, H., Sykosch, A., & Meier, M. (2020). Backstabber's knife collection: A review of open source software supply chain attacks. In *Detection of Intrusions and Malware, and Vulnerability Assessment (DIMVA 2020)* (pp. 23–43). Springer. https://doi.org/10.1007/978-3-030-52683-2_2
- Ong, I., Almahairi, A., Wu, V., Chiang, W.-L., Wu, T., Gonzalez, J. E., Kadous, M. W., & Stoica, I. (2024). RouteLLM: Learning to route LLMs with preference data. *arXiv preprint* arXiv:2406.18665. https://arxiv.org/abs/2406.18665
- OpenRouter. (n.d.). *API rate limits*. https://openrouter.ai/docs/api-reference/limits
- OWASP GenAI Security Project. (n.d.). *OWASP top 10 for LLM applications*. https://genai.owasp.org/llm-top-10/
- Popović, M. (2017). chrF++: Words helping character n-grams. In *Proceedings of the Second Conference on Machine Translation* (pp. 612–618). ACL. https://doi.org/10.18653/v1/W17-4770
- Zimmermann, M., Staicu, C.-A., Tenny, C., & Pradel, M. (2019). Small world with high risks: A study of security threats in the npm ecosystem. In *28th USENIX Security Symposium* (pp. 995–1010). USENIX Association. https://www.usenix.org/conference/usenixsecurity19/presentation/zimmerman

### Internet standards

- Fielding, R. (Ed.), Nottingham, M. (Ed.), & Reschke, J. (Ed.). (2022). *HTTP semantics* (RFC 9110). IETF. https://www.rfc-editor.org/rfc/rfc9110
- Nottingham, M. (2010). *HTTP cache-control extensions for stale content* (RFC 5861). IETF. https://www.rfc-editor.org/rfc/rfc5861
- Nottingham, M., & Fielding, R. (2012). *Additional HTTP status codes* (RFC 6585). IETF. https://www.rfc-editor.org/rfc/rfc6585
