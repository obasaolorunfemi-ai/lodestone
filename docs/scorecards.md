# Scorecards and candidates

Two small JSON formats let a model evaluator and Lodestone feed each other without knowing about each other's code. [Naija Eval](https://naija-eval.extrafemi.com) is the first evaluator to use them.

```
   evaluator (Naija Eval)                         Lodestone (in your tool)
   ──────────────────────                         ────────────────────────
   measures answer quality  ── model-scorecard ──▶  orders models by it, per task
                                                      │
   benchmarks what is in use ◀─ model-candidates ──   lists the models it can call
                                                      │
   (reads live reliability) ◀── model-scorecard ───   records success rate and speed
```

Nothing here is automatic or hidden. A scorecard changes the order models are *tried* in, for tasks you name, and nothing else. A model nobody measured is never dropped, added or moved.

## Why Naija Eval is a good evaluator to start with

[Naija Eval](https://naija-eval.extrafemi.com) tests Nigeria's own language model, N-ATLaS, against the Llama model it was built from and four hosted models, on Hausa, Igbo and Yoruba. Four things make it a sound first source for Lodestone, and its limits are part of the answer.

- **It measures what a price list cannot tell you.** Whether a model can translate between English and Hausa, Igbo or Yoruba, or transcribe speech in those languages, is not something a provider's own claims settle. Naija Eval scores each model on six translation directions (chrF++) and three speech languages (word error rate), and also shows each score ignoring tone marks, so a missing mark can be told apart from a wrong word.
- **Anyone can re-run it.** It uses public test sets (Google's FLEURS and FLORES, CC BY-SA 4.0), one fixed prompt for every model and temperature 0. A script for each step, the results file (`summary.json`) and the scorecard (`scorecard.json`) are public, and repeating the four hosted-model runs cost $1.59. A number that can be repeated can also be checked, and corrected.
- **It states what it did not do.** Each score rests on 100 items per language and direction, and Naija Eval calls itself a first pass, not a leaderboard. The 4-bit local models may score a point or two below full precision. The test sets are public, so any model may have seen them in training. FLEURS is clean read speech, and street voice notes will score differently.
- **It publishes every number with what it rests on.** In `model-scorecard/1` each score carries its metric, which way is good, the number of items (`n`) and the day it was measured, so Lodestone never has to guess how much weight a figure deserves.

## Why its results are reliable enough for Lodestone

"Reliable" here means something narrow. Lodestone uses a scorecard to put models in a better order for a task you name, and it is built so that a wrong number cannot do much harm:

- A scorecard only changes the *order* models are tried in. Nothing is added, dropped or called that you did not list.
- A score resting on fewer than 30 items, or measured more than a year ago, is ignored. Naija Eval's scores rest on 100 items each.
- A model nobody measured keeps its slot, an explicit `route` is never reordered, and if the scorecard cannot be fetched within 1.5 seconds the order is left alone.
- The worst a bad number can do is put a slightly worse model first for that task. A failure or a slow answer still moves the call to the next model, as it always does.

What it does not tell you: Naija Eval measures translation and speech in Hausa, Igbo and Yoruba, so use it only for tasks you tag that way. It says nothing about extracting a job posting or scoring a CV in English. And one disclosure: Naija Eval and Lodestone are both Extrafemi projects, so the evaluator is not independent of Lodestone's author. The protection is that its method and data are public, so anyone can check it.

## `model-scorecard/1`

Measured results about models.

```json
{
  "schema": "model-scorecard/1",
  "source": "naija-eval",
  "generatedAt": "2026-10-28T09:00:00Z",
  "scores": [
    {
      "model": "anthropic/claude-sonnet-5.5",
      "task": "translate",
      "metric": "chrf++",
      "value": 32.3,
      "higherIsBetter": true,
      "n": 100,
      "measuredAt": "2026-10-08",
      "language": "yo",
      "slice": "en->yo"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `model` | An OpenRouter model id. A model that can't be routed (run locally) uses `local/<name>`; Lodestone ignores those. A `:free` or other `:variant` suffix is ignored when matching, so a score for a model applies to its free version. |
| `task` | What was measured: `translate`, `transcribe`, `availability`, `latency`. |
| `metric` | How: `chrf++`, `wer`, `success_rate`, `latency_p50_ms`. |
| `value`, `higherIsBetter` | The number, and which way is good. Both are stated, never assumed. |
| `n` | Items the score rests on. |
| `measuredAt` | The day it was measured. |
| `language` | ISO 639-1 code, when the task is about a language. |
| `slice` | A finer cut: `en->yo`, `avg`, or for live stats the provider. |

`parseScorecard()` checks all of this and lists every problem. A scorecard with a different `schema` version is refused, not guessed at.

### Using one

```ts
import { createLodestone, fetchScorecard } from '@extrafemi-ai/lodestone';

let card; let at = 0;
const ai = createLodestone({
  openrouter: { apiKey: process.env.OPENROUTER_API_KEY },
  // Called per request; keep your own cache. If it fails or takes over 1.5 s, the order is left alone.
  scorecards: async () => {
    if (!card || Date.now() - at > 6 * 3_600_000) { card = await fetchScorecard('https://naija-eval.extrafemi.com/data/scorecard.json'); at = Date.now(); }
    return [card];
  },
  profiles: {
    'translate-yoruba': { tier: 'strong', quality: { task: 'translate', metric: 'chrf++', language: 'yo', slice: 'avg' } },
  },
});

await ai.complete({ task: 'translate-yoruba', prompt });
```

The rules, so there are no surprises:

- Scores based on fewer than 30 items, or older than a year, are ignored (`minN`, `maxAgeDays` to change).
- Measured models are sorted among the slots they already hold. An unmeasured model keeps its slot, so a good unmeasured model is never pushed down by a weaker measured one.
- It applies to the free, paid and fallback model lists. It never reorders an explicit `route`.
- With two scorecards measuring the same thing, the one based on more items wins.

## Live reliability

An evaluator says how good an answer is. It can't say whether you get an answer at all. Lodestone records that itself:

```ts
import { createStats } from '@extrafemi-ai/lodestone';

const stats = createStats();                 // last 200 attempts per model and provider
const ai = createLodestone({ /* ... */, stats });

stats.scorecard();   // success_rate, latency_p50_ms, latency_p95_ms per model, as a model-scorecard/1
stats.toJSON();      // save in your store; stats.load(saved) after a restart
```

The result is an ordinary scorecard (`source: "lodestone-live"`), so it can be served, shared, or used to order models: `quality: { task: 'availability', metric: 'success_rate' }` puts the model that answers most often first. Stats never see prompts or answers.

## `model-candidates/1`

The models a tool can actually call, so an evaluator benchmarks those and not a guess.

```ts
const candidates = await ai.candidates();
```

```json
{
  "schema": "model-candidates/1",
  "source": "lodestone",
  "generatedAt": "2026-10-28T09:00:00Z",
  "models": [
    { "id": "google/gemma-4-31b-it:free", "provider": "openrouter", "roles": ["free:strong", "free:vision"] },
    { "id": "qwen/qwen3.7-flash", "provider": "openrouter", "roles": ["paid"] }
  ]
}
```

Serve it from an endpoint or write it to a file. Naija Eval's `eval/candidates.py` reads it and prints the exact commands for the models it hasn't measured yet.
