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
