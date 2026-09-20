#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ArenaAgentBridge - curl examples.
#
#   1. start the server:            python -m server
#   2. open https://arena.ai/agent with the extension installed and log in
#   3. run a block below           ./test/curl_examples.sh
#
# Every command is copy-pasteable on its own; the script just runs them in
# sequence and prints a short explanation first.
# ---------------------------------------------------------------------------
set -uo pipefail

BASE="${AAB_BASE:-http://127.0.0.1:8000}"
KEY="${AAB_KEY:-sk-arena}"

hr() { printf '\n\033[1;36m%s\033[0m\n' "$*"; }

hr "0. Is the server up, and is a browser attached?"
curl -s "$BASE/healthz" | python3 -m json.tool
curl -s "$BASE/readyz" | python3 -m json.tool
curl -s "$BASE/v1/bridge/status" | python3 -m json.tool

hr "1. Model list (Hermes/OpenClaw call this on startup)"
curl -s "$BASE/v1/models" -H "Authorization: Bearer $KEY" | python3 -m json.tool

hr "2. Minimal chat completion"
curl -s "$BASE/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $KEY" \
  -d '{
        "model": "arena-agent",
        "messages": [{"role": "user", "content": "Reply with exactly: bridge ok"}]
      }' | python3 -m json.tool

hr "3. Multi-turn conversation (roles are flattened into one transcript)"
curl -s "$BASE/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d '{
        "model": "arena-agent",
        "messages": [
          {"role": "system", "content": "You are terse."},
          {"role": "user", "content": "Name the capital of France."},
          {"role": "assistant", "content": "Paris."},
          {"role": "user", "content": "And of Italy?"}
        ]
      }' | python3 -m json.tool

hr "4. Streaming (SSE, OpenAI chunk format)"
curl -N -s "$BASE/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d '{
        "model": "arena-agent",
        "stream": true,
        "messages": [{"role": "user", "content": "Count from 1 to 5, one number per line."}]
      }'

hr "5. Bridge-only extras: per-request timeout, direct mode, no sanitiser"
curl -s "$BASE/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d '{
        "model": "arena-agent-direct",
        "timeout": 120,
        "no_sanitize": true,
        "messages": [{"role": "user", "content": "Paste your last answer verbatim, no preamble."}]
      }' | python3 -m json.tool

hr "6. Error handling: nothing attached / captcha / wrong endpoint"
echo "-- wrong path (should be 404):"
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/v1/completions"
echo "-- server up but browser offline (503 with a hint):"
curl -s "$BASE/readyz" | python3 -m json.tool

hr "Done. Tips:"
cat <<'EOF'
  * `x_bridge` in every answer carries timings, queue wait and sanitiser findings.
  * The bridge is single-flight: concurrent requests queue up (see "queue_depth").
  * Set AAB_REQUEST_TIMEOUT=600 in .env for long coding tasks.
  * If you get `browser_offline`, the extension is not connected: open
    https://arena.ai/agent in Chrome and check the badge in the bottom-right.
EOF
