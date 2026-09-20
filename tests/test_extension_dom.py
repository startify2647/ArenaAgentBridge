"""Runs the jsdom-based DOM tests for the extension (tests/extension_dom_test.mjs).

Skipped when Node.js or jsdom is unavailable, so the Python suite still works on
a bare checkout:

    npm install --no-save jsdom     # or: npm install
    pytest -q
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "tests" / "extension_dom_test.mjs"


@pytest.mark.dom
def test_extension_automation_pipeline_in_jsdom():
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed")

    result = subprocess.run(
        [node, str(SCRIPT)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=300,
    )
    output = result.stdout + result.stderr
    if "SKIP: jsdom is not installed" in output:
        pytest.skip("jsdom is not installed (npm install --no-save jsdom)")
    assert result.returncode == 0, f"DOM tests failed:\n{output}"
    assert "all extension DOM tests passed" in output, output
