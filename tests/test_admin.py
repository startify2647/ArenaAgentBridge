"""Tests for the web UI - the panel page, its JSON API and the request history.

The panel is the part of the bridge a *human* uses, so it is tested from the
outside: HTML is fetched over HTTP, every endpoint is called the way the browser
calls it, and the browser itself is the scripted fake client from the shared
fixtures.  Nothing here needs Chrome, Firefox or node.
"""

from __future__ import annotations

import asyncio
import json

import pytest
from conftest import ScriptedBrowser, attach_browser, make_settings, plain_answer

from server.config import Settings
from server.history import RequestHistory, detect_client
from server.websocket_manager import BridgeError

# ---------------------------------------------------------------------------
# the page itself
# ---------------------------------------------------------------------------


async def test_panel_page_is_served_everywhere(api):
    _, client = api
    for path in ("/", "/admin", "/admin/", "/ui", "/panel"):
        response = await client.get(path)
        assert response.status_code == 200, path
        assert response.headers["content-type"].startswith("text/html")
        body = response.text
        assert 'id="view-dashboard"' in body, f"{path} did not render the panel"
        assert "window.__AAB_PANEL__" in body, "the panel config is missing"
        assert 'src="/admin/assets/panel.js"' in body
        assert 'href="/admin/assets/panel.css"' in body
    headers = (await client.get("/admin")).headers
    assert headers["x-robots-tag"] == "noindex"
    assert headers["cache-control"] == "no-store"


async def test_panel_page_points_at_nothing_remote(api):
    _, client = api
    body = (await client.get("/admin")).text
    assert "cdn." not in body and "unpkg" not in body and "jsdelivr" not in body
    for attribute in ("script", "link", "img", "iframe"):
        assert f"<{attribute} src=\"http" not in body, f"the panel loads a remote {attribute}"
        assert f"<{attribute} href=\"http" not in body
    csp = (await client.get("/admin")).headers["content-security-policy"]
    assert "default-src 'none'" in csp
    assert "connect-src 'self'" in csp
    assert "frame-ancestors 'self'" in csp


async def test_panel_config_matches_the_server(api):
    app, client = api
    body = (await client.get("/admin")).text
    settings = app.state.settings
    assert f'version: "{settings.version}"' in body
    assert f'modelId: "{settings.model_id}"' in body
    assert f"port: {settings.port}" in body
    assert f"refreshMs: {max(500, settings.panel_refresh_ms)}" in body


async def test_panel_assets_are_served_as_css_and_js(api):
    _, client = api
    css = await client.get("/admin/assets/panel.css")
    js = await client.get("/admin/assets/panel.js")
    assert css.status_code == 200 and css.headers["content-type"].startswith("text/css")
    assert js.status_code == 200 and "javascript" in js.headers["content-type"]
    assert "--bg:" in css.text and "[data-theme='light']" in css.text, "the theme switch is gone"
    # RTL is done with logical properties + a `dir` switch in panel.js
    assert "margin-inline-start" in css.text or "inset-inline-start" in css.text
    assert "documentElement.dir" in js.text, "the panel must switch to RTL for Persian"
    assert "__AAB_PANEL_STRINGS__" in js.text, "panel.js must expose its dictionaries"
    assert "fetch(" in js.text and "/admin/api/" in js.text


async def test_panel_can_be_disabled(api_factory):
    _, client = await api_factory(make_settings(panel_enabled=False))
    assert (await client.get("/admin")).status_code == 404
    assert (await client.get("/admin/api/overview")).status_code == 404
    assert (await client.get("/admin/assets/panel.js")).status_code == 404

    # `/` keeps working: it falls back to the small built-in dashboard
    fallback = await client.get("/")
    assert fallback.status_code == 200
    assert "Browser connection" in fallback.text
    assert "window.__AAB_PANEL__" not in fallback.text


