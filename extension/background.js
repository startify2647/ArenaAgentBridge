/**
 * ArenaAgentBridge - extension/background.js (Manifest V3 service worker)
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
importScripts('config.js');

const CFG = (typeof self !== 'undefined' && self.__AAB_CONFIG__) || {};
const SITE_PATTERN = 'https://arena.ai/*';
const LEASE_MS = 60_000;
const PING_ALARM = 'aab-ping';

const state = {
  owner: null, // { tabId, at }
  tabs: {}, // tabId -> last state report
  lastError: null,
  claimedAt: null,
};

// ---------------------------------------------------------------------------
function log(...args) {
  if (CFG.debug && CFG.debug.VERBOSE) console.log('[ArenaAgentBridge:bg]', ...args);
}

function persist(extra) {
  const tabs = {};
  for (const [tabId, info] of Object.entries(state.tabs)) {
    tabs[tabId] = { state: info.state, busy: info.busy, at: info.at };
  }
  const snapshot = {
    owner: state.owner,
    tabs,
    lastError: state.lastError,
    claimedAt: state.claimedAt,
    serverUrl: (CFG && CFG.SERVER_WS_URL) || 'ws://127.0.0.1:8000/ws/browser',
    updatedAt: Date.now(),
    ...(extra || {}),
  };
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
      state.tabs[tabId] = {
        state: message.state,
        busy: message.busy,
        lastError: message.lastError,
        lastAnswerMs: message.lastAnswerMs,
        url: message.url,
        at: Date.now(),
      };
      if (state.owner && state.owner.tabId === tabId) state.owner.at = Date.now();
      if (message.lastError) state.lastError = message.lastError;
      persist();
      sendResponse({ ok: true });
      return false;
    }
    case 'popup-state': {
      sendResponse({
        ok: true,
        owner: state.owner,
        tabs: state.tabs,
        lastError: state.lastError,
        serverUrl: (CFG && CFG.SERVER_WS_URL) || null,
      });
      return false;
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
  chrome.alarms.create(PING_ALARM, { periodInMinutes: 1 });
  persist();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(PING_ALARM, { periodInMinutes: 1 });
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

chrome.alarms.create(PING_ALARM, { periodInMinutes: 1 });
persist();
log('background worker ready');
