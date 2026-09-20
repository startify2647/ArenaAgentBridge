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
