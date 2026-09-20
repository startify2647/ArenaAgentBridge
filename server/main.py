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
``GET  /``                      small HTML dashboard (handy for a quick look)
``GET  /healthz`` ``GET /readyz``
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import sys
import time
from typing import Any, AsyncIterator, Dict, List, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse

from .config import Settings, get_settings
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
    new_id,
)
from .prompt_builder import PromptBuildError, build_prompt
from .sanitizer import load_rules, sanitize
from .websocket_manager import BridgeError, BrowserBridge

logger = logging.getLogger("aab.server")

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


def create_app(settings: Optional[Settings] = None) -> FastAPI:
    settings = settings or get_settings()
    bridge = BrowserBridge(settings)
    rules = load_rules(settings.patterns_file)

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
    )
    app.state.settings = settings
    app.state.bridge = bridge

    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=settings.cors_origin_regex,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    async def require_auth(authorization: Optional[str] = Header(default=None)) -> None:
        if not settings.require_api_key:
            return
        token = ""
        if authorization:
            token = authorization.split(" ", 1)[1].strip() if " " in authorization else authorization
        if token != settings.api_key:
            raise HTTPException(status_code=401, detail="invalid api key")

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

        # The requested model can select the prompt wrapper: `*-direct` skips the
        # agent preamble.  Resolve it *before* building the prompt.
        requested_mode = payload.mode or (
            "direct" if str(payload.model or "").endswith("-direct") else None
        )
        try:
            prompt, mode = build_prompt(payload.messages, settings, requested_mode)
        except PromptBuildError as exc:
            return _error(400, str(exc), code="invalid_messages")

        if payload.model and payload.model not in settings.model_ids:
            logger.info("client asked for unknown model %r - serving %s", payload.model, settings.model_id)

        timeout = settings.clamp_timeout(payload.timeout)
        if payload.n and payload.n > 1:
            logger.warning("n=%s requested; the bridge always returns a single choice", payload.n)

        if payload.stream:
            return StreamingResponse(
                _stream_response(
                    bridge=bridge,
                    settings=settings,
                    rules=rules,
                    request_id=request_id,
                    prompt=prompt,
                    mode=mode,
                    timeout=timeout,
                    no_sanitize=payload.no_sanitize,
                    model=payload.model or settings.model_id,
                    started=started,
                    is_disconnected=request.is_disconnected,
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
            result = await bridge.submit(prompt, mode, timeout)
        except BridgeError as exc:
            logger.warning("request failed: %s (%s)", exc.code, exc.message)
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
        )
        response = ChatCompletionResponse(
            id=request_id,
            model=payload.model or settings.model_id,
            choices=[
                Choice(index=0, message=ChoiceMessage(role="assistant", content=sanitized_text))
            ],
            usage=Usage.estimate(prompt, sanitized_text),
            x_bridge=meta,
        )
        return JSONResponse(
            content=response.model_dump(), headers={"X-Request-Id": request_id}
        )

    async def _stream_response(
        *,
        bridge: BrowserBridge,
        settings: Settings,
        rules: List[tuple],
        request_id: str,
        prompt: str,
        mode: str,
        timeout: float,
        no_sanitize: bool,
        model: str,
        started: float,
        is_disconnected,
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

            result = await bridge.submit(prompt, mode, timeout)
            answer = (result.get("response") or "")[: settings.max_response_chars]
            sanitized_text, report = sanitize(
                answer, mode="off" if no_sanitize else settings.sanitize_mode, rules=rules
            )
            if report.changed:
                bridge.total_sanitized += 1

            chunks = _split_for_stream(sanitized_text, settings.stream_chunk_chars)
            if not chunks and sanitized_text:
                chunks = [sanitized_text]
            for chunk in chunks:
                if await is_disconnected():
                    logger.info("client disconnected mid-stream %s", request_id)
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
            )
            final = ChatCompletionChunk(
                id=request_id,
                created=created,
                model=model,
                choices=[ChunkChoice(index=0, delta=Delta(), finish_reason="stop")],
                x_bridge=meta,
            )
            yield _sse(final.model_dump(exclude_none=True))
            yield "data: [DONE]\n\n"
        except BridgeError as exc:
            logger.warning("stream failed: %s (%s)", exc.code, exc.message)
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
    @app.get("/v1/bridge/status")
    @app.get("/bridge/status", include_in_schema=False)
    async def status() -> Dict[str, Any]:
        data = bridge.stats()
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
    async def index() -> str:
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
    @app.exception_handler(HTTPException)
    async def http_exception_handler(_: Request, exc: HTTPException):
        return _error(exc.status_code, str(exc.detail), err_type="authentication_error"
                      if exc.status_code == 401 else "invalid_request_error")

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(_: Request, exc: Exception):
        logger.exception("unhandled error: %s", exc)
        return _error(500, f"internal bridge error: {exc}", err_type="server_error")

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
