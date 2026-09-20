"""Admin panel + JSON API for the local bridge (``/admin``).

The bridge used to expose nothing but a small HTML status page; everything else
(queues, timings, errors, the sanitiser, the extension state) had to be read from
``/v1/bridge/status`` by hand.  This module adds the missing **web UI**:

``GET  /admin``                     the single-page panel (also ``/``, ``/ui``)
``GET  /admin/api/overview``        everything the dashboard needs, in one call
``GET  /admin/api/settings``        editable runtime settings + their env names
``POST /admin/api/settings``        apply a patch (validated, live)
``POST /admin/api/settings/reset``  reload the values from the environment
``GET  /admin/api/settings/env``    the matching ``.env`` block (download)
``GET  /admin/api/history``         request history (filter + paginate)
``POST /admin/api/history/clear``   wipe the in-memory history
``GET  /admin/api/history/export``  download the history as JSON
``POST /admin/api/sanitize``        dry-run the destructive-command sanitiser
``GET  /admin/api/rules``           the active sanitiser rules
``POST /admin/api/browser/*``       ping / cancel / disconnect / diagnose DOM
``GET  /admin/api/selfcheck``       a short "is everything wired up?" report

Everything is loopback-only by design and respects ``AAB_REQUIRE_API_KEY``: when
a real API key is enforced, ``/admin/api/*`` asks for the same Bearer token
(the panel shows a token prompt and stores it in ``localStorage``).
"""

from __future__ import annotations

import logging
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse, Response

from .auth import api_key_dependency
from .config import Settings
from .history import RequestHistory
from .sanitizer import sanitize
from .websocket_manager import BridgeError, BrowserBridge
from .webui import PANEL_CSS, PANEL_HTML, PANEL_JS

ROOT = Path(__file__).resolve().parent.parent


# ---------------------------------------------------------------------------
# runtime-editable settings
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Field:
    """One setting the panel may change while the server is running."""

    name: str
    env: str
    kind: str  # bool | int | float | str | slug | secret | enum | list
    group: str
    label: str
    label_fa: str
    help: str = ""
    help_fa: str = ""
    choices: Tuple[str, ...] = ()
    minimum: Optional[float] = None
    maximum: Optional[float] = None

    def as_dict(self) -> Dict[str, Any]:
        data = asdict(self)
        data["choices"] = list(self.choices)
        return data


