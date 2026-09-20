"""In-memory request history for the admin panel.

The bridge is a *local* tool, so the history deliberately lives in RAM only:
no database, no files, nothing that could outlive the process or leak a
conversation to disk.  Entries are trimmed (``AAB_HISTORY_SIZE``, default 200)
and previews are truncated, which is what a single user watching their own
machine needs - the panel shows the last requests, their timings, the sanitiser
findings and the error codes.

A history entry is created for every completed / failed / aborted request, no
matter whether it came from an agent framework (`/v1/chat/completions`) or from
the panel's playground (``X-Bridge-Source: panel``).
"""

from __future__ import annotations

import re
import time
import uuid
from collections import deque
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional

#: Preview sizes - the panel is a debugging aid, not a transcript store.
PROMPT_PREVIEW_CHARS = 700
RESPONSE_PREVIEW_CHARS = 1500

_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

#: Substrings found in a User-Agent / explicit client header -> friendly label.
CLIENT_HINTS = (
    ("hermes", "hermes"),
    ("openclaw", "openclaw"),
    ("open-claw", "openclaw"),
    ("litellm", "litellm"),
    ("open-webui", "open-webui"),
    ("openwebui", "open-webui"),
    ("lm-studio", "lm-studio"),
    ("lmstudio", "lm-studio"),
    ("continue", "continue"),
    ("cline", "cline"),
    ("ollama", "ollama"),
    ("langchain", "langchain"),
    ("llamaindex", "llamaindex"),
    ("curl", "curl"),
    ("httpx", "httpx"),
    ("python-requests", "python-requests"),
    ("aiohttp", "aiohttp"),
    ("openai", "openai-python"),
    ("node", "node"),
    ("undici", "node"),
    ("axios", "node"),
    ("mozilla", "browser"),
    ("chrome", "browser"),
    ("firefox", "browser"),
    ("safari", "browser"),
)


def detect_client(user_agent: Optional[str], explicit: Optional[str] = None) -> str:
    """Map a User-Agent (or an explicit header) to a short, stable label."""

    if explicit:
        return str(explicit).strip()[:40] or "unknown"
    haystack = (user_agent or "").lower()
    if not haystack:
        return "unknown"
    for needle, label in CLIENT_HINTS:
        if needle in haystack:
            return label
    return haystack.split("/")[0][:40] or "unknown"


def clean(text: Optional[str], limit: int) -> str:
    """One-line, control-character free preview."""

    if not text:
        return ""
    text = _CONTROL.sub("", str(text))
    if len(text) > limit:
        return text[:limit] + f"\n… (+{len(text) - limit} chars)"
    return text


@dataclass
class HistoryEntry:
    """One request/answer pair (or one failure).

    ``prompt_preview`` always holds what the *client* sent (the conversation
    dump) - that is what an operator wants to recognise in the log - while
    ``built_chars`` is the size of the prompt that was actually typed into the
    page, agent preamble included.
    """

    request_id: str
    at: float
    source: str = "api"  # api | panel | mock | test
    client: str = "unknown"
    model: str = ""
    mode: str = "agent"
    streamed: bool = False
    status: str = "ok"  # ok | error | aborted | rejected
    http_status: int = 200
    error_code: Optional[str] = None
    error_message: Optional[str] = None
    prompt_chars: int = 0
    built_chars: int = 0
    response_chars: int = 0
    prompt_preview: str = ""
    response_preview: str = ""
    queue_wait_ms: Optional[int] = None
    browser_duration_ms: Optional[int] = None
    total_ms: Optional[int] = None
    sanitized: bool = False
    sanitize_mode: Optional[str] = None
    sanitize_findings: List[Dict[str, Any]] = field(default_factory=list)
    stop_reason: Optional[str] = None

    def as_dict(self) -> Dict[str, Any]:
        data = asdict(self)
        data["at_iso"] = datetime.fromtimestamp(self.at, tz=timezone.utc).isoformat(
            timespec="seconds"
        )
        data["age_s"] = round(time.time() - self.at, 1)
        return data


