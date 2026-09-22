/**
 * ArenaAgentBridge - extensions/shared/background.js (MV3 worker / event page)
 * ---------------------------------------------------------------------------
 * The content script owns the WebSocket to `ws://127.0.0.1:8000/ws/browser`
 * (that is the architecture of this project), so this worker does not talk to
 * the server itself.  Its job:
 *
 *   1. Designate exactly ONE arena.ai tab as the bridge tab (a lease), so two
 *      open tabs do not fight over the single server connection.
 *   2. Keep the worker - and therefore the lease bookkeeping - alive while a
 *      long answer streams.
 *   3. Re-inject the content script into arena.ai tabs that lost it (extension
 *      installed after the page was opened, extension reloaded, bfcache).
 *   4. Publish state to the popup via `chrome.storage.session` + runtime
 *      messages.
 */
// Chrome loads this as a service worker and needs importScripts(); Firefox
// loads config.js + background.js as event-page scripts (see the manifests), so
// the call is guarded and the fallback is simply "config already loaded".
if (typeof importScripts === 'function') {
  try {
    importScripts('config.js');
  } catch (error) {
    console.warn('[ArenaAgentBridge:bg] could not load config.js', error);
  }
}

const CFG = (typeof self !== 'undefined' && self.__AAB_CONFIG__) || {};
const SITE_PATTERN = 'https://arena.ai/*';
const LEASE_MS = 60_000;
const PING_ALARM = 'aab-ping';
// Chrome allows 0.5, Firefox requires >= 1: use 1 everywhere.
const PING_PERIOD_MINUTES = 1;
const IS_GECKO = typeof browser !== 'undefined' && Boolean(browser.runtime && browser.runtime.getBrowserInfo);

const state = {
  owner: null, // { tabId, at }
  tabs: {}, // tabId -> last state report
  lastError: null,
  lastAction: null,
  answered: 0,
  claimedAt: null,
};

// ---------------------------------------------------------------------------
function log(...args) {
  if (CFG.debug && CFG.debug.VERBOSE) console.log('[ArenaAgentBridge:bg]', ...args);
}

async function describeBrowser() {
  if (!IS_GECKO) return { engine: 'chromium', version: null };
  try {
    const info = await browser.runtime.getBrowserInfo();
    return { engine: 'gecko', name: info.name, version: info.version };
  } catch (_) {
    return { engine: 'gecko', version: null };
  }
}

let lastPersistKey = '';

function persist(extra) {
  const tabs = {};
  for (const [tabId, info] of Object.entries(state.tabs)) {
    tabs[tabId] = { state: info.state, busy: info.busy, at: info.at };
  }
  const snapshot = {
    owner: state.owner,
    tabs,
    pageHook: state.pageHook || null,
    lastError: state.lastError,
    lastAction: state.lastAction || null,
    answered: state.answered || 0,
    claimedAt: state.claimedAt,
    serverUrl: (CFG && CFG.SERVER_WS_URL) || 'ws://127.0.0.1:8000/ws/browser',
    updatedAt: Date.now(),
    browser: state.browser || null,
    permissions: state.permissions || null,
    ...(extra || {}),
  };
  // The content script heartbeats every 30 s and the alarm fires every
  // minute; when nothing meaningful changed, a write to chrome.storage
  // (and a message to the popup) buys nothing - skip it.  Timestamps are
  // deliberately NOT part of the key: they change on every call.
  const key = JSON.stringify([
    state.owner && state.owner.tabId,
    Object.keys(state.tabs).sort().map((id) => [id, state.tabs[id].state, state.tabs[id].busy]),
    state.lastError,
    state.lastAction,
    state.answered || 0,
    state.permissions && state.permissions.granted,
    state.pageHook && state.pageHook.ready,
    extra ? JSON.stringify(extra) : '',
  ]);
  if (!extra && key === lastPersistKey) return snapshot;
  lastPersistKey = key;
  try {
    chrome.storage.session.set({ aabState: snapshot });
  } catch (_) {
    /* storage.session missing on very old builds - the popup then falls back */
  }
  try {
    chrome.runtime.sendMessage({ kind: 'bridge-state', ...snapshot }).catch(() => {});
  } catch (_) {
    /* no popup listening */
  }
}

