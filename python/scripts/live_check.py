"""Calls a real provider once, through the Python port, and prints what happened. Keys come from the environment and are never printed.

    GROQ_API_KEY=... REQUESTY_API_KEY=... OPENROUTER_API_KEY=... python scripts/live_check.py

One tiny request per key (a few tokens), so the cost is a fraction of a cent. Run from the python/ folder after
`pip install -e .`, or with PYTHONPATH=src."""
import asyncio
import os
import time
import urllib.error
import urllib.request

from lodestone import Fallback, Lodestone, LodestoneError, OpenRouterConfig, explain, groq, requesty
from lodestone.providers import USER_AGENT

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


def diagnose(url: str) -> str:
    """Status 599 means the request itself failed before any answer. This asks the service for its public model list, with no key, and says what Python itself reports: a 401 means the connection is fine."""
    try:
        urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": USER_AGENT}), timeout=10)  # noqa: S310
        return "connected, answered 200"
    except urllib.error.HTTPError as e:
        return f"connected, the service answered {e.code} (so the network and certificates are fine)"
    except Exception as e:  # noqa: BLE001
        return f"could not connect: {type(e).__name__}: {e}"


async def main() -> None:
    rows = []
    if os.environ.get("GROQ_API_KEY"):
        ai = Lodestone(fallbacks=[Fallback(groq(), os.environ["GROQ_API_KEY"], ["openai/gpt-oss-20b"], free=True)])
        row = await run("groq (fallback only)", ai)
        if "599" in row.get("attempts", ""):
            row["connection"] = diagnose("https://api.groq.com/openai/v1/models")
        rows.append(row)
    else:
        rows.append({"check": "groq", "result": "skipped: GROQ_API_KEY not set"})
    if os.environ.get("REQUESTY_API_KEY"):
        ai = Lodestone(fallbacks=[Fallback(requesty(), os.environ["REQUESTY_API_KEY"], ["bedrock/claude-haiku-5-5"])])
        rows.append(await run("requesty (fallback only)", ai))
    else:
        rows.append({"check": "requesty", "result": "skipped: REQUESTY_API_KEY not set"})
    if os.environ.get("OPENROUTER_API_KEY"):
        ai = Lodestone(openrouter=OpenRouterConfig(api_key=os.environ["OPENROUTER_API_KEY"], allow_paid=True, paid_first=True, paid_models=["anthropic/claude-haiku-5.5"]))
        rows.append(await run("openrouter (paid first)", ai))
    else:
        rows.append({"check": "openrouter", "result": "skipped: OPENROUTER_API_KEY not set"})
    for row in rows:
        print(row)


if __name__ == "__main__":
    asyncio.run(main())