CATALOG: Tuple[Field, ...] = (
    Field(
        "default_mode", "AAB_DEFAULT_MODE", "enum", "request",
        "Default prompt mode", "حالت پیش‌فرض پرامپت",
        "agent = bridge preamble + transcript, direct = transcript only",
        "agent = پیش‌گفتار پل + متن گفتگو، direct = فقط متن گفتگو",
        choices=("agent", "direct"),
    ),
    Field(
        "request_timeout", "AAB_REQUEST_TIMEOUT", "float", "request",
        "Request timeout (s)", "مهلت درخواست (ثانیه)",
        "How long the server waits for the page to answer.",
        "مدتی که سرور برای پاسخ صفحه صبر می‌کند.",
        minimum=5, maximum=3600,
    ),
    Field(
        "queue_max_size", "AAB_QUEUE_MAX_SIZE", "int", "request",
        "Queue size", "اندازه صف",
        "Waiting requests before clients get HTTP 429.",
        "تعداد درخواست‌های در انتظار قبل از خطای ۴۲۹.",
        minimum=1, maximum=10000,
    ),
    Field(
        "max_prompt_chars", "AAB_MAX_PROMPT_CHARS", "int", "request",
        "Max prompt chars", "حداکثر کاراکتر پرامپت",
        "Refuse absurdly large prompts before typing them into the page.",
        "پرامپت‌های بیش از حد بزرگ رد می‌شوند.",
        minimum=1000, maximum=2000000,
    ),
    Field(
        "max_response_chars", "AAB_MAX_RESPONSE_CHARS", "int", "request",
        "Max response chars", "حداکثر کاراکتر پاسخ",
        "Truncate longer answers before they reach the agent.",
        "پاسخ‌های طولانی‌تر بریده می‌شوند.",
        minimum=1000, maximum=5000000,
    ),
    Field(
        "sanitize_mode", "AAB_SANITIZE_MODE", "enum", "safety",
        "Sanitiser mode", "حالت سنیترایزر",
        "off = do nothing, detect = report, redact = neutralise destructive commands",
        "off = هیچ، detect = فقط گزارش، redact = خنثی‌سازی دستورهای مخرب",
        choices=("off", "detect", "redact"),
    ),
    Field(
        "stream_chunk_chars", "AAB_STREAM_CHUNK_CHARS", "int", "streaming",
        "SSE chunk chars", "اندازهٔ تکهٔ SSE",
        "Streaming is emulated: the answer is replayed in chunks this big.",
        "استریم شبیه‌سازی می‌شود؛ پاسخ در تکه‌هایی با این اندازه ارسال می‌شود.",
        minimum=1, maximum=4000,
    ),
    Field(
        "stream_chunk_delay_ms", "AAB_STREAM_CHUNK_DELAY_MS", "int", "streaming",
        "SSE chunk delay (ms)", "تأخیر تکهٔ SSE (میلی‌ثانیه)",
        "Pause between replayed chunks (0 = as fast as possible).",
        "فاصله بین تکه‌ها (۰ = حداکثر سرعت).",
        minimum=0, maximum=1000,
    ),
    Field(
        "model_id", "AAB_MODEL_ID", "slug", "models",
        "Primary model id", "شناسهٔ مدل اصلی",
        "The model name agents must use for the agent-mode wrapper.",
        "نام مدلی که ایجنت‌ها برای حالت agent استفاده می‌کنند.",
    ),
    Field(
        "extra_model_ids", "AAB_EXTRA_MODEL_IDS", "list", "models",
        "Extra model ids", "شناسه‌های مدل اضافه",
        "Comma separated; every extra id reuses the same browser session.",
        "جدا شده با کاما؛ همه از همان نشست مرورگر استفاده می‌کنند.",
    ),
    Field(
        "history_size", "AAB_HISTORY_SIZE", "int", "diagnostics",
        "History size", "اندازهٔ تاریخچه",
        "How many requests the panel remembers in RAM (0 = disable).",
        "چند درخواست در حافظه نگه داشته شود (۰ = غیرفعال).",
        minimum=0, maximum=2000,
    ),
    Field(
        "log_level", "AAB_LOG_LEVEL", "enum", "diagnostics",
        "Log level", "سطح لاگ",
        "Applied to the running process immediately.",
        "بی‌درنگ روی پروسهٔ در حال اجرا اعمال می‌شود.",
        choices=("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"),
    ),
    Field(
        "require_api_key", "AAB_REQUIRE_API_KEY", "bool", "security",
        "Require API key", "الزام کلید API",
        "Enforce the Bearer token below for /v1/* and /admin/api/*.",
        "توکن Bearer زیر برای /v1/* و /admin/api/* الزامی می‌شود.",
    ),
    Field(
        "api_key", "AAB_API_KEY", "secret", "security",
        "API key", "کلید API",
        "Shared secret; never shown again after saving (write-only).",
        "کلید مشترک؛ پس از ذخیره دیگر نمایش داده نمی‌شود.",
    ),
)

FIELDS: Dict[str, Field] = {field.name: field for field in CATALOG}
GROUPS = ("request", "safety", "streaming", "models", "security", "diagnostics")

_TRUE = {"1", "true", "yes", "on", "y", "t"}
_FALSE = {"0", "false", "no", "off", "n", "f"}

