"""
Integration tests for the Python SDK against a live Node.js sidecar.

These tests start a real sidecar process (using the mock exchange that ships
with pmxt-core) and exercise the full HTTP path:

    Python SDK -> HTTP -> Node sidecar -> MockExchange -> response

The mock exchange returns deterministic, seeded data so assertions are exact.
No network calls are made beyond localhost.

Run:
    cd sdks/python
    python -m pytest tests/test_sdk_integration.py -v -m integration

These tests are excluded from the default pytest run (see pytest.ini).
"""

import json
import os
import subprocess
import time
import urllib.error
import urllib.request
from typing import Tuple

import pytest

from pmxt.client import (
    Exchange,
    _convert_balance,
    _convert_event,
    _convert_market,
    _convert_order_book,
)
from pmxt.models import (
    Balance,
    MarketList,
    MarketOutcome,
    OrderBook,
    OrderLevel,
    UnifiedEvent,
    UnifiedMarket,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_CORE_DIR = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "core")
)

_SERVER_STARTUP_TIMEOUT_S = 15
_SERVER_POLL_INTERVAL_S = 0.2

# ---------------------------------------------------------------------------
# Server lifecycle helpers
# ---------------------------------------------------------------------------

_NODE_INLINE = r"""
const { createApp } = require('./dist/server/app');
const http = require('http');
const app = createApp({});
const server = http.createServer(app);
server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    process.stdout.write(JSON.stringify({ port }) + '\n');
});
"""


