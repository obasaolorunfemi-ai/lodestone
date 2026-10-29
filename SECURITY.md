# Security

## Reporting a problem

Please report a vulnerability privately, not in a public issue: use GitHub's **Report a vulnerability** button on the
Security tab of this repository. Say what you found, how to reproduce it, and which version. You will get a reply
within a few days. Please give a reasonable time to fix it before you publish details.

## What this package is, for supply-chain purposes

- **No runtime dependencies.** Lodestone uses only `fetch`, `AbortSignal` and `URL`. Installing it brings in nothing else,
  so there is nothing underneath it to be taken over.
- **Published with provenance.** Each release is built by a GitHub Actions workflow from a tagged commit and published to
  npm with a signed attestation. `npm audit signatures` verifies that a package came from this repository.
- **Small.** About 1,600 lines of source, with tests beside it. Read it before you depend on it.
- **Pinned build.** Every third-party GitHub Action is pinned to a commit, not a tag; Dependabot proposes updates; CodeQL scans the TypeScript and Python on every push and weekly; the release job runs in a protected environment (`npm-publish`) that needs a human to approve before anything is published.
- **Your keys stay yours.** Keys are passed in by your code and sent only to the provider you name. They are never stored,
  logged or sent anywhere else, and prompts and answers are never logged. `onAttempt` reports the provider, model, outcome
  and timing only.

## What Lodestone checks about models, and what it does not

There is no vulnerability database for hosted AI models, so Lodestone does not claim to scan for one. It checks what can
really be checked, and says where it cannot:

- **Who made it.** A model found by discovery is used only if its publisher is on a list of well-known labs (yours to
  change). A model you name yourself is your decision.
- **What happens to the prompt.** Where a provider publishes it (Requesty does, for every model), a model that is trained on,
  or that keeps prompts longer than you allow, is refused. For OpenRouter, a call marked `private` asks for providers that do
  not keep or train on prompts. For other providers Lodestone cannot enforce this: it relies on the model's list entry, and
  refuses a model whose list says nothing.
- **That it is not about to disappear.** A model with an expiry date within a week is left out.
- **That the answer is the shape you expect.** `json()` skips a model whose answer is not valid JSON or fails your check,
  which also limits what a misbehaving model can hand to the rest of your code. Treat every model answer as untrusted input.

These are self-reported by providers and are only as good as what they report.

## What protects your users' data and your budget

- **A private call is never cached**, and goes only to providers that say, or that you vouch for, they do not keep or train on the prompt ([README](README.md#private-calls-private-true)).
- **A cached answer is tied to the input**, not only to the key you chose, so a `cacheKey` that is too coarse cannot hand one person's answer to another.
- **The spend limit holds under a burst** (`createSpendLimit` takes a hold per attempt), and **each caller has an allowance** (`rateLimit`), stored as a hash so an IP address is not kept. What is exact and what is approximate between processes is stated in [docs/protecting-your-budget.md](docs/protecting-your-budget.md).
- **Anything read back from a store is checked** for shape and size before it is used (catalogue, breaker state, spend ledger, rate-limit counters), so a store someone else can write to cannot hide every model or grow without limit.
- **Errors do not carry the provider's raw response into logs.** `ProviderError.body` is not an enumerable property, so `console.log(err)` and `JSON.stringify(err)` leave it out; read `err.body` deliberately.
- **A scorecard fetched from a URL** must be https, under 1 MB by default, and (if you pass `allowedHosts`) from a host you named, including after a redirect. A scorecard can only change the order models are tried in.

## Known limits

- Lodestone cannot tell a person from a script. `caller` is whatever you pass; an IP address is a weak identity.
- With a plain get/set store, counters are exact inside one process and approximate between processes. Use `upstashStore` where that matters.
- `private` cannot make a provider honour a promise it does not publish. It can only refuse providers that say nothing.
- Everything above is about what Lodestone does. The model's answer is untrusted input: treat it like user input.