#: Settings shown read-only in the panel (they need a restart to change).
READONLY_INFO = (
    "host", "port", "cors_origin_regex", "heartbeat_interval", "client_hello_timeout",
    "single_client", "min_request_timeout", "max_request_timeout", "stats_window",
    "patterns_file", "log_json",
)


def _coerce(field: Field, value: Any) -> Tuple[Any, Optional[str]]:
    """Return ``(value, error)`` for one incoming setting."""

    if field.kind == "bool":
        if isinstance(value, bool):
            return value, None
        text = str(value).strip().lower()
        if text in _TRUE:
            return True, None
        if text in _FALSE:
            return False, None
        return None, "must be true or false"

    if field.kind in {"int", "float"}:
        try:
            number = float(value)
        except (TypeError, ValueError):
            return None, "must be a number"
        if field.kind == "int" and number != int(number):
            return None, "must be a whole number"
        result: Any = int(number) if field.kind == "int" else number
        if field.minimum is not None and result < field.minimum:
            return None, f"must be >= {field.minimum:g}"
        if field.maximum is not None and result > field.maximum:
            return None, f"must be <= {field.maximum:g}"
        return result, None

    if field.kind == "enum":
        text = str(value).strip().lower()
        if text not in {choice.lower() for choice in field.choices}:
            return None, f"must be one of: {', '.join(field.choices)}"
        # preserve the canonical spelling (e.g. log levels are upper case)
        for choice in field.choices:
            if choice.lower() == text:
                return choice, None
        return text, None

    if field.kind == "list":
        if isinstance(value, list):
            items = [str(part).strip() for part in value]
        else:
            items = [part.strip() for part in str(value).split(",")]
        return [item for item in items if item][:32], None

    text = str(value).strip()
    if field.kind == "slug":
        if not text or len(text) > 64 or any(ch.isspace() for ch in text):
            return None, "must be a short id without spaces (max 64 chars)"
        return text, None
    if field.kind == "secret":
        if len(text) < 4:
            return None, "must be at least 4 characters"
        return text, None
    return text, None


def _apply_side_effects(
    settings: Settings, bridge: Optional[BrowserBridge], history: Optional[RequestHistory]
) -> Dict[str, Any]:
    """Propagate a settings change to the parts of the process that cache it."""

    settings.validate()
    settings.model_ids = [settings.model_id, *settings.extra_model_ids]
    if history is not None and history.maxlen != max(0, settings.history_size):
        history.resize(settings.history_size)
    if bridge is not None:
        bridge.set_queue_max(settings.queue_max_size)
    logging.getLogger().setLevel(getattr(logging, settings.log_level, logging.INFO))
    return {
        "model_ids": settings.model_ids,
        "queue_max": settings.queue_max_size,
        "history_size": settings.history_size if history is None else history.maxlen,
        "log_level": settings.log_level,
    }


def _side_effect_snapshot(settings: Settings, history: Optional[RequestHistory]) -> Dict[str, Any]:
    """What the live process looks like after a settings change (for the panel)."""

    return {
        "model_ids": settings.model_ids,
        "queue_max": settings.queue_max_size,
        "history_size": history.maxlen if history is not None else settings.history_size,
        "log_level": settings.log_level,
        "sanitize_mode": settings.sanitize_mode,
    }


def public_settings(settings: Settings) -> Dict[str, Any]:
    """Current values of every editable setting (secrets masked)."""

    values: Dict[str, Any] = {}
    for field in CATALOG:
        value = getattr(settings, field.name, None)
        if field.kind == "secret":
            values[field.name] = "***" if value else ""
            values[f"{field.name}_set"] = bool(value)
        else:
            values[field.name] = value
    return values


