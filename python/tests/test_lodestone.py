import asyncio
import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest import mock

from lodestone import (Fallback, Health, Lodestone, LodestoneError, MemoryStore, Mock, OpenAICompatible, OpenRouterConfig, ProviderError, ProviderReply,
                       RateLimiter, SpendInfo, SpendLimit, Timing, TrustPolicy, UpstashStore, explain, pick_models, read_rate_limit, try_parse_json, vet)

FREE = ["free-a:free", "free-b:free", "openrouter/free"]
MODELS = {"fast": FREE, "strong": FREE}
QUICK = Timing(free_slice_ms=150, free_slice_later_ms=150, free_phase_later_ms=400, min_slice_ms=5, paid_slice_ms=300)


def fail(status):
    raise ProviderError(status, "")


def make(provider, **kw):
    cfg = kw.pop("openrouter", OpenRouterConfig(api_key="k", models=MODELS, provider=provider))
    kw.setdefault("fetch_catalog", lambda: None)  # tests never reach the real OpenRouter
    return Lodestone(openrouter=cfg, timing=kw.pop("timing", QUICK), **kw)


class Failover(unittest.IsolatedAsyncioTestCase):
    async def test_answers_from_the_first_model(self):
        p = Mock("hello")
        r = await make(p).complete("hi")
        self.assertEqual((r.text, r.model), ("hello", "free-a:free"))
        self.assertEqual(len(p.calls), 1)

    async def test_moves_on_when_a_model_fails_or_is_empty(self):
        p = Mock(lambda req: fail(503) if req.model == "free-a:free" else "  " if req.model == "free-b:free" else "third")
        r = await make(p).complete("hi")
        self.assertEqual(r.model, "openrouter/free")
        self.assertEqual([c.model for c in p.calls], FREE)

    async def test_cuts_off_a_model_that_hangs(self):
        async def slow(req):
            if req.model == "free-a:free":
                await asyncio.sleep(5)
            return "ok"
        t0 = time.monotonic()
        r = await make(Mock(slow)).complete("hi")
        self.assertEqual(r.text, "ok")
        self.assertLess(time.monotonic() - t0, 2)

    async def test_stops_at_a_401(self):
        p = Mock(lambda req: fail(401))
        with self.assertRaises(LodestoneError) as c:
            await make(p).complete("hi")
        self.assertEqual(c.exception.kind, "auth")
        self.assertEqual(len(p.calls), 1)

    async def test_json_skips_an_answer_that_is_not_json(self):
        p = Mock(lambda req: "nope" if req.model == "free-a:free" else '```json\n{"n": 1}\n```')
        r = await make(p).json("x", validate=lambda v: isinstance(v, dict) and "n" in v)
        self.assertEqual(r.data, {"n": 1})

    async def test_paid_model_after_the_free_ones_fail(self):
        p = Mock(lambda req: ProviderReply("paid answer", 10, 5, 0.0004) if req.model.startswith("paid") else fail(503))
        r = await make(p, openrouter=OpenRouterConfig(api_key="k", models=MODELS, provider=p, allow_paid=True, paid_models=["paid-1"])).complete("x")
        self.assertEqual((r.model, r.cost_usd), ("paid-1", 0.0004))

    async def test_explains_the_failure(self):
        with self.assertRaises(LodestoneError) as c:
            await make(Mock(lambda req: fail(503))).complete("x")
        self.assertEqual(c.exception.kind, "unavailable")
        self.assertIn("provider is having issues", explain(c.exception))

    async def test_a_daily_limit_is_told_apart(self):
        body = json.dumps({"error": {"message": "Rate limit exceeded: free-models-per-day"}})
        def raise429(req):
            raise ProviderError(429, body)
        with self.assertRaises(LodestoneError) as c:
            await make(Mock(raise429)).complete("x")
        self.assertEqual(c.exception.detail["rate_limit"].kind, "daily")
        self.assertIn("used up", explain(c.exception, product="MyApp"))

    async def test_route_goes_exactly_where_told(self):
        from lodestone import RouteStep
        p = Mock(lambda req: fail(503) if req.model == "a" else "from b")
        ai = Lodestone(providers={"mock": p}, timing=QUICK, fetch_catalog=lambda: None)
        r = await ai.complete("x", route=[RouteStep("mock", "a", "k"), RouteStep("mock", "b", "k")])
        self.assertEqual(r.model, "b")