async function tabAlive(tabId) {
  if (!tabId) return false;
  try {
    const reply = await chrome.tabs.sendMessage(tabId, { kind: 'ping-content' });
    return Boolean(reply && reply.ok);
  } catch (_) {
    return false;
  }
}

/** Grant (or renew) the bridge lease for a tab. */
async function claim(tabId) {
  const now = Date.now();
  if (!state.owner || state.owner.tabId === tabId || now - state.owner.at > LEASE_MS) {
    state.owner = { tabId, at: now };
    state.claimedAt = now;
    persist();
    return true;
  }
  const alive = await tabAlive(state.owner.tabId);
  if (!alive) {
    log('previous owner tab is gone, handing the lease to tab', tabId);
    state.owner = { tabId, at: now };
    state.claimedAt = now;
    persist();
    return true;
  }
  return false;
}

/** Injected when a tab has no content script (extension reloaded, install order). */
async function ensureContentScript(tabId) {
  if (await tabAlive(tabId)) return true;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['config.js', 'content.js'] });
    log('content script injected into tab', tabId);
    return true;
  } catch (error) {
    state.lastError = `injection failed for tab ${tabId}: ${error && error.message}`;
    persist();
    return false;
  }
}

/**
 * Inject the optional page-world stream hook (see content.js / inject.js).
 * Works in Chrome 111+ and Firefox 128+; on Firefox it needs a granted host
 * permission, so a failure here is only reported, never fatal.
 */
async function injectPageHook(tabId) {
  if (!tabId) return { ok: false, error: 'no tab' };
  try {
    await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['inject.js'] });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

/** Firefox MV3 makes host permissions opt-in: report what still needs granting. */
async function permissionState() {
  // Both loopback hosts: the extension's settings accept ws://127.0.0.1 and
  // ws://localhost alike, so the grant flow must cover both.
  const origins = ['http://127.0.0.1:8000/*', 'http://localhost:8000/*', 'https://arena.ai/*'];
  try {
    if (!chrome.permissions || !chrome.permissions.contains) return { supported: false, granted: true, origins };
    const granted = await chrome.permissions.contains({ origins });
    return { supported: true, granted: Boolean(granted), origins };
  } catch (error) {
    return { supported: false, granted: true, origins, error: String((error && error.message) || error) };
  }
}

