import asyncio
import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest import mock

from lodestone import (Discover, Fallback, Health, Lodestone, LodestoneError, MemoryStore, Mock, OpenAICompatible, OpenRouterConfig, ProviderError, ProviderReply,
                       RateLimiter, SpendInfo, SpendLimit, Timing, TrustPolicy, UpstashStore, explain, heal_provider_models, normalize_anthropic, pick_models, read_rate_limit, try_parse_json, vet)

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


class AnthropicAdapter(unittest.IsolatedAsyncioTestCase):
    async def _sent(self, adapter, temperature):
        from lodestone import ProviderRequest
        seen = {}
        def fake_post(url, headers, body, timeout_s):
            seen.update(url=url, headers=headers, body=body)
            return {"content": [{"type": "text", "text": "ok"}], "usage": {"input_tokens": 1, "output_tokens": 1}}
        with mock.patch("lodestone.providers._post", fake_post):
            await adapter.call(ProviderRequest(model="m", messages=[{"role": "user", "content": "x"}], max_tokens=50, api_key="k", temperature=temperature))
        return seen

    async def test_the_temperature_is_left_out_because_current_claude_models_reject_it(self):
        from lodestone import Anthropic
        seen = await self._sent(Anthropic(), 0.2)
        self.assertNotIn("temperature", seen["body"])
        self.assertEqual(seen["body"]["max_tokens"], 50)

    async def test_it_is_sent_only_when_asked_for_an_older_model(self):
        from lodestone import Anthropic
        self.assertEqual((await self._sent(Anthropic(send_temperature=True), 0.2))["body"]["temperature"], 0.2)
        self.assertNotIn("temperature", (await self._sent(Anthropic(send_temperature=True), None))["body"])


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


class Presets(unittest.IsolatedAsyncioTestCase):
    def test_omniakey_names_itself_and_points_at_its_openai_compatible_endpoint(self):
        from lodestone import omniakey
        p = omniakey()
        self.assertEqual((p.name, p._base), ("omniakey", "https://api.omniakey.com/v1"))

    def test_cencori_names_itself_and_points_at_its_openai_compatible_endpoint(self):
        from lodestone import cencori
        p = cencori()
        self.assertEqual((p.name, p._base), ("cencori", "https://api.cencori.com/v1"))

    async def test_a_private_call_skips_cencori_unless_the_app_vouches_for_it(self):
        from lodestone import cencori
        seen = []
        c = cencori()
        async def call(req):
            seen.append(req.model)
            return ProviderReply("ok")
        c.call = call
        down = Mock(lambda req: fail(503))
        ai = make(down, fallbacks=[Fallback(c, "k", ["gpt-4o"])])
        with self.assertRaises(LodestoneError):
            await ai.complete("cv", private=True)
        self.assertEqual(seen, [])
        ai2 = make(down, fallbacks=[Fallback(c, "k", ["gpt-4o"], privacy="no-training")])
        self.assertEqual((await ai2.complete("cv", private=True)).text, "ok")


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