async def test_panel_api_requires_the_api_key_when_configured(api_factory):
    app, client = await api_factory(
        make_settings(require_api_key=True, api_key="sk-secret", panel_enabled=True)
    )
    denied = await client.get("/admin/api/overview")
    assert denied.status_code == 401
    assert denied.json()["error"]["message"] == "invalid api key"
    assert denied.json()["error"]["type"] == "authentication_error"
    assert (await client.get("/admin", headers={})).status_code == 200  # the shell is static

    allowed = await client.get(
        "/admin/api/overview", headers={"Authorization": "Bearer sk-secret"}
    )
    assert allowed.status_code == 200
    assert allowed.json()["version"] == app.state.settings.version

    # the same dependency protects the OpenAI surface
    assert (await client.get("/v1/models")).status_code == 401
    assert (
        await client.get("/v1/models", headers={"Authorization": "Bearer sk-secret"})
    ).status_code == 200


async def test_require_api_key_can_be_toggled_from_the_panel(api):
    app, client = api
    assert (await client.get("/v1/models")).status_code == 200
    response = await client.post("/admin/api/settings", json={"patch": {"require_api_key": True}})
    assert response.json()["applied"]["require_api_key"] is True
    assert app.state.settings.require_api_key is True
    assert (await client.get("/v1/models")).status_code == 401
    assert (
        await client.get("/v1/models", headers={"Authorization": "Bearer sk-arena"})
    ).status_code == 200


# ---------------------------------------------------------------------------
# overview
# ---------------------------------------------------------------------------


async def test_overview_describes_the_whole_bridge(api):
    app, client = api
    body = (await client.get("/admin/api/overview")).json()
    settings = app.state.settings
    assert body["version"] == settings.version
    assert body["browser"]["connected"] is False
    assert body["browser"]["clients"] == []
    assert body["server"]["queue_max"] == settings.queue_max_size
    assert body["server"]["pending"] == []
    assert body["history"]["enabled"] is True
    assert body["sanitizer"]["mode"] == settings.sanitize_mode
    assert body["sanitizer"]["rules"] > 0
    assert body["sanitizer"]["block_rules"] + body["sanitizer"]["warn_rules"] == body["sanitizer"]["rules"]
    assert [model["id"] for model in body["models"]] == settings.model_ids
    assert [model["mode"] for model in body["models"]] == ["agent", "direct"]
    assert body["panel"]["refresh_ms"] == max(500, settings.panel_refresh_ms)
    for key in ("latency_ms", "totals", "recent_errors", "now", "settings"):
        assert key in body
    assert body["settings"]["host"] == settings.host


async def test_overview_shows_the_in_flight_request(api):
    app, client = api
    browser = await ScriptedBrowser(plain_answer("late"), delay=0.6).start(app.state.bridge)
    task = asyncio.create_task(
        client.post(
            "/v1/chat/completions",
            json={"model": "arena-agent", "messages": [{"role": "user", "content": "hold on"}]},
        )
    )
    await asyncio.sleep(0.2)
    pending = (await client.get("/admin/api/overview")).json()["server"]["pending"]
    assert len(pending) == 1
    assert pending[0]["prompt_preview"].startswith("### user")
    assert "hold on" in pending[0]["prompt_preview"]
    assert pending[0]["sent_at"] is not None
    assert pending[0]["timeout"] > 0
    assert pending[0]["running_for_s"] is not None

    assert (await task).status_code == 200
    await browser.stop(app.state.bridge)
    assert (await client.get("/admin/api/overview")).json()["server"]["pending"] == []


# ---------------------------------------------------------------------------
# settings
# ---------------------------------------------------------------------------


async def test_settings_catalog_is_editable_where_it_is_safe(api):
    _, client = api
    body = (await client.get("/admin/api/settings")).json()
    names = {field["name"] for field in body["fields"]}
    for expected in (
        "default_mode",
        "request_timeout",
        "queue_max_size",
        "max_prompt_chars",
        "max_response_chars",
        "sanitize_mode",
        "stream_chunk_chars",
        "stream_chunk_delay_ms",
        "model_id",
        "extra_model_ids",
        "history_size",
        "log_level",
        "require_api_key",
        "api_key",
    ):
        assert expected in names, f"{expected} is not editable from the panel"
    assert {"host", "port", "cors_origin_regex"} <= set(body["readonly"])
    assert body["values"]["api_key"] == "***", "the secret must never leave the server"
    assert body["values"]["api_key_set"] is True
    assert "AAB_REQUEST_TIMEOUT=300" in body["env_block"]
    assert "AAB_SANITIZE_MODE=redact" in body["env_block"]
    for field in body["fields"]:
        assert field["label"] and field["label_fa"], field["name"]
        assert field["help"] and field["help_fa"], field["name"]
        assert field["env"].startswith("AAB_")
    assert body["state"]["queue_max"] >= 1
    assert body["groups"]


