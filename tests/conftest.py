"""Shared paths/helpers for the test suite."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SERVER = ROOT / "server"
EXTENSIONS = ROOT / "extensions"
SHARED = EXTENSIONS / "shared"
CHROME_MANIFEST = EXTENSIONS / "chrome" / "manifest.json"
FIREFOX_MANIFEST = EXTENSIONS / "firefox" / "manifest.json"
DIST = ROOT / "dist"


def read_manifest(browser: str) -> dict:
    path = EXTENSIONS / browser / "manifest.json"
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def repo_root() -> Path:
    return ROOT


# ---------------------------------------------------------------------------
# shared test doubles / fixtures
# ---------------------------------------------------------------------------
#: ``ScriptedBrowser``, ``make_settings``, ``attach_browser`` and ``plain_answer``
#: live here (and not in a single test module) so every suite - the bridge, the
#: admin panel, the history - can drive the server the same way.
#
# Imports are kept local to this block on purpose: the path constants above must
# be importable before anything else pulls in the application package.
import asyncio  # noqa: E402
from typing import Any, Callable, Dict, List, Optional  # noqa: E402

import httpx  # noqa: E402
import pytest  # noqa: E402

from server.config import Settings  # noqa: E402
from server.main import create_app  # noqa: E402
from server.mock_browser import FakeWebSocket  # noqa: E402


class ScriptedBrowser:
    """A fake extension: answers every request with a scripted payload."""

    def __init__(
        self,
        answer: Callable[[Dict[str, Any]], Dict[str, Any]],
        delay: float = 0.0,
        diagnostics: bool = True,
    ):
        self.answer = answer
        self.delay = delay
        #: 1.2.0 extensions answer the panel's `diagnose` frame; older ones ignore it
        self.diagnostics = diagnostics
        self.ws = FakeWebSocket()
        self.bridge = None
        self.client = None
        self.seen: List[Dict[str, Any]] = []
        self.concurrent = 0
        self.max_concurrent = 0
        self._task: Optional[asyncio.Task] = None

    async def start(self, bridge) -> "ScriptedBrowser":
        self.bridge = bridge
        self.client = await bridge.connect(self.ws, {"client": "scripted", "version": "test"})
        self._task = asyncio.create_task(self._loop())
        return self

    async def stop(self, bridge) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        if self.client is not None:
            await bridge.disconnect(self.client)

    async def _loop(self) -> None:
        seen = 0
        while True:
            await asyncio.sleep(0.01)
            while seen < len(self.ws.sent):
                payload = self.ws.sent[seen]
                seen += 1
                kind = payload.get("type")
                if kind == "request":
                    asyncio.create_task(self._handle(payload))
                elif kind == "diagnose" and self.diagnostics:
                    asyncio.create_task(self._handle_diagnostics(payload))

    async def _handle_diagnostics(self, payload: Dict[str, Any]) -> None:
        assert self.bridge is not None and self.client is not None
        await self.bridge.handle_message(
            self.client,
            {
                "type": "diag",
                "id": payload.get("id"),
                "state": "idle",
                "busy": False,
                "diag": {
                    "url": "https://arena.ai/agent",
                    "selectorCounts": {"input": 1, "sendButton": 1},
                },
                "config": {
                    "serverUrl": "ws://127.0.0.1:8000/ws/browser",
                    "stableMs": 3000,
                    "capture": True,
                },
            },
        )

    async def _handle(self, payload: Dict[str, Any]) -> None:
        self.concurrent += 1
        self.max_concurrent = max(self.max_concurrent, self.concurrent)
        try:
            if self.delay:
                await asyncio.sleep(self.delay)
            self.seen.append(payload)
            body = self.answer(payload)
            await self.bridge_handle(payload, body)
        finally:
            self.concurrent -= 1

    async def bridge_handle(self, payload: Dict[str, Any], body: Dict[str, Any]) -> None:
        assert self.bridge is not None and self.client is not None
        await self.bridge.handle_message(
            self.client, {"type": "response", "id": payload["id"], **body}
        )


def make_settings(**overrides) -> Settings:
    settings = Settings()
    settings.validate()
    for key, value in overrides.items():
        setattr(settings, key, value)
    settings.model_ids = [settings.model_id, *settings.extra_model_ids]
    settings.validate()
    return settings


@pytest.fixture
async def settings() -> Settings:
    return make_settings(stream_chunk_delay_ms=0, stream_chunk_chars=16)


@pytest.fixture
async def api(settings):
    """An app with NO browser connected (plus a scripted one on request)."""
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://bridge.test", timeout=30.0
        ) as client:
            yield app, client


async def attach_browser(app, answer, delay: float = 0.0) -> ScriptedBrowser:
    return await ScriptedBrowser(answer, delay=delay).start(app.state.bridge)


def plain_answer(text: str = "the answer") -> Callable[[Dict[str, Any]], Dict[str, Any]]:
    def _answer(_payload: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "response": text,
            "error": None,
            "meta": {"duration_ms": 12, "stop_reason": "stable"},
        }

    return _answer
