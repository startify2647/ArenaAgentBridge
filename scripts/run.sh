#!/usr/bin/env bash
# Start the bridge server (loopback only). Creates a virtualenv on first run.
#
#   ./scripts/run.sh              # 127.0.0.1:8000
#   AAB_PORT=8100 ./scripts/run.sh
#   AAB_MOCK_BROWSER=1 ./scripts/run.sh   # no Chrome needed (canned answers)
set -euo pipefail

cd "$(dirname "$0")/.."
VENV="${AAB_VENV:-.venv}"
PYTHON="${PYTHON:-python3}"

if [ ! -d "$VENV" ]; then
  echo "creating virtualenv in $VENV"
  "$PYTHON" -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --upgrade pip
  "$VENV/bin/pip" install --quiet -r server/requirements.txt
fi

exec "$VENV/bin/python" -m server "$@"
