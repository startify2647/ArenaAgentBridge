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


# ---------------------------------------------------------------------------
# the extension UI (popup + options page) and its settings layer
# ---------------------------------------------------------------------------
UI_PAGES = ("popup.html", "options.html")
UI_SCRIPTS = ("settings.js", "i18n.js", "popup.js", "options.js")


def test_ui_pages_and_scripts_exist():
    for name in (*UI_PAGES, *UI_SCRIPTS):
        assert (SHARED / name).is_file(), f"extensions/shared/{name} is missing"


def test_both_manifests_expose_the_options_page(chrome_manifest, firefox_manifest):
    for manifest in (chrome_manifest, firefox_manifest):
        options = manifest.get("options_ui") or {}
        assert options.get("page") == "options.html"
        assert options.get("open_in_tab") is True, "options must open in a tab (room to think)"
        assert (SHARED / options["page"]).is_file()


def test_ui_pages_are_self_contained_and_script_driven():
    """No CDN, no inline handlers - the pages must survive an offline machine."""
    for name in UI_PAGES:
        html = (SHARED / name).read_text(encoding="utf-8")
        assert "settings.js" in html and "i18n.js" in html, f"{name} must load the shared modules"
        assert html.index("settings.js") < html.index(name.replace(".html", ".js")), (
            f"{name} must load settings.js before its own script"
        )
        assert 'src="http' not in html and "cdn." not in html, f"{name} pulls a remote asset"
        for inline in ("onclick=", "onchange=", "onload=", "onerror="):
            assert inline not in html, f"{name} uses {inline} (blocked by the extension CSP)"
        assert "<style>" in html, f"{name} should carry its own styles"


def test_content_script_loads_the_settings_layer(chrome_manifest, firefox_manifest):
    for manifest in (chrome_manifest, firefox_manifest):
        js = manifest["content_scripts"][0]["js"]
        assert js == ["config.js", "settings.js", "content.js"], js


def test_settings_fields_are_bilingual_and_cover_the_config_knobs():
    source = (SHARED / "settings.js").read_text(encoding="utf-8")
    config = (SHARED / "config.js").read_text(encoding="utf-8")
    fields = re.findall(r"path: '([^']+)', group: '([^']+)'", source)
    assert len(fields) >= 15, f"the settings model lost fields ({len(fields)} found)"
    for path, group in fields:
        assert group in {"connection", "automation", "capture", "advanced"}, f"{path}: odd group {group}"
        leaf = path.split(".")[-1]
        assert leaf in config, f"{path} does not exist in config.js"
    # every field needs a Persian label/help for the bilingual UI
    assert source.count("label_fa:") == len(fields)
    assert source.count("help_fa:") == len(fields)
    for needle in ("aabOverrides", "serverUrl", "LOOPBACK_WS", "exportJson", "fromJson", "httpUrl"):
        assert needle in source, f"settings.js lost {needle}"


def test_i18n_dictionaries_stay_in_sync():
    source = (SHARED / "i18n.js").read_text(encoding="utf-8")

    def keys(block: str) -> list:
        return sorted(re.findall(r"'([a-z0-9_.]+)':", block))

    english = source[source.index("en: {"): source.index("fa: {")]
    persian = source[source.index("fa: {"):]
    en_keys, fa_keys = keys(english), keys(persian)
    assert len(en_keys) > 20, "the dictionary looks truncated"
    assert en_keys == fa_keys, f"untranslated: {sorted(set(en_keys) - set(fa_keys))}"
    assert "dir" in source and "rtl" in source, "the Persian UI must switch the layout to RTL"
    assert "aabLang" in source, "the language choice is not remembered"


def test_ui_scripts_are_api_safe():
    """The UI scripts must not reach beyond the extension APIs they need."""
    for name in UI_SCRIPTS:
        source = (SHARED / name).read_text(encoding="utf-8")
        assert "eval(" not in source and "new Function(" not in source
        assert "document.cookie" not in source
        for match in re.finditer(r"https?://([a-z0-9.-]+)", source, re.I):
            assert match.group(1) in {"arena.ai", "127.0.0.1", "localhost", "github.com"}, match.group(0)


def test_popup_links_to_the_admin_panel():
    popup = (SHARED / "popup.js").read_text(encoding="utf-8")
    assert "/admin" in popup, "the popup must be able to open the server's admin panel"
    assert "__AAB_SETTINGS__" in popup, "the popup must reuse the shared settings model"
    assert "httpUrl" in popup, "the popup must derive the HTTP url from the websocket url"
