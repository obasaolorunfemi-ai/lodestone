"""A daily and a monthly spend limit that holds under load.

A bare allow() then record() lets a burst of requests all pass the check before any has been counted. This takes a
hold for each paid attempt when it is allowed and counts the holds against the limit; the hold is replaced by the
real cost when the attempt answers, and handed back when it does not. Exact inside one process; between processes it
is as good as the store. If the ledger cannot be read, the attempt is refused (the money is yours).

Each caller can have a share of their own (``per_caller``), so one person cannot use up the pool for everyone. It needs the call to name the caller
(``caller=``); a call without one is only held to the pool. A caller's own key is their money and never counts here, unless they asked for a limit of
their own (``spend_cap`` on the call): then their paid calls on that key are counted separately, in a ledger that never touches yours, and stopped
when they reach the number they chose. What is stored under a caller is a hash of the caller, never the caller."""
from __future__ import annotations

import asyncio
import hashlib
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
    caller: Optional[str] = None
    own_key: bool = False  # the call is on the caller's own key: their money. Only asked about when they set a spend_cap
    cap: Optional[dict] = None  # the limit the caller chose for themselves: {'daily_usd': .., 'monthly_usd': ..}


def _lowest(a: Optional[float], b: Optional[float]) -> Optional[float]:
    return b if a is None else a if b is None else min(a, b)


def _nn(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0 and v == v and v != float("inf")


class SpendLimit:
    handles_own_key = True  # keeps a share for each caller and a cap of the caller's own on their own key

    def __init__(self, store: Any, daily_usd: Optional[float] = None, monthly_usd: Optional[float] = None, hold_usd: float = 0.01,
                 hold_ttl_s: float = 120.0, key: str = "lodestone:spend", now: Callable[[], float] = time.time,
                 per_caller: Optional[dict] = None) -> None:
        self._store, self._daily, self._monthly, self._hold, self._ttl, self._key, self._now = store, daily_usd, monthly_usd, hold_usd, hold_ttl_s, key, now
        self._per_caller = per_caller
        self._lock = asyncio.Lock()
        self._refusals: dict[str, str] = {}

    def refusal(self, info_id: str) -> Optional[str]:
        """Which limit refused the attempt that allow() just turned down: 'app', 'caller' or 'own-key'. Read once."""
        return self._refusals.pop(info_id, None)

    def _refuse(self, info_id: str, scope: str) -> bool:
        if len(self._refusals) >= 100:
            self._refusals.pop(next(iter(self._refusals)))
        self._refusals[info_id] = scope
        return False

    async def _load(self, at: Optional[str] = None) -> dict:
        day = datetime.fromtimestamp(self._now(), tz=timezone.utc).strftime("%Y-%m-%d")
        month = day[:7]
        raw = await self._store.get(at or self._key)
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

    def _over(self, l: dict, daily: Optional[float], monthly: Optional[float]) -> bool:
        pending = self._held(l) + self._hold
        return (daily is not None and l["dayUsd"] + pending > daily) or (monthly is not None and l["monthUsd"] + pending > monthly)

    def _target(self, info: SpendInfo) -> Optional[tuple[str, Optional[float], Optional[float]]]:
        """Where this attempt is counted besides the pool: the caller's share, or, on their own key, the cap they chose."""
        if not info.caller:
            return None
        who = hashlib.sha256(info.caller.encode()).hexdigest()[:32]
        cap = info.cap or {}
        if info.own_key:
            return (f"{self._key}:own:{who}", cap.get("daily_usd"), cap.get("monthly_usd")) if info.cap else None
        pc = self._per_caller or {}
        if not self._per_caller and not info.cap:
            return None
        return (f"{self._key}:caller:{who}", _lowest(pc.get("daily_usd"), cap.get("daily_usd")), _lowest(pc.get("monthly_usd"), cap.get("monthly_usd")))

    def _ledgers(self, info: SpendInfo) -> list[str]:
        mine = self._target(info)
        return [*([] if info.own_key else [self._key]), *([mine[0]] if mine else [])]

    async def allow(self, info: SpendInfo) -> bool:
        async with self._lock:
            try:
                taken: list[tuple[str, dict]] = []
                if not info.own_key:
                    l = await self._load()
                    if self._over(l, self._daily, self._monthly) or len(l["holds"]) >= MAX_HOLDS:
                        return self._refuse(info.id, "app")
                    taken.append((self._key, l))
                mine = self._target(info)
                if mine:
                    c = await self._load(mine[0])
                    if self._over(c, mine[1], mine[2]) or len(c["holds"]) >= MAX_HOLDS:
                        return self._refuse(info.id, "own-key" if info.own_key else "caller")
                    taken.append((mine[0], c))
                for at, l in taken:
                    l["holds"][info.id] = [self._hold, self._now() + self._ttl]
                    await self._store.set(at, l)
                return True
            except Exception:
                return False

    async def record(self, info: SpendInfo, cost_usd: Optional[float] = None) -> None:
        async with self._lock:
            for at in self._ledgers(info):
                l = await self._load(at)
                taken = l["holds"].pop(info.id, [self._hold])[0]
                cost = cost_usd if _nn(cost_usd) else taken  # a cost nobody reported counts as the hold
                l["dayUsd"] += cost
                l["monthUsd"] += cost
                await self._store.set(at, l)

    async def release(self, info: SpendInfo) -> None:
        async with self._lock:
            for at in self._ledgers(info):
                l = await self._load(at)
                if info.id in l["holds"]:
                    del l["holds"][info.id]
                    await self._store.set(at, l)

    async def report(self) -> dict:
        async with self._lock:
            l = await self._load()
            return {"today_usd": l["dayUsd"], "month_usd": l["monthUsd"], "held_usd": self._held(l)}

    async def caller_report(self, caller: str, own_key: bool = False, cap: Optional[dict] = None) -> dict:
        """What one caller has spent and may spend: on the pool's money, or on their own key with ``own_key`` and the ``cap`` they chose."""
        async with self._lock:
            mine = self._target(SpendInfo("", "", "", "paid", caller, own_key, cap))
            l = await self._load(mine[0] if mine else f"{self._key}:caller:{hashlib.sha256(caller.encode()).hexdigest()[:32]}")
            return {"today_usd": l["dayUsd"], "month_usd": l["monthUsd"], "held_usd": self._held(l),
                    "daily_usd": mine[1] if mine else None, "monthly_usd": mine[2] if mine else None}
