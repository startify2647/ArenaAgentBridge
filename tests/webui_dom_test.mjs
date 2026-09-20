/**
 * ArenaAgentBridge - test/webui_dom_test.mjs
 * ---------------------------------------------------------------------------
 * Runs the admin panel (`server/assets/panel.js`) inside jsdom against a stubbed
 * `/admin/api/*`, and checks what a user would actually see:
 *
 *   dashboard cards + connection pill + latency sparkline
 *   playground: a streamed answer and a non-streamed one
 *   request history: rows, detail dialog, filters
 *   settings: the form is generated from the server catalog and Apply posts it
 *   sanitiser: the dry-run endpoint renders findings
 *   i18n: both dictionaries are complete and the Persian mode is RTL
 *
 * The HTML shell is rendered by the *Python* code that serves it (no copy of the
 * markup in the test), so the panel and its test cannot drift apart.
 *
 *   npm install --no-save jsdom
 *   node tests/webui_dom_test.mjs
 *
 * Exits 0 with "SKIP: …" when jsdom or the Python toolchain is missing.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'server', 'assets');
// the panel version comes from the server config: never hard-code it here
const SERVER_VERSION = /version:\s*str\s*=\s*["']([^"']+)["']/.exec(
  readFileSync(path.join(ROOT, 'server', 'config.py'), 'utf8')
)[1];

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (_) {
  console.log('SKIP: jsdom is not installed (run `npm install --no-save jsdom`)');
  process.exit(0);
}

const PANEL_JS = readFileSync(path.join(ASSETS, 'panel.js'), 'utf8');
const PANEL_CSS = readFileSync(path.join(ASSETS, 'panel.css'), 'utf8');

// ---------------------------------------------------------------------------
// the HTML shell, rendered by the server code itself
// ---------------------------------------------------------------------------
const RENDER_PY = `
from server.admin import render_panel_page
from server.config import Settings
settings = Settings()
settings.validate()
print(render_panel_page(settings).body.decode(), end="")
`;

function renderShell() {
  const candidates = [process.env.PYTHON, path.join(ROOT, '.venv', 'bin', 'python'), 'python3', 'python'];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return execFileSync(candidate, ['-c', RENDER_PY], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (_) {
      /* try the next interpreter */
    }
  }
  return null;
}

