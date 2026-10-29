"""A circuit breaker: remembers which models have been failing, so a request does not spend its time on a model that is down.

A model whose last few attempts all failed is skipped; every couple of minutes one attempt is let through to see
whether it has recovered. With a store, every instance (every serverless function) shares what it has learned."""
from __future__ import annotations

import secrets
import time
from typing import Any, Callable, Optional

KEEP = 6
SHARE_S = 15.0
MAX_MODELS = 400


def _clean(raw: Any) -> dict[str, list[list]]:
    """What a store returned, checked: well-formed samples for a bounded number of models only."""
    out: dict[str, list[list]] = {}
    if not isinstance(raw, dict):
        return out
    for k, lst in list(raw.items())[:MAX_MODELS]:
        if not isinstance(k, str) or len(k) > 300 or not isinstance(lst, list):
            continue
        ok = [s for s in lst if isinstance(s, list) and len(s) == 3 and isinstance(s[0], (int, float)) and s[1] in (0, 1)
              and isinstance(s[2], str) and len(s[2]) <= 16][-KEEP:]
        if ok:
            out[k] = ok
    return out


class Health:
    def __init__(self, store: Any = None, key: str = "lodestone:health", failures: int = 3, window_s: float = 600.0,
                 probe_every_s: float = 120.0, now: Callable[[], float] = time.time) -> None:
        self._store, self._key, self._need, self._window, self._probe, self._now = store, key, failures, window_s, probe_every_s, now
        self._state: dict[str, list[list]] = {}
        self._loaded_at = float("-inf")

    @staticmethod
    def _id(provider: str, model: str) -> str:
        return f"{provider}\x00{model}"

    @staticmethod
    def _merge(a: dict, b: dict) -> dict:
        out: dict[str, list[list]] = {}
        for k in {*a, *b}:
            seen: set[str] = set()
            rows = []
            for at, ok, sid in sorted([*a.get(k, []), *b.get(k, [])], key=lambda s: s[0]):
                u = f"{at}:{sid}"
                if u not in seen:
                    seen.add(u)
                    rows.append([at, ok, sid])
            out[k] = rows[-KEEP:]
        return out

    async def _refresh(self) -> None:
        if not self._store or self._now() - self._loaded_at < SHARE_S:
            return
        self._loaded_at = self._now()
        try:
            self._state = self._merge(self._state, _clean(await self._store.get(self._key)))
        except Exception:  # an unreadable store is the same as an empty one
            pass

    def _recent(self, k: str) -> list[list]:
        return [s for s in self._state.get(k, []) if self._now() - s[0] <= self._window]

    def _is_open(self, recent: list[list]) -> bool:
        last = recent[-self._need:]
        if len(last) < self._need or any(s[1] == 1 for s in last):
            return False
        return self._now() - last[-1][0] < self._probe

    async def should_skip(self, provider: str, model: str) -> bool:
        await self._refresh()
        return self._is_open(self._recent(self._id(provider, model)))

    async def record(self, provider: str, model: str, ok: bool) -> None:
        k = self._id(provider, model)
        before = self._recent(k)
        recovering = bool(before) and before[-1][1] == 0
        self._state[k] = [*self._state.get(k, []), [self._now(), 1 if ok else 0, secrets.token_hex(3)]][-KEEP:]
        if not self._store or (ok and not recovering):
            return
        try:
            self._state = self._merge(self._state, _clean(await self._store.get(self._key)))
            await self._store.set(self._key, self._state, int(self._window * 3000))
            self._loaded_at = self._now()
        except Exception:  # not saved: the next instance just has to learn it again
            pass
