"""Request-body tolerance: a real OpenAI API never 422s over cosmetic shapes.

Hermes & friends send numbers where the schema says string, httpx-style
timeout objects, dict content parts, legacy ``function_call`` history and
unknown roles.  All of that must reach the page; only structurally hopeless
bodies (``messages`` not a list...) may fail - and then with an OpenAI-style
400 JSON error, never FastAPI's bare 422.
"""

from __future__ import annotations

from conftest import attach_browser

from server.models import ChatMessage, as_bool, coerce_timeout


def scripted(text: str):
    def _answer(_payload):
        return {"response": text, "error": None, "meta": {"duration_ms": 2, "stop_reason": "stable"}}

    return _answer


def test_as_bool_and_coerce_timeout_shapes():
    assert as_bool("true") is True and as_bool("false") is False
    assert as_bool(1) is True and as_bool(0) is False
    assert as_bool(None, default=True) is True
    assert coerce_timeout(600) == 600.0
    assert coerce_timeout("600") == 600.0
    assert coerce_timeout({"total": 30, "connect": 5}) == 30.0
    assert coerce_timeout({"read": 12}) == 12.0
    assert coerce_timeout("soon") is None
    assert coerce_timeout({"connect": "x"}) is None


def test_message_tolerates_dict_content_unknown_role_and_function_call():
    assert ChatMessage(role="narrator", content={"type": "text", "text": "hi"}).as_text() == "hi"
    assert ChatMessage(content={"type": "image_url", "image_url": "u"}).as_text() == "[image omitted by bridge]"
    legacy = ChatMessage(role="assistant", content=None, function_call={"name": "terminal", "arguments": '{"cmd":"ls"}'})
    text = legacy.as_text()
    assert '"name": "terminal"' in text
    assert ChatMessage(role=5, content=7).as_text() == "7"


async def test_messy_but_valid_body_runs(api):
    app, client = api
    browser = await attach_browser(app, scripted("ok"))
    try:
        res = await client.post(
            "/v1/chat/completions",
            json={
                "model": "arena-agent",
                "messages": [
                    {"role": "system", "content": [{"type": "text", "text": "policy"}]},
                    {"role": "user", "content": "hello"},
                ],
                "user": 42,
                "timeout": {"total": 600, "connect": 5},
                "stream": "false",
                "temperature": "0.7",
                "max_tokens": "4096",
                "n": "1",
            },
        )
        assert res.status_code == 200
        assert res.json()["choices"][0]["message"]["content"] == "ok"
        assert "policy" in browser.seen[0]["prompt"]
    finally:
        await browser.stop(app.state.bridge)


async def test_stream_as_string_true_streams(api):
    app, client = api
    browser = await attach_browser(app, scripted("hi"))
    try:
        res = await client.post(
            "/v1/chat/completions",
            json={
                "model": "arena-agent",
                "messages": [{"role": "user", "content": "hey"}],
                "stream": "true",
            },
        )
        assert res.status_code == 200
        assert res.text.startswith("data: ")
        assert "data: [DONE]" in res.text
    finally:
        await browser.stop(app.state.bridge)


async def test_structurally_hopeless_body_is_openai_style_400(api):
    _app, client = api
    res = await client.post(
        "/v1/chat/completions",
        json={"model": "arena-agent", "messages": "not a list"},
    )
    assert res.status_code == 400
    error = res.json()["error"]
    assert error["type"] == "invalid_request_error"
    assert error["code"] == "invalid_body"
    assert "messages" in error["message"]