def apply_patch(
    patch: Dict[str, Any],
    *,
    settings: Settings,
    bridge: Optional[BrowserBridge] = None,
    history: Optional[RequestHistory] = None,
) -> Tuple[Dict[str, Any], Dict[str, str]]:
    """Validate and apply a settings patch. Returns ``(applied, rejected)``."""

    applied: Dict[str, Any] = {}
    rejected: Dict[str, str] = {}

    if not isinstance(patch, dict):
        return applied, {"*": "expected a JSON object"}

    pending: Dict[str, Any] = {}
    for name, raw in patch.items():
        field = FIELDS.get(name)
        if field is None:
            rejected[name] = "unknown setting (read-only or not editable)"
            continue
        if field.kind == "secret" and (raw is None or str(raw).strip() in {"", "***"}):
            # an empty/blank secret means "leave it alone"
            continue
        value, error = _coerce(field, raw)
        if error:
            rejected[name] = error
            continue
        if getattr(settings, name, None) == value:
            continue
        pending[name] = value

    for name, value in pending.items():
        setattr(settings, name, value)
    if pending:
        _apply_side_effects(settings, bridge, history)
        for name in pending:
            field = FIELDS[name]
            value = getattr(settings, name)
            applied[name] = "***" if (field.kind == "secret" and value) else value

    return applied, rejected


def reset_from_environment(
    *,
    settings: Settings,
    bridge: Optional[BrowserBridge] = None,
    history: Optional[RequestHistory] = None,
) -> Dict[str, Any]:
    """Reload every editable setting from ``.env`` / the process environment."""

    fresh = Settings.from_env(ROOT / ".env")
    applied: Dict[str, Any] = {}
    for field in CATALOG:
        value = getattr(fresh, field.name)
        changed = getattr(settings, field.name, None) != value
        setattr(settings, field.name, value)
        if changed:
            applied[field.name] = "***" if field.kind == "secret" else value
    _apply_side_effects(settings, bridge, history)
    return applied


def env_block(settings: Settings) -> str:
    """A paste-ready ``.env`` snippet for the current settings."""

    lines = [
        "# ArenaAgentBridge - generated by the admin panel",
        "# Drop these lines into .env (or export them) to make them permanent.",
        "",
    ]
    for group in GROUPS:
        lines.append(f"# --- {group} " + "-" * max(0, 60 - len(group)))
        for field in CATALOG:
            if field.group != group:
                continue
            value = getattr(settings, field.name, "")
            if field.kind == "bool":
                value = "1" if value else "0"
            elif field.kind == "list":
                value = ",".join(str(part) for part in (value or []))
            lines.append(f"{field.env}={value}")
        lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# page rendering
# ---------------------------------------------------------------------------
def render_panel_page(settings: Settings) -> HTMLResponse:
    """The panel shell, with the per-process bits filled in."""

    html = (
        PANEL_HTML.replace("__VERSION__", settings.version)
        .replace("__MODEL_ID__", settings.model_id)
        .replace("__PORT__", str(settings.port))
        .replace("__REFRESH_MS__", str(max(500, settings.panel_refresh_ms)))
    )
    return HTMLResponse(
        html,
        headers={
            "Cache-Control": "no-store",
            "X-Robots-Tag": "noindex",
            # No `frame-ancestors`: the panel is a local page you may want to
            # embed in your own dashboard (or view through a remote preview of
            # your dev box).  Cross-site POSTs still need a CORS preflight
            # (JSON body), and `default-src 'none'` keeps remote code out.
            "Content-Security-Policy": (
                "default-src 'none'; style-src 'self' 'unsafe-inline'; "
                "script-src 'self' 'unsafe-inline'; connect-src 'self'; "
                "img-src 'self' data:; form-action 'none'"
            ),
        },
    )


# ---------------------------------------------------------------------------
# router
# ---------------------------------------------------------------------------
def _rules_payload(rules: List[tuple]) -> List[Dict[str, Any]]:
    payload = []
    for rule in rules:
        name, kind, severity, regex = rule
        payload.append(
            {
                "name": name,
                "kind": kind,
                "severity": severity,
                "pattern": getattr(regex, "pattern", str(regex)),
            }
        )
    return payload


