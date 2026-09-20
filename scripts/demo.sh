#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Full demo WITHOUT Chrome: starts the server with the built-in mock browser and
# sends a real request through the OpenAI endpoint, including a streamed one.
#
#   ./scripts/demo.sh
# ---------------------------------------------------------------------------
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="${AAB_PORT:-8123}"
BASE="http://127.0.0.1:$PORT"
VENV="${AAB_VENV:-.venv}"
PYTHON="${PYTHON:-python3}"

if [ ! -x "$VENV/bin/python" ]; then
  "$PYTHON" -m venv "$VENV"
  "$VENV/bin/pip" install --quiet -r server/requirements.txt
fi

echo "==> starting the bridge with the mock browser on port $PORT"
AAB_MOCK_BROWSER=1 AAB_PORT="$PORT" AAB_LOG_LEVEL="${AAB_LOG_LEVEL:-warning}" \
  "$VENV/bin/python" -m server &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf "$BASE/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.25
done

echo
echo "==> GET /v1/models"
curl -s "$BASE/v1/models" | "$VENV/bin/python" -m json.tool

echo
echo "==> POST /v1/chat/completions"
curl -s "$BASE/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer sk-arena' \
  -d '{"model":"arena-agent","messages":[{"role":"user","content":"hello bridge"}]}' \
  | "$VENV/bin/python" -m json.tool

echo
echo "==> POST /v1/chat/completions (stream: true, first 12 SSE lines)"
# `head` closes the pipe early, which makes curl exit with a write error - that
# is expected here, so pipefail must not kill the script.
set +o pipefail
curl -N -s "$BASE/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d '{"model":"arena-agent","stream":true,"messages":[{"role":"user","content":"stream please"}]}' \
  | head -n 12 || true
set -o pipefail

echo
echo "==> bridge status"
curl -s "$BASE/v1/bridge/status" | "$VENV/bin/python" -m json.tool

echo
echo "Done. With Chrome + the extension, drop AAB_MOCK_BROWSER and use port 8000."
