"""Shared Bearer-token check for the OpenAI surface *and* the admin panel.

By default the bridge is loopback-only and accepts any (or no) token: the
security boundary is "only this machine can connect".  Setting
``AAB_REQUIRE_API_KEY=1`` + ``AAB_API_KEY=...`` enforces a real shared secret -
useful on a shared machine, and required if you ever expose the port to a
network (don't).

The dependency is built from a live :class:`~server.config.Settings` object, so
toggling ``require_api_key`` from the admin panel takes effect immediately for
both the API and the panel's own ``/admin/api/*`` routes.
"""

from __future__ import annotations

from typing import Optional

from fastapi import Header, HTTPException

from .config import Settings


def extract_token(authorization: Optional[str]) -> str:
    """``Bearer sk-…`` / ``sk-…`` / nothing -> the raw token."""

    if not authorization:
        return ""
    value = authorization.strip()
    if " " in value:
        scheme, _, rest = value.partition(" ")
        if scheme.lower() in {"bearer", "token"}:
            return rest.strip()
    return value


def api_key_dependency(settings: Settings):
    """Build the FastAPI dependency that enforces ``AAB_REQUIRE_API_KEY``."""

    async def require_auth(authorization: Optional[str] = Header(default=None)) -> None:
        if not settings.require_api_key:
            return
        if extract_token(authorization) != settings.api_key:
            raise HTTPException(status_code=401, detail="invalid api key")

    return require_auth
