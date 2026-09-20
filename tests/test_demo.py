"""`scripts/demo.sh` is the first thing a new user runs, so it is part of the suite.

It starts the server in mock mode on a private port, pushes a request through the
real HTTP API (including a streamed one) and prints the bridge status. The script
used to die early on SIGPIPE from `head`, which this test now guards against.
"""

from __future__ import annotations

import os
import shutil
import subprocess

import pytest
from conftest import ROOT

SCRIPT = ROOT / "scripts" / "demo.sh"


@pytest.mark.skipif(shutil.which("curl") is None, reason="curl is required by the demo")
def test_demo_script_runs_to_completion(tmp_path):
    venv_python = ROOT / ".venv" / "bin" / "python"
    if not venv_python.exists():
        pytest.skip("no .venv - run scripts/run.sh first")

    env = {
        **os.environ,
        "AAB_PORT": "8199",
        "AAB_VENV": str(ROOT / ".venv"),
        "AAB_LOG_LEVEL": "warning",
    }
    result = subprocess.run(
        ["bash", str(SCRIPT)],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
    )
    output = result.stdout + result.stderr

    assert result.returncode == 0, f"demo.sh failed ({result.returncode}):\n{output}"
    assert '"object": "chat.completion"' in output, "the completion response is missing"
    assert "chat.completion.chunk" in output, "the streamed chunks are missing"
    assert '"connected": true' in output, "the demo stopped before the bridge status"
    assert "Done." in output, "the demo was cut short"
