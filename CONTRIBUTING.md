# Contributing

Thank you for looking. Lodestone is small on purpose: no dependencies, about two thousand lines of source, and tests beside it. A change that keeps it that way is easy to say yes to.

## Before you open a pull request

```bash
npm ci
npm run typecheck && npm test
npm run smoke            # the built library, on Node
npm run smoke:workers    # the built library, in workerd (Cloudflare Workers)
cd python && python -m unittest discover -s tests -t .
```

- Add a test for what you changed. A bug fix starts with a test that fails.
- Keep it dependency-free. If a change needs a package, open an issue first and say why.
- Keep it web-standard: `fetch`, `Response`, `AbortSignal`, `crypto.subtle`. No `node:` imports in `src/` (CI runs the library on Workers, Deno and Bun).
- Do not log prompts or answers, anywhere, ever. `onAttempt` carries provider, model, outcome and timing only.
- Say what you measured. Claims on the site and in the README are checked against code or a dated measurement; please follow that.

## Good first issues

- A store adapter for another platform (see `src/stores/`).
- A provider preset, with how far you checked it: the table on the site separates "a chat call answered live" from "the endpoint answers".
- Running the smoke checks on a runtime we do not list, and telling us what happened.
- Python: reading a provider's model list, so `private` can vet a fallback without being vouched for.

## Reporting a security problem

Privately, please: see [SECURITY.md](SECURITY.md).

## Conduct

Be kind and be specific. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