class Catalogue(unittest.IsolatedAsyncioTestCase):
    async def test_a_withdrawn_model_is_replaced_from_the_live_catalogue(self):
        live = [{"id": "google/gemma-9-27b:free", "context_length": 100000}, {"id": "google/kept:free", "context_length": 100000}]
        p = Mock("ok")
        ai = Lodestone(openrouter=OpenRouterConfig(api_key="k", provider=p, models={"fast": ["google/gone:free", "google/kept:free", "openrouter/free"]}),
                       fetch_catalog=lambda: live, timing=QUICK)
        await ai.refresh_catalog()
        r = await ai.complete("hi")
        self.assertEqual(r.model, "google/kept:free")
        self.assertNotIn("google/gone:free", await ai.resolve_models("fast"))

    async def test_a_catalogue_of_the_wrong_shape_in_the_store_is_ignored(self):
        store = MemoryStore()
        await store.set("lodestone:model-catalog", {"at": time.time(), "models": [{"id": 7}, None, "x"]})
        ai = Lodestone(openrouter=OpenRouterConfig(api_key="k", provider=Mock("ok"), models=MODELS), store=store, fetch_catalog=lambda: None)
        self.assertEqual(await ai.resolve_models("fast"), FREE)


class Private(unittest.IsolatedAsyncioTestCase):
    async def test_never_cached_even_with_a_cache_key(self):
        store, p = MemoryStore(), Mock("answer")
        ai = make(p, store=store)
        await ai.complete("my cv", private=True, cache_key="cv")
        await ai.complete("my cv", private=True, cache_key="cv")
        self.assertEqual(len(p.calls), 2)
        self.assertIsNone(await store.get("lodestone:cache:cv"))

    async def test_a_coarse_cache_key_is_a_miss_not_another_inputs_answer(self):
        p = Mock(lambda req: f"answer to {req.messages[0]['content']}")
        ai = make(p)
        a = await ai.complete("alice cv", cache_key="cv")
        b = await ai.complete("bob cv", cache_key="cv")
        self.assertFalse(b.cached)
        self.assertIn("bob", b.text)
        again = await ai.complete("bob cv", cache_key="cv")
        self.assertTrue(again.cached)
        self.assertNotEqual(a.text, b.text)

    async def test_openrouter_is_told_to_use_only_providers_that_do_not_keep_prompts(self):
        p = Mock("ok")
        await make(p).complete("cv", private=True)
        self.assertEqual(p.calls[0].privacy, "strict")

    async def test_a_fallback_nothing_vouches_for_is_skipped(self):
        down, fb = Mock(lambda req: fail(503)), Mock("fallback")
        ai = make(down, fallbacks=[Fallback(fb, "g", ["m1"])])
        with self.assertRaises(LodestoneError):
            await ai.complete("cv", private=True)
        self.assertEqual(fb.calls, [])
        self.assertEqual((await ai.complete("not private")).text, "fallback")

    async def test_a_fallback_the_app_vouches_for_is_used(self):
        down, fb = Mock(lambda req: fail(503)), Mock("fallback")
        ai = make(down, fallbacks=[Fallback(fb, "g", ["m1"], privacy="no-training")])
        self.assertEqual((await ai.complete("cv", private=True)).text, "fallback")


