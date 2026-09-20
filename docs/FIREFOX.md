# Firefox

The bridge runs the same shared code in Chrome/Edge and Firefox; only the manifest
differs (`extensions/firefox/manifest.json`). This page covers what is special
about Firefox.

## Install

1. Build the extensions (nothing is duplicated in git):

   ```bash
   python scripts/build-extensions.py        # or: make build
   ```

2. Open `about:debugging#/runtime/this-firefox`.
3. **Load Temporary Add-on…** → pick `dist/firefox/manifest.json`.
4. Open <https://arena.ai> (the work page is `/agent`), log in, and click the
   extension icon.

### Grant the host permissions (one-time)

Firefox MV3 makes host permissions **opt-in**, so a freshly installed extension may
not be allowed to talk to `ws://127.0.0.1:8000` yet. The popup shows a yellow
**Grant permissions** card in that case; press it once and accept the prompt (it
asks for `127.0.0.1:8000`, `localhost:8000` and `arena.ai`). Equivalent manual
route: `about:addons` → ArenaAgentBridge → **Permissions** tab.

Without the grant you will see `browser_offline` in the popup and the badge stays
grey; the DOM automation itself would work, but the WebSocket to the local server
is blocked.

### Keeping it across restarts

Temporary add-ons disappear when Firefox closes. Firefox Release/ESR only install
**signed** extensions permanently, and `xpinstall.signatures.required` can only be
turned off in Firefox Developer Edition, Nightly or ESR with enterprise policies.
Your options:

| option | how |
| --- | --- |
| Daily development | Load Temporary Add-on every session (10 seconds) |
| Developer Edition / Nightly | `about:config` → `xpinstall.signatures.required = false`, then `python scripts/build-extensions.py --zip` and install the `.zip` from `dist/` |
| Permanent on Release | Sign it for yourself on [addons.mozilla.org](https://addons.mozilla.org/developers/) (unlisted/self-distribution is free) with `web-ext sign` |
| No install at all | Keep using the temporary add-on; the server remembers nothing between sessions anyway |

## Development loop

```bash
./scripts/firefox-dev.sh          # web-ext run: launches Firefox with the add-on
./scripts/firefox-dev.sh --lint   # Mozilla's validator (also runs in CI)
```

`web-ext run` needs Firefox installed and `npx` available; it opens a temporary
profile with the extension loaded and hot-reloads on file changes.

Manual loop without `web-ext`:

1. `python scripts/build-extensions.py --browser firefox`
2. `about:debugging` → **Reload** next to the add-on after each change
3. The content-script log is in the page console (`[ArenaAgentBridge]`), the
   background log under `about:debugging` → **Inspect**.

## What is different from Chrome

| area | Chrome | Firefox |
| --- | --- | --- |
| Background | MV3 service worker (`background.service_worker`) | event page (`background.scripts: [config.js, background.js]`) |
| `importScripts` | available, used to load `config.js` | **unavailable** - the manifest lists `config.js` first instead |
| Host permissions | granted at install | **opt-in**, `chrome.permissions.request` from the popup |
| `alarms` minimum | 30 s | 1 minute (`PING_PERIOD_MINUTES = 1` both places) |
| Page-world hook | `content_scripts.world: "MAIN"` (Chrome 111+) | same key (Firefox 128+), but subject to the page CSP → may fall back to DOM-only |
| `chrome.scripting` from a content script | allowed | allowed, but needs the granted host permission; the background worker does the injection for both |
| Tab URL visibility | always | hidden until host permissions (or the optional `tabs` permission) are granted - the popup degrades gracefully |
| Minimum version | Chrome/Edge 111 | Firefox 128 |

Everything else - DOM automation, the stream hook, request/response framing and the
OpenAI-compatible server - is identical, and the tests run the *same* shared
JavaScript for both browsers.

## Verification

```bash
python scripts/build-extensions.py --check          # both manifests valid
npx --yes web-ext lint --source-dir dist/firefox    # 0 errors / 0 warnings
node tests/extension_dom_test.mjs                   # DOM pipeline (49 checks)
```

CI runs all three, plus the Python server suite.

## Known Firefox caveats

* **Background throttling.** Firefox throttles timers in background tabs, which is
  why completion detection is event driven (MutationObserver + captured stream
  frames) instead of timer-only. Keep the agent tab in its own window for long
  tasks.
* **Strict CSP.** If the site ships a CSP that forbids `moz-extension:` scripts,
  the page-world hook cannot run and the extension falls back to DOM-only capture.
  This only makes completion detection a little slower; the popup's *Diagnose DOM*
  shows `page hook: inactive`.
* **Container tabs / private windows.** A private window has its own extension
  context; the bridge connection follows whichever tab holds the lease, so keep one
  working tab and close the others (the background hands the lease to a single
  tab).
* **Firefox for Android** is untested - the popup and the automation are designed
  for desktop.
