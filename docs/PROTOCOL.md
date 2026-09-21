# ArenaAgentBridge protocol

[فارسی](PROTOCOL.fa.md) · [README فارسی](../README.fa.md)

Two interfaces exist:

1. **HTTP** (localhost:8000) - what Hermes/OpenClaw/curl speak: OpenAI Chat Completions.
2. **WebSocket** (`/ws/browser`) - what the Chrome extension speaks.

---

## 1. HTTP surface (OpenAI compatible)

| Method | Path                  | Notes                                                        |
| ------ | --------------------- | ------------------------------------------------------------ |
| POST   | `/v1/chat/completions` | `stream: true/false`, plus bridge-only fields (below)        |
| GET    | `/v1/models`           | `arena-agent`, `arena-agent-direct`                          |
| GET    | `/v1/bridge/status`    | browser connection, queue depth, latencies, recent errors    |
| GET    | `/healthz`             | liveness (always 200)                                        |
| GET    | `/readyz`              | 200 when a browser is attached, 503 otherwise                |
| GET    | `/`                    | one-page HTML status dashboard                               |
| WS     | `/ws/browser`          | the extension connects here                                  |

Aliases without the `/v1` prefix exist for sloppy clients (`/chat/completions`,
`/models`, `/bridge/status`).

### Request

Everything OpenAI clients send is accepted; unknown fields are ignored.

```jsonc
{
  "model": "arena-agent",          // "arena-agent-direct" => no agent preamble
  "messages": [                     // system/user/assistant/tool, string or parts
    {"role": "system", "content": "be terse"},
    {"role": "user", "content": "hello"}
  ],
  "stream": false,

  // --- bridge extensions -------------------------------------------------
  "timeout": 300,        // seconds to wait for the page (clamped by AAB_* limits)
  "mode": "agent",       // "agent" | "direct", overrides model-based default
  "no_sanitize": false   // skip the destructive-command sanitiser for this call
}
```

`temperature`, `top_p`, `max_tokens`, `stop`, `tools`, `response_format`, ... are
accepted and **ignored** - the web UI has no way to receive them. `n > 1` returns
a single choice with a warning in the log.

### Response

```jsonc
{
  "id": "chatcmpl-6a1f...",
  "object": "chat.completion",
  "created": 1712345678,
  "model": "arena-agent",
  "choices": [{"index": 0, "message": {"role": "assistant", "content": "..."},
               "finish_reason": "stop"}],
  "usage": {"prompt_tokens": 42, "completion_tokens": 17, "total_tokens": 59},
  "x_bridge": {
    "request_id": "chatcmpl-6a1f...",
    "mode": "agent",
    "browser_duration_ms": 8123,  // time inside the page
    "total_duration_ms": 8210,    // HTTP -> HTTP
    "queue_wait_ms": 0,
    "sanitized": true,
    "sanitize_mode": "redact",
    "sanitize_findings": [{"pattern": "rm_rf_root", "kind": "destructive-fs",
                           "severity": "block", "match": "rm -rf /", "line": 3}],
    "browser_meta": {"stop_reason": "stable", "stream": {"mainChars": 812, "frames": 96}},
    "streamed": false
  }
}
```

`usage` is estimated (≈4 characters per token): the web UI does not expose real
token counts.

### Streaming

