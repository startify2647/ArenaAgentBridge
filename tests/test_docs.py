"""Documentation checks: the two READMEs must stay in sync and every relative
link in the docs must resolve to a real file.

Documentation rots faster than code; this keeps `README.md` (English) and
`README.fa.md` (Persian) honest about paths after a refactor.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from conftest import ROOT

DOCS = [ROOT / "README.md", ROOT / "README.fa.md", *sorted((ROOT / "docs").glob("*.md"))]
LINK = re.compile(r"\[([^\]]+)\]\(([^)\s]+)\)")


@pytest.mark.parametrize("path", DOCS, ids=lambda p: p.name)
def test_relative_links_resolve(path: Path):
    text = path.read_text(encoding="utf-8")
    missing = []
    for label, target in LINK.findall(text):
        if target.startswith(("http://", "https://", "mailto:", "#")):
            continue
        without_anchor = target.split("#")[0]
        if without_anchor and not (ROOT / without_anchor).exists():
            missing.append(f"{label} -> {target}")
    assert not missing, f"{path.relative_to(ROOT)} has broken links: {missing}"


def test_both_readmes_exist_and_point_at_each_other():
    english = (ROOT / "README.md").read_text(encoding="utf-8")
    persian = (ROOT / "README.fa.md").read_text(encoding="utf-8")
    assert "README.fa.md" in english, "the English README does not link to the Persian one"
    assert "README.md" in persian, "the Persian README does not link back to the English one"


def test_persian_readme_is_rtl_wrapped():
    lines = (ROOT / "README.fa.md").read_text(encoding="utf-8").splitlines()
    assert lines[0].strip() == '<div dir="rtl">', "the Persian README must open with <div dir=\"rtl\">"
    assert lines[1].strip() == "", "a blank line after the div is required for markdown to be parsed"
    assert lines[-1].strip() == "</div>", "the Persian README must close the rtl wrapper"
    assert lines[-2].strip() == "", "a blank line before </div> keeps the last block intact"


def test_persian_readme_covers_the_essentials():
    text = (ROOT / "README.fa.md").read_text(encoding="utf-8")
    for needle in (
        "127.0.0.1:8000",
        "/v1/chat/completions",
        "arena-agent",
        "ws://127.0.0.1:8000/ws/browser",
        "dist/chrome",
        "dist/firefox",
        "AAB_SANITIZE_MODE",
        "make test",
        "هشدار حقوقی",
    ):
        assert needle in text, f"the Persian README lost `{needle}`"


def test_readme_promises_match_the_repo():
    """A few things the READMEs claim; they must be true in the tree."""
    english = (ROOT / "README.md").read_text(encoding="utf-8")
    assert (ROOT / "extensions" / "shared" / "config.js").is_file()
    assert (ROOT / "extensions" / "chrome" / "manifest.json").is_file()
    assert (ROOT / "extensions" / "firefox" / "manifest.json").is_file()
    assert (ROOT / "scripts" / "build-extensions.py").is_file()
    assert (ROOT / "scripts" / "demo.sh").is_file()
    assert (ROOT / "Makefile").is_file()
    # the documented version must be the real one
    config = (ROOT / "extensions" / "shared" / "config.js").read_text(encoding="utf-8")
    version = re.search(r"CONFIG\.version\s*=\s*'([^']+)'", config).group(1)  # type: ignore[union-attr]
    assert f"`{version}`" in english or version in english, "the README does not state the current version"
