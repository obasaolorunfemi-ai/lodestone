"""Turns a failure into a sentence a person can read. Written for the person, not the developer."""
from __future__ import annotations

import math
from typing import Any, Optional

from .errors import LodestoneError


def explain(err: Any, product: str = "the app", settings_hint: Optional[str] = None) -> str:
    generic = "Something went wrong talking to the AI provider. Try again in a moment."
    if not isinstance(err, LodestoneError):
        return generic
    d = err.detail
    own = bool(d.get("own_key"))
    settings = f" {settings_hint}" if settings_hint else ""
    kind = err.kind
    if kind == "slow":
        return "The AI is slow right now and did not answer in time. Try again in a minute."
    if kind == "auth":
        return (f"Your OpenRouter key was rejected. Double-check it{settings}, or remove it to use {product}'s shared AI."
                if own else f"{product}'s AI provider isn't configured correctly right now. This isn't something you can fix. Try again shortly.")
    if kind == "rate_limit":
        r = d.get("rate_limit")
        credit = (" If you add a little credit (even $1) on openrouter.ai, a very low-cost model will be used on your key whenever the free ones are busy."
                  if d.get("needs_credit") and own else "")
        k = r.kind if r else None
        when = f" It resets around {r.reset_at.strftime('%H:%M')} UTC." if r and r.reset_at else ""
        if k == "daily":
            lim = f" ({r.limit} requests)" if r and r.limit else ""
            head = (f"Your OpenRouter account has used its free-model allowance for today{lim}.{when} Adding a little credit on openrouter.ai raises it a lot, or try again tomorrow."
                    if own else f"{product}'s shared AI budget for today is used up. Try again after midnight UTC"
                    + (f", or add your own OpenRouter key{settings}" if settings_hint else "") + ".")
            return head + credit
        if k == "minute":
            return "Too many AI requests in a minute. Wait about a minute and try again." + credit
        if k == "upstream":
            return "The free AI models are busy right now: the provider behind them is limiting requests, not your key. Try again in a minute." + credit
        return ("OpenRouter is limiting requests for your key right now. This is often the free models being busy rather than your own limit, so try again in a minute."
                if own else f"{product}'s shared AI budget is under heavy load right now. Try again shortly"
                + (f", or add your own OpenRouter key{settings} to skip the wait" if settings_hint else "") + ".") + credit
    if kind == "withdrawn":
        return f"The AI models {product} uses just changed on the provider's side. Try again in a few minutes."
    if kind == "unavailable":
        return f"The AI provider is having issues right now, not {product}. Try again in a few minutes."
    if kind == "bad_output":
        return "The AI gave back something that couldn't be read. Try again; it usually works on a second attempt."
    if kind == "credit":
        return "The AI account has no credit for the backup model. Add a little credit and try again."
    if kind == "aborted":
        return "Cancelled."
    if kind == "budget":
        return f"{product}'s AI budget for now is used up, and the free models are busy. Try again later" + (f", or add your own OpenRouter key {settings_hint} to keep going" if settings_hint else "") + "."
    if kind == "throttled":
        mins = max(1, math.ceil((d.get("retry_after_ms") or 60_000) / 60_000))
        return f"You've made a lot of requests in a short time. Try again in {'a minute' if mins == 1 else f'about {mins} minutes'}."
    if kind == "not_configured":
        return f"{product}'s AI isn't set up yet."
    return generic