SSE with OpenAI chunk semantics:

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello "}}]}
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"x_bridge":{...,"streamed":true}}
data: [DONE]
```

The page exposes no incremental stream we can trust, so the answer is fetched
whole and replayed in chunks (`AAB_STREAM_CHUNK_CHARS` /
`AAB_STREAM_CHUNK_DELAY_MS`). Clients get a normal stream; `x_bridge.streamed`
marks it as emulated. **Errors mid-stream** are sent as a final `data:` frame
containing an `error` object, followed by `[DONE]`.

### Errors

HTTP status + OpenAI error body:

```json
{"error": {"message": "...", "type": "bridge_error", "code": "captcha_required"}}
```

| code                 | HTTP | meaning                                                |
| -------------------- | ---- | ------------------------------------------------------ |
| `invalid_messages`   | 400  | empty conversation / prompt above the size limit       |
| `authentication_error` | 401 | `AAB_REQUIRE_API_KEY=1` and a wrong/missing key        |
| `captcha_required`   | 409  | a captcha is on screen; solve it manually              |
| `browser_busy`       | 409  | the tab refused a second concurrent request            |
| `queue_full`         | 429  | too many queued requests (`AAB_QUEUE_MAX_SIZE`)        |
| `login_required`     | 502  | the tab is logged out                                  |
| `dom_changed`        | 502  | selectors no longer match (update `config.js`)         |
| `browser_disconnected` | 502 | the extension/tab vanished mid-request               |
| `browser_offline`    | 503  | no extension connected at all                          |
| `browser_tab_missing`| 503  | extension connected, but no arena.ai/agent tab open    |
| `page_timeout`       | 504  | no stable answer within the timeout                    |
| `server_error`       | 500  | unexpected bridge failure (see the log)                |

---

## 2. WebSocket protocol (`/ws/browser`)

JSON text frames, one message per frame.

### Extension → server

```jsonc
{"type":"hello","client":"chrome-extension","version":"1.3.0","url":"https://arena.ai/agent"}
{"type":"heartbeat","state":"idle|answering","busy":false,"url":"https://arena.ai/agent"}
{"type":"pong","ts":1712345678.9}
{"type":"response","id":"<uuid>","response":"text or null","error":null,
 "meta":{"duration_ms":8123,"stop_reason":"see below","from_stream":false,
         "kept_working":{"found":true,"clicked":true,"cleared":true,"input":true,"label":"Keep working"},
         "stream":{"frames":96,"mainChars":812,"reasoningChars":0,"sawDone":true}}}
{"type":"heartbeat","state":"busy","busy":true,"url":"https://arena.ai/agent"}
{"type":"diag","id":"<uuid>","state":"idle|answering","busy":false,
 "url":"https://arena.ai/agent",
 "diag":{"selectorCounts":{"input":1,"sendButton":1},"captcha":false,"loggedIn":true},
 "config":{"serverUrl":"ws://127.0.0.1:8000/ws/browser","stableMs":3000,"capture":true}}
