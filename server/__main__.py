"""Package entry point: ``python -m server`` or ``uvicorn server.main:app``."""

from __future__ import annotations

from .main import app, create_app, main

__all__ = ["app", "create_app", "main"]

if __name__ == "__main__":  # pragma: no cover
    main()
