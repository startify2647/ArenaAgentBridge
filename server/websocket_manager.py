"""Browser connection manager: one browser client, one in-flight request.

Design notes
------------
* A single ``asyncio.Queue`` feeds a single worker coroutine, so requests are
  serialised - the web UI can only work on one prompt at a time and parallel
  DOM automation on the same tab produces garbage.
* Each queued item carries its own ``asyncio.Future``; the WebSocket reader
  resolves it when the extension reports back.  Timeouts never cancel the task
  that is waiting on the HTTP side of the bridge, they resolve the future with a
  sentinel so the worker can move on.
* The server pings the extension; the extension also sends ``heartbeat``
  messages.  A client that misses ``AAB_CLIENT_HELLO_TIMEOUT`` worth of pings is
  considered dead and dropped, which fails the in-flight request immediately
  instead of letting it burn the full 300s timeout.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from fastapi import WebSocket

from .config import Settings
from .models import BrowserRequest

logger = logging.getLogger("aab.bridge")


class BridgeError(RuntimeError):
    """A request could not be answered by the browser."""

    def __init__(self, code: str, message: str, status_code: int = 502) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


@dataclass
class BrowserClient:
    ws: WebSocket
    client: str = "unknown"
    version: Optional[str] = None
    url: Optional[str] = None
    connected_at: float = field(default_factory=time.time)
    last_seen: float = field(default_factory=time.time)
    state: str = "idle"
    busy: bool = False
    heartbeat_count: int = 0
    answered: int = 0

    @property
    def is_alive(self) -> bool:
        return True

    def touch(self) -> None:
        self.last_seen = time.time()

    def info(self) -> Dict[str, Any]:
        return {
            "client": self.client,
            "version": self.version,
            "url": self.url,
            "state": self.state,
            "busy": self.busy,
            "connected_at": self.connected_at,
            "connected_for_s": round(time.time() - self.connected_at, 1),
            "last_seen_ago_s": round(time.time() - self.last_seen, 1),
            "answered": self.answered,
            "heartbeats": self.heartbeat_count,
        }


@dataclass
class PendingRequest:
    id: str
    prompt: str
    mode: str
    timeout: float
    future: "asyncio.Future[Dict[str, Any]]"
    #: what the client actually sent (the agent preamble stripped) - the panel
    #: shows this, because recognising your own question beats reading the wrapper
    conversation: str = ""
    created_at: float = field(default_factory=time.time)
    enqueued_at: float = field(default_factory=time.time)
    sent_at: Optional[float] = None
    #: set when a reconnected tab received the request again
    resent_at: Optional[float] = None
    client: Optional[BrowserClient] = None
    finished: bool = False

    def queue_wait_ms(self) -> Optional[int]:
        if self.sent_at is None:
            return None
        return int((self.sent_at - self.enqueued_at) * 1000)

    def browser_duration_ms(self) -> Optional[int]:
        if self.sent_at is None:
            return None
        if not self.finished:
            return int((time.time() - self.sent_at) * 1000)
        return None


class BrowserBridge:
    """Owns the WebSocket connection(s) to the Chrome extension."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.clients: List[BrowserClient] = []
        self._queue: "asyncio.Queue[Optional[PendingRequest]]" = asyncio.Queue(
            maxsize=settings.queue_max_size
        )
        self._pending: Dict[str, PendingRequest] = {}
        self._worker: Optional[asyncio.Task] = None
        self._pinger: Optional[asyncio.Task] = None
        self._client_ready = asyncio.Event()
        self._running = False
        #: request-id -> future, for ``diagnose`` round-trips to the extension
        self._diagnostics: Dict[str, "asyncio.Future[Dict[str, Any]]"] = {}
        #: grace timers that fail orphaned requests when no tab reconnects
        self._orphan_tasks: set = set()

        # stats
        self.started_at = time.time()
        self.total_requests = 0
        self.total_errors = 0
        self.total_timeouts = 0
        self.total_sanitized = 0
        self.last_errors: List[Dict[str, Any]] = []
        self.latencies_ms: List[int] = []
        self.last_request_at: Optional[float] = None
        self.last_duration_ms: Optional[int] = None

    # ------------------------------------------------------------------
    # lifecycle
    # ------------------------------------------------------------------
    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._worker = asyncio.create_task(self._worker_loop(), name="aab-bridge-worker")
        self._pinger = asyncio.create_task(self._ping_loop(), name="aab-bridge-pinger")
        logger.info("browser bridge started (queue_max=%s)", self.settings.queue_max_size)

    async def stop(self) -> None:
        self._running = False
        for task in (self._worker, self._pinger):
            if task is not None:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task
        self._worker = None
        self._pinger = None
        for pending in list(self._pending.values()):
            if not pending.future.done():
                pending.future.set_result(
                    {"error": "server_shutdown", "response": None, "meta": {}}
                )
        self._pending.clear()
        for task in list(self._orphan_tasks):
            task.cancel()
        self._orphan_tasks.clear()
        for client in list(self.clients):
            with contextlib.suppress(Exception):
                await client.ws.close(code=1001)
        self.clients.clear()

    # ------------------------------------------------------------------
    # connection handling
    # ------------------------------------------------------------------
    async def connect(self, ws: WebSocket, hello: Optional[Dict[str, Any]] = None) -> BrowserClient:
        client = BrowserClient(
            ws=ws,
            client=str((hello or {}).get("client") or "chrome-extension"),
            version=(hello or {}).get("version"),
            url=(hello or {}).get("url"),
        )
        # If a stale tab is still registered, drop it - the newest tab wins.
        if self.settings.single_client and self.clients:
            for old in list(self.clients):
                logger.info("replacing previous browser client %s", old.client)
                with contextlib.suppress(Exception):
                    await old.ws.send_json(
                        {"type": "replaced", "reason": "another arena.ai tab connected"}
                    )
                with contextlib.suppress(Exception):
                    await old.ws.close(code=4000)
                self._remove_client(old)
                self._orphan_pending_for(old)
        self.clients.append(client)
        self._client_ready.set()
        # A tab that reconnected after a socket blink takes over the requests
        # that were in flight on the dead connection (they are only failed
        # once the grace window below expires).
        await self._resend_orphans(client)
        logger.info("browser connected: %s v%s url=%s", client.client, client.version, client.url)
        return client

    def _remove_client(self, client: BrowserClient) -> None:
        if client in self.clients:
            self.clients.remove(client)
        if not self.clients:
            self._client_ready.clear()

    async def disconnect(self, client: BrowserClient) -> None:
        self._remove_client(client)
        self._orphan_pending_for(client)
        logger.info("browser disconnected: %s", client.client)

    # ------------------------------------------------------------------
    # reconnect grace
    # ------------------------------------------------------------------
    def _orphan_pending_for(self, client: BrowserClient) -> None:
        """Detach in-flight requests from a dropped client.

        The tab usually reconnects within a few seconds (the extension retries
        with backoff, and it queues answers it could not send), so the requests
        get a short grace window instead of failing on the spot: a client that
        reconnects in time has them re-sent, and only a tab that stays gone
        surfaces as ``browser_disconnected``.
        """

        grace = max(0.0, float(self.settings.reconnect_grace_s))
        for _request_id, pending in list(self._pending.items()):
            if pending.finished or pending.client is not client:
                continue
            pending.client = None
            if grace <= 0:
                self._fail_orphan(pending)
                continue
            task = asyncio.get_running_loop().create_task(
                self._expire_orphan_later(pending, time.time() + grace)
            )
            self._orphan_tasks.add(task)
            task.add_done_callback(self._orphan_tasks.discard)

    def _fail_orphan(self, pending: PendingRequest) -> None:
        self._pending.pop(pending.id, None)
        pending.finished = True
        if not pending.future.done():
            pending.future.set_result(
                {
                    "error": "browser_disconnected",
                    "response": None,
                    "meta": {
                        "message": "the arena.ai tab/extension disconnected mid-request",
                        "status_code": 502,
                    },
                }
            )

    async def _expire_orphan_later(self, pending: PendingRequest, deadline: float) -> None:
        try:
            await asyncio.sleep(max(0.05, deadline - time.time()))
        except asyncio.CancelledError:
            return
        if pending.finished or pending.client is not None:
            return  # answered, cancelled or already taken over by a new tab
        if self._pending.get(pending.id) is not pending:
            return
        self._fail_orphan(pending)
        logger.warning(
            "request %s failed: the browser did not reconnect within the grace window",
            pending.id[:8],
        )

    async def _resend_orphans(self, client: BrowserClient) -> None:
        """Hand the requests of a dead connection to a (re)connecting client."""

        orphans = [
            pending
            for pending in list(self._pending.values())
            if not pending.finished and pending.client is None and pending.sent_at is not None
        ]
        for pending in orphans:
            payload = BrowserRequest(
                id=pending.id,
                prompt=pending.prompt,
                mode=pending.mode,
                timeout=pending.timeout,
            ).model_dump()
            try:
                await client.ws.send_json(payload)
            except Exception:
                self._fail_orphan(pending)
                continue
            pending.client = client
            again = " again" if pending.resent_at else ""
            pending.resent_at = time.time()
            client.busy = True
            client.state = "answering"
            logger.info("request %s re-sent to the reconnected browser%s", pending.id[:8], again)

    def active_client(self) -> Optional[BrowserClient]:
        return self.clients[-1] if self.clients else None

    def has_client(self) -> bool:
        return bool(self.clients)

    async def handle_message(self, client: BrowserClient, payload: Dict[str, Any]) -> None:
        client.touch()
        msg_type = str(payload.get("type") or "").lower()

        if msg_type in ("hello", "register"):
            client.client = str(payload.get("client") or client.client)
            client.version = payload.get("version") or client.version
            client.url = payload.get("url") or client.url
            await client.ws.send_json(
                {
                    "type": "welcome",
                    "version": self.settings.version,
                    "queue": self.queue_depth(),
                    "timeout_default": self.settings.request_timeout,
                }
            )
            return

        if msg_type == "pong":
            return

        if msg_type == "heartbeat":
            client.heartbeat_count += 1
            if payload.get("state"):
                client.state = str(payload["state"])
            if "busy" in payload:
                client.busy = bool(payload["busy"])
            if payload.get("url"):
                client.url = str(payload["url"])
            return

        if msg_type == "response":
            self._resolve(payload)
            return

        if msg_type == "error":
            self._resolve(
                {
                    "id": payload.get("id"),
                    "error": payload.get("error") or "browser error",
                    "meta": payload.get("meta") or {},
                }
            )
            return

        if msg_type == "status":
            client.state = str(payload.get("state") or client.state)
            logger.debug("browser status: %s", payload)
            return

        if msg_type in ("diag", "diagnostics"):
            self._resolve_diagnostics(payload)
            return

        logger.warning("unknown message type from browser: %s", msg_type)

    def _resolve(self, payload: Dict[str, Any]) -> None:
        request_id = str(payload.get("id") or "")
        pending = self._pending.pop(request_id, None)
        if pending is None:
            logger.warning("response for unknown/expired request id %s", request_id)
            return
        pending.finished = True
        if pending.client is not None:
            pending.client.busy = False
            pending.client.answered += 1
        if not pending.future.done():
            pending.future.set_result(
                {
                    "id": request_id,
                    "response": payload.get("response"),
                    "error": payload.get("error"),
                    "meta": payload.get("meta") or {},
                }
            )

    def _resolve_diagnostics(self, payload: Dict[str, Any]) -> None:
        ident = str(payload.get("id") or "")
        future = self._diagnostics.pop(ident, None)
        if future is None:
            logger.debug("diagnostics payload for an unknown id %s", ident)
            return
        if not future.done():
            future.set_result({key: value for key, value in payload.items() if key not in {"id", "type"}})

    # ------------------------------------------------------------------
    # control surface (admin panel)
    # ------------------------------------------------------------------
    def set_queue_max(self, size: int) -> int:
        """Resize the waiting queue without dropping what is already in it."""

        size = max(1, int(size))
        self._queue._maxsize = size  # noqa: SLF001 - asyncio offers no setter
        self.settings.queue_max_size = size
        return size

    def pending_requests(self) -> List[Dict[str, Any]]:
        """Everything that is queued or currently typed into the page."""

        rows: List[Dict[str, Any]] = []
        for pending in list(self._pending.values()):
            if pending.finished:
                continue
            rows.append(
                {
                    "id": pending.id,
                    "mode": pending.mode,
                    "created_at": pending.created_at,
                    "sent_at": pending.sent_at,
                    "queued_for_s": round((pending.sent_at or time.time()) - pending.enqueued_at, 2),
                    "running_for_s": pending.browser_duration_ms() / 1000
                    if pending.browser_duration_ms() is not None
                    else None,
                    "timeout": pending.timeout,
                    "prompt_preview": (pending.conversation or pending.prompt)[:400],
                    "prompt_chars": len(pending.conversation or pending.prompt),
                    "built_chars": len(pending.prompt),
                }
            )
        return sorted(rows, key=lambda row: row["created_at"])

    async def cancel_pending(self, reason: str = "cancelled", notify_browser: bool = True) -> Dict[str, Any]:
        """Fail every queued/in-flight request and tell the page to stop.

        Queued requests are resolved directly (the worker skips a future that is
        already done); the one in the page gets a ``cancel`` message so the
        extension stops capturing.
        """

        cancelled: List[str] = []
        client = self.active_client()
        for request_id, pending in list(self._pending.items()):
            if pending.finished:
                continue
            self._pending.pop(request_id, None)
            pending.finished = True
            if not pending.future.done():
                pending.future.set_result(
                    {
                        "error": "cancelled",
                        "response": None,
                        "meta": {"message": reason, "status_code": 499},
                    }
                )
            cancelled.append(request_id)
            if notify_browser and pending.sent_at is not None and client is not None:
                with contextlib.suppress(Exception):
                    await client.ws.send_json(
                        {"type": "cancel", "id": request_id, "reason": reason}
                    )
        if client is not None:
            client.busy = False
            if client.state == "answering":
                client.state = "idle"
        if cancelled:
            logger.info("cancelled %d request(s) from the admin panel", len(cancelled))
        return {"cancelled": len(cancelled), "ids": cancelled}

    async def disconnect_all(self, reason: str = "disconnected") -> int:
        """Drop every browser client (the extension reconnects on its own)."""

        dropped = 0
        for client in list(self.clients):
            with contextlib.suppress(Exception):
                await client.ws.send_json({"type": "shutdown", "reason": reason})
            with contextlib.suppress(Exception):
                await client.ws.close(code=4004)
            await self.disconnect(client)
            dropped += 1
        return dropped

    async def ping_clients(self) -> int:
        """Send a keepalive ping to every connected client."""

        sent = 0
        for client in list(self.clients):
            with contextlib.suppress(Exception):
                await client.ws.send_json({"type": "ping", "ts": time.time()})
                sent += 1
        return sent

    async def request_diagnostics(self, timeout: float = 8.0) -> Dict[str, Any]:
        """Ask the extension to describe the live page (selector hits, captcha…)."""

        client = self.active_client()
        if client is None:
            raise BridgeError(
                "browser_offline",
                "no extension is connected - load dist/chrome and open https://arena.ai/agent",
                status_code=503,
            )
        loop = asyncio.get_running_loop()
        ident = str(uuid.uuid4())
        future: "asyncio.Future[Dict[str, Any]]" = loop.create_future()
        self._diagnostics[ident] = future
        try:
            await client.ws.send_json({"type": "diagnose", "id": ident})
        except Exception as exc:
            self._diagnostics.pop(ident, None)
            raise BridgeError(
                "browser_disconnected", f"could not ask the page: {exc}", status_code=502
            ) from exc
        try:
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError as exc:
            raise BridgeError(
                "diagnostics_timeout",
                "the extension did not answer the diagnostics request - is the "
                "arena.ai tab still open? (older extension builds ignore it)",
                status_code=504,
            ) from exc
        finally:
            self._diagnostics.pop(ident, None)

    # ------------------------------------------------------------------
    # queue / worker
    # ------------------------------------------------------------------
    def queue_depth(self) -> int:
        return self._queue.qsize()

    async def submit(
        self,
        prompt: str,
        mode: str,
        timeout: float,
        conversation: str = "",
    ) -> Dict[str, Any]:
        """Enqueue a prompt and wait for the browser answer.

        Raises :class:`BridgeError` on failure.
        """

        if self._queue.full():
            raise BridgeError(
                "queue_full",
                f"the bridge queue is full ({self.settings.queue_max_size} waiting "
                "requests); retry later or raise AAB_QUEUE_MAX_SIZE",
                status_code=429,
            )

        loop = asyncio.get_running_loop()
        pending = PendingRequest(
            id=str(uuid.uuid4()),
            prompt=prompt,
            mode=mode,
            timeout=timeout,
            conversation=conversation,
            future=loop.create_future(),
        )
        self._pending[pending.id] = pending
        await self._queue.put(pending)
        self.total_requests += 1
        self.last_request_at = time.time()

        try:
            result = await asyncio.wait_for(
                asyncio.shield(pending.future), timeout=timeout + 30.0
            )
        except asyncio.TimeoutError as exc:
            self.total_timeouts += 1
            self._pending.pop(pending.id, None)
            pending.finished = True
            if not pending.future.done():
                pending.future.set_result({"error": "timeout", "response": None, "meta": {}})
            raise BridgeError(
                "timeout",
                f"no answer from the browser within {timeout:.0f}s "
                "(the page may be stuck, logged out or showing a captcha)",
                status_code=504,
            ) from exc

        error = result.get("error")
        if error:
            self.total_errors += 1
            self._remember_error(str(error), result.get("meta") or {})
            raise self._bridge_error_for(str(error), result.get("meta") or {})

        result["queue_wait_ms"] = pending.queue_wait_ms()
        self._record_latency(result.get("meta") or {})
        return result

    def _record_latency(self, meta: Dict[str, Any]) -> None:
        duration = meta.get("duration_ms")
        if isinstance(duration, (int, float)):
            self.last_duration_ms = int(duration)
            self.latencies_ms.append(int(duration))
            window = max(1, self.settings.stats_window)
            if len(self.latencies_ms) > window:
                del self.latencies_ms[:-window]

    def _remember_error(self, code: str, meta: Dict[str, Any]) -> None:
        self.last_errors.append(
            {
                "at": time.time(),
                "code": code,
                "message": str(meta.get("message") or "")[:300],
            }
        )
        if len(self.last_errors) > 20:
            del self.last_errors[:-20]

    @staticmethod
    def _bridge_error_for(code: str, meta: Dict[str, Any]) -> BridgeError:
        status = int(meta.get("status_code") or 502)
        friendly = {
            "timeout": (
                "page_timeout",
                "the arena.ai page did not finish answering before the timeout; "
                "check the tab for a captcha, a login prompt or a stalled generation",
                504,
            ),
            "no_tab": (
                "browser_tab_missing",
                "the extension is connected but no arena.ai/agent tab is open; "
                "open https://arena.ai/agent in Chrome and keep it in the background",
                503,
            ),
            "no_browser": (
                "browser_offline",
                "no Chrome extension is connected to the bridge; start Chrome and "
                "open https://arena.ai/agent",
                503,
            ),
            "not_logged_in": (
                "login_required",
                "the arena.ai tab is not logged in - sign in manually in Chrome, the "
                "bridge never touches credentials",
                502,
            ),
            "captcha": (
                "captcha_required",
                "a captcha was detected; solve it manually in the arena.ai tab, the "
                "bridge does not bypass captchas",
                409,
            ),
            "selector_missing": (
                "dom_changed",
                "the extension could not find the input box / send button; update the "
                "selectors in extensions/shared/config.js (popup -> Diagnose DOM)",
                502,
            ),
            "response_timeout": (
                "page_timeout",
                "the page stopped producing output before a stable answer was reached",
                504,
            ),
            "no_output": (
                "page_timeout",
                "the page produced no readable answer within the capture window - the "
                "model may have answered but the selectors/stream no longer match the "
                "site; run Diagnose DOM (popup) and update extensions/shared/config.js",
                504,
            ),
            "site_idle": (
                "page_timeout",
                "the arena.ai tab (and its own stream) stopped changing while the "
                "request was running - the page is frozen, suspended or the session "
                "ended; check the tab, raise behavior.IDLE_STALL_MS if the page is "
                "legitimately quiet for that long",
                504,
            ),
            "busy": (
                "browser_busy",
                "the tab is already answering another request",
                409,
            ),
            "cancelled": ("cancelled", "the request was cancelled in the browser", 499),
        }
        if code in friendly:
            mapped_code, message, mapped_status = friendly[code]
            return BridgeError(mapped_code, message, mapped_status)
        return BridgeError(code or "browser_error", str(meta.get("message") or code), status)

    async def _worker_loop(self) -> None:
        """Send queued prompts to the browser, one at a time."""

        while self._running:
            try:
                pending = await self._queue.get()
            except asyncio.CancelledError:
                return
            if pending is None:
                self._queue.task_done()
                continue
            try:
                await self._dispatch(pending)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # pragma: no cover - defensive
                logger.exception("dispatch failed: %s", exc)
                if not pending.future.done():
                    pending.future.set_result(
                        {"error": "internal_error", "response": None,
                         "meta": {"message": str(exc), "status_code": 500}}
                    )
            finally:
                self._queue.task_done()

    async def _dispatch(self, pending: PendingRequest) -> None:
        client = await self._wait_for_client(timeout=min(pending.timeout, 600.0))
        if client is None:
            self._pending.pop(pending.id, None)
            pending.finished = True
            if not pending.future.done():
                pending.future.set_result(
                    {"error": "no_browser", "response": None, "meta": {"status_code": 503}}
                )
            return

        if pending.future.done():  # already timed out on the HTTP side
            self._pending.pop(pending.id, None)
            return

        pending.client = client
        client.busy = True
        client.state = "answering"
        payload = BrowserRequest(
            id=pending.id,
            prompt=pending.prompt,
            mode=pending.mode,
            timeout=pending.timeout,
        ).model_dump()
        try:
            await client.ws.send_json(payload)
        except Exception as exc:
            client.busy = False
            self._pending.pop(pending.id, None)
            pending.finished = True
            if not pending.future.done():
                pending.future.set_result(
                    {"error": "browser_disconnected", "response": None,
                     "meta": {"message": str(exc), "status_code": 502}}
                )
            return

        pending.sent_at = time.time()
        logger.info("request %s sent to browser (mode=%s, %ss)", pending.id[:8], pending.mode,
                    int(pending.timeout))

        # Block the worker until this request is answered, so the page only ever
        # has one request in flight (the whole point of the queue).
        try:
            await asyncio.wait_for(asyncio.shield(pending.future), timeout=pending.timeout + 20.0)
        except asyncio.TimeoutError:
            client.busy = False
            pending.finished = True
            self._pending.pop(pending.id, None)
            if not pending.future.done():
                pending.future.set_result(
                    {"error": "timeout", "response": None,
                     "meta": {"status_code": 504, "message": "the page never answered"}}
                )
            with contextlib.suppress(Exception):
                await client.ws.send_json({"type": "cancel", "id": pending.id, "reason": "timeout"})
            logger.warning("request %s timed out inside the browser", pending.id[:8])
        except asyncio.CancelledError:
            client.busy = False
            raise

    async def _wait_for_client(self, timeout: float) -> Optional[BrowserClient]:
        deadline = time.time() + timeout
        while time.time() < deadline:
            client = self.active_client()
            if client is not None:
                return client
            self._client_ready.clear()
            remaining = max(0.05, deadline - time.time())
            try:
                await asyncio.wait_for(self._client_ready.wait(), timeout=remaining)
            except asyncio.TimeoutError:
                return None
        return None

    # ------------------------------------------------------------------
    async def _ping_loop(self) -> None:
        interval = self.settings.heartbeat_interval
        while self._running:
            try:
                await asyncio.sleep(interval)
            except asyncio.CancelledError:
                return
            for client in list(self.clients):
                if time.time() - client.last_seen > interval * 3:
                    logger.warning("dropping unresponsive browser client (%s)", client.client)
                    with contextlib.suppress(Exception):
                        await client.ws.close(code=4001)
                    await self.disconnect(client)
                    continue
                with contextlib.suppress(Exception):
                    await client.ws.send_json({"type": "ping", "ts": time.time()})

    # ------------------------------------------------------------------
    def stats(self) -> Dict[str, Any]:
        latencies = sorted(self.latencies_ms)
        p50 = latencies[len(latencies) // 2] if latencies else None
        p95 = latencies[min(len(latencies) - 1, int(len(latencies) * 0.95))] if latencies else None
        return {
            "server": {
                "version": self.settings.version,
                "uptime_s": round(time.time() - self.started_at, 1),
                "pending_requests": len(self._pending),
                "pending": self.pending_requests(),
                "queue_depth": self.queue_depth(),
                "queue_max": self.settings.queue_max_size,
                "sanitize_mode": self.settings.sanitize_mode,
                "started_at": self.started_at,
            },
            "browser": {
                "connected": self.has_client(),
                "clients": [c.info() for c in self.clients],
            },
            "totals": {
                "requests": self.total_requests,
                "errors": self.total_errors,
                "timeouts": self.total_timeouts,
                "sanitized_answers": self.total_sanitized,
                "last_request_at": self.last_request_at,
                "last_duration_ms": self.last_duration_ms,
            },
            "latency_ms": {"last": self.last_duration_ms, "p50": p50, "p95": p95,
                           "samples": len(self.latencies_ms)},
            "recent_errors": self.last_errors[-5:],
        }