async def test_settings_patch_applies_side_effects(api):
    app, client = api
    response = await client.post(
        "/admin/api/settings",
        json={
            "patch": {
                "request_timeout": 42,
                "queue_max_size": 7,
                "history_size": 5,
                "model_id": "custom-model",
                "extra_model_ids": ["a", "b"],
                "sanitize_mode": "detect",
                "stream_chunk_chars": 8,
            }
        },
    )
    body = response.json()
    assert body["ok"] is True
    assert body["rejected"] == {}
    assert body["applied"]["request_timeout"] == 42.0
    assert body["applied"]["sanitize_mode"] == "detect"
    assert body["applied"]["extra_model_ids"] == ["a", "b"]

    settings = app.state.settings
    assert settings.request_timeout == 42.0
    assert settings.sanitize_mode == "detect"
    assert settings.model_ids == ["custom-model", "a", "b"], "the model list was not rebuilt"
    assert app.state.bridge._queue.maxsize == 7, "the live queue was not resized"
    assert app.state.history.maxlen == 5, "the history ring was not resized"
    assert body["state"] == {
        "model_ids": ["custom-model", "a", "b"],
        "queue_max": 7,
        "history_size": 5,
        "log_level": settings.log_level,
        "sanitize_mode": "detect",
    }

    models = (await client.get("/v1/models")).json()
    assert {card["id"] for card in models["data"]} == {"custom-model", "a", "b"}


async def test_settings_patch_rejects_bad_values_without_side_effects(api):
    app, client = api
    body = (
        await client.post(
            "/admin/api/settings",
            json={
                "patch": {
                    "request_timeout": -1,
                    "sanitize_mode": "nope",
                    "nope": 1,
                    "max_prompt_chars": 10**9,
                    "queue_max_size": "many",
                }
            },
        )
    ).json()
    assert body["ok"] is False
    assert body["applied"] == {}, "a rejected patch must not apply anything"
    rejected = body["rejected"]
    assert set(rejected) == {"request_timeout", "sanitize_mode", "nope", "max_prompt_chars", "queue_max_size"}
    assert "must be >=" in rejected["request_timeout"]
    assert "one of" in rejected["sanitize_mode"]
    assert "unknown" in rejected["nope"]
    assert app.state.settings.request_timeout == 300.0
    assert app.state.settings.sanitize_mode == "redact"

    assert (await client.post("/admin/api/settings", content="not json")).status_code == 400
    assert (await client.post("/admin/api/settings", json={"patch": []})).status_code == 400


async def test_settings_accepts_an_empty_patch(api):
    _, client = api
    body = (await client.post("/admin/api/settings", json={"patch": {}})).json()
    assert body == {
        "ok": True,
        "applied": {},
        "rejected": {},
        **{key: body[key] for key in ("values", "state")},
    }


async def test_api_key_can_be_set_but_never_read(api):
    app, client = api
    body = (await client.post("/admin/api/settings", json={"patch": {"api_key": "sk-new"}})).json()
    assert body["applied"]["api_key"] == "***"
    assert app.state.settings.api_key == "sk-new"
    assert "sk-new" not in json.dumps(body)
    # a blank value means "keep the current one" (the panel never sends the old)
    await client.post("/admin/api/settings", json={"patch": {"api_key": ""}})
    assert app.state.settings.api_key == "sk-new"


async def test_settings_reset_restores_the_environment(api):
    app, client = api
    await client.post("/admin/api/settings", json={"patch": {"sanitize_mode": "off", "request_timeout": 11}})
    assert app.state.settings.sanitize_mode == "off"
    body = (await client.post("/admin/api/settings/reset")).json()
    assert body["ok"] is True
    assert body["applied"]["sanitize_mode"] == "redact"
    assert body["applied"]["request_timeout"] == 300.0
    assert app.state.settings.sanitize_mode == "redact"


