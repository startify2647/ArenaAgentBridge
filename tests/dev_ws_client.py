#!/usr/bin/env python3
"""A Chrome-free stand-in for the extension - for debugging the bridge.

It connects to `ws://127.0.0.1:8000/ws/browser`, prints every request the server
sends, and answers with either your own text or a canned reply.  Useful to prove
that Hermes/OpenClaw -> server -> "browser" -> back works, before you spend time
on selectors.

    python test/dev_ws_client.py --reply "hello from the fake browser"
    python test/dev_ws_client.py --echo-prompt         # answer with the prompt
    python test/dev_ws_client.py --manual              # type each answer yourself
    python test/dev_ws_client.py --fail captcha        # always report a captcha

Then, from another terminal:

    curl -s http://127.0.0.1:8000/v1/chat/completions \
      -H 'Content-Type: application/json' \
      -d '{"model":"arena-agent","messages":[{"role":"user","content":"ping"}]}' | python -m json.tool
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from typing import Any, Dict

try:
    import websockets
except ImportError as exc:  # pragma: no cover
    print("pip install websockets", file=sys.stderr)
    raise SystemExit(1) from exc


def build_reply(payload: Dict[str, Any], args: argparse.Namespace) -> Dict[str, Any]:
    prompt = payload.get("prompt", "")
    duration = int((time.time() - float(payload.get("created_at", time.time()))) * 1000)

    if args.fail:
        return {
            "response": None,
            "error": args.fail,
            "meta": {"message": f"simulated `{args.fail}` from dev_ws_client.py", "duration_ms": duration},
        }
    if args.manual:
        print("\n--- prompt received " + "-" * 40)
        print(prompt[:2000])
        print("-" * 60)
        text = input("answer (leave empty to send an empty answer): ")
    elif args.echo_prompt:
        text = f"[fake browser] prompt has {len(prompt)} characters:\n\n{prompt[-500:]}"
    else:
        text = args.reply or "hello from dev_ws_client.py"

    if args.delay:
        time.sleep(args.delay)
    return {
        "response": text,
        "error": None,
        "meta": {"duration_ms": int((time.time() - float(payload.get("created_at", time.time()))) * 1000),
                 "simulated": True},
    }


async def run(args: argparse.Namespace) -> None:
    url = args.url
    async with websockets.connect(url, ping_interval=None) as ws:
        await ws.send(json.dumps({
            "type": "hello",
            "client": f"dev_ws_client/{args.version}",
            "version": args.version,
            "url": "cli://fake-browser",
        }))
        print(f"connected to {url} - waiting for requests (Ctrl+C to stop)")

        async def heartbeat() -> None:
            while True:
                await asyncio.sleep(20)
                await ws.send(json.dumps({"type": "heartbeat", "state": "idle", "busy": False,
                                          "url": "cli://fake-browser"}))

        heartbeat_task = asyncio.create_task(heartbeat())
        try:
            async for raw in ws:
                try:
                    message = json.loads(raw)
                except json.JSONDecodeError:
                    print("non-JSON frame:", raw[:200])
                    continue

                kind = message.get("type")
                if kind == "request":
                    print(f"\n-> request {message.get('id')} ({message.get('mode')}, "
                          f"{len(message.get('prompt', ''))} chars, timeout {message.get('timeout')}s)")
                    body = build_reply(message, args)
                    await ws.send(json.dumps({"type": "response", "id": message.get("id"), **body}))
                    status = "error: " + str(body["error"]) if body["error"] else \
                        f"{len(body['response'] or '')} chars"
                    print(f"<- answered {message.get('id')} ({status})")
                elif kind in ("ping", "welcome", "replaced"):
                    if kind == "ping":
                        await ws.send(json.dumps({"type": "pong"}))
                    else:
                        print(f"   server: {kind} {message}")
                else:
                    print("   server:", message)
        finally:
            heartbeat_task.cancel()


def main() -> None:
    parser = argparse.ArgumentParser(description="Fake browser for ArenaAgentBridge")
    parser.add_argument("--url", default="ws://127.0.0.1:8000/ws/browser")
    parser.add_argument("--reply", default=None, help="answer with this fixed text")
    parser.add_argument("--echo-prompt", action="store_true", help="answer with the received prompt")
    parser.add_argument("--manual", action="store_true", help="type every answer interactively")
    parser.add_argument("--fail", default=None, metavar="CODE",
                        help="always report this error code, e.g. captcha, timeout, selector_missing")
    parser.add_argument("--delay", type=float, default=0.0, help="seconds to wait before answering")
    parser.add_argument("--version", default="1.0.0")
    args = parser.parse_args()
    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