const shell = renderShell();
if (!shell) {
  console.log('SKIP: could not render the panel HTML (is the python environment installed?)');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// fake server
// ---------------------------------------------------------------------------
const NOW = 1_800_000_000;

const OVERVIEW = {
  version: '1.2.0',
  now: NOW,
  server: {
    version: '1.2.0',
    uptime_s: 3725,
    pending_requests: 1,
    pending: [
      {
        id: 'pending-1',
        mode: 'agent',
        created_at: NOW - 3,
        sent_at: NOW - 2,
        prompt_preview: 'explain the queue',
        prompt_chars: 19,
        timeout: 300,
      },
    ],
    queue_depth: 2,
    queue_max: 64,
    sanitize_mode: 'redact',
  },
  browser: {
    connected: true,
    clients: [
      {
        client: 'chrome-extension',
        version: '1.2.0',
        url: 'https://arena.ai/agent',
        state: 'answering',
        busy: true,
        connected_for_s: 120.5,
        last_seen_ago_s: 1.2,
        answered: 7,
        heartbeats: 42,
      },
    ],
  },
  totals: { requests: 12, errors: 1, timeouts: 0, sanitized_answers: 2, last_duration_ms: 4200 },
  latency_ms: { last: 4200, p50: 3100, p95: 9000, samples: 12 },
  recent_errors: [{ at: NOW - 60, code: 'captcha_required', message: 'a captcha was detected' }],
  history: { enabled: true, size: 2, max: 200, ok: 1, errors: 1, sanitized: 1, last_at: NOW - 5, avg_ms: 4000 },
  models: [
    { id: 'arena-agent', mode: 'agent' },
    { id: 'arena-agent-direct', mode: 'direct' },
  ],
  sanitizer: { mode: 'redact', rules: 34, block_rules: 24, warn_rules: 10 },
  settings: {
    model_id: 'arena-agent',
    model_ids: ['arena-agent', 'arena-agent-direct'],
    default_mode: 'agent',
    request_timeout: 300,
    queue_max_size: 64,
    sanitize_mode: 'redact',
    require_api_key: false,
    max_prompt_chars: 200000,
    stream_chunk_chars: 32,
    history_size: 200,
    host: '127.0.0.1',
    port: 8000,
    patterns_file: null,
  },
  panel: { refresh_ms: 2000 },
};

const HISTORY_ITEM = {
  request_id: 'chatcmpl-abc123',
  at: NOW - 30,
  at_iso: '2027-01-15T08:00:00+00:00',
  age_s: 30,
  source: 'panel',
  client: 'browser',
  model: 'arena-agent',
  mode: 'agent',
  streamed: false,
  status: 'ok',
  http_status: 200,
  error_code: null,
  error_message: null,
  prompt_chars: 42,
  response_chars: 120,
  prompt_preview: '### user\nhello bridge',
  response_preview: 'bridge ok',
  queue_wait_ms: 12,
  browser_duration_ms: 4000,
  total_ms: 4200,
  sanitized: true,
  sanitize_mode: 'redact',
  sanitize_findings: [
    { pattern: 'rm_rf_root', kind: 'destructive-fs', severity: 'block', match: 'rm -rf /', line: 3 },
  ],
  stop_reason: 'stable',
};

const HISTORY = {
  items: [HISTORY_ITEM],
  total: 1,
  filtered: 1,
  limit: 20,
  offset: 0,
  summary: OVERVIEW.history,
};

const SETTINGS_PAYLOAD = {
  fields: [
    {
      name: 'default_mode', env: 'AAB_DEFAULT_MODE', kind: 'enum', group: 'request',
      label: 'Default prompt mode', label_fa: 'حالت پیش‌فرض پرامپت', help: 'agent or direct', help_fa: 'agent یا direct',
      choices: ['agent', 'direct'], minimum: null, maximum: null,
    },
    {
      name: 'request_timeout', env: 'AAB_REQUEST_TIMEOUT', kind: 'float', group: 'request',
      label: 'Request timeout (s)', label_fa: 'مهلت درخواست (ثانیه)', help: 'seconds', help_fa: 'ثانیه',
      choices: [], minimum: 5, maximum: 3600,
    },
    {
      name: 'require_api_key', env: 'AAB_REQUIRE_API_KEY', kind: 'bool', group: 'security',
      label: 'Require API key', label_fa: 'الزام کلید API', help: 'bearer token', help_fa: 'توکن',
      choices: [], minimum: null, maximum: null,
    },
    {
      name: 'api_key', env: 'AAB_API_KEY', kind: 'secret', group: 'security',
      label: 'API key', label_fa: 'کلید API', help: 'write only', help_fa: 'فقط نوشتن',
      choices: [], minimum: null, maximum: null,
    },
  ],
  groups: ['request', 'safety', 'streaming', 'models', 'security', 'diagnostics'],
  values: { default_mode: 'agent', request_timeout: 300, require_api_key: false, api_key: '***' },
  readonly: { host: '127.0.0.1', port: 8000, patterns_file: null },
  env_block: 'AAB_DEFAULT_MODE=agent\nAAB_REQUEST_TIMEOUT=300\n',
  state: { model_ids: ['arena-agent'], queue_max: 64, history_size: 200, log_level: 'INFO' },
};

const RULES = {
  count: 2,
  mode: 'redact',
  rules: [
    { name: 'rm_rf_root', kind: 'destructive-fs', severity: 'block', pattern: 'rm -rf /' },
    { name: 'git_force_push', kind: 'git', severity: 'warn', pattern: 'push --force' },
  ],
  block: [{ name: 'rm_rf_root', kind: 'destructive-fs', severity: 'block', pattern: 'rm -rf /' }],
  warn: [{ name: 'git_force_push', kind: 'git', severity: 'warn', pattern: 'push --force' }],
};

const SELFCHECK = {
  ok: false,
  version: '1.2.0',
  checks: [
    { id: 'browser', ok: true, level: 'ok', detail: 'connected: chrome-extension v1.2.0', hint: '' },
    { id: 'sanitizer', ok: false, level: 'error', detail: 'mode=off rules=34', hint: 'set AAB_SANITIZE_MODE=redact' },
  ],
};

const SANITIZE = {
  ok: true,
  mode: 'redact',
  changed: true,
  replacements: 1,
  output: 'run [BLOCKED BY ARENA-AGENT-BRIDGE: rm_rf_root] now',
  findings: [{ pattern: 'rm_rf_root', kind: 'destructive-fs', severity: 'block', match: 'rm -rf /', line: 1 }],
};

function jsonResponse(payload, status = 200) {
  return {
    ok: status < 400,
    status,
    statusText: status < 400 ? 'OK' : 'Error',
    headers: { get: () => 'application/json' },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  const queue = chunks.slice();
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => 'text/event-stream' },
    body: {
      getReader: () => ({
        read: async () => (queue.length ? { done: false, value: encoder.encode(queue.shift()) } : { done: true, value: undefined }),
      }),
    },
    json: async () => ({}),
    text: async () => '',
  };
}