```

`diag` answers a `diagnose` frame (1.2.0+); the admin panel's *Diagnose DOM*
button and the `/admin/api/browser/diagnose` endpoint use it to show the live
page state without touching the queue. Extensions older than 1.2.0 ignore the
request and the server reports `diagnostics_timeout`. `selectorCounts` covers
every selector list in `config.js` (including `keepWorking` and `survey`) and
`checks` adds `surveyVisible` / `keepWorkingVisible`, which is what you look at
when only the read-only path works.

### How a turn ends

The extension finishes a turn as soon as **one** of these is true, whichever
comes first:

| `stop_reason`    | what happened |
| ---------------- | ------------- |
| `stable`         | the answer text stopped changing for `STABLE_MS` |
| `sse_done`       | the site's own stream said it was done |
| `sse_idle`       | the captured stream went quiet while the text was stable |
| `stream_text`    | the DOM exposed no answer element, so the text was rebuilt from the captured `a0:` frames |
| `survey`         | the post-answer poll appeared in the composer (agent mode) |
| `stalled`        | no growth for `STALL_MS` while a Stop button was still there - partial answer |
| `site_idle`      | neither the page nor the site stream changed for `IDLE_STALL_MS` - an *error* when there was no text yet, a partial answer otherwise |
| `timeout_partial`| the request deadline arrived with text in hand (`PARTIAL_ON_TIMEOUT=true`) |

The last two exist so a frozen or backgrounded tab can never hang a request
until the server's own timeout: the extension reports the stoppage itself, and
the server maps `site_idle` to `504 page_timeout` with the partial answer
attached when there is one.

Two more rules matter to a caller:

* **Agent mode only** - after an answer the site shows a three-option poll in
  the composer; the extension clicks *Keep working* (`AUTO_KEEP_WORKING`), waits
  for the composer to come back and reports `meta.kept_working`. Direct mode has
  no survey, so nothing is clicked there.
* **Keepalive** - a background tab throttles `setInterval`, so every DOM
  mutation or captured frame also nudges the heartbeat (`HEARTBEAT_MIN_MS`).
  Without it the server would drop a client that is busy answering.
* A re-sent `request` with the same `id` (server-side reconnect) is ignored while
  that turn is still running instead of being answered with `busy`.

`error` is one of: `captcha`, `not_logged_in`, `selector_missing`,
`submit_failed`, `no_output`, `response_timeout`, `page_error`, `busy`,
`empty_prompt`, `unknown_error`.

### Server → extension

```jsonc
{"type":"welcome","version":"1.0.0","queue":0,"timeout_default":300}
{"type":"request","id":"<uuid>","prompt":"...","mode":"agent","timeout":300}
{"type":"ping","ts":1712345678.9}
{"type":"cancel","id":"<uuid>","reason":"timeout|operator"}
{"type":"replaced","reason":"another arena.ai tab connected"}
{"type":"diagnose","id":"<uuid>"}
{"type":"shutdown","reason":"operator disconnected the tab"}   → close code 4004
```

`cancel` also arrives when someone presses *Cancel* in the admin panel (the HTTP
client gets `499 cancelled`), and `shutdown` is sent before the server closes the
socket on *Disconnect* - the extension treats it as "come back later" and
reconnects with a 10 s backoff.

### Ordering rules

* The extension sends `hello` immediately after the socket opens, then a
  `heartbeat` at least every 30 s. The server sends `ping` every
  `AAB_HEARTBEAT_INTERVAL` (20 s) and drops clients silent for 3 intervals.
* The server keeps **exactly one** in-flight `request`; a new `request` arrives
  only after the previous `response`. Hold nothing in the extension.
* Background tabs are throttled by Chrome, which is why the extension detects the
  end of an answer from DOM mutations and captured stream frames rather than a
  timer alone - and why it finishes `ANSWER_SEND_MARGIN_MS` (15 s) *before* the
  server's deadline, so a tab that only wakes once a minute still delivers.
* A `response` that cannot be sent (socket down at that moment) is kept in a
  small outbox in the extension and flushed when the socket is back.
* If the extension socket drops mid-request, the server keeps the in-flight
  request alive for `AAB_RECONNECT_GRACE` (8 s): a client that reconnects in
  time gets the same `request` (same id) re-sent - an extension that is still
  answering it ignores the duplicate, a fresh tab simply answers it. Only a tab
  that stays gone surfaces as `browser_disconnected`.
* If a second arena.ai tab connects and `AAB_SINGLE_CLIENT=1`, the server sends
  `replaced` + close code `4000` to the older one; its in-flight request is
  re-sent to the new tab the same way.

---

## 3. Emulated stream (optional capture path)

The extension taps the page's own WebSocket/SSE traffic (`extensions/shared/inject.js`)
purely to learn *when* generation starts and ends. Frames look like:

| prefix | meaning            |
| ------ | ------------------ |
| `a0:`  | main answer text   |
| `ag:`  | reasoning/thinking |
| `ad:`  | extra data/meta    |

Those prefixes are configurable in `extensions/shared/config.js` (`capture.*`).
Timestamps and frame counts drive completion detection, and the `a0:` frames are
also decoded (plain text or JSON) so the answer can be rebuilt when the DOM
exposes no message element - `stop_reason: "stream_text"` and
`meta.from_stream: true` tell a caller that this fallback was used. A prefix
change therefore degrades speed, and the text fallback with it, but never turns a
finished answer into a timeout.

Capture cost model (1.4): the hook forwards traffic **only while a bridge request
is running** - the content script marks `<html data-aab-capture>` for the
duration of one turn, and `inject.js` checks that attribute before touching
anything (a fetch that starts outside a turn is never tee'd). Each frame is
parsed exactly once, on arrival, into a per-request aggregate; a capture tick
reads a snapshot instead of re-parsing the buffer. If the site rotates its
prefixes (`a0:` -> `b0:`/…), the first letter+digit prefix seen during the
request is adopted automatically. When even the stream matches nothing, the
content script falls back to *page-text growth*: it records the readable text of
the chat region before typing and returns whatever appeared after our own prompt
echo once it stops changing - slower, but redesign-proof.
