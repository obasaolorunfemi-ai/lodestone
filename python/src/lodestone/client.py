"""The core: failover across free models, a low-cost paid model and other providers, inside a time budget."""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional, Union

from .catalog import ROUTER, Catalog, pick_models
from .errors import LodestoneError, ProviderError, message_from
from .health import Health
from .limiter import RateLimiter
from .providers import Anthropic, OpenRouter, ProviderReply, ProviderRequest
from .ratelimit_reading import read_rate_limit
from .spend import SpendInfo, SpendLimit
from .stores import MemoryStore
from .trust import TrustPolicy

DEFAULT_MODELS = {
    "fast": ["google/gemma-4-26b-a4b-it:free", "nvidia/nemotron-3.5-lightning:free", ROUTER],
    "strong": ["nvidia/nemotron-3-ultra-550b-a55b:free", "google/gemma-4-31b-it:free", ROUTER],
}
DEFAULT_PAID_MODELS = ["qwen/qwen3.7-flash", "mistralai/mistral-small-3.2-24b-instruct"]
POOL, ACTIVE = 8, 3


@dataclass
class Fallback:
    """Another provider, with its own key, tried after OpenRouter has failed."""

    provider: Any
    api_key: str
    models: list[str]
    free: bool = False  # costs nothing: not counted against, or stopped by, the spend limit
    allow_with_caller_key: bool = False
    privacy: Optional[str] = None  # 'no-training': your statement that this provider does not keep or train on API prompts


@dataclass
class OpenRouterConfig:
    api_key: Optional[str] = None
    allow_paid: bool = False
    paid_first: bool = False
    models: Optional[dict] = None
    paid_models: Optional[list] = None
    provider: Any = None


@dataclass
class Timing:
    free_slice_ms: float = 11_000
    free_slice_later_ms: float = 5_000
    free_phase_later_ms: float = 9_000
    min_slice_ms: float = 3_000
    paid_slice_ms: float = 12_000


@dataclass
class Profile:
    tier: str = "fast"
    max_tokens: Optional[int] = None
    temperature: Optional[float] = None


@dataclass
class RouteStep:
    provider: str
    model: str
    api_key: str
    timeout_ms: Optional[float] = None


@dataclass
class AttemptEvent:
    provider: str
    model: str
    phase: str  # 'free' | 'paid' | 'fallback' | 'route'
    outcome: str  # 'ok' | 'timeout' | 'failed' | 'skipped'
    status: Optional[int] = None
    ms: float = 0


@dataclass
class Result:
    text: str
    provider: str
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: Optional[float] = None
    cached: bool = False
    data: Any = None


@dataclass
class _Out:
    kind: str  # 'ok' | 'fail' | 'timeout'
    reply: Optional[ProviderReply] = None
    status: int = 0
    body: str = ""
    unusable: bool = False
    message: Optional[str] = None


def try_parse_json(raw: str) -> Any:
    """Strips the ```json fences models like to wrap answers in, then parses. None when it is not valid JSON."""
    cleaned = re.sub(r"```$", "", re.sub(r"^```", "", re.sub(r"^```json", "", raw.strip(), flags=re.I))).strip()
    try:
        return json.loads(cleaned)
    except ValueError:
        return None


def _classify(failure: Optional[_Out], own_key: bool, auth_failed: bool, needs_credit: bool) -> LodestoneError:
    status = failure.status if failure else 0
    kind = ("bad_output" if failure and failure.unusable else "auth" if auth_failed or status == 401 else "rate_limit" if status == 429
            else "withdrawn" if status == 404 else "unavailable" if status >= 500 else "other")
    rl = read_rate_limit(failure.body) if status == 429 and failure else None
    return LodestoneError(kind, status=status, rate_limit=rl, own_key=own_key, needs_credit=needs_credit, provider_message=failure.message if failure else None)


