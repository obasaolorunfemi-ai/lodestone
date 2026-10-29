"""Per-caller rate limiting, so one person cannot spend everyone's budget.

What is stored is a hash of the caller, never the caller: an IP address does not end up in your store."""
from __future__ import annotations

import asyncio
import hashlib
import time
from dataclasses import dataclass
from typing import Any, Callable


@dataclass
class RateLimitResult:
    ok: bool
    remaining: int
    retry_after_ms: float


class RateLimiter:
    def __init__(self, store: Any, max: int, window_ms: float = 3_600_000, key: str = "lodestone:rl",
                 on_store_error: str = "allow", now: Callable[[], float] = time.time) -> None:
        self._store, self._max, self._window, self._prefix, self._on_error, self._now = store, max, window_ms, key, on_store_error, now
        self._lock = asyncio.Lock()

    async def take(self, caller: str) -> RateLimitResult:
        who = hashlib.sha256(caller.encode()).hexdigest()[:32]
        t = self._now() * 1000
        start = int(t // self._window) * self._window
        retry = start + self._window - t
        try:
            if hasattr(self._store, "incr_by"):
                n = await self._store.incr_by(f"{self._prefix}:{who}:{int(start)}", 1, self._window * 2)
                return RateLimitResult(n <= self._max, max(0, self._max - n), retry)
            async with self._lock:  # exact inside one process
                key = f"{self._prefix}:{who}"
                saved = await self._store.get(key)
                n = saved["n"] if isinstance(saved, dict) and saved.get("w") == start and isinstance(saved.get("n"), int) and saved["n"] >= 0 else 0
                if n >= self._max:
                    return RateLimitResult(False, 0, retry)
                await self._store.set(key, {"w": start, "n": n + 1}, self._window * 2)
                return RateLimitResult(True, self._max - n - 1, retry)
        except Exception:
            return RateLimitResult(self._on_error != "deny", self._max if self._on_error != "deny" else 0, 0 if self._on_error != "deny" else 60_000)
