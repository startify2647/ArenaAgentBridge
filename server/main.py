"""FastAPI server exposing an OpenAI-compatible API backed by the Arena web UI.

Run it with::

    python -m server                     # from the repository root
    uvicorn server.main:app --host 127.0.0.1 --port 8000

Endpoints
---------
``POST /v1/chat/completions``   OpenAI chat completion (``stream`` supported)
``GET  /v1/models``             fake model list (``arena-agent``, ...)
``WS   /ws/browser``            the Chrome extension connects here
``GET  /v1/bridge/status``      JSON status of server + browser connection
``GET  /`` ``/admin``           the web UI (admin panel + playground)
``GET  /healthz`` ``GET /readyz``
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import sys
import time
import urllib.parse
from typing import Any, AsyncIterator, Dict, List, Optional

from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.routing import APIRoute

from .admin import create_admin_router, render_panel_page
from .auth import api_key_dependency
from .config import Settings, get_settings
from .history import RequestHistory, detect_client
from .mock_browser import maybe_start_mock
from .models import (
    BridgeMeta,
    ChatCompletionChunk,
    ChatCompletionRequest,
    ChatCompletionResponse,
    Choice,
    ChoiceMessage,
    ChunkChoice,
    Delta,
    ErrorDetail,
    ErrorResponse,
    ModelCard,
    ModelList,
    Usage,
    as_bool,
    coerce_timeout,
    new_id,
)
from .prompt_builder import PromptBuildError, build_prompt
from .sanitizer import load_rules, sanitize
from .toolbroker import (
    build_tool_prompt,
    extract_tool_specs,
    parse_plan,
    sanitize_plan_calls,
    stream_tool_call_deltas,
    to_openai_tool_calls,
)
from .websocket_manager import BridgeError, BrowserBridge

logger = logging.getLogger("aab.server")

#: Fallback page for ``AAB_PANEL_ENABLED=0`` (the panel itself lives in
#: ``server/webui.py`` and is served from ``server/admin.py``).
STATUS_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>ArenaAgentBridge</title>
<style>
 body{{font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:#0d1117;color:#c9d1d9;
      margin:0;padding:32px}}
 h1{{font-size:18px;margin:0 0 4px}} .muted{{color:#8b949e}}
 .card{{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin:16px 0;max-width:760px}}
 .ok{{color:#3fb950}} .bad{{color:#f85149}} .warn{{color:#d29922}}
 code{{background:#21262d;padding:2px 6px;border-radius:4px}}
 pre{{white-space:pre-wrap;word-break:break-word}}
</style></head><body>
<h1>ArenaAgentBridge <span class="muted">v{version}</span></h1>
<p class="muted">OpenAI-compatible bridge to a locally logged-in browser session.
Nothing leaves this machine.</p>
<div class="card"><b>Browser connection:</b> {browser}<br>
<b>Queue:</b> {queue} &nbsp; <b>Requests:</b> {requests} &nbsp; <b>Errors:</b> {errors}</div>
<div class="card"><b>Use it from Hermes / OpenClaw / curl:</b>
<pre>curl http://127.0.0.1:{port}/v1/chat/completions \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer sk-arena' \\
  -d '{{"model":"arena-agent","messages":[{{"role":"user","content":"hello"}}]}}'</pre>
</div>
<div class="card"><b>JSON status:</b> <code>/v1/bridge/status</code> &nbsp;
<b>Models:</b> <code>/v1/models</code> &nbsp; <b>Docs:</b> <code>/docs</code></div>
</body></html>
"""


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _error(status: int, message: str, err_type: str = "invalid_request_error",
           code: Optional[str] = None) -> JSONResponse:
    payload = ErrorResponse(error=ErrorDetail(message=message, type=err_type, code=code))
    return JSONResponse(status_code=status, content=payload.model_dump())