def _node_available() -> bool:
    """Return True if the `node` binary is on PATH."""
    try:
        subprocess.run(
            ["node", "--version"],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return True
    except (FileNotFoundError, subprocess.CalledProcessError):
        return False


def _core_dist_exists() -> bool:
    """Return True if core/dist/server/app.js has been built."""
    return os.path.isfile(os.path.join(_CORE_DIR, "dist", "server", "app.js"))


def _start_test_server() -> Tuple[subprocess.Popen, int]:
    """Start the PMXT sidecar on a random port.

    Returns (process, port).  Raises RuntimeError if the server does not
    start within _SERVER_STARTUP_TIMEOUT_S seconds.
    """
    proc = subprocess.Popen(
        ["node", "-e", _NODE_INLINE],
        cwd=_CORE_DIR,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    deadline = time.monotonic() + _SERVER_STARTUP_TIMEOUT_S
    line = b""
    while time.monotonic() < deadline:
        if proc.stdout is None:
            break
        chunk = proc.stdout.readline()
        if chunk:
            line = chunk.strip()
            break
        time.sleep(_SERVER_POLL_INTERVAL_S)

    if not line:
        proc.kill()
        stderr_out = proc.stderr.read().decode(errors="replace") if proc.stderr else ""
        raise RuntimeError(
            f"Sidecar did not emit port line within {_SERVER_STARTUP_TIMEOUT_S}s. "
            f"stderr: {stderr_out[:500]}"
        )

    try:
        info = json.loads(line)
        port = int(info["port"])
    except (json.JSONDecodeError, KeyError, ValueError) as exc:
        proc.kill()
        raise RuntimeError(f"Malformed port line from sidecar: {line!r}") from exc

    _wait_for_health(port, deadline)
    return proc, port


def _wait_for_health(port: int, deadline: float) -> None:
    """Poll GET /health until 200 or deadline."""
    url = f"http://127.0.0.1:{port}/health"
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as resp:
                if resp.status == 200:
                    return
        except (urllib.error.URLError, OSError):
            pass
        time.sleep(_SERVER_POLL_INTERVAL_S)
    raise RuntimeError(f"Sidecar health check never returned 200 on port {port}")


def _post(port: int, path: str, body: dict) -> dict:
    """POST JSON to the sidecar and return the parsed response body."""
    url = f"http://127.0.0.1:{port}{path}"
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def _get(port: int, path: str) -> dict:
    """GET from the sidecar and return the parsed response body."""
    url = f"http://127.0.0.1:{port}{path}"
    req = urllib.request.Request(
        url,
        headers={"Accept": "application/json"},
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


# ---------------------------------------------------------------------------
# Pytest fixtures
# ---------------------------------------------------------------------------

pytestmark = pytest.mark.integration


@pytest.fixture(scope="module")
def sidecar_port():
    """Module-scoped sidecar.  Skips the module if prerequisites are absent."""
    if not _node_available():
        pytest.skip("node binary not found — skipping integration tests")

    if not _core_dist_exists():
        pytest.skip(
            "core/dist/server/app.js not found. "
            "Run: npm run build --workspace=pmxt-core"
        )

    proc, port = _start_test_server()
    yield port
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


class _MockExchangeClient(Exchange):
    """Minimal concrete Exchange subclass pointing at the mock exchange.

    Disables server auto-start because we manage the sidecar ourselves.
    """

    def __init__(self, base_url: str) -> None:
        super().__init__(
            exchange_name="mock",
            base_url=base_url,
            auto_start_server=False,
        )


@pytest.fixture(scope="module")
def mock_exchange(sidecar_port):
    """Return an Exchange client wired to the in-process mock exchange."""
    base_url = f"http://127.0.0.1:{sidecar_port}"
    return _MockExchangeClient(base_url)


# ---------------------------------------------------------------------------
# Health / smoke
# ---------------------------------------------------------------------------


class TestSidecarHealth:
    def test_health_endpoint_returns_ok(self, sidecar_port):
        result = _get(sidecar_port, "/health")
        assert result["status"] == "ok"
        assert isinstance(result["timestamp"], int)

    def test_health_timestamp_is_recent(self, sidecar_port):
        result = _get(sidecar_port, "/health")
        now_ms = int(time.time() * 1000)
        assert abs(result["timestamp"] - now_ms) < 5000


# ---------------------------------------------------------------------------
# fetchMarkets via raw HTTP + converter
# ---------------------------------------------------------------------------


class TestFetchMarketsRawHttp:
    def test_post_returns_success_envelope(self, sidecar_port):
        resp = _post(
            sidecar_port,
            "/api/mock/fetchMarkets",
            {"args": [{"limit": 3}]},
        )
        assert resp["success"] is True
        assert "data" in resp

    def test_post_limit_is_respected(self, sidecar_port):
        resp = _post(
            sidecar_port,
            "/api/mock/fetchMarkets",
            {"args": [{"limit": 3}]},
        )
        assert len(resp["data"]) == 3

    def test_get_limit_query_param_is_respected(self, sidecar_port):
        resp = _get(sidecar_port, "/api/mock/fetchMarkets?limit=2")
        assert resp["success"] is True
        assert len(resp["data"]) == 2

    def test_raw_market_has_required_keys(self, sidecar_port):
        resp = _post(
            sidecar_port,
            "/api/mock/fetchMarkets",
            {"args": [{"limit": 1}]},
        )
        raw = resp["data"][0]
        for key in ("marketId", "title", "outcomes", "volume24h", "liquidity", "url"):
            assert key in raw, f"Missing key: {key}"

    def test_event_id_is_present_in_raw_response(self, sidecar_port):
        """Regression: eventId was being dropped at earlier pipeline layers."""
        resp = _post(
            sidecar_port,
            "/api/mock/fetchMarkets",
            {"args": [{"limit": 5}]},
        )
        for raw in resp["data"]:
            assert "eventId" in raw, (
                f"eventId missing from market {raw.get('marketId')}"
            )

    def test_outcomes_present_in_raw_response(self, sidecar_port):
        resp = _post(
            sidecar_port,
            "/api/mock/fetchMarkets",
            {"args": [{"limit": 1}]},
        )
        outcomes = resp["data"][0]["outcomes"]
        assert len(outcomes) >= 2
        for o in outcomes:
            assert "outcomeId" in o
            assert "label" in o
            assert "price" in o


# ---------------------------------------------------------------------------
# _convert_market on live sidecar data
# ---------------------------------------------------------------------------


class TestConvertMarketLive:
    def test_convert_produces_unified_market(self, sidecar_port):
        resp = _post(
            sidecar_port,
            "/api/mock/fetchMarkets",
            {"args": [{"limit": 1}]},
        )
        market = _convert_market(resp["data"][0])
        assert isinstance(market, UnifiedMarket)

    def test_market_id_is_string(self, sidecar_port):
        resp = _post(
            sidecar_port,
            "/api/mock/fetchMarkets",
            {"args": [{"limit": 1}]},
        )
        market = _convert_market(resp["data"][0])
        assert isinstance(market.market_id, str)
        assert market.market_id != ""

    def test_title_is_non_empty_string(self, sidecar_port):
        resp = _post(
            sidecar_port,
            "/api/mock/fetchMarkets",
            {"args": [{"limit": 1}]},
        )
        market = _convert_market(resp["data"][0])
        assert isinstance(market.title, str)
        assert len(market.title) > 0

    def test_outcomes_are_market_outcome_instances(self, sidecar_port):
        resp = _post(
            sidecar_port,
            "/api/mock/fetchMarkets",
            {"args": [{"limit": 1}]},
        )
        market = _convert_market(resp["data"][0])
        assert len(market.outcomes) >= 2
        for outcome in market.outcomes:
            assert isinstance(outcome, MarketOutcome)

    def test_outcome_prices_are_in_unit_interval(self, sidecar_port):
        resp = _post(
            sidecar_port,
            "/api/mock/fetchMarkets",
            {"args": [{"limit": 5}]},
        )
        for raw in resp["data"]:
            market = _convert_market(raw)
            for outcome in market.outcomes:
                assert 0.0 <= outcome.price <= 1.0, (
                    f"Outcome price {outcome.price} outside [0, 1]"
                )

    def test_volume_24h_is_non_negative(self, sidecar_port):
        resp = _post(
            sidecar_port,
            "/api/mock/fetchMarkets",
            {"args": [{"limit": 3}]},
        )
        for raw in resp["data"]:
            market = _convert_market(raw)
            assert market.volume_24h >= 0

    def test_liquidity_is_non_negative(self, sidecar_port):
        resp = _post(
            sidecar_port,
            "/api/mock/fetchMarkets",
            {"args": [{"limit": 3}]},
        )
        for raw in resp["data"]:
            market = _convert_market(raw)
            assert market.liquidity >= 0

    def test_event_id_survives_conversion(self, sidecar_port):
        """Regression guard: event_id must not be dropped during conversion."""
        resp = _post(
            sidecar_port,
            "/api/mock/fetchMarkets",
            {"args": [{"limit": 5}]},
        )
        for raw in resp["data"]:
            market = _convert_market(raw)
            assert market.event_id is not None, (
                f"event_id is None after conversion for market {market.market_id}"
            )
            assert isinstance(market.event_id, str)
            assert market.event_id != ""

    def test_source_exchange_is_mock(self, sidecar_port):
        resp = _post(
            sidecar_port,
            "/api/mock/fetchMarkets",
            {"args": [{"limit": 3}]},
        )
        for raw in resp["data"]:
            market = _convert_market(raw)
            assert market.source_exchange == "mock"

    def test_binary_market_has_yes_and_no(self, sidecar_port):
        """The mock exchange sets market.yes / market.no for binary markets."""
        resp = _post(
            sidecar_port,
            "/api/mock/fetchMarkets",
            {"args": [{"limit": 10}]},
        )
        binary_markets = [
            _convert_market(r) for r in resp["data"] if r.get("yes") or r.get("no")
        ]
        assert len(binary_markets) > 0, "Expected at least one binary market in 10"
        for market in binary_markets:
            assert isinstance(market.yes, MarketOutcome)
            assert isinstance(market.no, MarketOutcome)
            assert market.yes.label == "Yes"
            assert market.no.label == "No"

    def test_status_is_active(self, sidecar_port):
        resp = _post(
            sidecar_port,
            "/api/mock/fetchMarkets",
            {"args": [{"limit": 3}]},
        )
        for raw in resp["data"]:
            market = _convert_market(raw)
            assert market.status == "active"

    def test_tick_size_is_0_01(self, sidecar_port):
        resp = _post(
            sidecar_port,
            "/api/mock/fetchMarkets",
            {"args": [{"limit": 3}]},
        )
        for raw in resp["data"]:
            market = _convert_market(raw)
            assert market.tick_size == pytest.approx(0.01)

    def test_market_url_starts_with_https(self, sidecar_port):
        resp = _post(
            sidecar_port,
            "/api/mock/fetchMarkets",
            {"args": [{"limit": 3}]},
        )
        for raw in resp["data"]:
            market = _convert_market(raw)
            assert market.url.startswith("https://")


# ---------------------------------------------------------------------------
# fetchMarkets via Exchange SDK client
# ---------------------------------------------------------------------------


class TestFetchMarketsViaSdk:
    def test_returns_list_of_unified_market(self, mock_exchange):
        markets = mock_exchange.fetch_markets({"limit": 3})
        assert isinstance(markets, list)
        assert len(markets) == 3
        for m in markets:
            assert isinstance(m, UnifiedMarket)

    def test_limit_is_respected(self, mock_exchange):
        markets = mock_exchange.fetch_markets({"limit": 5})
        assert len(markets) == 5

    def test_event_id_present_via_sdk(self, mock_exchange):
        """Full consumer path: event_id must survive SDK fetch + conversion."""
        markets = mock_exchange.fetch_markets({"limit": 5})
        for market in markets:
            assert market.event_id is not None, (
                f"event_id is None on {market.market_id} after SDK fetch"
            )

    def test_outcomes_non_empty(self, mock_exchange):
        markets = mock_exchange.fetch_markets({"limit": 3})
        for market in markets:
            assert len(market.outcomes) >= 2

    def test_market_ids_are_unique(self, mock_exchange):
        markets = mock_exchange.fetch_markets({"limit": 10})
        ids = [m.market_id for m in markets]
        assert len(ids) == len(set(ids))

    def test_deterministic_across_calls(self, mock_exchange):
        """Two identical calls return the same data (seeded rng)."""
        first = mock_exchange.fetch_markets({"limit": 3})
        second = mock_exchange.fetch_markets({"limit": 3})
        assert [m.market_id for m in first] == [m.market_id for m in second]
        assert [m.title for m in first] == [m.title for m in second]


# ---------------------------------------------------------------------------
# fetchEvents via raw HTTP + converter
# ---------------------------------------------------------------------------


class TestFetchEventsRawHttp:
    def test_post_returns_success_envelope(self, sidecar_port):
        resp = _post(
            sidecar_port,
            "/api/mock/fetchEvents",
            {"args": [{"limit": 2}]},
        )
        assert resp["success"] is True
        assert "data" in resp

    def test_limit_is_respected(self, sidecar_port):
        resp = _post(
            sidecar_port,
            "/api/mock/fetchEvents",
            {"args": [{"limit": 2}]},
        )
        assert len(resp["data"]) == 2

    def test_raw_event_has_required_keys(self, sidecar_port):
        resp = _post(
            sidecar_port,
            "/api/mock/fetchEvents",
            {"args": [{"limit": 1}]},
        )
        raw = resp["data"][0]
        for key in ("id", "title", "slug", "markets", "url"):
            assert key in raw, f"Missing key in raw event: {key}"

    def test_nested_markets_have_event_id(self, sidecar_port):
        resp = _post(
            sidecar_port,
            "/api/mock/fetchEvents",
            {"args": [{"limit": 3}]},
        )
        for raw_event in resp["data"]:
            for raw_market in raw_event.get("markets", []):
                assert "eventId" in raw_market, (
                    f"eventId missing from nested market {raw_market.get('marketId')}"
                )


# ---------------------------------------------------------------------------
# _convert_event on live sidecar data
# ---------------------------------------------------------------------------


class TestConvertEventLive:
    def test_convert_produces_unified_event(self, sidecar_port):
        resp = _post(
            sidecar_port,
            "/api/mock/fetchEvents",
            {"args": [{"limit": 1}]},
        )
        event = _convert_event(resp["data"][0])
        assert isinstance(event, UnifiedEvent)

    def test_event_id_is_non_empty_string(self, sidecar_port):
        resp = _post(
            sidecar_port,
            "/api/mock/fetchEvents",
            {"args": [{"limit": 1}]},
        )
        event = _convert_event(resp["data"][0])
        assert isinstance(event.id, str)
        assert len(event.id) > 0

    def test_markets_is_market_list(self, sidecar_port):
        resp = _post(
            sidecar_port,
            "/api/mock/fetchEvents",
            {"args": [{"limit": 1}]},
        )
        event = _convert_event(resp["data"][0])
        assert isinstance(event.markets, MarketList)

    def test_nested_markets_are_unified_market_instances(self, sidecar_port):
        resp = _post(
            sidecar_port,
            "/api/mock/fetchEvents",
            {"args": [{"limit": 3}]},
        )
        for raw_event in resp["data"]:
            event = _convert_event(raw_event)
            for market in event.markets:
                assert isinstance(market, UnifiedMarket)

    def test_nested_market_event_id_survives_conversion(self, sidecar_port):
        """event_id on markets nested inside events must survive both layers."""
        resp = _post(
            sidecar_port,
            "/api/mock/fetchEvents",
            {"args": [{"limit": 3}]},
        )
        for raw_event in resp["data"]:
            event = _convert_event(raw_event)
            for market in event.markets:
                assert market.event_id is not None, (
                    f"event_id None on nested market {market.market_id} "
                    f"inside event {event.id}"
                )
                assert market.event_id == event.id, (
                    f"Nested market.event_id ({market.event_id!r}) "
                    f"does not match parent event.id ({event.id!r})"
                )

    def test_event_volume_24h_equals_sum_of_market_volumes(self, sidecar_port):
        resp = _post(
            sidecar_port,
            "/api/mock/fetchEvents",
            {"args": [{"limit": 2}]},
        )
        for raw_event in resp["data"]:
            event = _convert_event(raw_event)
            if event.volume_24h is not None:
                expected = sum(m.volume_24h for m in event.markets)
                assert event.volume_24h == pytest.approx(expected, rel=1e-4)

    def test_source_exchange_is_mock(self, sidecar_port):
        resp = _post(
            sidecar_port,
            "/api/mock/fetchEvents",
            {"args": [{"limit": 2}]},
        )
        for raw_event in resp["data"]:
            event = _convert_event(raw_event)
            assert event.source_exchange == "mock"


# ---------------------------------------------------------------------------
# fetchEvents via Exchange SDK client
# ---------------------------------------------------------------------------


class TestFetchEventsViaSdk:
    def test_returns_list_of_unified_event(self, mock_exchange):
        events = mock_exchange.fetch_events({"limit": 2})
        assert isinstance(events, list)
        assert len(events) == 2
        for e in events:
            assert isinstance(e, UnifiedEvent)

    def test_nested_markets_event_id_via_sdk(self, mock_exchange):
        """Full SDK consumer path: nested market event_id must not be dropped."""
        events = mock_exchange.fetch_events({"limit": 3})
        for event in events:
            for market in event.markets:
                assert market.event_id is not None, (
                    f"event_id None on nested market {market.market_id} "
                    f"after SDK fetch"
                )

    def test_nested_outcomes_are_market_outcome_instances(self, mock_exchange):
        events = mock_exchange.fetch_events({"limit": 2})
        for event in events:
            for market in event.markets:
                for outcome in market.outcomes:
                    assert isinstance(outcome, MarketOutcome)


# ---------------------------------------------------------------------------
# fetchOrderBook via raw HTTP + converter
# ---------------------------------------------------------------------------


class TestFetchOrderBookRawHttp:
    def _fetch_first_outcome_id(self, sidecar_port: int) -> str:
        resp = _post(
            sidecar_port,
            "/api/mock/fetchMarkets",
            {"args": [{"limit": 1}]},
        )
        return resp["data"][0]["outcomes"][0]["outcomeId"]

    def test_post_returns_success_envelope(self, sidecar_port):
        outcome_id = self._fetch_first_outcome_id(sidecar_port)
        resp = _post(
            sidecar_port,
            "/api/mock/fetchOrderBook",
            {"args": [outcome_id]},
        )
        assert resp["success"] is True

    def test_order_book_has_bids_and_asks(self, sidecar_port):
        outcome_id = self._fetch_first_outcome_id(sidecar_port)
        resp = _post(
            sidecar_port,
            "/api/mock/fetchOrderBook",
            {"args": [outcome_id]},
        )
        raw = resp["data"]
        assert "bids" in raw
        assert "asks" in raw

    def test_order_book_has_8_levels_per_side(self, sidecar_port):
        outcome_id = self._fetch_first_outcome_id(sidecar_port)
        resp = _post(
            sidecar_port,
            "/api/mock/fetchOrderBook",
            {"args": [outcome_id]},
        )
        raw = resp["data"]
        assert len(raw["bids"]) == 8
        assert len(raw["asks"]) == 8

    def test_order_book_timestamp_present(self, sidecar_port):
        outcome_id = self._fetch_first_outcome_id(sidecar_port)
        resp = _post(
            sidecar_port,
            "/api/mock/fetchOrderBook",
            {"args": [outcome_id]},
        )
        raw = resp["data"]
        assert "timestamp" in raw
        assert isinstance(raw["timestamp"], int)
        assert raw["timestamp"] > 0


# ---------------------------------------------------------------------------
# _convert_order_book on live sidecar data
# ---------------------------------------------------------------------------


class TestConvertOrderBookLive:
    def _fetch_raw_order_book(self, sidecar_port: int) -> dict:
        resp = _post(
            sidecar_port,
            "/api/mock/fetchMarkets",
            {"args": [{"limit": 1}]},
        )
        outcome_id = resp["data"][0]["outcomes"][0]["outcomeId"]
        book_resp = _post(
            sidecar_port,
            "/api/mock/fetchOrderBook",
            {"args": [outcome_id]},
        )
        return book_resp["data"]

    def test_convert_produces_order_book(self, sidecar_port):
        raw = self._fetch_raw_order_book(sidecar_port)
        book = _convert_order_book(raw)
        assert isinstance(book, OrderBook)

    def test_bids_are_order_level_instances(self, sidecar_port):
        raw = self._fetch_raw_order_book(sidecar_port)
        book = _convert_order_book(raw)
        for bid in book.bids:
            assert isinstance(bid, OrderLevel)

    def test_asks_are_order_level_instances(self, sidecar_port):
        raw = self._fetch_raw_order_book(sidecar_port)
        book = _convert_order_book(raw)
        for ask in book.asks:
            assert isinstance(ask, OrderLevel)

    def test_bid_prices_in_unit_interval(self, sidecar_port):
        raw = self._fetch_raw_order_book(sidecar_port)
        book = _convert_order_book(raw)
        for bid in book.bids:
            assert 0.0 < bid.price < 1.0
            assert bid.size > 0

    def test_ask_prices_in_unit_interval(self, sidecar_port):
        raw = self._fetch_raw_order_book(sidecar_port)
        book = _convert_order_book(raw)
        for ask in book.asks:
            assert 0.0 < ask.price < 1.0
            assert ask.size > 0

    def test_bids_sorted_descending(self, sidecar_port):
        raw = self._fetch_raw_order_book(sidecar_port)
        book = _convert_order_book(raw)
        prices = [b.price for b in book.bids]
        assert prices == sorted(prices, reverse=True)

    def test_asks_sorted_ascending(self, sidecar_port):
        raw = self._fetch_raw_order_book(sidecar_port)
        book = _convert_order_book(raw)
        prices = [a.price for a in book.asks]
        assert prices == sorted(prices)

    def test_best_bid_lower_than_best_ask(self, sidecar_port):
        raw = self._fetch_raw_order_book(sidecar_port)
        book = _convert_order_book(raw)
        assert book.bids[0].price < book.asks[0].price

    def test_timestamp_preserved(self, sidecar_port):
        raw = self._fetch_raw_order_book(sidecar_port)
        book = _convert_order_book(raw)
        assert isinstance(book.timestamp, int)
        assert book.timestamp > 0


# ---------------------------------------------------------------------------
# fetchOrderBook via Exchange SDK client
# ---------------------------------------------------------------------------


class TestFetchOrderBookViaSdk:
    def test_returns_order_book_instance(self, mock_exchange):
        markets = mock_exchange.fetch_markets({"limit": 1})
        outcome_id = markets[0].outcomes[0].outcome_id
        book = mock_exchange.fetch_order_book(outcome_id)
        assert isinstance(book, OrderBook)

    def test_bids_and_asks_non_empty(self, mock_exchange):
        markets = mock_exchange.fetch_markets({"limit": 1})
        outcome_id = markets[0].outcomes[0].outcome_id
        book = mock_exchange.fetch_order_book(outcome_id)
        assert len(book.bids) > 0
        assert len(book.asks) > 0

    def test_deterministic_order_book(self, mock_exchange):
        """Order books are seeded — two calls for the same outcome return the same levels."""
        markets = mock_exchange.fetch_markets({"limit": 1})
        outcome_id = markets[0].outcomes[0].outcome_id
        book1 = mock_exchange.fetch_order_book(outcome_id)
        book2 = mock_exchange.fetch_order_book(outcome_id)
        assert [b.price for b in book1.bids] == [b.price for b in book2.bids]
        assert [a.price for a in book1.asks] == [a.price for a in book2.asks]


# ---------------------------------------------------------------------------
# fetchBalance via raw HTTP + converter
# ---------------------------------------------------------------------------


class TestFetchBalanceLive:
    def test_post_returns_success_envelope(self, sidecar_port):
        resp = _post(sidecar_port, "/api/mock/fetchBalance", {"args": []})
        assert resp["success"] is True
        assert "data" in resp

    def test_balance_array_non_empty(self, sidecar_port):
        resp = _post(sidecar_port, "/api/mock/fetchBalance", {"args": []})
        assert isinstance(resp["data"], list)
        assert len(resp["data"]) >= 1

    def test_usdc_balance_present(self, sidecar_port):
        resp = _post(sidecar_port, "/api/mock/fetchBalance", {"args": []})
        currencies = [b["currency"] for b in resp["data"]]
        assert "USDC" in currencies

    def test_convert_produces_balance_instances(self, sidecar_port):
        resp = _post(sidecar_port, "/api/mock/fetchBalance", {"args": []})
        balances = [_convert_balance(b) for b in resp["data"]]
        for balance in balances:
            assert isinstance(balance, Balance)

    def test_initial_balance_is_1000_usdc(self, sidecar_port):
        """The mock exchange starts with 1000 USDC by default."""
        resp = _post(sidecar_port, "/api/mock/fetchBalance", {"args": []})
        for raw in resp["data"]:
            balance = _convert_balance(raw)
            if balance.currency == "USDC":
                assert balance.total == pytest.approx(1000.0)
                return
        pytest.fail("USDC balance not found")

    def test_balance_available_equals_total_when_no_orders(self, sidecar_port):
        resp = _post(sidecar_port, "/api/mock/fetchBalance", {"args": []})
        for raw in resp["data"]:
            balance = _convert_balance(raw)
            if balance.currency == "USDC":
                assert balance.available == pytest.approx(balance.total)
                assert balance.locked == pytest.approx(0.0)
                return
        pytest.fail("USDC balance not found")

    def test_balance_fields_are_numeric(self, sidecar_port):
        # The mock exchange returns integer-valued balances when there are no
        # fractional amounts (e.g. 1000, not 1000.0). Python dataclasses do
        # not coerce types at runtime, so we assert numeric rather than float.
        resp = _post(sidecar_port, "/api/mock/fetchBalance", {"args": []})
        for raw in resp["data"]:
            balance = _convert_balance(raw)
            assert isinstance(balance.total, (int, float))
            assert isinstance(balance.available, (int, float))
            assert isinstance(balance.locked, (int, float))


# ---------------------------------------------------------------------------
# fetchBalance via Exchange SDK client
# ---------------------------------------------------------------------------


class TestFetchBalanceViaSdk:
    def test_returns_list_of_balance(self, mock_exchange):
        balances = mock_exchange.fetch_balance()
        assert isinstance(balances, list)
        for b in balances:
            assert isinstance(b, Balance)

    def test_usdc_currency_present(self, mock_exchange):
        balances = mock_exchange.fetch_balance()
        currencies = [b.currency for b in balances]
        assert "USDC" in currencies
