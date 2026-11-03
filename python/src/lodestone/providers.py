"""Provider adapters. A provider is any object with ``name``, ``vision`` and ``async call(req)``; these use only the standard library."""
from __future__ import annotations

import asyncio
import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional, Union

from .errors import ProviderError


@dataclass
class ProviderRequest:
    model: str
    messages: list[dict]
    max_tokens: int
    api_key: str
    system: Optional[str] = None
    temperature: Optional[float] = None
    privacy: Optional[str] = None  # 'strict': the prompt must not be kept or used for training
    timeout_s: float = 30.0


@dataclass
class ProviderReply:
    text: str
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: Optional[float] = None


# Python's default User-Agent ("Python-urllib/3.x") is refused (403) by providers behind Cloudflare, such as Groq, so every request names itself.
USER_AGENT = "lodestone-python/0.1 (+https://lodestone.extrafemi.com)"


def _post(url: str, headers: dict, body: dict, timeout_s: float) -> dict:
    if not url.startswith(("https://", "http://localhost", "http://127.0.0.1")):
        raise ProviderError(599, "refusing to send a key over plain http")
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "User-Agent": USER_AGENT, **headers}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as r:  # noqa: S310 - scheme checked above
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode("utf-8", "replace")
        finally:
            e.close()
        raise ProviderError(e.code, body) from None
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise ProviderError(599, str(e)) from None