def create_admin_router(
    *,
    settings: Settings,
    bridge: BrowserBridge,
    history: RequestHistory,
    rules: Optional[List[tuple]] = None,
) -> APIRouter:
    """Build the ``/admin`` page routes plus the JSON API."""

    active_rules = list(rules or [])
    page = APIRouter()
    api = APIRouter(prefix="/admin/api", dependencies=[Depends(api_key_dependency(settings))])

    @page.get("/admin", include_in_schema=False)
    @page.get("/admin/", include_in_schema=False)
    @page.get("/ui", include_in_schema=False)
    @page.get("/panel", include_in_schema=False)
    async def admin_page() -> HTMLResponse:
        return render_panel_page(settings)

    @page.get("/admin/assets/panel.css", include_in_schema=False)
    async def panel_css() -> Response:
        return Response(
            PANEL_CSS, media_type="text/css", headers={"Cache-Control": "no-cache"}
        )

    @page.get("/admin/assets/panel.js", include_in_schema=False)
    async def panel_js() -> Response:
        return Response(
            PANEL_JS,
            media_type="application/javascript",
            headers={"Cache-Control": "no-cache"},
        )

    # ------------------------------------------------------------------
    # overview
    # ------------------------------------------------------------------
    @api.get("/overview")
    async def overview() -> Dict[str, Any]:
        data = bridge.stats()
        data.update(
            {
                "now": time.time(),
                "version": settings.version,
                "history": history.summary(),
                "models": [
                    {"id": model_id, "mode": "direct" if model_id.endswith("-direct") else "agent"}
                    for model_id in settings.model_ids
                ],
                "sanitizer": {
                    "mode": settings.sanitize_mode,
                    "rules": len(active_rules),
                    "block_rules": sum(1 for rule in active_rules if rule[2] == "block"),
                    "warn_rules": sum(1 for rule in active_rules if rule[2] == "warn"),
                },
                "settings": {
                    "model_id": settings.model_id,
                    "model_ids": settings.model_ids,
                    "default_mode": settings.default_mode,
                    "request_timeout": settings.request_timeout,
                    "queue_max_size": settings.queue_max_size,
                    "sanitize_mode": settings.sanitize_mode,
                    "require_api_key": settings.require_api_key,
                    "max_prompt_chars": settings.max_prompt_chars,
                    "stream_chunk_chars": settings.stream_chunk_chars,
                    "history_size": history.maxlen,
                    "host": settings.host,
                    "port": settings.port,
                    "patterns_file": settings.patterns_file,
                },
                "panel": {"refresh_ms": max(500, settings.panel_refresh_ms)},
            }
        )
        return data

    # ------------------------------------------------------------------
    # settings
    # ------------------------------------------------------------------
    @api.get("/settings")
    async def get_settings_payload() -> Dict[str, Any]:
        return {
            "fields": [field.as_dict() for field in CATALOG],
            "groups": list(GROUPS),
            "values": public_settings(settings),
            "readonly": {name: getattr(settings, name, None) for name in READONLY_INFO},
            "env_block": env_block(settings),
            "state": _side_effect_snapshot(settings, history),
        }

    @api.post("/settings")
    async def patch_settings(request: Request) -> JSONResponse:
        try:
            body = await request.json()
        except Exception:  # pragma: no cover - malformed body
            return JSONResponse(
                status_code=400, content={"ok": False, "error": "expected a JSON object"}
            )
        patch = body.get("patch") if isinstance(body, dict) and "patch" in body else body
        if not isinstance(patch, dict):
            return JSONResponse(
                status_code=400, content={"ok": False, "error": "patch must be an object"}
            )
        applied, rejected = apply_patch(patch, settings=settings, bridge=bridge, history=history)
        if applied:
            logging.getLogger("aab.admin").info(
                "settings changed from the panel: %s", ", ".join(sorted(applied))
            )
        return JSONResponse(
            {
                "ok": not rejected,
                "applied": applied,
                "rejected": rejected,
                "values": public_settings(settings),
                "state": _side_effect_snapshot(settings, history),
            }
        )

    @api.post("/settings/reset")
    async def reset_settings() -> Dict[str, Any]:
        applied = reset_from_environment(settings=settings, bridge=bridge, history=history)
        return {
            "ok": True,
            "applied": applied,
            "rejected": {},
            "values": public_settings(settings),
            "state": _side_effect_snapshot(settings, history),
        }

    @api.get("/settings/env")
    async def download_env() -> PlainTextResponse:
        return PlainTextResponse(
            env_block(settings),
            media_type="text/plain; charset=utf-8",
            headers={"Content-Disposition": 'attachment; filename="arena-agent-bridge.env"'},
        )

    # ------------------------------------------------------------------
    # history
    # ------------------------------------------------------------------
    @api.get("/history")
    async def get_history(
        limit: int = Query(default=50, ge=1, le=500),
        offset: int = Query(default=0, ge=0),
        q: Optional[str] = Query(default=None),
        status: Optional[str] = Query(default=None),
        source: Optional[str] = Query(default=None),
    ) -> Dict[str, Any]:
        items = history.items(
            limit=limit, offset=offset, query=q, status=status, source=source
        )
        return {
            "items": [entry.as_dict() for entry in items],
            "total": history.count(),
            "filtered": history.count(query=q, status=status, source=source),
            "limit": limit,
            "offset": offset,
            "summary": history.summary(),
        }

    # NOTE: declared before ``/history/{request_id}`` on purpose - FastAPI matches
    # routes in registration order, so "export" must not be swallowed by the id.
    @api.get("/history/export", include_in_schema=True)
    async def export_history(limit: int = Query(default=200, ge=1, le=2000)) -> JSONResponse:
        return JSONResponse(
            {
                "exported_at": time.time(),
                "version": settings.version,
                "summary": history.summary(),
                "requests": history.as_json(limit=limit),
            },
            headers={
                "Content-Disposition": 'attachment; filename="arena-agent-bridge-history.json"'
            },
        )

    @api.post("/history/clear")
    async def clear_history() -> Dict[str, Any]:
        return {"ok": True, "removed": history.clear()}

    @api.get("/history/{request_id}")
    async def get_history_entry(request_id: str) -> JSONResponse:
        entry = history.get(request_id)
        if entry is None:
            return JSONResponse(status_code=404, content={"ok": False, "error": "not found"})
        return JSONResponse(entry.as_dict())

    # ------------------------------------------------------------------
    # sanitiser
    # ------------------------------------------------------------------
    @api.get("/rules")
    async def get_rules() -> Dict[str, Any]:
        payload = _rules_payload(active_rules)
        return {
            "rules": payload,
            "count": len(payload),
            "mode": settings.sanitize_mode,
            "patterns_file": settings.patterns_file,
            "block": [rule for rule in payload if rule["severity"] == "block"],
            "warn": [rule for rule in payload if rule["severity"] == "warn"],
        }

    @api.post("/sanitize")
    async def dry_run_sanitizer(request: Request) -> JSONResponse:
        try:
            body = await request.json()
        except Exception:  # pragma: no cover - malformed body
            return JSONResponse(status_code=400, content={"ok": False, "error": "invalid json"})
        text = str((body or {}).get("text") or "")
        if len(text) > 200_000:
            return JSONResponse(
                status_code=413, content={"ok": False, "error": "text too large (max 200k)"}
            )
        mode = str((body or {}).get("mode") or settings.sanitize_mode).lower()
        if mode not in {"off", "detect", "redact"}:
            return JSONResponse(
                status_code=400,
                content={"ok": False, "error": "mode must be off, detect or redact"},
            )
        cleaned, report = sanitize(text, mode=mode, rules=active_rules)
        return JSONResponse(
            {
                "ok": True,
                "mode": report.mode,
                "input_chars": len(text),
                "output": cleaned,
                "changed": report.changed,
                "replacements": report.replacements,
                "findings": [finding.as_dict() for finding in report.findings],
            }
        )

    # ------------------------------------------------------------------
    # browser / extension control
    # ------------------------------------------------------------------
    @api.post("/browser/ping")
    async def browser_ping() -> Dict[str, Any]:
        sent = await bridge.ping_clients()
        return {"ok": sent > 0, "pinged": sent, "connected": bridge.has_client()}

    @api.post("/browser/cancel")
    async def browser_cancel(request: Request) -> Dict[str, Any]:
        reason = "cancelled from the admin panel"
        try:
            body = await request.json()
            reason = str((body or {}).get("reason") or reason)[:200]
        except Exception:
            pass
        result = await bridge.cancel_pending(reason, notify_browser=True)
        return {"ok": True, **result}

    @api.post("/browser/disconnect")
    async def browser_disconnect() -> Dict[str, Any]:
        dropped = await bridge.disconnect_all("disconnected from the admin panel")
        return {"ok": True, "disconnected": dropped}

    @api.post("/browser/diagnose")
    async def browser_diagnose() -> JSONResponse:
        try:
            result = await bridge.request_diagnostics(timeout=8.0)
        except BridgeError as exc:
            return JSONResponse(
                status_code=exc.status_code,
                content={"ok": False, "error": exc.code, "message": exc.message},
            )
        return JSONResponse({"ok": True, **result})

    # ------------------------------------------------------------------
    # self check
    # ------------------------------------------------------------------
    @api.get("/selfcheck")
    async def selfcheck() -> Dict[str, Any]:
        client = bridge.active_client()
        extension_version = client.version if client else None
        checks: List[Dict[str, Any]] = []

        def add(check_id: str, ok: bool, detail: str, hint: str = "", level: str = "warn") -> None:
            checks.append(
                {"id": check_id, "ok": bool(ok), "level": "ok" if ok else level,
                 "detail": detail, "hint": hint}
            )

        add(
            "browser",
            bridge.has_client(),
            f"connected: {client.client} v{extension_version}" if client else "no browser attached",
            "load dist/chrome (or dist/firefox) and open https://arena.ai/agent",
            level="error",
        )
        add(
            "extension-version",
            bool(client) and str(extension_version or "").startswith(
                ".".join(settings.version.split(".")[:2])
            ),
            f"extension v{extension_version or '?'} / server v{settings.version}",
            "rebuild the extension (python scripts/build-extensions.py) and reload it",
        )
        add(
            "queue",
            bridge.queue_depth() < settings.queue_max_size,
            f"{bridge.queue_depth()}/{settings.queue_max_size} waiting",
            "raise AAB_QUEUE_MAX_SIZE or slow down the clients",
        )
        add(
            "sanitizer",
            settings.sanitize_mode != "off",
            f"mode={settings.sanitize_mode} rules={len(active_rules)}",
            "set AAB_SANITIZE_MODE=redact if your agent can run shell commands",
            level="error",
        )
        add(
            "history",
            history.enabled,
            f"{history.size}/{history.maxlen} entries" if history.enabled else "disabled",
            "set AAB_HISTORY_SIZE=200 to keep a request log for the panel",
        )
        api_key_ok = not settings.require_api_key or bool(settings.api_key)
        add(
            "auth",
            api_key_ok,
            "api key required" if settings.require_api_key else "open (loopback only)",
            "set AAB_API_KEY when AAB_REQUIRE_API_KEY=1",
            level="error",
        )
        return {
            "ok": all(check["ok"] for check in checks),
            "checks": checks,
            "version": settings.version,
            "now": time.time(),
        }

    root = APIRouter()
    root.include_router(page)
    root.include_router(api)
    return root
