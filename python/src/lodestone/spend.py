"""A daily and a monthly spend limit that holds under load.

A bare allow() then record() lets a burst of requests all pass the check before any has been counted. This takes a
hold for each paid attempt when it is allowed and counts the holds against the limit; the hold is replaced by the
real cost when the attempt answers, and handed back when it does not. Exact inside one process; between processes it
is as good as the store. If the ledger cannot be read, the attempt is refused (the money is yours)."""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Optional

MAX_HOLDS = 500


@dataclass
class SpendInfo:
    id: str
    provider: str
    model: str
    phase: str  # 'paid' | 'fallback'


def _nn(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0 and v == v and v != float("inf")


class SpendLimit:
    def __init__(self, store: Any, daily_usd: Optional[float] = None, monthly_usd: Optional[float] = None, hold_usd: float = 0.01,
                 hold_ttl_s: float = 120.0, key: str = "lodestone:spend", now: Callable[[], float] = time.time) -> None:
        self._store, self._daily, self._monthly, self._hold, self._ttl, self._key, self._now = store, daily_usd, monthly_usd, hold_usd, hold_ttl_s, key, now
        self._lock = asyncio.Lock()

    async def _load(self) -> dict:
        day = datetime.fromtimestamp(self._now(), tz=timezone.utc).strftime("%Y-%m-%d")
        month = day[:7]
        raw = await self._store.get(self._key)
        s = raw if isinstance(raw, dict) else {}
        holds: dict[str, list[float]] = {}
        if isinstance(s.get("holds"), dict):
            for hid, h in list(s["holds"].items())[:MAX_HOLDS]:
                if isinstance(h, list) and len(h) == 2 and _nn(h[0]) and _nn(h[1]) and h[1] > self._now():
                    holds[hid] = [h[0], h[1]]
        return {"day": day, "month": month, "holds": holds,
                "dayUsd": s["dayUsd"] if s.get("day") == day and _nn(s.get("dayUsd")) else 0.0,
                "monthUsd": s["monthUsd"] if s.get("month") == month and _nn(s.get("monthUsd")) else 0.0}

    @staticmethod
    def _held(l: dict) -> float:
        return sum(h[0] for h in l["holds"].values())

    async def allow(self, info: SpendInfo) -> bool:
        async with self._lock:
            try:
                l = await self._load()
                pending = self._held(l) + self._hold
                if self._daily is not None and l["dayUsd"] + pending > self._daily:
                    return False
                if self._monthly is not None and l["monthUsd"] + pending > self._monthly:
                    return False
                if len(l["holds"]) >= MAX_HOLDS:
                    return False
                l["holds"][info.id] = [self._hold, self._now() + self._ttl]
                await self._store.set(self._key, l)
                return True
            except Exception:
                return False

    async def record(self, info: SpendInfo, cost_usd: Optional[float] = None) -> None:
        async with self._lock:
            l = await self._load()
            taken = l["holds"].pop(info.id, [self._hold])[0]
            cost = cost_usd if _nn(cost_usd) else taken  # a cost nobody reported counts as the hold
            l["dayUsd"] += cost
            l["monthUsd"] += cost
            await self._store.set(self._key, l)

    async def release(self, info: SpendInfo) -> None:
        async with self._lock:
            l = await self._load()
            if info.id in l["holds"]:
                del l["holds"][info.id]
                await self._store.set(self._key, l)

    async def report(self) -> dict:
        async with self._lock:
            l = await self._load()
            return {"today_usd": l["dayUsd"], "month_usd": l["monthUsd"], "held_usd": self._held(l)}
