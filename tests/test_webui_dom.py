"""Runs the jsdom-based tests for the admin panel (tests/webui_dom_test.mjs).

The panel is plain JavaScript served from `server/assets/`; this wrapper keeps it
inside the normal test run (and skips cleanly when Node.js, jsdom or the Python
environment is missing):

    npm install --no-save jsdom     # or: npm install
    pytest -q
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "tests" / "webui_dom_test.mjs"


@pytest.mark.dom
def test_admin_panel_renders_in_jsdom():
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
    if "SKIP: jsdom is not installed" in output or "SKIP: could not render" in output:
        pytest.skip(output.strip().splitlines()[0])
    assert result.returncode == 0, f"admin panel DOM tests failed:\n{output}"
    assert "all admin panel DOM tests passed" in output, output
