"""In-process fake browser client - lets you exercise the whole pipeline without
Chrome.  Enable with ``AAB_MOCK_BROWSER=1`` (see ``scripts/demo.sh``).

It registers itself as a browser client on the bridge and answers every request
with a canned deterministic reply, which is handy for:

* smoke-testing the OpenAI endpoints / streaming emitter,
* verifying a Hermes or OpenClaw integration points at the right URL,
* CI, where no Chrome exists.

It is **not** able to reach the real website - it only proves the wiring works.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import time
from typing import Any, Dict, List, Optional

from .websocket_manager import BrowserBridge, BrowserClient

logger = logging.getLogger("aab.mock")


class FakeWebSocket:
    """Duck-typed stand-in for ``fastapi.WebSocket`` (only the bits we use)."""

    def __init__(self) -> None:
        self.sent: List[Dict[str, Any]] = []
        self.closed = False
        #: the code of the last ``close()`` (the bridge uses 4000/4001/4004)
        self.close_code: Optional[int] = None

    async def send_json(self, payload: Dict[str, Any]) -> None:
        if self.closed:
            raise RuntimeError("fake socket closed")
        self.sent.append(payload)

    async def close(self, code: int = 1000) -> None:  # pragma: no cover - parity
        self.closed = True
        self.close_code = code


class MockBrowser:
    """Answers queued prompts like a very fast, very boring assistant."""

    def __init__(self, bridge: BrowserBridge, delay: float = 0.4, fail_rate: float = 0.0) -> None:
        self.bridge = bridge
        self.delay = delay
        self.fail_rate = fail_rate
        self.ws = FakeWebSocket()
        self.client: Optional[BrowserClient] = None
        self._task: Optional[asyncio.Task] = None
        self.answered = 0

    async def start(self) -> None:
        self.client = await self.bridge.connect(
            self.ws,  # type: ignore[arg-type]
            {"client": "mock-browser", "version": "0.0.0", "url": "mock://arena.ai/agent"},
        )
        self._task = asyncio.create_task(self._loop(), name="aab-mock-browser")
        logger.warning(
            "MOCK BROWSER ENABLED - answers are synthetic, no real website is contacted"
        )

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
        if self.client is not None:
            await self.bridge.disconnect(self.client)

    async def _loop(self) -> None:
        seen = 0
        while True:
            await asyncio.sleep(0.05)
            while seen < len(self.ws.sent):
                payload = self.ws.sent[seen]
                seen += 1
                kind = payload.get("type")
                if kind == "request":
                    asyncio.create_task(self._answer(payload))
                elif kind == "diagnose":
                    asyncio.create_task(self._diagnose(payload))
                elif kind == "cancel":
                    logger.info("mock browser: cancel %s (%s)", payload.get("id"), payload.get("reason"))

    async def _diagnose(self, payload: Dict[str, Any]) -> None:
        """Answer like the extension does, so the panel's DOM view is demo-able."""

        assert self.client is not None
        await self.bridge.handle_message(
            self.client,
            {
                "type": "diag",
                "id": payload.get("id"),
                "state": "idle",
                "busy": False,
                "injected": True,
                "diag": {
                    "mock": True,
                    "url": "mock://arena.ai/agent",
                    "title": "mock arena.ai tab",
                    "checks": {"logged_in": True, "captcha": False, "streaming": False},
                    "selectorCounts": {"input": 1, "sendButton": 1, "stopButton": 0},
                    "messageCount": self.answered,
                    "lastRole": "assistant",
                    "stream": {"frames": 0, "mainChars": 0},
                    "pageHook": {"ready": True, "source": "mock"},
                },
                "config": {"serverUrl": "ws://127.0.0.1:8000/ws/browser", "mock": True},
            },
        )

    async def _answer(self, payload: Dict[str, Any]) -> None:
        started = time.time()
        await asyncio.sleep(self.delay)
        request_id = str(payload.get("id"))
        is_failure = self.fail_rate > 0 and (self.answered % max(1, int(1 / self.fail_rate)) == 0)

        if is_failure:
            body = {
                "id": request_id,
                "error": "captcha",
                "meta": {"message": "mock captcha", "status_code": 409},
            }
        else:
            prompt = str(payload.get("prompt") or "")
            body = {
                "id": request_id,
                "response": (
                    f"[mock answer] Received {len(prompt)} characters in "
                    f"`{payload.get('mode')}` mode. The bridge, the queue and the OpenAI "
                    "layer all work - connect the Chrome extension to talk to the real "
                    f"page.\n\nTail of prompt:\n{prompt[-160:].strip()}"
                ),
                "error": None,
                "meta": {
                    "duration_ms": int((time.time() - started) * 1000),
                    "mock": True,
                    "stop_reason": "stable",
                    "url": "mock://arena.ai/agent",
                },
            }
        self.answered += 1
        assert self.client is not None
        await self.bridge.handle_message(self.client, {"type": "response", **body})


async def maybe_start_mock(bridge: BrowserBridge) -> Optional[MockBrowser]:
    if os.getenv("AAB_MOCK_BROWSER", "").strip().lower() not in {"1", "true", "yes", "on"}:
        return None
    delay = float(os.getenv("AAB_MOCK_DELAY", "0.4") or 0.4)
    fail_rate = float(os.getenv("AAB_MOCK_FAIL_RATE", "0") or 0)
    mock = MockBrowser(bridge, delay=delay, fail_rate=fail_rate)
    await mock.start()
    return mock