class Spend(unittest.IsolatedAsyncioTestCase):
    def info(self, i):
        return SpendInfo(i, "p", "m", "paid")

    async def test_a_burst_cannot_overshoot(self):
        spend = SpendLimit(MemoryStore(), daily_usd=0.05, hold_usd=0.01)
        results = await asyncio.gather(*[spend.allow(self.info(f"a{i}")) for i in range(20)])
        self.assertEqual(sum(results), 5)

    async def test_holds_are_settled_or_given_back(self):
        spend = SpendLimit(MemoryStore(), daily_usd=1, hold_usd=0.1)
        await spend.allow(self.info("a")); await spend.allow(self.info("b"))
        await spend.record(self.info("a"), 0.0004)
        await spend.release(self.info("b"))
        r = await spend.report()
        self.assertAlmostEqual(r["today_usd"], 0.0004, places=6)
        self.assertEqual(r["held_usd"], 0)

    async def test_refuses_when_the_ledger_cannot_be_read(self):
        class Broken:
            async def get(self, k): raise RuntimeError("down")
            async def set(self, *a): pass
        self.assertFalse(await SpendLimit(Broken(), daily_usd=1).allow(self.info("a")))

    async def test_a_burst_through_the_client_stays_inside_the_limit(self):
        store = MemoryStore()
        spend = SpendLimit(store, daily_usd=0.03, hold_usd=0.01)
        p = Mock(lambda req: ProviderReply("ok", 1, 1, 0.01) if req.model.startswith("paid") else fail(503))
        ai = make(p, spend=spend, openrouter=OpenRouterConfig(api_key="p", models=MODELS, provider=p, allow_paid=True, paid_first=True, paid_models=["paid-1"]))
        out = await asyncio.gather(*[ai.complete("x") for _ in range(10)], return_exceptions=True)
        self.assertEqual(sum(1 for o in out if not isinstance(o, Exception) and o.model == "paid-1"), 3)
        r = await spend.report()
        self.assertAlmostEqual(r["today_usd"], 0.03, places=6)
        self.assertEqual(r["held_usd"], 0)

    async def test_a_failed_paid_attempt_gives_its_hold_back(self):
        spend = SpendLimit(MemoryStore(), daily_usd=1, hold_usd=0.1)
        p = Mock(lambda req: fail(503))
        ai = make(p, spend=spend, openrouter=OpenRouterConfig(api_key="p", models=MODELS, provider=p, allow_paid=True, paid_models=["paid-1"]))
        with self.assertRaises(LodestoneError):
            await ai.complete("x")
        self.assertEqual((await spend.report())["held_usd"], 0)


class PerCaller(unittest.IsolatedAsyncioTestCase):
    async def test_rejects_a_caller_over_their_allowance(self):
        rl = RateLimiter(MemoryStore(), max=2)
        ai = make(Mock("x"), rate_limit=rl)
        await ai.complete("1", caller="u1"); await ai.complete("2", caller="u1")
        with self.assertRaises(LodestoneError) as c:
            await ai.complete("3", caller="u1")
        self.assertEqual(c.exception.kind, "throttled")
        self.assertIn("lot of requests", explain(c.exception))
        self.assertEqual((await ai.complete("4", caller="u2")).text, "x")

    async def test_does_not_limit_a_call_without_a_caller_or_on_the_callers_own_key(self):
        ai = make(Mock("x"), rate_limit=RateLimiter(MemoryStore(), max=0))
        await ai.complete("a")
        await ai.complete("a", caller="u", api_key="their-own")

    async def test_free_only_never_spends_the_platforms_money(self):
        spent = []
        class Ledger(SpendLimit):
            async def allow(self, info): spent.append(info.model); return True
        p = Mock(lambda req: ProviderReply("paid", 1, 1, 0.01) if req.model.startswith("paid") else fail(503))
        ai = make(p, spend=Ledger(MemoryStore()), rate_limit=RateLimiter(MemoryStore(), max=0), when_over="free-only",
                  openrouter=OpenRouterConfig(api_key="p", models=MODELS, provider=p, allow_paid=True, paid_first=True, paid_models=["paid-1"]))
        with self.assertRaises(LodestoneError) as c:
            await ai.complete("x", caller="abuser")
        self.assertEqual(c.exception.kind, "throttled")
        self.assertEqual(spent, [])
        ok = make(Mock("free answer"), rate_limit=RateLimiter(MemoryStore(), max=0), when_over="free-only")
        self.assertEqual((await ok.complete("x", caller="abuser")).text, "free answer")

    async def test_limiter_counts_exactly_on_a_get_set_store_and_hashes_the_caller(self):
        inner = MemoryStore()
        class Plain:
            keys = []
            async def get(self, k): return await inner.get(k)
            async def set(self, k, v, ttl=None): self.keys.append(k); await inner.set(k, v, ttl)
        plain = Plain()
        rl = RateLimiter(plain, max=5)
        res = await asyncio.gather(*[rl.take("203.0.113.7") for _ in range(20)])
        self.assertEqual(sum(r.ok for r in res), 5)
        self.assertTrue(all("203.0.113.7" not in k for k in plain.keys))


