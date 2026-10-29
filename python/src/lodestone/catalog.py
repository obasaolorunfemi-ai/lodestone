"""Works out which models to ask OpenRouter for from its own catalogue, so a withdrawn model is dropped and a current one takes its place."""
from __future__ import annotations

import asyncio
import json
import re
import time
import urllib.request
from typing import Any, Callable, Optional

from .trust import TrustPolicy, vet

ROUTER = "openrouter/free"
_EXCLUDE = re.compile(r"safety|guard|moderation|lyria|embed|rerank|tts|whisper|code|coder|preview-audio|ocr", re.I)
_LIGHT = re.compile(r"lightning|flash|mini|small|nano|lite|fast", re.I)
_SAVED_KEY = "lodestone:model-catalog"
MAX_CATALOG = 5000
MEMORY_S = 6 * 3600
STALE_S = 24 * 3600


def _price(v: Any) -> Optional[float]:
    try:
        return float(v) * 1e6 if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _is_free(m: dict) -> bool:
    p = m.get("pricing") or {}
    return m["id"].endswith(":free") or (_price(p.get("prompt")) == 0 and _price(p.get("completion")) == 0 and m["id"] != ROUTER)


def _size(mid: str) -> int:
    x = re.search(r"(\d{2,4})b\b", mid, re.I)
    return int(x.group(1)) if x else 0


def _rank_key(tier: str, m: dict):
    ctx = -(m.get("context_length") or 0)
    if tier == "fast":
        return (not _LIGHT.search(m["id"]), _size(m["id"]), ctx)
    return (-_size(m["id"]), ctx)


def eligible(catalog: list[dict], tier: str) -> list[dict]:
    out = []
    for m in catalog:
        arch = m.get("architecture") or {}
        text_out = ",".join(arch.get("output_modalities") or ["text"]) == "text"
        if _is_free(m) and text_out and (m.get("context_length") or 0) >= 32_000 and not _EXCLUDE.search(m["id"]):
            out.append(m)
    return out


def pick_models(tier: str, catalog: Optional[list[dict]], preferences: list[str], policy: Optional[TrustPolicy] = None,
                strict: bool = False, depth: int = 3, now_ms: Optional[float] = None) -> list[str]:
    if not catalog:
        return preferences[:depth]
    now_ms = now_ms if now_ms is not None else time.time() * 1000
    ok = {m["id"]: m for m in eligible(catalog, tier)}
    out = [i for i in preferences if i != ROUTER and i in ok and vet(ok[i], policy, False, now_ms, strict) is None]
    rest = sorted((m for m in ok.values() if m["id"] not in out and vet(m, policy, True, now_ms, strict) is None), key=lambda m: _rank_key(tier, m))
    for m in rest:
        if len(out) >= depth - 1:
            break
        out.append(m["id"])
    return [*out[: depth - 1], ROUTER]


def clean_saved(raw: Any) -> Optional[dict]:
    if not isinstance(raw, dict) or not isinstance(raw.get("at"), (int, float)) or not isinstance(raw.get("models"), list):
        return None
    models = [m for m in raw["models"] if isinstance(m, dict) and isinstance(m.get("id"), str) and 0 < len(m["id"]) <= 200][:MAX_CATALOG]
    return {"at": raw["at"], "models": models} if models else None


def _fetch_openrouter() -> Optional[list[dict]]:
    with urllib.request.urlopen("https://openrouter.ai/api/v1/models", timeout=8) as r:  # noqa: S310 - fixed https URL
        data = json.loads(r.read()).get("data", [])
    models = [{"id": m["id"], "context_length": m.get("context_length"), "architecture": m.get("architecture"), "pricing": m.get("pricing"),
               **({"expiration_date": m["expiration_date"]} if m.get("expiration_date") else {})} for m in data if isinstance(m, dict) and isinstance(m.get("id"), str)]
    return models or None


class Catalog:
    def __init__(self, store: Any, now: Callable[[], float] = time.time, fetch: Callable[[], Optional[list[dict]]] = _fetch_openrouter) -> None:
        self._store, self._now, self._fetch = store, now, fetch
        self._memory: Optional[tuple[float, list[dict]]] = None
        self._last_kick = float("-inf")
        self._tasks: set[asyncio.Task] = set()

    async def refresh(self) -> Optional[list[dict]]:
        try:
            models = await asyncio.to_thread(self._fetch)
        except Exception:
            return None
        if not models:
            return None
        try:
            await self._store.set(_SAVED_KEY, {"at": self._now(), "models": models})
        except Exception:
            pass
        self._memory = (self._now(), models)
        return models

    def _kick(self) -> None:
        t = asyncio.ensure_future(self.refresh())
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)

    async def load(self) -> Optional[list[dict]]:
        """The saved catalogue. Never waits on the network unless it must: with nothing saved yet the preferences are used this time."""
        if self._memory and self._now() - self._memory[0] < MEMORY_S:
            return self._memory[1]
        try:
            saved = clean_saved(await self._store.get(_SAVED_KEY))
            if saved:
                self._memory = (self._now(), saved["models"])
                if self._now() - saved["at"] > STALE_S:
                    self._kick()
                return saved["models"]
            if self._now() - self._last_kick > 300:
                self._last_kick = self._now()
                self._kick()
        except Exception:
            pass
        return None