async def test_env_block_can_be_downloaded(api):
    _, client = api
    response = await client.get("/admin/api/settings/env")
    assert response.status_code == 200
    assert "attachment" in response.headers["content-disposition"]
    assert "arena-agent-bridge.env" in response.headers["content-disposition"]
    assert "AAB_REQUEST_TIMEOUT=300" in response.text
    assert response.text.startswith("# ArenaAgentBridge")


async def test_settings_can_be_toggled_without_a_restart(api):
    app, client = api
    await client.post("/admin/api/settings", json={"patch": {"default_mode": "direct"}})
    browser = await attach_browser(app, plain_answer("hello"))
    response = await client.post(
        "/v1/chat/completions",
        json={"model": "arena-agent", "messages": [{"role": "user", "content": "hi"}]},
    )
    assert response.json()["x_bridge"]["mode"] == "direct"
    await browser.stop(app.state.bridge)


# ---------------------------------------------------------------------------
# history
# ---------------------------------------------------------------------------


async def test_history_records_a_completion(api):
    app, client = api
    browser = await attach_browser(app, plain_answer("# title\n\n run rm -rf / please"))
    response = await client.post(
        "/v1/chat/completions",
        json={"model": "arena-agent", "messages": [{"role": "user", "content": "hello panel"}]},
        headers={"X-Bridge-Source": "panel", "User-Agent": "python-httpx/0.27"},
    )
    request_id = response.json()["id"]
    await browser.stop(app.state.bridge)

    listed = (await client.get("/admin/api/history")).json()
    assert listed["total"] == 1
    assert listed["filtered"] == 1
    assert listed["limit"] == 50 and listed["offset"] == 0
    entry = listed["items"][0]
    assert entry["request_id"] == request_id
    assert entry["source"] == "panel"
    assert entry["client"] == "httpx"
    assert entry["model"] == "arena-agent"
    assert entry["mode"] == "agent"
    assert entry["status"] == "ok"
    assert entry["http_status"] == 200
    assert entry["streamed"] is False
    assert entry["sanitized"] is True
    assert [finding["pattern"] for finding in entry["sanitize_findings"]] == ["rm_rf_root"]
    assert entry["prompt_preview"].startswith("### user")
    assert "hello panel" in entry["prompt_preview"]
    assert entry["prompt_chars"] == len("### user\nhello panel")
    assert entry["built_chars"] > entry["prompt_chars"], "the agent preamble is part of the built prompt"
    assert entry["response_preview"].startswith("# title")
    assert "BLOCKED BY ARENA-AGENT-BRIDGE" in entry["response_preview"]
    assert entry["browser_duration_ms"] == 12
    assert entry["total_ms"] >= 0
    assert entry["age_s"] >= 0 and entry["at_iso"]

    single = (await client.get(f"/admin/api/history/{request_id}")).json()
    assert single["request_id"] == request_id
    assert (await client.get("/admin/api/history/deadbeef")).status_code == 404


async def test_history_records_failures_with_their_code(api):
    _, client = api
    # no browser attached and a 1 s deadline: the request fails
    failed = await client.post(
        "/v1/chat/completions",
        json={
            "model": "arena-agent",
            "timeout": 1,
            "messages": [{"role": "user", "content": "nobody home"}],
        },
    )
    assert failed.status_code == 503
    rejected = await client.post(
        "/v1/chat/completions", json={"model": "arena-agent", "messages": []}
    )
    assert rejected.status_code == 400

    items = (await client.get("/admin/api/history")).json()["items"]
    by_status = {item["status"]: item for item in items}
    assert by_status["error"]["error_code"] == "browser_offline"
    assert by_status["error"]["http_status"] == 503
    assert by_status["error"]["client"] == "httpx"  # the test client's user agent
    assert by_status["rejected"]["error_code"] == "invalid_messages"
    assert by_status["rejected"]["http_status"] == 400


async def test_history_records_streaming(api):
    app, client = api
    browser = await attach_browser(app, plain_answer("streamed answer"))
    response = await client.post(
        "/v1/chat/completions",
        json={"model": "arena-agent", "stream": True, "messages": [{"role": "user", "content": "go"}]},
    )
    assert response.status_code == 200
    await browser.stop(app.state.bridge)

    entry = (await client.get("/admin/api/history")).json()["items"][0]
    assert entry["streamed"] is True
    assert entry["status"] == "ok"
    assert entry["response_preview"] == "streamed answer"
    assert entry["sanitize_mode"] == "redact"


