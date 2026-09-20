"""Static sanity checks for the Chrome extension.

They cannot test DOM automation (that needs a real browser), but they do catch
the mistakes that cost the most time: a manifest pointing at a missing file, a
config.js that lost a selector group, or a version mismatch between the manifest
and config.js.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "extension"


@pytest.fixture(scope="module")
def manifest() -> dict:
    return json.loads((EXT / "manifest.json").read_text(encoding="utf-8"))


def test_manifest_is_v3_and_points_at_existing_files(manifest):
    assert manifest["manifest_version"] == 3

    referenced = [manifest["background"]["service_worker"]]
    for script in manifest["content_scripts"]:
        referenced.extend(script["js"])
    referenced.append(manifest["action"]["default_popup"])
    referenced.extend((manifest.get("web_accessible_resources") or [{}])[0].get("resources", []))
    referenced.extend((manifest.get("icons") or {}).values())
    referenced.extend((manifest["action"].get("default_icon") or {}).values())

    for name in referenced:
        assert (EXT / name).is_file(), f"manifest references a missing file: {name}"


def test_manifest_matches_expected_site_and_permissions(manifest):
    assert manifest["content_scripts"][0]["matches"] == ["https://arena.ai/*"]
    assert manifest["content_scripts"][0]["run_at"] == "document_start"
    # loopback only: no remote hosts, no broad permissions
    assert manifest["host_permissions"] == [
        "https://arena.ai/*",
        "http://127.0.0.1:8000/*",
        "http://localhost:8000/*",
    ]
    assert set(manifest["permissions"]) == {"storage", "alarms", "scripting"}
    assert "<all_urls>" not in json.dumps(manifest)


def test_versions_are_in_sync(manifest):
    config = (EXT / "config.js").read_text(encoding="utf-8")
    match = re.search(r"CONFIG\.version\s*=\s*'([^']+)'", config)
    assert match, "config.js does not declare CONFIG.version"
    assert match.group(1) == manifest["version"]


def test_config_exposes_the_documented_groups():
    config = (EXT / "config.js").read_text(encoding="utf-8")
    for group in ("selectors", "behavior", "capture", "debug"):
        assert re.search(rf"\b{group}:\s*\{{", config), f"config.js lost the `{group}` group"
    for key in (
        "SERVER_WS_URL",
        "input",
        "sendButton",
        "stopButton",
        "assistantMessage",
        "captcha",
        "STABLE_MS",
        "SSE_IDLE_MS",
        "MAX_WAIT_MS",
    ):
        assert key in config, f"config.js lost `{key}`"


def test_websocket_url_is_loopback_only():
    config = (EXT / "config.js").read_text(encoding="utf-8")
    urls = re.findall(r"ws://[^\s'\"]+", config)
    assert urls, "no WebSocket URL found"
    for url in urls:
        assert re.match(r"ws://(127\.0\.0\.1|localhost):\d+/ws/browser", url), f"non-local URL: {url}"


def test_every_content_script_avoids_eval_and_remote_code():
    """A cheap guard against accidental remote code / inline evaluation."""
    for name in ("content.js", "background.js", "inject.js", "popup.js", "config.js"):
        source = (EXT / name).read_text(encoding="utf-8")
        assert "eval(" not in source, f"{name} uses eval()"
        assert "new Function(" not in source, f"{name} uses new Function()"
        assert not re.search(r"https?://(?!arena\.ai|127\.0\.0\.1|localhost)[a-z0-9.-]+", source, re.I), (
            f"{name} references a remote host"
        )
        assert not re.search(r"\bfetch\(\s*['\"]https?://(?!127\.0\.0\.1|localhost)", source), (
            f"{name} posts data to a remote host"
        )


def test_inject_hook_only_observes():
    source = (EXT / "inject.js").read_text(encoding="utf-8")
    assert "postMessage" in source
    # It taps streams but must never send credentials anywhere.
    for forbidden in ("document.cookie", "localStorage.getItem('token')", "Authorization"):
        assert forbidden not in source, f"inject.js touches {forbidden}"
