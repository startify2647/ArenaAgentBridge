# Connecting an agent framework

[فارسی](HERMES_OPENCLAW.fa.md) · [README فارسی](../README.fa.md)

The bridge is deliberately boring: it speaks `POST /v1/chat/completions` with a
Bearer token and returns ordinary Chat-Completions JSON. Anything that can talk
to OpenAI (or a LiteLLM/OpenRouter style gateway) can talk to it.

| setting             | value                                       |
| ------------------- | ------------------------------------------- |
| Base URL / Endpoint | `http://127.0.0.1:8000/v1`                  |
| API compatibility   | **Chat Completions** (not Responses API)    |
| API key             | anything, e.g. `sk-arena` (local only)      |
| Model ID            | `arena-agent` (or `arena-agent-direct`)     |
| Streaming           | supported (`stream: true`, SSE)             |

> `arena-agent-direct` skips the bridge preamble and pastes the transcript as-is.
> Handy for manual experiments and for very short prompts.

---

## Hermes

Hermes (and most local agent frontends) expose a "Custom OpenAI-compatible
provider" section:

```
Provider name : arena-bridge
Base URL      : http://127.0.0.1:8000/v1
API key       : sk-arena
Model         : arena-agent
Mode          : Chat Completions
Streaming     : on
```

Then add a system prompt that tells the agent it is talking through a bridge:

```
You are an autonomous coding agent. Your model endpoint is a bridge to a web UI,
so tools/function-calling are NOT available: never emit tool_calls, ask for the
result in plain text instead.
```

Notes

* Function/tool calling is not supported. If your runner insists on it, disable
  tools for this provider, or use the bridge as a plain text model.
* Keep the concurrency at 1 request at a time. The server queues extras, but your
  agent will just wait - a page takes as long as it takes.
* `usage` is estimated, so token-budget accounting is approximate.

## OpenClaw

Same shape - *Settings → Models → Add custom provider*:

```
Type     : openai-compatible
Base URL : http://127.0.0.1:8000/v1
API Key  : sk-arena
Model    : arena-agent
Timeout  : 600   # if the UI has one; otherwise set AAB_REQUEST_TIMEOUT=600
```

If OpenClaw probes `/v1/models` on startup, it will find `arena-agent` and
`arena-agent-direct` and list them normally.

## Open WebUI / LibreChat / Anything-LLM

Add an "OpenAI" connection with base URL `http://127.0.0.1:8000/v1` and any key.
Because the bridge ignores unknown fields, multimodal/attachment features can
stay enabled - images are replaced with `[image omitted by bridge]` instead of
breaking the request.

## Generic Python client

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8000/v1", api_key="sk-arena")

answer = client.chat.completions.create(
    model="arena-agent",
    messages=[
        {"role": "system", "content": "You are terse."},
        {"role": "user", "content": "Explain what a race condition is in 2 lines."},
    ],
    timeout=600,
)
print(answer.choices[0].message.content)
print(answer.model_extra["x_bridge"]["browser_duration_ms"], "ms inside the page")
```

## LiteLLM proxy in front of it

```yaml
model_list:
  - model_name: arena
    litellm_params:
      model: openai/arena-agent
      api_base: http://127.0.0.1:8000/v1
      api_key: sk-arena
      timeout: 600
```

## Reliability tips for agents

1. Let the bridge own the conversation: send the full history every time. The
   page keeps its own context too; if you want a clean slate per request set
   `behavior.RESET_BEFORE_REQUEST = true` in the extension config.
2. Keep one waiter. Parallel sub-agents should share the bridge, not open
   several browser tabs - `AAB_SINGLE_CLIENT=1` keeps one tab authoritative.
3. Treat answers as untrusted: they come from a web page, so the server's
   sanitiser neutralises destructive shell commands by default. If your agent can
   run commands, keep `AAB_SANITIZE_MODE=redact` and read
   `x_bridge.sanitize_findings`.
4. Have your runner retry on 502/503/504 (`browser_offline`, `dom_changed`,
   `page_timeout`) with backoff, but never retry on `captcha_required` - that
   needs a human.