class OpenAICompatible:
    """Any service that speaks OpenAI's chat API."""

    def __init__(self, name: str, base_url: str, extra_body: Optional[Callable[[str], Optional[dict]]] = None, headers: Optional[dict] = None, vision: bool = False) -> None:
        self.name, self.vision, self._base, self._extra, self._headers = name, vision, base_url.rstrip("/"), extra_body, headers or {}

    def _body(self, req: ProviderRequest) -> dict:
        msgs = [*([{"role": "system", "content": req.system}] if req.system else []), *req.messages]
        body: dict[str, Any] = {"model": req.model, "max_tokens": req.max_tokens, "messages": msgs}
        if req.temperature is not None:
            body["temperature"] = req.temperature
        extra = self._extra(req.model) if self._extra else None
        if extra:
            body["reasoning"] = extra
        return body

    async def call(self, req: ProviderRequest) -> ProviderReply:
        data = await asyncio.to_thread(_post, f"{self._base}/chat/completions", {"Authorization": f"Bearer {req.api_key}", **self._headers}, self._body(req), req.timeout_s + 1)
        text = ((data.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
        u = data.get("usage") or {}
        cost = u.get("cost")
        return ProviderReply(text, u.get("prompt_tokens", 0), u.get("completion_tokens", 0), cost if isinstance(cost, (int, float)) else None)


class OpenRouter(OpenAICompatible):
    def __init__(self, reasoning: Optional[Callable[[str], Optional[dict]]] = None, referer: Optional[str] = None, title: Optional[str] = None) -> None:
        headers = {**({"HTTP-Referer": referer} if referer else {}), **({"X-Title": title} if title else {})}
        super().__init__("openrouter", "https://openrouter.ai/api/v1", reasoning or (lambda _m: {"effort": "low", "exclude": True}), headers, vision=False)

    def _body(self, req: ProviderRequest) -> dict:
        body = super()._body(req)
        body["usage"] = {"include": True}  # asks OpenRouter to report what the call cost
        if req.privacy == "strict":  # only providers that do not keep or train on prompts
            body["provider"] = {"data_collection": "deny"}
        return body


def normalize_anthropic(r: Any) -> Optional[dict]:
    """One row of Anthropic's model list as a catalogue entry. The retirement date becomes ``expiration_date``, so a model about to go is left out like any other."""
    if not isinstance(r, dict) or not isinstance(r.get("id"), str) or not r["id"]:
        return None
    caps = r.get("capabilities") if isinstance(r.get("capabilities"), dict) else {}
    image = isinstance(caps.get("image_input"), dict) and caps["image_input"].get("supported") is True
    lifecycle = r.get("lifecycle") if r.get("lifecycle") in ("active", "deprecated", "retired") else None
    retires = r.get("retires_at") if lifecycle != "retired" and isinstance(r.get("retires_at"), str) and r.get("retires_at") else None
    ctx = r.get("max_input_tokens")
    m: dict[str, Any] = {"id": r["id"], "publisher": "anthropic", "architecture": {"input_modalities": ["text", "image"] if image else ["text"], "output_modalities": ["text"]}}
    if isinstance(ctx, int) and not isinstance(ctx, bool) and ctx > 0:
        m["context_length"] = ctx
    if lifecycle:
        m["lifecycle"] = lifecycle
    if isinstance(r.get("line"), str) and r["line"]:
        m["line"] = r["line"]
    if isinstance(r.get("created_at"), str) and r["created_at"]:
        m["created_at"] = r["created_at"]
    if retires:
        m["expiration_date"] = retires
    return m


def _list_anthropic(query: str, api_key: str) -> Optional[list]:
    """Every page of Anthropic's model list for one query, or None if it cannot be read."""
    rows: list = []
    after = ""
    for _ in range(5):
        req = urllib.request.Request(f"https://api.anthropic.com/v1/models?limit=1000{query}{after}",
                                     headers={"x-api-key": api_key, "anthropic-version": "2023-06-01", "User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:  # noqa: S310 - fixed https URL
                body = json.loads(r.read())
        except (urllib.error.URLError, ValueError):
            return None
        rows.extend(body.get("data") or [])
        if not body.get("has_more") or not body.get("last_id"):
            break
        after = f"&after_id={urllib.parse.quote(str(body['last_id']))}"
    return rows


class Anthropic:
    """Anthropic's own API.

    ``send_temperature`` defaults to False. Anthropic's current models reject a temperature: Claude 4.7 and later answer 400 to a non-default
    one, and API version 2026-10-21 removes the parameter for every model. Lodestone's calls default to 0.2, so it is left out and the model's own
    setting applies. Turn it on only for an older model that still accepts one."""

    name, vision = "anthropic", False

    def __init__(self, send_temperature: bool = False) -> None:
        self.send_temperature = send_temperature

    def list_models(self, api_key: str) -> Optional[list[dict]]:
        """What Anthropic offers now, as catalogue entries (blocking; the catalogue runs it in a thread). The default list holds the active and
        deprecated models, so a retired id is simply missing; a second read asks for the retired ones too, so the line a retired id belonged to is
        known. If that second read fails the first still stands. None if the list cannot be read."""
        live = _list_anthropic("", api_key)
        if live is None:
            return None
        try:
            retired = _list_anthropic("&lifecycle=retired", api_key) or []
        except Exception:
            retired = []
        out: dict[str, dict] = {}
        for row in [*live, *retired]:
            m = normalize_anthropic(row)
            if m and m["id"] not in out:
                out[m["id"]] = m
        return list(out.values()) or None

    async def call(self, req: ProviderRequest) -> ProviderReply:
        body: dict[str, Any] = {"model": req.model, "max_tokens": req.max_tokens, "messages": req.messages}
        if self.send_temperature and req.temperature is not None:
            body["temperature"] = req.temperature
        if req.system:
            body["system"] = req.system
        data = await asyncio.to_thread(_post, "https://api.anthropic.com/v1/messages", {"x-api-key": req.api_key, "anthropic-version": "2023-06-01"}, body, req.timeout_s + 1)
        text = "".join(c.get("text", "") for c in data.get("content", []) if c.get("type") == "text")
        u = data.get("usage") or {}
        return ProviderReply(text, u.get("input_tokens", 0), u.get("output_tokens", 0))


def groq() -> OpenAICompatible:
    return OpenAICompatible("groq", "https://api.groq.com/openai/v1")


def omniakey() -> OpenAICompatible:
    return OpenAICompatible("omniakey", "https://api.omniakey.com/v1")


def cerebras() -> OpenAICompatible:
    return OpenAICompatible("cerebras", "https://api.cerebras.ai/v1")


def requesty(region: Optional[str] = None) -> OpenAICompatible:
    return OpenAICompatible("requesty", "https://router.eu.requesty.ai/v1" if region == "eu" else "https://router.requesty.ai/v1")


def llmapi() -> OpenAICompatible:
    return OpenAICompatible("llmapi", "https://api.llmapi.ai/v1")


def openai() -> OpenAICompatible:
    return OpenAICompatible("openai", "https://api.openai.com/v1")


def mistral() -> OpenAICompatible:
    return OpenAICompatible("mistral", "https://api.mistral.ai/v1")


def ollama(base_url: str = "http://localhost:11434/v1") -> OpenAICompatible:
    return OpenAICompatible("ollama", base_url)


Reply = Union[str, ProviderReply]


class Mock:
    """Answers without any network, for tests and offline development. Pass a function to control the answer, or raise from it to simulate a failure."""

    name, vision = "mock", True

    def __init__(self, reply: Union[str, Callable[[ProviderRequest], Union[Reply, Awaitable[Reply]]]] = "[mock answer]") -> None:
        self._reply = reply
        self.calls: list[ProviderRequest] = []

    async def call(self, req: ProviderRequest) -> ProviderReply:
        self.calls.append(req)
        r = self._reply(req) if callable(self._reply) else self._reply
        if asyncio.iscoroutine(r):
            r = await r
        return r if isinstance(r, ProviderReply) else ProviderReply(str(r))
