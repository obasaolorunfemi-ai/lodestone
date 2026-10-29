"""Where Lodestone keeps what it learns: the model catalogue, which models are failing, saved answers and counters.

A store is any object with ``async get(key)`` and ``async set(key, value, ttl_ms=None)``. One that also has
``async incr_by(key, by, ttl_ms)`` can count atomically, which makes the rate limiter exact across processes."""
from __future__ import annotations

import asyncio
import json
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Optional


class MemoryStore:
    """Lives in memory. The default; lost when the process ends."""

    def __init__(self, now: Callable[[], float] = time.time) -> None:
        self._now = now
        self._data: dict[str, tuple[Any, float]] = {}

    def _live(self, key: str) -> Optional[tuple[Any, float]]:
        e = self._data.get(key)
        if e is None:
            return None
        if e[1] <= self._now():
            del self._data[key]
            return None
        return e

    async def get(self, key: str) -> Any:
        e = self._live(key)
        return None if e is None else e[0]

    async def set(self, key: str, value: Any, ttl_ms: Optional[float] = None) -> None:
        self._data[key] = (value, self._now() + ttl_ms / 1000 if ttl_ms else float("inf"))

    async def incr_by(self, key: str, by: int, ttl_ms: float) -> int:
        e = self._live(key)
        total = (e[0] if e and isinstance(e[0], (int, float)) else 0) + by
        self._data[key] = (total, e[1] if e else self._now() + ttl_ms / 1000)
        return total


class UpstashStore:
    """Upstash Redis (and Vercel KV) over its REST API, with the standard library only."""

    def __init__(self, url: str, token: str, prefix: str = "lodestone:", timeout_s: float = 5.0) -> None:
        if not url.startswith("https://"):
            raise ValueError("UpstashStore: the URL must be https")
        self._url, self._token, self._prefix, self._timeout = url.rstrip("/"), token, prefix, timeout_s

    def _send(self, path: str, body: Any) -> Any:
        req = urllib.request.Request(self._url + path, data=json.dumps(body).encode(), method="POST",
                                     headers={"Authorization": f"Bearer {self._token}", "Content-Type": "application/json", "User-Agent": "lodestone-python/0.1 (+https://lodestone.extrafemi.com)"})
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as r:  # noqa: S310 - https only, checked in __init__
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"upstash: {e.code}") from None  # the body is not included: it can echo a key

    async def get(self, key: str) -> Any:
        raw = (await asyncio.to_thread(self._send, "/", ["GET", self._prefix + key])).get("result")
        try:
            return json.loads(raw) if isinstance(raw, str) else None
        except ValueError:
            return None

    async def set(self, key: str, value: Any, ttl_ms: Optional[float] = None) -> None:
        cmd = ["SET", self._prefix + key, json.dumps(value)] + (["PX", str(int(ttl_ms))] if ttl_ms else [])
        await asyncio.to_thread(self._send, "/", cmd)

    async def incr_by(self, key: str, by: int, ttl_ms: float) -> int:
        k = self._prefix + key
        r = await asyncio.to_thread(self._send, "/pipeline", [["INCRBY", k, by], ["PEXPIRE", k, int(ttl_ms), "NX"]])
        n = r[0].get("result") if r and isinstance(r[0], dict) else None
        if not isinstance(n, int):
            raise RuntimeError("upstash: the counter was refused")
        return n
