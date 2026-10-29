# Lodestone for Python

Reliable AI calls on a shoestring budget. A Python port of [Lodestone](https://lodestone.extrafemi.com): it sits between your code and AI models, and when a model is withdrawn, slow, rate-limited or down it moves to the next one, stays inside your time limit, spends only what you allow, and, if everything fails, tells the person what went wrong in plain words.

Zero dependencies (the standard library only), Python 3.10 or newer. **Alpha (0.1).** Read "What is not in the Python port yet" before you rely on it.

```bash
# not on PyPI yet; until it is, install from the repository
pip install "git+https://github.com/obasaolorunfemi-ai/lodestone#subdirectory=python"
```

```python
import asyncio
from lodestone import (Lodestone, OpenRouterConfig, Fallback, Health, SpendLimit, RateLimiter, MemoryStore,
                       LodestoneError, explain, groq)

store = MemoryStore()  # use UpstashStore(url, token) to share state between serverless functions

ai = Lodestone(
    openrouter=OpenRouterConfig(api_key=OPENROUTER_KEY, allow_paid=True, paid_first=True, paid_models=["anthropic/claude-haiku-5.5"]),
    fallbacks=[Fallback(groq(), GROQ_KEY, ["openai/gpt-oss-20b"], free=True)],
    health=Health(store),                                   # skip a model that keeps failing, for every function
    spend=SpendLimit(store, daily_usd=2, monthly_usd=30),   # holds, so a burst cannot overshoot
    rate_limit=RateLimiter(store, max=20, window_ms=3_600_000),
    when_over="free-only",                                  # an over-limit caller never costs you anything
    store=store,
)

async def handler(text: str, user_id: str) -> str:
    try:
        r = await ai.json(f"Summarise as JSON {{title, points}}:\n\n{text}", caller=user_id, private=True,
                          validate=lambda v: isinstance(v, dict) and "title" in v)
        return r.data["title"]
    except LodestoneError as err:
        return explain(err, product="MyApp")        # a sentence a person can read

print(asyncio.run(handler("...", "user-1")))
```

For a script, `ai.complete_sync("hello")` runs a call to the end.

## What it does

Everything in the TypeScript library's [README](../README.md) about these, with the same defaults:

- Free models first, then a low-cost paid model, then your `fallbacks`, inside a 24 s budget (`budget_ms`) with a slice for each attempt.
- A model list that checks itself against OpenRouter's catalogue: a withdrawn model is dropped and a current one takes its place.
- `json()` skips a model whose answer is not valid JSON or fails your `validate`.
- Typed failures (`LodestoneError.kind`) and `explain()`, with the same sentences.
- A circuit breaker (`Health`) shared through a store.
- `SpendLimit`: a daily and monthly limit that takes a hold per paid attempt.
- `RateLimiter` and `caller=`: each caller has their own allowance. Only a hash of the caller is stored.
- `private=True`: OpenRouter is told to use only providers that do not keep or train on the prompt; a fallback is used only if you vouch for it with `privacy="no-training"`; the answer is never cached.
- `cache_key=`: tied to a fingerprint of the input, so a key that is too coarse is a miss, never another input's answer.

## What is not in the Python port yet

Be clear-eyed about these before you choose it over the TypeScript library.

- **Model lists other than OpenRouter's.** The port can't read the other providers' model lists. So Requesty's price, lab and data-policy details, and `discover` (topping up a fallback's model list), are TypeScript-only. For a private call, a fallback is only used if you vouch for it.
- **Cancelling a hung request.** A hung call is cut off at its time slice and the next model is tried, but the thread making the request is only ended by its socket timeout, not killed.

## Disclaimers

- **Images, streaming, tool calling and scorecards.** None of these exist in the Python port.
- **Real-provider testing.** The port has been tested against a local HTTP server and fake providers, not against live ones. That is the main reason it is alpha.

## If every call fails with status 599

Status 599 means the request itself failed before a provider answered. The commonest cause on a Mac is Python from python.org, which ships without trusted certificates, so every HTTPS request fails with `CERTIFICATE_VERIFY_FAILED`. Run `Install Certificates.command` from the Python folder in Applications (for example `/Applications/Python 3.14/`), or `pip install certifi`, then try again. `python scripts/live_check.py` prints what Python itself reports. The port never turns certificate checking off.

## If a provider answers 403

Some providers sit behind Cloudflare, which refuses Python's default User-Agent (`Python-urllib`) with a 403 before the request reaches the provider. Groq does: a live check on 28 October 2026 got 403 from Python and an answer from the Node library with the same key. The port now sends `lodestone-python/0.1` on every request. If you write your own provider, set a User-Agent of your own.

## Stores

`MemoryStore` (default) and `UpstashStore` (Upstash Redis and Vercel KV over REST, standard library only; it counts atomically, so rate limits are exact across functions). A store is any object with `async get(key)` and `async set(key, value, ttl_ms=None)`; one that also has `async incr_by(key, by, ttl_ms)` can count atomically.

## Develop

```bash
cd python
python -m unittest discover -s tests -t .
```
