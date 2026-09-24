"""OpenAI-compatible request/response models plus the browser WebSocket protocol.

Only the subset of the OpenAI schema that a Chat-Completions client realistically
sends is modelled explicitly; unknown fields are accepted (``extra="allow"``) and
ignored so that Hermes/OpenClaw/LiteLLM style clients never get a 422 for adding
``response_format`` and friends.  ``tools``/``tool_choice`` are modelled: they
put the bridge into tool-broker mode (see ``server/toolbroker.py``).
"""

from __future__ import annotations

import json
import time
import uuid
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

Role = Literal["system", "developer", "user", "assistant", "tool", "function"]


def new_id(prefix: str = "chatcmpl") -> str:
    return f"{prefix}-{uuid.uuid4().hex[:24]}"


def now_ts() -> int:
    return int(time.time())


# ---------------------------------------------------------------------------
# Chat messages
# ---------------------------------------------------------------------------
class ContentPart(BaseModel):
    model_config = ConfigDict(extra="allow")

    type: Optional[str] = None
    text: Optional[str] = None
    image_url: Optional[Any] = None


def as_bool(value: Any, default: bool = False) -> bool:
    """Tolerant truthiness for request fields (``"true"``, ``1``, ``"false"``...)."""

    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on", "y", "t"}
    return default


def coerce_timeout(value: Any) -> Optional[float]:
    """Accept a number, a numeric string, or an httpx-style timeout object."""

    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    if isinstance(value, dict):
        for key in ("total", "read", "timeout"):
            if key in value:
                try:
                    return float(value[key])
                except (TypeError, ValueError):
                    continue
    return None


class ChatMessage(BaseModel):
    """One conversation turn.

    Every field is intentionally loose: real-world clients (Hermes, OpenClaw,
    LiteLLM proxies, the OpenAI SDK) send numbers where the schema says string,
    a dict where it says list, legacy ``function_call`` objects, or roles
    outside the OpenAI set.  A real API tolerates those and so does the bridge -
    a request body must never die on a 422.
    """

    model_config = ConfigDict(extra="allow")

    role: Any = "user"
    content: Any = None
    name: Any = None
    tool_call_id: Any = None
    #: OpenAI assistant tool_calls echoed back in the history of a later turn
    tool_calls: Optional[List[Dict[str, Any]]] = None

    def all_tool_calls(self) -> List[Dict[str, Any]]:
        """``tool_calls`` plus the legacy single ``function_call`` field."""

        calls = [c for c in (self.tool_calls or []) if isinstance(c, dict)]
        legacy = (self.model_extra or {}).get("function_call")
        if isinstance(legacy, dict) and legacy.get("name"):
            calls.append(
                {"name": legacy.get("name"), "arguments": legacy.get("arguments")}
            )
        return calls

    def render_tool_calls(self) -> str:
        """The tool_calls of this message as the broker's JSON plan shape."""

        rendered: List[Dict[str, Any]] = []
        for call in self.all_tool_calls():
            if not isinstance(call, dict):
                continue
            function = call.get("function") if isinstance(call.get("function"), dict) else {}
            name = call.get("name") or function.get("name")
            arguments = call.get("arguments", function.get("arguments"))
            if isinstance(arguments, str):
                try:
                    arguments = json.loads(arguments)
                except (ValueError, TypeError):
                    pass
            entry: Dict[str, Any] = {"name": name or "?"}
            if call.get("id"):
                entry["id"] = call["id"]
            entry["arguments"] = arguments if arguments is not None else {}
            rendered.append(entry)
        return json.dumps({"tool_calls": rendered}, ensure_ascii=False, indent=2)

    @staticmethod
    def _part_text(part: Any) -> str:
        if isinstance(part, str):
            return part
        if isinstance(part, ContentPart):
            if part.text:
                return part.text
            if part.image_url is not None:
                return "[image omitted by bridge]"
            return f"[{part.type}]" if part.type else ""
        if isinstance(part, dict):
            if isinstance(part.get("text"), str):
                return part["text"]
            if part.get("image_url") is not None:
                return "[image omitted by bridge]"
            if part.get("type"):
                return f"[{part['type']}]"
            return ""
        return str(part) if part is not None else ""

    def as_text(self) -> str:
        """Flatten the (possibly multimodal) content into plain text."""

        content = self.content
        text = ""
        if content is None:
            text = ""
        elif isinstance(content, str):
            text = content
        elif isinstance(content, dict):
            text = self._part_text(content)
        elif isinstance(content, (list, tuple)):
            chunks: List[str] = [self._part_text(part) for part in content]
            text = "\n".join(chunk for chunk in chunks if chunk)
        else:
            text = str(content)
        if self.all_tool_calls():
            block = self.render_tool_calls()
            text = f"{text}\n{block}" if text else block
        return text

    def is_empty(self) -> bool:
        return not self.as_text().strip()


# ---------------------------------------------------------------------------
# /v1/chat/completions
# ---------------------------------------------------------------------------
class ChatCompletionRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    model: Optional[str] = None
    messages: List[ChatMessage] = Field(default_factory=list)
    # sampling/top-level knobs are decorative (the page model is what it is) -
    # they are accepted in any shape real clients emit and never reject a body
    stream: Any = False
    temperature: Any = None
    top_p: Any = None
    max_tokens: Any = None
    n: Any = 1
    stop: Any = None
    user: Any = None
    tools: Optional[List[Dict[str, Any]]] = None
    tool_choice: Optional[Any] = None

    # --- bridge extensions (ignored by OpenAI clients) -------------------
    #: seconds to wait for the browser answer, overrides AAB_REQUEST_TIMEOUT.
    #: Loose on purpose: some clients leak an httpx timeout object here
    #: (``{"total": 600, "connect": 5}``) - coerce_timeout() makes sense of it.
    timeout: Any = None
    #: ``agent`` (default) or ``direct``
    mode: Optional[str] = None
    #: skip the destructive-command sanitiser for this request
    no_sanitize: bool = False