// ---------------------------------------------------------------------------
// popup <-> background
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.kind) return undefined;
  const senderTab = sender && sender.tab ? sender.tab.id : null;

  switch (message.kind) {
    case 'claim': {
      const tabId = message.tabId || senderTab;
      claim(tabId).then((granted) => {
        sendResponse({
          granted,
          ownerTabId: state.owner ? state.owner.tabId : null,
          leaseMs: LEASE_MS,
        });
      });
      return true; // async
    }
    case 'release': {
      if (state.owner && state.owner.tabId === (message.tabId || senderTab)) {
        state.owner = null;
        persist();
      }
      sendResponse({ ok: true });
      return false;
    }
    case 'state': {
      const tabId = message.tabId || senderTab;
      if (!tabId) {
        sendResponse({ ok: false });
        return false;
      }
      const previous = state.tabs[tabId] || {};
      state.tabs[tabId] = {
        state: message.state,
        busy: message.busy,
        lastError: message.lastError,
        lastAnswerMs: message.lastAnswerMs,
        answered: typeof message.answered === 'number' ? message.answered : previous.answered || 0,
        url: message.url,
        pageHook: message.pageHook || null,
        at: Date.now(),
      };
      // the tab counter restarts on reload; keep the session total growing
      const before = previous.answered || 0;
      if (typeof message.answered === 'number' && message.answered > before) {
        state.answered = (state.answered || 0) + (message.answered - before);
      }
      if (message.lastAction) state.lastAction = message.lastAction;
      if (state.owner && state.owner.tabId === tabId) state.owner.at = Date.now();
      if (!state.owner || state.owner.tabId === tabId) state.pageHook = message.pageHook || state.pageHook;
      if (message.lastError) state.lastError = message.lastError;
      persist();
      sendResponse({ ok: true });
      return false;
    }
    case 'popup-state': {
      permissionState().then((permissions) => {
        state.permissions = permissions;
        sendResponse({
          ok: true,
          owner: state.owner,
          tabs: state.tabs,
          lastError: state.lastError,
          lastAction: state.lastAction || null,
          answered: state.answered || 0,
          browser: state.browser,
          permissions,
          serverUrl: (CFG && CFG.SERVER_WS_URL) || null,
        });
      });
      return true; // async
    }
    case 'permissions-granted': {
      // the popup obtained the grant; re-inject the page hook into every tab
      (async () => {
        const tabs = await chrome.tabs.query({ url: [SITE_PATTERN] });
        for (const tab of tabs) {
          await injectPageHook(tab.id);
          chrome.tabs.sendMessage(tab.id, { kind: 'reconnect' }, () => void chrome.runtime.lastError);
        }
        state.permissions = await permissionState();
        state.lastError = null;
        persist();
        sendResponse({ ok: true, permissions: state.permissions });
      })();
      return true; // async
    }
    case 'inject-page-hook': {
      injectPageHook(message.tabId || senderTab).then(sendResponse);
      return true; // async
    }
    case 'permissions-state': {
      permissionState().then(sendResponse);
      return true; // async
    }
    case 'ensure-content': {
      (async () => {
        const tabs = await chrome.tabs.query({ url: [SITE_PATTERN] });
        const results = [];
        for (const tab of tabs) results.push({ tabId: tab.id, ok: await ensureContentScript(tab.id) });
        sendResponse({ ok: true, results });
      })();
      return true; // async
    }
    default:
      return undefined;
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'aab-keepalive') return;
  port.onMessage.addListener(() => {
    /* any port traffic resets the MV3 idle timer */
  });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== PING_ALARM) return;
  for (const tabId of Object.keys(state.tabs)) {
    if (!(await tabAlive(Number(tabId)))) delete state.tabs[tabId];
  }
  if (state.owner && Date.now() - state.owner.at > LEASE_MS * 2) {
    log('lease for tab', state.owner.tabId, 'expired');
    state.owner = null;
  }
  persist();
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(PING_ALARM, { periodInMinutes: PING_PERIOD_MINUTES });
  persist();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(PING_ALARM, { periodInMinutes: PING_PERIOD_MINUTES });
  persist();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete state.tabs[tabId];
  if (state.owner && state.owner.tabId === tabId) state.owner = null;
  persist();
});

// Keep the door open: if an arena.ai tab finishes loading without a content
// script (common right after installing/reloading the extension), inject it.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab || !tab.url || !tab.url.startsWith('https://arena.ai')) return;
  if (state.tabs[tabId]) return;
  await ensureContentScript(tabId);
});

chrome.alarms.create(PING_ALARM, { periodInMinutes: PING_PERIOD_MINUTES });

// First run: remember which browser we are in and whether Firefox still needs
// the host permissions granted (about:addons -> Permissions).
Promise.all([describeBrowser(), permissionState()]).then(([info, permissions]) => {
  state.browser = info;
  state.permissions = permissions;
  if (!permissions.granted) {
    state.lastError =
      'host permissions are not granted yet - open the popup and press "Grant permissions"';
  }
  persist({ browser: info, permissions });
  log('background worker ready', info, permissions);
});
