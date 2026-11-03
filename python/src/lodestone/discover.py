"""Keeps a provider's list of models alive from its own catalogue: a model it no longer lists, that is retired or about to be, or that the trust
policy refuses is dropped, and (if asked) one that has gone is swapped for the provider's newest current model of the same line."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

from .trust import TrustPolicy, vet


@dataclass
class Healed:
    models: list[str]
    replaced: list[dict] = field(default_factory=list)  # {'from', 'to', 'reason'}: a named model swapped for the newest current one of its line
    unreplaced: list[dict] = field(default_factory=list)  # {'id', 'reason', 'note'}: a named model that has gone and found no replacement


def _gone(model_id: str, by_id: dict, policy: Optional[TrustPolicy], now_ms: float, strict: bool) -> Optional[str]:
    """Why a named model cannot be used any more ('withdrawn', 'retired', 'expiring'), 'refused' if the trust policy turns it down, else None."""
    m = by_id.get(model_id)
    if m is None:
        return "withdrawn"
    if m.get("lifecycle") == "retired":
        return "retired"
    why = vet(m, policy, False, now_ms, strict)
    return None if why is None else "expiring" if why == "expiring" else "refused"


def _released(m: dict) -> float:
    try:
        return datetime.fromisoformat(str(m.get("created_at")).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def _takes_images(m: dict) -> bool:
    return "image" in ((m.get("architecture") or {}).get("input_modalities") or [])


def heal_provider_models(curated: list[str], catalog: Optional[list[dict]], *, tier: str = "fast", policy: Optional[TrustPolicy] = None, strict: bool = False,
                         replace_retired: bool = False, now_ms: float = 0.0) -> Healed:
    """The list to use, and what was changed in it. A gone model is dropped; with ``replace_retired`` it is swapped for the newest model of the same
    line (never one the app already named, never a deprecated or retired one, only one the trust policy accepts and, for the vision tier, that reads
    images). Nothing is swapped without being reported in ``replaced``."""
    if not catalog:
        return Healed(list(curated))  # nothing known about what exists: use what the app named
    by_id = {m["id"]: m for m in catalog}
    out = Healed([])
    for mid in curated:
        why = _gone(mid, by_id, policy, now_ms, strict)
        if why is None:
            out.models.append(mid)
            continue
        if why == "refused" or not replace_retired:
            continue
        line = (by_id.get(mid) or {}).get("line")
        if not line:
            out.unreplaced.append({"id": mid, "reason": why, "note": "the provider names no line for it" if mid in by_id else "no longer listed, so its line is unknown"})
            continue
        taken = {r["to"] for r in out.replaced}
        options = sorted((m for m in catalog if m.get("line") == line and m.get("lifecycle") in (None, "active") and m["id"] not in curated and m["id"] not in out.models
                          and m["id"] not in taken and (tier != "vision" or _takes_images(m)) and vet(m, policy, True, now_ms, strict) is None),
                         key=lambda m: (-_released(m), m["id"]))
        if not options:
            out.unreplaced.append({"id": mid, "reason": why, "note": f"no current {line} model to take its place"})
            continue
        out.models.append(options[0]["id"])
        out.replaced.append({"from": mid, "to": options[0]["id"], "reason": why})
    return out
