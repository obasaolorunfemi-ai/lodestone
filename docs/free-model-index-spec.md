# Free Model Index: spec (draft 1, 2 Nov 2026)

> **Status:** milestone 1 (harness, validity rule, outcome classification, daily rollup) is built and public at https://github.com/obasaolorunfemi-ai/free-model-index. The scheduler, `scorecard.json`, the page and the Naija Eval join are not.

A public, open, scheduled measurement of how reliably OpenRouter's free models answer a real request, published as an open dataset, a methodology page and a weekly update. It is the Lodestone version of what makes SemiAnalysis's InferenceX worth citing: every number comes from a public run anyone can inspect, and it is updated continuously.

## What it is, and is not

- **Is:** for each free model, how often a probe got a usable answer inside a serverless time budget, how fast, and how it failed when it did not. One uniform probe, so the rates are comparable between models.
- **Is not:** a quality ranking. A fast, reliable model can still be a poor translator. Quality lives in Naija Eval (below) and, for other tasks, nowhere yet.
- **Is not:** a measurement of paid models, or of every region. The probes run from GitHub's runners, not from Lagos.
- **Differs from the "weather" feed:** weather counts what one app's traffic happened to try, so a model is tried only because earlier ones failed, and its rate says little. The index sends the same request to every model on a schedule, so a rate here means something.

## Name, versions, cadence

- **Name:** Free Model Index. Avoid the "MAX" and "X" suffixes SemiAnalysis uses on its own named products.
- **Methodology versions:** `v1.0` now. Any change to the probe, the validity rule or the timeout bumps the version; every datapoint carries the version it was taken under, and rates are never compared across versions without saying so.
- **Weekly updates:** numbered, published Mondays (Update 1, 2, ...). Each is the JSON for the week, a short written summary, and the list of models added or withdrawn.
- **Announce versions, not the daily data.** `v1` is the first public week with at least 14 days of history.

## Where it lives, and licences

- **Repo:** a new public repo, `free-model-index`, under the same account. Separate from the library so the index can be cited and forked on its own, and so the library's releases do not depend on it.
- **Code (probe harness, aggregation, site page):** Apache-2.0, like InferenceX's benchmark repo.
- **Data:** CC BY 4.0, so a citation is the price of reuse. Attribution is the point.
- **README rule, borrowed from InferenceX:** only this repo contains the official index. Forks and reruns are unofficial and must say so.
- **Branch layout:** `main` holds code and the methodology; an append-only `data` branch holds the probe records, so the code history is not buried in one commit per run.

## The probe