class BreakerAndStores(unittest.IsolatedAsyncioTestCase):
    async def test_the_breaker_shares_what_it_learns_through_a_store(self):
        store = MemoryStore()
        a = Health(store)
        for _ in range(3):
            await a.record("p", "m", False)
        self.assertTrue(await Health(store).should_skip("p", "m"))

    async def test_a_malformed_health_record_is_ignored(self):
        store = MemoryStore()
        await store.set("lodestone:health", {"bad": "nope", "p\x00m": [[time.time(), 0, "x"], "junk", [1, 2, 3]], **{f"k{i}": [[time.time(), 0, "a"]] for i in range(1000)}})
        h = Health(store)
        self.assertFalse(await h.should_skip("p", "m"))

    async def test_the_breaker_skips_a_failing_model_in_a_client(self):
        p = Mock(lambda req: fail(503) if req.model == "free-a:free" else "ok")
        ai = make(p, health=Health())
        for _ in range(3):
            await ai.complete("x")
        p.calls.clear()
        await ai.complete("x")
        self.assertNotIn("free-a:free", [c.model for c in p.calls])

    async def test_upstash_counts_atomically_and_does_not_echo_a_failure_body(self):
        sent = []
        store = UpstashStore("https://x.upstash.io", "tok")
        def fake(path, body):
            sent.append((path, body))
            return [{"result": 1}, {"result": 1}] if path == "/pipeline" else {"result": None}
        with mock.patch.object(store, "_send", fake):
            self.assertEqual(await store.incr_by("c", 1, 1000), 1)
            self.assertIsNone(await store.get("k"))
        self.assertEqual(sent[0][1][0], ["INCRBY", "lodestone:c", 1])
        with self.assertRaises(ValueError):
            UpstashStore("http://insecure.example", "t")

    async def test_memory_store_expires_values(self):
        t = [100.0]
        s = MemoryStore(now=lambda: t[0])
        await s.set("a", 1, 500)
        self.assertEqual(await s.get("a"), 1)
        t[0] += 1
        self.assertIsNone(await s.get("a"))


class Pieces(unittest.TestCase):
    def test_provider_error_leaves_its_body_out_of_repr(self):
        e = ProviderError(400, "echo: my secret prompt")
        self.assertNotIn("secret", repr(e) + str(e))
        self.assertEqual(e.body, "echo: my secret prompt")

    def test_vet(self):
        now = 1_790_000_000_000
        self.assertEqual(vet({"id": "x/y", "data_used_for_training": True}, TrustPolicy(require_no_training=True), False, now), "trains-on-data")
        self.assertEqual(vet({"id": "x/y"}, TrustPolicy(require_no_training=True), True, now), "unknown-data-policy")
        self.assertIsNone(vet({"id": "x/y"}, TrustPolicy(require_no_training=True), False, now))
        self.assertEqual(vet({"id": "shady/m"}, None, True, now), "untrusted-publisher")
        self.assertEqual(vet({"id": "google/m", "expiration_date": "2026-10-31"}, None, False, 1_793_000_000_000 - 2 * 86_400_000), "expiring")
        self.assertEqual(vet({"id": "google/m"}, TrustPolicy(block=["google/"]), False, now), "blocked")

    def test_pick_models_drops_a_withdrawn_model_and_fills_from_the_catalogue(self):
        cat = [{"id": "google/a:free", "context_length": 100000}, {"id": "google/new-27b:free", "context_length": 100000}, {"id": "google/other-7b:free", "context_length": 100000}, {"id": "shady/huge-900b:free", "context_length": 100000}]
        out = pick_models("strong", cat, ["gone:free", "google/a:free", "openrouter/free"])
        self.assertEqual(out[:2], ["google/a:free", "google/new-27b:free"])
        self.assertNotIn("shady/huge-900b:free", out)
        self.assertNotIn("gone:free", out)
        self.assertEqual(out[-1], "openrouter/free")
        self.assertEqual(len(out), 3)

    def test_read_rate_limit(self):
        self.assertEqual(read_rate_limit('{"error":{"message":"x per-minute y"}}').kind, "minute")
        self.assertEqual(read_rate_limit('{"error":{"metadata":{"provider_name":"P"}}}').kind, "upstream")
        self.assertEqual(read_rate_limit("nonsense").kind, "other")

    def test_try_parse_json(self):
        self.assertEqual(try_parse_json('```json\n{"a":1}\n```'), {"a": 1})
        self.assertIsNone(try_parse_json("nope"))

    def test_explain_covers_every_kind(self):
        from lodestone import FAILURE_KINDS
        for k in FAILURE_KINDS:
            self.assertTrue(explain(LodestoneError(k)).endswith((".", "Cancelled.")), k)
        self.assertIn("Cancelled", explain(LodestoneError("aborted")))


