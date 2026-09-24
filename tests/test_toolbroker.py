"""Tests for the tool-calling broker (server/toolbroker.py + chat wiring).

Unit tests cover plan parsing (the page answers with free-form text that
hides a JSON object) and prompt assembly; the end-to-end tests drive the real
HTTP -> queue -> WebSocket -> sanitiser path with a scripted fake browser and
assert the OpenAI wire format (``message.tool_calls`` + ``finish_reason``).
"""

from __future__ import annotations

import json
from typing import Any, Dict

from conftest import attach_browser, make_settings

from server.models import ChatMessage
from server.prompt_builder import PromptBuildError
from server.toolbroker import (
    build_tool_prompt,
    extract_tool_specs,
    parse_plan,
    to_openai_tool_calls,
    tool_policy_text,
)

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "terminal",
            "description": "Run a shell command",
            "parameters": {
                "type": "object",
                "properties": {"command": {"type": "string"}},
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the web",
            "parameters": {"type": "object", "properties": {"q": {"type": "string"}}},
        },
    },
]


def scripted(*answers: str):
    """Answer each request with the next canned page text."""

    remaining = list(answers)

    def _answer(_payload: Dict[str, Any]) -> Dict[str, Any]:
        text = remaining.pop(0) if remaining else "{}"
        return {"response": text, "error": None, "meta": {"duration_ms": 3, "stop_reason": "stable"}}

    return _answer


# ---------------------------------------------------------------------------
# specs / policy
# ---------------------------------------------------------------------------
def test_extract_tool_specs_accepts_openai_and_bare_shapes():
    specs = extract_tool_specs(
        TOOLS + [{"function": {}}, {"name": "solo", "parameters": {"type": "object"}}, "junk"]
    )
    assert [s.name for s in specs] == ["terminal", "web_search", "solo"]
    assert specs[0].description.startswith("Run")
    assert specs[0].parameters["required"] == ["command"]


def test_tool_policy_text_variants():
    assert "no tool is needed" in tool_policy_text(None)
    assert "at least one tool call" in tool_policy_text("required")
    assert "MUST include a call to the `terminal`" in tool_policy_text(
        {"type": "function", "function": {"name": "terminal"}}
    )
    assert "MUST include a call to the `web_search`" in tool_policy_text({"name": "web_search"})


def test_build_tool_prompt_contains_tools_protocol_and_history():
    settings = make_settings()
    prompt, mode = build_tool_prompt(
        [
            ChatMessage(role="system", content="policy"),
            ChatMessage(role="user", content="list files"),
            ChatMessage(
                role="assistant",
                content=None,
                tool_calls=[
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "terminal", "arguments": '{"command": "ls"}'},
                    }
                ],
            ),
            ChatMessage(role="tool", content="a.txt\nb.txt"),
        ],
        settings,
        extract_tool_specs(TOOLS),
    )
    assert mode == "agent"
    assert "TOOL-CALLING mode" in prompt
    assert "- name: terminal" in prompt and "- name: web_search" in prompt
    assert '"tool_calls"' in prompt and '"final"' in prompt
    assert "### system\npolicy" in prompt
    assert "### tool result\na.txt" in prompt
    assert '"name": "terminal"' in prompt  # history call rendered as the plan shape


def test_build_tool_prompt_rejects_empty_conversation():
    try:
        build_tool_prompt([], make_settings(), extract_tool_specs(TOOLS))
    except PromptBuildError as exc:
        assert "no usable message content" in str(exc)
    else:  # pragma: no cover - guard
        raise AssertionError("expected PromptBuildError")


# ---------------------------------------------------------------------------
# plan parsing
# ---------------------------------------------------------------------------
def test_parse_plan_pure_json():
    plan = parse_plan('{"tool_calls": [{"name": "terminal", "arguments": {"command": "ls"}}]}')
    assert plan.parsed and plan.final is None
    assert plan.tool_calls[0].name == "terminal"
    assert plan.tool_calls[0].arguments == {"command": "ls"}