class Lodestone:
    def __init__(self, openrouter: Optional[OpenRouterConfig] = None, fallbacks: Optional[list[Fallback]] = None, trust: Optional[TrustPolicy] = None,
                 health: Optional[Health] = None, spend: Optional[SpendLimit] = None, rate_limit: Optional[RateLimiter] = None, when_over: str = "reject",
                 profiles: Optional[dict[str, Profile]] = None, store: Any = None, budget_ms: float = 24_000, timing: Optional[Timing] = None,
                 providers: Optional[dict] = None, on_attempt: Optional[Callable[[AttemptEvent], None]] = None,
                 fetch_catalog: Optional[Callable[[], Optional[list]]] = None, now_ms: Callable[[], float] = lambda: time.monotonic() * 1000) -> None:
        self.or_cfg = openrouter or OpenRouterConfig()
        self.fallbacks = fallbacks or []
        self.trust, self.health, self.spend, self.rate_limit, self.when_over = trust, health, spend, rate_limit, when_over
        self.profiles = profiles or {}
        self.store = store or MemoryStore()
        self.budget, self.t, self.on_attempt, self.now = budget_ms, timing or Timing(), on_attempt, now_ms
        self.router = self.or_cfg.provider or OpenRouter()
        self.prefs = {**DEFAULT_MODELS, **(self.or_cfg.models or {})}
        self.paid_models = self.or_cfg.paid_models if self.or_cfg.paid_models is not None else DEFAULT_PAID_MODELS
        self.registry = {"openrouter": self.router, "anthropic": Anthropic(), **(providers or {})}
        self.catalog = Catalog(self.store, fetch=fetch_catalog) if fetch_catalog else Catalog(self.store)

    # --- public -----------------------------------------------------------------------------------------------

    async def complete(self, prompt: Optional[str] = None, **opts: Any) -> Result:
        """Asks for an answer. Options: messages, system, task, tier, max_tokens, temperature, api_key (the caller's own OpenRouter key),
        accept (a check an answer must pass), private, caller, cache_key, cache_ttl_s, route."""
        return await _Call(self, prompt, opts).run()

    async def json(self, prompt: Optional[str] = None, *, validate: Optional[Callable[[Any], bool]] = None, **opts: Any) -> Result:
        """Like complete(), but the answer must be JSON, and pass ``validate`` if given. A model whose answer is not is skipped for the next."""
        def parse_ok(text: str) -> bool:
            v = try_parse_json(text)
            return v is not None and (validate is None or bool(validate(v)))

        user_accept = opts.pop("accept", None)
        accept = (lambda s: parse_ok(s) and user_accept(s)) if user_accept else parse_ok
        r = await self.complete(prompt, accept=accept, **opts)
        r.data = try_parse_json(r.text)
        return r

    def complete_sync(self, prompt: Optional[str] = None, **opts: Any) -> Result:
        """For scripts: runs complete() to the end. Not for use inside a running event loop."""
        return asyncio.run(self.complete(prompt, **opts))

    async def refresh_catalog(self) -> Optional[list[dict]]:
        return await self.catalog.refresh()

    async def resolve_models(self, tier: str = "fast") -> list[str]:
        try:
            return pick_models(tier, await self.catalog.load(), self.prefs[tier], self.trust)
        except Exception:
            return self.prefs[tier]


