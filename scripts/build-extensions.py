#!/usr/bin/env python3
"""Build the browser extensions from the shared sources.

Layout
------
    extensions/shared/           one source of truth for every browser
    extensions/chrome/manifest.json
    extensions/firefox/manifest.json
    extensions/shared/icons/     icons used by both

The build copies `shared/` + the browser's manifest into `dist/<browser>/`, which
is the directory you load in the browser. Nothing is duplicated in git.

    python scripts/build-extensions.py                # both browsers
    python scripts/build-extensions.py --browser firefox
    python scripts/build-extensions.py --zip          # also write dist/*.zip
    python scripts/build-extensions.py --check        # validate, write nothing

The script also validates that every file referenced by a manifest was actually
copied, that the versions agree with `shared/config.js`, and that no
browser-specific API leaked into the wrong manifest.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import zipfile
from pathlib import Path
from typing import Dict, List

ROOT = Path(__file__).resolve().parent.parent
EXT_DIR = ROOT / "extensions"
SHARED = EXT_DIR / "shared"
DIST = ROOT / "dist"
BROWSERS = ("chrome", "firefox")

MANIFEST_FILE_KEYS = (
    "background.service_worker",
    "action.default_popup",
)


def display(path: Path) -> str:
    """`dist/chrome` when inside the repo, the full path otherwise."""
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def read_json(path: Path) -> Dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        fail(f"{path.relative_to(ROOT)} is not valid JSON: {exc}")
    return {}


def config_version() -> str:
    source = (SHARED / "config.js").read_text(encoding="utf-8")
    match = re.search(r"CONFIG\.version\s*=\s*'([^']+)'", source)
    if not match:
        fail("extensions/shared/config.js does not declare CONFIG.version")
    return match.group(1)


def referenced_files(manifest: Dict) -> List[str]:
    """Every file path a manifest points at (so we can prove they exist)."""
    files: List[str] = []

    background = manifest.get("background") or {}
    if background.get("service_worker"):
        files.append(background["service_worker"])
    files.extend(background.get("scripts") or [])

    for entry in manifest.get("content_scripts") or []:
        files.extend(entry.get("js") or [])
        files.extend(entry.get("css") or [])

    for entry in manifest.get("web_accessible_resources") or []:
        files.extend(entry.get("resources") or [])

    action = manifest.get("action") or manifest.get("browser_action") or {}
    if action.get("default_popup"):
        files.append(action["default_popup"])
    for size in ("default_icon", "icons"):
        icons = manifest.get(size) if size == "icons" else action.get("default_icon") or {}
        files.extend((icons or {}).values())

    # de-duplicate, keep order
    seen = set()
    unique = []
    for name in files:
        if name not in seen:
            seen.add(name)
            unique.append(name)
    return unique


def validate(browser: str, manifest: Dict, output: Path) -> None:
    version = config_version()
    if manifest.get("manifest_version") != 3:
        fail(f"{browser}: manifest_version must be 3")
    if manifest.get("version") != version:
        fail(
            f"{browser}: manifest version {manifest.get('version')!r} does not match "
            f"config.js version {version!r}"
        )

    background = manifest.get("background") or {}
    if browser == "chrome" and "service_worker" not in background:
        fail("chrome: background.service_worker is required")
    if browser == "firefox":
        if "scripts" not in background:
            fail("firefox: background.scripts is required (Firefox has no MV3 service worker)")
        gecko = (manifest.get("browser_specific_settings") or {}).get("gecko") or {}
        if not gecko.get("id"):
            fail("firefox: browser_specific_settings.gecko.id is required")
        if "optional_host_permissions" not in manifest:
            fail("firefox: optional_host_permissions is required (MV3 host permissions are opt-in)")

    # loopback / site only
    for origin in manifest.get("host_permissions") or []:
        if origin == "<all_urls>" or "*://*/*" in origin:
            fail(f"{browser}: host_permissions must not include {origin}")
    if manifest.get("content_scripts"):
        matches = manifest["content_scripts"][0].get("matches") or []
        if matches != ["https://arena.ai/*"]:
            fail(f"{browser}: content script matches should be exactly https://arena.ai/*")

    missing = [name for name in referenced_files(manifest) if not (output / name).is_file()]
    if missing:
        fail(f"{browser}: manifest references missing files: {', '.join(missing)}")

    for script in ("content.js", "background.js", "config.js", "inject.js", "popup.js"):
        text = (output / script).read_text(encoding="utf-8")
        if re.search(r"\beval\s*\(", text) or "new Function(" in text:
            fail(f"{browser}: {script} uses dynamic code evaluation")
        remote = re.findall(r"https?://(?!arena\.ai|127\.0\.0\.1|localhost)[\w.-]+", text)
        if remote:
            fail(f"{browser}: {script} references remote host(s): {', '.join(sorted(set(remote)))}")


def build(browser: str, zip_output: bool = False, check_only: bool = False) -> Path:
    manifest_path = EXT_DIR / browser / "manifest.json"
    if not manifest_path.is_file():
        fail(f"{manifest_path.relative_to(ROOT)} is missing")
    manifest = read_json(manifest_path)

    output = DIST / browser
    if check_only:
        # validate against the shared sources without copying
        validate(browser, manifest, SHARED)
        print(f"{browser}: manifest ok ({len(referenced_files(manifest))} referenced files)")
        return output

    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True, exist_ok=True)

    for item in sorted(SHARED.iterdir()):
        if item.name == "icons":
            shutil.copytree(item, output / "icons")
        elif item.is_file():
            shutil.copy2(item, output / item.name)

    shutil.copy2(manifest_path, output / "manifest.json")
    validate(browser, manifest, output)

    if zip_output:
        archive = DIST / f"arena-agent-bridge-{browser}-{manifest['version']}.zip"
        if archive.exists():
            archive.unlink()
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
            for path in sorted(output.rglob("*")):
                if path.is_file():
                    bundle.write(path, path.relative_to(output))
        print(f"packed {display(archive)}")

    files = len([p for p in output.rglob("*") if p.is_file()])
    print(f"built {display(output)} ({files} files, v{manifest['version']})")
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the Chrome and Firefox extensions")
    parser.add_argument("--browser", choices=BROWSERS, action="append", help="build only this browser")
    parser.add_argument("--zip", action="store_true", help="also write dist/*.zip (for AMO / Chrome Web Store)")
    parser.add_argument("--check", action="store_true", help="validate manifests, copy nothing")
    args = parser.parse_args()

    if not SHARED.is_dir():
        fail("extensions/shared is missing")

    browsers = args.browser or list(BROWSERS)
    for browser in browsers:
        build(browser, zip_output=args.zip, check_only=args.check)

    if not args.check:
        print(
            "\nLoad them as unpacked extensions:\n"
            f"  Chrome/Edge : {DIST / 'chrome'}\n"
            f"  Firefox     : {DIST / 'firefox'}  (about:debugging -> Load Temporary Add-on -> manifest.json)"
        )


if __name__ == "__main__":
    main()
