# ArenaAgentBridge - common tasks.
# Everything is optional: plain scripts/ commands work just as well.

PY ?= python3
VENV ?= .venv
PORT ?= 8000

.DEFAULT_GOAL := help
.PHONY: help install run demo test test-server test-dom lint format icons build build-check clean firefox-lint doctor

help: ## show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1;36m%-14s\033[0m %s\n", $$1, $$2}'

install: ## create .venv and install server dependencies (+ jsdom for the DOM tests)
	$(PY) -m venv $(VENV)
	$(VENV)/bin/pip install --quiet --upgrade pip
	$(VENV)/bin/pip install --quiet -r server/requirements-dev.txt
	@command -v npm >/dev/null 2>&1 && npm install --silent --no-audit --no-fund || \
		echo "npm not found - skipping jsdom (the DOM tests will be skipped)"

run: ## start the bridge server (loopback, needs Chrome/Firefox with the extension)
	$(VENV)/bin/python -m server

demo: ## start the server in mock mode and run a request through it (no browser)
	./scripts/demo.sh

test: test-server test-dom ## run everything that does not need a browser

test-server: ## python test suite (server, build, static extension checks)
	$(VENV)/bin/python -m pytest -q

test-dom: ## jsdom test suite for the extension automation
	node tests/extension_dom_test.mjs

lint: ## ruff + JavaScript syntax + manifest JSON
	$(VENV)/bin/ruff check .
	@for f in extensions/shared/*.js; do node --check "$$f"; done
	@$(PY) -m json.tool extensions/chrome/manifest.json > /dev/null
	@$(PY) -m json.tool extensions/firefox/manifest.json > /dev/null
	@echo "lint ok"

format: ## apply ruff fixes
	$(VENV)/bin/ruff check . --fix

icons: ## regenerate extensions/shared/icons
	$(PY) scripts/make_icons.py

build: ## build both extensions into dist/
	$(PY) scripts/build-extensions.py

build-check: ## validate the manifests without writing anything
	$(PY) scripts/build-extensions.py --check

firefox-lint: ## validate dist/firefox with Mozilla's validator
	$(PY) scripts/build-extensions.py --browser firefox >/dev/null
	npx --yes web-ext@8 lint --source-dir dist/firefox

doctor: ## quick health check: is the server up, is a browser attached?
	@curl -sf http://127.0.0.1:$(PORT)/healthz || echo "server is not running (make run)"
	@curl -s http://127.0.0.1:$(PORT)/v1/bridge/status | $(PY) -m json.tool 2>/dev/null || true

clean: ## remove build/test artifacts (keeps .venv and node_modules)
	rm -rf dist .pytest_cache .ruff_cache
	find . -name '__pycache__' -type d -prune -exec rm -rf {} +