def _sse(payload: Dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _split_for_stream(text: str, chunk_chars: int) -> List[str]:
    """Split into human-ish chunks so clients render a progressive answer."""

    if not text:
        return []
    chunks: List[str] = []
    buffer = ""
    for token in text.replace("\r", "").split(" "):
        if len(buffer) + len(token) + 1 <= chunk_chars:
            buffer = f"{buffer} {token}".strip() if buffer else token
        else:
            if buffer:
                chunks.append(buffer + " ")
            buffer = token
    if buffer:
        chunks.append(buffer)
    return chunks


def _dump_messages(payload: ChatCompletionRequest, limit: int = 4000) -> str:
    """Flatten the incoming conversation for the panel's history preview."""

    lines: List[str] = []
    for message in payload.messages:
        text = message.as_text()
        if text:
            lines.append(f"### {message.role}\n{text}")
    return "\n".join(lines)[:limit]


async def submit_with_disconnect_watch(
    bridge: BrowserBridge,
    prompt: str,
    mode: str,
    timeout: float,
    *,
    conversation: str,
    is_disconnected,
) -> tuple:
    """Await ``bridge.submit`` while watching the HTTP client connection.

    Returns ``(result, aborted)``.  ``aborted`` is ``True`` when the client
    went away mid-flight: the request has been cancelled on the bridge so the
    browser tab is not burned producing an answer nobody is waiting for.
    """

    pending_id: Dict[str, str] = {}
    task = asyncio.create_task(
        bridge.submit(prompt, mode, timeout, conversation=conversation, id_sink=pending_id)
    )
    try:
        while not task.done():
            done_set, _ = await asyncio.wait({task}, timeout=0.3)
            if not done_set and await is_disconnected():
                if pending_id.get("id"):
                    await bridge.cancel_by_id(pending_id["id"], reason="client_disconnected")
                return None, True
        return await task, False
    finally:
        if not task.done():
            task.cancel()


def create_app(settings: Optional[Settings] = None) -> FastAPI:
    settings = settings or get_settings()
    bridge = BrowserBridge(settings)
    rules = load_rules(settings.patterns_file)
    history = RequestHistory(settings.history_size)

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        await bridge.start()
        app.state.mock = await maybe_start_mock(bridge)
        logger.info(
            "ArenaAgentBridge v%s ready on http://%s:%s/v1 (sanitize=%s, mock=%s)",
            settings.version, settings.host, settings.port, settings.sanitize_mode,
            bool(app.state.mock),
        )
        try:
            yield
        finally:
            if getattr(app.state, "mock", None) is not None:
                await app.state.mock.stop()
            await bridge.stop()

    app = FastAPI(
        title="ArenaAgentBridge",
        version=settings.version,
        summary="Local OpenAI-compatible bridge to the Arena.ai/Agent web UI",
        description=(
            "Bridges OpenAI-style chat requests to a real, logged-in Chrome session "
            "via a Manifest V3 extension. Loopback only, no API keys, no captcha bypass."
        ),
        lifespan=lifespan,
        # /docs + /openapi.json are disabled by AAB_DOCS=0 (default: on, the
        # server is loopback-only).
        docs_url="/docs" if settings.docs_enabled else None,
        redoc_url=None,
        openapi_url="/openapi.json" if settings.docs_enabled else None,
    )
    app.state.settings = settings
    app.state.bridge = bridge
    app.state.history = history

    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=settings.cors_origin_regex,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    require_auth = api_key_dependency(settings)

    if settings.panel_enabled:
        app.include_router(
            create_admin_router(settings=settings, bridge=bridge, history=history, rules=rules)
        )
        logger.info("admin panel enabled on http://%s:%s/admin", settings.host, settings.port)

    def request_context(request: Request) -> tuple:
        """(source, client label) for the history/panel."""

        source = (request.headers.get("x-bridge-source") or "api").strip().lower()
        if source not in {"api", "panel", "test"}:
            source = "api"
        return source, detect_client(request.headers.get("user-agent"))

    # ------------------------------------------------------------------
    # OpenAI-compatible surface
    # ------------------------------------------------------------------
    @app.get("/v1/models", response_model=ModelList)
    @app.get("/models", response_model=ModelList, include_in_schema=False)
    async def list_models(_: None = Depends(require_auth)) -> ModelList:
        return ModelList(
            data=[
                ModelCard(
                    id=settings.model_id,
                    root=settings.model_id,
                    description="Arena.ai/Agent web UI, agent-mode prompt wrapper",
                ),
                *[
                    ModelCard(
                        id=mid,
                        root=settings.model_id,
                        description="same browser session, direct prompt wrapper (no preamble)",
                    )
                    for mid in settings.extra_model_ids
                ],
            ]
        )

    @app.post("/v1/chat/completions")
    @app.post("/chat/completions", include_in_schema=False)
    async def chat_completions(
        payload: ChatCompletionRequest,
        request: Request,
        _: None = Depends(require_auth),
    ):
        started = time.time()
        request_id = new_id()
        source, client_label = request_context(request)
        stream_flag = as_bool(payload.stream, default=False)
        #: what the client sent, preamble excluded - the panel's history shows this
        conversation = _dump_messages(payload)

        # The requested model can select the prompt wrapper: `*-direct` skips the
        # agent preamble.  Resolve it *before* building the prompt.
        requested_mode = payload.mode or (
            "direct" if str(payload.model or "").endswith("-direct") else None
        )
        # `tools` flips the bridge into tool-broker mode: the site model plans
        # with the caller's tools and the answer comes back as standard OpenAI
        # tool_calls (see server/toolbroker.py).
        tool_specs = extract_tool_specs(payload.tools)
        wants_tools = bool(tool_specs) and payload.tool_choice != "none"
        tool_names = [spec.name for spec in tool_specs]
        try:
            if wants_tools:
                prompt, mode = build_tool_prompt(
                    payload.messages,
                    settings,
                    tool_specs,
                    payload.tool_choice,
                    requested_mode,
                )
            else:
                prompt, mode = build_prompt(payload.messages, settings, requested_mode)
        except PromptBuildError as exc:
            history.record(
                request_id=request_id,
                source=source,
                client=client_label,
                model=payload.model or settings.model_id,
                mode=payload.mode or settings.default_mode,
                streamed=stream_flag,
                status="rejected",
                http_status=400,
                error_code="invalid_messages",
                error_message=str(exc),
                prompt=_dump_messages(payload),
                total_ms=int((time.time() - started) * 1000),
            )
            return _error(400, str(exc), code="invalid_messages")

        if payload.model and payload.model not in settings.model_ids:
            logger.info("client asked for unknown model %r - serving %s", payload.model, settings.model_id)

        timeout = settings.clamp_timeout(coerce_timeout(payload.timeout))
        try:
            n_choices = int(payload.n) if payload.n is not None else 1
        except (TypeError, ValueError):
            n_choices = 1
        if n_choices > 1:
            logger.warning("n=%s requested; the bridge always returns a single choice", payload.n)

        if stream_flag:
            return StreamingResponse(
                _stream_response(
                    bridge=bridge,
                    settings=settings,
                    rules=rules,
                    history=history,
                    request_id=request_id,
                    prompt=prompt,
                    conversation=conversation,
                    mode=mode,
                    timeout=timeout,
                    no_sanitize=payload.no_sanitize,
                    model=payload.model or settings.model_id,
                    started=started,
                    source=source,
                    client_label=client_label,
                    is_disconnected=request.is_disconnected,
                    wants_tools=wants_tools,
                    tool_specs=tool_specs,
                    tool_choice=payload.tool_choice,
                ),
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache, no-transform",
                    "Connection": "keep-alive",
                    "X-Accel-Buffering": "no",
                    "X-Request-Id": request_id,
                },
            )

        try:
            result, aborted = await submit_with_disconnect_watch(
                bridge, prompt, mode, timeout,
                conversation=conversation, is_disconnected=request.is_disconnected,
            )
            if aborted:
                logger.info("client disconnected, request %s cancelled", request_id[:8])
                history.record(
                    request_id=request_id,
                    source=source,
                    client=client_label,
                    model=payload.model or settings.model_id,
                    mode=mode,
                    streamed=False,
                    status="aborted",
                    http_status=499,
                    error_code="client_disconnected",
                    error_message="the client closed the connection while the page was answering",
                    prompt=conversation,
                    built_chars=len(prompt),
                    total_ms=int((time.time() - started) * 1000),
                )
                return _error(499, "client disconnected", err_type="client_error",
                             code="client_disconnected")
        except BridgeError as exc:
            logger.warning("request failed: %s (%s)", exc.code, exc.message)
            history.record(
                request_id=request_id,
                source=source,
                client=client_label,
                model=payload.model or settings.model_id,
                mode=mode,
                streamed=False,
                status="error",
                http_status=exc.status_code,
                error_code=exc.code,
                error_message=exc.message,
                prompt=conversation,
                built_chars=len(prompt),
                total_ms=int((time.time() - started) * 1000),
            )
            return _error(exc.status_code, exc.message, err_type="bridge_error", code=exc.code)

        answer = result.get("response") or ""
        answer = answer[: settings.max_response_chars]
        sanitized_text, report = sanitize(
            answer, mode="off" if payload.no_sanitize else settings.sanitize_mode, rules=rules
        )
        if report.changed:
            bridge.total_sanitized += 1
            logger.warning(
                "sanitiser neutralised %d destructive command(s) in the page answer "
                "(request %s)", report.replacements, request_id
            )

        plan = (
            parse_plan(sanitized_text, [spec.name for spec in tool_specs])
            if wants_tools
            else None
        )
        message = ChoiceMessage(role="assistant", content=sanitized_text)
        finish_reason = "stop"
        called_names: List[str] = []
        plan_parsed = True
        if plan is not None:
            plan_parsed = plan.parsed
            if plan.tool_calls:
                calls = to_openai_tool_calls(plan.tool_calls)
                sanitize_plan_calls(
                    calls,
                    mode="off" if payload.no_sanitize else settings.sanitize_mode,
                    rules=rules,
                )
                called_names = [call.function.name for call in calls]
                message = ChoiceMessage(
                    role="assistant",
                    content=plan.final or None,
                    tool_calls=calls,
                )
                finish_reason = "tool_calls"
            elif plan.parsed:
                # clean protocol answer (preamble stripped) for the client
                message = ChoiceMessage(role="assistant", content=plan.final or "")

        meta = BridgeMeta(
            request_id=request_id,
            mode=mode,
            browser_duration_ms=(result.get("meta") or {}).get("duration_ms"),
            total_duration_ms=int((time.time() - started) * 1000),
            queue_wait_ms=result.get("queue_wait_ms"),
            sanitized=report.changed,
            sanitize_mode=report.mode,
            sanitize_findings=[f.as_dict() for f in report.findings[:16]],
            browser_meta=result.get("meta") or {},
            tool_mode=wants_tools,
            tools_offered=tool_names,
            tool_calls=called_names,
            plan_parsed=plan_parsed,
        )
        response = ChatCompletionResponse(
            id=request_id,
            model=payload.model or settings.model_id,
            choices=[Choice(index=0, message=message, finish_reason=finish_reason)],
            usage=Usage.estimate(prompt, sanitized_text),
            x_bridge=meta,
        )
        history.record(
            request_id=request_id,
            source=source,
            client=client_label,
            model=payload.model or settings.model_id,
            mode=mode,
            streamed=False,
            status="ok",
            http_status=200,
            prompt=conversation,
            built_chars=len(prompt),
            response=sanitized_text,
            queue_wait_ms=result.get("queue_wait_ms"),
            browser_duration_ms=(result.get("meta") or {}).get("duration_ms"),
            total_ms=meta.total_duration_ms,
            sanitized=report.changed,
            sanitize_mode=report.mode,
            sanitize_findings=[finding.as_dict() for finding in report.findings[:16]],
            stop_reason=(result.get("meta") or {}).get("stop_reason"),
        )
        return JSONResponse(
            content=response.model_dump(), headers={"X-Request-Id": request_id}
        )

    async def _stream_response(
        *,
        bridge: BrowserBridge,
        settings: Settings,
        rules: List[tuple],
        history: RequestHistory,
        request_id: str,
        prompt: str,
        conversation: str,
        mode: str,
        timeout: float,
        no_sanitize: bool,
        model: str,
        started: float,
        source: str,
        client_label: str,
        is_disconnected,
        wants_tools: bool = False,
        tool_specs: Optional[List[Any]] = None,
        tool_choice: Any = None,
    ) -> AsyncIterator[str]:
        """Emit an OpenAI-style SSE stream.

        The web UI exposes no incremental stream we can trust, so the answer is
        fetched whole and then replayed as chunks.  Clients see a normal SSE
        stream; ``x_bridge.streamed`` marks it as emulated.
        """

        created = int(time.time())
        try:
            first = ChatCompletionChunk(
                id=request_id,
                created=created,
                model=model,
                choices=[ChunkChoice(index=0, delta=Delta(role="assistant", content=""))],
            )
            yield _sse(first.model_dump(exclude_none=True))

            # The client may already be gone (curl --max-time, an aborted
            # fetch): do not burn the browser tab on a dead conversation.
            if await is_disconnected():
                logger.info("client disconnected before submit %s", request_id[:8])
                history.record(
                    request_id=request_id,
                    source=source,
                    client=client_label,
                    model=model,
                    mode=mode,
                    streamed=True,
                    status="aborted",
                    http_status=499,
                    error_code="client_disconnected",
                    error_message="the client closed the stream before the request was submitted",
                    prompt=conversation,
                    built_chars=len(prompt),
                    total_ms=int((time.time() - started) * 1000),
                )
                return

            result, aborted = await submit_with_disconnect_watch(
                bridge, prompt, mode, timeout,
                conversation=conversation, is_disconnected=is_disconnected,
            )
            if aborted:
                logger.info("client disconnected, request %s cancelled", request_id[:8])
                history.record(
                    request_id=request_id,
                    source=source,
                    client=client_label,
                    model=model,
                    mode=mode,
                    streamed=True,
                    status="aborted",
                    http_status=499,
                    error_code="client_disconnected",
                    error_message="the client closed the stream while the page was answering",
                    prompt=conversation,
                    built_chars=len(prompt),
                    total_ms=int((time.time() - started) * 1000),
                )
                return

            answer = (result.get("response") or "")[: settings.max_response_chars]
            sanitized_text, report = sanitize(
                answer, mode="off" if no_sanitize else settings.sanitize_mode, rules=rules
            )
            if report.changed:
                bridge.total_sanitized += 1

            plan = (
                parse_plan(sanitized_text, [spec.name for spec in (tool_specs or [])])
                if wants_tools
                else None
            )
            called_names: List[str] = []
            plan_parsed = True
            finish_reason = "stop"
            stream_text = sanitized_text
            if plan is not None:
                plan_parsed = plan.parsed
                if plan.tool_calls:
                    calls = to_openai_tool_calls(plan.tool_calls)
                    sanitize_plan_calls(
                        calls,
                        mode="off" if no_sanitize else settings.sanitize_mode,
                        rules=rules,
                    )
                    called_names = [call.function.name for call in calls]
                    stream_tool_call_deltas(calls)
                    yield _sse(
                        ChatCompletionChunk(
                            id=request_id,
                            created=created,
                            model=model,
                            choices=[
                                ChunkChoice(
                                    index=0,
                                    delta=Delta(
                                        role="assistant",
                                        content=None,
                                        tool_calls=calls,
                                    ),
                                )
                            ],
                        ).model_dump(exclude_none=True)
                    )
                    finish_reason = "tool_calls"
                elif plan.parsed:
                    stream_text = plan.final or ""
            if finish_reason == "stop":
                chunks = _split_for_stream(stream_text, settings.stream_chunk_chars)
                if not chunks and stream_text:
                    chunks = [stream_text]
            else:
                chunks = []
            for chunk in chunks:
                if await is_disconnected():
                    logger.info("client disconnected mid-stream %s", request_id)
                    history.record(
                        request_id=request_id,
                        source=source,
                        client=client_label,
                        model=model,
                        mode=mode,
                        streamed=True,
                        status="aborted",
                        http_status=499,
                        error_code="client_disconnected",
                        error_message="the client closed the SSE stream while replaying chunks",
                        prompt=conversation,
                        built_chars=len(prompt),
                        response=sanitized_text,
                        queue_wait_ms=result.get("queue_wait_ms"),
                        browser_duration_ms=(result.get("meta") or {}).get("duration_ms"),
                        total_ms=int((time.time() - started) * 1000),
                        sanitized=report.changed,
                        sanitize_mode=report.mode,
                        sanitize_findings=[finding.as_dict() for finding in report.findings[:16]],
                    )
                    return
                payload = ChatCompletionChunk(
                    id=request_id,
                    created=created,
                    model=model,
                    choices=[ChunkChoice(index=0, delta=Delta(content=chunk))],
                )
                yield _sse(payload.model_dump(exclude_none=True))
                if settings.stream_chunk_delay_ms:
                    await asyncio.sleep(settings.stream_chunk_delay_ms / 1000.0)

            meta = BridgeMeta(
                request_id=request_id,
                mode=mode,
                browser_duration_ms=(result.get("meta") or {}).get("duration_ms"),
                total_duration_ms=int((time.time() - started) * 1000),
                queue_wait_ms=result.get("queue_wait_ms"),
                sanitized=report.changed,
                sanitize_mode=report.mode,
                sanitize_findings=[f.as_dict() for f in report.findings[:16]],
                browser_meta=result.get("meta") or {},
                streamed=True,
                tool_mode=wants_tools,
                tools_offered=[spec.name for spec in (tool_specs or [])],
                tool_calls=called_names,
                plan_parsed=plan_parsed,
            )
            final = ChatCompletionChunk(
                id=request_id,
                created=created,
                model=model,
                choices=[ChunkChoice(index=0, delta=Delta(), finish_reason=finish_reason)],
                x_bridge=meta,
            )
            history.record(
                request_id=request_id,
                source=source,
                client=client_label,
                model=model,
                mode=mode,
                streamed=True,
                status="ok",
                http_status=200,
                prompt=conversation,
                built_chars=len(prompt),
                response=sanitized_text,
                queue_wait_ms=result.get("queue_wait_ms"),
                browser_duration_ms=(result.get("meta") or {}).get("duration_ms"),
                total_ms=meta.total_duration_ms,
                sanitized=report.changed,
                sanitize_mode=report.mode,
                sanitize_findings=[finding.as_dict() for finding in report.findings[:16]],
                stop_reason=(result.get("meta") or {}).get("stop_reason"),
            )
            yield _sse(final.model_dump(exclude_none=True))
            yield "data: [DONE]\n\n"
        except BridgeError as exc:
            logger.warning("stream failed: %s (%s)", exc.code, exc.message)
            history.record(
                request_id=request_id,
                source=source,
                client=client_label,
                model=model,
                mode=mode,
                streamed=True,
                status="error",
                http_status=exc.status_code,
                error_code=exc.code,
                error_message=exc.message,
                prompt=conversation,
                built_chars=len(prompt),
                total_ms=int((time.time() - started) * 1000),
            )
            yield _sse(
                {
                    "error": {
                        "message": exc.message,
                        "type": "bridge_error",
                        "code": exc.code,
                    },
                    "id": request_id,
                }
            )
            yield "data: [DONE]\n\n"
        except asyncio.CancelledError:  # pragma: no cover - client hangup
            raise

    # ------------------------------------------------------------------
    # status / diagnostics
    # ------------------------------------------------------------------
    # The bare `/v1` prefix has no OpenAI counterpart, but clients (and
    # humans opening the base URL in a browser) probe it - answer with a
    # small index instead of FastAPI's 404 "Not Found".
    @app.get("/v1", include_in_schema=False)
    async def v1_root() -> Dict[str, Any]:
        return {
            "object": "api",
            "message": "ArenaAgentBridge - local OpenAI-compatible bridge to the arena.ai web UI",
            "models": "/v1/models",
            "chat": "/v1/chat/completions",
            "status": "/v1/bridge/status",
        }

    @app.get("/v1/", include_in_schema=False)
    async def v1_root_slash() -> Dict[str, Any]:
        return await v1_root()

    @app.get("/v1/bridge/status")
    @app.get("/bridge/status", include_in_schema=False)
    async def status(_: None = Depends(require_auth)) -> Dict[str, Any]:
        # Prompt previews only for authenticated callers (the OpenAI-style
        # surface and the admin API share the same token): the public view
        # must not leak queued prompts to any page on the machine.
        data = bridge.stats(include_previews=settings.require_api_key)
        data["history"] = history.summary()
        data["panel"] = {"enabled": settings.panel_enabled, "url": "/admin"}
        data["settings"] = {
            "model_ids": settings.model_ids,
            "default_mode": settings.default_mode,
            "request_timeout": settings.request_timeout,
            "sanitize_mode": settings.sanitize_mode,
            "require_api_key": settings.require_api_key,
            "cors_origin_regex": settings.cors_origin_regex,
            "max_prompt_chars": settings.max_prompt_chars,
        }
        return data

    @app.get("/healthz")
    async def healthz() -> Dict[str, Any]:
        return {"status": "ok", "version": settings.version, "uptime_s": bridge.stats()
                ["server"]["uptime_s"]}

    @app.get("/readyz")
    async def readyz() -> JSONResponse:
        if bridge.has_client():
            return JSONResponse({"ready": True, "browser": "connected"})
        return JSONResponse(
            status_code=503,
            content={
                "ready": False,
                "browser": "disconnected",
                "hint": "open https://arena.ai/agent in Chrome with the extension installed",
            },
        )

    @app.get("/", response_class=HTMLResponse, include_in_schema=False)
    async def index():
        # With the panel enabled (default) `/` *is* the panel; the tiny fallback
        # page below is only served when the panel is switched off.
        if settings.panel_enabled:
            return render_panel_page(settings)
        stats = bridge.stats()
        browser = (
            f'<span class="ok">connected</span> ({stats["browser"]["clients"][0]["client"]})'
            if bridge.has_client()
            else '<span class="bad">disconnected</span>'
        )
        return STATUS_HTML.format(
            version=settings.version,
            browser=browser,
            queue=f'{stats["server"]["queue_depth"]} waiting / {stats["server"]["queue_max"]} max',
            requests=stats["totals"]["requests"],
            errors=stats["totals"]["errors"],
            port=settings.port,
        )

    # ------------------------------------------------------------------
    # extension WebSocket
    # ------------------------------------------------------------------
    @app.websocket("/ws/browser")
    async def ws_browser(ws: WebSocket) -> None:
        # Who is this?  A browser tab always sends an ``Origin``; the content
        # script runs inside arena.ai, so its socket carries the tab origin.
        # Anything else - a random web page speaking the protocol - is
        # rejected *before* the handshake.  Non-browser clients (CLI, curl,
        # tests) send no Origin and are allowed: the server is loopback-only.
        origin = (ws.headers.get("origin") or "").strip()
        if not settings.ws_origin_allowed(origin):
            logger.warning("rejecting /ws/browser from foreign origin %r", origin)
            await ws.close(code=4403)
            return

        # Optional shared secret (AAB_WS_TOKEN): presented as ?token=… in the
        # URL or inside the hello frame.  Checked after accept, because the
        # token may travel in the first frame.
        ws_token_presented: Optional[str] = None
        with contextlib.suppress(Exception):
            parsed = urllib.parse.urlsplit(str(ws.url))
            ws_token_presented = urllib.parse.parse_qs(parsed.query).get("token", [None])[0]

        await ws.accept()
        client = None
        try:
            # The extension sends `hello` right away; tolerate older clients that
            # start sending heartbeats instead.
            while client is None:
                try:
                    first = await asyncio.wait_for(
                        ws.receive_json(), timeout=settings.client_hello_timeout
                    )
                except asyncio.TimeoutError:
                    await ws.send_json({"type": "error", "error": "hello_timeout"})
                    await ws.close(code=4008)
                    return
                if not isinstance(first, dict):
                    continue
                if settings.ws_token:
                    presented = ws_token_presented
                    if presented is None and first.get("type") == "hello":
                        presented = first.get("token")
                    if presented != settings.ws_token:
                        logger.warning("rejecting /ws/browser: bad or missing token")
                        await ws.send_json({"type": "error", "error": "bad_token"})
                        await ws.close(code=4401)
                        return
                client = await bridge.connect(ws, first if first.get("type") == "hello" else {})
                await bridge.handle_message(client, first)

            while True:
                message = await ws.receive_json()
                if not isinstance(message, dict):
                    continue
                await bridge.handle_message(client, message)
        except WebSocketDisconnect:
            pass
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("websocket error: %s", exc)
        finally:
            if client is not None:
                await bridge.disconnect(client)
            with contextlib.suppress(Exception):
                await ws.close()

    # ------------------------------------------------------------------
    @app.exception_handler(RequestValidationError)
    async def request_validation_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
        """OpenAI-style 400 for malformed API bodies (FastAPI would answer 422).

        The admin surface keeps the native 422 contract.
        """

        if not request.url.path.startswith(("/v1", "/chat/completions", "/models")):
            return JSONResponse(status_code=422, content={"detail": exc.errors()})
        parts = []
        for err in exc.errors()[:8]:
            loc = ".".join(str(x) for x in err.get("loc", ()) if x != "body") or "body"
            parts.append(f"{loc}: {err.get('msg', 'invalid value')}")
        message = "invalid request body - " + "; ".join(parts)
        logger.warning("request validation failed: %s", message)
        return JSONResponse(
            status_code=400,
            content={
                "error": {
                    "message": message,
                    "type": "invalid_request_error",
                    "param": None,
                    "code": "invalid_body",
                }
            },
        )

    @app.exception_handler(HTTPException)
    async def http_exception_handler(_: Request, exc: HTTPException):
        return _error(exc.status_code, str(exc.detail), err_type="authentication_error"
                      if exc.status_code == 401 else "invalid_request_error")

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception):
        # The exception text (and its traceback) is logged on the server, never
        # echoed to the client: it can carry settings, paths or other secrets.
        logger.exception("unhandled error %s %s: %s", request.method, request.url.path, exc)
        return _error(500, "internal bridge error - see the server logs", err_type="server_error",
                      code="internal_error")

    # ------------------------------------------------------------------
    # HEAD twins for every GET route
    # ------------------------------------------------------------------
    # Clients like Hermes validate a custom endpoint with `curl -I` (HEAD)
    # before trusting it; a GET-only route answers 405 and the client marks
    # the whole bridge as unreachable.  Registered as separate, schema-hidden
    # routes - an `api_route(methods=["GET", "HEAD"])` would trip FastAPI's
    # duplicate-operation-id warning (one route = one operation id).
    for route in list(app.router.routes):
        if not isinstance(route, APIRoute) or "GET" not in route.methods or "HEAD" in route.methods:
            continue
        app.add_api_route(
            route.path,
            route.endpoint,
            methods=["HEAD"],
            response_model=route.response_model,
            status_code=route.status_code,
            response_class=route.response_class,
            dependencies=list(route.dependencies),
            name=f"{route.name}_head",
            include_in_schema=False,
            response_model_exclude_unset=route.response_model_exclude_unset,
            response_model_exclude_defaults=route.response_model_exclude_defaults,
            response_model_exclude_none=route.response_model_exclude_none,
        )

    return app


# ---------------------------------------------------------------------------
def _configure_logging(level: str, as_json: bool) -> None:
    handler = logging.StreamHandler(sys.stdout)
    if as_json:
        class _JsonFormatter(logging.Formatter):
            def format(self, record: logging.LogRecord) -> str:
                payload = {
                    "ts": round(record.created, 3),
                    "level": record.levelname,
                    "logger": record.name,
                    "message": record.getMessage(),
                }
                if record.exc_info:
                    payload["exc"] = self.formatException(record.exc_info)
                return json.dumps(payload, ensure_ascii=False)

        handler.setFormatter(_JsonFormatter())
    else:
        handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)-7s %(name)s | %(message)s", "%H:%M:%S")
        )
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(getattr(logging, level, logging.INFO))


def main() -> None:  # pragma: no cover - process bootstrap
    import uvicorn

    settings = get_settings(reload=True)
    _configure_logging(settings.log_level, settings.log_json)
    uvicorn.run(
        "server.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
        ws_ping_interval=None,  # we implement our own heartbeat
        ws_ping_timeout=None,
        reload=False,
    )


_settings = get_settings()
_configure_logging(_settings.log_level, _settings.log_json)
app = create_app(_settings)


if __name__ == "__main__":  # pragma: no cover
    main()