class Usage(BaseModel):
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0

    @classmethod
    def estimate(cls, prompt: str, completion: str) -> "Usage":
        prompt_tokens = estimate_tokens(prompt)
        completion_tokens = estimate_tokens(completion)
        return cls(
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=prompt_tokens + completion_tokens,
        )


def estimate_tokens(text: str) -> int:
    """Rough token estimate (~4 chars/token, whitespace aware).

    The bridge cannot know the real tokenizer of the web UI, so this is only
    here so that clients that insist on a ``usage`` block get a sane number.
    """

    if not text:
        return 0
    words = len(text.split())
    return max(words, len(text) // 4)


class ToolCallFunction(BaseModel):
    model_config = ConfigDict(extra="allow")

    name: str
    arguments: str = "{}"


class ToolCall(BaseModel):
    """One OpenAI ``message.tool_calls`` entry (``index`` only used in SSE)."""

    model_config = ConfigDict(extra="allow")

    id: str
    type: str = "function"
    function: ToolCallFunction
    index: Optional[int] = None


class ChoiceMessage(BaseModel):
    role: str = "assistant"
    content: Optional[str] = ""
    tool_calls: Optional[List[ToolCall]] = None


class Choice(BaseModel):
    index: int = 0
    message: ChoiceMessage
    finish_reason: Optional[str] = "stop"
    logprobs: Optional[Any] = None


class BridgeMeta(BaseModel):
    """Extra diagnostic block (``x_bridge``) added to every answer.

    OpenAI clients ignore unknown top-level keys, humans debugging a bridge do
    not.
    """

    request_id: str
    mode: str = "agent"
    browser_duration_ms: Optional[int] = None
    total_duration_ms: Optional[int] = None
    queue_wait_ms: Optional[int] = None
    sanitized: bool = False
    sanitize_mode: str = "redact"
    sanitize_findings: List[Dict[str, Any]] = Field(default_factory=list)
    browser_meta: Dict[str, Any] = Field(default_factory=dict)
    streamed: bool = False
    tool_mode: bool = False
    tools_offered: List[str] = Field(default_factory=list)
    tool_calls: List[str] = Field(default_factory=list)
    plan_parsed: bool = True


class ChatCompletionResponse(BaseModel):
    id: str = Field(default_factory=new_id)
    object: str = "chat.completion"
    created: int = Field(default_factory=now_ts)
    model: str = "arena-agent"
    choices: List[Choice]
    usage: Usage = Field(default_factory=Usage)
    system_fingerprint: str = "arena-agent-bridge"
    x_bridge: Optional[BridgeMeta] = None


# --- streaming -------------------------------------------------------------
class Delta(BaseModel):
    role: Optional[str] = None
    content: Optional[str] = None
    tool_calls: Optional[List[ToolCall]] = None


class ChunkChoice(BaseModel):
    index: int = 0
    delta: Delta = Field(default_factory=Delta)
    finish_reason: Optional[str] = None
    logprobs: Optional[Any] = None


class ChatCompletionChunk(BaseModel):
    id: str = Field(default_factory=new_id)
    object: str = "chat.completion.chunk"
    created: int = Field(default_factory=now_ts)
    model: str = "arena-agent"
    choices: List[ChunkChoice]
    system_fingerprint: str = "arena-agent-bridge"
    x_bridge: Optional[BridgeMeta] = None


# --- models -----------------------------------------------------------------
class ModelCard(BaseModel):
    id: str
    object: str = "model"
    created: int = Field(default_factory=now_ts)
    owned_by: str = "arena-agent-bridge"
    permission: List[Any] = Field(default_factory=list)
    root: Optional[str] = None
    description: Optional[str] = None


class ModelList(BaseModel):
    object: str = "list"
    data: List[ModelCard]


# --- errors -----------------------------------------------------------------
class ErrorDetail(BaseModel):
    message: str
    type: str = "invalid_request_error"
    param: Optional[str] = None
    code: Optional[str] = None


class ErrorResponse(BaseModel):
    error: ErrorDetail


# ---------------------------------------------------------------------------
# WebSocket protocol between server and extension
# ---------------------------------------------------------------------------
class BrowserRequest(BaseModel):
    """server -> extension"""

    type: Literal["request"] = "request"
    id: str
    prompt: str
    mode: str = "agent"
    timeout: float = 300.0
    created_at: float = Field(default_factory=time.time)


class BrowserResponse(BaseModel):
    """extension -> server"""

    type: Literal["response"] = "response"
    id: str
    response: Optional[str] = None
    error: Optional[str] = None
    meta: Dict[str, Any] = Field(default_factory=dict)


class BrowserHello(BaseModel):
    """extension -> server, sent right after the socket opens."""

    type: Literal["hello"] = "hello"
    client: str = "chrome-extension"
    version: Optional[str] = None
    url: Optional[str] = None
    tab_id: Optional[int] = None


class BrowserHeartbeat(BaseModel):
    """extension -> server, periodic status ping."""

    type: Literal["heartbeat"] = "heartbeat"
    id: Optional[str] = None
    state: Optional[str] = None
    busy: Optional[bool] = None
    url: Optional[str] = None
