/**
 * ArenaAgentBridge - extension/popup.js
 * ---------------------------------------------------------------------------
 * Status view + two useful buttons:
 *   - "Diagnose DOM" explains why a request failed (which selector matched, is
 *     there a captcha, was the user logged out, ...),
 *   - "Cancel now" tells the content script to abort the running capture.
 */
(function () {
  'use strict';

  const CFG = window.__AAB_CONFIG__ || {};
  const $ = (id) => document.getElementById(id);

  const els = {
    dot: $('dot'),
    version: $('version'),
    extState: $('ext-state'),
    tabState: $('tab-state'),
    serverVersion: $('server-version'),
    answered: $('answered'),
    errorRow: $('error-row'),
    lastError: $('last-error'),
    serverUrl: $('server-url'),
    diag: $('diag'),
    diagHint: $('diag-hint'),
  };

  function send(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (reply) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(reply || null);
      });
    });
  }

  function setState(state, note) {
    const dot = els.dot;
    const mapped = ['connected', 'busy', 'error', 'disconnected', 'standby'].includes(state) ? state : 'idle';
    dot.dataset.state = mapped === 'busy' ? 'busy' : mapped;
    els.extState.textContent = note ? `${mapped} (${note})` : mapped;
    els.extState.className = mapped === 'connected' ? 'ok' : mapped === 'busy' ? 'warn' : mapped === 'error' ? 'bad' : 'muted';
  }

  function describeTab(tabs, owner) {
    const ids = Object.keys(tabs || {});
    if (!ids.length) return 'no arena.ai tab has reported in yet';
    const ownerId = owner && owner.tabId;
    const parts = ids.map((id) => {
      const info = tabs[id];
      const mark = String(id) === String(ownerId) ? '*' : ' ';
      return `${mark} tab ${id}: ${info.state}${info.busy ? ' (busy)' : ''}`;
    });
    return parts.join('\n');
  }

  async function refresh() {
    const [state, stored] = await Promise.all([
      send({ kind: 'popup-state' }),
      new Promise((resolve) => chrome.storage.session.get(['aabState'], (data) => resolve(data && data.aabState))),
    ]);

    const source = stored || {};
    const serverUrl = (state && state.serverUrl) || source.serverUrl || (CFG && CFG.SERVER_WS_URL) || '';
    if (!els.serverUrl.value) els.serverUrl.value = serverUrl;

    const ownerTab = state && state.owner ? state.owner.tabId : source.owner ? source.owner.tabId : null;
    const tabs = (state && state.tabs) || source.tabs || {};
    const ownerInfo = ownerTab !== null && tabs[ownerTab] ? tabs[ownerTab] : null;

    setState(
      ownerInfo ? ownerInfo.state || 'connected' : 'idle',
      ownerInfo ? null : 'waiting for a bridge tab'
    );
    els.version.textContent = `v${(CFG && CFG.version) || chrome.runtime.getManifest().version}`;
    els.tabState.textContent = describeTab(tabs, { tabId: ownerTab });
    els.tabState.className = ownerInfo ? 'ok' : 'muted';
    els.serverVersion.textContent = (ownerInfo && ownerInfo.serverVersion) || source.serverVersion || '-';
    els.answered.textContent = String(source.answered || 0);

    const lastError = (state && state.lastError) || source.lastError;
    if (lastError) {
      els.errorRow.hidden = false;
      els.lastError.textContent = String(lastError).slice(0, 180);
    } else {
      els.errorRow.hidden = true;
    }
  }

  async function activeArenaTab() {
    const tabs = await chrome.tabs.query({ url: ['https://arena.ai/*'] });
    if (!tabs.length) return null;
    return tabs.find((tab) => tab.active) || tabs[0];
  }

  function renderDiagnostics(payload) {
    if (!payload) {
      els.diag.textContent = 'no answer from the tab - is https://arena.ai/agent open?';
      return;
    }
    const diag = payload.diag || {};
    const lines = [
      `state: ${payload.state}${payload.busy ? ' (busy)' : ''}`,
      `page:  ${diag.url || '?'}`,
      `title: ${diag.title || '?'}`,
      '',
      'checks:',
      ...Object.entries(diag.checks || {}).map(([key, value]) => `  ${key}: ${value}`),
      '',
      'selector hits (0 = fix config.js):',
      ...Object.entries(diag.selectorCounts || {}).map(([key, value]) => `  ${key}: ${value}`),
      '',
      `messages found: ${diag.messageCount}`,
      `last role:      ${diag.lastRole || '-'}`,
      `captured stream frames: ${(diag.stream && diag.stream.frames) || 0} ` +
        `(chars: ${(diag.stream && diag.stream.mainChars) || 0})`,
      `page hook injected: ${payload.injected}`,
      '',
      'last message sample:',
      (diag.lastMessageSample || '-').replace(/^/gm, '  '),
    ];
    els.diag.textContent = lines.join('\n');
  }

  // ---------------------------------------------------------------------
  els.reconnect.addEventListener('click', async () => {
    const tab = await activeArenaTab();
    if (tab) await new Promise((resolve) => chrome.tabs.sendMessage(tab.id, { kind: 'reconnect' }, () => {
      void chrome.runtime.lastError;
      resolve();
    }));
    await send({ kind: 'ensure-content' });
    els.diagHint.textContent = 'reconnect requested';
    setTimeout(refresh, 800);
  });

  els.saveServer.addEventListener('click', async () => {
    const url = els.serverUrl.value.trim();
    // The content script owns the socket, so the URL comes from config.js; we
    // only accept changes that look like a local bridge address.
    if (url && !/^ws:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/ws\/browser$/.test(url)) {
      els.diag.textContent =
        'Invalid URL. The bridge is local-only, e.g. ws://127.0.0.1:8000/ws/browser.\n' +
        'To change it permanently edit extension/config.js (SERVER_WS_URL).';
      return;
    }
    chrome.storage.local.set({ serverUrl: url }, async () => {
      const tabs = await chrome.tabs.query({ url: ['https://arena.ai/*'] });
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { kind: 'reconnect' }, () => void chrome.runtime.lastError);
      }
      els.diagHint.textContent = 'server url saved';
      setTimeout(refresh, 500);
    });
  });

  els.diagnose.addEventListener('click', async () => {
    els.diagHint.textContent = 'running…';
    const tab = await activeArenaTab();
    if (!tab) {
      els.diag.textContent = 'No https://arena.ai tab is open. Open the site, log in, then try again.';
      els.diagHint.textContent = 'no tab';
      return;
    }
    chrome.tabs.sendMessage(tab.id, { kind: 'diagnose' }, (reply) => {
      if (chrome.runtime.lastError || !reply) {
        els.diag.textContent =
          `The content script is not running in tab ${tab.id} (page loaded before the extension?).\n` +
          'Reload the arena.ai tab, or press "Reconnect" to inject it again.';
        els.diagHint.textContent = 'content script missing';
        return;
      }
      renderDiagnostics(reply);
      els.diagHint.textContent = `tab ${tab.id}`;
    });
  });

  els.openTab.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://arena.ai/agent' });
  });

  els.cancel.addEventListener('click', async () => {
    const tab = await activeArenaTab();
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { kind: 'cancel', reason: 'cancelled' }, () => void chrome.runtime.lastError);
      els.diagHint.textContent = 'cancelled the running capture';
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.kind === 'bridge-state') refresh();
  });

  refresh();
  setInterval(refresh, 2000);
})();
