"""Calls a real provider once, through the Python port, and prints what happened. Keys come from the environment and are never printed.

    GROQ_API_KEY=... OPENROUTER_API_KEY=... python scripts/live_check.py

One tiny request per key (a few tokens), so the cost is a fraction of a cent. Run from the python/ folder after
`pip install -e .`, or with PYTHONPATH=src."""
import asyncio
import os
import time

from lodestone import Fallback, Lodestone, OpenRouterConfig, explain, groq, LodestoneError

PROMPT = 'Reply with only this JSON: {"ok":true}'
ok = lambda v: isinstance(v, dict) and v.get("ok") is True  # noqa: E731


async def run(label: str, ai: Lodestone) -> dict:
    attempts: list[str] = []
    ai.on_attempt = lambda e: attempts.append(f"{e.model}: {e.outcome}{' ' + str(e.status) if e.status else ''}")
    t0 = time.monotonic()
    try:
        r = await ai.json(PROMPT, max_tokens=400, validate=ok)
        return {"check": label, "result": "answered", "provider": r.provider, "model": r.model, "seconds": round(time.monotonic() - t0, 1)}
    except LodestoneError as err:
        return {"check": label, "result": "failed", "kind": err.kind, "seconds": round(time.monotonic() - t0, 1),
                "say": explain(err, product="check"), "attempts": "; ".join(attempts)}


async def main() -> None:
    rows = []
    if os.environ.get("GROQ_API_KEY"):
        ai = Lodestone(fallbacks=[Fallback(groq(), os.environ["GROQ_API_KEY"], ["openai/gpt-oss-20b"], free=True)])
        rows.append(await run("groq (fallback only)", ai))
    else:
        rows.append({"check": "groq", "result": "skipped: GROQ_API_KEY not set"})
    if os.environ.get("OPENROUTER_API_KEY"):
        ai = Lodestone(openrouter=OpenRouterConfig(api_key=os.environ["OPENROUTER_API_KEY"], allow_paid=True, paid_first=True, paid_models=["anthropic/claude-haiku-5.5"]))
        rows.append(await run("openrouter (paid first)", ai))
    else:
        rows.append({"check": "openrouter", "result": "skipped: OPENROUTER_API_KEY not set"})
    for row in rows:
        print(row)


if __name__ == "__main__":
    asyncio.run(main())
