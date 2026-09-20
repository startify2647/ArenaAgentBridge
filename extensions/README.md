# Extensions

One shared codebase, two browser packages, one build step.

```
extensions/
├── shared/                 ← the only place you edit code
│   ├── config.js           selectors, thresholds, server URL  (start here)
│   ├── content.js          owns the WebSocket, drives the DOM
│   ├── inject.js           page-world stream hook (optional, read-only)
│   ├── background.js       connection lease, keepalive, scripting bridge
│   ├── popup.html/js       status, Diagnose DOM, permissions, cancel
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
stream hook is active, and a **Diagnose DOM** button.

## Editing

* **Selectors / thresholds / behaviour** → `shared/config.js`. Everything is
  documented inline, and the values can be overridden at runtime from the page
  console: `__AAB_CONFIG__.selectors.input.unshift('textarea.my-new-class')`.
* **Automation logic** → `shared/content.js` (`SiteDriver` = DOM, `Pipeline` =
  type→submit→capture, `Transport` + `Bridge` = WebSocket, `PageHook` = the
  optional page-world hook).
* **Browser differences** → only the manifests. The shared code detects the engine
  through `chrome.*` availability and `browser.runtime.getBrowserInfo`.

After editing, rebuild (`python scripts/build-extensions.py`) and reload the
extension in the browser. Test before you rebuild:

```bash
node tests/extension_dom_test.mjs        # 49 DOM/automation checks, no browser needed
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
