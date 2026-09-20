/**
 * ArenaAgentBridge - popup.js  (Chrome / Edge / Firefox)
 * ---------------------------------------------------------------------------
 * Status view plus the three things you actually need while debugging:
 *   - "Diagnose DOM"      why did a request fail (selector hits, captcha, login)
 *   - "Grant permissions" Firefox makes host permissions opt-in (MV3)
 *   - "Cancel now"        stop the running capture
 *
 * Everything goes through the background worker, which answers with callbacks -
 * the `chrome.*` namespace behaves the same in both browsers.
 */
(function () {
  'use strict';

  const CFG = window.__AAB_CONFIG__ || {};
  const IS_GECKO = typeof browser !== 'undefined' && Boolean(browser.runtime && browser.runtime.getBrowserInfo);
  const $ = (id) => document.getElementById(id);

  const els = {
    dot: $('dot'),
    version: $('version'),
    extState: $('ext-state'),
    browser: $('browser'),
    tabState: $('tab-state'),
    serverVersion: $('server-version'),
    hook: $('hook'),
    answered: $('answered'),
    errorRow: $('error-row'),
    lastError: $('last-error'),
    permissionCard: $('permission-card'),
    permissionState: $('permission-state'),
    grant: $('grant'),
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
    const mapped = ['connected', 'busy', 'error', 'disconnected', 'standby'].includes(state) ? state : 'idle';
    els.dot.dataset.state = mapped;
    els.extState.textContent = note ? `${mapped} (${note})` : mapped;
    els.extState.className =
      mapped === 'connected' ? 'ok' : mapped === 'busy' ? 'warn' : mapped === 'error' ? 'bad' : 'muted';
  }

  function describeTab(tabs, ownerTab) {
    const ids = Object.keys(tabs || {});
    if (!ids.length) return 'no arena.ai tab has reported in yet';
    const owner = ownerTab === null || ownerTab === undefined ? null : String(ownerTab);
    const lines = ids.map((id) => {
      const info = tabs[id];
      const mark = owner !== null && id === owner ? '*' : ' ';
      return `${mark} tab ${id}: ${info.state}${info.busy ? ' (busy)' : ''}`;
    });
    if (owner !== null && !ids.includes(owner)) lines.push(`* tab ${owner}: (no report yet)`);
    return lines.join('\n');
  }

  /** storage.session is missing on old builds: never let that break the popup. */
  function rememberedState() {
    return new Promise((resolve) => {
      try {
        if (!chrome.storage || !chrome.storage.session) {
          resolve(null);
          return;
        }
        chrome.storage.session.get(['aabState'], (data) => {
          void chrome.runtime.lastError;
          resolve((data && data.aabState) || null);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  async function refresh() {
    const [state, stored] = await Promise.all([send({ kind: 'popup-state' }), rememberedState()]);

    const source = stored || {};
    const permissions = (state && state.permissions) || source.permissions;
    const browserInfo = (state && state.browser) || source.browser;

    if (!els.serverUrl.value) {
      els.serverUrl.value = (state && state.serverUrl) || source.serverUrl || (CFG && CFG.SERVER_WS_URL) || '';
    }

    const ownerTab = state && state.owner ? state.owner.tabId : source.owner ? source.owner.tabId : null;
    const tabs = (state && state.tabs) || source.tabs || {};
    const ownerInfo = ownerTab !== null && tabs[ownerTab] ? tabs[ownerTab] : null;

    setState(ownerInfo ? ownerInfo.state || 'connected' : 'idle', ownerInfo ? null : 'waiting for a bridge tab');
    els.version.textContent = `v${(CFG && CFG.version) || chrome.runtime.getManifest().version}`;
    els.browser.textContent =
      IS_GECKO ? `firefox${browserInfo && browserInfo.version ? ' ' + browserInfo.version : ''}` : 'chromium';
    els.tabState.textContent = describeTab(tabs, ownerTab);
    els.tabState.className = ownerInfo ? 'ok' : 'muted';
    els.serverVersion.textContent = (ownerInfo && ownerInfo.serverVersion) || source.serverVersion || '-';
    els.answered.textContent = String(source.answered || 0);

    const hook = source.pageHook;
    if (hook) {
      els.hook.textContent = hook.ready ? `active (${hook.source || 'injected'})` : 'DOM only';
      els.hook.className = hook.ready ? 'ok' : 'muted';
    } else {
      els.hook.textContent = 'unknown';
      els.hook.className = 'muted';
    }

    const lastError = (state && state.lastError) || source.lastError;
    if (lastError) {
      els.errorRow.hidden = false;
      els.lastError.textContent = String(lastError).slice(0, 200);
    } else {
      els.errorRow.hidden = true;
    }

    const needsPermissions = Boolean(permissions && permissions.supported && !permissions.granted);
    els.permissionCard.hidden = !needsPermissions;
    if (needsPermissions) {
      els.permissionState.textContent = 'not granted';
    }
  }

  /** Tabs showing arena.ai - tolerating browsers that hide tab URLs. */
  async function arenaTabs() {
    const byUrl = await new Promise((resolve) =>
      chrome.tabs.query({ url: ['https://arena.ai/*'] }, (tabs) => {
        void chrome.runtime.lastError;
        resolve(tabs || []);
      })
    );
    if (byUrl.length) return byUrl;

    const all = await new Promise((resolve) => chrome.tabs.query({}, (tabs) => resolve(tabs || [])));
    return all.filter((tab) => (tab.url || tab.pendingUrl || '').includes('arena.ai'));
  }

  async function activeArenaTab() {
    const tabs = await arenaTabs();
    if (!tabs.length) return null;
    return tabs.find((tab) => tab.active) || tabs[0];
  }

  function renderDiagnostics(payload) {
    if (!payload) {
      els.diag.textContent = 'no answer from the tab - is https://arena.ai open?';
      return;
    }
    const diag = payload.diag || {};
    const hook = diag.pageHook || {};
    const lines = [
      `state:  ${payload.state}${payload.busy ? ' (busy)' : ''}`,
      `browser:${IS_GECKO ? ' firefox' : ' chromium'}`,
      `page:   ${diag.url || '?'}`,
      `title:  ${diag.title || '?'}`,
      '',
      'checks:',
      ...Object.entries(diag.checks || {}).map(([key, value]) => `  ${key}: ${value}`),
      '',
      'selector hits (0 = fix shared/config.js):',
      ...Object.entries(diag.selectorCounts || {}).map(([key, value]) => `  ${key}: ${value}`),
      '',
      `messages found: ${diag.messageCount}`,
      `last role:      ${diag.lastRole || '-'}`,
      `stream frames:  ${(diag.stream && diag.stream.frames) || 0} ` +
        `(chars: ${(diag.stream && diag.stream.mainChars) || 0})`,
      `page hook:      ${hook.ready ? `active (${hook.source || 'injected'})` : `inactive - ${hook.mode || '?'} injection, DOM-only capture`}`,
      '',
      'last message sample:',
      (diag.lastMessageSample || '-').replace(/^/gm, '  '),
    ];
    els.diag.textContent = lines.join('\n');
  }

  // ---------------------------------------------------------------------
  els.grant.addEventListener('click', () => {
    const origins = ['http://127.0.0.1:8000/*', 'http://localhost:8000/*', 'https://arena.ai/*'];
    const permissions = chrome.permissions;
    if (!permissions || !permissions.request) {
      els.diag.textContent = 'this browser does not expose chrome.permissions.request';
      return;
    }
    permissions.request({ origins }, async (granted) => {
      void chrome.runtime.lastError;
      if (!granted) {
        els.diag.textContent =
          'Permission denied. Without the loopback origin the extension cannot reach the bridge.\n' +
          'You can also grant it from about:addons -> ArenaAgentBridge -> Permissions.';
        return;
      }
      await send({ kind: 'permissions-granted' });
      els.diag.textContent = 'permissions granted - reconnecting the tab';
      setTimeout(refresh, 600);
    });
  });

  els.reconnect.addEventListener('click', async () => {
    const tab = await activeArenaTab();
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { kind: 'reconnect' }, () => void chrome.runtime.lastError);
    }
    await send({ kind: 'ensure-content' });
    els.diagHint.textContent = 'reconnect requested';
    setTimeout(refresh, 800);
  });

  els.saveServer.addEventListener('click', () => {
    const url = els.serverUrl.value.trim();
    if (url && !/^ws:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/ws\/browser$/.test(url)) {
      els.diag.textContent =
        'Invalid URL. The bridge is local-only, e.g. ws://127.0.0.1:8000/ws/browser.\n' +
        'To change it permanently edit extensions/shared/config.js (SERVER_WS_URL).';
      return;
    }
    chrome.storage.local.set({ serverUrl: url }, async () => {
      const tabs = await arenaTabs();
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
      els.diag.textContent =
        'No arena.ai tab found.\n' +
        (IS_GECKO
          ? 'Open the site first; if it is open, grant permissions so the popup can see tab URLs.'
          : 'Open https://arena.ai and log in, then try again.');
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
    chrome.tabs.create({ url: 'https://arena.ai' });
  });

  els.cancel.addEventListener('click', async () => {
    const tab = await activeArenaTab();
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { kind: 'cancel', reason: 'cancelled' }, () => void chrome.runtime.lastError);
      els.diagHint.textContent = 'cancelled the running capture';
    } else {
      els.diagHint.textContent = 'no arena.ai tab to cancel';
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.kind === 'bridge-state') refresh();
  });

  refresh();
  setInterval(refresh, 2000);
})();