def test_parse_plan_tolerates_preamble_and_fences():
    text = (
        "Sure - I will list the files first.\n"
        '```json\n{"tool_calls": [{"name": "terminal", "arguments": {"command": "ls"}}]}\n```'
    )
    plan = parse_plan(text)
    assert plan.parsed and plan.tool_calls[0].name == "terminal"


def test_parse_plan_final_and_answer_alias():
    assert parse_plan('{"final": "42"}').final == "42"
    assert parse_plan("hmm...\n{\"answer\": \"42\"}").final == "42"
    assert parse_plan('{"final": {"x": 1}}').final == '{"x": 1}'


def test_parse_plan_string_arguments_are_decoded():
    plan = parse_plan(
        '{"tool_calls": [{"name": "terminal", "arguments": "{\\"command\\": \\"ls\\"}"}]}'
    )
    assert plan.tool_calls[0].arguments == {"command": "ls"}


def test_parse_plan_function_shaped_calls_and_singular_key():
    plan = parse_plan(
        '{"tool_call": [{"function": {"name": "web_search", "arguments": "{\\"q\\": \\"x\\"}"}}]}'
    )
    assert plan.tool_calls[0].name == "web_search"
    assert plan.tool_calls[0].arguments == {"q": "x"}


def test_parse_plan_drops_unknown_tools_and_falls_back():
    plan = parse_plan(
        '{"tool_calls": [{"name": "rm_rf", "arguments": {}}]}', known_names=["terminal"]
    )
    assert plan.parsed is False
    assert plan.final.startswith("{")


def test_parse_plan_garbage_falls_back_to_raw_text():
    plan = parse_plan("no json here at all")
    assert plan.parsed is False
    assert plan.final == "no json here at all"
    assert plan.tool_calls == []


def test_to_openai_tool_calls_wire_shape():
    calls = to_openai_tool_calls(parse_plan('{"tool_calls": [{"name": "terminal", "arguments": {"command": "ls"}}]}').tool_calls)
    encoded = calls[0].model_dump(exclude_none=True)
    assert encoded["id"].startswith("call_")
    assert encoded["type"] == "function"
    assert encoded["function"]["name"] == "terminal"
    assert json.loads(encoded["function"]["arguments"]) == {"command": "ls"}


def test_chat_message_renders_tool_calls_in_history():
    message = ChatMessage(
        role="assistant",
        content=None,
        tool_calls=[{"id": "call_9", "function": {"name": "terminal", "arguments": '{"command": "ls"}'}}],
    )
    text = message.as_text()
    assert not message.is_empty()
    assert '"name": "terminal"' in text
    assert "call_9" in text


# ---------------------------------------------------------------------------
# end-to-end through the HTTP surface
# ---------------------------------------------------------------------------
async def test_tool_broker_round_trip(api):
    app, client = api
    browser = await attach_browser(
        app,
        scripted(
            '{"tool_calls": [{"name": "terminal", "arguments": {"command": "ls"}}]}',
            '{"final": "a.txt and b.txt"}',
        ),
    )
    try:
        res = await client.post(
            "/v1/chat/completions",
            json={
                "model": "arena-agent",
                "messages": [{"role": "user", "content": "list files"}],
                "tools": TOOLS,
            },
        )
        assert res.status_code == 200
        data = res.json()
        choice = data["choices"][0]
        assert choice["finish_reason"] == "tool_calls"
        call = choice["message"]["tool_calls"][0]
        assert call["function"]["name"] == "terminal"
        assert json.loads(call["function"]["arguments"]) == {"command": "ls"}
        assert call["id"].startswith("call_")
        assert data["x_bridge"]["tool_mode"] is True
        assert data["x_bridge"]["tool_calls"] == ["terminal"]
        assert data["x_bridge"]["plan_parsed"] is True

        # the client executed the tool and reports the result
        res = await client.post(
            "/v1/chat/completions",
            json={
                "model": "arena-agent",
                "messages": [
                    {"role": "user", "content": "list files"},
                    {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [choice["message"]["tool_calls"][0]],
                    },
                    {"role": "tool", "tool_call_id": call["id"], "content": "a.txt\nb.txt"},
                ],
                "tools": TOOLS,
            },
        )
        data = res.json()
        assert data["choices"][0]["finish_reason"] == "stop"
        assert data["choices"][0]["message"]["content"] == "a.txt and b.txt"
        assert data["choices"][0]["message"].get("tool_calls") is None
        # the second page prompt carried the tool result back to the site model
        prompt2 = browser.seen[1]["prompt"]
        assert "a.txt\nb.txt" in prompt2
    finally:
        await browser.stop(app.state.bridge)


