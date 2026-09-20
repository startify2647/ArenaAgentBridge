/**
 * ArenaAgentBridge - extensions/shared/popup.js  (Chrome / Edge / Firefox)
 * ---------------------------------------------------------------------------
 * The popup used to be a status list with three buttons.  It is now a small
 * four-tab control centre:
 *
 *   Status      connection, bridge tab, page hook, permissions, actions
 *   Quick test  sends one prompt through the server (the same path agents use)
 *   Diagnose    the DOM diagnostics of the open arena.ai tab (+ copy)
 *   Settings    server URL, the most important thresholds, language, links
 *
 * Everything goes through the background worker (`chrome.runtime.sendMessage`)
 * and reads its state from `chrome.storage.session.aabState`; nothing here talks
 * to arena.ai, and the only network call is the explicit "Send test" button.
 */
(function () {
  'use strict';

  const CFG = window.__AAB_CONFIG__ || {};
  const T = window.__AAB_I18N__;
  const SETTINGS = window.__AAB_SETTINGS__;
  const IS_GECKO = typeof browser !== 'undefined' && Boolean(browser.runtime && browser.runtime.getBrowserInfo);
  const $ = (id) => document.getElementById(id);
  const t = (key, vars) => (T ? T.t(key, vars) : key);

  const els = {
    dot: $('dot'),
    version: $('version'),
    version2: $('version-2'),
    state: $('state'),
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
    wsUrl: $('ws-url'),
    serverUrl: $('server-url'),
    quickSettings: $('quick-settings'),
    testPrompt: $('test-prompt'),
    testOutput: $('test-output'),
    testStatus: $('test-status'),
    testTimings: $('test-timings'),
    diag: $('diag'),
  };

  const QUICK_PATHS = [
    'behavior.STABLE_MS',
    'behavior.RESET_BEFORE_REQUEST',
    'behavior.SHOW_BADGE',
    'capture.ENABLED',
  ];

  let lastState = null;

  // -------------------------------------------------------------------------
  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (reply) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(reply || null);
        });
      } catch (error) {
        resolve(null);
      }
    });
  }

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
      } catch (error) {
        resolve(null);
      }
    });
  }

  function setState(state, note) {
    const mapped = ['connected', 'busy', 'error', 'disconnected', 'standby'].indexOf(state) !== -1 ? state : 'idle';
    els.dot.className = 'dot ' + (mapped === 'connected' ? 'ok' : mapped === 'busy' ? 'busy' : mapped === 'error' || mapped === 'disconnected' ? 'bad' : '');
    els.state.textContent = note ? mapped + ' (' + note + ')' : mapped;
    els.state.className = 'v ' + (mapped === 'connected' ? 'ok' : mapped === 'busy' ? 'warn' : mapped === 'idle' ? 'muted' : 'bad');
  }

  function describeTab(tabs, ownerTab) {
    const ids = Object.keys(tabs || {});
    if (!ids.length) return t('pop.noTab');
    const owner = ownerTab === null || ownerTab === undefined ? null : String(ownerTab);
    return ids
      .map((id) => {
        const info = tabs[id];
        return `${owner !== null && id === owner ? '★ ' : ''}tab ${id}: ${info.state}${info.busy ? ' (busy)' : ''}`;
      })
      .join('\n');
  }

  // -------------------------------------------------------------------------
  async function refresh() {
    const [state, stored] = await Promise.all([send({ kind: 'popup-state' }), rememberedState()]);
    const source = stored || {};
    lastState = Object.assign({}, source, state || {});
    const permissions = (state && state.permissions) || source.permissions;
    const browserInfo = (state && state.browser) || source.browser;

    const ownerTab = state && state.owner ? state.owner.tabId : source.owner ? source.owner.tabId : null;
    const tabs = (state && state.tabs) || source.tabs || {};
    const ownerInfo = ownerTab !== null && tabs[ownerTab] ? tabs[ownerTab] : null;

    setState(ownerInfo ? ownerInfo.state || 'connected' : 'idle', ownerInfo ? null : t('pop.waiting'));
    els.version.textContent = 'v' + ((CFG && CFG.version) || chrome.runtime.getManifest().version);
    els.version2.textContent = (CFG && CFG.version) || chrome.runtime.getManifest().version;
    els.browser.textContent = IS_GECKO
      ? `firefox${browserInfo && browserInfo.version ? ' ' + browserInfo.version : ''}`
      : 'chromium';
    els.tabState.textContent = describeTab(tabs, ownerTab);
    els.tabState.className = 'v ' + (ownerInfo ? 'ok' : 'muted');
    els.serverVersion.textContent = (ownerInfo && ownerInfo.serverVersion) || source.serverVersion || '-';
    els.answered.textContent = String(source.answered || 0);

    const hook = source.pageHook;
    if (hook) {
      els.hook.textContent = hook.ready ? `active (${hook.source || 'injected'})` : 'DOM only';
      els.hook.className = 'v ' + (hook.ready ? 'ok' : 'muted');
    } else {
      els.hook.textContent = 'unknown';
      els.hook.className = 'v muted';
    }

    const lastError = (state && state.lastError) || source.lastError;
    els.errorRow.hidden = !lastError;
    if (lastError) els.lastError.textContent = String(lastError).slice(0, 200);

    const needsPermissions = Boolean(permissions && permissions.supported && !permissions.granted);
    els.permissionCard.hidden = !needsPermissions;

    const overrides = SETTINGS ? await SETTINGS.load() : {};
    const config = SETTINGS ? SETTINGS.apply(overrides, Object.assign({}, CFG)) : CFG;
    if (!els.serverUrl.value) els.serverUrl.value = config.SERVER_WS_URL || '';
    els.wsUrl.textContent = config.SERVER_WS_URL || '';
    renderQuickSettings(config, overrides);
  }

  function renderQuickSettings(config, overrides) {
    if (!SETTINGS || els.quickSettings.dataset.rendered === '1') return;
    els.quickSettings.dataset.rendered = '1';
    const rows = QUICK_PATHS.map((path) => {
      const field = SETTINGS.field(path);
      if (!field) return '';
      const value = SETTINGS.getPath(config, path);
      const label = (T && T.lang === 'fa' && field.label_fa) || field.label;
      if (field.type === 'bool') {
        return `<label class="check"><input type="checkbox" data-path="${path}"${value ? ' checked' : ''}> ${label}</label>`;
      }
      return `<label class="f"><span class="n">${label}</span><input type="number" data-path="${path}" value="${value}"></label>`;
    }).join('');
    els.quickSettings.innerHTML =
      rows +
      `<div class="buttons"><button class="action primary" id="save-quick">${t('set.save')}</button>` +
      `<button class="action" id="reset-quick">${t('set.reset')}</button></div>`;

    $('save-quick').addEventListener('click', async () => {
      const values = {};
      Array.prototype.forEach.call(els.quickSettings.querySelectorAll('[data-path]'), (input) => {
        values[input.dataset.path] = input.type === 'checkbox' ? input.checked : Number(input.value);
      });
      await SETTINGS.patch(values);
      await SETTINGS.notifyTabs();
      toastButton($('save-quick'), t('set.saved'));
      refresh();
    });
    $('reset-quick').addEventListener('click', async () => {
      await SETTINGS.reset();
      await SETTINGS.notifyTabs();
      els.quickSettings.dataset.rendered = '';
      els.quickSettings.innerHTML = '';
      window.location.reload();
    });
  }

  function toastButton(button, text) {
    const original = button.textContent;
    button.textContent = text;
    button.disabled = true;
    setTimeout(() => {
      button.textContent = original;
      button.disabled = false;
    }, 1400);
  }

  // -------------------------------------------------------------------------
  async function arenaTabs() {
    const byUrl = await new Promise((resolve) =>
      chrome.tabs.query({ url: ['https://arena.ai/*'] }, (tabs) => {
        void chrome.runtime.lastError;
        resolve(tabs || []);
      })
    );
    if (byUrl.length) return byUrl;
    const all = await new Promise((resolve) => chrome.tabs.query({}, (tabs) => resolve(tabs || [])));
    return all.filter((tab) => (tab.url || tab.pendingUrl || '').indexOf('arena.ai') !== -1);
  }

  async function activeArenaTab() {
    const tabs = await arenaTabs();
    if (!tabs.length) return null;
    return tabs.filter((tab) => tab.active)[0] || tabs[0];
  }

  function renderDiagnostics(payload) {
    if (!payload) {
      els.diag.textContent = 'no answer from the tab - is https://arena.ai open?';
      return;
    }
    const diag = payload.diag || {};
    const hook = diag.pageHook || {};
    const lines = [
      `state:   ${payload.state}${payload.busy ? ' (busy)' : ''}`,
      `browser: ${IS_GECKO ? 'firefox' : 'chromium'}`,
      `page:    ${diag.url || '?'}`,
      `title:   ${diag.title || '?'}`,
      '',
      'checks:',
      ...Object.entries(diag.checks || {}).map(([key, value]) => `  ${key}: ${value}`),
      '',
      'selector hits (0 = fix extensions/shared/config.js):',
      ...Object.entries(diag.selectorCounts || {}).map(([key, value]) => `  ${key}: ${value}`),
      '',
      `messages found: ${diag.messageCount}`,
      `last role:      ${diag.lastRole || '-'}`,
      `stream frames:  ${(diag.stream && diag.stream.frames) || 0} (chars: ${(diag.stream && diag.stream.mainChars) || 0})`,
      `page hook:      ${hook.ready ? `active (${hook.source || 'injected'})` : `inactive - ${hook.mode || '?'} injection, DOM-only capture`}`,
      '',
      'last message sample:',
      (diag.lastMessageSample || '-').replace(/^/gm, '  '),
    ];
    els.diag.textContent = lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // quick test: one real request through the server
  // -------------------------------------------------------------------------
  async function runTest() {
    const overrides = SETTINGS ? await SETTINGS.load() : {};
    const config = SETTINGS ? SETTINGS.apply(overrides, Object.assign({}, CFG)) : CFG;
    const base = SETTINGS ? SETTINGS.httpUrl(config) : 'http://127.0.0.1:8000';
    const stored = await new Promise((resolve) =>
      chrome.storage.local.get(['aabApiKey'], (data) => resolve((data && data.aabApiKey) || ''))
    );
    const prompt = els.testPrompt.value.trim() || 'Reply with exactly: bridge ok';
    const started = performance.now();
    els.testStatus.textContent = t('pop.sending');
    els.testStatus.className = 'k warn';
    els.testTimings.textContent = '';
    els.testOutput.textContent = '…';
    try {
      const response = await fetch(base + '/v1/chat/completions', {
        method: 'POST',
        headers: Object.assign(
          { 'Content-Type': 'application/json', 'X-Bridge-Source': 'test' },
          stored ? { Authorization: 'Bearer ' + stored } : {}
        ),
        body: JSON.stringify({
          model: (config.MODEL_ID || 'arena-agent'),
          stream: false,
          timeout: 180,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = (payload && payload.error) || {};
        throw new Error((detail.code ? detail.code + ': ' : '') + (detail.message || response.statusText));
      }
      const answer = ((payload.choices || [{}])[0].message || {}).content || '';
      const bridge = payload.x_bridge || {};
      els.testStatus.textContent = `${t('pop.answer')} · ${bridge.mode || '?'}`;
      els.testStatus.className = 'k ok';
      els.testTimings.textContent =
        `${Math.round(performance.now() - started)} ms · browser ${bridge.browser_duration_ms || '?'} ms` +
        (bridge.sanitized ? ` · sanitised (${(bridge.sanitize_findings || []).length})` : '');
      els.testOutput.textContent = answer || '(empty answer)';
    } catch (error) {
      els.testStatus.textContent = String(error && error.message ? error.message : error);
      els.testStatus.className = 'k bad';
      els.testOutput.textContent =
        'The test request failed.\n' +
        '• is the server running?  (./scripts/run.sh)\n' +
        '• is a browser tab attached?  curl ' + base + '/readyz\n' +
        (IS_GECKO ? '• Firefox: grant the loopback host permission from the Status tab\n' : '');
    }
  }

  // -------------------------------------------------------------------------
  // tabs
  // -------------------------------------------------------------------------
  function showTab(name) {
    Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), (button) => {
      button.setAttribute('aria-selected', String(button.dataset.tab === name));
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-pane]'), (pane) => {
      pane.hidden = pane.dataset.pane !== name;
    });
    try {
      chrome.storage.local.set({ aabTab: name }, () => void chrome.runtime.lastError);
    } catch (error) {
      /* ignore */
    }
  }

  // -------------------------------------------------------------------------
  // wiring
  // -------------------------------------------------------------------------
  els.grant.addEventListener('click', () => {
    const origins = [
      'http://127.0.0.1:8000/*',
      'http://localhost:8000/*',
      'https://arena.ai/*',
    ];
    const permissions = chrome.permissions;
    if (!permissions || !permissions.request) {
      els.diag.textContent = 'this browser does not expose chrome.permissions.request';
      return;
    }
    permissions.request({ origins }, async (granted) => {
      void chrome.runtime.lastError;
      if (!granted) {
        els.permissionState.textContent = 'denied';
        return;
      }
      await send({ kind: 'permissions-granted' });
      els.permissionCard.hidden = true;
      setTimeout(refresh, 600);
    });
  });

  $('reconnect').addEventListener('click', async () => {
    const tab = await activeArenaTab();
    if (tab) chrome.tabs.sendMessage(tab.id, { kind: 'reconnect' }, () => void chrome.runtime.lastError);
    await send({ kind: 'ensure-content' });
    setTimeout(refresh, 800);
  });

  $('save-server').addEventListener('click', async () => {
    const url = els.serverUrl.value.trim();
    const field = SETTINGS ? SETTINGS.field('SERVER_WS_URL') : null;
    const result = SETTINGS ? SETTINGS.validate(field, url) : { ok: /^ws:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/ws\/browser$/.test(url) };
    if (!result.ok) {
      els.serverUrl.value = '';
      els.diag.textContent = t('set.invalidUrl');
      alert(t('set.invalidUrl'));
      return;
    }
    await SETTINGS.patch({ SERVER_WS_URL: url });
    const tabs = await arenaTabs();
    tabs.forEach((tab) => chrome.tabs.sendMessage(tab.id, { kind: 'reconnect' }, () => void chrome.runtime.lastError));
    toastButton($('save-server'), t('set.saved'));
    setTimeout(refresh, 500);
  });

  $('open-tab').addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://arena.ai/agent' });
    window.close();
  });

  $('open-options').addEventListener('click', openOptions);
  $('open-options-2').addEventListener('click', openOptions);
  function openOptions() {
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
    else chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  }

  $('open-panel').addEventListener('click', async () => {
    const overrides = SETTINGS ? await SETTINGS.load() : {};
    const config = SETTINGS ? SETTINGS.apply(overrides, Object.assign({}, CFG)) : CFG;
    const base = SETTINGS ? SETTINGS.httpUrl(config) : 'http://127.0.0.1:8000';
    chrome.tabs.create({ url: base + '/admin' });
  });

  $('cancel').addEventListener('click', async () => {
    const tab = await activeArenaTab();
    if (tab) chrome.tabs.sendMessage(tab.id, { kind: 'cancel', reason: 'cancelled' }, () => void chrome.runtime.lastError);
    els.testStatus.textContent = t('pop.cancel');
  });

  $('diagnose').addEventListener('click', async () => {
    els.diag.textContent = '…';
    const tab = await activeArenaTab();
    if (!tab) {
      els.diag.textContent =
        'No arena.ai tab found.\n' +
        (IS_GECKO
          ? 'Open the site first; if it is open, grant permissions so the popup can see tab URLs.'
          : 'Open https://arena.ai and log in, then try again.');
      return;
    }
    chrome.tabs.sendMessage(tab.id, { kind: 'diagnose' }, (reply) => {
      if (chrome.runtime.lastError || !reply) {
        els.diag.textContent =
          `The content script is not running in tab ${tab.id} (page loaded before the extension?).\n` +
          'Reload the arena.ai tab, or press "Reconnect" to inject it again.';
        return;
      }
      renderDiagnostics(reply);
    });
  });

  $('run-test').addEventListener('click', runTest);
  $('copy-answer').addEventListener('click', () => copy(els.testOutput.textContent));
  $('copy-diag').addEventListener('click', () => copy(els.diag.textContent));
  $('lang-toggle').addEventListener('click', async () => {
    if (!T) return;
    await T.toggle();
    renderStaticLabels();
  });

  function copy(text) {
    try {
      navigator.clipboard.writeText(text).then(
        () => toastButton($('copy-answer'), t('pop.copied')),
        () => {}
      );
    } catch (error) {
      /* ignore */
    }
  }

  function renderStaticLabels() {
    if (T) T.apply();
    els.quickSettings.dataset.rendered = '';
    els.quickSettings.innerHTML = '';
  }

  Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), (button) => {
    button.addEventListener('click', () => showTab(button.dataset.tab));
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.kind === 'bridge-state') refresh();
  });

  // -------------------------------------------------------------------------
  async function boot() {
    if (T) await T.load();
    renderStaticLabels();
    try {
      const stored = await new Promise((resolve) =>
        chrome.storage.local.get(['aabTab'], (data) => resolve((data && data.aabTab) || 'status'))
      );
      showTab(stored);
    } catch (error) {
      showTab('status');
    }
    refresh();
    setInterval(() => {
      if (!document.hidden) refresh();
    }, 2000);
  }

  boot();
})();
