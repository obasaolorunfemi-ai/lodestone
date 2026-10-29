"""Provider adapters. A provider is any object with ``name``, ``vision`` and ``async call(req)``; these use only the standard library."""
from __future__ import annotations

import asyncio
import json
import urllib.error
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


class Anthropic:
    name, vision = "anthropic", False

    async def call(self, req: ProviderRequest) -> ProviderReply:
        body: dict[str, Any] = {"model": req.model, "max_tokens": req.max_tokens, "messages": req.messages}
        if req.temperature is not None:
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
