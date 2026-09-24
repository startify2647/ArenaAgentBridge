"""Security fixes from the 1.4.1 review.

* the extension WebSocket checks the ``Origin`` header (a web page must not be
  able to impersonate the extension and read queued prompts / inject answers);
* an optional shared secret (``AAB_WS_TOKEN``) gates the same socket;
* the public status endpoint no longer leaks queued prompt previews;
* a queued/in-flight request can be cancelled by id when its HTTP client
  disconnects (the browser tab must not burn on a dead conversation);
* the queue never blocks the event loop and cannot be shrunk below its depth.
"""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest
from conftest import ScriptedBrowser, attach_browser, make_settings, plain_answer
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from server.main import create_app
from server.sanitizer import sanitize
from server.websocket_manager import BridgeError, BrowserBridge


# ---------------------------------------------------------------------------
# the extension websocket
# ---------------------------------------------------------------------------
@pytest.fixture()
def ws_app():
    """A fresh app + its TestClient (the client owns the websocket upgrade)."""

    settings = make_settings()
    app = create_app(settings)
    with TestClient(app) as client:
        yield client, settings


def test_ws_rejects_foreign_origins(ws_app):
    client, _ = ws_app
    with pytest.raises(WebSocketDisconnect) as excinfo:
        with client.websocket_connect(
            "/ws/browser", headers={"Origin": "https://evil.example"}
        ) as ws:
            ws.receive_json()
    assert excinfo.value.code == 4403


def test_ws_allows_arena_and_originless_clients(ws_app):
    client, _ = ws_app
    # a tab of the site itself ...
    with client.websocket_connect("/ws/browser", headers={"Origin": "https://arena.ai"}) as ws:
        ws.send_json({"type": "hello", "client": "test", "version": "1.5.0"})
        assert ws.receive_json()["type"] == "welcome"
    # ...and non-browser clients that send no Origin (CLI, curl, tests)
    with client.websocket_connect("/ws/browser") as ws:
        ws.send_json({"type": "hello", "client": "cli"})
        assert ws.receive_json()["type"] == "welcome"


def test_ws_token_query_param(ws_app):
    client, settings = ws_app
    settings.ws_token = "sekrit"

    with client.websocket_connect("/ws/browser") as ws:
        ws.send_json({"type": "hello", "client": "test"})
        assert ws.receive_json() == {"type": "error", "error": "bad_token"}
        with pytest.raises(WebSocketDisconnect) as excinfo:
            ws.receive_json()
        assert excinfo.value.code == 4401

    with client.websocket_connect("/ws/browser?token=sekrit") as ws:
        ws.send_json({"type": "hello", "client": "test"})
        assert ws.receive_json()["type"] == "welcome"

    # a wrong token is rejected too
    with client.websocket_connect("/ws/browser?token=wrong") as ws:
        ws.send_json({"type": "hello", "client": "test"})
        assert ws.receive_json() == {"type": "error", "error": "bad_token"}


def test_ws_token_in_hello_frame(ws_app):
    client, settings = ws_app
    settings.ws_token = "sekrit"
    with client.websocket_connect("/ws/browser") as ws:
        ws.send_json({"type": "hello", "client": "test", "token": "sekrit"})
        assert ws.receive_json()["type"] == "welcome"


def test_origin_regex_is_overridable_and_fails_closed():
    settings = make_settings(ws_origin_regex="not-a-regex(")
    settings.validate()
    assert settings.ws_origin_allowed("") is True  # non-browser clients stay in
    assert settings.ws_origin_allowed("https://arena.ai") is False  # closed, not open

    settings = make_settings(ws_origin_regex=r"^https://internal\.example$")
    settings.validate()
    assert settings.ws_origin_allowed("https://internal.example") is True
    assert settings.ws_origin_allowed("https://arena.ai") is False


