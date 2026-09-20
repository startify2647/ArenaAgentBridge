/**
 * ArenaAgentBridge - extensions/shared/settings.js
 * ---------------------------------------------------------------------------
 * The extension's settings layer, shared by the popup, the options page and the
 * content script (see the manifests: `config.js`, `settings.js`, `content.js`).
 *
 * `config.js` holds the *defaults*.  Everything a user changes in the popup or
 * the options page is stored as a sparse override object in
 * `chrome.storage.local.aabOverrides` and deep-merged into `__AAB_CONFIG__`:
 *
 *     __AAB_SETTINGS__.save({ SERVER_WS_URL: 'ws://127.0.0.1:8000/ws/browser' })
 *     __AAB_SETTINGS__.patch({ 'behavior.STABLE_MS': 4000 })   // dot paths
 *
 * The content script applies the overrides at boot and again whenever the
 * popup/options page pings the tab (`{kind: 'reload-settings'}`), so a change
 * does not require reloading arena.ai.
 *
 * Nothing here talks to the network: a settings page must work with the bridge
 * stopped, otherwise you could never fix a wrong server URL.
 */
(function () {
  'use strict';

  const glob = typeof window !== 'undefined' ? window : self;
  const CFG = glob.__AAB_CONFIG__ || {};

  const STORAGE_KEY = 'aabOverrides';
  //: kept in sync for backwards compatibility with the first release
  const LEGACY_SERVER_URL_KEY = 'serverUrl';

  /** What the UI is allowed to change, with validation metadata. */
  const FIELDS = [
    {
      path: 'SERVER_WS_URL', group: 'connection', type: 'url',
      label: 'Server websocket url', label_fa: 'آدرس وب‌سوکت سرور',
      help: 'Loopback only, e.g. ws://127.0.0.1:8000/ws/browser', help_fa: 'فقط لوکال، مثلاً ws://127.0.0.1:8000/ws/browser',
    },
    {
      path: 'SERVER_HTTP_URL', group: 'connection', type: 'url',
      label: 'Server http url', label_fa: 'آدرس HTTP سرور',
      help: 'Used for the "admin panel" button and the quick test.', help_fa: 'برای دکمهٔ پنل مدیریت و آزمون سریع.',
    },
    {
      path: 'TRANSPORT_MODE', group: 'connection', type: 'enum', choices: ['lease', 'direct'],
      label: 'Tab ownership', label_fa: 'مالکیت تب',
      help: 'lease = one tab owns the bridge, direct = every tab connects',
      help_fa: 'lease = یک تب مالک پل است، direct = هر تب خودش وصل می‌شود',
    },
    {
      path: 'behavior.STABLE_MS', group: 'automation', type: 'int', min: 500, max: 30000, step: 250,
      label: 'Answer stable time (ms)', label_fa: 'زمان پایداری پاسخ (ms)',
      help: 'Text unchanged for this long ⇒ the answer is finished.',
      help_fa: 'اگر متن این مدت تغییر نکند، پاسخ تمام‌شده در نظر گرفته می‌شود.',
    },
    {
      path: 'behavior.SSE_IDLE_MS', group: 'automation', type: 'int', min: 300, max: 15000, step: 100,
      label: 'Stream idle (ms)', label_fa: 'بی‌کاری استریم (ms)',
      help: 'Fast path: stream silent and text stable ⇒ finished.',
      help_fa: 'مسیر سریع: قطع شدن استریم و ثابت ماندن متن ⇒ پایان.',
    },
    {
      path: 'behavior.STALL_MS', group: 'automation', type: 'int', min: 5000, max: 300000, step: 1000,
      label: 'Stall timeout (ms)', label_fa: 'مهلت توقف (ms)',
      help: 'No growth but a Stop button is still there ⇒ return a partial answer.',
      help_fa: 'رشد نکردن متن با وجود دکمهٔ Stop ⇒ بازگرداندن پاسخ جزئی.',
    },
    {
      path: 'behavior.NO_OUTPUT_MS', group: 'automation', type: 'int', min: 5000, max: 600000, step: 1000,
      label: 'No output timeout (ms)', label_fa: 'مهلت بدون خروجی (ms)',
      help: 'Nothing at all after this long ⇒ error `no_output`.',
      help_fa: 'اگر هیچ خروجی نیاید ⇒ خطای `no_output`.',
    },
    {
      path: 'behavior.MAX_WAIT_MS', group: 'automation', type: 'int', min: 30000, max: 3600000, step: 10000,
      label: 'Hard per-request cap (ms)', label_fa: 'سقف سخت هر درخواست (ms)',
      help: 'Mirrors AAB_REQUEST_TIMEOUT on the server.',
      help_fa: 'معادل AAB_REQUEST_TIMEOUT در سرور.',
    },
    {
      path: 'behavior.INPUT_WAIT_MS', group: 'automation', type: 'int', min: 2000, max: 120000, step: 1000,
      label: 'Input wait (ms)', label_fa: 'انتظار برای کادر ورودی (ms)',
      help: 'How long to wait for the chat box after navigation.',
      help_fa: 'مدت انتظار برای ظاهر شدن کادر چت.',
    },
    {
      path: 'behavior.RESET_BEFORE_REQUEST', group: 'automation', type: 'bool',
      label: 'Reset chat before every request', label_fa: 'شروع چت تازه پیش از هر درخواست',
      help: 'Clean context, slower, avoids context limits.', help_fa: 'زمینهٔ پاک، کندتر، بدون محدودیت زمینه.',
    },
    {
      path: 'behavior.STOP_AFTER_CAPTURE', group: 'automation', type: 'bool',
      label: 'Stop generation after capture', label_fa: 'توقف تولید پس از ضبط',
      help: 'Leaves the tab idle for the next request.', help_fa: 'تب را برای درخواست بعدی بی‌کار می‌کند.',
    },
    {
      path: 'behavior.SHOW_BADGE', group: 'automation', type: 'bool',
      label: 'Show the on-page badge', label_fa: 'نمایش نشان روی صفحه',
      help: 'Bottom-right status badge inside arena.ai.', help_fa: 'نشان وضعیت گوشهٔ پایین صفحهٔ arena.ai.',
    },
    {
      path: 'capture.ENABLED', group: 'capture', type: 'bool',
      label: 'Use the site stream', label_fa: 'استفاده از استریم سایت',
      help: 'Reads the page WebSocket for faster completion detection.',
      help_fa: 'خواندن وب‌سوکت صفحه برای تشخیص سریع‌تر پایان.',
    },
    {
      path: 'capture.INJECTION', group: 'capture', type: 'enum', choices: ['manifest', 'runtime'],
      label: 'Hook injection', label_fa: 'روش تزریق هوک',
      help: 'manifest = browser injected, runtime = scripting.executeScript.',
      help_fa: 'manifest = توسط مرورگر، runtime = با scripting.executeScript.',
    },
    {
      path: 'capture.HOOK_TIMEOUT_MS', group: 'capture', type: 'int', min: 300, max: 20000, step: 100,
      label: 'Hook timeout (ms)', label_fa: 'مهلت هوک (ms)',
      help: 'How long the page-world hook may take to announce itself.',
      help_fa: 'مهلتی که هوک برای اعلام آمادگی دارد.',
    },
    {
      path: 'debug.VERBOSE', group: 'capture', type: 'bool',
      label: 'Verbose logging', label_fa: 'لاگ پرجزئیات',
      help: 'Logs to the page console (never the content of answers).',
      help_fa: 'لاگ در کنسول صفحه (هرگز متن پاسخ‌ها).',
    },
  ];

  const FIELD_BY_PATH = {};
  FIELDS.forEach(function (field) { FIELD_BY_PATH[field.path] = field; });

  // ---------------------------------------------------------------------------
  // storage helpers (callback + promise browsers)
  // ---------------------------------------------------------------------------
  /** `chrome.runtime.lastError` must be read (or the console complains) - but
   *  only when the API is actually there: this file also runs in tests. */
  function swallowLastError() {
    try {
      void chrome.runtime.lastError;
    } catch (error) {
      /* no runtime API in this context */
    }
  }

  function storageGet(keys) {
    return new Promise(function (resolve) {
      try {
        const result = chrome.storage.local.get(keys, function (data) {
          swallowLastError();
          resolve(data || {});
        });
        if (result && typeof result.then === 'function') {
          result.then(function (data) { resolve(data || {}); }, function () { resolve({}); });
        }
      } catch (error) {
        resolve({});
      }
    });
  }

  function storageSet(payload) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.set(payload, function () {
          swallowLastError();
          resolve(true);
        });
      } catch (error) {
        resolve(false);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // path helpers
  // ---------------------------------------------------------------------------
  function getPath(object, path) {
    return String(path).split('.').reduce(function (acc, part) {
      return acc && typeof acc === 'object' ? acc[part] : undefined;
    }, object);
  }

  function setPath(object, path, value) {
    const parts = String(path).split('.');
    let node = object;
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = value;
    return object;
  }

  function deletePath(object, path) {
    const parts = String(path).split('.');
    let node = object;
    for (let i = 0; i < parts.length - 1; i += 1) {
      node = node[parts[i]];
      if (!node || typeof node !== 'object') return object;
    }
    delete node[parts[parts.length - 1]];
    return object;
  }

  function deepMerge(base, override) {
    if (!override || typeof override !== 'object') return base;
    Object.keys(override).forEach(function (key) {
      const value = override[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const current = base[key] && typeof base[key] === 'object' ? base[key] : {};
        base[key] = deepMerge(current, value);
      } else if (value !== undefined) {
        base[key] = value;
      }
    });
    return base;
  }

  // ---------------------------------------------------------------------------
  // validation
  // ---------------------------------------------------------------------------
  const LOOPBACK_WS = /^ws:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/ws\/browser$/;

  function validate(field, value) {
    if (!field) return { ok: false, error: 'unknown setting' };
    switch (field.type) {
      case 'bool':
        return { ok: true, value: value === true || value === 'true' || value === 1 || value === '1' };
      case 'int': {
        const number = Number(value);
        if (!isFinite(number) || Math.floor(number) !== number) return { ok: false, error: 'must be a whole number' };
        if (field.min !== undefined && number < field.min) return { ok: false, error: 'must be >= ' + field.min };
        if (field.max !== undefined && number > field.max) return { ok: false, error: 'must be <= ' + field.max };
        return { ok: true, value: number };
      }
      case 'enum':
        return field.choices.indexOf(value) === -1
          ? { ok: false, error: 'must be one of: ' + field.choices.join(', ') }
          : { ok: true, value: value };
      case 'url': {
        const text = String(value || '').trim();
        if (field.path === 'SERVER_WS_URL') {
          // The bridge is local by design: refuse anything but loopback.
          return LOOPBACK_WS.test(text)
            ? { ok: true, value: text }
            : { ok: false, error: 'must be ws://127.0.0.1:8000/ws/browser (or localhost)' };
        }
        return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(text)
          ? { ok: true, value: text }
          : { ok: false, error: 'must be http://127.0.0.1:8000 (or localhost)' };
      }
      default:
        return { ok: true, value: String(value || '').trim() };
    }
  }

  // ---------------------------------------------------------------------------
  // public API
  // ---------------------------------------------------------------------------
  const API = {
    STORAGE_KEY: STORAGE_KEY,
    FIELDS: FIELDS,
    field: function (path) { return FIELD_BY_PATH[path] || null; },
    getPath: getPath,
    setPath: setPath,
    deletePath: deletePath,
    deepMerge: deepMerge,
    validate: validate,
    version: CFG.version || null,

    /** Raw overrides as stored (an empty object when nothing was changed). */
    load: function () {
      return storageGet([STORAGE_KEY, LEGACY_SERVER_URL_KEY]).then(function (data) {
        let overrides = (data && data[STORAGE_KEY]) || {};
        if (typeof overrides !== 'object' || Array.isArray(overrides)) overrides = {};
        const legacy = data && data[LEGACY_SERVER_URL_KEY];
        // `serverUrl` was the only knob in 1.1.0 - keep such installs working.
        if (legacy && LOOPBACK_WS.test(legacy) && overrides.SERVER_WS_URL === undefined) {
          overrides.SERVER_WS_URL = legacy;
        }
        return overrides;
      });
    },

    /** Replace the whole override object. */
    save: function (overrides) {
      const payload = overrides && typeof overrides === 'object' ? overrides : {};
      const sync = { [STORAGE_KEY]: payload };
      // keep the 1.1.0 key in sync (and clear it when the override is gone)
      sync[LEGACY_SERVER_URL_KEY] = typeof payload.SERVER_WS_URL === 'string' ? payload.SERVER_WS_URL : '';
      return storageSet(sync).then(function () { return payload; });
    },

    /**
     * Merge the given `path -> value` map into the stored overrides.
     *
     * Changing the websocket url also updates the derived HTTP url (used by the
     * admin-panel button and the quick test) unless the caller set it too.
     */
    patch: function (values) {
      const incoming = values || {};
      const input = Object.assign({}, incoming);
      if (input.SERVER_WS_URL && input.SERVER_HTTP_URL === undefined) {
        input.SERVER_HTTP_URL = String(input.SERVER_WS_URL).replace(/^ws/, 'http').replace(/\/ws\/browser$/, '');
      }
      return API.load().then(function (overrides) {
        Object.keys(input).forEach(function (path) {
          const raw = input[path];
          const field = FIELD_BY_PATH[path];
          const result = validate(field, raw);
          if (!result.ok) return;
          if (result.value === undefined || result.value === null) deletePath(overrides, path);
          else setPath(overrides, path, result.value);
        });
        return API.save(overrides);
      });
    },

    reset: function () {
      return API.save({}).then(function () { return {}; });
    },

    /**
     * Merge overrides into a config object (defaults: `__AAB_CONFIG__`).
     * Returns the same object so callers can chain.
     */
    apply: function (overrides, config) {
      const target = config || glob.__AAB_CONFIG__ || {};
      deepMerge(target, overrides && typeof overrides === 'object' ? overrides : {});
      return target;
    },

    /** Everything the settings UI needs: current value + default + field meta. */
    describe: function (config, overrides) {
      const target = config || glob.__AAB_CONFIG__ || {};
      const raw = overrides || {};
      return FIELDS.map(function (field) {
        return {
          field: field,
          value: getPath(target, field.path),
          explicit: getPath(raw, field.path),
          overridden: getPath(raw, field.path) !== undefined,
        };
      });
    },

    exportJson: function () {
      return API.load().then(function (overrides) {
        return JSON.stringify(
          { tool: 'ArenaAgentBridge', version: CFG.version || null, exported_at: new Date().toISOString(),
            overrides: overrides },
          null,
          2
        );
      });
    },

    /** Parse an exported blob: `{overrides: {…}}` or a bare override object.
     *  Both shapes are accepted: nested (`{behavior: {STABLE_MS: 1}}`, what we
     *  store) and flat dotted paths (`{'behavior.STABLE_MS': 1}`). */
    fromJson: function (text) {
      try {
        const parsed = JSON.parse(String(text || ''));
        const overrides = parsed && parsed.overrides ? parsed.overrides : parsed;
        if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
          return { ok: false, error: 'expected a JSON object' };
        }
        const flat = {};
        const walk = function (node, prefix) {
          Object.keys(node).forEach(function (key) {
            const path = prefix ? prefix + '.' + key : key;
            const value = node[key];
            if (value && typeof value === 'object' && !Array.isArray(value)) walk(value, path);
            else flat[path] = value;
          });
        };
        walk(overrides, '');

        const cleaned = {};
        const errors = [];
        Object.keys(flat).forEach(function (path) {
          const field = FIELD_BY_PATH[path];
          if (!field) {
            errors.push(path + ': unknown setting');
            return;
          }
          const result = validate(field, flat[path]);
          if (!result.ok) {
            errors.push(path + ': ' + result.error);
            return;
          }
          setPath(cleaned, path, result.value);
        });
        return { ok: true, overrides: cleaned, errors: errors };
      } catch (error) {
        return { ok: false, error: 'invalid JSON: ' + error.message };
      }
    },

    /** The HTTP base the panel/quick test should use. */
    httpUrl: function (config) {
      const target = config || glob.__AAB_CONFIG__ || {};
      const explicit = target.SERVER_HTTP_URL;
      if (explicit) return String(explicit).replace(/\/+$/, '');
      const ws = String(target.SERVER_WS_URL || 'ws://127.0.0.1:8000/ws/browser');
      return ws.replace(/^ws/, 'http').replace(/\/ws\/browser$/, '');
    },

    /** Tell every open arena.ai tab to re-read the stored overrides. */
    notifyTabs: function () {
      return new Promise(function (resolve) {
        try {
          chrome.tabs.query({ url: ['https://arena.ai/*'] }, function (tabs) {
            swallowLastError();
            const list = tabs || [];
            let notified = 0;
            list.forEach(function (tab) {
              try {
                chrome.tabs.sendMessage(tab.id, { kind: 'reload-settings' }, function () {
                  swallowLastError();
                });
                notified += 1;
              } catch (error) {
                /* tab without a content script */
              }
            });
            resolve(notified);
          });
        } catch (error) {
          resolve(0);
        }
      });
    },
  };

  glob.__AAB_SETTINGS__ = API;
})();