async def test_tool_broker_unparsable_plan_returns_plain_text(api):
    app, client = api
    browser = await attach_browser(app, scripted("let us chat instead"))
    try:
        res = await client.post(
            "/v1/chat/completions",
            json={
                "model": "arena-agent",
                "messages": [{"role": "user", "content": "hi"}],
                "tools": TOOLS,
            },
        )
        data = res.json()
        assert data["choices"][0]["finish_reason"] == "stop"
        assert data["choices"][0]["message"]["content"] == "let us chat instead"
        assert data["x_bridge"]["plan_parsed"] is False
    finally:
        await browser.stop(app.state.bridge)


async def test_tool_broker_strips_preamble_around_final(api):
    app, client = api
    browser = await attach_browser(app, scripted('Sure, here you go!\n{"final": "42"}'))
    try:
        res = await client.post(
            "/v1/chat/completions",
            json={
                "model": "arena-agent",
                "messages": [{"role": "user", "content": "the answer"}],
                "tools": TOOLS,
            },
        )
        data = res.json()
        assert data["choices"][0]["message"]["content"] == "42"
    finally:
        await browser.stop(app.state.bridge)


async def test_tool_choice_none_keeps_plain_chat(api):
    app, client = api
    browser = await attach_browser(app, scripted("plain answer"))
    try:
        res = await client.post(
            "/v1/chat/completions",
            json={
                "model": "arena-agent",
                "messages": [{"role": "user", "content": "hi"}],
                "tools": TOOLS,
                "tool_choice": "none",
            },
        )
        data = res.json()
        assert data["choices"][0]["finish_reason"] == "stop"
        assert data["choices"][0]["message"]["content"] == "plain answer"
        assert data["x_bridge"]["tool_mode"] is False
        assert "TOOL-CALLING mode" not in browser.seen[0]["prompt"]
    finally:
        await browser.stop(app.state.bridge)


async def test_tool_broker_streaming_emits_tool_calls(api):
    app, client = api
    browser = await attach_browser(
        app, scripted('{"tool_calls": [{"name": "web_search", "arguments": {"q": "arena"}}]}')
    )
    try:
        res = await client.post(
            "/v1/chat/completions",
            json={
                "model": "arena-agent",
                "messages": [{"role": "user", "content": "search"}],
                "tools": TOOLS,
                "stream": True,
            },
        )
        assert res.status_code == 200
        events = [line for line in res.text.splitlines() if line.startswith("data: ")]
        assert events[-1] == "data: [DONE]"
        payloads = [json.loads(e[6:]) for e in events[:-1]]
        tool_deltas = [
            p for p in payloads if p.get("choices", [{}])[0].get("delta", {}).get("tool_calls")
        ]
        assert tool_deltas, "no tool_calls delta in the SSE stream"
        call = tool_deltas[0]["choices"][0]["delta"]["tool_calls"][0]
        assert call["function"]["name"] == "web_search"
        assert call["index"] == 0
        finals = [p for p in payloads if p["choices"][0].get("finish_reason")]
        assert finals and finals[-1]["choices"][0]["finish_reason"] == "tool_calls"
    finally:
        await browser.stop(app.state.bridge)
