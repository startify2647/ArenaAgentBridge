# ArenaAgentBridge protocol

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
{"type":"hello","client":"chrome-extension","version":"1.0.0","url":"https://arena.ai/agent"}
{"type":"heartbeat","state":"idle|answering","busy":false,"url":"https://arena.ai/agent"}
{"type":"pong","ts":1712345678.9}
{"type":"response","id":"<uuid>","response":"text or null","error":null,
 "meta":{"duration_ms":8123,"stop_reason":"stable|sse_done|sse_idle|stalled|captcha"}}
```

`error` is one of: `captcha`, `not_logged_in`, `selector_missing`,
`submit_failed`, `no_output`, `response_timeout`, `page_error`, `busy`,
`empty_prompt`, `unknown_error`.

### Server → extension

```jsonc
{"type":"welcome","version":"1.0.0","queue":0,"timeout_default":300}
{"type":"request","id":"<uuid>","prompt":"...","mode":"agent","timeout":300}
{"type":"ping","ts":1712345678.9}
{"type":"cancel","id":"<uuid>","reason":"timeout"}
{"type":"replaced","reason":"another arena.ai tab connected"}
```

### Ordering rules

* The extension sends `hello` immediately after the socket opens, then a
  `heartbeat` at least every 30 s. The server sends `ping` every
  `AAB_HEARTBEAT_INTERVAL` (20 s) and drops clients silent for 3 intervals.
* The server keeps **exactly one** in-flight `request`; a new `request` arrives
  only after the previous `response`. Hold nothing in the extension.
* Background tabs are throttled by Chrome, which is why the extension detects the
  end of an answer from DOM mutations and captured stream frames rather than a
  timer alone.
* If a second arena.ai tab connects and `AAB_SINGLE_CLIENT=1`, the server sends
  `replaced` + close code `4000` to the older one.

---

## 3. Emulated stream (optional capture path)

The extension taps the page's own WebSocket/SSE traffic (`extension/inject.js`)
purely to learn *when* generation starts and ends. Frames look like:

| prefix | meaning            |
| ------ | ------------------ |
| `a0:`  | main answer text   |
| `ag:`  | reasoning/thinking |
| `ad:`  | extra data/meta    |

Those prefixes are configurable in `extension/config.js` (`capture.*`). Only
lengths and timestamps are used for completion detection - the answer itself is
still read from the DOM, so a prefix change degrades speed, never correctness.