class SpendShares(unittest.IsolatedAsyncioTestCase):
    def info(self, i, **kw):
        return SpendInfo(i, "p", "m", "paid", **kw)

    async def test_a_caller_stops_at_their_share_and_others_carry_on(self):
        spend = SpendLimit(MemoryStore(), daily_usd=1, hold_usd=0.01, per_caller={"daily_usd": 0.03})
        for i in "123":
            self.assertTrue(await spend.allow(self.info(i, caller="ann")))
            await spend.record(self.info(i, caller="ann"), 0.01)
        self.assertFalse(await spend.allow(self.info("4", caller="ann")))
        self.assertEqual(spend.refusal("4"), "caller")
        self.assertIsNone(spend.refusal("4"))
        self.assertTrue(await spend.allow(self.info("5", caller="bob")))
        self.assertAlmostEqual((await spend.report())["today_usd"], 0.03, places=6)

    async def test_the_pool_still_binds_everyone_and_says_so(self):
        spend = SpendLimit(MemoryStore(), daily_usd=0.02, hold_usd=0.01, per_caller={"daily_usd": 1})
        self.assertTrue(await spend.allow(self.info("1", caller="ann")))
        self.assertTrue(await spend.allow(self.info("2", caller="bob")))
        self.assertFalse(await spend.allow(self.info("3", caller="cat")))
        self.assertEqual(spend.refusal("3"), "app")

    async def test_a_person_can_lower_their_share_but_not_raise_it(self):
        low = SpendLimit(MemoryStore(), daily_usd=1, hold_usd=0.01, per_caller={"daily_usd": 0.05})
        self.assertTrue(await low.allow(self.info("a", caller="ann", cap={"daily_usd": 0.01})))
        self.assertFalse(await low.allow(self.info("b", caller="ann", cap={"daily_usd": 0.01})))
        high = SpendLimit(MemoryStore(), daily_usd=1, hold_usd=0.01, per_caller={"daily_usd": 0.01})
        self.assertTrue(await high.allow(self.info("a", caller="bob", cap={"daily_usd": 5})))
        self.assertFalse(await high.allow(self.info("b", caller="bob", cap={"daily_usd": 5})))

    async def test_a_call_without_a_caller_is_held_only_to_the_pool(self):
        spend = SpendLimit(MemoryStore(), daily_usd=1, hold_usd=0.01, per_caller={"daily_usd": 0.01})
        self.assertTrue(all([await spend.allow(self.info(str(i))) for i in range(3)]))

    async def test_the_caller_is_stored_as_a_hash(self):
        keys = []
        class Spy:
            async def get(self, k): return None
            async def set(self, k, v, *a): keys.append(k)
        await SpendLimit(Spy(), per_caller={"daily_usd": 1}).allow(self.info("a", caller="203.0.113.7"))
        self.assertFalse(any("203.0.113.7" in k for k in keys))
        self.assertTrue(any(":caller:" in k for k in keys))

    async def test_a_cap_on_their_own_key_is_kept_apart_from_the_pool(self):
        spend = SpendLimit(MemoryStore(), daily_usd=1, hold_usd=0.01)
        own = lambda i: self.info(i, caller="ann", own_key=True, cap={"daily_usd": 0.02})
        for i in "12":
            self.assertTrue(await spend.allow(own(i)))
            await spend.record(own(i), 0.01)
        self.assertFalse(await spend.allow(own("3")))
        self.assertEqual(spend.refusal("3"), "own-key")
        self.assertEqual((await spend.report())["today_usd"], 0)
        self.assertAlmostEqual((await spend.caller_report("ann", own_key=True, cap={"daily_usd": 0.02}))["today_usd"], 0.02, places=6)

    def paid(self, spend):
        p = Mock(lambda req: ProviderReply("ok", 1, 1, 0.01) if req.model.startswith("paid") else fail(503))
        return make(p, spend=spend, openrouter=OpenRouterConfig(api_key="platform", models=MODELS, provider=p, allow_paid=True, paid_models=["paid-1"]))

    async def test_through_the_client_a_caller_over_their_share_gets_a_budget_error_naming_it(self):
        ai = self.paid(SpendLimit(MemoryStore(), daily_usd=10, hold_usd=0.01, per_caller={"daily_usd": 0.02}))
        await ai.complete("x", caller="ann"); await ai.complete("x", caller="ann")
        with self.assertRaises(LodestoneError) as cm:
            await ai.complete("x", caller="ann")
        self.assertEqual((cm.exception.kind, cm.exception.detail["scope"]), ("budget", "caller"))
        self.assertIn("used your share of Acme", explain(cm.exception, product="Acme"))
        self.assertEqual((await ai.complete("x", caller="bob")).text, "ok")

    async def test_through_the_client_their_own_key_is_uncounted_unless_they_set_a_cap(self):
        spend = SpendLimit(MemoryStore(), daily_usd=0.01, hold_usd=0.01, per_caller={"daily_usd": 0.01})
        ai = self.paid(spend)
        for _ in range(3):
            self.assertEqual((await ai.complete("x", caller="ann", api_key="theirs")).text, "ok")
        self.assertEqual((await spend.report())["today_usd"], 0)
        spend2 = SpendLimit(MemoryStore(), daily_usd=10, hold_usd=0.01)
        ai2 = self.paid(spend2)
        call = lambda: ai2.complete("x", caller="ann", api_key="theirs", spend_cap={"daily_usd": 0.02})
        await call(); await call()
        with self.assertRaises(LodestoneError) as cm:
            await call()
        self.assertEqual(cm.exception.detail["scope"], "own-key")
        self.assertEqual((await spend2.report())["today_usd"], 0)

    async def test_a_cap_it_cannot_keep_is_refused_not_ignored(self):
        ai = self.paid(SpendLimit(MemoryStore(), daily_usd=1))
        with self.assertRaisesRegex(TypeError, "needs a caller"):
            await ai.complete("x", spend_cap={"daily_usd": 1})
        with self.assertRaisesRegex(TypeError, "zero or more"):
            await ai.complete("x", caller="a", spend_cap={"daily_usd": -1})
        with self.assertRaisesRegex(TypeError, "SpendLimit"):
            await make(Mock("ok")).complete("x", caller="a", spend_cap={"daily_usd": 1})

