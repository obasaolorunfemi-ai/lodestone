"""What may be used, and what may be added by itself. Checks what providers publish in their model lists and what the app decides."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

DEFAULT_PUBLISHERS = ["anthropic", "google", "openai", "meta-llama", "mistralai", "nvidia", "qwen", "deepseek", "microsoft", "cohere", "x-ai", "amazon"]
_ALIASES = {"mistral": "mistralai", "meta": "meta-llama", "xai": "x-ai", "x.ai": "x-ai", "claude": "anthropic", "gemini": "google",
            "gemini-flash": "google", "gemini-pro": "google", "gemma": "google", "gpt": "openai"}


@dataclass
class TrustPolicy:
    publishers: object = None  # list[str] | 'any' | None for the default list
    block: list[str] = field(default_factory=list)
    require_no_training: bool = False
    max_retention_days: Optional[float] = None
    expiring_within_days: float = 7


def publisher_of(model: dict) -> str:
    raw = str(model.get("publisher") or model["id"].split("/")[0]).lower()
    return _ALIASES.get(raw, raw)


def vet(model: dict, policy: Optional[TrustPolicy], discovered: bool, now_ms: float, strict: bool = False) -> Optional[str]:
    """None if the model may be used, otherwise the reason it is refused."""
    from datetime import datetime

    p = policy or TrustPolicy()
    pub = publisher_of(model)
    mid = model["id"]
    for b in p.block:
        if (mid.lower().startswith(b.lower()) or pub == b[:-1].lower()) if b.endswith("/") else mid == b:
            return "blocked"
    exp = model.get("expiration_date")
    if exp:
        try:
            at = datetime.fromisoformat(exp.replace("Z", "+00:00")).timestamp() * 1000
            if at - now_ms < p.expiring_within_days * 86_400_000:
                return "expiring"
        except ValueError:
            pass
    unknown_refused = discovered or strict
    if p.require_no_training:
        if model.get("data_used_for_training") is True:
            return "trains-on-data"
        if model.get("data_used_for_training") is None and unknown_refused:
            return "unknown-data-policy"
    if p.max_retention_days is not None:
        d = model.get("data_retention_days")
        if d is not None and d > p.max_retention_days:
            return "retention"
        if d is None and unknown_refused:
            return "unknown-data-policy"
    if discovered and p.publishers != "any" and pub not in [x.lower() for x in (p.publishers or DEFAULT_PUBLISHERS)]:
        return "untrusted-publisher"
    return None