# ---------------------------------------------------------------------------
# the public status endpoint
# ---------------------------------------------------------------------------
async def test_status_masks_prompt_previews(api):
    app, client = api
    bridge = app.state.bridge

    # A request that sits in the queue (no browser is connected, so nobody
    # answers it) - exactly what the public status would expose.
    task = asyncio.create_task(
        bridge.submit("super secret prompt about the acquisition", "agent", 30.0)
    )
    await asyncio.sleep(0.05)
    try:
        # unauthenticated (default: any key): the prompt must not be in there
        public = (await client.get("/v1/bridge/status")).json()
        assert len(public["server"]["pending"]) == 1
        assert "super secret" not in json.dumps(public)
        assert "masked" in public["server"]["pending"][0]["prompt_preview"]

        # with auth enabled: unauthenticated callers get 401, ...
        settings = app.state.settings
        settings.require_api_key = True
        settings.api_key = "sk-test"
        assert (await client.get("/v1/bridge/status")).status_code == 401

        # ...and the authenticated caller sees the real preview (admin parity)
        private = await client.get(
            "/v1/bridge/status", headers={"Authorization": "Bearer sk-test"}
        )
        assert private.status_code == 200
        preview = private.json()["server"]["pending"][0]["prompt_preview"]
        assert "super secret" in preview
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        app.state.settings.require_api_key = False


# ---------------------------------------------------------------------------
# cancelling a request when its client disconnects
# ---------------------------------------------------------------------------
async def test_cancel_by_id_resolves_the_waiter():
    bridge = BrowserBridge(make_settings())  # worker intentionally not started
    try:
        task = asyncio.create_task(bridge.submit("queued prompt", "agent", 30.0))
        await asyncio.sleep(0.03)
        (pending,) = list(bridge._pending.values())  # noqa: SLF001 - whitebox test
        assert await bridge.cancel_by_id(pending.id, reason="client_disconnected") is True

        with pytest.raises(BridgeError) as excinfo:
            await task
        assert excinfo.value.code == "cancelled"
        assert excinfo.value.status_code == 499
        # cancelling twice is a no-op
        assert await bridge.cancel_by_id(pending.id) is False
        assert await bridge.cancel_by_id("unknown-id") is False
    finally:
        await bridge.stop()


async def test_worker_skips_a_cancelled_queued_request():
    """A request cancelled while queued must never be typed into the page."""

    bridge = BrowserBridge(make_settings(queue_max_size=8))
    browser = None
    try:
        await bridge.start()
        # the blocker occupies the worker (no client yet => it waits)
        blocker = asyncio.create_task(bridge.submit("first", "agent", 30.0))
        await asyncio.sleep(0.05)
        second = asyncio.create_task(bridge.submit("second", "agent", 30.0))
        await asyncio.sleep(0.03)
        blocked, waiting = sorted(
            bridge._pending.values(), key=lambda p: p.enqueued_at  # noqa: SLF001
        )
        assert await bridge.cancel_by_id(waiting.id) is True
        with pytest.raises(BridgeError):
            await second

        # now a browser shows up: exactly ONE request may reach the page
        browser = await ScriptedBrowser(plain_answer("ok")).start(bridge)
        result = await asyncio.wait_for(blocker, 5.0)
        assert result["response"] == "ok"
        assert len(browser.seen) == 1
        assert browser.seen[0]["prompt"].startswith("first")
    finally:
        if browser is not None:
            await browser.stop(bridge)
        await bridge.stop()