def claude(mid, line, created, **kw):
    return {"id": mid, "publisher": "anthropic", "line": line, "created_at": created, "lifecycle": "active",
            "architecture": {"input_modalities": ["text", "image"], "output_modalities": ["text"]}, **kw}


NOW_MS = 1793707200000.0  # 2026-11-03T12:00:00Z
CLAUDES = [
    claude("claude-sonnet-4-20250514", "sonnet", "2025-05-14T00:00:00Z", lifecycle="retired"),
    claude("claude-sonnet-4-5-20250929", "sonnet", "2025-09-29T00:00:00Z", lifecycle="deprecated", expiration_date="2026-11-30T00:00:00Z"),
    claude("claude-sonnet-5-5", "sonnet", "2026-09-21T00:00:00Z"),
    claude("claude-sonnet-5-4", "sonnet", "2026-06-01T00:00:00Z"),
    claude("claude-opus-5-5", "opus", "2026-09-21T00:00:00Z"),
]


class AnthropicHealing(unittest.IsolatedAsyncioTestCase):
    def test_a_row_becomes_a_catalogue_entry(self):
        row = {"id": "claude-sonnet-5-5", "lifecycle": "deprecated", "line": "sonnet", "created_at": "2026-09-21T00:00:00Z", "retires_at": "2026-11-30T00:00:00Z",
               "max_input_tokens": 1000000, "capabilities": {"image_input": {"supported": True}}}
        self.assertEqual(normalize_anthropic(row), {"id": "claude-sonnet-5-5", "publisher": "anthropic", "context_length": 1000000, "lifecycle": "deprecated", "line": "sonnet",
                                                    "created_at": "2026-09-21T00:00:00Z", "expiration_date": "2026-11-30T00:00:00Z",
                                                    "architecture": {"input_modalities": ["text", "image"], "output_modalities": ["text"]}})
        self.assertNotIn("expiration_date", normalize_anthropic({**row, "lifecycle": "retired"}))
        self.assertIsNone(normalize_anthropic({"nope": 1}))

    def test_a_retired_model_is_dropped_and_by_default_not_replaced(self):
        h = heal_provider_models(["claude-sonnet-4-20250514", "claude-opus-5-5"], CLAUDES, now_ms=NOW_MS)
        self.assertEqual((h.models, h.replaced), (["claude-opus-5-5"], []))

    def test_with_replace_retired_the_newest_model_of_the_same_line_takes_its_place_and_is_reported(self):
        h = heal_provider_models(["claude-sonnet-4-20250514"], CLAUDES, replace_retired=True, now_ms=NOW_MS)
        self.assertEqual(h.models, ["claude-sonnet-5-5"])
        self.assertEqual(h.replaced, [{"from": "claude-sonnet-4-20250514", "to": "claude-sonnet-5-5", "reason": "retired"}])

    def test_it_never_crosses_lines_never_picks_a_deprecated_model_or_one_already_named(self):
        h = heal_provider_models(["claude-sonnet-4-20250514", "claude-sonnet-5-5"], CLAUDES, replace_retired=True, now_ms=NOW_MS)
        self.assertEqual(h.models, ["claude-sonnet-5-4", "claude-sonnet-5-5"])

    def test_a_model_about_to_retire_counts_as_gone(self):
        h = heal_provider_models(["claude-sonnet-4-5-20250929"], CLAUDES, replace_retired=True, now_ms=NOW_MS + 27 * 86_400_000)
        self.assertEqual(h.replaced[0]["reason"], "expiring")

    def test_it_says_so_when_it_cannot_place_a_model(self):
        h = heal_provider_models(["claude-sonnet-3-7"], CLAUDES, replace_retired=True, now_ms=NOW_MS)
        self.assertEqual((h.models, h.unreplaced[0]["note"]), ([], "no longer listed, so its line is unknown"))
        lone = [claude("claude-haiku-3", "haiku", "2024-03-01T00:00:00Z", lifecycle="retired")]
        self.assertEqual(heal_provider_models(["claude-haiku-3"], lone, replace_retired=True, now_ms=NOW_MS).unreplaced[0]["note"], "no current haiku model to take its place")

    def test_for_the_vision_tier_only_a_model_that_reads_images_takes_the_place(self):
        no_img = [{**m, "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]}} if m["id"] == "claude-sonnet-5-5" else m for m in CLAUDES]
        h = heal_provider_models(["claude-sonnet-4-20250514"], no_img, tier="vision", replace_retired=True, now_ms=NOW_MS)
        self.assertEqual(h.models, ["claude-sonnet-5-4"])

    async def _run(self, discover):
        p = Mock("hello")
        p.list_models = lambda key: CLAUDES
        ai = Lodestone(openrouter=OpenRouterConfig(api_key="k", models=MODELS, provider=Mock(lambda r: fail(503))), timing=QUICK, fetch_catalog=lambda: None,
                       fallbacks=[Fallback(provider=p, api_key="a", models=["claude-sonnet-4-20250514"], discover=discover)])
        report = await ai.check_providers()
        try:
            r = await ai.complete("hi")
        except LodestoneError:
            r = None
        return report, r, p

    async def test_end_to_end_a_call_goes_to_the_current_model_and_the_check_reports_the_swap(self):
        report, r, p = await self._run(Discover(replace_retired=True))
        self.assertEqual(report["mock"]["replaced"], [{"from": "claude-sonnet-4-20250514", "to": "claude-sonnet-5-5", "reason": "retired"}])
        self.assertEqual(r.model, "claude-sonnet-5-5")
        self.assertEqual([c.model for c in p.calls], ["claude-sonnet-5-5"])

    async def test_without_it_the_retired_model_is_not_asked_for(self):
        report, r, p = await self._run(None)
        self.assertNotIn("replaced", report["mock"])
        self.assertEqual(p.calls, [])

    def test_list_models_reads_the_live_list_then_the_retired_ones(self):
        import io
        urls = []

        def fake(req, timeout=0):
            urls.append(req.full_url)
            rows = [{"id": "claude-sonnet-4-20250514", "lifecycle": "retired", "line": "sonnet"}] if "lifecycle=retired" in req.full_url else [{"id": "claude-sonnet-5-5", "lifecycle": "active", "line": "sonnet"}]
            return io.BytesIO(json.dumps({"data": rows, "has_more": False}).encode())

        from lodestone import Anthropic
        with mock.patch("urllib.request.urlopen", fake):
            models = Anthropic().list_models("secret")
        self.assertEqual([(m["id"], m["lifecycle"]) for m in models], [("claude-sonnet-5-5", "active"), ("claude-sonnet-4-20250514", "retired")])
        self.assertIn("limit=1000", urls[0])


class NoCreditLeft(unittest.IsolatedAsyncioTestCase):
    async def _run(self, status, body):
        def boom(req):
            raise ProviderError(status, body)
        ai = make(Mock(lambda req: fail(503)), fallbacks=[Fallback(Mock(boom), "g", ["gpt-4o"])])
        with self.assertRaises(LodestoneError) as cm:
            await ai.complete("x")
        return cm.exception

    async def test_a_402_or_a_403_about_credit_is_a_credit_failure(self):
        self.assertEqual((await self._run(402, "payment required")).kind, "credit")
        self.assertEqual((await self._run(403, '{"error":{"code":"credit_balance_exhausted"}}')).kind, "credit")
        self.assertEqual((await self._run(403, '{"error":{"code":"insufficient_user_quota"}}')).kind, "credit")

    async def test_another_403_stays_other_and_the_person_gets_a_credit_sentence(self):
        self.assertEqual((await self._run(403, "only available on agentic harnesses")).kind, "other")
        self.assertIn("no credit", explain(await self._run(403, "Credit balance exhausted")).lower())
