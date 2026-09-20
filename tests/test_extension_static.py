"""Static sanity checks for the browser extensions (Chrome/Edge + Firefox).

They cannot test DOM automation (that is `extension_dom_test.mjs`), but they
catch the mistakes that cost the most time: a manifest pointing at a missing
file, an API that only exists in one browser, a config.js that lost a selector
group, or a version mismatch between the manifests and config.js.
"""

from __future__ import annotations

import json
import re

import pytest
from conftest import CHROME_MANIFEST, EXTENSIONS, FIREFOX_MANIFEST, ROOT, SHARED, read_manifest

ALL_SCRIPTS = ("config.js", "content.js", "background.js", "inject.js", "popup.js")


@pytest.fixture(scope="module", params=["chrome", "firefox"])
def manifest(request) -> dict:
    return read_manifest(request.param)


@pytest.fixture(scope="module")
def chrome_manifest() -> dict:
    return json.loads(CHROME_MANIFEST.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def firefox_manifest() -> dict:
    return json.loads(FIREFOX_MANIFEST.read_text(encoding="utf-8"))


def strip_comments(source: str) -> str:
    """Drop comments so API-surface assertions only look at real code."""
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
    return re.sub(r"^\s*//.*$", "", source, flags=re.M)


def manifest_files(manifest: dict) -> list:
    """Every file path a manifest points at."""
    names = []
    background = manifest.get("background") or {}
    if background.get("service_worker"):
        names.append(background["service_worker"])
    names.extend(background.get("scripts") or [])
    for entry in manifest.get("content_scripts") or []:
        names.extend(entry.get("js") or [])
        names.extend(entry.get("css") or [])
    for entry in manifest.get("web_accessible_resources") or []:
        names.extend(entry.get("resources") or [])
    action = manifest.get("action") or {}
    names.append(action.get("default_popup"))
    names.extend((action.get("default_icon") or {}).values())
    names.extend((manifest.get("icons") or {}).values())
    return [name for name in names if name]


def test_both_manifests_are_v3_and_reference_real_files(manifest):
    assert manifest["manifest_version"] == 3
    for name in manifest_files(manifest):
        assert (SHARED / name).is_file(), f"manifest references a missing shared file: {name}"


def test_versions_are_in_sync(manifest):
    config = (SHARED / "config.js").read_text(encoding="utf-8")
    match = re.search(r"CONFIG\.version\s*=\s*'([^']+)'", config)
    assert match, "config.js does not declare CONFIG.version"
    assert manifest["version"] == match.group(1)


def test_manifests_only_touch_the_site_and_loopback(manifest):
    assert manifest["host_permissions"] == [
        "https://arena.ai/*",
        "http://127.0.0.1:8000/*",
        "http://localhost:8000/*",
    ]
    assert "<all_urls>" not in json.dumps(manifest)
    assert set(manifest["permissions"]) == {"storage", "alarms", "scripting"}
    matches = [entry["matches"] for entry in manifest["content_scripts"]]
    assert matches == [["https://arena.ai/*"]] * len(matches)
    for entry in manifest["content_scripts"]:
        assert entry["run_at"] == "document_start"


def test_chrome_uses_a_service_worker_and_main_world_hook(chrome_manifest):
    assert chrome_manifest["background"]["service_worker"] == "background.js"
    worlds = [entry.get("world", "ISOLATED") for entry in chrome_manifest["content_scripts"]]
    assert worlds == ["ISOLATED", "MAIN"], worlds  # content.js, then inject.js
    assert "inject.js" in chrome_manifest["content_scripts"][1]["js"]
    assert int(chrome_manifest["minimum_chrome_version"]) >= 111, "world:MAIN needs Chrome 111+"


def test_firefox_uses_event_page_scripts_and_declares_gecko_id(firefox_manifest):
    background = firefox_manifest["background"]
    assert "service_worker" not in background, "Firefox has no MV3 service worker"
    assert background["scripts"] == ["config.js", "background.js"]
    gecko = firefox_manifest["browser_specific_settings"]["gecko"]
    assert gecko["id"] == "arena-agent-bridge@local"
    assert float(gecko["strict_min_version"]) >= 128.0
    # Firefox MV3 host permissions are opt-in, so the extension must ask nicely
    assert "optional_host_permissions" in firefox_manifest
    assert "permissions" in firefox_manifest  # the permissions API for the grant flow


def test_config_exposes_the_documented_groups():
    config = (SHARED / "config.js").read_text(encoding="utf-8")
    for group in ("selectors", "behavior", "capture", "debug"):
        assert re.search(rf"\b{group}:\s*\{{", config), f"config.js lost the `{group}` group"
    for key in (
        "SERVER_WS_URL",
        "TRANSPORT_MODE",
        "input",
        "sendButton",
        "stopButton",
        "assistantMessage",
        "captcha",
        "STABLE_MS",
        "SSE_IDLE_MS",
        "MAX_WAIT_MS",
        "HOOK_TIMEOUT_MS",
    ):
        assert key in config, f"config.js lost `{key}`"


def test_websocket_url_is_loopback_only():
    config = (SHARED / "config.js").read_text(encoding="utf-8")
    urls = re.findall(r"ws://[^\s'\"]+", config)
    assert urls, "no WebSocket URL found"
    for url in urls:
        assert re.match(r"ws://(127\.0\.0\.1|localhost):\d+/ws/browser", url), f"non-local URL: {url}"


def test_scripts_avoid_eval_and_remote_code():
    """A cheap guard against accidental remote code / inline evaluation."""
    for name in ALL_SCRIPTS:
        source = (SHARED / name).read_text(encoding="utf-8")
        assert "eval(" not in source, f"{name} uses eval()"
        assert "new Function(" not in source, f"{name} uses new Function()"
        assert not re.search(r"https?://(?!arena\.ai|127\.0\.0\.1|localhost)[a-z0-9.-]+", source, re.I), (
            f"{name} references a remote host"
        )
        assert not re.search(r"\bfetch\(\s*['\"]https?://(?!127\.0\.0\.1|localhost)", source), (
            f"{name} posts data to a remote host"
        )


def test_inject_hook_only_observes():
    source = (SHARED / "inject.js").read_text(encoding="utf-8")
    assert "postMessage" in source
    for forbidden in ("document.cookie", "localStorage.getItem('token')", "Authorization", "fetch("):
        assert forbidden not in source, f"inject.js touches {forbidden}"


def test_cross_browser_guards_are_present():
    """The shared sources must stay loadable in both engines."""
    background = (SHARED / "background.js").read_text(encoding="utf-8")
    assert "typeof importScripts === 'function'" in background, (
        "background.js must guard importScripts (Firefox event pages do not have it)"
    )
    assert "browser.runtime.getBrowserInfo" in background, "no Firefox detection in background.js"
    assert "periodInMinutes: PING_PERIOD_MINUTES" in background, (
        "Firefox requires >= 1 minute alarm periods"
    )

    content = strip_comments((SHARED / "content.js").read_text(encoding="utf-8"))
    assert "PageHook" in content, "content.js must own the page-hook bootstrap"
    assert "chrome.scripting" not in content and "browser.scripting" not in content, (
        "content.js must not call the scripting API directly - it has no valid tabId"
    )
    assert "kind: 'inject-page-hook'" in content, "content.js must ask the background worker instead"
    assert "scripting.executeScript" in background, "the runtime page-hook fallback lives in background.js"

    popup = (SHARED / "popup.js").read_text(encoding="utf-8")
    assert "permissions.request" in popup, "the popup must be able to request Firefox host permissions"


def test_extensions_have_no_stale_duplicates():
    """shared/ is the single source of truth: no browser folder may hold JS."""
    for browser in ("chrome", "firefox"):
        folder = EXTENSIONS / browser
        assert [p.name for p in folder.iterdir()] == ["manifest.json"], (
            f"extensions/{browser} should only contain manifest.json (found {[p.name for p in folder.iterdir()]})"
        )
    assert not (ROOT / "extension").exists(), "the old extension/ folder must be gone"