async def test_history_filters_and_clears(api):
    app, client = api
    browser = await attach_browser(app, plain_answer("one"))
    await client.post(
        "/v1/chat/completions",
        json={"model": "arena-agent", "messages": [{"role": "user", "content": "needle here"}]},
    )
    await client.post(
        "/v1/chat/completions",
        json={"model": "arena-agent", "messages": [{"role": "user", "content": "other"}]},
    )
    await browser.stop(app.state.bridge)

    everything = (await client.get("/admin/api/history")).json()
    assert everything["total"] == 2 and everything["filtered"] == 2
    filtered = (await client.get("/admin/api/history?q=needle")).json()
    assert filtered["total"] == 2  # total = the whole ring
    assert filtered["filtered"] == 1  # filtered = what the query matched
    assert len(filtered["items"]) == 1
    assert (await client.get("/admin/api/history?status=error")).json()["filtered"] == 0
    assert (await client.get("/admin/api/history?source=panel")).json()["filtered"] == 0
    assert (await client.get("/admin/api/history?source=api&status=ok")).json()["filtered"] == 2
    assert len((await client.get("/admin/api/history?limit=1")).json()["items"]) == 1
    assert (await client.get("/admin/api/history?limit=0")).status_code == 422

    assert (await client.post("/admin/api/history/clear")).json() == {"ok": True, "removed": 2}
    assert (await client.get("/admin/api/history")).json()["total"] == 0


async def test_history_export_is_registered_before_the_id_route(api):
    app, client = api
    browser = await attach_browser(app, plain_answer("exported"))
    await client.post(
        "/v1/chat/completions",
        json={"model": "arena-agent", "messages": [{"role": "user", "content": "export me"}]},
    )
    await browser.stop(app.state.bridge)

    response = await client.get("/admin/api/history/export")
    assert response.status_code == 200, "the export route was shadowed by /history/{id}"
    assert "arena-agent-bridge-history.json" in response.headers["content-disposition"]
    body = response.json()
    assert body["version"] == app.state.settings.version
    assert len(body["requests"]) == 1
    assert body["requests"][0]["request_id"]
    assert body["summary"]["size"] == 1
    assert body["exported_at"]


def test_history_is_bounded_and_can_be_disabled():
    history = RequestHistory(maxlen=3)
    for index in range(5):
        history.record(request_id=f"r{index}", prompt=f"p{index}", response="x")
    assert history.size == 3
    assert [entry.request_id for entry in history.items()] == ["r4", "r3", "r2"]
    assert history.summary()["size"] == 3

    assert history.resize(1) == 1
    assert [entry.request_id for entry in history.items()] == ["r4"]
    assert history.clear() == 1
    history.resize(0)
    assert history.enabled is False
    assert history.record(request_id="ignored", prompt="y") is None
    assert history.items() == []


@pytest.mark.parametrize(
    "user_agent, expected",
    [
        ("hermes/1.2", "hermes"),
        ("OpenClaw-agent", "openclaw"),
        ("LiteLLM/1.40", "litellm"),
        ("open-webui", "open-webui"),
        ("curl/8.5.0", "curl"),
        ("python-httpx/0.27", "httpx"),
        ("OpenAI/Python 1.30", "openai-python"),
        ("node-fetch/3", "node"),
        ("Mozilla/5.0 (X11; Linux x86_64) Chrome/126", "browser"),
        (None, "unknown"),
        ("", "unknown"),
        ("some-agent/2", "some-agent"),
    ],
)
def test_client_detection(user_agent, expected):
    assert detect_client(user_agent) == expected


# ---------------------------------------------------------------------------
# sanitiser
# ---------------------------------------------------------------------------


