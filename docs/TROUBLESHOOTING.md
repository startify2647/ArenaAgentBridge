# Troubleshooting

[فارسی](TROUBLESHOOTING.fa.md) · [README فارسی](../README.fa.md)

Start with the built-in diagnostics - they answer most questions in one shot:

```bash
curl -s http://127.0.0.1:8000/v1/bridge/status | python -m json.tool
```

* `browser.connected: false` → the extension is not connected (next section).
* `server.queue_depth > 0` → requests are piling up; the page is slow or stuck.

Click the extension icon and press **Diagnose DOM**: it reports which selectors
matched (0 hits = fix `extensions/shared/config.js`), whether a captcha or a login
wall is present, how many messages were found and whether the optional page-world
stream hook is active. You can also see the state on the page itself - there
is a small badge in the bottom-right corner.

---

## Firefox: nothing connects at all

Firefox MV3 makes host permissions **opt-in**, so after installing the extension
it may not be allowed to reach `127.0.0.1:8000` yet:

1. Click the extension icon: a yellow **permissions** card appears → press
   **Grant permissions** and accept the prompt.
2. Alternatively: `about:addons` → ArenaAgentBridge → **Permissions** tab → grant
   the two origins.
3. Reload the arena.ai tab afterwards (the popup's *Reconnect* button also works).

Other Firefox notes: the background is an event page (not a service worker), so
`chrome://extensions`-style service-worker consoles do not exist - use
`about:debugging#/runtime/this-firefox` → **Inspect** next to the extension to see
the background log, and the tab's own console for the content-script log.

## "browser_offline" / the badge says `disconnected`

1. Is the server running? `curl http://127.0.0.1:8000/healthz`.
   (Firefox users: check the permissions card first, see below.)
2. Is `https://arena.ai/agent` open in Chrome? (Any `arena.ai` page works, but
   the capture logic expects the agent UI.)
3. Was the page opened **before** the extension was installed/loaded? Then the
   content script is missing - reload the tab (or press *Reconnect* in the popup;
   the background worker re-injects `config.js` + `content.js`).
4. Check the popup: `standby` means another arena.ai tab owns the single bridge
   connection. Close the extra tabs or make the intended one active.
5. `chrome://extensions` → *Service worker* → *Errors* for background logs; the
   content-script log is in the page console with the `[ArenaAgentBridge]` prefix.
6. Chrome's *Extensions* page must not show a permission warning for
   `http://127.0.0.1:8000/*`; if it does, re-load the unpacked extension.

## "dom_changed" / "selector_missing"

The site markup changed. Open the popup → **Diagnose DOM** and look at
`selectorCounts`; anything at `0` needs a new selector.

1. In the page: right-click the chat box → *Inspect* → copy a stable class or
   test id (prefer `data-*`/`aria-*` over hashed CSS-module classes).
2. Add it to the **front** of the relevant list in `extensions/shared/config.js`
   (`selectors.input`, `selectors.sendButton`, `selectors.stopButton`,
   `selectors.assistantMessage`).
3. Reload the extension (`chrome://extensions` → ↻) and reload the tab.
4. Test without Hermes: `python tests/dev_ws_client.py --manual`, then
   `curl` one request. Fix repeatable failures before wiring up the agent.

Live experimentation without editing files: in the page console,

```js
__AAB_CONFIG__.selectors.input.unshift('textarea.my-new-class');
__AAB__.driver.diagnose();      // Dump current state
__AAB__.pipeline;               // The object that types/clicks/captures
```

## "captcha_required"

A bot check is on screen. Solve it **manually** in the tab, then retry. The
bridge never tries to bypass a captcha; repeated failures mean the site decided
your automation looks like automation - slow down, enable
`behavior.RESET_BEFORE_REQUEST`, or stop.

## "login_required"

The tab is logged out (or the login wall changed). Log in manually in that tab.
The bridge never stores cookies or tokens: the session lives in Chrome, exactly
as if you were using the site by hand.

## Answers come back truncated or with the previous turn attached

Tuning knobs in `extensions/shared/config.js` → `behavior`:

| symptom                                    | knob                                              |
| ------------------------------------------ | ------------------------------------------------- |
| cut off mid-sentence                       | raise `STABLE_MS` (e.g. 4000), `SSE_IDLE_MS`      |
| waits too long after the answer is done    | lower `STABLE_MS`, raise confidence in capture    |
| previous answer included in the new one    | `selectors.assistantMessage` matches the wrong node; check with *Diagnose DOM* |
| prompt echoed back as the answer           | the role detection failed - add a `data-*` selector for assistant messages |
| nothing arrives, `no_output`               | the model is queued or the tab was throttled; raise `NO_OUTPUT_MS`, keep the tab in its own window, disable "Memory Saver" for arena.ai |
| the answer is visible on the page but never comes back | the DOM no longer exposes the message element; the extension falls back to the captured `a0:` stream text (`stop_reason: stream_text`). If that fails too, *Diagnose DOM* shows `selectorCounts.assistantMessage = 0` - add a selector |
| `site_idle` on a long prompt               | the page was genuinely quiet for `IDLE_STALL_MS` (45 s): raise it, or keep the tab visible so the site keeps updating |
| the next prompt fails with `busy` / an empty composer | the post-answer survey was never answered. Agent mode needs `AUTO_KEEP_WORKING=true`; check the popup's *last action* row for `kept_working` |

## Only *Diagnose DOM* works

That button is the read-only path: it only counts nodes. If typing, sending and
capturing all do nothing, the automation selectors stopped matching the page.
Order of checks:

1. Popup → *last action*: it says what the bridge last did (`answering: …`,
   `answer sent in 4.2s (survey)`, `failed: selector_missing`, …).
2. *Diagnose DOM* → `selectorCounts` (input / sendButton / assistantMessage) and
   `checks` (`input`, `sendButton`, `surveyVisible`). A zero count is the answer:
   add a selector to `extensions/shared/config.js`, rebuild, reload.
3. `pageHook.ready = false` means `inject.js` did not run in the page world - the
   automation still works through the DOM, only completion detection is slower.
   Firefox: check the host permission; Chrome: *Reload* the extension.

## Timeouts

* `page_timeout` (504) - the page did not stabilise in `timeout` seconds. Raise
  the per-request `timeout` field, or `.env` `AAB_REQUEST_TIMEOUT`.
* Very long tasks (deep agent loops, big code generation) are fine with
  `AAB_REQUEST_TIMEOUT=900`, but Chrome must be allowed to run in the background.
* `504 page_timeout` with a partial answer in the payload - the deadline was hit
  while text was already on screen (`PARTIAL_ON_TIMEOUT=true`). Raise the
  per-request `timeout` for a complete answer.
* The bridge does not wait for the server timeout when the *site* is the problem:
  a page (and stream) that stops changing for `IDLE_STALL_MS` produces
  `site_idle` straight away, and a stream that goes silent with a Stop button
  still showing produces a partial answer after `STALL_MS`.
* **The model answered but you still got a timeout** - three layers protect this
  now, in this order: (1) the extension finishes `ANSWER_SEND_MARGIN_MS` (15 s)
  before the server's deadline so a throttled background tab still delivers;
  (2) an answer that cannot be delivered immediately waits in the extension's
  outbox and is flushed on reconnect; (3) the server keeps an in-flight request
  alive for `AAB_RECONNECT_GRACE` (8 s) and re-sends it to the tab that
  reconnects in time. If you still see it, run *Diagnose DOM* - the page may
  have stopped matching every selector and stream prefix; 1.4 also has a
  page-text growth fallback for exactly that case, so a `page_timeout` with an
  answer visible on screen is worth a bug report.

## Streaming looks like one big chunk

Expected: the page has no usable incremental stream, so the answer is fetched
whole and replayed. Lower `AAB_STREAM_CHUNK_CHARS` / raise
`AAB_STREAM_CHUNK_DELAY_MS` if you want a slower, more "human" pace.

## "queue_full" (429)

More concurrent requests than `AAB_QUEUE_MAX_SIZE`. Either raise it (they will be
answered strictly one after another) or make your client send fewer parallel
requests - the page is the bottleneck, not the server.

## Sanitiser replaced something I actually needed

Set `AAB_SANITIZE_MODE=detect` (report only) or add `"no_sanitize": true` to a
single request. For finer control, write your own rules and point
`AAB_PATTERNS_FILE` at them (see `.env.example` and `server/sanitizer.py`).

## Port already in use

`AAB_PORT=8100 ./scripts/run.sh`, and change `SERVER_WS_URL` in
`extensions/shared/config.js` (or just save the new URL in the popup on the current tab).

## Reading the logs

* Server: structured lines, e.g. `request 6a1f8c2e sent to browser (mode=agent, 300s)`.
* `AAB_LOG_JSON=1` for JSON logs (nice with `jq`).
* Extension: page console (`[ArenaAgentBridge]`) with `debug.VERBOSE = true`;
  the background worker's console is under `chrome://extensions` → *Service worker*.
* `debug.LOG_LENGTHS = false` silences the per-tick "waiting: dom=… stream=…"
  lines if they are too chatty.

## Everything is slow

* The bridge is **single-flight**: latency is the page's latency, plus queue wait.
* 1.4 removed the classic extension hot spots: while no request runs the page
  hook does not touch the site's traffic at all, stream frames are parsed once
  (not re-parsed on every poll), and button matching no longer forces layout.
  If the browser still feels heavy with the extension installed, check that the
  loaded build is actually 1.4+ (`chrome://extensions` → details).
* `behavior.SHOW_BADGE = false` and `debug.VERBOSE = false` shave off a little
  overhead.
* Prefer `mode: "direct"` (or the `arena-agent-direct` model) for short prompts -
  the agent preamble costs a few hundred tokens per request.
* Setting `behavior.RESET_BEFORE_REQUEST = true` starts a fresh chat per request:
  slower, but immune to context-limit degradation in long sessions.

## The admin panel / extension UI

| symptom | cause / fix |
| --- | --- |
| `/admin` shows the small fallback page | `AAB_PANEL_ENABLED=0` - set it to `1` and restart the server |
| the panel asks for a token | `AAB_REQUIRE_API_KEY=1`; paste the `AAB_API_KEY` value (it is kept in `localStorage`, never sent anywhere but loopback) |
| *Diagnose DOM* → `diagnostics_timeout` | the loaded extension is older than 1.2.0 (rebuild + reload) or the tab is not on arena.ai |
| the panel is empty / all counters zero | no extension attached - open <https://arena.ai/agent> and log in; check *Browser* |
| history stays empty | `AAB_HISTORY_SIZE=0`, or the server restarted (the history is RAM-only by design) |
| the panel does not refresh | the refresh is paused (header button) or the tab is in the background - Chrome throttles timers, the panel skips ticks while hidden |
| settings were rejected | the form shows the reason per field; read-only values (`AAB_HOST`, `AAB_PORT`, CORS, mock) must be changed in `.env` and need a restart |
| the popup's *Quick test* fails in Firefox | host permissions were not granted yet - use the permission card in the popup |

Full reference: [`WEBUI.md`](WEBUI.md).