class RequestHistory:
    """A bounded ring buffer of :class:`HistoryEntry` objects."""

    def __init__(self, maxlen: int = 200) -> None:
        self._items: deque[HistoryEntry] = deque(maxlen=max(0, int(maxlen)))

    # ------------------------------------------------------------------
    @property
    def maxlen(self) -> int:
        return self._items.maxlen or 0

    @property
    def size(self) -> int:
        return len(self._items)

    @property
    def enabled(self) -> bool:
        return bool(self._items.maxlen)

    def resize(self, maxlen: int) -> int:
        """Change the ring size, keeping the newest entries."""

        maxlen = max(0, int(maxlen))
        self._items = deque(self._items, maxlen=maxlen)
        return self.maxlen

    def clear(self) -> int:
        removed = len(self._items)
        self._items.clear()
        return removed

    # ------------------------------------------------------------------
    def record(
        self,
        *,
        request_id: Optional[str] = None,
        source: str = "api",
        client: Optional[str] = None,
        user_agent: Optional[str] = None,
        model: str = "",
        mode: str = "agent",
        streamed: bool = False,
        status: str = "ok",
        http_status: int = 200,
        error_code: Optional[str] = None,
        error_message: Optional[str] = None,
        prompt: str = "",
        built_chars: int = 0,
        response: str = "",
        queue_wait_ms: Optional[int] = None,
        browser_duration_ms: Optional[int] = None,
        total_ms: Optional[int] = None,
        sanitized: bool = False,
        sanitize_mode: Optional[str] = None,
        sanitize_findings: Optional[Iterable[Dict[str, Any]]] = None,
        stop_reason: Optional[str] = None,
    ) -> Optional[HistoryEntry]:
        """Append an entry (a no-op when the history is disabled)."""

        if not self.enabled:
            return None
        entry = HistoryEntry(
            request_id=request_id or f"panel-{uuid.uuid4().hex[:12]}",
            at=time.time(),
            source=source or "api",
            client=client or detect_client(user_agent),
            model=model or "",
            mode=mode or "agent",
            streamed=bool(streamed),
            status=status,
            http_status=int(http_status),
            error_code=error_code,
            error_message=clean(error_message, 400) or None,
            prompt_chars=len(prompt or ""),
            built_chars=int(built_chars or 0),
            response_chars=len(response or ""),
            prompt_preview=clean(prompt, PROMPT_PREVIEW_CHARS),
            response_preview=clean(response, RESPONSE_PREVIEW_CHARS),
            queue_wait_ms=queue_wait_ms,
            browser_duration_ms=browser_duration_ms,
            total_ms=total_ms,
            sanitized=bool(sanitized),
            sanitize_mode=sanitize_mode,
            sanitize_findings=list(sanitize_findings or [])[:16],
            stop_reason=stop_reason,
        )
        self._items.append(entry)
        return entry

    # ------------------------------------------------------------------
    def items(
        self,
        *,
        limit: int = 50,
        offset: int = 0,
        query: Optional[str] = None,
        status: Optional[str] = None,
        source: Optional[str] = None,
    ) -> List[HistoryEntry]:
        """Newest first, optionally filtered by a free-text query."""

        rows: List[HistoryEntry] = list(reversed(self._items))
        if status:
            wanted = {part.strip() for part in str(status).split(",") if part.strip()}
            rows = [row for row in rows if row.status in wanted]
        if source:
            wanted = {part.strip() for part in str(source).split(",") if part.strip()}
            rows = [row for row in rows if row.source in wanted]
        if query:
            needle = str(query).lower()
            rows = [
                row
                for row in rows
                if needle
                in " ".join(
                    [
                        row.prompt_preview.lower(),
                        row.response_preview.lower(),
                        (row.error_message or "").lower(),
                        row.client.lower(),
                        row.model.lower(),
                        row.request_id.lower(),
                        (row.error_code or "").lower(),
                    ]
                )
            ]
        offset = max(0, int(offset))
        limit = max(1, min(500, int(limit)))
        return rows[offset : offset + limit]

    def count(
        self,
        *,
        query: Optional[str] = None,
        status: Optional[str] = None,
        source: Optional[str] = None,
    ) -> int:
        if not query and not status and not source:
            return len(self._items)
        # cheap: reuse the filter, but bounded by the ring size anyway
        rows = self.items(limit=self.maxlen or 0 or 1, query=query, status=status, source=source)
        return len(rows)

    def get(self, request_id: str) -> Optional[HistoryEntry]:
        for entry in reversed(self._items):
            if entry.request_id == request_id:
                return entry
        return None

    # ------------------------------------------------------------------
    def summary(self) -> Dict[str, Any]:
        ok = sum(1 for entry in self._items if entry.status == "ok")
        errors = sum(1 for entry in self._items if entry.status in {"error", "rejected"})
        durations = [
            entry.total_ms for entry in self._items if isinstance(entry.total_ms, (int, float))
        ]
        return {
            "enabled": self.enabled,
            "size": len(self._items),
            "max": self.maxlen,
            "ok": ok,
            "errors": errors,
            "sanitized": sum(1 for entry in self._items if entry.sanitized),
            "last_at": self._items[-1].at if self._items else None,
            "avg_ms": round(sum(durations) / len(durations)) if durations else None,
        }

    def as_json(self, limit: Optional[int] = None) -> List[Dict[str, Any]]:
        rows = list(self._items)
        if limit:
            rows = rows[-int(limit) :]
        return [entry.as_dict() for entry in rows]
