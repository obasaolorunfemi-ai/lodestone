"""Lodestone: reliable AI calls on a shoestring budget. Failover, a time budget, spend limits and plain-language errors; no dependencies."""
from .catalog import ROUTER, pick_models
from .client import (DEFAULT_MODELS, DEFAULT_PAID_MODELS, AttemptEvent, Fallback, Lodestone, OpenRouterConfig, Profile, Result, RouteStep, Timing,
                     try_parse_json)
from .errors import FAILURE_KINDS, LodestoneError, ProviderError
from .explain import explain
from .health import Health
from .limiter import RateLimiter, RateLimitResult
from .providers import (Anthropic, Mock, OpenAICompatible, OpenRouter, ProviderReply, ProviderRequest, cerebras, omniakey, groq, llmapi, mistral, ollama,
                        openai, requesty)
from .ratelimit_reading import RateLimitReading, read_rate_limit
from .spend import SpendInfo, SpendLimit
from .stores import MemoryStore, UpstashStore
from .trust import DEFAULT_PUBLISHERS, TrustPolicy, vet

__version__ = "0.1.0"
create_lodestone = Lodestone

__all__ = [
    "ROUTER", "pick_models", "DEFAULT_MODELS", "DEFAULT_PAID_MODELS", "AttemptEvent", "Fallback", "Lodestone", "create_lodestone", "OpenRouterConfig",
    "Profile", "Result", "RouteStep", "Timing", "try_parse_json", "FAILURE_KINDS", "LodestoneError", "ProviderError", "explain", "Health", "RateLimiter",
    "RateLimitResult", "Anthropic", "Mock", "OpenAICompatible", "OpenRouter", "ProviderReply", "ProviderRequest", "cerebras", "omniakey", "groq", "llmapi", "mistral",
    "ollama", "openai", "requesty", "RateLimitReading", "read_rate_limit", "SpendInfo", "SpendLimit", "MemoryStore", "UpstashStore", "DEFAULT_PUBLISHERS",
    "TrustPolicy", "vet",
]