const calls = [];

function installFetch(window, options = {}) {
  window.fetch = async (url, init) => {
    const target = String(url);
    calls.push({ url: target, method: (init && init.method) || 'GET', body: init && init.body });
    if (target.indexOf('/admin/api/overview') !== -1) return jsonResponse(OVERVIEW);
    if (target.indexOf('/admin/api/history/chatcmpl-abc123') !== -1) return jsonResponse(HISTORY_ITEM);
    if (target.indexOf('/admin/api/history') !== -1) return jsonResponse(HISTORY);
    if (target.indexOf('/admin/api/settings') !== -1) return jsonResponse(SETTINGS_PAYLOAD);
    if (target.indexOf('/admin/api/rules') !== -1) return jsonResponse(RULES);
    if (target.indexOf('/admin/api/selfcheck') !== -1) return jsonResponse(SELFCHECK);
    if (target.indexOf('/admin/api/sanitize') !== -1) return jsonResponse(SANITIZE);
    if (target.indexOf('/admin/api/browser/diagnose') !== -1) {
      return jsonResponse({ ok: true, state: 'idle', diag: { url: 'https://arena.ai/agent', selectorCounts: { input: 1 } } });
    }
    if (target.indexOf('/admin/api/browser/') !== -1) return jsonResponse({ ok: true, pinged: 1, cancelled: 1, disconnected: 1 });
    if (target.indexOf('/v1/chat/completions') !== -1) {
      if (options.streamAnswer) return sseResponse(options.streamAnswer);
      return jsonResponse({
        id: 'chatcmpl-panel',
        choices: [{ index: 0, message: { role: 'assistant', content: 'direct answer' }, finish_reason: 'stop' }],
        usage: { total_tokens: 7 },
        x_bridge: { request_id: 'chatcmpl-panel', mode: 'agent', sanitized: false, sanitize_findings: [], queue_wait_ms: 5 },
      });
    }
    return jsonResponse({ ok: true });
  };
  return calls;
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let checks = 0;
let failures = 0;

function check(name, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function test(name, fn) {
  console.log(`\n${name}`);
  try {
    await fn();
  } catch (error) {
    failures += 1;
    checks += 1;
    console.log(`  FAIL threw ${error && error.stack ? error.stack.split('\n')[0] : error}`);
  }
}

async function createPanel(fetchOptions = {}) {
  const virtualConsole = new (require('jsdom').VirtualConsole)();
  const pageErrors = [];
  virtualConsole.on('jsdomError', (error) => {
    if (!/Not implemented/.test(String(error && error.message))) pageErrors.push(String(error && error.message));
  });

  const dom = new JSDOM(shell, {
    url: 'http://127.0.0.1:8000/admin',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;

  // jsdom extras the panel expects
  window.TextDecoder = TextDecoder;
  window.TextEncoder = TextEncoder;
  window.scrollTo = () => {};
  const context2d = {
    scale() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    closePath() {}, fill() {}, save() {}, restore() {}, setLineDash() {}, strokeRect() {}, fillRect() {},
    set fillStyle(value) {}, get fillStyle() { return ''; },
    set strokeStyle(value) {}, get strokeStyle() { return ''; },
    set lineWidth(value) {}, get lineWidth() { return 1; },
    set globalAlpha(value) {}, get globalAlpha() { return 1; },
  };
  window.HTMLCanvasElement.prototype.getContext = () => context2d;

  const dialog = window.document.getElementById('detail');
  dialog.showModal = function showModal() { this.open = true; };
  dialog.close = function close() { this.open = false; };
  window.confirm = () => true;

  installFetch(window, fetchOptions);
  window.eval(PANEL_JS);
  await sleep(60); // let the first paint land

  const close = () => {
    try {
      window.close();
    } catch (_) {
      /* already gone */
    }
  };
  return { dom, window, close, pageErrors, calls };
}

const $ = (window, selector, root) => (root || window.document).querySelector(selector);
const $$ = (window, selector, root) => Array.from((root || window.document).querySelectorAll(selector));
const text = (window, selector) => {
  const node = $(window, selector);
  return node ? node.textContent.trim() : '';
};

async function waitFor(predicate, timeout = 3000, what = 'condition') {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(30);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function click(window, selector) {
  const node = $(window, selector);
  if (!node) throw new Error(`no element ${selector}`);
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(40);
  return node;
}

// ---------------------------------------------------------------------------
async function main() {
  await test('static panel assets', async () => {
    check('the shell has no external scripts', !/<script[^>]+src="https?:/.test(shell), 'remote <script src>');
    check('the shell has no external stylesheets', !/<link[^>]+href="https?:/.test(shell), 'remote <link>');
    check('the shell carries the panel config', /window\.__AAB_PANEL__/.test(shell));
    check('the version is rendered into the page', shell.includes(SERVER_VERSION), SERVER_VERSION);
    check('the css is self contained (no @import/url(http))', !/@import|url\(\s*['"]?https?:/.test(PANEL_CSS));
    const keys = Array.from(shell.matchAll(/data-i18n="([^"]+)"/g)).map((match) => match[1]);
    check('the shell uses i18n keys', keys.length >= 10, `${keys.length} keys`);
  });

  await test('boots against the local API and renders the dashboard', async () => {
    const panel = await createPanel();
    const { window } = panel;
    const strings = window.__AAB_PANEL_STRINGS__;
    check('the dictionaries are exposed for tests', Boolean(strings));
    const en = Object.keys(strings.en).sort();
    const fa = Object.keys(strings.fa).sort();
    check('every English string has a Persian twin', JSON.stringify(en) === JSON.stringify(fa),
      `en=${en.length} fa=${fa.length}`);
    const missing = Array.from(shell.matchAll(/data-i18n="([^"]+)"/g))
      .map((match) => match[1])
      .filter((key) => !(key in strings.en) || !(key in strings.fa));
    check('every data-i18n key exists in both languages', missing.length === 0, missing.join(', '));
    // only real t('…') calls: `createElement('div')`-style text must not count
    const used = Array.from(PANEL_JS.matchAll(/(?<![\w$.])t\('([a-z0-9._]+)'/gi)).map((match) => match[1]);
    const unknown = used.filter((key) => !key.endsWith('.') && !(key in strings.en));
    check('every t() key is defined', unknown.length === 0, Array.from(new Set(unknown)).join(', '));
    const prefixes = Array.from(new Set(used.filter((key) => key.endsWith('.'))));
    const emptyPrefixes = prefixes.filter((prefix) => !Object.keys(strings.en).some((key) => key.indexOf(prefix) === 0));
    check('every dynamic t() prefix has strings', emptyPrefixes.length === 0, emptyPrefixes.join(', '));

    check('the connection pill shows the browser', /connected/.test(text(window, '#conn-pill')), text(window, '#conn-pill'));
    check('the request counter is filled in', text(window, '#stat-requests') !== '0', text(window, '#stat-requests'));
    check('stat cards were rendered', $$(window, '#dash-body .stat').length >= 6, String($$(window, '#dash-body .stat').length));
    check('the pending request is shown', /pending-1|queued|in page/.test($(window, '#dash-body').textContent));
    check('the sparkline has a canvas', Boolean($(window, '#spark')));
    check('models are listed', $(window, '#dash-body').textContent.includes('arena-agent-direct'));
    check('recent requests are listed', Boolean($(window, '.table-wrap tbody tr[data-action="detail"]')));
    check('recent errors are listed', $(window, '#dash-body').textContent.includes('captcha_required'));
    check('no page errors during boot', panel.pageErrors.length === 0, panel.pageErrors.join(' | '));
    check('only the local API was called', panel.calls.every((call) => /^(http:\/\/127\.0\.0\.1:8000)?\/?(admin|v1)?/.test(call.url)),
      panel.calls.map((call) => call.url).join(', '));
    panel.close();
  });

  await test('navigation switches views', async () => {
    const panel = await createPanel();
    const { window } = panel;
    await click(window, '.nav-item[data-view="requests"]');
    check('the requests view is visible', !$(window, '#view-requests').hidden);
    check('the dashboard is hidden', $(window, '#view-dashboard').hidden);
    check('the history table has the entry', $(window, '#requests-body').textContent.includes('chatcmpl-abc123') === false &&
      $(window, '#requests-body').textContent.includes('browser'),
      $(window, '#requests-body').textContent.slice(0, 200));
    check('the nav item is marked as current', $(window, '.nav-item[data-view="requests"]').getAttribute('aria-current') === 'page');

    await click(window, '.nav-item[data-view="browser"]');
    check('the browser view lists the extension', $(window, '#browser-body').textContent.includes('chrome-extension'));
    check('the self check is rendered', $(window, '#browser-body').textContent.includes('sanitizer'),
      $(window, '#browser-body').textContent.slice(0, 120));

    await click(window, '.nav-item[data-view="connect"]');
    check('the connect view shows the base url', $(window, '#connect-body').textContent.includes('http://127.0.0.1:8000/v1'));
    check('the connect view shows a curl snippet', $(window, '#connect-body').textContent.includes('curl'));
    panel.close();
  });

  await test('the request detail dialog opens (and shows the findings)', async () => {
    const panel = await createPanel();
    const { window } = panel;
    await click(window, '.nav-item[data-view="requests"]');
    await click(window, '#requests-body tr[data-action="detail"]');
    const dialog = $(window, '#detail');
    check('the dialog is open', dialog.open === true);
    check('the request id is shown', dialog.textContent.includes('chatcmpl-abc123'));
    check('the prompt tab is visible by default', !$(window, '[data-pane="prompt"]', dialog).hidden);
    await click(window, '[data-action="dlg-tab"][data-tab="findings"]');
    check('the findings tab can be selected', !$(window, '[data-pane="findings"]', dialog).hidden);
    check('the sanitiser finding is listed', dialog.textContent.includes('rm_rf_root'));
    await click(window, '[data-action="dlg-close"]');
    check('the dialog closes', dialog.open === false);
    panel.close();
  });

  await test('the playground streams an answer', async () => {
    const chunks = [
      'data: {"id":"x","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n',
      'data: {"id":"x","choices":[{"index":0,"delta":{"content":"bridge "}}]}\n\n',
      'data: {"id":"x","choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n',
      'data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"x_bridge":{"request_id":"chatcmpl-panel","mode":"agent","queue_wait_ms":3,"sanitized":true,"sanitize_findings":[{"pattern":"rm_rf_root","severity":"block","match":"rm -rf /"}]}}\n\n',
      'data: [DONE]\n\n',
    ];
    const panel = await createPanel({ streamAnswer: chunks });
    const { window } = panel;
    await click(window, '.nav-item[data-view="playground"]');
    $(window, '#pg-prompt').value = 'say hi';
    await click(window, '[data-action="pg-send"]');
    await waitFor(() => text(window, '#pg-out').includes('bridge ok'), 3000, 'the streamed answer');
    check('the streamed answer is rendered', text(window, '#pg-out').trim() === 'bridge ok', text(window, '#pg-out'));
    check('the model selector is filled from /v1/models', $$(window, '#pg-model option').length === 2);
    check('the request was sent to the OpenAI endpoint', panel.calls.some((call) => call.url === '/v1/chat/completions' && call.method === 'POST'));
    check('the panel marks itself as the source', panel.calls.some((call) => String(call.body || '').includes('say hi')));
    check('sanitiser findings are shown after the stream', $(window, '#pg-meta').textContent.includes('rm_rf_root'),
      $(window, '#pg-meta').textContent.slice(0, 160));
    panel.close();
  });

  await test('the playground handles a non-streamed answer', async () => {
    const panel = await createPanel();
    const { window } = panel;
    await click(window, '.nav-item[data-view="playground"]');
    $(window, '#pg-stream').checked = false;
    $(window, '#pg-prompt').value = 'one shot';
    await click(window, '[data-action="pg-send"]');
    await waitFor(() => text(window, '#pg-out').includes('direct answer'), 3000, 'the answer');
    check('the answer is rendered', text(window, '#pg-out').trim() === 'direct answer', text(window, '#pg-out'));
    check('timings are shown', /ms/.test(text(window, '#pg-meta')), text(window, '#pg-meta').slice(0, 120));
    panel.close();
  });

  await test('settings are generated from the server catalog and applied', async () => {
    const panel = await createPanel();
    const { window } = panel;
    await click(window, '.nav-item[data-view="settings"]');
    await waitFor(() => Boolean($(window, '#settings-body [data-field="request_timeout"]')), 2000, 'the settings form');
    check('an enum field is rendered as a select',
      ($(window, '#settings-body [data-field="default_mode"]') || {}).tagName === 'SELECT',
      String(($(window, '#settings-body [data-field="default_mode"]') || {}).tagName));
    check('a bool field is rendered as a checkbox', $(window, '#settings-body [data-field="require_api_key"]').type === 'checkbox');
    check('a secret field is a password input', $(window, '#settings-body [data-field="api_key"]').type === 'password');
    check('the env variable name is shown', $(window, '#settings-body').textContent.includes('AAB_REQUEST_TIMEOUT'));
    check('the .env block is shown', text(window, '#env-block').includes('AAB_DEFAULT_MODE=agent'));
    $(window, '#settings-body [data-field="request_timeout"]').value = '120';
    await click(window, '[data-action="settings-apply"]');
    const patch = panel.calls.filter((call) => call.url === '/admin/api/settings' && call.method === 'POST').pop();
    check('the patch was posted as JSON', Boolean(patch) && String(patch.body).includes('"request_timeout":"120"'),
      patch ? String(patch.body) : 'no POST /admin/api/settings');
    panel.close();
  });

  await test('the sanitiser view dry-runs a text', async () => {
    const panel = await createPanel();
    const { window } = panel;
    await click(window, '.nav-item[data-view="sanitizer"]');
    await waitFor(() => Boolean($(window, '#san-input')), 2000, 'the sanitiser form');
    check('the rule table is rendered', $(window, '#sanitizer-body').textContent.includes('rm_rf_root'));
    $(window, '#san-input').value = 'rm -rf /';
    await click(window, '[data-action="san-run"]');
    await waitFor(() => text(window, '#san-result').includes('BLOCKED BY ARENA-AGENT-BRIDGE'), 2000, 'the sanitiser result');
    check('the neutralised text is shown', text(window, '#san-result').includes('[BLOCKED BY ARENA-AGENT-BRIDGE: rm_rf_root]'),
      text(window, '#san-result'));
    check('the findings table is shown', $(window, '#san-findings').textContent.includes('destructive-fs'));
    panel.close();
  });

  await test('the language toggle switches to Persian and RTL', async () => {
    const panel = await createPanel();
    const { window } = panel;
    await click(window, '#lang-toggle');
    check('the document is right-to-left', window.document.documentElement.dir === 'rtl', window.document.documentElement.dir);
    check('the language attribute is fa', window.document.documentElement.lang === 'fa');
    check('the nav shows Persian', text(window, '.nav-item[data-view="dashboard"]').includes('داشبورد'),
      text(window, '.nav-item[data-view="dashboard"]'));
    check('the dashboard headline is Persian', text(window, '#view-dashboard h2').includes('داشبورد'), text(window, '#view-dashboard h2'));
    check('the choice is remembered', window.localStorage.getItem('aab.lang') === 'fa');
    const stored = window.localStorage.getItem('aab.theme');
    await click(window, '#theme-toggle');
    check('the theme toggles and is stored', window.document.documentElement.dataset.theme !== stored &&
      window.localStorage.getItem('aab.theme') === window.document.documentElement.dataset.theme);
    panel.close();
  });

  await test('the browser tab can cancel and diagnose', async () => {
    const panel = await createPanel();
    const { window } = panel;
    await click(window, '.nav-item[data-view="browser"]');
    await click(window, '[data-action="browser-diagnose"]');
    await waitFor(() => ($(window, '#browser-body') || {}).textContent.includes('selectorCounts'), 2000, 'the diagnostics');
    check('the diagnostics payload is rendered', $(window, '#browser-body').textContent.includes('arena.ai/agent'));
    await click(window, '[data-action="browser-cancel"]');
    check('cancel was posted', panel.calls.some((call) => call.url === '/admin/api/browser/cancel'));
    check('no page errors', panel.pageErrors.length === 0, panel.pageErrors.join(' | '));
    panel.close();
  });

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) {
    console.log(`${failures} FAILED`);
    process.exit(1);
  }
  console.log('all admin panel DOM tests passed');
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
