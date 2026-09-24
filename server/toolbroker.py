"""Tool-calling broker: make the bridge behave like a real OpenAI tools API.

The web UI behind the bridge is a plain chat box - it has no function-calling
protocol of its own.  Clients such as Hermes however speak standard OpenAI
tool calls: they send ``tools``, expect ``message.tool_calls`` plus
``finish_reason: "tool_calls"`` back, execute the calls in *their* environment
and post ``role="tool"`` results on the next turn.  This module glues the two
worlds together:

``extract_tool_specs``    normalise the incoming OpenAI ``tools`` array
``build_tool_prompt``     flatten the conversation and teach the strict JSON
                          plan protocol (``{"tool_calls": [...]}`` /
                          ``{"final": "..."}``)
``parse_plan``            recover the plan from the page's free-form answer
``to_openai_tool_calls``  re-encode it into the OpenAI wire format
``sanitize_plan_calls``   run the destructive-command sanitiser over arguments

The bridge never executes tools itself - exactly like api.openai.com, the
caller runs them and feeds the results back in the next request, so the whole
flow stays stateless.
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Union

from .models import ChatMessage, ToolCall, ToolCallFunction
from .prompt_builder import (
    PromptBuildError,
    last_user_message,
    normalise_messages,
    render_transcript,
)

logger = logging.getLogger("arena_bridge.toolbroker")


# ---------------------------------------------------------------------------
# incoming tool specs
# ---------------------------------------------------------------------------
@dataclass
class ToolSpec:
    name: str
    description: str = ""
    parameters: Dict[str, Any] = field(default_factory=dict)


def extract_tool_specs(tools: Optional[Sequence[Any]]) -> List[ToolSpec]:
    """Pull ``name``/``description``/``parameters`` out of an OpenAI tools array.

    Both ``{"type": "function", "function": {...}}`` and a bare ``{"name": ...}``
    function object are accepted; malformed entries are skipped.
    """

    specs: List[ToolSpec] = []
    for entry in tools or []:
        if not isinstance(entry, dict):
            continue
        function = entry.get("function") if isinstance(entry.get("function"), dict) else entry
        name = function.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        parameters = function.get("parameters")
        if not isinstance(parameters, dict):
            parameters = {}
        description = function.get("description")
        specs.append(
            ToolSpec(
                name=name.strip(),
                description=(description or "").strip()[:800],
                parameters=parameters,
            )
        )
    return specs


def render_tools_block(specs: Sequence[ToolSpec]) -> str:
    """Render the caller's tools as a compact list for the prompt."""

    lines: List[str] = []
    for spec in specs:
        schema = json.dumps(spec.parameters, ensure_ascii=False)
        lines.append(f"- name: {spec.name}")
        if spec.description:
            lines.append(f"  description: {spec.description}")
        lines.append(f"  arguments JSON schema: {schema}")
    return "\n".join(lines) if lines else "(no tools offered)"


def tool_policy_text(tool_choice: Any) -> str:
    """Translate the OpenAI ``tool_choice`` value into one policy line."""

    if isinstance(tool_choice, dict):
        name = tool_choice.get("name")
        function = tool_choice.get("function")
        if not name and isinstance(function, dict):
            name = function.get("name")
        if isinstance(name, str) and name:
            return (
                f"You MUST include a call to the `{name}` tool in this reply "
                "(other independent calls may accompany it)."
            )
    if tool_choice == "required":
        return 'You MUST include at least one tool call in this reply (never {"final": ...} first).'
    return (
        "Call tools when they move the task forward; reply with "
        '{"final": ...} when the task is done or no tool is needed.'
    )


# ---------------------------------------------------------------------------
# prompt assembly
# ---------------------------------------------------------------------------
def _fill(template: str, **parts: str) -> str:
    """Substitute ``{key}`` markers.

    ``str.format`` is deliberately avoided: the tool wrapper legitimately
    contains JSON braces (``{"tool_calls": ...}``) that format() would reject.
    """

    for key, value in parts.items():
        template = template.replace("{" + key + "}", value)
    return template


def build_tool_prompt(
    messages: Sequence[ChatMessage],
    settings: Any,
    specs: Sequence[ToolSpec],
    tool_choice: Any = None,
    mode: Optional[str] = None,
) -> tuple:
    """Return ``(prompt, mode)`` for a tool-calling turn.

    ``mode`` keeps its usual meaning (``agent``/``direct`` - how the browser
    submits the prompt); only the wrapper text changes so the site model plans
    with the caller's tools instead of answering directly.
    """

    resolved_mode = (mode or settings.default_mode or "agent").lower()
    if resolved_mode not in {"agent", "direct"}:
        resolved_mode = settings.default_mode

    pairs = normalise_messages(messages)
    if not pairs:
        raise PromptBuildError(
            "no usable message content: every message in `messages` was empty "
            "(the bridge can only forward text)"
        )

    transcript = render_transcript(pairs, settings)
    final_user = last_user_message(pairs)
    prompt = _fill(
        settings.tool_wrapper,
        transcript=transcript,
        last_user=final_user,
        tools=render_tools_block(specs),
        tool_policy=tool_policy_text(tool_choice),
    )

    prompt = prompt.strip()
    if len(prompt) > settings.max_prompt_chars:
        raise PromptBuildError(
            f"prompt is {len(prompt)} characters which exceeds "
            f"AAB_MAX_PROMPT_CHARS={settings.max_prompt_chars}; trim the history "
            "or the tool list"
        )
    return prompt, resolved_mode


