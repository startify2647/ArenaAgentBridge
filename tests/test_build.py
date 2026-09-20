"""The extension build (`scripts/build-extensions.py`) must produce loadable
packages for both browsers, and refuse to produce broken ones.

These tests build into a temporary directory (never touching `dist/`), so they
are safe to run while you have an unpacked extension loaded.
"""

from __future__ import annotations

import importlib.util
import json
import sys

import pytest
from conftest import CHROME_MANIFEST, FIREFOX_MANIFEST, ROOT, SHARED


def load_builder():
    path = ROOT / "scripts" / "build-extensions.py"
    spec = importlib.util.spec_from_file_location("build_extensions", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules["build_extensions"] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def builder(tmp_path, monkeypatch):
    module = load_builder()
    monkeypatch.setattr(module, "DIST", tmp_path / "dist")
    return module


@pytest.mark.parametrize("browser", ["chrome", "firefox"])
def test_build_produces_a_complete_extension(builder, browser):
    output = builder.build(browser)
    manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))

    assert manifest["manifest_version"] == 3
    for name in builder.referenced_files(manifest):
        assert (output / name).exists(), f"{browser}: {name} was not copied"

    # the shared sources must arrive byte-identical
    for source in sorted(SHARED.iterdir()):
        if source.is_file():
            assert (output / source.name).read_bytes() == source.read_bytes(), f"{browser}: {source.name} differs"


@pytest.mark.parametrize("browser", ["chrome", "firefox"])
def test_build_writes_valid_manifests(builder, browser):
    output = builder.build(browser)
    built = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
    source = json.loads(
        (CHROME_MANIFEST if browser == "chrome" else FIREFOX_MANIFEST).read_text(encoding="utf-8")
    )
    assert built == source


@pytest.mark.parametrize("browser", ["chrome", "firefox"])
def test_check_mode_writes_nothing(builder, browser):
    output = builder.build(browser, check_only=True)
    assert not output.exists()


def test_zip_option_packs_the_extension(builder):
    builder.build("firefox", zip_output=True)
    archives = list((builder.DIST).glob("*.zip"))
    assert len(archives) == 1
    import zipfile

    with zipfile.ZipFile(archives[0]) as bundle:
        names = set(bundle.namelist())
    assert "manifest.json" in names
    assert "content.js" in names
    assert "icons/icon128.png" in names


def test_version_mismatch_is_rejected(builder, monkeypatch):
    manifest = json.loads(CHROME_MANIFEST.read_text(encoding="utf-8"))
    manifest["version"] = "999.0.0"
    with pytest.raises(SystemExit):
        builder.validate("chrome", manifest, SHARED)


def test_firefox_manifest_without_service_worker_is_rejected(builder):
    manifest = json.loads(FIREFOX_MANIFEST.read_text(encoding="utf-8"))
    manifest["background"] = {"service_worker": "background.js"}
    with pytest.raises(SystemExit):
        builder.validate("firefox", manifest, SHARED)


def test_broad_host_permissions_are_rejected(builder):
    manifest = json.loads(CHROME_MANIFEST.read_text(encoding="utf-8"))
    manifest["host_permissions"] = ["<all_urls>"]
    with pytest.raises(SystemExit):
        builder.validate("chrome", manifest, SHARED)


def test_missing_referenced_file_is_rejected(builder, tmp_path):
    manifest = json.loads(CHROME_MANIFEST.read_text(encoding="utf-8"))
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(SystemExit):
        builder.validate("chrome", manifest, empty)