- **One fixed request**, published in the repo. A short JSON extraction (a one-line job posting to `{title, remote}`), temperature 0, `max_tokens` about 200, no reasoning option set, no system prompt. This is the kind of call Lodestone is for, and a model that "thinks" for thousands of tokens will time out, which is a real result for a serverless tool.
- **Validity rule, in code:** the answer parses as JSON, `title` mentions the role, `remote` is true. Anything else is "answered, unusable".
- **Timing:** measured to the last byte of the body, never to the headers. (28 Oct 2026: headers arrive seconds early and made every model look faster.)
- **Time limits:** a hard timeout at 45 s (the hang length seen on 28 Oct) and a "serverless budget" line at 24 s (Lodestone's default).
- **Explicit model ids only.** The harness refuses any id that does not end in `:free` and whose catalogue price is not zero, so a probe can never spend money. It does not use OpenRouter's router model.

## Outcomes

Every probe ends in exactly one outcome, using the same names as Lodestone's failure kinds where they exist:

| Outcome | Meaning |
|---|---|
| `usable` | valid answer within 24 s |
| `usable_late` | valid answer between 24 s and the 45 s timeout |
| `unusable` | answered, but empty or failed the validity rule |
| `timeout` | no complete body within 45 s |
| `rate_limited_upstream` / `rate_limited_other` | a 429 from the model's own provider, or one we could not tell apart (classified with `readRateLimit()`) |
| `withdrawn` | 404 |
| `unavailable` | 5xx |
| `other` | anything else, with the status |
| `restricted` | 403: the model refuses direct API calls (for example it is offered only through approved apps). Recorded with OpenRouter's message, listed, never rated: it says nothing about reliability |
| `probe_budget` | our own account's daily or per-minute limit. OpenRouter's "daily" and "minute" 429s apply to the whole account, so they say nothing about a model. Recorded, never counted for or against it |

Headline metric per model per window: **usable rate** = `usable` / all counted outcomes. Also published: `usable_late`, `unusable`, `timeout` and rate-limit shares, and p50 and p95 latency of answered probes.

## Budget: the constraint that shapes everything

OpenRouter's documented limits for `:free` models are 20 requests a minute, and 50 a day with under 10 credits purchased or 1,000 a day with 10 or more. Limits are per account, and extra keys do not raise them.

- **Use a dedicated account and key.** Probes must not share a cap with KeyStone, Inkstone, TouchStone or Naija Eval, or they would eat those tools' allowance and the tools would corrupt the index.
- **Option A, no purchase (50 a day):** on 2 Nov 2026 OpenRouter's catalogue lists 14 free text models, of which 12 are general chat models (a safety classifier and a code-only model are left out, as Lodestone leaves them out). 12 models x 3 probes a day (every 8 hours) is 36 a day, inside the cap with room for new models. Each model reaches n >= 30 in about 10 days, so the published window is trailing 14 days.
- **Option B, one-time 10-credit purchase (1,000 a day):** up to about 40 models, one probe an hour each, about 960 a day. n is about 168 a week per model, so a weekly window works. The credit is not consumed by free calls. This is the recommendation, and it is the owner's decision to spend it.
- **If there are more free models than the budget covers:** probe the most-used first (the models in Lodestone's default lists and the ones KeyStone, Inkstone and TouchStone call), and the rest on a rota, labelled "sampled".
- **Back-off:** honour `Retry-After`. Never retry a failed probe within the same hour; a retry would measure our persistence, not the model.

## Finding new models the day they appear

- An hourly job reads OpenRouter's catalogue (not a completion, so it does not use the free-request cap), keeps the `:free` models, and diffs against the last list.
- A new free model gets its first probe in the same run and is added to the schedule. The weekly update names it ("added Tuesday 14:00 UTC").
- A model that is withdrawn (404) or whose expiry date is within a week is marked, not deleted. Its history stays.

## Schedule and storage

- **Scheduler:** GitHub Actions cron on a public repo (standard runners are free for public repos). GitHub documents that scheduled runs can start late and that it disables schedules in a public repo with no activity for 60 days; recording the real start time of every probe and committing the results keeps it active.
- **Records:** `data/probes/YYYY-MM-DD.jsonl`, one line per probe: `{ts, version, model, outcome, status, ms, answered_chars, account_remaining}`. No model answers are stored beyond a length and the validity result; a weekly audit sample of 20 raw answers is kept for checking.
- **Rollups:** `data/daily/YYYY-MM-DD.json` and `data/weekly/YYYY-WW.json`.
- **Public file:** `scorecard.json` in the repo's published output, in `model-scorecard/1`, so Lodestone can read it unchanged:
  `source: "free-model-index"`, `task: "availability"`, `metric: "usable_rate"` (and `latency_p50_ms`, `latency_p95_ms`), `n`, `measuredAt`, `slice: "openrouter-free"`.
- **Stable URL on the Lodestone site**, for example `https://lodestone.extrafemi.com/data/free-model-index.json`, with `Access-Control-Allow-Origin: *` so anyone can read it and the site's own CSP does not need a new origin.

## The page

A page on the Lodestone site, `/free-model-index/`, built the way the Runs on Lodestone page is: static, reading the published JSON.

- A sortable table: model, usable rate, p50 and p95, timeouts, rate limits, first seen, last probed, n. Models with n < 30 in the window are listed but not rated.
- A 14-day strip per model (one cell a day) so a change is visible.
- "Updated" time, the methodology version, a link to the data and the repo, and a copy-ready citation line.
- Plain-language note at the top: "A low rate is not a bad model. These are the free tiers, which are rationed."
- Emit `Dataset` structured data and add the page to `llms.txt` and the sitemap, so search engines and AI assistants can find and quote it.

## How Naija Eval connects

Two halves of the same question, "can I build on this free model?": the index says whether it answers at all, Naija Eval says how good the answer is in Hausa, Igbo and Yoruba.

- **Same format.** Both publish `model-scorecard/1`. Lodestone already reads several scorecards and orders models with `quality: { task, metric, language }`. A Hausa task can sort by Naija Eval's `chrf++`; any other task by the index's `usable_rate`.
- **The index gates Naija Eval's measurements.** On 28 Oct 2026 Naija Eval's free-model translation run got 0 of 180 answers from gemma-4-31b and nemotron-3.5-lightning, 4 of 180 from nemotron-3.5-super-vl, and 180 of 180 from nemotron-3-ultra. It correctly refused to publish a row of zeros. With the index, Naija Eval can run a free model's quality test only when that model has recently been usable, and can say "not measured: answers too rarely" instead of nothing.
- **The index feeds candidates both ways.** Lodestone's `model-candidates/1` already tells Naija Eval which models are in use. The index adds which free models exist and are alive, so Naija Eval benchmarks live models and skips dead ones.
- **A joined view.** One extra table, "up and good": usable rate (index) beside average chrF++ for Hausa, Igbo and Yoruba (Naija Eval, n = 100 per direction, with its date). A quality number is shown only for a model whose usable rate is above a stated floor in the same window, and always with its own n and date. Nobody else publishes this for African languages.
- **One rule, stated once:** quality and reliability stay separate columns and are never blended into one score.
- **Account separation again.** Naija Eval's all-day free runs also draw on an OpenRouter cap. It must use its own key, not the index's.

## Methodology and independence note (published with v1)

- What a probe is, the exact prompt, the validity rule, the timeouts, the outcome table, the window, the minimum n.
- Limits, stated up front: one prompt; GitHub's runners and region; free tiers are rationed and change without notice; ranks are not a judgement of the model.
- Independence: we sell nothing whose price or availability depends on a model's rank. We take no payment from any model provider or gateway.
- Disclosure: Extrafemi's own tools (KeyStone, Inkstone, TouchStone) and Naija Eval use these models, and Lodestone is the library that routes around the ones that fail. That is a reason we measure this and a reason to read it critically; the harness and data are open so anyone can check.
- Corrections policy: a wrong number is corrected in the open, with the old value kept in the history.
- Nothing is implied about OpenRouter's view of the index; it has not reviewed it.

## Funnel (later, not part of v1)

Library and index free, then hosted alerts (tell me when a model in my chain goes down or is withdrawn, using the index plus my Lodestone config), then a managed store for the circuit breaker and rate limits, then Extrafemi integration work. None of these should change what the index says.

## Success measures

Referrals to the page and the JSON, GitHub stars and forks of the repo, npm downloads of the library in the weeks after each update, AI-crawler and assistant citations of the page, and inbound messages that mention the index. Review after 8 weekly updates.

## Milestones

1. **Harness and data repo:** probe, validity rule, outcome classification, dedicated key, a manual run, the raw records and the daily rollup. About 2 days.
2. **Scheduler and catalogue watcher:** hourly or 8-hourly runs on GitHub Actions, new-model detection, the `data` branch. About 1 day.
3. **`scorecard.json` and the page:** the table, the strip, structured data, `llms.txt`. About 2 days.
4. **Methodology page and the first 14 days of history,** then **Update 1** and the announcement post.
5. **Naija Eval join:** the gate and the joined table, once Naija Eval is ready to read the scorecard.

## Risks

- **The free tier changes.** Limits, model availability and rules can change overnight. The methodology says what was true when, and the version bumps.
- **"One prompt proves nothing."** True, and stated. A second probe type (a longer reasoning-light task) is a v1.1 candidate, not a v1 requirement.
- **Our probes distort the thing measured.** A dedicated account and a once-an-hour rate keep that small, and `probe_budget` outcomes are excluded.
- **Cloudflare or an upstream blocks the runners.** Recorded as `other` with the status. If it is persistent, move the scheduler to a Worker cron, which is also free.
- **Credibility.** The index is only as good as the care in the methodology. Publish the failures and the corrections.
- **Terms.** OpenRouter's limits page has no rule about benchmarking, only that heavy abuse is blocked and limits are global. Re-read it before launch.

## Open decisions for the owner

1. Spend the one-time 10 credits on a dedicated OpenRouter account (Option B), or start on Option A with 15 models?
2. A separate `free-model-index` repo, or a folder inside the Lodestone repo?
3. Data licence: CC BY 4.0 (recommended) or CC0?
4. First scorecard consumer: ship the Lodestone site page first, or the Naija Eval join first?