# ---------------------------------------------------------------------------
# plan parsing (page answer -> structured calls)
# ---------------------------------------------------------------------------
@dataclass
class PlanCall:
    name: str
    arguments: Union[Dict[str, Any], str] = field(default_factory=dict)


@dataclass
class ToolPlan:
    tool_calls: List[PlanCall] = field(default_factory=list)
    final: Optional[str] = None
    parsed: bool = False
    raw: str = ""


_FENCE_RE = re.compile(r"```[a-zA-Z0-9_-]*\s*\n?(.*?)```", re.S)


def _balanced_objects(text: str) -> List[str]:
    """Every outermost ``{...}`` span of *text* (string/escape aware)."""

    objs: List[str] = []
    depth = 0
    start: Optional[int] = None
    in_str = False
    esc = False
    for i, ch in enumerate(text):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}" and depth:
            depth -= 1
            if depth == 0 and start is not None:
                objs.append(text[start : i + 1])
                start = None
    return objs


def _coerce_arguments(value: Any) -> Union[Dict[str, Any], str]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (ValueError, TypeError):
            return value
        return parsed if isinstance(parsed, dict) else {"_raw": parsed}
    if value is None:
        return {}
    return {"_raw": value}


def _plan_from_obj(obj: Dict[str, Any], known_names: Optional[Sequence[str]]) -> Optional[ToolPlan]:
    calls_raw = obj.get("tool_calls", obj.get("tool_call"))
    final = obj.get("final", obj.get("answer"))
    if calls_raw is None and final is None:
        return None

    if isinstance(calls_raw, dict):
        calls_raw = [calls_raw]

    calls: List[PlanCall] = []
    for item in calls_raw or []:
        if not isinstance(item, dict):
            continue
        function = item.get("function") if isinstance(item.get("function"), dict) else {}
        name = item.get("name") or function.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        name = name.strip()
        if known_names and name not in known_names:
            logger.warning("plan asked for unknown tool %r - dropping the call", name)
            continue
        arguments = item.get("arguments", item.get("parameters", function.get("arguments")))
        calls.append(PlanCall(name=name, arguments=_coerce_arguments(arguments)))

    if final is not None and not isinstance(final, str):
        final = json.dumps(final, ensure_ascii=False)
    if not calls and final is None:
        return None
    return ToolPlan(tool_calls=calls, final=final, parsed=True)


def parse_plan(text: str, known_names: Optional[Sequence[str]] = None) -> ToolPlan:
    """Recover ``{"tool_calls": [...]}`` / ``{"final": ...}`` from a page answer.

    Site models wrap their answer in prose or code fences surprisingly often
    (the bridge's known cosmetic issue), so every plausible JSON span is tried:
    the whole answer, each fenced block, then each balanced object.  When
    nothing parses, the raw text is returned as an unparsed ``final`` so the
    caller still gets a usable assistant message.
    """

    text = text or ""
    candidates: List[str] = [text.strip()]
    candidates.extend(m.strip() for m in _FENCE_RE.findall(text))
    candidates.extend(_balanced_objects(text))

    for candidate in candidates:
        if not candidate.startswith("{"):
            continue
        try:
            obj = json.loads(candidate)
        except (ValueError, TypeError):
            continue
        if not isinstance(obj, dict):
            continue
        plan = _plan_from_obj(obj, known_names)
        if plan is not None:
            return plan

    return ToolPlan(tool_calls=[], final=text.strip(), parsed=False, raw=text)


# ---------------------------------------------------------------------------
# outgoing wire format + sanitiser hook
# ---------------------------------------------------------------------------
def to_openai_tool_calls(calls: Sequence[PlanCall]) -> List[ToolCall]:
    """Encode plan calls as OpenAI ``message.tool_calls`` entries."""

    encoded: List[ToolCall] = []
    for call in calls:
        arguments = call.arguments
        if not isinstance(arguments, str):
            arguments = json.dumps(arguments, ensure_ascii=False)
        encoded.append(
            ToolCall(
                id=f"call_{uuid.uuid4().hex[:24]}",
                type="function",
                function=ToolCallFunction(name=call.name, arguments=arguments),
            )
        )
    return encoded


def stream_tool_call_deltas(calls: Sequence[ToolCall]) -> List[ToolCall]:
    """Give each encoded call its SSE ``index`` (single-shot arguments chunks)."""

    for i, call in enumerate(calls):
        call.index = i
    return list(calls)


def sanitize_plan_calls(calls: Sequence[ToolCall], *, mode: str, rules: List[tuple]) -> bool:
    """Run the destructive-command sanitiser over every arguments payload.

    If redaction would break the JSON the original payload is kept - a tool
    call the client can at least parse beats a corrupted one.
    """

    from .sanitizer import sanitize  # local import: keeps the import graph flat

    changed = False
    for call in calls:
        original = call.function.arguments
        cleaned, report = sanitize(original, mode=mode, rules=rules)
        if not report.changed or cleaned == original:
            continue
        try:
            json.loads(cleaned)
        except (ValueError, TypeError):
            logger.warning(
                "sanitiser output for tool %s is not valid JSON - keeping the original",
                call.function.name,
            )
            continue
        call.function.arguments = cleaned
        changed = True
    return changed
