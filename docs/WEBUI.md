# Web UI and admin panel

[فارسی](WEBUI.fa.md) · [README](../README.md) · [Protocol](PROTOCOL.md)

ArenaAgentBridge has two interfaces:

| | what | where | who it is for |
| --- | --- | --- | --- |
| **Admin panel** | a full dashboard served by the bridge itself | <http://127.0.0.1:8000/admin> (also `/`, `/ui`, `/panel`) | you, watching the bridge, testing prompts, editing settings, keeping an eye on the last requests |
| **Extension UI** | toolbar popup + options page inside the browser | click the extension icon / *Extension options* | you, checking the tab that actually talks to arena.ai |

Both are local-only, need no build step and no external asset: the panel is one
HTML document with a bundled CSS/JS pair, and the popup/options page reuse the
same `config.js` + `settings.js` + `i18n.js` as the content script.

---

## 1. Admin panel

### Opening it

Start the server (`./scripts/run.sh` or `make run`) and open
<http://127.0.0.1:8000/admin>. The panel is *the same process* as the API - no
extra port, no separate tool, and it stops when the server stops.

Disable it with `AAB_PANEL_ENABLED=0` if you want a headless bridge; `GET /` then
falls back to the small built-in status page.

### Dashboard

Live numbers, refreshed every `AAB_PANEL_REFRESH_MS` (default 2 s):

* **server / browser / queue / latency / requests** cards: is an extension
  attached, which tab, which extension version, queue depth, p50/p95 latency,
  totals (requests, errors, timeouts, neutralised answers);
* **in-flight request**: the prompt currently being typed into the page, how long
  it has been running, and a **Cancel** button;
* **recent errors** with their codes (`browser_offline`, `page_timeout`,
  `captcha_required`, …) and a one-line explanation;
* **models** and **sanitiser** summary, plus the **self-check** list (see below).

### Playground

The fastest way to test the whole chain without an agent framework: type a
prompt, pick a model (`arena-agent` = agent wrapper, `arena-agent-direct` = raw),
choose agent/direct mode, set the browser timeout, toggle streaming and
`no_sanitize`, press **Send**. The answer streams into the output box exactly the
way an API client would see it, together with the per-request metadata: time to
first token, total duration, queue wait, token estimate, request id, the
sanitiser findings and the raw `x_bridge` payload.

Playground requests are recorded in the history with `source: panel`, so they
never get mixed up with your real traffic.

### Requests (history)

A bounded, in-memory log of the last `AAB_HISTORY_SIZE` requests (default 200;
`0` disables recording):

* filter by free text (prompt, answer, error, client, model, request id), by
  status (`ok`, `error`, `aborted`, `rejected`) and by source (`api`, `panel`);
* every row opens a detail dialog with the prompt/answer previews, the exact
  timings, the sanitiser findings and the error code;
* **Export** downloads the current view as JSON, **Clear** empties the ring;
* the *client* column is derived from the `User-Agent` (hermes, openclaw, litellm,
  open-webui, curl, httpx, …) so you can tell which framework sent what.

Nothing is written to disk: the history lives in the server process and is gone
when it restarts. Previews are truncated (700 / 1500 characters), and the full
prompt length is reported separately.

### Browser

Everything about the extension connection in one place:

* connected clients: tab url, extension version, state, busy flag, heartbeats,
  answered count, how long the tab has been attached;
* **Ping** - ask the tab to answer `pong` (checks the socket, not the page);
* **Diagnose DOM** - ask the extension for a live snapshot of the page: selector
  hits, whether the input/send button exist, captcha state, the effective
  thresholds and the server url it is using. This is the same data the popup's
  *Diagnose* tab shows, but visible from the server side - the fastest way to see
  why a request would fail;
* **Cancel** - abort the in-flight request (the API client gets
  `499 cancelled`, the page is told to stop);
* **Disconnect** - drop the WebSocket so you can re-attach from another tab
  (the extension reconnects on its own).

Older extensions ignore the `diagnose` frame; the panel then reports
`diagnostics_timeout` instead of hanging, which is the hint to rebuild and reload
the extension.

### Sanitizer

The dry-run inspector: paste any text (an answer, a command, a file) and see
exactly what the configured mode (`off` / `detect` / `redact`) would do with it -
matches, severity, replacement text - before it ever reaches a client. The rule
list (name, kind, severity, pattern) is listed below the tester.

### Settings

A form for the knobs that are safe to change at runtime - timeout, queue size,
prompt/response limits, sanitiser mode, streaming chunk size/delay, model ids,
default mode, history size, log level, `require_api_key` + `api_key`:

* **Apply** patches the live server (no restart), validates every value and shows
  which fields were rejected and why;
* the derived side effects are applied too: the queue is resized, the model list
  is rebuilt, the history ring is resized;
* **Copy .env / Download .env** produce the `AAB_*` block for a permanent change;
* values that cannot be changed from a running process (`AAB_HOST`, `AAB_PORT`,
  CORS, mock browser, …) are shown read-only.

### Connect

Ready-to-paste snippets for `curl`, Python (`openai`), the `AAB_API_KEY` header,
the model list, the status endpoint and the Hermes/OpenClaw configuration - the
whole "point your framework at this bridge" step in one place.

### Self-check

`GET /admin/api/selfcheck` powers the small check list in the dashboard and the
browser view. Each row reports `ok`, a level (`ok` / `warn` / `error`), a
one-line explanation and a hint:

| id | checks |
| --- | --- |
| `browser` | an extension is attached and answers ping |
| `extension-version` | the extension's major.minor matches the server's version |
| `queue` | queue depth vs. `AAB_QUEUE_MAX_SIZE` |
| `sanitizer` | rules loaded, mode valid |
| `history` | history enabled and not full-of-errors |
| `auth` | `require_api_key` state and whether a key is set |

### Language, theme, refresh

The panel is bilingual (**English / فارسی**) and follows the browser language on
first visit; the toggle is in the header. Persian switches the whole layout to
RTL. Theme (dark/light) and pause/resume of the auto-refresh are next to it; both
choices are remembered in `localStorage`.

### Authentication

The panel respects `AAB_REQUIRE_API_KEY`: when the bridge requires a key, the
`/admin/api/*` endpoints require the same `Authorization: Bearer …` header. The
panel asks for the token once and keeps it in `localStorage` (never in a cookie,
never sent anywhere but your own loopback server). `/admin` itself is a static
shell and stays readable - it contains no secret.

### JSON API

Everything the panel does is a plain HTTP call you can script:

| method | path | purpose |
| --- | --- | --- |
| `GET` | `/admin/api/overview` | dashboard payload (server, browser, totals, latency, models, sanitiser, history, settings) |
| `GET` | `/admin/api/settings` | editable fields + current values + the `.env` block |
| `POST` | `/admin/api/settings` | `{"patch": {...}}` → applied/rejected per field |
| `POST` | `/admin/api/settings/reset` | back to the values from `.env` |
| `GET` | `/admin/api/settings/env` | the `.env` block as a download |
| `GET` | `/admin/api/history` | `limit`, `offset`, `q`, `status`, `source` |
| `GET` | `/admin/api/history/export` | JSON export of the current view |
| `POST` | `/admin/api/history/clear` | empty the ring |
| `GET` | `/admin/api/history/{id}` | one request in detail |
| `GET` | `/admin/api/rules` | sanitiser rules |
| `POST` | `/admin/api/sanitize` | dry-run `{"text": ..., "mode": ...}` |
| `POST` | `/admin/api/browser/ping\|cancel\|disconnect\|diagnose` | browser control |
| `GET` | `/admin/api/selfcheck` | the check list |

---

## 2. Extension UI

### Toolbar popup

Click the extension icon:

* **Status** - bridge connection (server url, extension version, state), the
  attached arena.ai tab, the page hook (manifest/runtime/script-tag), how many
  answers this tab produced, the last error, and the permission card on Firefox;
* **Quick test** - send a one-line prompt through the bridge from inside the
  browser and see the answer with its timings; useful to prove that the whole
  chain works without starting an agent framework;
* **Diagnose** - the live page snapshot (selectors, captcha, thresholds) with a
  copy button;
* **Settings** - server url, the most important thresholds, and a link to the
  full options page;
* buttons for *Open arena.ai*, *Open admin panel*, *Reconnect* and *Cancel now*.

### Options page

*Extension details → Extension options*, or the **Advanced settings** button in
the popup. It edits the same overrides as the popup settings tab, in a wider
layout:

* **Connection** - `SERVER_WS_URL`, `SERVER_HTTP_URL`, transport mode, the API
  key used by the *Quick test* and the admin-panel links, a **Test connection**
  button (calls `/healthz` + `/v1/bridge/status`) and the panel link;
* **Automation & capture** - every safe `config.js` knob: input wait, stability
  windows, stall/no-output caps, max wait, reset-before-request, badge, capture
  and injection mode, debug logging;
* **Import / export / reset** - the overrides as JSON (same format as
  `exportJson()`, usable from the page console too);
* **Permissions** (Firefox) - grant/revoke host access per host.

Overrides are stored in `chrome.storage.local` under `aabOverrides` (the legacy
`serverUrl` key is kept in sync), are validated before they are saved (loopback
urls only, sane ranges) and are applied by the content script on load *and*
immediately when you hit save - no page reload needed.

---

## 3. Troubleshooting the UI

| symptom | cause / fix |
| --- | --- |
| `/admin` returns the small fallback page | `AAB_PANEL_ENABLED=0` - set it to `1` and restart |
| panel asks for a token | `AAB_REQUIRE_API_KEY=1`; paste the `AAB_API_KEY` value |
| *Diagnose DOM* fails with `diagnostics_timeout` | extension older than 1.2.0 (rebuild + reload) or the tab is on a non-arena.ai page |
| `browser_offline` in the panel | no extension connected - open <https://arena.ai/agent> and log in |
| history is always empty | `AAB_HISTORY_SIZE=0`, or the server was restarted (it is RAM-only) |
| playground answer is slower than the API | streaming in the panel is the SSE replay; check *browser ms* vs *total ms` in the metadata |

More: [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).

## 4. Where the code lives

| path | role |
| --- | --- |
| `server/admin.py` | the `/admin/api/*` router, the panel's HTML shell and its self-check |
| `server/assets/panel.css` | panel styles (both themes, RTL) |
| `server/assets/panel.js` | panel logic: views, i18n, polling, playground, history |
| `server/webui.py` | loads the assets and renders the page |
| `server/history.py` | the bounded in-memory request history |
| `server/auth.py` | the shared `Authorization` check for `/v1/*` and `/admin/api/*` |
| `extensions/shared/popup.html/js` | toolbar popup |
| `extensions/shared/options.html/js` | options page |
| `extensions/shared/settings.js` | the settings/override model shared by popup, options and content script |
| `extensions/shared/i18n.js` | English/Persian dictionary + `data-i18n` applier |
| `tests/test_admin.py` | panel API + HTML tests (no browser needed) |
| `tests/webui_dom_test.mjs` | the panel's own jsdom suite (60 checks: views, i18n, streaming, actions) |
