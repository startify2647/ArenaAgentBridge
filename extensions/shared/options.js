/**
 * ArenaAgentBridge - extensions/shared/options.js
 * ---------------------------------------------------------------------------
 * The extension's full-page options screen (`chrome://extensions` → Options,
 * or the popup's "Advanced settings" button).
 *
 * It renders itself from `__AAB_SETTINGS__.FIELDS`, validates every value with
 * the same rules the content script relies on, stores the result as a sparse
 * override object and pings the open arena.ai tabs so the change takes effect
 * without a reload.
 *
 * The only network calls are the two explicit buttons: "Test connection"
 * (`/healthz` + `/v1/bridge/status`) and "Open the admin panel" (a new tab).
 */
(function () {
  'use strict';

  const CFG = window.__AAB_CONFIG__ || {};
  const T = window.__AAB_I18N__;
  const SETTINGS = window.__AAB_SETTINGS__;
  const $ = (id) => document.getElementById(id);
  const t = (key, vars) => (T ? T.t(key, vars) : key);

  const STATE = { overrides: {}, config: {}, dirty: {} };

  function toast(message, kind) {
    const node = document.createElement('div');
    node.className = 'toast ' + (kind || '');
    node.textContent = message;
    $('toasts').appendChild(node);
    setTimeout(() => node.remove(), kind === 'bad' ? 6000 : 3000);
  }

  function storageGet(key) {
    return new Promise((resolve) =>
      chrome.storage.local.get([key], (data) => {
        void chrome.runtime.lastError;
        resolve((data && data[key]) || '');
      })
    );
  }

  function storageSet(payload) {
    return new Promise((resolve) =>
      chrome.storage.local.set(payload, () => {
        void chrome.runtime.lastError;
        resolve(true);
      })
    );
  }

  // -------------------------------------------------------------------------
  function fieldInput(field, value) {
    const path = field.path;
    const attrs = `data-path="${path}"`;
    if (field.type === 'bool') {
      return `<label class="check"><input type="checkbox" ${attrs}${value ? ' checked' : ''}> ${escapeHtml(label(field))}</label>` +
        `<span class="h">${escapeHtml(help(field))}</span>`;
    }
    if (field.type === 'enum') {
      const options = field.choices
        .map((choice) => `<option value="${choice}"${String(value) === choice ? ' selected' : ''}>${choice}</option>`)
        .join('');
      return `<label class="f"><span class="n">${escapeHtml(label(field))}</span><select ${attrs}>${options}</select>` +
        `<span class="h">${escapeHtml(help(field))} — default: <code>${escapeHtml(defaultOf(field))}</code></span></label>`;
    }
    if (field.type === 'int') {
      return `<label class="f"><span class="n">${escapeHtml(label(field))}</span>` +
        `<input type="number" ${attrs} value="${escapeHtml(value)}"` +
        `${field.min !== undefined ? ` min="${field.min}"` : ''}${field.max !== undefined ? ` max="${field.max}"` : ''}` +
        `${field.step ? ` step="${field.step}"` : ''}>` +
        `<span class="h">${escapeHtml(help(field))} — default: <code>${escapeHtml(defaultOf(field))}</code></span></label>`;
    }
    return `<label class="f"><span class="n">${escapeHtml(label(field))}</span>` +
      `<input type="text" ${attrs} value="${escapeHtml(value)}" spellcheck="false">` +
      `<span class="h">${escapeHtml(help(field))} — default: <code>${escapeHtml(defaultOf(field))}</code></span></label>`;
  }

  function label(field) {
    return T && T.lang === 'fa' && field.label_fa ? field.label_fa : field.label;
  }

  function help(field) {
    return T && T.lang === 'fa' && field.help_fa ? field.help_fa : field.help;
  }

  function defaultOf(field) {
    return SETTINGS.getPath(CFG, field.path);
  }

  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function renderFields() {
    const groups = { connection: [], automation: [], capture: [] };
    SETTINGS.FIELDS.forEach((field) => {
      if (!groups[field.group]) groups[field.group] = [];
      groups[field.group].push(field);
    });
    Object.keys(groups).forEach((group) => {
      const host = $('fields-' + group);
      if (!host) return;
      host.innerHTML = groups[group]
        .map((field) => `<div>${fieldInput(field, SETTINGS.getPath(STATE.config, field.path))}</div>`)
        .join('');
    });
  }

  // -------------------------------------------------------------------------
  function collect() {
    const values = {};
    const errors = [];
    Array.prototype.forEach.call(document.querySelectorAll('[data-path]'), (input) => {
      const path = input.dataset.path;
      const field = SETTINGS.field(path);
      if (!field) return;
      const raw = input.type === 'checkbox' ? input.checked : input.value;
      const result = SETTINGS.validate(field, raw);
      if (!result.ok) {
        errors.push(path + ': ' + result.error);
        input.style.borderColor = 'var(--bad)';
        return;
      }
      input.style.borderColor = '';
      values[path] = result.value;
      STATE.dirty[path] = true;
    });
    return { values, errors };
  }

  async function save() {
    const { values, errors } = collect();
    if (errors.length) {
      toast(errors.join(' · '), 'bad');
      return;
    }
    const overrides = Object.assign({}, STATE.overrides);
    Object.keys(values).forEach((path) => {
      const field = SETTINGS.field(path);
      const isDefault = JSON.stringify(values[path]) === JSON.stringify(SETTINGS.getPath(CFG, path));
      if (isDefault && !field) return;
      SETTINGS.setPath(overrides, path, values[path]);
    });
    STATE.overrides = overrides;
    await SETTINGS.save(overrides);
    const notified = await SETTINGS.notifyTabs();
    $('save-state').textContent = t('set.saved') + (notified ? ` · ${t('set.applied')} (${notified})` : '');
    toast(t('set.saved'), 'ok');
    await reload();
  }

  async function reload() {
    STATE.overrides = await SETTINGS.load();
    STATE.config = SETTINGS.apply(STATE.overrides, JSON.parse(JSON.stringify(CFG)));
    STATE.dirty = {};
    renderFields();
    $('raw-json').value = JSON.stringify(STATE.overrides, null, 2);
    await checkServer();
  }

  // -------------------------------------------------------------------------
  async function checkServer() {
    const base = SETTINGS.httpUrl(STATE.config);
    const pill = $('server-pill');
    const text = $('server-pill-text');
    try {
      const health = await fetch(base + '/healthz', { cache: 'no-store' });
      const payload = await health.json();
      const status = await fetch(base + '/v1/bridge/status', { cache: 'no-store' });
      const statusPayload = await status.json().catch(() => ({}));
      const connected = Boolean(statusPayload.browser && statusPayload.browser.connected);
      pill.className = 'pill ' + (connected ? 'ok' : 'warn');
      text.textContent = `server v${payload.version || '?'} · ${connected ? 'browser connected' : 'no browser'}`;
      $('test-result').textContent = connected
        ? 'bridge ready · an arena.ai tab is attached'
        : 'server reachable, but no arena.ai tab is attached yet';
      $('test-result').className = 'small ' + (connected ? 'ok' : 'warn');
    } catch (error) {
      pill.className = 'pill bad';
      text.textContent = 'server offline';
      $('test-result').textContent = 'cannot reach ' + base + ' — start it with ./scripts/run.sh';
      $('test-result').className = 'small bad';
    }
  }

  // -------------------------------------------------------------------------
  function wire() {
    $('version').textContent = (CFG && CFG.version) || chrome.runtime.getManifest().version;
    $('lang-toggle').addEventListener('click', async () => {
      if (!T) return;
      await T.toggle();
      T.apply();
      $('lang-toggle').textContent = T.lang === 'fa' ? 'English' : 'فارسی';
      renderFields();
    });

    $('save-all').addEventListener('click', save);

    $('reset-all').addEventListener('click', async () => {
      await SETTINGS.reset();
      await SETTINGS.notifyTabs();
      toast(t('set.resetDone'), 'ok');
      $('save-state').textContent = '';
      await reload();
      await storageSet({ aabApiKey: '' });
      $('api-key').value = '';
    });

    $('export-json').addEventListener('click', async () => {
      const text = await SETTINGS.exportJson();
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'arena-agent-bridge-extension-settings.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    });

    $('import-json').addEventListener('click', () => $('import-file').click());
    $('import-file').addEventListener('change', async (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      const text = await file.text();
      const parsed = SETTINGS.fromJson(text);
      if (!parsed.ok) {
        toast(t('set.importError') + ' — ' + parsed.error, 'bad');
        return;
      }
      await SETTINGS.save(parsed.overrides);
      await SETTINGS.notifyTabs();
      toast(t('set.saved') + (parsed.errors.length ? ` (${parsed.errors.join('; ')})` : ''), 'ok');
      await reload();
    });

    $('apply-raw').addEventListener('click', async () => {
      const parsed = SETTINGS.fromJson($('raw-json').value);
      if (!parsed.ok) {
        toast(t('set.importError') + ' — ' + parsed.error, 'bad');
        return;
      }
      await SETTINGS.save(parsed.overrides);
      await SETTINGS.notifyTabs();
      toast(t('set.saved'), 'ok');
      await reload();
    });

    $('test-connection').addEventListener('click', checkServer);

    async function openPanel() {
      const base = SETTINGS.httpUrl(STATE.config);
      chrome.tabs.create({ url: base + '/admin' });
    }
    $('open-panel').addEventListener('click', openPanel);
    $('open-panel-2').addEventListener('click', openPanel);

    $('api-key').addEventListener('change', async () => {
      await storageSet({ aabApiKey: $('api-key').value.trim() });
      toast('API key saved', 'ok');
    });

    const permissions = chrome.permissions;
    if (permissions && permissions.contains) {
      permissions.contains(
        { origins: ['http://127.0.0.1:8000/*', 'http://localhost:8000/*', 'https://arena.ai/*'] },
        (granted) => {
          void chrome.runtime.lastError;
          const card = $('card-permissions');
          card.hidden = false;
          $('permission-text').textContent = granted
            ? 'Host permissions granted — the extension can reach the loopback server.'
            : 'Firefox makes host permissions opt-in. Grant them so the bridge can talk to 127.0.0.1:8000.';
          $('grant-permissions').hidden = Boolean(granted);
        }
      );
      $('grant-permissions').addEventListener('click', () => {
        permissions.request(
          { origins: ['http://127.0.0.1:8000/*', 'http://localhost:8000/*', 'https://arena.ai/*'] },
          (granted) => {
            void chrome.runtime.lastError;
            toast(granted ? 'permissions granted' : 'permission denied', granted ? 'ok' : 'bad');
            if (granted) {
              $('card-permissions').hidden = true;
              checkServer();
            }
          }
        );
      });
    }
  }

  async function boot() {
    if (T) {
      await T.load();
      $('lang-toggle').textContent = T.lang === 'fa' ? 'English' : 'فارسی';
      T.apply();
    }
    wire();
    $('api-key').value = await storageGet('aabApiKey');
    await reload();
    setInterval(() => {
      if (!document.hidden) checkServer();
    }, 15000);
  }

  boot();
})();
