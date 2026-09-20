/**
 * ArenaAgentBridge - extensions/shared/i18n.js
 * ---------------------------------------------------------------------------
 * Tiny bilingual layer for the extension pages (popup + options).
 *
 * The bridge itself logs in English, but the *UI* is used by a human, so it
 * follows the browser language (and remembers an explicit choice in
 * `chrome.storage.local.aabLang`).  Persian is right-to-left, which is why the
 * pages set `dir` from here too.
 *
 * Usage in a page:
 *   <script src="i18n.js"></script>
 *   <h2 data-i18n="pop.status"></h2>       <- text is filled in for you
 *   t('pop.connected')                     <- or explicitly
 */
(function () {
  'use strict';

  const STRINGS = {
    en: {
      'app.name': 'ArenaAgentBridge',
      'tab.status': 'Status',
      'tab.test': 'Quick test',
      'tab.diagnose': 'Diagnose',
      'tab.settings': 'Settings',
      'pop.extension': 'extension',
      'pop.browser': 'browser',
      'pop.bridgeTab': 'bridge tab',
      'pop.server': 'server',
      'pop.pageHook': 'page hook',
      'pop.answered': 'answered',
      'pop.lastError': 'last error',
      'pop.connected': 'connected',
      'pop.busy': 'busy',
      'pop.waiting': 'waiting for a bridge tab',
      'pop.idle': 'idle',
      'pop.noTab': 'no arena.ai tab reported in yet',
      'pop.permissions': 'permissions',
      'pop.notGranted': 'not granted',
      'pop.grant': 'Grant permissions',
      'pop.grantHint': 'Firefox makes host permissions opt-in. Grant them once so the extension can reach 127.0.0.1:8000 and inject the optional stream hook.',
      'pop.reconnect': 'Reconnect',
      'pop.cancel': 'Cancel now',
      'pop.openSite': 'Open arena.ai',
      'pop.openPanel': 'Admin panel',
      'pop.advanced': 'Advanced settings',
      'pop.saveServer': 'Save & reconnect',
      'pop.serverUrl': 'server websocket url',
      'pop.diagnostics': 'diagnostics',
      'pop.runDiagnose': 'Diagnose DOM',
      'pop.copy': 'Copy',
      'pop.copied': 'Copied',
      'pop.testHint': 'Sends one prompt through the server (the same path your agents use). Requires the arena.ai tab to be open and logged in.',
      'pop.testPrompt': 'Reply with exactly: bridge ok',
      'pop.send': 'Send test',
      'pop.sending': 'sending…',
      'pop.answer': 'answer',
      'pop.timings': 'timings',
      'set.title': 'Extension settings',
      'set.intro': 'Overrides are stored in this browser and applied to the arena.ai tab (reload the tab if a change does not stick).',
      'set.connection': 'Connection',
      'set.automation': 'Automation & timing',
      'set.capture': 'Stream capture',
      'set.advanced': 'Advanced (raw JSON)',
      'set.save': 'Save',
      'set.saved': 'Saved',
      'set.reset': 'Reset to defaults',
      'set.resetDone': 'Defaults restored',
      'set.export': 'Export JSON',
      'set.import': 'Import JSON',
      'set.importError': 'Could not parse that JSON',
      'set.applied': 'Applied to open arena.ai tab(s)',
      'set.default': 'default',
      'set.serverUrlHint': 'Loopback only: ws://127.0.0.1:8000/ws/browser',
      'set.serverHttp': 'Server HTTP url',
      'set.serverHttpHint': 'Used by the tests and the "open admin panel" button.',
      'set.invalidUrl': 'Must be ws://127.0.0.1:8000/ws/browser or ws://localhost:8000/ws/browser',
      'set.openPanel': 'Open the admin panel',
      'set.options': 'Open the full options page',
      'set.language': 'Language',
      'set.theme': 'Theme',
    },
    fa: {
      'app.name': 'ArenaAgentBridge',
      'tab.status': 'وضعیت',
      'tab.test': 'آزمون سریع',
      'tab.diagnose': 'عیب‌یابی',
      'tab.settings': 'تنظیمات',
      'pop.extension': 'افزونه',
      'pop.browser': 'مرورگر',
      'pop.bridgeTab': 'تب پل',
      'pop.server': 'سرور',
      'pop.pageHook': 'هوک صفحه',
      'pop.answered': 'پاسخ‌ها',
      'pop.lastError': 'آخرین خطا',
      'pop.connected': 'متصل',
      'pop.busy': 'مشغول',
      'pop.waiting': 'در انتظار تب پل',
      'pop.idle': 'بی‌کار',
      'pop.noTab': 'هنوز تب arena.ai ثبت نشده',
      'pop.permissions': 'مجوزها',
      'pop.notGranted': 'داده نشده',
      'pop.grant': 'دادن مجوزها',
      'pop.grantHint': 'فایرفاکس مجوز میزبان را اختیاری کرده است. یک‌بار بدهید تا افزونه به 127.0.0.1:8000 برسد و هوک استریم را تزریق کند.',
      'pop.reconnect': 'اتصال دوباره',
      'pop.cancel': 'لغو فوری',
      'pop.openSite': 'بازکردن arena.ai',
      'pop.openPanel': 'پنل مدیریت',
      'pop.advanced': 'تنظیمات پیشرفته',
      'pop.saveServer': 'ذخیره و اتصال دوباره',
      'pop.serverUrl': 'آدرس وب‌سوکت سرور',
      'pop.diagnostics': 'عیب‌یابی',
      'pop.runDiagnose': 'عیب‌یابی DOM',
      'pop.copy': 'کپی',
      'pop.copied': 'کپی شد',
      'pop.testHint': 'یک پرامپت از همان مسیری که ایجنت‌ها استفاده می‌کنند می‌فرستد. تب arena.ai باید باز و وارد‌شده باشد.',
      'pop.testPrompt': 'دقیقاً این را جواب بده: bridge ok',
      'pop.send': 'ارسال آزمون',
      'pop.sending': 'در حال ارسال…',
      'pop.answer': 'پاسخ',
      'pop.timings': 'زمان‌ها',
      'set.title': 'تنظیمات افزونه',
      'set.intro': 'تغییرها در همین مرورگر ذخیره و روی تب arena.ai اعمال می‌شوند (در صورت نیاز تب را دوباره بارگذاری کنید).',
      'set.connection': 'اتصال',
      'set.automation': 'اتوماسیون و زمان‌بندی',
      'set.capture': 'ضبط استریم',
      'set.advanced': 'پیشرفته (JSON خام)',
      'set.save': 'ذخیره',
      'set.saved': 'ذخیره شد',
      'set.reset': 'بازنشانی به پیش‌فرض',
      'set.resetDone': 'پیش‌فرض‌ها بازگردانده شد',
      'set.export': 'خروجی JSON',
      'set.import': 'ورود JSON',
      'set.importError': 'این JSON خوانده نشد',
      'set.applied': 'روی تب‌های باز arena.ai اعمال شد',
      'set.default': 'پیش‌فرض',
      'set.serverUrlHint': 'فقط لوکال: ws://127.0.0.1:8000/ws/browser',
      'set.serverHttp': 'آدرس HTTP سرور',
      'set.serverHttpHint': 'برای تست‌ها و دکمهٔ «بازکردن پنل مدیریت» استفاده می‌شود.',
      'set.invalidUrl': 'باید ws://127.0.0.1:8000/ws/browser یا ws://localhost:8000/ws/browser باشد',
      'set.openPanel': 'بازکردن پنل مدیریت',
      'set.options': 'بازکردن صفحهٔ تنظیمات کامل',
      'set.language': 'زبان',
      'set.theme': 'پوسته',
    },
  };

  const LANG_KEY = 'aabLang';
  let current = null;

  function detect() {
    const nav = (typeof navigator !== 'undefined' && (navigator.language || navigator.userLanguage)) || 'en';
    return String(nav).toLowerCase().indexOf('fa') === 0 ? 'fa' : 'en';
  }

  function t(key, vars) {
    const lang = current || detect();
    const dict = STRINGS[lang] || STRINGS.en;
    let text = dict[key] !== undefined ? dict[key] : STRINGS.en[key] !== undefined ? STRINGS.en[key] : key;
    if (vars) {
      Object.keys(vars).forEach(function (name) {
        text = text.split('{' + name + '}').join(String(vars[name]));
      });
    }
    return text;
  }

  function apply(root) {
    const scope = root || document;
    Array.prototype.forEach.call(scope.querySelectorAll('[data-i18n]'), function (node) {
      node.textContent = t(node.dataset.i18n);
    });
    Array.prototype.forEach.call(scope.querySelectorAll('[data-i18n-placeholder]'), function (node) {
      node.setAttribute('placeholder', t(node.dataset.i18nPlaceholder));
    });
    document.documentElement.lang = current || detect();
    document.documentElement.dir = (current || detect()) === 'fa' ? 'rtl' : 'ltr';
  }

  function storageGet(key) {
    return new Promise(function (resolve) {
      try {
        const result = chrome.storage.local.get([key], function (data) {
          try {
            void chrome.runtime.lastError;
          } catch (_) {
            /* no runtime API in this context */
          }
          resolve((data && data[key]) || null);
        });
        if (result && typeof result.then === 'function') {
          result.then(function (data) { resolve((data && data[key]) || null); }, function () { resolve(null); });
        }
      } catch (error) {
        resolve(null);
      }
    });
  }

  function storageSet(payload) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.set(payload, function () {
          try {
            void chrome.runtime.lastError;
          } catch (_) {
            /* no runtime API in this context */
          }
          resolve(true);
        });
      } catch (error) {
        resolve(false);
      }
    });
  }

  /** Load the stored language (falls back to the browser language). */
  function load() {
    return storageGet(LANG_KEY).then(function (value) {
      current = value === 'fa' || value === 'en' ? value : detect();
      apply();
      return current;
    });
  }

  function setLang(lang) {
    current = lang === 'fa' ? 'fa' : 'en';
    apply();
    return storageSet({ [LANG_KEY]: current });
  }

  function toggle() {
    return setLang((current || detect()) === 'fa' ? 'en' : 'fa');
  }

  const API = {
    STRINGS: STRINGS,
    t: t,
    apply: apply,
    load: load,
    setLang: setLang,
    toggle: toggle,
    detect: detect,
    get lang() {
      return current || detect();
    },
    keys: Object.keys(STRINGS.en),
  };

  const glob = typeof window !== 'undefined' ? window : self;
  glob.__AAB_I18N__ = API;
})();
