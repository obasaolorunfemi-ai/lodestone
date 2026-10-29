"""Which kind of 429 a provider sent, because they mean different things and need different advice."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional


@dataclass
class RateLimitReading:
    kind: str  # 'daily' | 'minute' | 'upstream' | 'other'
    reset_at: Optional[datetime] = None
    limit: Optional[int] = None


def read_rate_limit(raw_body: str) -> RateLimitReading:
    body: dict = {}
    try:
        parsed = json.loads(raw_body)
        body = parsed if isinstance(parsed, dict) else {}
    except ValueError:
        pass
    error = body.get("error") if isinstance(body.get("error"), dict) else {}
    meta = error.get("metadata") if isinstance(error.get("metadata"), dict) else {}
    headers = meta.get("headers") if isinstance(meta.get("headers"), dict) else {}
    msg = f"{error.get('message', '')} {meta.get('raw', '')} {raw_body[:400]}".lower()

    def num(*names: str) -> Optional[float]:
        for n in names:
            try:
                return float(headers[n])
            except (KeyError, TypeError, ValueError):
                continue
        return None

    reset_ms, limit = num("X-RateLimit-Reset", "x-ratelimit-reset"), num("X-RateLimit-Limit", "x-ratelimit-limit")
    reset_at = datetime.fromtimestamp(reset_ms / 1000, tz=timezone.utc) if reset_ms and reset_ms > 1e12 else None
    lim = int(limit) if limit and limit > 0 else None
    if re.search(r"per-day|per day|free-models-per-day|daily", msg):
        return RateLimitReading("daily", reset_at, lim)
    if re.search(r"per-minute|per minute|requests per minute", msg):
        return RateLimitReading("minute", reset_at, lim)
    if re.search(r"upstream|provider returned error|temporarily rate-limited|provider_name", msg) or meta.get("provider_name"):
        return RateLimitReading("upstream", reset_at, lim)
    return RateLimitReading("other", reset_at, lim)