async def test_full_chat_flow_survives_the_disconnect_watch(api):
    """The new disconnect watch must not change the happy path."""

    app, client = api
    browser = await attach_browser(app, plain_answer("the watched answer"))
    try:
        response = await client.post(
            "/v1/chat/completions",
            json={"model": "arena-agent", "messages": [{"role": "user", "content": "hi"}]},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["choices"][0]["message"]["content"] == "the watched answer"
    finally:
        await browser.stop(app.state.bridge)


# ---------------------------------------------------------------------------
# queue hygiene
# ---------------------------------------------------------------------------
async def test_set_queue_max_clamps_to_current_depth():
    bridge = BrowserBridge(make_settings(queue_max_size=10))
    try:
        tasks = [
            asyncio.create_task(bridge.submit(f"p{i}", "agent", 30.0)) for i in range(2)
        ]
        await asyncio.sleep(0.05)
        assert bridge.queue_depth() == 2
        # shrinking below the current depth would wedge every put forever
        assert bridge.set_queue_max(1) == 2
        assert bridge.settings.queue_max_size == 2
        assert bridge.set_queue_max(0) == 2
        assert bridge.set_queue_max(50) == 50
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    finally:
        await bridge.stop()


async def test_full_queue_fails_fast_without_blocking():
    """A full queue raises 429 immediately instead of stalling the loop."""

    bridge = BrowserBridge(make_settings(queue_max_size=2))
    try:
        blocked = [
            asyncio.create_task(bridge.submit(f"p{i}", "agent", 30.0)) for i in range(2)
        ]
        await asyncio.sleep(0.05)
        started = asyncio.get_event_loop().time()
        with pytest.raises(BridgeError) as excinfo:
            await bridge.submit("overflow", "agent", 30.0)
        assert excinfo.value.status_code == 429
        assert asyncio.get_event_loop().time() - started < 0.5
        for task in blocked:
            task.cancel()
        await asyncio.gather(*blocked, return_exceptions=True)
    finally:
        await bridge.stop()


# ---------------------------------------------------------------------------
# the OpenAPI docs flag
# ---------------------------------------------------------------------------
async def test_docs_flag_controls_openapi():
    for enabled, want in ((False, 404), (True, 200)):
        app = create_app(make_settings(docs_enabled=enabled))
        async with app.router.lifespan_context(app):
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://t.test") as client:
                assert (await client.get("/docs")).status_code == want
                assert (await client.get("/openapi.json")).status_code == want


# ---------------------------------------------------------------------------
# sanitiser rule corrections
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "text",
    ["crontab -l", "crontab -e", "crontab myjobs.txt", "chmod 777 /tmp/project"],
)
def test_sanitizer_allows_routine_commands(text):
    cleaned, report = sanitize(text, mode="redact")
    assert cleaned == text
    assert not report.findings


@pytest.mark.parametrize(
    "text",
    [
        "chmod 777 /",
        "chmod -R 777 /etc",
        "chmod a+rwx ~",
        "chown -R admin /etc",
        "crontab -r",
        "rm -rf | crontab -",
        "echo evil >> /etc/cron.d/jobs",
    ],
)
def test_sanitizer_blocks_extended_targets(text):
    cleaned, report = sanitize(text, mode="redact")
    assert report.changed
    assert "BLOCKED BY ARENA-AGENT-BRIDGE" in cleaned
    assert report.blocked


def test_sanitizer_warns_on_shell_profile_appends():
    text = "echo 'alias ll=ls -la' >> ~/.bashrc"
    cleaned, report = sanitize(text, mode="redact")
    assert cleaned == text  # warn-level findings are never rewritten
    assert any(
        finding.pattern == "shell_profile_backdoor" and finding.severity == "warn"
        for finding in report.findings
    )


# ---------------------------------------------------------------------------
# the exception handler must not echo server internals
# ---------------------------------------------------------------------------
def test_unhandled_errors_do_not_leak_details():
    app = create_app(make_settings())

    @app.get("/boom", include_in_schema=False)
    async def boom():  # pragma: no cover - only the handler matters
        raise RuntimeError("secret internal detail /var/secret")

    # This Starlette version sends the 500 response and then re-raises the
    # exception (uvicorn just logs it); the test client must not echo it here.
    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.get("/boom")
    assert response.status_code == 500
    body = response.json()
    assert "secret internal detail" not in json.dumps(body)
    assert body["error"]["type"] == "server_error"
