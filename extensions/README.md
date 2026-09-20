# Extensions

[فارسی](README.fa.md) · [README فارسی](../README.fa.md)

One shared codebase, two browser packages, one build step.

```
extensions/
├── shared/                 ← the only place you edit code
│   ├── config.js           selectors, thresholds, server URL  (start here)
│   ├── content.js          owns the WebSocket, drives the DOM
│   ├── inject.js           page-world stream hook (optional, read-only)
│   ├── background.js       connection lease, keepalive, scripting bridge
│   ├── settings.js         settings model: validation, storage, apply, export/import
│   ├── i18n.js             English/Persian strings + the data-i18n applier
│   ├── popup.html/js       status, quick test, Diagnose DOM, settings, cancel
│   ├── options.html/js     the full options page (same model, wider layout)
│   └── icons/              shared icons
├── chrome/manifest.json    service worker, world:MAIN hook, Chrome 111+
└── firefox/manifest.json   event page, gecko id, opt-in host permissions, FF 128+
```

The build copies `shared/` + one manifest into `dist/<browser>/`, which is what
you actually load:

```bash
python scripts/build-extensions.py            # both
python scripts/build-extensions.py --browser firefox
python scripts/build-extensions.py --check    # validate without writing
python scripts/build-extensions.py --zip      # dist/*.zip for stores / signing
```

Nothing is duplicated in git, and the build refuses to produce a broken package
(version drift, missing files, wrong background type for the browser, broad host
permissions, `eval`).

## Load it

| browser | how |
| --- | --- |
| Chrome / Edge / Brave | `chrome://extensions` → Developer mode → **Load unpacked** → `dist/chrome` |
| Firefox 128+ | `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → `dist/firefox/manifest.json`, then grant host permissions from the popup (see [`../docs/FIREFOX.md`](../docs/FIREFOX.md)) |

Then open <https://arena.ai/agent>, log in, and check the badge in the bottom-right
corner. The popup shows the server state, the bridge tab, whether the optional
stream hook is active, the **last action** the bridge took (the first thing to
look at when "nothing happens"), a **Quick test** (runs one prompt through the
bridge from inside the browser), a **Diagnose DOM** button, and a settings tab
that links to the full options page (*Extension details → Extension options*).

The server side has its own dashboard at <http://127.0.0.1:8000/admin> - a live
panel with the request history, a playground, browser control and runtime
settings. See [`../docs/WEBUI.md`](../docs/WEBUI.md).

## Editing

* **Selectors / thresholds / behaviour** → `shared/config.js`. Everything is
  documented inline, and the values can be overridden at runtime from the page
  console: `__AAB_CONFIG__.selectors.input.unshift('textarea.my-new-class')`.
* **What the user can change** → `shared/settings.js` (the field list, validation
  and the `chrome.storage.local` overrides the popup and options page edit).
* **Automation logic** → `shared/content.js` (`SiteDriver` = DOM, `Pipeline` =
  type→submit→capture, `Transport` + `Bridge` = WebSocket, `PageHook` = the
  optional page-world hook). A turn ends on the first of: stable text, the site's
  own stream saying it is done, the post-answer survey appearing (agent mode, the
  extension clicks *Keep working*), a stall/`site_idle` with a partial answer, or
  the request deadline - never on a frozen tab hanging until the server timeout.
* **Browser differences** → only the manifests. The shared code detects the engine
  through `chrome.*` availability and `browser.runtime.getBrowserInfo`.

After editing, rebuild (`python scripts/build-extensions.py`) and reload the
extension in the browser. Test before you rebuild:

```bash
node tests/extension_dom_test.mjs        # 140 DOM/automation/settings/UI checks, no browser
node tests/webui_dom_test.mjs            # 60 checks for the admin panel UI
python -m pytest tests/test_extension_static.py tests/test_build.py
```

## Permissions, deliberately minimal

| permission | why |
| --- | --- |
| `storage` | remember the server URL and the last state for the popup |
| `alarms` | revive the background worker (MV3 workers/event pages are evicted) |
| `scripting` | re-inject the content script into tabs opened before installation, and the optional page hook |
| host `https://arena.ai/*` | the site the bridge automates |
| host `http://127.0.0.1:8000/*`, `http://localhost:8000/*` | the local bridge server - loopback only |

No `tabs` permission is required (Firefox declares it as *optional* only to be able
to list tab URLs when the user grants it). No `webRequest`, no `cookies`, no
`<all_urls>`, no remote hosts, no analytics, no `eval`.