async def test_sanitizer_dry_run_in_all_modes(api):
    _, client = api
    payload = {"text": "run rm -rf / now", "mode": "redact"}
    redacted = (await client.post("/admin/api/sanitize", json=payload)).json()
    assert redacted["changed"] is True
    assert "BLOCKED BY ARENA-AGENT-BRIDGE" in redacted["output"]
    assert redacted["replacements"] >= 1
    assert redacted["findings"][0]["pattern"] == "rm_rf_root"
    assert redacted["findings"][0]["severity"] == "block"
    assert redacted["input_chars"] == len(payload["text"])

    detected = (await client.post("/admin/api/sanitize", json={**payload, "mode": "detect"})).json()
    assert detected["changed"] is False
    assert detected["output"] == payload["text"]
    assert detected["findings"][0]["pattern"] == "rm_rf_root"

    untouched = (await client.post("/admin/api/sanitize", json={**payload, "mode": "off"})).json()
    assert untouched["changed"] is False and untouched["findings"] == []

    # the mode defaults to the configured one
    default = (await client.post("/admin/api/sanitize", json={"text": payload["text"]})).json()
    assert default["mode"] == "redact" and default["changed"] is True

    assert (await client.post("/admin/api/sanitize", json={"text": "x", "mode": "nope"})).status_code == 400
    assert (await client.post("/admin/api/sanitize", content="{")).status_code == 400
    assert (
        await client.post("/admin/api/sanitize", json={"text": "x" * 200_001})
    ).status_code == 413


async def test_rules_endpoint_lists_every_rule(api):
    _, client = api
    body = (await client.get("/admin/api/rules")).json()
    assert body["count"] == len(body["rules"]) > 10
    assert body["mode"] in {"off", "detect", "redact"}
    assert body["block"] and body["warn"]
    assert len(body["block"]) + len(body["warn"]) == body["count"]
    assert {rule["name"] for rule in body["rules"]} >= {"rm_rf_root"}
    assert all(rule["pattern"] for rule in body["rules"])
    assert all(rule["severity"] in {"block", "warn"} for rule in body["rules"])


# ---------------------------------------------------------------------------
# browser control
# ---------------------------------------------------------------------------


async def test_browser_endpoints_without_a_browser(api):
    _, client = api
    assert (await client.post("/admin/api/browser/ping")).json() == {
        "ok": False,
        "pinged": 0,
        "connected": False,
    }
    cancel = (await client.post("/admin/api/browser/cancel")).json()
    assert cancel == {"ok": True, "cancelled": 0, "ids": []}
    assert (await client.post("/admin/api/browser/disconnect")).json() == {
        "ok": True,
        "disconnected": 0,
    }
    diagnose = await client.post("/admin/api/browser/diagnose")
    assert diagnose.status_code == 503
    assert diagnose.json() == {
        "ok": False,
        "error": "browser_offline",
        "message": "no extension is connected - load dist/chrome and open https://arena.ai/agent",
    }


async def test_browser_ping_and_diagnose(api):
    app, client = api
    browser = await attach_browser(app, plain_answer("ok"))
    assert (await client.post("/admin/api/browser/ping")).json() == {
        "ok": True,
        "pinged": 1,
        "connected": True,
    }
    body = (await client.post("/admin/api/browser/diagnose")).json()
    assert body["ok"] is True
    assert body["state"] == "idle"
    assert body["busy"] is False
    assert body["diag"]["selectorCounts"]["input"] == 1
    assert body["config"]["serverUrl"].startswith("ws://")
    assert "id" not in body and "type" not in body, "the envelope must be stripped"
    await browser.stop(app.state.bridge)


async def test_diagnose_times_out_on_a_silent_extension(api):
    app, client = api
    browser = await ScriptedBrowser(plain_answer("ok"), diagnostics=False).start(app.state.bridge)
    with pytest.raises(BridgeError) as excinfo:
        await app.state.bridge.request_diagnostics(timeout=0.3)
    assert excinfo.value.code == "diagnostics_timeout"
    assert excinfo.value.status_code == 504
    assert "did not answer" in excinfo.value.message
    await browser.stop(app.state.bridge)


