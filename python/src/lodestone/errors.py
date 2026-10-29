"""Errors. A ProviderError is one provider saying no; a LodestoneError is every model having said no."""
from __future__ import annotations

from typing import Any, Optional

FAILURE_KINDS = (
    "auth", "rate_limit", "slow", "credit", "withdrawn", "unavailable", "bad_output",
    "aborted", "budget", "throttled", "not_configured", "other",
)


class ProviderError(Exception):
    """A provider answered with an error status (status 599 means the request itself failed).

    The provider's raw response is kept in ``body`` but left out of ``repr``/``str``: some providers
    repeat part of the prompt in an error, and a log line should not carry it."""

    def __init__(self, status: int, body: str = "") -> None:
        super().__init__(f"provider error {status}")
        self.status = status
        self.body = body

    def __repr__(self) -> str:
        return f"ProviderError(status={self.status})"


class LodestoneError(Exception):
    """Raised when no model could answer. ``kind`` says why; ``explain(err)`` has a sentence for a person."""

    def __init__(self, kind: str, **detail: Any) -> None:
        super().__init__(f"no model could answer: {kind}")
        self.kind = kind
        self.detail: dict[str, Any] = detail

    def __repr__(self) -> str:
        return f"LodestoneError(kind={self.kind!r})"


def message_from(body: str) -> Optional[str]:
    """The human-readable message inside a provider's error body, if it has one."""
    import json

    try:
        j = json.loads(body)
        err = j.get("error") if isinstance(j, dict) else None
        m = err if isinstance(err, str) else (err or {}).get("message") if isinstance(err, dict) else None
        m = m or (j.get("message") if isinstance(j, dict) else None)
        return m.strip()[:300] if isinstance(m, str) and m.strip() else None
    except (ValueError, AttributeError):
        return None
