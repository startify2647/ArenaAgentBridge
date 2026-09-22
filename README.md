# ArenaAgentBridge

**A local, OpenAI-compatible bridge from agent frameworks (Hermes, OpenClaw,
LiteLLM, Open WebUI, plain `curl`) to the [Arena.ai](https://arena.ai) web UI -
through a real, already-logged-in browser session.**

No official API. No reCAPTCHA token. No stored cookies. No captcha bypass. Just a
real browser doing what it already does, with a FastAPI server and one shared
extension codebase packaged for **Chrome/Edge and Firefox**.

```
Hermes / OpenClaw
      │  OpenAI Chat Completions  (HTTP, 127.0.0.1:8000)
      ▼
FastAPI server ── queue ──▶ WebSocket /ws/browser
      │                            │
      │                            ▼
      │                  browser extension (content script)
      │                            │  DOM automation (type, click, read)
      │                            ▼
      └──────────────◀──     https://arena.ai/agent
```

Everything runs on your machine. The browser talks to the public website exactly
as it normally would; the bridge never sends your data anywhere else, never
touches cookies, and never stores credentials.

**Languages:** English (this file) · [فارسی](README.fa.md) · **Version:** `1.4.1`

> ⚠️ **Read this first.** Automating the site this way very likely violates
> Arena.ai's Terms of Service and your account may be limited or banned. The
> bridge is *not* a bypass: it uses your own logged-in session and your own
> machine, at your own risk, for personal and experimental use only. See
> [Legal & safety](#legal--safety).

---

## Contents

- [How it works](#how-it-works)
- [Quick start (5 minutes)](#quick-start-5-minutes)
- [Web UI and admin panel](#web-ui-and-admin-panel)
- [Firefox](#firefox)
- [No-browser demo (30 seconds)](#no-browser-demo-30-seconds)
- [Configuration](#configuration)
- [Extension reference](#extension-reference)
- [API](#api)
- [Troubleshooting](#troubleshooting)
- [Security model](#security-model)
- [Limitations](#limitations)
- [Changelog](#changelog)
- [Project layout](#project-layout)
- [Development](#development)
- [Legal & safety](#legal--safety)

---

## How it works

1. Hermes/OpenClaw sends a normal `POST /v1/chat/completions`.
2. The server flattens `messages[]` into a single labelled transcript and queues
   the request (**one request at a time** - the page can only answer one prompt).
3. The extension (connected over WebSocket) types the prompt into the chat box
   using the native setter + `input` event React expects, then clicks **Send**.
4. It watches the DOM - plus the site's own streaming frames (`a0:`/`ag:`/`ad:`)
   for exact start/stop detection - until the answer stops changing. The
   observation is event-driven and incremental (each stream frame is parsed
   once), and while no request runs the extension leaves the page's traffic
   alone, so it stays light on the browser.
   On every arena.ai page that is **not** the agent page the extension stays
   fully dormant (no socket, no observers, no page traffic wrapping), and
   during a capture it only re-reads the answer when the page actually
   changed it - so an idle tab costs (almost) nothing.
5. The answer travels back to the server, is passed through the destructive-command
   sanitiser, and is returned as `chat.completion` JSON (or as an SSE stream).
   Delivery is guaranteed across socket blinks: undelivered answers wait in a
   small outbox, and the server re-sends in-flight requests to a tab that
   reconnects within `AAB_RECONNECT_GRACE` seconds.

Failure modes are explicit instead of silent: `captcha_required`,
`login_required`, `dom_changed`, `page_timeout`, `browser_offline`, ... each maps
to a documented HTTP status and an OpenAI-shaped error body.

## Quick start (5 minutes)

**Requirements:** Python 3.10+, Chrome/Edge 111+ or Firefox 128+, Linux/macOS/Windows.

### 1. Start the server

```bash
git clone https://github.com/startify2647/ArenaAgentBridge.git arena-agent-bridge
cd arena-agent-bridge

./scripts/run.sh                 # creates .venv, installs deps, listens on 127.0.0.1:8000
```

Or manually:

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r server/requirements.txt
python -m server                 # same thing, without the venv helper
cp .env.example .env             # optional: tune timeouts, sanitiser, port
```

Check it: <http://127.0.0.1:8000/> (status dashboard) or
`curl -s http://127.0.0.1:8000/v1/bridge/status | python -m json.tool`.

### 2. Build and load the extension

```bash
python scripts/build-extensions.py     # → dist/chrome and dist/firefox
```

| browser | load it |
| --- | --- |
| **Chrome / Edge / Brave** | `chrome://extensions` → enable *Developer mode* → **Load unpacked** → `dist/chrome` |
| **Firefox 128+** | `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → `dist/firefox/manifest.json`, then press **Grant permissions** in the popup |

Then open <https://arena.ai/agent> and make sure you are **logged in**. The badge
in the bottom-right corner of the page should read `bridge: connected`; the
extension popup shows the server, the bridge tab and a **Diagnose DOM** button.

> The extension sources live in `extensions/shared/` and are copied into
> `dist/<browser>/` by the build, so both browsers run the *same* JavaScript. Load
> `dist/...`, not the sources. See [`extensions/README.md`](extensions/README.md).

### 3. Talk to it

```bash
curl -s http://127.0.0.1:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer sk-arena' \
  -d '{
        "model": "arena-agent",
        "messages": [{"role": "user", "content": "Reply with exactly: bridge ok"}]
      }' | python -m json.tool
```

More examples (streaming, multi-turn, errors): [`tests/curl_examples.sh`](tests/curl_examples.sh).

### 4. Point Hermes / OpenClaw at it

| setting           | value                                   |
| ----------------- | --------------------------------------- |
| Base URL          | `http://127.0.0.1:8000/v1`              |
| Compatibility     | **Chat Completions**                    |
| API key           | any value, e.g. `sk-arena`              |
| Model ID          | `arena-agent`                           |
| Streaming         | supported                               |

Details and per-client recipes: [`docs/HERMES_OPENCLAW.md`](docs/HERMES_OPENCLAW.md).

## Firefox

The same extension, packaged for Gecko. Firefox-specific facts:

* **Host permissions are opt-in** (MV3): the popup shows a yellow *permissions*
  card → **Grant permissions** (asks for `127.0.0.1:8000`, `localhost:8000` and
  `arena.ai`). Without it you get `browser_offline` in the popup.
* **Temporary add-ons** disappear when Firefox closes; permanent installs require
  signing (AMO or Developer Edition/Nightly with signature checks off). The
  options are laid out in [`docs/FIREFOX.md`](docs/FIREFOX.md).
* The background is an **event page**, not a service worker, so there is no
  service-worker console - use `about:debugging` → *Inspect*.
* The optional page-world stream hook may be blocked by the site's CSP; the
  extension then falls back to DOM-only completion detection (slower, still
  correct). The popup's *Diagnose DOM* shows `page hook: active/inactive`.

Development loop: `./scripts/firefox-dev.sh` (launches Firefox with the add-on),
`./scripts/firefox-dev.sh --lint` (Mozilla's validator, also in CI).

## No-browser demo (30 seconds)

Proves the whole pipeline without a browser (canned answers, obviously):

```bash
./scripts/demo.sh        # or: make demo
```

It starts the server with `AAB_MOCK_BROWSER=1`, calls `/v1/models`, a completion,
a streamed completion and `/v1/bridge/status`.

You can also fake just the browser while using the real server - useful to test
an integration before touching selectors:

```bash
python -m server                                   # terminal 1
python tests/dev_ws_client.py --reply "hello"      # terminal 2: fake browser
curl -s http://127.0.0.1:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"arena-agent","messages":[{"role":"user","content":"ping"}]}'   # terminal 3
```

## Web UI and admin panel

Two interfaces ship with the bridge - both local-only, no build step, no CDN:

```bash
./scripts/run.sh                                  # start the server
xdg-open http://127.0.0.1:8000/admin              # the admin panel
# aliases: http://127.0.0.1:8000/ · /ui · /panel
```

* **Admin panel** (`/admin`): live dashboard (browser, queue, latency, in-flight
  request, recent errors), a **playground** that runs real prompts through the
  whole chain, the **request history** (bounded, in RAM, filterable, exportable),
  browser control (ping / diagnose DOM / cancel / disconnect), a sanitiser
  dry-run inspector, a runtime **settings** form (apply without restart, copy the
  matching `.env`), a self-check list and ready-to-paste connection snippets.
  Bilingual **English/فارسی** with RTL, dark/light theme, and auto-refresh you
  can pause. It answers to the same `AAB_REQUIRE_API_KEY` as the API.
* **Extension UI**: the toolbar popup (status, **quick test** through the bridge,
  diagnose DOM, settings, reconnect/cancel) and the full **options page**
  (server url, API key, thresholds, capture, import/export/reset, Firefox
  permissions). Settings are validated, stored in `chrome.storage.local` and
  applied by the content script immediately.

Knobs: `AAB_PANEL_ENABLED`, `AAB_PANEL_REFRESH_MS`, `AAB_HISTORY_SIZE`.
Full reference: [`docs/WEBUI.md`](docs/WEBUI.md) · [فارسی](docs/WEBUI.fa.md).

## Configuration

Server: copy [`.env.example`](.env.example) to `.env`. The environment always wins
over the file. The important knobs:

| variable                | default | what it does                                            |
| ----------------------- | ------- | ------------------------------------------------------- |
| `AAB_HOST` / `AAB_PORT` | `127.0.0.1` / `8000` | where the API listens - keep it on loopback |
| `AAB_REQUEST_TIMEOUT`   | `300`   | seconds to wait for the page                            |
| `AAB_QUEUE_MAX_SIZE`    | `64`    | waiting requests before HTTP 429                        |
| `AAB_DEFAULT_MODE`      | `agent` | `agent` = preamble + transcript, `direct` = transcript only |
| `AAB_SANITIZE_MODE`     | `redact`| `off` / `detect` / `redact` destructive commands        |
| `AAB_PATTERNS_FILE`     | –       | JSON file with extra sanitiser rules                    |
| `AAB_REQUIRE_API_KEY`   | `0`     | `1` + `AAB_API_KEY=…` to require a real Bearer token     |
| `AAB_STREAM_CHUNK_CHARS` / `AAB_STREAM_CHUNK_DELAY_MS` | `32` / `12` | SSE replay pace |
| `AAB_MOCK_BROWSER`      | `0`     | `1` = answer without a browser (testing only)           |
| `AAB_RECONNECT_GRACE`   | `8`     | seconds to keep an in-flight request alive after the extension socket drops, so a reconnecting tab can finish it |
| `AAB_LOG_LEVEL` / `AAB_LOG_JSON` | `INFO` / `0` | logging verbosity / format        |

Extension: everything site-specific lives in
[`extensions/shared/config.js`](extensions/shared/config.js) - selectors, stability
thresholds, SSE prefixes, debug flags. You can override values live from DevTools
- the content script runs in the extension's *isolated world*, so first switch the
console's context dropdown (top of the Console panel) to the extension entry,
then:

```js
__AAB_CONFIG__.selectors.input.unshift('textarea.my-new-class');
__AAB__.diagnose();
```

## Extension reference

Sources live in `extensions/shared/`; `extensions/chrome/manifest.json` and
`extensions/firefox/manifest.json` are the only browser-specific files.

| file            | role |
| --------------- | ---- |
| `shared/config.js`     | all selectors, thresholds and flags (the first file to edit) |
| `shared/content.js`    | owns the WebSocket; types the prompt, clicks Send, reads the answer |
| `shared/inject.js`     | page-world hook that *observes* the site's WebSocket/SSE traffic for start/stop detection |
| `shared/background.js` | connection lease to one tab, keepalive, script re-injection, optional page-hook injection |
| `shared/settings.js`   | the settings/override model (validation, storage, export/import) shared by the popup, the options page and the content script |
| `shared/i18n.js`       | English/Persian strings + the `data-i18n` applier |
| `shared/popup.html/js` | status, **Quick test**, **Diagnose DOM**, settings, permissions (Firefox), reconnect, cancel |
| `shared/options.html/js` | the full options page: server url + API key, thresholds, capture, import/export/reset, permissions |
| `shared/icons/`        | generated by `python scripts/make_icons.py` |

Key behaviour knobs in `config.js`:

| knob                | default | meaning |
| ------------------- | ------- | ------- |
| `INPUT_WAIT_MS`     | `20000` | how long to wait for the chat box to exist |
| `STABLE_MS`         | `3000`  | text unchanged this long ⇒ answer finished |
| `SSE_IDLE_MS`       | `1200`  | stream silent + text stable ⇒ finished (fast path) |
| `STALL_MS`          | `25000` | no growth but a Stop button is still there ⇒ return partial answer |
| `NO_OUTPUT_MS`      | `60000` | nothing at all ⇒ `no_output` error |
| `MAX_WAIT_MS`       | `300000`| hard per-request cap |
| `ANSWER_SEND_MARGIN_MS` | `15000` | finish this much *before* the server's deadline, so a throttled background tab still delivers in time |
| `RESET_BEFORE_REQUEST` | `false` | click "New chat" before every request (clean context, slower) |
| `IDLE_STALL_MS`     | `45000` | neither the page nor the site stream changed this long ⇒ `site_idle` instead of hanging |
| `PARTIAL_ON_TIMEOUT`| `true`  | hand over the partial answer when the deadline hits instead of a bare timeout |
| `AUTO_KEEP_WORKING` | `true`  | agent mode: answer the post-answer survey ("Keep working") so the next prompt can be sent |
| `KEEP_WORKING_WAIT_MS` | `4000` | how long to keep looking for that survey once the answer goes quiet |
| `HEARTBEAT_MIN_MS`  | `5000`  | activity-driven keepalive: keeps the socket alive in a throttled background tab |
| `capture.INJECTION` | `manifest` | how the page-world hook is injected (`manifest` / `runtime`) |
| `capture.MAX_FRAMES`| `200`   | ring buffer of stream frames, each parsed once on arrival |
| `SHOW_BADGE`        | `true`  | on-page status badge |

`inject.js` only reads; it never sends anything, never touches `document.cookie`
and never adds credentials to a request. While no bridge request is running it
does not touch the site's traffic at all (the content script marks the document
with `data-aab-capture` for the duration of one request, and the hook forwards
frames only while that flag is up). If the `a0:`/`ag:`/`ad:` prefixes ever
change, the first letter+digit prefix seen during a request is adopted
automatically, and completion detection can always fall back to the DOM (see
[`docs/PROTOCOL.md`](docs/PROTOCOL.md#3-emulated-stream-optional-capture-path)).

Answers are found through three layers, in order: role/class selectors, the
site's own stream text, and - new in 1.4 - a *growth fallback* that reads how
the page's readable text grows and strips our own prompt echo, so a full site
redesign degrades to "slower but still correct" instead of a timeout. Finished
answers that could not be delivered (socket blinked at the wrong moment) are
kept in a small outbox and flushed on reconnect; the server, in turn, keeps an
in-flight request alive for `AAB_RECONNECT_GRACE` seconds and re-sends it to
the tab that reconnects in time.

## API

* `POST /v1/chat/completions` - Chat Completions, `stream: true/false`; extra
  fields `timeout`, `mode`, `no_sanitize`.
* `GET  /v1/models` - `arena-agent`, `arena-agent-direct`.
* `GET  /v1/bridge/status` - browser state, queue depth, latencies, recent errors.
* `GET  /healthz`, `GET /readyz`, `GET /` - health/readiness/dashboard.
* `GET  /admin`, `/ui`, `/panel` - the admin panel (HTML); `GET|POST /admin/api/*`
  - its JSON API: overview, settings, history, rules, sanitize, browser control,
  self-check (see [`docs/WEBUI.md`](docs/WEBUI.md#json-api)).
* `WS   /ws/browser` - the extension.
* OpenAPI docs: <http://127.0.0.1:8000/docs>.

Full wire format, error codes and the extension protocol:
[`docs/PROTOCOL.md`](docs/PROTOCOL.md).

## Troubleshooting

Quick checks:

```bash
curl -s http://127.0.0.1:8000/readyz          # is a browser attached?
curl -s http://127.0.0.1:8000/v1/bridge/status | python -m json.tool
```

* **`browser_offline`** - the extension is not connected: did you load `dist/<browser>`
  (not the sources)? Is the page logged in? (Firefox: grant the host permissions.)
* **`dom_changed`** - the site markup moved. Popup → **Diagnose DOM**, then add a
  selector to `extensions/shared/config.js` and rebuild.
* **`captcha_required`** - solve it by hand in the tab; the bridge will not.
* **Answers truncated / previous turn included** - tune `STABLE_MS`,
  `SSE_IDLE_MS` and the assistant selectors.
* **`site_idle`** - the tab stopped changing while a request was in flight (the
  site froze, the tab was suspended, or the session ended). Nothing is sent back
  until the site moves again; raise `IDLE_STALL_MS` if your prompts legitimately
  keep the page quiet for longer.
* **Nothing works except *Diagnose DOM*** - the automation path found no input
  box or send button. *Diagnose DOM* lists every selector candidate and its
  result; the popup's *last action* row says what the bridge last did.

Everything else (long `no_output`, slow responses, port conflicts, reading logs,
sanitiser false positives, Firefox permission quirks):
[`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) and
[`docs/FIREFOX.md`](docs/FIREFOX.md).

## Security model

* **Loopback only.** Default bind is `127.0.0.1`; CORS allows only extension
  origins, `localhost` *on the server's own port* and the site itself. Do not
  expose it - by default the API accepts any Bearer token, because the security
  boundary is "only this machine can connect".
* **The extension socket is identity-checked.** `/ws/browser` rejects any
  `Origin` that is not the arena.ai tab, loopback or the extension origin
  (close code 4403), so a random web page cannot impersonate the extension,
  read queued prompts or inject forged answers. Non-browser clients (CLI,
  curl) send no Origin and are allowed. Optionally, set `AAB_WS_TOKEN` and the
  same value in the extension (options → *Server websocket token*): the socket
  is then only opened for a matching `?token=…` / hello frame (4401 otherwise).
* **No prompt leakage from public endpoints.** `/v1/bridge/status` shows only a
  length placeholder for queued prompts; the real preview is visible to the
  authenticated admin API (and to callers with the API key when auth is on).
* **The server never echoes its own internals.** Unhandled errors return a
  generic 500 body; the exception detail goes to the server log only.
* **No credentials.** No cookies, tokens or profiles are read, stored or
  forwarded. The extension uses your existing browser session, nothing else. The
  server holds prompts in memory only.
* **Untrusted input.** Web answers may contain destructive commands or prompt
  injections. `AAB_SANITIZE_MODE=redact` (default) replaces obviously destructive
  payloads (`rm -rf /`, `curl … | bash`, reverse shells, SSH/AWS credential reads,
  base64 pipe shells, ...) with `[BLOCKED BY ARENA-AGENT-BRIDGE: <rule>]` and
  reports every finding in `x_bridge.sanitize_findings`. Use `detect` to only
  report, `off` to disable.
* **No captcha bypass, no stealth.** The extension does not spoof fingerprints,
  hide automation flags or solve challenges. If the site asks for a human, the
  request fails with `captcha_required`.
* **Minimal extension permissions.** `storage`, `alarms`, `scripting` and exactly
  three host origins (arena.ai + loopback). No `cookies`, no `webRequest`, no
  `<all_urls>`, no `eval`, no analytics.
* **Optional auth.** `AAB_REQUIRE_API_KEY=1` + `AAB_API_KEY=…` enforces a Bearer
  token (useful on shared machines). Enabling it from the admin panel while the
  key is still the default placeholder generates a real random key and shows it
  to you once (the field is write-only afterwards).

## Limitations

* **One request at a time.** The page serialises everything; extras queue up
  (visible as `queue_depth`).
* **No tool/function calling**, no `temperature`/`top_p`/`max_tokens`/`stop`, no
  real token counts (all accepted and ignored, `usage` is estimated).
* **Streaming is emulated** - the answer is fetched whole, then replayed in
  chunks (`x_bridge.streamed: true`).
* **DOM fragility.** A site redesign breaks selectors until you update
  `extensions/shared/config.js`; the failure is explicit (`dom_changed`).
* **Background tabs** are throttled (both browsers). Keep the agent tab in its own
  window, disable memory saver for the site.
* **Context lives in the page.** Long sessions may degrade or hit the site's own
  limits; `RESET_BEFORE_REQUEST = true` starts fresh per request.
* **Image/audio input is dropped** (`[image omitted by bridge]`).
* **Attachments, files and site tools can't be driven** by the bridge.

## Changelog

**1.4.1** - security + weight:

* `/ws/browser` now checks the `Origin` header (4403 for foreign pages) and
  supports an optional shared secret `AAB_WS_TOKEN` (4401 without it), so a web
  page can no longer impersonate the extension.
* `/v1/bridge/status` no longer leaks queued prompt previews (length-only
  placeholder; authenticated callers get the real text).
* A request whose HTTP client disconnects is cancelled on the bridge
  (`499`), so the browser tab is not burned on a dead conversation.
* Admin panel: enabling API-key auth with the default key generates a real
  random key (shown once); selfcheck flags the predictable default; the queue
  can no longer be shrunk below its current depth; the queue never blocks the
  event loop.
* Sanitiser: `crontab -l`/`-e` are no longer flagged, profile appends (`>>
  ~/.bashrc`) are reported but not rewritten, `chmod`/`chown` 777 detection
  covers `/etc`, `/usr`, `/var`, `/boot`, `/home`, `~`.
* OpenAPI docs are behind `AAB_DOCS=0`; CORS defaults to the server's own port.
* Extension is much lighter: dormant on non-agent arena.ai pages (SPA
  navigation still wakes it), the page-world hook wraps nothing on non-agent
  pages, the capture loop ticks adaptively and re-reads answer text only on
  real changes, page probes (stop/survey/captcha/login) are cached per
  request, state heartbeats and `chrome.storage` writes are deduplicated, and
  the keepalive port is open only while a request runs.
* Outbox TTL now mirrors the server's worker margin (timeout + 20 s).

## Project layout

```
arena-agent-bridge/
├── server/                      # FastAPI bridge (loopback only)
│   ├── main.py                  # endpoints, SSE, dashboard, history wiring
│   ├── admin.py                 # the /admin panel + its JSON API
│   ├── webui.py                 # panel shell (loads assets/panel.{css,js})
│   ├── assets/                  # panel.css + panel.js (the panel's own frontend)
│   ├── history.py               # bounded, in-memory request history
│   ├── auth.py                  # shared Authorization check (/v1 + /admin/api)
│   ├── config.py                # env/.env settings
│   ├── models.py                # OpenAI + browser protocol models
│   ├── prompt_builder.py        # messages[] -> one labelled transcript
│   ├── sanitizer.py             # destructive-command inspection/neutralisation
│   ├── websocket_manager.py     # single browser client, serial queue, stats
│   └── mock_browser.py          # browser-free fake client for tests/demos
├── extensions/                  # one shared codebase, two packages
│   ├── shared/                  # config.js, content.js, background.js, inject.js,
│   │                            # popup.*, options.*, settings.js, i18n.js, icons/
│   ├── chrome/manifest.json     # MV3 service worker, world:MAIN hook
│   └── firefox/manifest.json    # event page, gecko id, opt-in host permissions
├── tests/                       # no browser required
│   ├── test_bridge.py           # server end-to-end with a scripted fake browser
│   ├── test_admin.py            # admin panel: HTML, settings, history, browser API
│   ├── test_build.py            # both extension packages build & validate
│   ├── test_extension_static.py # manifest/config/UI-surface checks
│   ├── test_extension_dom.py    # pytest wrapper for the extension jsdom suite
│   ├── test_webui_dom.py        # pytest wrapper for the panel jsdom suite
│   ├── extension_dom_test.mjs   # content.js automation suite (jsdom)
│   ├── webui_dom_test.mjs       # admin panel suite (jsdom)
│   ├── dev_ws_client.py         # fake browser CLI
│   └── curl_examples.sh
├── scripts/                     # run.sh, demo.sh, build-extensions.py,
│                                # firefox-dev.sh, make_icons.py
├── docs/                        # PROTOCOL, TROUBLESHOOTING, HERMES_OPENCLAW,
│                                # FIREFOX, WEBUI - each with a `.fa.md` Persian copy
├── Makefile                     # make help
├── README.fa.md                 # Persian documentation (same content)
├── pyproject.toml               # pytest + ruff config
├── package.json                 # jsdom (dev only)
└── .github/workflows/ci.yml
```

## Development

```bash
make install          # .venv + server deps + jsdom
make help             # list every task

make run              # start the bridge server
make test             # pytest (165) + jsdom (212 checks), no browser needed
make lint             # ruff + node --check + manifest JSON
make build            # dist/chrome + dist/firefox
make firefox-lint     # Mozilla's validator on dist/firefox
```

Three test layers, none of which needs Chrome, Firefox or the network:

1. **Server and panel end-to-end** (`tests/test_bridge.py` 46 tests,
   `tests/test_admin.py` 45 tests; `tests/test_demo.py` runs `demo.sh`) - real
   HTTP + WebSocket code paths with a scripted fake browser (queueing, prompt
   assembly, SSE streaming, error mapping, sanitiser, timeouts, disconnects) plus
   the whole `/admin` surface: page, settings, history, browser control, self-check.
2. **Extension automation and UI** (`tests/extension_dom_test.mjs`, 152 checks;
   `tests/webui_dom_test.mjs`, 60 checks) - the real `content.js` inside jsdom
   against a simulated chat page (typing, sending, capture, page-world hook,
   runtime injection, Firefox DOM-only fallback, failure paths, cancel, standby,
   the post-answer survey, a frozen page, a re-sent request, the stream-text
   fallback and the activity keepalive), the popup/options pages rendered from the
   shared settings model, and the panel driven against a stubbed API (views, i18n,
   playground, history, actions).
3. **Packaging, docs and static checks** (`tests/test_build.py`, 11 tests;
   `tests/test_extension_static.py`, 22 tests; `tests/test_docs.py`, 38 tests) -
   both manifests validate, the build produces complete loadable packages,
   versions stay in sync, URLs are loopback-only, no `eval`, the UI pages are
   self-contained and every documentation link resolves.

CI (`.github/workflows/ci.yml`) runs all three, Mozilla's `web-ext lint`, and
`./scripts/demo.sh`.

## Legal & safety

* Automating Arena.ai this way **probably violates its Terms of Service**; your
  account may be rate-limited, suspended or banned. That risk is yours.
* The bridge does **not** bypass paywalls, authentication, rate limits or
  captchas. It reuses the browser session you already have, on your machine.
* Personal, experimental use only. Do not resell access, do not run it as a
  service for other people, do not point it at accounts you do not own.
* Respect the site's limits: one tab, one request at a time, sane timeouts. If
  you need volume, use the official API.
* Answers are untrusted web content. Keep the sanitiser on (or stronger) if your
  agent framework can execute shell commands, and never let an agent run code
  from a web page unattended.

MIT licensed - see [LICENSE](LICENSE).