async def test_cancel_fails_the_in_flight_request(api):
    app, client = api
    # the browser will never answer within the test's lifetime
    browser = await ScriptedBrowser(plain_answer("too late"), delay=30.0).start(app.state.bridge)
    task = asyncio.create_task(
        client.post(
            "/v1/chat/completions",
            json={"model": "arena-agent", "messages": [{"role": "user", "content": "wait"}]},
        )
    )
    await asyncio.sleep(0.2)

    cancelled = (await client.post("/admin/api/browser/cancel", json={"reason": "testing"})).json()
    assert cancelled["cancelled"] == 1
    assert len(cancelled["ids"]) == 1

    response = await task
    assert response.status_code == 499
    assert response.json()["error"]["code"] == "cancelled"

    # the extension was told to stop and the client is idle again
    assert any(frame.get("type") == "cancel" for frame in browser.ws.sent)
    overview = (await client.get("/admin/api/overview")).json()
    assert overview["server"]["pending"] == []
    assert overview["browser"]["clients"][0]["busy"] is False
    # the cancelled request is still recorded, with its own status
    entry = (await client.get("/admin/api/history")).json()["items"][0]
    assert entry["status"] == "error"
    assert entry["error_code"] == "cancelled"
    assert entry["http_status"] == 499
    await browser.stop(app.state.bridge)


async def test_disconnect_drops_the_client(api):
    app, client = api
    browser = await ScriptedBrowser(plain_answer("ok")).start(app.state.bridge)
    assert (await client.get("/readyz")).status_code == 200
    body = (await client.post("/admin/api/browser/disconnect")).json()
    assert body == {"ok": True, "disconnected": 1}
    assert (await client.get("/readyz")).status_code == 503
    assert (await client.get("/admin/api/overview")).json()["browser"]["connected"] is False
    assert any(frame.get("type") == "shutdown" for frame in browser.ws.sent)
    assert browser.ws.closed is True and browser.ws.close_code == 4004
    await browser.stop(app.state.bridge)


# ---------------------------------------------------------------------------
# self-check + status
# ---------------------------------------------------------------------------


async def test_selfcheck_flags_the_missing_browser(api):
    _, client = api
    body = (await client.get("/admin/api/selfcheck")).json()
    assert body["ok"] is False
    assert body["version"] == api[0].state.settings.version
    by_id = {check["id"]: check for check in body["checks"]}
    assert set(by_id) == {"browser", "extension-version", "queue", "sanitizer", "history", "auth"}
    assert by_id["browser"]["ok"] is False
    assert by_id["browser"]["level"] == "error"
    assert by_id["browser"]["hint"], "a failing check must say what to do"
    assert by_id["extension-version"]["ok"] is False
    assert by_id["queue"]["ok"] is True
    assert by_id["sanitizer"]["ok"] is True
    assert by_id["history"]["ok"] is True
    assert by_id["auth"]["ok"] is True


async def test_selfcheck_is_green_once_a_matching_extension_is_attached(api):
    app, client = api
    browser = await ScriptedBrowser(plain_answer("ok")).start(app.state.bridge)
    # the fixture connects without a version, so the version check must complain
    body = (await client.get("/admin/api/selfcheck")).json()
    by_id = {check["id"]: check for check in body["checks"]}
    assert by_id["browser"]["ok"] is True
    assert by_id["extension-version"]["ok"] is False
    await browser.stop(app.state.bridge)


async def test_bridge_status_mentions_the_panel_and_keeps_the_secret(api):
    _, client = api
    status = (await client.get("/v1/bridge/status")).json()
    assert status["panel"] == {"enabled": True, "url": "/admin"}
    assert status["history"]["enabled"] is True
    assert "require_api_key" in status["settings"]
    assert "sk-arena" not in json.dumps(status)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


@pytest.fixture
async def api_factory():
    """Build extra apps (with different settings) inside a single test.

    The shared ``api`` fixture covers the default configuration; a few tests
    need a second app (panel disabled, API key required), which would otherwise
    fight over the same bridge.
    """

    from httpx import ASGITransport, AsyncClient

    from server.main import create_app

    stack: list = []

    async def _factory(settings: Settings):
        app = create_app(settings)
        context = app.router.lifespan_context(app)
        await context.__aenter__()
        client = AsyncClient(
            transport=ASGITransport(app=app), base_url="http://bridge.test", timeout=30.0
        )
        stack.append((context, client))
        return app, client

    try:
        yield _factory
    finally:
        for context, client in stack:
            await client.aclose()
            await context.__aexit__(None, None, None)
