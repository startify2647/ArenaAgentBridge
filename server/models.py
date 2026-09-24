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
from typing import Any, Dict, List, Literal, Optional, Union

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


class ChatMessage(BaseModel):
    model_config = ConfigDict(extra="allow")

    role: Role = "user"
    content: Union[str, List[Union[str, ContentPart, Dict[str, Any]]], None] = None
    name: Optional[str] = None
    tool_call_id: Optional[str] = None
    #: OpenAI assistant tool_calls echoed back in the history of a later turn
    tool_calls: Optional[List[Dict[str, Any]]] = None

    def render_tool_calls(self) -> str:
        """The tool_calls of this message as the broker's JSON plan shape."""

        rendered: List[Dict[str, Any]] = []
        for call in self.tool_calls or []:
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

    def as_text(self) -> str:
        """Flatten the (possibly multimodal) content into plain text."""

        content = self.content
        text = ""
        if content is None:
            text = ""
        elif isinstance(content, str):
            text = content
        else:
            chunks: List[str] = []
            for part in content:
                if isinstance(part, str):
                    chunks.append(part)
                elif isinstance(part, ContentPart):
                    if part.text:
                        chunks.append(part.text)
                    elif part.image_url is not None:
                        chunks.append("[image omitted by bridge]")
                    elif part.type:
                        chunks.append(f"[{part.type}]")
                elif isinstance(part, dict):
                    if isinstance(part.get("text"), str):
                        chunks.append(part["text"])
                    elif isinstance(part.get("image_url"), (dict, str)):
                        chunks.append("[image omitted by bridge]")
                    elif part.get("type"):
                        chunks.append(f"[{part['type']}]")
            text = "\n".join(chunk for chunk in chunks if chunk)
        if self.tool_calls:
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
    stream: bool = False
    temperature: Optional[float] = None
    top_p: Optional[float] = None
    max_tokens: Optional[int] = None
    n: Optional[int] = 1
    stop: Optional[Union[str, List[str]]] = None
    user: Optional[str] = None
    tools: Optional[List[Dict[str, Any]]] = None
    tool_choice: Optional[Any] = None

    # --- bridge extensions (ignored by OpenAI clients) -------------------
    #: seconds to wait for the browser answer, overrides AAB_REQUEST_TIMEOUT
    timeout: Optional[float] = None
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