class _Call:
    """One complete() call: its state, so concurrent calls never share any."""

    def __init__(self, ai: Lodestone, prompt: Optional[str], o: dict) -> None:
        self.ai, self.o = ai, o
        self.messages: list[dict] = o.get("messages") or ([{"role": "user", "content": prompt}] if prompt is not None else [])
        if not self.messages:
            raise ValueError("complete() needs a prompt or messages")
        task = o.get("task")
        self.profile = ai.profiles.get(task) if task else None
        if task and not self.profile:
            raise ValueError(f'Unknown task "{task}"')
        self.tier = o.get("tier") or (self.profile.tier if self.profile else "fast")
        self.max_tokens = o.get("max_tokens") or (self.profile.max_tokens if self.profile else None) or 3500
        t = o.get("temperature")
        self.temperature = t if t is not None else (self.profile.temperature if self.profile and self.profile.temperature is not None else (None if o.get("route") else 0.2))
        self.strict = bool(o.get("private"))
        self.accept = o.get("accept")
        self.caller_key = bool(o.get("api_key"))
        self.attempted = False
        self.last: Optional[_Out] = None
        self.rate_limited: Optional[_Out] = None
        self.auth_failed = self.needs_credit = self.spend_blocked = False
        self.throttled: Optional[float] = None
        self.held: Optional[SpendInfo] = None
        self.started = 0.0

    def left(self) -> float:
        return self.ai.budget - (self.ai.now() - self.started)

    def _emit(self, provider: Any, model: str, phase: str, outcome: str, status: Optional[int] = None, ms: float = 0) -> None:
        if self.ai.on_attempt:
            self.ai.on_attempt(AttemptEvent(provider.name, model, phase, outcome, status, ms))

    async def _healthy(self, provider: Any, models: list[str], phase: str) -> list[str]:
        if not self.ai.health:
            return models
        keep = []
        for m in models:
            if await self.ai.health.should_skip(provider.name, m):
                self._emit(provider, m, phase, "skipped")
            else:
                keep.append(m)
        return keep

    async def _may_use(self, provider: Any, model: str, phase: str, free: bool = False) -> bool:
        if self.caller_key or free:
            return True
        if self.throttled is not None:  # a caller over their allowance (free-only) costs the platform nothing
            self._emit(provider, model, phase, "skipped")
            return False
        if not self.ai.spend:
            return True
        info = SpendInfo(str(uuid.uuid4()), provider.name, model, phase)
        if await self.ai.spend.allow(info):
            self.held = info
            return True
        self.spend_blocked = True
        self._emit(provider, model, phase, "skipped")
        return False

    async def _attempt(self, provider: Any, api_key: str, model: str, phase: str, ms: float) -> _Out:
        self.attempted = True
        t0 = self.ai.now()
        req = ProviderRequest(model=model, messages=self.messages, max_tokens=self.max_tokens, api_key=api_key, system=self.o.get("system"),
                              temperature=self.temperature, privacy="strict" if self.strict else None, timeout_s=ms / 1000)
        try:
            reply = await asyncio.wait_for(provider.call(req), timeout=ms / 1000)
            if not reply.text.strip():
                out = _Out("fail", status=502, body="empty answer", unusable=True)
            elif self.accept and not self.accept(reply.text):
                out = _Out("fail", status=422, body="answer failed the check", unusable=True)
            else:
                out = _Out("ok", reply=reply)
        except asyncio.TimeoutError:
            out = _Out("timeout")
        except ProviderError as e:
            out = _Out("fail", status=e.status, body=e.body, message=message_from(e.body))
        except asyncio.CancelledError:
            await self._give_back(provider, model)
            raise
        except Exception as e:  # noqa: BLE001 - any failure of one model is that model's failure
            out = _Out("fail", status=599, body=str(e))
        await self._give_back(provider, model, out)
        ok = out.kind == "ok"
        event = AttemptEvent(provider.name, model, phase, "ok" if ok else "timeout" if out.kind == "timeout" else "failed", out.status if out.kind == "fail" else None, self.ai.now() - t0)
        credential = out.kind == "fail" and out.status in (401, 402, 403)  # says nothing about the model
        if not credential and not self.strict and self.ai.health:
            await self.ai.health.record(provider.name, model, ok)
        if self.ai.on_attempt:
            self.ai.on_attempt(event)
        self.last = out
        return out

    async def _give_back(self, provider: Any, model: str, out: Optional[_Out] = None) -> None:
        h = self.held
        if h and h.provider == provider.name and h.model == model and (out is None or out.kind != "ok"):
            self.held = None
            if self.ai.spend:
                try:
                    await self.ai.spend.release(h)
                except Exception:  # the hold expires by itself
                    pass

    async def _finish(self, provider: Any, model: str, reply: ProviderReply, phase: Optional[str] = None, free: bool = False) -> Result:
        result = Result(reply.text, provider.name, model, reply.input_tokens, reply.output_tokens, reply.cost_usd)
        if phase and not self.caller_key and not free and self.ai.spend:
            h = self.held
            info = h if h and h.provider == provider.name and h.model == model else SpendInfo(str(uuid.uuid4()), provider.name, model, phase)
            self.held = None
            try:  # a ledger that fails must never fail an answer the person is waiting for
                await self.ai.spend.record(info, reply.cost_usd)
            except Exception:
                pass
        if self.cache_slot:
            try:
                await self.ai.store.set(self.cache_slot, {"text": result.text, "provider": result.provider, "model": result.model, "at": time.time(), "fp": self.fp},
                                        self.cache_ttl * 1000)
            except Exception:
                pass
        return result

    async def _fallback_models(self, fb: Fallback) -> list[str]:
        # A private call may only go where something vouches that prompts are not kept or trained on. The Python port does not read provider
        # model lists, so the only voucher is the app's own word.
        return fb.models if (not self.strict or fb.privacy == "no-training") else []

    async def run(self) -> Result:
        ai, o = self.ai, self.o
        cache_key = o.get("cache_key")
        # A private call is never read from or written to the cache: an answer made from a CV must not sit in a shared store.
        self.cache_slot = f"lodestone:cache:{cache_key}" if cache_key and not self.strict else None
        self.cache_ttl = o.get("cache_ttl_s", 86_400)
        self.fp = hashlib.sha256(json.dumps([o.get("system") or "", self.messages, self.tier, o.get("task") or ""], sort_keys=True).encode()).hexdigest() if self.cache_slot else ""
        if self.cache_slot:
            try:
                hit = await ai.store.get(self.cache_slot)
                if (isinstance(hit, dict) and isinstance(hit.get("text"), str) and hit.get("fp") == self.fp and time.time() - hit.get("at", 0) < self.cache_ttl
                        and (not self.accept or self.accept(hit["text"]))):
                    return Result(hit["text"], hit.get("provider", ""), hit.get("model", ""), cached=True)
            except Exception:  # a store that cannot be read is a cache miss
                pass

        caller = o.get("caller")
        if ai.rate_limit and caller and not self.caller_key and not o.get("route"):
            r = await ai.rate_limit.take(caller)
            if not r.ok:
                if ai.when_over == "reject":
                    raise LodestoneError("throttled", retry_after_ms=r.retry_after_ms)
                self.throttled = r.retry_after_ms

        self.started = ai.now()
        route = o.get("route")
        if route:
            return await self._run_route(route)

        or_key = o.get("api_key") or ai.or_cfg.api_key
        paid_allowed = self.caller_key or ai.or_cfg.allow_paid
        fbs = [f for f in ai.fallbacks if f.api_key and (not self.caller_key or f.allow_with_caller_key)]
        paid_available = bool(or_key) and paid_allowed and bool(ai.paid_models)
        later = paid_available or bool(fbs)
        paid_first = bool(ai.or_cfg.paid_first) and not self.caller_key and paid_available
        t = ai.t

        async def run_free() -> Optional[Result]:
            try:
                pool = pick_models(self.tier, await ai.catalog.load(), ai.prefs[self.tier], ai.trust, self.strict, POOL)
            except Exception:
                pool = ai.prefs[self.tier]
            live = await self._healthy(ai.router, pool, "free")
            router_live = ROUTER in live
            models = [*[m for m in live if m != ROUTER][: ACTIVE - (1 if router_live else 0)], *([ROUTER] if router_live else [])]
            if not models and not later and not paid_first:
                models = pool[:ACTIVE]
            free_started = ai.now()
            free_ends = t.free_phase_later_ms if later else ai.budget

            def left_here() -> float:
                if paid_first:
                    return min(self.left(), t.free_phase_later_ms - (ai.now() - free_started)) if fbs else self.left()
                return min(self.left(), free_ends - (ai.now() - self.started))

            for i, m in enumerate(models):
                if left_here() < t.min_slice_ms:
                    break
                slice_ms = left_here() if i >= len(models) - 1 else min(t.free_slice_later_ms if later and not paid_first else t.free_slice_ms, left_here())
                out = await self._attempt(ai.router, or_key, m, "free", slice_ms)
                if out.kind == "ok":
                    return await self._finish(ai.router, m, out.reply)
                if out.kind == "fail":
                    if out.status == 401:
                        self.auth_failed = True
                        break
                    if out.status == 429:
                        self.rate_limited = out
            return None

        async def run_paid() -> Optional[Result]:
            plist = await self._healthy(ai.router, ai.paid_models, "paid") or ai.paid_models
            for m in plist:
                if self.left() < t.min_slice_ms:
                    break
                if not await self._may_use(ai.router, m, "paid"):
                    continue
                ms = min(self.left(), t.paid_slice_ms) if paid_first else self.left()
                out = await self._attempt(ai.router, or_key, m, "paid", ms)
                if out.kind == "ok":
                    return await self._finish(ai.router, m, out.reply, "paid")
                if out.kind == "fail":
                    if out.status == 402:
                        self.needs_credit = True
                        break
                    if out.status == 401:
                        break
            return None

        if or_key:
            if paid_first:
                if (a := await run_paid()):
                    return a
                if not self.auth_failed and (b := await run_free()):
                    return b
            else:
                if (b := await run_free()):
                    return b
                if paid_available and not self.auth_failed and (a := await run_paid()):
                    return a

        for fb in fbs:
            flist = await self._healthy(fb.provider, await self._fallback_models(fb), "fallback")
            for m in flist:
                if self.left() < t.min_slice_ms:
                    break
                if not await self._may_use(fb.provider, m, "fallback", fb.free):
                    continue
                out = await self._attempt(fb.provider, fb.api_key, m, "fallback", self.left())
                if out.kind == "ok":
                    return await self._finish(fb.provider, m, out.reply, "fallback", fb.free)
                if out.kind == "fail" and out.status == 401:
                    break

        if self.throttled is not None:
            raise LodestoneError("throttled", retry_after_ms=self.throttled)
        if self.spend_blocked:
            raise LodestoneError("budget")
        if not self.attempted:
            raise LodestoneError("not_configured")
        if not self.rate_limited and self.last and self.last.kind == "timeout":
            raise LodestoneError("slow")
        raise _classify(self.rate_limited or (self.last if self.last and self.last.kind == "fail" else None), self.caller_key, self.auth_failed, self.needs_credit)

    async def _run_route(self, route: list[RouteStep]) -> Result:
        ai, t = self.ai, self.ai.t
        steps = [s for s in route if s.api_key]
        first_fail: Optional[_Out] = None
        for i, st in enumerate(steps):
            provider = ai.registry.get(st.provider) if isinstance(st.provider, str) else st.provider
            if provider is None:
                raise ValueError(f'Unknown provider "{st.provider}" in route')
            if self.left() <= 0:
                break
            ms = min(self.left(), st.timeout_ms or (self.left() if i == len(steps) - 1 else max(t.min_slice_ms, self.left() * 0.6)))
            out = await self._attempt(provider, st.api_key, st.model, "route", ms)
            if out.kind == "ok":
                return await self._finish(provider, st.model, out.reply)
            if out.kind == "fail" and not first_fail:
                first_fail = out
        if not self.attempted:
            raise LodestoneError("not_configured")
        if not first_fail and self.last and self.last.kind == "timeout":
            raise LodestoneError("slow")
        raise _classify(first_fail or (self.last if self.last and self.last.kind == "fail" else None), self.caller_key, False, False)
