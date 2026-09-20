#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Firefox development helper (wraps Mozilla's `web-ext`).
#
#   ./scripts/firefox-dev.sh            # build + launch Firefox with the add-on
#   ./scripts/firefox-dev.sh --lint     # run Mozilla's validator only
#   ./scripts/firefox-dev.sh --build    # produce dist/*.zip for signing
#
# Requires: node/npx, a Firefox installation (for --run).
# ---------------------------------------------------------------------------
set -euo pipefail

cd "$(dirname "$0")/.."

MODE="${1:-run}"
WEB_EXT_VERSION="${WEB_EXT_VERSION:-8}"

echo "==> building dist/firefox"
python3 scripts/build-extensions.py --browser firefox >/dev/null

case "$MODE" in
  --lint|lint)
    exec npx --yes "web-ext@${WEB_EXT_VERSION}" lint --source-dir dist/firefox
    ;;
  --build|build)
    python3 scripts/build-extensions.py --browser firefox --zip
    echo "==> artifacts in dist/"
    ;;
  run|--run|*)
    if ! command -v firefox >/dev/null 2>&1; then
      echo "warning: no 'firefox' binary on PATH; web-ext will try to find one"
    fi
    exec npx --yes "web-ext@${WEB_EXT_VERSION}" run \
      --source-dir dist/firefox \
      --start-url "https://arena.ai/agent" \
      --keep-profile-changes
    ;;
esac
