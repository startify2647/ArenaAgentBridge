"""Documentation checks: the English and Persian docs must stay in sync, and every
relative link must resolve *from the file that contains it*.

Documentation rots faster than code; this keeps `README.md` / `README.fa.md` and
the `docs/*.md` pairs honest about paths after a refactor.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from conftest import ROOT

DOCS_DIR = ROOT / "docs"
LINK = re.compile(r"\[([^\]]+)\]\(([^)\s]+)\)")

# glob("*.md") also matches "X.fa.md", so filter the Persian copies out
ENGLISH_DOCS = sorted(p for p in DOCS_DIR.glob("*.md") if not p.name.endswith(".fa.md"))
PERSIAN_DOCS = [ROOT / "README.fa.md", ROOT / "extensions" / "README.fa.md",
                *sorted(DOCS_DIR.glob("*.fa.md"))]
ALL_DOCS = sorted({ROOT / "README.md", ROOT / "extensions" / "README.md", *ENGLISH_DOCS, *PERSIAN_DOCS})


def display(path: Path) -> str:
    return str(path.relative_to(ROOT))


@pytest.mark.parametrize("path", ALL_DOCS, ids=display)
def test_relative_links_resolve(path: Path):
    """Markdown links are relative to the containing file, not to the repo root."""
    missing = []
    for label, target in LINK.findall(path.read_text(encoding="utf-8")):
        if target.startswith(("http://", "https://", "mailto:", "#")):
            continue
        without_anchor = target.split("#")[0]
        if without_anchor and not (path.parent / without_anchor).exists():
            missing.append(f"[{label}]({target})")
    assert not missing, f"{display(path)} has broken links: {missing}"


@pytest.mark.parametrize("path", PERSIAN_DOCS, ids=display)
def test_persian_docs_are_rtl_wrapped(path: Path):
    lines = path.read_text(encoding="utf-8").splitlines()
    assert lines[0].strip() == '<div dir="rtl">', "must open with <div dir=\"rtl\">"
    assert lines[1].strip() == "", "a blank line after the div is required for markdown parsing"
    assert lines[-1].strip() == "</div>", "must close the rtl wrapper"
    assert lines[-2].strip() == "", "a blank line before </div> keeps the last block intact"


def test_every_doc_has_a_persian_counterpart():
    missing = [
        path.name
        for path in ENGLISH_DOCS
        if not (path.parent / path.name.replace(".md", ".fa.md")).is_file()
    ]
    assert not missing, f"docs without a Persian copy: {missing}"
    assert (ROOT / "extensions" / "README.fa.md").is_file(), "extensions/README.fa.md is missing"


@pytest.mark.parametrize("path", [*ENGLISH_DOCS, ROOT / "extensions" / "README.md"], ids=display)
def test_english_docs_link_to_the_persian_copy(path: Path):
    text = path.read_text(encoding="utf-8")
    persian = path.name.replace(".md", ".fa.md")
    assert persian in text, f"{display(path)} does not link to {persian}"


@pytest.mark.parametrize("path", PERSIAN_DOCS, ids=display)
def test_persian_docs_link_back_to_english(path: Path):
    text = path.read_text(encoding="utf-8")
    english = path.name.replace(".fa.md", ".md")
    assert english in text, f"{display(path)} does not link back to {english}"


def test_both_readmes_exist_and_point_at_each_other():
    english = (ROOT / "README.md").read_text(encoding="utf-8")
    persian = (ROOT / "README.fa.md").read_text(encoding="utf-8")
    assert "README.fa.md" in english, "the English README does not link to the Persian one"
    assert "README.md" in persian, "the Persian README does not link back to the English one"


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
    assert version in english, "the README does not state the current version"