class _Handler(BaseHTTPRequestHandler):
    seen = []

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        _Handler.seen.append({"path": self.path, "auth": self.headers["Authorization"], "agent": self.headers["User-Agent"], "body": body})
        if body["model"] == "bad":
            payload, code = json.dumps({"error": {"message": "no credit"}}), 402
        else:
            payload, code = json.dumps({"choices": [{"message": {"content": "hello from the server"}}], "usage": {"prompt_tokens": 7, "completion_tokens": 3, "cost": 0.0002}}), 200
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(payload.encode())

    def log_message(self, *a):
        pass


class Presets(unittest.TestCase):
    def test_omniakey_names_itself_and_points_at_its_openai_compatible_endpoint(self):
        from lodestone import omniakey
        p = omniakey()
        self.assertEqual((p.name, p._base), ("omniakey", "https://api.omniakey.com/v1"))


class RealHttp(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.srv = HTTPServer(("127.0.0.1", 0), _Handler)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.srv.server_port}/v1"
        _Handler.seen.clear()

    def tearDown(self):
        self.srv.shutdown(); self.srv.server_close()

    async def test_openai_compatible_sends_the_request_and_reads_the_reply(self):
        p = OpenAICompatible("local", self.base)
        ai = Lodestone(fallbacks=[Fallback(p, "secret-key", ["good"], free=True)], timing=QUICK, fetch_catalog=lambda: None)
        r = await ai.complete("hi", system="be brief", max_tokens=50)
        self.assertEqual((r.text, r.provider, r.input_tokens, r.cost_usd), ("hello from the server", "local", 7, 0.0002))
        seen = _Handler.seen[0]
        self.assertEqual(seen["path"], "/v1/chat/completions")
        self.assertEqual(seen["auth"], "Bearer secret-key")
        self.assertTrue(seen["agent"].startswith("lodestone-python/"), seen["agent"])  # not Python-urllib, which Cloudflare-fronted providers refuse
        self.assertEqual(seen["body"]["messages"][0], {"role": "system", "content": "be brief"})

    async def test_an_error_status_becomes_a_provider_error_without_the_key(self):
        p = OpenAICompatible("local", self.base)
        from lodestone import ProviderRequest
        with self.assertRaises(ProviderError) as c:
            await p.call(ProviderRequest(model="bad", messages=[{"role": "user", "content": "x"}], max_tokens=5, api_key="secret-key"))
        self.assertEqual(c.exception.status, 402)
        self.assertNotIn("secret-key", repr(c.exception) + str(c.exception))

    async def test_refuses_to_send_a_key_over_plain_http_to_another_host(self):
        from lodestone import ProviderRequest
        with self.assertRaises(ProviderError) as c:
            await OpenAICompatible("x", "http://example.com/v1").call(ProviderRequest(model="m", messages=[], max_tokens=1, api_key="k"))
        self.assertEqual(c.exception.status, 599)


if __name__ == "__main__":
    unittest.main()
