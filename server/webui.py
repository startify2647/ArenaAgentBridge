"""The admin panel front-end (HTML shell + assets).

The panel is deliberately dependency-free: plain HTML/CSS/JS served from this
process, no CDN, no bundler, no npm.  That keeps the promise of the project -
everything runs on your machine, offline, and the page never talks to anything
but ``127.0.0.1``.

    server/webui.py            this file: the HTML shell + asset loader
    server/assets/panel.css    the stylesheet (dark + light, RTL aware)
    server/assets/panel.js     the application (views, polling, i18n)

The shell carries a tiny ``window.__AAB_PANEL__`` config block (version, model,
port, refresh interval) that :mod:`server.admin` fills in per request.
"""

from __future__ import annotations

from pathlib import Path

ASSETS = Path(__file__).resolve().parent / "assets"


def _read(name: str) -> str:
    path = ASSETS / name
    try:
        return path.read_text(encoding="utf-8")
    except OSError:  # pragma: no cover - packaging accident
        return f"/* {name} is missing from server/assets */"


PANEL_CSS = _read("panel.css")
PANEL_JS = _read("panel.js")

#: ``__VERSION__``, ``__MODEL_ID__``, ``__PORT__`` and ``__REFRESH_MS__`` are
#: replaced by ``server.admin.render_page``.
PANEL_HTML = """<!doctype html>
<html lang="en" dir="ltr" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>ArenaAgentBridge · admin panel</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/admin/assets/panel.css">
<script>
  window.__AAB_PANEL__ = {
    version: "__VERSION__",
    modelId: "__MODEL_ID__",
    port: __PORT__,
    refreshMs: __REFRESH_MS__
  };
</script>
</head>
<body>

<div id="banner" hidden></div>

<div id="app">
  <div class="brand">
    <span class="logo">A</span>
    <span>
      <span class="title">ArenaAgentBridge</span><br>
      <span class="sub" data-i18n="app.sub">local bridge console</span>
    </span>
  </div>

  <header class="topbar">
    <span class="pill" id="conn-pill"><span class="dot"></span>…</span>
    <span class="small muted" id="top-counts">
      <span data-i18n="dash.requests">Requests</span> <span class="mono" id="stat-requests">0</span>
      · <span data-i18n="dash.errors">Errors</span> <span class="mono" id="stat-errors">0</span>
    </span>
    <span class="grow"></span>
    <span class="badge" id="live-dot">live</span>
    <button class="small ghost" id="pause-toggle" data-action="pause-toggle" title="pause auto refresh">❙❙</button>
    <button class="small ghost" data-action="refresh" title="refresh now">⟳</button>
    <button class="small ghost" id="lang-toggle" data-action="lang">فارسی</button>
    <button class="small ghost" id="theme-toggle" data-action="theme">☀</button>
  </header>

  <aside class="sidebar">
    <button class="nav-item" data-view="dashboard" data-action="nav"><span class="ico">▤</span><span data-i18n="nav.dashboard">Dashboard</span></button>
    <button class="nav-item" data-view="playground" data-action="nav"><span class="ico">▶</span><span data-i18n="nav.playground">Playground</span></button>
    <button class="nav-item" data-view="requests" data-action="nav"><span class="ico">≡</span><span data-i18n="nav.requests">Requests</span><span class="badge-count" id="nav-requests-count" hidden></span></button>
    <button class="nav-item" data-view="browser" data-action="nav"><span class="ico">🖥</span><span data-i18n="nav.browser">Browser &amp; extension</span></button>
    <button class="nav-item" data-view="sanitizer" data-action="nav"><span class="ico">🛡</span><span data-i18n="nav.sanitizer">Sanitiser</span></button>
    <button class="nav-item" data-view="settings" data-action="nav"><span class="ico">⚙</span><span data-i18n="nav.settings">Settings</span></button>
    <button class="nav-item" data-view="connect" data-action="nav"><span class="ico">⇄</span><span data-i18n="nav.connect">Connect</span></button>
    <span class="spacer"></span>
    <div class="side-note">
      Loopback only · nothing leaves this machine.<br>
      Extension: <span class="mono">ws://127.0.0.1:__PORT__/ws/browser</span>
    </div>
  </aside>

  <main id="main">
    <section class="view" id="view-dashboard" hidden>
      <div class="view-head">
        <div>
          <h2 data-i18n="dash.title">Dashboard</h2>
          <div class="hint" data-i18n="dash.hint">Live view of the bridge.</div>
        </div>
      </div>
      <div class="stack" id="dash-body"></div>
    </section>

    <section class="view" id="view-playground" hidden>
      <div class="view-head">
        <div>
          <h2 data-i18n="play.title">Playground</h2>
          <div class="hint" data-i18n="play.hint">Send a prompt through the bridge queue.</div>
        </div>
      </div>
      <div id="play-body"></div>
    </section>

    <section class="view" id="view-requests" hidden>
      <div class="view-head">
        <div>
          <h2 data-i18n="req.title">Requests</h2>
          <div class="hint" data-i18n="req.hint">In-memory history.</div>
        </div>
      </div>
      <div id="requests-body"></div>
    </section>

    <section class="view" id="view-browser" hidden>
      <div class="view-head">
        <div>
          <h2 data-i18n="brw.title">Browser &amp; extension</h2>
          <div class="hint" data-i18n="brw.hint">The bridge drives one logged-in tab.</div>
        </div>
      </div>
      <div class="stack" id="browser-body"></div>
    </section>

    <section class="view" id="view-sanitizer" hidden>
      <div class="view-head">
        <div>
          <h2 data-i18n="san.title">Sanitiser</h2>
          <div class="hint" data-i18n="san.hint">Answers from the page are untrusted input.</div>
        </div>
      </div>
      <div id="sanitizer-body"></div>
    </section>

    <section class="view" id="view-settings" hidden>
      <div class="view-head">
        <div>
          <h2 data-i18n="set.title">Settings</h2>
          <div class="hint" data-i18n="set.hint">Editable at runtime.</div>
        </div>
        <div class="row">
          <button class="primary" data-action="settings-apply" data-i18n="set.apply">Apply changes</button>
          <button data-action="settings-reset" data-i18n="set.reset">Reload from environment</button>
          <a class="btn" href="/admin/api/settings/env" download data-i18n="set.download_env">Download .env</a>
        </div>
      </div>
      <div class="stack" id="settings-body"></div>
    </section>

    <section class="view" id="view-connect" hidden>
      <div class="view-head">
        <div>
          <h2 data-i18n="con.title">Connect</h2>
          <div class="hint" data-i18n="con.hint">Point any OpenAI-compatible client here.</div>
        </div>
      </div>
      <div class="grid cols-2" id="connect-body"></div>
    </section>
  </main>

  <footer>
    <span>ArenaAgentBridge <span class="mono">v__VERSION__</span></span>
    <span class="badge" data-i18n="footer.loopback">loopback only</span>
    <a href="/docs" target="_blank" rel="noreferrer" data-i18n="footer.docs">docs</a>
    <a href="/readyz" target="_blank" rel="noreferrer" data-i18n="footer.ready">readiness</a>
    <a href="/v1/bridge/status" target="_blank" rel="noreferrer">/v1/bridge/status</a>
    <a href="https://github.com/startify2647/ArenaAgentBridge" target="_blank" rel="noreferrer">GitHub</a>
  </footer>
</div>

<dialog id="detail"></dialog>
<div id="toasts"></div>
<script src="/admin/assets/panel.js"></script>
</body>
</html>
"""
