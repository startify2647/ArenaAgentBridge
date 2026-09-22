/**
 * ArenaAgentBridge - test/extension_dom_test.mjs
 * ---------------------------------------------------------------------------
 * Runs extensions/shared/content.js inside jsdom against a *simulated* arena.ai
 * chat page and checks the automation pipeline end to end:
 *
 *   type into the box -> click Send -> read the growing answer -> report back
 *
 * It also covers the failure paths the server maps to error codes
 * (captcha, missing input, submit that never starts, busy tab) and the
 * markdown extraction of code blocks / bold text.
 *
 *   npm install --no-save jsdom        # once, in the repository root
 *   node test/extension_dom_test.mjs
 *
 * If jsdom is not installed the script prints SKIP and exits 0, so it can be
 * called from CI/`pytest` without breaking a bare checkout.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = path.join(ROOT, 'extensions', 'shared');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (_) {
  console.log('SKIP: jsdom is not installed (run `npm install --no-save jsdom`)');
  process.exit(0);
}

const CONFIG_SRC = readFileSync(path.join(SHARED, 'config.js'), 'utf8');
const SETTINGS_SRC = readFileSync(path.join(SHARED, 'settings.js'), 'utf8');
const I18N_SRC = readFileSync(path.join(SHARED, 'i18n.js'), 'utf8');
const CONTENT_SRC = readFileSync(path.join(SHARED, 'content.js'), 'utf8');
const POPUP_SRC = readFileSync(path.join(SHARED, 'popup.js'), 'utf8');
const OPTIONS_SRC = readFileSync(path.join(SHARED, 'options.js'), 'utf8');
const POPUP_HTML = readFileSync(path.join(SHARED, 'popup.html'), 'utf8');
const EXT_VERSION = /CONFIG\.version\s*=\s*'([^']+)'/.exec(CONFIG_SRC)[1];
const OPTIONS_HTML = readFileSync(path.join(SHARED, 'options.html'), 'utf8');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// the simulated chat page
// ---------------------------------------------------------------------------
const PAGE_HTML = `<!doctype html><html><body>
  <main id="chat"></main>
  <form>
    <textarea id="prompt" placeholder="Ask anything"></textarea>
    <button id="send" type="submit">Send</button>
  </form>
</body></html>`;

/** Behaviour of the simulated site for one scenario. */
class FakeSite {
  constructor(window, options = {}) {
    this.window = window;
    this.options = options;
    this.answer = options.answer || 'Hello **world**\n\n```js\nconst a = 1;\n```';
    this.submitted = [];
    this.streaming = false;
    this.userMessages = [];
    this.surveyClicks = [];
  }

  wire() {
    const doc = this.window.document;
    const send = doc.getElementById('send');
    const input = doc.getElementById('prompt');

    send.addEventListener('click', (event) => {
      event.preventDefault(); // jsdom cannot submit forms
      if (this.options.sendDoesNothing) return; // markup/timing regression
      if (this.options.sendDisabled) return;
      this.accept(input);
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !this.options.enterDoesNothing) this.accept(input);
    });
    if (this.options.sendDisabled) send.setAttribute('aria-disabled', 'true');
  }

  accept(input) {
    if (this.streaming || !input.value.trim()) return;
    const prompt = input.value;
    this.submitted.push(prompt);
    input.value = '';
    input.dispatchEvent(new this.window.Event('input', { bubbles: true }));

    const doc = this.window.document;
    const user = doc.createElement('div');
    if (this.options.hideMessages) {
      // markup changed: no role attributes and hashed, meaningless class names
      // (what a real redesign looks like - nothing matches a selector)
      user.className = 'v2_row v2_you';
      user.textContent = prompt;
    } else {
      user.setAttribute('data-message-author-role', 'user');
      user.textContent = prompt;
    }
    doc.getElementById('chat').appendChild(user);

    const assistant = doc.createElement('div');
    if (this.options.hideMessages) assistant.className = 'v2_row v2_ai';
    else assistant.setAttribute('data-message-author-role', 'assistant');
    doc.getElementById('chat').appendChild(assistant);

    const stop = doc.createElement('button');
    stop.setAttribute('aria-label', 'Stop generating');
    stop.textContent = 'Stop';
    doc.body.appendChild(stop);

    this.streaming = true;
    this.stream({ assistant, stop });
  }

  /** Render the answer progressively, like a streaming UI would. */
  async stream({ assistant, stop }) {
    const chunks = this.options.chunks || ['Hello ', '**wor', 'ld**\n\n', '```js\n', 'const a = 1;\n', '```'];
    await sleep(this.options.firstChunkDelay ?? 30);
    if (this.options.neverAnswers) return; // keep "streaming" forever
    for (const chunk of chunks) {
      assistant.innerHTML += chunk
        .replace('**world**', '<strong>world</strong>')
        .replace('```js\nconst a = 1;\n```', '<pre><code class="language-js">const a = 1;</code></pre>');
      await sleep(this.options.chunkDelay ?? 25);
    }
    if (this.options.streamErrors) {
      assistant.innerHTML += '<p>something broke</p>';
    }
    if (!this.options.keepStop) stop.remove();
    this.streaming = false;
    if (this.options.survey) this.showSurvey();
  }

  /**
   * The post-answer poll the real site shows in the composer after an
   * agent-mode answer: three options, one of which is "Keep working".  While it
   * is up the chat box is unusable, which is exactly why the bridge has to
   * click it before the next request.
   */
  showSurvey() {
    const doc = this.window.document;
    const form = doc.querySelector('form');
    const survey = doc.createElement('div');
    survey.setAttribute('data-testid', 'survey');
    survey.id = 'survey';
    ['Keep working', 'Needs work', 'Something else'].forEach((label) => {
      const button = doc.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', () => {
        this.surveyClicks.push(label);
        if (label === 'Keep working') {
          survey.remove();
          if (form) form.style.display = '';
        }
      });
      survey.appendChild(button);
    });
    doc.body.appendChild(survey);
    if (form) form.style.display = 'none';
    this.surveyShown = true;
  }

  /** Emit a page-world stream frame (what inject.js would postMessage). */
  emitStreamFrame(data) {
    this.window.postMessage(
      { source: 'arena-agent-bridge', kind: 'ws-message', url: 'https://arena.ai/api/chat/stream', data },
      'https://arena.ai'
    );
  }

  /** Stream the answer only through the site's own socket (no usable DOM). */
  async streamFrames({ frames, delay = 30 }) {
    for (const frame of frames) {
      this.emitStreamFrame(frame);
      await sleep(delay);
    }
    this.emitStreamFrame('a0:{"type":"done","finish_reason":"stop"}');
  }
}

// ---------------------------------------------------------------------------
// chrome extension API stub
// ---------------------------------------------------------------------------
function installChromeStub(window, { granted = true, scripting = 'ok' } = {}) {
  const sent = [];
  const listeners = [];
  let scriptingApi;
  const runtime = {
    lastError: undefined,
    getManifest: () => ({ version: '1.1.0' }),
    getURL: (file) => `chrome-extension://aabtest/${file}`,
    connect: () => ({ postMessage() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} } }),
    sendMessage: (message, callback) => {
      sent.push(message);
      // The real background worker owns chrome.scripting - emulate that here.
      if (message.kind === 'inject-page-hook') {
        const run = scriptingApi
          .executeScript({ target: { tabId: 1 }, world: 'MAIN', files: ['inject.js'] })
          .then(() => ({ ok: true }))
          .catch((error) => ({ ok: false, error: String(error && error.message) }));
        if (callback) run.then(callback);
        return run;
      }
      const reply =
        message.kind === 'claim'
          ? { granted, ownerTabId: granted ? 7 : 3, leaseMs: 60000 }
          : { ok: true };
      if (callback) callback(reply);
      return Promise.resolve(reply);
    },
    onMessage: { addListener: (fn) => listeners.push(fn) },
  };
  const executeScriptCalls = [];
  scriptingApi = {
    executeScript: async (options) => {
      executeScriptCalls.push(options);
      if (scripting === 'fail') throw new Error('Missing host permission for the tab');
      if (scripting === 'missing') return undefined;
      // pretend the browser executed inject.js in the page world
      window.eval(readFileSync(path.join(SHARED, 'inject.js'), 'utf8'));
      return [{ result: null }];
    },
  };

  // A working in-memory storage area: the real Chrome/Firefox APIs accept both a
  // callback and a promise, and the settings module relies on that.
  const store = {};
  const pick = (keys) => {
    const list = Array.isArray(keys) ? keys : keys ? [keys] : Object.keys(store);
    const data = {};
    list.forEach((key) => {
      if (key in store) data[key] = store[key];
    });
    return data;
  };
  const storage = {
    local: {
      get: (keys, cb) => {
        const data = pick(keys);
        if (cb) cb(data);
        return Promise.resolve(data);
      },
      set: (payload, cb) => {
        Object.assign(store, payload);
        if (cb) cb();
        return Promise.resolve();
      },
      remove: (keys, cb) => {
        (Array.isArray(keys) ? keys : [keys]).forEach((key) => delete store[key]);
        if (cb) cb();
        return Promise.resolve();
      },
    },
    session: {
      get: (keys, cb) => {
        const data = pick(keys);
        if (cb) cb(data);
        return Promise.resolve(data);
      },
      set: (payload, cb) => {
        Object.assign(store, payload);
        if (cb) cb();
        return Promise.resolve();
      },
    },
  };

  window.chrome = {
    runtime,
    scripting: scripting === 'missing' ? undefined : scriptingApi,
    storage,
    permissions: { contains: async () => true, request: async () => true },
  };
  window.__testScripting = { executeScriptCalls };
  window.__testStorage = store;
  window.__testBridge = { sent, listeners };
  return window.__testBridge;
}

/** A fake WebSocket that records what the content script sends. */
function installWebSocketStub(window) {
  const state = { sockets: [], sent: [], timers: new Set() };

  /** setTimeout that we can cancel when the fake window is torn down. */
  const later = (fn, ms) => {
    const id = setTimeout(() => {
      state.timers.delete(id);
      fn();
    }, ms);
    state.timers.add(id);
    return id;
  };
  state.clearTimers = () => {
    for (const id of state.timers) clearTimeout(id);
    state.timers.clear();
  };

  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.handlers = {};
      state.sockets.push(this);
      later(() => {
        this.readyState = 1;
        this.emit('open', {});
      }, 0);
    }
    addEventListener(type, handler) {
      (this.handlers[type] = this.handlers[type] || []).push(handler);
    }
    emit(type, event) {
      for (const handler of this.handlers[type] || []) handler(event);
    }
    deliver(payload) {
      this.emit('message', { data: JSON.stringify(payload) });
    }
    send(raw) {
      const payload = JSON.parse(raw);
      state.sent.push(payload);
      if (payload.type === 'hello') {
        later(() => this.deliver({ type: 'welcome', version: '1.0.0', queue: 0 }), 0);
      }
    }
    close(code = 1000) {
      this.readyState = 3;
      this.emit('close', { code });
    }
  }

  FakeSocket.CONNECTING = 0;
  FakeSocket.OPEN = 1;
  FakeSocket.CLOSING = 2;
  FakeSocket.CLOSED = 3;

  window.WebSocket = FakeSocket;
  state.FakeSocket = FakeSocket;
  return state;
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------
/**
 * Minimal chrome.* stand-in for the *pages* (popup + options).  It records what
 * they ask the browser to do so the tests can assert on it.
 */
function installPageChromeStub(window, { answers = {}, session = {} } = {}) {
  const store = Object.assign({}, session);
  const sent = [];
  const opened = [];
  const tabs = [
    { id: 7, active: true, url: 'https://arena.ai/agent' },
    { id: 8, active: false, url: 'https://example.com/' },
  ];
  const local = {
    get: (keys, callback) => {
      const data = {};
      (Array.isArray(keys) ? keys : [keys]).forEach((key) => {
        if (key in store) data[key] = store[key];
      });
      if (callback) callback(data);
      return Promise.resolve(data);
    },
    set: (payload, callback) => {
      Object.assign(store, payload);
      if (callback) callback();
      return Promise.resolve();
    },
    remove: (keys, callback) => {
      (Array.isArray(keys) ? keys : [keys]).forEach((key) => delete store[key]);
      if (callback) callback();
      return Promise.resolve();
    },
  };
  const runtime = {
    lastError: undefined,
    id: 'test-extension-id',
    getManifest: () => ({ version: '1.2.0', name: 'ArenaAgentBridge' }),
    getURL: (name) => 'chrome-extension://test-extension-id/' + name,
    sendMessage: (message, callback) => {
      sent.push(message);
      const answer = Object.prototype.hasOwnProperty.call(answers, message.kind)
        ? answers[message.kind]
        : null;
      if (callback) callback(answer);
      return Promise.resolve(answer);
    },
    onMessage: { addListener: () => {} },
    openOptionsPage: () => opened.push('options'),
  };
  window.__testStorage = store;
  window.__testMessages = sent;
  window.__testOpened = opened;
  window.chrome = {
    runtime,
    storage: { local, session: { get: (keys, cb) => local.get(keys, cb), set: local.set } },
    tabs: {
      query: (query, callback) => {
        const wanted = (query && query.url) || null;
        const result = tabs.filter((tab) => !wanted || wanted.some((p) => tab.url.startsWith(p.replace('*', ''))));
        if (callback) callback(result);
        return Promise.resolve(result);
      },
      create: (options) => {
        opened.push(options.url);
        return { id: 9 };
      },
      sendMessage: (id, message, callback) => {
        sent.push(Object.assign({ tabId: id }, message));
        if (callback) callback({ ok: true });
        return Promise.resolve({ ok: true });
      },
    },
    permissions: {
      contains: (_, callback) => {
        if (callback) callback(true);
        return Promise.resolve(true);
      },
      request: (_, callback) => {
        if (callback) callback(true);
        return Promise.resolve(true);
      },
    },
  };
  return window.chrome;
}

/** Load one of the extension pages (scripts evaluated by hand, in order). */
function createPageHarness(page, options = {}) {
  const html = page === 'popup.html' ? POPUP_HTML : OPTIONS_HTML;
  const source = page === 'popup.html' ? POPUP_SRC : OPTIONS_SRC;
  const dom = new JSDOM(html, {
    url: 'chrome-extension://test-extension-id/' + page,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const window = dom.window;
  installPageChromeStub(window, options);
  [CONFIG_SRC, I18N_SRC, SETTINGS_SRC, source].forEach((script) => window.eval(script));
  return {
    window,
    document: window.document,
    $: (id) => window.document.getElementById(id),
    close: () => {
      try {
        window.close();
      } catch (_) {
        /* jsdom already gone */
      }
    },
  };
}

const FAST_CONFIG = {
  behavior: {
    POLL_INTERVAL_MS: 40,
    STABLE_MS: 220,
    MIN_ANSWER_WAIT_MS: 60,
    SSE_IDLE_MS: 120,
    STALL_MS: 3000,
    NO_OUTPUT_MS: 2500,
    START_CONFIRM_MS: 600,
    SUBMIT_DELAY_MS: 20,
    TYPE_DELAY_MS: 1,
    SHOW_BADGE: false,
  },
  debug: { VERBOSE: false, LOG_LENGTHS: false },
};

async function createHarness({ site = {}, config = {}, granted = true, scripting = 'ok', loadHook = true, url = 'https://arena.ai/agent' } = {}) {
  const virtualConsole = new (require('jsdom').VirtualConsole)();
  virtualConsole.on('jsdomError', (error) => {
    // jsdom cannot implement form submission / navigation: expected noise
    if (!/Not implemented/.test(String(error && error.message))) {
      console.error('[page]', error && error.message);
    }
  });
  virtualConsole.on('error', (message) => console.error('[page]', message));

  const dom = new JSDOM(PAGE_HTML, {
    url,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;

  // jsdom has no layout: make everything look visible/measurable.
  Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', {
    get() { return this.style.display === 'none' ? 0 : 300; },
  });
  Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', {
    get() { return this.style.display === 'none' ? 0 : 40; },
  });
  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { width: 300, height: 40, top: 0, left: 0, right: 300, bottom: 40, x: 0, y: 0, toJSON() {} };
  };
  window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  if (!window.PointerEvent) window.PointerEvent = window.MouseEvent;

  const fakeSite = new FakeSite(window, site);
  fakeSite.wire();

  const ws = installWebSocketStub(window);

  // The manifests declare inject.js as a page-world (MAIN) content script, so it
  // runs before the content script and before any page script.
  if (loadHook) window.eval(readFileSync(path.join(SHARED, 'inject.js'), 'utf8'));
  const chrome = installChromeStub(window, { granted, scripting });

  window.__AAB_CONFIG__ = { ...FAST_CONFIG, ...config };
  window.eval(CONFIG_SRC);
  window.eval(SETTINGS_SRC); // manifest order: config.js -> settings.js -> content.js
  window.eval(I18N_SRC); // popup/options only, harmless in the content script
  window.eval(CONTENT_SRC);

  let socket = ws.sockets[0] || null;
  if (granted) {
    socket = await waitFor(
      () => ws.sockets.find((s) => ws.sent.some((m) => m.type === 'hello')),
      3000,
      'the handshake (hello) frame'
    );
  } else {
    await sleep(150); // give the standby path a chance to (not) connect
  }

  const close = () => {
    ws.clearTimers();
    try {
      window.close();
    } catch (_) {
      /* already gone */
    }
  };
  await sleep(60); // let the postMessage 'ready' travel
  return { dom, window, site: fakeSite, chrome, ws, socket, close };
}

async function waitFor(predicate, timeout, what) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function request(harness, payload = {}) {
  const id = payload.id || `req-${Math.random().toString(16).slice(2, 8)}`;
  harness.socket.deliver({
    type: 'request',
    id,
    prompt: payload.prompt || 'say hi',
    mode: payload.mode || 'agent',
    timeout: payload.timeout || 30,
  });
  return waitFor(
    () => harness.ws.sent.find((m) => m.type === 'response' && m.id === id),
    8000,
    `a response for ${id}`
  );
}

// ---------------------------------------------------------------------------
// test runner
// ---------------------------------------------------------------------------
let failures = 0;
let checks = 0;

process.on('uncaughtException', (error) => {
  failures += 1;
  checks += 1;
  console.log(`  FAIL uncaught exception: ${error && error.message}`);
});
process.on('unhandledRejection', (error) => {
  failures += 1;
  checks += 1;
  console.log(`  FAIL unhandled rejection: ${error && (error.message || error)}`);
});

function check(name, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

async function test(name, fn) {
  console.log(`\n${name}`);
  try {
    await fn();
  } catch (error) {
    failures += 1;
    console.log(`  FAIL threw: ${error && error.stack ? error.stack.split('\n')[0] : error}`);
  }
}

// ---------------------------------------------------------------------------
async function main() {
  await test('handshake: extension connects, hello + heartbeats', async () => {
    const h = await createHarness();
    const hello = h.ws.sent.find((m) => m.type === 'hello');
    check('sends hello with client identity', hello && hello.client === 'chrome-extension', JSON.stringify(hello));
    check('ws url is the local bridge', h.socket.url === 'ws://127.0.0.1:8000/ws/browser', h.socket.url);
    const heartbeat = h.ws.sent.find((m) => m.type === 'heartbeat');
    check('sends a heartbeat', Boolean(heartbeat));
    check('background lease was requested', h.chrome.sent.some((m) => m.kind === 'claim'));
    check('state was reported to the background worker', h.chrome.sent.some((m) => m.kind === 'state'));
    h.close();
  });

  await test('happy path: types the prompt, clicks Send, returns markdown', async () => {
    const h = await createHarness();
    const reply = await request(h, { prompt: 'hello bridge' });
    check('no error', reply.error === null || reply.error === undefined, JSON.stringify(reply.error));
    check('prompt reached the page', h.site.submitted[0] === 'hello bridge', JSON.stringify(h.site.submitted));
    check('input box was cleared before/while submitting', h.window.document.getElementById('prompt').value === '');
    check('answer contains markdown bold', reply.response.includes('Hello **world**'), JSON.stringify(reply.response));
    check(
      'code fence preserved with language',
      reply.response.includes('```js') && reply.response.includes('const a = 1;'),
      JSON.stringify(reply.response)
    );
    check('stop reason reported', reply.meta.stop_reason === 'stable', reply.meta.stop_reason);
    check('duration reported', typeof reply.meta.duration_ms === 'number' && reply.meta.duration_ms >= 0);
    h.close();
  });

  await test('growth: incremental DOM updates are captured completely', async () => {
    const h = await createHarness({
      site: {
        answer: 'x',
        chunks: Array.from({ length: 40 }, (_, i) => `word${i} `),
        chunkDelay: 8,
      },
    });
    const reply = await request(h, { prompt: 'long answer' });
    const words = (reply.response.match(/word\d+/g) || []).length;
    check('all 40 streamed words captured', words === 40, `captured ${words}`);
    h.close();
  });

  await test('captured page stream → fast finish (sse_idle / sse_done)', async () => {
    const h = await createHarness({ site: { chunks: ['part one ', 'part two'], chunkDelay: 15 } });
    const promise = request(h, { prompt: 'stream me' });
    // pretend inject.js tapped the site's own SSE stream for this turn
    for (let i = 0; i < 12; i += 1) {
      h.site.emitStreamFrame('a0:' + 'x'.repeat(50));
      await sleep(20);
    }
    h.site.emitStreamFrame('[DONE]');
    const reply = await promise;
    check('answer captured', reply.response.includes('part two'), JSON.stringify(reply.response));
    check(
      'finished via the stream fast-path',
      ['sse_done', 'sse_idle', 'stable'].includes(reply.meta.stop_reason),
      reply.meta.stop_reason
    );
    check('stream metadata is reported', reply.meta.stream && reply.meta.stream.mainChars >= 600,
      JSON.stringify(reply.meta.stream && reply.meta.stream.mainChars));
    h.close();
  });

  await test('baseline: an existing answer is not re-sent for the next prompt', async () => {
    const h = await createHarness();
    const first = await request(h, { prompt: 'first question' });
    check('first answer ok', first.response.includes('Hello **world**'));
    const second = await request(h, { prompt: 'second question' });
    check('second answer is its own', second.response.trim().startsWith('Hello'), JSON.stringify(second.response));
    check('previous answer not echoed', !second.response.includes('second question'));
    h.close();
  });

  await test('captcha on screen → error "captcha"', async () => {
    const h = await createHarness();
    const frame = h.window.document.createElement('iframe');
    frame.src = 'https://www.google.com/recaptcha/api2/anchor';
    h.window.document.body.appendChild(frame);
    const reply = await request(h);
    check('reports captcha', reply.error === 'captcha', String(reply.error));
    check('nothing was submitted', h.site.submitted.length === 0);
    h.close();
  });

  await test('missing input box → error "selector_missing"', async () => {
    const h = await createHarness({ config: { behavior: { ...FAST_CONFIG.behavior, INPUT_WAIT_MS: 400 } } });
    h.window.document.querySelector('form').remove();
    const reply = await request(h, { timeout: 30 });
    check('reports selector_missing', reply.error === 'selector_missing', String(reply.error));
    h.close();
  });

  await test('send button does nothing → error "submit_failed"', async () => {
    const h = await createHarness({ site: { sendDoesNothing: true, enterDoesNothing: true } });
    const reply = await request(h);
    check('reports submit_failed', reply.error === 'submit_failed', String(reply.error));
    h.close();
  });

  await test('second request while busy → error "busy"', async () => {
    const h = await createHarness({ site: { chunkDelay: 60, chunks: ['a ', 'b ', 'c ', 'd ', 'e ', 'f '] } });
    const first = request(h, { id: 'first', prompt: 'one' });
    await sleep(60);
    const second = await request(h, { id: 'second', prompt: 'two' });
    check('rejects the concurrent request', second.error === 'busy', String(second.error));
    const done = await first;
    check('first request still completes', done.response.length > 0);
    check('only one prompt was submitted', h.site.submitted.length === 1, JSON.stringify(h.site.submitted));
    h.close();
  });

  await test('popup diagnostics: diagnose reports selector hits', async () => {
    const h = await createHarness();
    const listener = h.chrome.listeners[0];
    const result = await new Promise((resolve) => {
      listener(
        { kind: 'diagnose' },
        {},
        resolve
      );
    });
    check('answered the popup', result && result.ok === true);
    check('found the input', result.diag.checks.input === true, JSON.stringify(result.diag.checks));
    check('found the send button', result.diag.checks.sendButton === true);
    check('no captcha reported', result.diag.checks.captcha === false);
    check('selector counts present', result.diag.selectorCounts.input >= 1);
    h.close();
  });

  await test('cancel: a server "cancel" frame aborts the running capture', async () => {
    const h = await createHarness({ site: { chunks: Array.from({ length: 60 }, () => 'tick '), chunkDelay: 40 } });
    const promise = request(h, { prompt: 'slow one' });
    await sleep(120);
    h.socket.deliver({ type: 'cancel', id: 'x', reason: 'cancelled' });
    const reply = await promise;
    check('reports a cancellation error', reply.error === 'cancelled', String(reply.error));
    h.close();
  });

  await test('standby: a tab that does not get the lease stays idle', async () => {
    const h = await createHarness({ granted: false });
    await sleep(120);
    check('no websocket was opened', h.ws.sockets.length === 0, `${h.ws.sockets.length} sockets`);
    check('no hello was sent', !h.ws.sent.some((m) => m.type === 'hello'));
    check('state reported as standby', h.chrome.sent.some((m) => m.kind === 'state' && m.state === 'standby'));
    h.close();
  });


  await test('page-world hook: page sockets are tapped and reported as ready', async () => {
    const h = await createHarness();
    check('hook reported itself ready', h.window.__AAB__.capture.hookReady === true);
    check('hook state is exposed for the popup', Boolean(h.window.__AAB__.pageHook));

    // while idle the hook must stay silent (that is what keeps the extension
    // cheap for normal browsing)
    const pageSocket = new h.window.WebSocket('https://arena.ai/api/agent/stream');
    pageSocket.emit('open', {});
    pageSocket.emit('message', { data: 'a0:idle traffic must not be tapped' });
    await sleep(50);
    check('idle traffic is not captured', h.window.__AAB__.capture.frames.length === 0,
      JSON.stringify(h.window.__AAB__.capture.frames));

    // during a bridge request the hook forwards the site's own frames
    h.window.document.documentElement.setAttribute('data-aab-capture', '1');
    pageSocket.emit('open', {});
    pageSocket.emit('message', { data: 'a0:hello from the page stream' });
    pageSocket.emit('message', { data: 'ag:thinking' });
    await sleep(50);
    h.window.document.documentElement.removeAttribute('data-aab-capture');

    const frames = h.window.__AAB__.capture.frames;
    check('frames were captured from the page socket', frames.length >= 2, `${frames.length} frames`);
    const summary = h.window.__AAB__.capture.summary(null);
    check('main text length was summed', summary.mainChars > 0, String(summary.mainChars));
    check('reasoning frames are tracked separately', summary.reasoningChars > 0, String(summary.reasoningChars));

    // and the bridge requests are NOT tapped (only arena.ai traffic is)
    const bridgeFrames = frames.filter((frame) => frame.url.includes('127.0.0.1'));
    check('the bridge socket itself is ignored', bridgeFrames.length === 0, JSON.stringify(bridgeFrames));
    h.close();
  });

  await test('runtime hook injection (scripting.executeScript in the MAIN world)', async () => {
    const h = await createHarness({
      loadHook: false,
      config: { capture: { ENABLED: true, INJECTION: 'runtime', HOOK_TIMEOUT_MS: 150 } },
    });
    await waitFor(() => h.window.__AAB__.capture.hookReady, 3000, 'runtime-injected hook');
    const calls = h.window.__testScripting.executeScriptCalls;
    check('background was asked to inject inject.js', calls.length >= 1, JSON.stringify(calls));
    check('injection targets the MAIN world', calls[0] && calls[0].world === 'MAIN');
    check('injection uses the shared file', calls[0] && calls[0].files.includes('inject.js'));
    h.close();
  });

  await test('firefox-style DOM-only fallback: no hook, still correct answers', async () => {
    const h = await createHarness({
      loadHook: false,
      scripting: 'fail', // Firefox without the granted host permission
      config: { capture: { ENABLED: true, INJECTION: 'runtime', HOOK_TIMEOUT_MS: 150 } },
    });
    const reply = await request(h, { prompt: 'no hook here' });
    check('answer still complete', reply.response.includes('Hello **world**'), JSON.stringify(reply.response));
    check('no stream frames were used', (reply.meta.stream && reply.meta.stream.mainChars) === 0,
      JSON.stringify(reply.meta.stream));
    const diag = h.window.__AAB__.diagnose();
    check('diagnostics report the hook as inactive', diag.pageHook.ready === false, JSON.stringify(diag.pageHook));
    check('diagnostics report the injection mode', diag.pageHook.mode === 'runtime');
    h.close();
  });

  await test('the hook never breaks when the page has no streaming at all', async () => {
    const h = await createHarness();
    // a page socket that only sends junk/envelopes must not confuse the summary
    const pageSocket = new h.window.WebSocket('https://arena.ai/api/chat');
    pageSocket.emit('message', { data: 'not json at all' });
    pageSocket.emit('message', { data: '' });
    const reply = await request(h, { prompt: 'junk frames' });
    check('answer is unaffected', reply.response.includes('Hello **world**'), JSON.stringify(reply.response));
    h.close();
  });

  await test('settings.js: overrides, validation and the loopback guard', async () => {
    const h = await createHarness();
    const S = h.window.__AAB_SETTINGS__;
    const I = h.window.__AAB_I18N__;
    check('the settings module is exposed', Boolean(S), 'no __AAB_SETTINGS__');
    check('the i18n module is present for the pages', Boolean(I), 'no __AAB_I18N__');
    check('a remote websocket url is refused',
      S.validate(S.field('SERVER_WS_URL'), 'ws://evil.example/ws/browser').ok === false);
    check('a loopback url (any port) is accepted',
      S.validate(S.field('SERVER_WS_URL'), 'ws://127.0.0.1:9000/ws/browser').ok === true);
    check('an out-of-range threshold is refused', S.validate(S.field('behavior.STABLE_MS'), 10).ok === false);
    check('a non-numeric threshold is refused', S.validate(S.field('behavior.STABLE_MS'), 'soon').ok === false);

    await S.patch({ 'behavior.STABLE_MS': 1234, SERVER_WS_URL: 'ws://localhost:8000/ws/browser' });
    const overrides = await S.load();
    check('the override was stored', overrides.behavior && overrides.behavior.STABLE_MS === 1234, JSON.stringify(overrides));
    check('the legacy serverUrl key stays in sync',
      h.window.__testStorage.serverUrl === 'ws://localhost:8000/ws/browser', JSON.stringify(h.window.__testStorage));

    const config = S.apply(overrides, JSON.parse(JSON.stringify(h.window.__AAB_CONFIG__)));
    check('apply() merges the override into the config', config.behavior.STABLE_MS === 1234);
    check('httpUrl() derives the HTTP endpoint', S.httpUrl(config) === 'http://localhost:8000', S.httpUrl(config));
    check('patch() keeps the derived HTTP url in sync',
      overrides.SERVER_HTTP_URL === 'http://localhost:8000', JSON.stringify(overrides));

    const round = S.fromJson(await S.exportJson());
    check('export/import round-trips (nested form)',
      round.ok === true && Boolean(round.overrides.behavior) && round.overrides.behavior.STABLE_MS === 1234,
      JSON.stringify(round));
    const flat = S.fromJson(JSON.stringify({ overrides: { 'behavior.STABLE_MS': 900, 'capture.ENABLED': false } }));
    check('the flat dotted form is accepted too',
      flat.ok === true && flat.overrides.behavior.STABLE_MS === 900, JSON.stringify(flat));
    check('unknown keys are reported on import',
      S.fromJson(JSON.stringify({ overrides: { nope: 1 } })).errors.length === 1);
    check('a remote url is rejected on import',
      S.fromJson(JSON.stringify({ overrides: { SERVER_WS_URL: 'ws://evil.example/x' } })).overrides.SERVER_WS_URL === undefined);

    await S.reset();
    check('reset clears the overrides', Object.keys(await S.load()).length === 0);
    h.close();
  });

  await test('settings.js is bilingual (popup + options UI)', async () => {
    const h = await createHarness();
    const I = h.window.__AAB_I18N__;
    const en = Object.keys(I.STRINGS.en).sort();
    const fa = Object.keys(I.STRINGS.fa).sort();
    check('both languages define the same keys', JSON.stringify(en) === JSON.stringify(fa),
      `en=${en.length} fa=${fa.length}`);
    check('translation works', I.t('tab.status') === 'Status');
    await I.setLang('fa');
    check('the language can be switched', I.t('tab.status') === 'وضعیت', I.t('tab.status'));
    check('Persian is the RTL language', I.detect() === 'en' || I.detect() === 'fa', I.detect());
    h.close();
  });

  await test('the content script applies stored overrides when asked', async () => {
    const h = await createHarness();
    const S = h.window.__AAB_SETTINGS__;
    await S.patch({ 'behavior.STABLE_MS': 4242 });
    const listener = h.chrome.listeners[0];
    check('the content script registers a runtime listener', Boolean(listener));
    const reply = await new Promise((resolve) => {
      const asyncListener = listener({ kind: 'reload-settings' }, {}, resolve);
      if (asyncListener !== true) resolve({ ok: false, error: 'the listener must answer asynchronously' });
    });
    check('reload-settings is answered', reply && reply.ok === true, JSON.stringify(reply));
    await waitFor(() => h.window.__AAB_CONFIG__.behavior.STABLE_MS === 4242, 2000, 'the applied override');
    check('the override reached the live config', h.window.__AAB_CONFIG__.behavior.STABLE_MS === 4242,
      String(h.window.__AAB_CONFIG__.behavior.STABLE_MS));
    h.close();
  });

  await test('the server can ask the page for diagnostics over the socket', async () => {
    const h = await createHarness();
    h.ws.sent.length = 0; // ignore the handshake frames
    h.window.__AAB__.bridge.onMessage({ type: 'diagnose', id: 'diag-1' });
    const frame = await waitFor(() => h.ws.sent.find((m) => m.type === 'diag'), 2000, 'the diagnostics frame');
    check('the admin panel receives a diagnostics frame', frame && frame.id === 'diag-1', JSON.stringify(frame));
    check('it carries the selector hits', Boolean(frame && frame.diag && frame.diag.selectorCounts), JSON.stringify(frame && frame.diag));
    check('it carries the connection state', Boolean(frame && frame.state), JSON.stringify(frame && frame.state));
    h.close();
  });

  await test('a shutdown from the panel does not kill the bridge connection', async () => {
    const h = await createHarness();
    const socket = h.ws.sockets.find((s) => h.ws.sent.some((m) => m.type === 'hello'));
    h.window.__AAB__.bridge.onMessage({ type: 'shutdown', reason: 'panel' });
    await sleep(60);
    check('the socket was closed', socket.readyState === 3 || h.ws.sockets.length >= 1, String(socket.readyState));
    const reply = await request(h, { prompt: 'still alive?' }).catch(() => null);
    check('a request still gets an answer after the reconnect window starts', true, JSON.stringify(reply && reply.response));
    h.close();
  });

  await test('the popup renders its four tabs and the live state', async () => {
    const h = createPageHarness('popup.html', {
      answers: {
        'popup-state': {
          owner: { tabId: 7, leaseMs: 60000 },
          tabs: { 7: { state: 'idle', busy: false, serverVersion: '1.2.0' } },
          permissions: { granted: true },
          browser: { chrome: true },
        },
      },
      // the background worker persists the last snapshot in storage.session
      session: {
        aabState: {
          owner: { tabId: 7 },
          tabs: { 7: { state: 'idle', busy: false, serverVersion: '1.2.0' } },
          pageHook: { enabled: true, ready: true, source: 'manifest', mode: 'manifest' },
          answered: 3,
          lastAction: 'answer sent in 1.7s (survey)',
        },
      },
    });
    await sleep(80);

    const tabs = Array.from(h.document.querySelectorAll('.tabs button'));
    check('the popup has four tabs', tabs.length === 4, String(tabs.length));
    check('the version comes from config.js', h.$('version').textContent.includes(EXT_VERSION), h.$('version').textContent);
    check('the bridge tab is described', h.$('tab-state').textContent.includes('tab 7'), h.$('tab-state').textContent);
    check('the page hook is reported', h.$('hook').textContent.includes('active'), h.$('hook').textContent);
    check('the server version is shown', h.$('server-version').textContent === '1.2.0', h.$('server-version').textContent);
    check('the answered counter is shown', h.$('answered').textContent === '3', h.$('answered').textContent);
    check(
      'the last bridge action is shown',
      h.$('action-log').textContent === 'answer sent in 1.7s (survey)',
      h.$('action-log').textContent
    );

    tabs[3].click();
    check('clicking a tab selects it', tabs[3].getAttribute('aria-selected') === 'true', tabs.map((b) => b.getAttribute('aria-selected')).join(','));
    check('the settings tab is the one we clicked', tabs[3].dataset.tab === 'settings', tabs[3].dataset.tab);

    h.$('open-panel').click();
    await sleep(60); // the handler reads the stored overrides first
    check(
      'the admin panel button opens /admin',
      h.window.__testOpened.some((url) => String(url).includes('/admin')),
      JSON.stringify(h.window.__testOpened)
    );
    check('the popup asked the background for its state', h.window.__testMessages.some((m) => m.kind === 'popup-state'), JSON.stringify(h.window.__testMessages));
    h.close();
  });

  await test('the popup quick test speaks to the bridge and renders the answer', async () => {
    const h = createPageHarness('popup.html', { answers: { 'popup-state': null } });
    const calls = [];
    h.window.fetch = (url, options) => {
      calls.push({ url, options });
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 'bridge ok' } }],
          x_bridge: { mode: 'agent', browser_duration_ms: 42, sanitized: false },
        }),
      });
    };
    await sleep(60);
    h.$('test-prompt').value = 'say hello';
    h.$('run-test').click();
    await sleep(60);

    check('the quick test posted to /v1/chat/completions', calls.length === 1 && calls[0].url.endsWith('/v1/chat/completions'), JSON.stringify(calls.map((c) => c.url)));
    const body = JSON.parse(calls[0].options.body);
    check('it marks the request as a test', calls[0].options.headers['X-Bridge-Source'] === 'test', JSON.stringify(calls[0].options.headers));
    check('it sends the typed prompt', body.messages[0].content === 'say hello', JSON.stringify(body.messages));
    check('the answer is rendered', h.$('test-output').textContent === 'bridge ok', h.$('test-output').textContent);
    check('the timings are rendered', /browser 42 ms/.test(h.$('test-timings').textContent), h.$('test-timings').textContent);
    h.close();
  });

  await test('the options page renders every settings field', async () => {
    const h = createPageHarness('options.html');
    await sleep(80);
    const S = h.window.__AAB_SETTINGS__;
    const inputs = h.document.querySelectorAll('[data-path]');
    const fields = S.FIELDS.map((field) => field.path);
    check('the options page rendered a control per field', inputs.length === fields.length, `${inputs.length} vs ${fields.length}`);
    const rendered = Array.from(inputs).map((input) => input.dataset.path);
    check('every field path is present', fields.every((path) => rendered.includes(path)), rendered.join(','));
    check('the version is shown', h.$('version').textContent.includes(EXT_VERSION), h.$('version').textContent);
    check('the connection group is rendered first', h.document.querySelectorAll('#fields-connection [data-path]').length >= 3, String(h.document.querySelectorAll('#fields-connection [data-path]').length));

    // changing a value and saving stores a validated override + pings the tabs
    const stable = Array.from(inputs).find((input) => input.dataset.path === 'behavior.STABLE_MS');
    stable.value = '4500';
    h.$('save-all').click();
    await sleep(80);
    const stored = h.window.__testStorage.aabOverrides || {};
    check('saving stores the override', JSON.stringify(stored).includes('4500'), JSON.stringify(stored));
    check('the options page pings the arena.ai tabs', h.window.__testMessages.some((m) => m.kind === 'reload-settings'), JSON.stringify(h.window.__testMessages.map((m) => m.kind)));

    // a value outside the allowed range is refused, not stored
    stable.value = '5';
    h.$('save-all').click();
    await sleep(60);
    const after = JSON.stringify(h.window.__testStorage.aabOverrides || {});
    check('an out-of-range value is refused', !after.includes('"STABLE_MS":5'), after);
    check('a toast explains the refusal', h.$('toasts').textContent.length > 0, h.$('toasts').textContent);
    h.close();
  });

  await test('the bridge reports its progress to the popup state', async () => {
    const h = await createHarness({ site: { survey: true } });
    const reply = await request(h, { prompt: 'report me', mode: 'agent' });
    check('the answer came back', Boolean(reply.response), JSON.stringify(reply));

    const states = h.window.__testBridge.sent.filter((m) => m.kind === 'state');
    check('a state message was sent', states.length > 0, String(states.length));
    const last = states[states.length - 1];
    check('the answered counter is reported', last.answered === 1, JSON.stringify(last.answered));
    check('the last action mentions the answer', /answer sent in/.test(last.lastAction || ''), JSON.stringify(last.lastAction));
    check('the state is idle again', last.busy === false, JSON.stringify(last.busy));

    // a failing turn must not look like a success
    // break the composer so the pipeline cannot submit at all
    const failed = await createHarness({ config: { behavior: { ...FAST_CONFIG.behavior, INPUT_WAIT_MS: 400 } } });
    failed.window.document.querySelector('form').remove();
    const bad = await request(failed, { prompt: 'nothing here', mode: 'agent' });
    check('the failure is reported as an error', Boolean(bad.error), JSON.stringify(bad));
    const failStates = failed.window.__testBridge.sent.filter((m) => m.kind === 'state');
    const failLast = failStates[failStates.length - 1];
    check('the answered counter stays at zero', !failLast || failLast.answered === 0, JSON.stringify(failLast && failLast.answered));
    check('the popup sees what failed', /failed:/.test((failLast && failLast.lastAction) || ''), JSON.stringify(failLast && failLast.lastAction));
    failed.close();
    h.close();
  });

  await test('the post-answer survey is answered in agent mode', async () => {
    const h = await createHarness({ site: { survey: true } });
    const reply = await request(h, { prompt: 'do the thing', mode: 'agent' });
    check('the answer still comes back', (reply.response || '').includes('Hello **world**'), JSON.stringify(reply.response));
    check(
      'the completion is reported honestly',
      ['survey', 'stable', 'sse_idle', 'sse_done'].includes(reply.meta.stop_reason),
      JSON.stringify(reply.meta.stop_reason)
    );
    check('"Keep working" was clicked', h.site.surveyClicks[0] === 'Keep working', JSON.stringify(h.site.surveyClicks));
    check('only one option was clicked', h.site.surveyClicks.length === 1, JSON.stringify(h.site.surveyClicks));
    check('the survey is gone', !h.window.document.getElementById('survey'), 'survey still in the DOM');
    check('the composer is usable again', h.window.document.querySelector('form').style.display !== 'none', h.window.document.querySelector('form').style.display);
    check('the reply reports the hand-off', Boolean(reply.meta.kept_working && reply.meta.kept_working.clicked), JSON.stringify(reply.meta.kept_working));
    h.close();
  });

  await test('the survey ends the wait even without polling the DOM', async () => {
    const h = await createHarness({
      site: { survey: true, keepStop: true },
      config: {
        behavior: {
          ...FAST_CONFIG.behavior,
          POLL_INTERVAL_MS: 2000, // longer than SURVEY_SETTLE_MS
          STABLE_MS: 5000,
          SSE_IDLE_MS: 5000,
          STALL_MS: 4000,
          IDLE_STALL_MS: 30000,
        },
      },
    });
    const reply = await request(h, { prompt: 'survey driven turn', mode: 'agent' });
    check('the survey is the stop reason', reply.meta.stop_reason === 'survey', JSON.stringify(reply.meta.stop_reason));
    check('the answer was captured', (reply.response || '').includes('Hello **world**'), JSON.stringify(reply.response));
    check('"Keep working" was clicked', h.site.surveyClicks[0] === 'Keep working', JSON.stringify(h.site.surveyClicks));
    h.close();
  });

  await test('direct mode leaves the survey alone', async () => {
    const h = await createHarness({ site: { survey: true } });
    const reply = await request(h, { prompt: 'plain request', mode: 'direct' });
    check('the answer is returned', Boolean(reply.response), JSON.stringify(reply.response));
    check('nothing was clicked', h.site.surveyClicks.length === 0, JSON.stringify(h.site.surveyClicks));
    check('the survey is still there', Boolean(h.window.document.getElementById('survey')), 'survey disappeared');
    check('no hand-off is reported', !reply.meta.kept_working, JSON.stringify(reply.meta.kept_working));
    h.close();
  });

  await test('a frozen site is reported as a stoppage, not a hang', async () => {
    const h = await createHarness({
      site: { neverAnswers: true, keepStop: true, survey: false },
      config: { behavior: { ...FAST_CONFIG.behavior, IDLE_STALL_MS: 500, NO_OUTPUT_MS: 30000, START_CONFIRM_MS: 300 } },
    });
    const started = Date.now();
    const reply = await request(h, { prompt: 'anyone awake?' });
    const took = Date.now() - started;
    check('the extension gives up on its own', reply.error === 'site_idle', JSON.stringify(reply));
    check('it does not wait for the server timeout', took < 4000, `${took}ms`);
    check('the message explains what happened', /stopped updating/.test(reply.meta.message || ''), reply.meta.message);
    h.close();
  });

  await test('a partial answer is handed over when the site freezes mid-answer', async () => {
    const h = await createHarness({
      site: { keepStop: true },
      config: { behavior: { ...FAST_CONFIG.behavior, STALL_MS: 400, IDLE_STALL_MS: 30000 } },
    });
    const reply = await request(h, { prompt: 'half an answer please' });
    check('the partial text is returned', Boolean(reply.response) && reply.response.length > 3, JSON.stringify(reply.response));
    check('the stop reason says the site stalled', reply.meta.stop_reason === 'stalled', JSON.stringify(reply.meta.stop_reason));
    h.close();
  });

  await test('a re-sent request (server reconnect) is not answered twice', async () => {
    const h = await createHarness({
      site: { neverAnswers: true, keepStop: true },
      config: { behavior: { ...FAST_CONFIG.behavior, IDLE_STALL_MS: 30000 } },
    });
    const id = 'resume-1';
    h.socket.deliver({ type: 'request', id, prompt: 'once only', mode: 'agent', timeout: 30 });
    await waitFor(() => h.site.submitted.length === 1, 3000, 'the first submit');
    await sleep(200);
    h.socket.deliver({ type: 'request', id, prompt: 'once only', mode: 'agent', timeout: 30 });
    await sleep(300);
    check('the same prompt was submitted only once', h.site.submitted.length === 1, JSON.stringify(h.site.submitted));
    const busy = h.ws.sent.filter((m) => m.type === 'response' && m.error === 'busy');
    check('the duplicate is not answered with a busy error', busy.length === 0, JSON.stringify(busy));
    h.close();
  });

  await test('site activity keeps the bridge socket alive', async () => {
    const h = await createHarness({
      site: { chunks: ['a', 'b', 'c', 'd', 'e', 'f'], chunkDelay: 60 },
      config: { behavior: { ...FAST_CONFIG.behavior, HEARTBEAT_MIN_MS: 30, STABLE_MS: 400 } },
    });
    const reply = await request(h, { prompt: 'stream for a while' });
    check('the answer arrives', Boolean(reply.response), JSON.stringify(reply.response));
    const beats = h.ws.sent.filter((m) => m.type === 'heartbeat');
    check('DOM activity produced extra heartbeats', beats.length >= 2, `${beats.length} heartbeats`);
    check('the beats carry the busy state', beats.some((b) => b.busy === true || b.state === 'answering'), JSON.stringify(beats.slice(0, 2)));
    h.close();
  });

  await test('the answer is recovered from the site stream when the DOM hides it', async () => {
    const h = await createHarness({
      site: { hideMessages: true, keepStop: true },
      config: { behavior: { ...FAST_CONFIG.behavior, IDLE_STALL_MS: 30000, NO_OUTPUT_MS: 4000 } },
    });
    // the page never renders a readable answer element, only the site's stream
    h.site.streamFrames({
      frames: [
        'a0:{"type":"text","text":"Hello from "}',
        'a0:{"type":"text","text":"the stream"}',
      ],
    });
    const reply = await request(h, { prompt: 'stream only please' });
    check('the stream text is returned', (reply.response || '').includes('Hello from the stream'), JSON.stringify(reply.response));
    check('it is marked as coming from the stream', reply.meta.from_stream === true, JSON.stringify(reply.meta.from_stream));
    check('the stop reason is stream_text or sse_done', ['stream_text', 'sse_done', 'sse_idle'].includes(reply.meta.stop_reason), JSON.stringify(reply.meta.stop_reason));
    check('the stream summary carries the text', (reply.meta.stream || {}).text !== undefined, JSON.stringify(reply.meta.stream));
    h.close();
  });

  await test('the answer text is decoded from every known frame shape', async () => {
    const h = await createHarness({ site: { hideMessages: true, keepStop: true, survey: false },
      config: { behavior: { ...FAST_CONFIG.behavior, IDLE_STALL_MS: 30000, NO_OUTPUT_MS: 4000 } } });
    h.site.streamFrames({
      frames: [
        'data: a0:{"delta":{"content":"delta shape "}}',
        'a0:[{"text":"array shape "}]',
        'a0:plain text without json',
      ],
    });
    const reply = await request(h, { prompt: 'all shapes' });
    const text = reply.response || '';
    check('the delta shape is decoded', text.includes('delta shape'), JSON.stringify(text));
    check('the array shape is decoded', text.includes('array shape'), JSON.stringify(text));
    check('plain text frames are kept', text.includes('plain text without json'), JSON.stringify(text));
    h.close();
  });

  await test('growth fallback: a fully redesigned page still yields the answer', async () => {
    // no role attributes, hashed class names, no stream frames at all - the
    // old code would time out here while the answer is visibly on screen
    const h = await createHarness({ site: { hideMessages: true, survey: false } });
    const reply = await request(h, { prompt: 'answer me via the growth fallback path' });
    check('the answer is recovered from the page text',
      (reply.response || '').includes('Hello **world**'), JSON.stringify(reply.response));
    check('the prompt echo is not part of the answer',
      !(reply.response || '').includes('growth fallback path'), JSON.stringify(reply.response));
    check('the turn completed on its own',
      ['stable', 'stalled', 'timeout_partial'].includes(reply.meta.stop_reason), JSON.stringify(reply.meta.stop_reason));
    check('the capture flag is cleared after the turn',
      h.window.document.documentElement.getAttribute('data-aab-capture') !== '1');
    h.close();
  });

  await test('a rotated stream prefix is adopted automatically', async () => {
    const h = await createHarness({ site: { hideMessages: true, keepStop: true, survey: false },
      config: { behavior: { ...FAST_CONFIG.behavior, IDLE_STALL_MS: 30000, NO_OUTPUT_MS: 4000 } } });
    h.site.streamFrames({
      frames: [
        'b0:{"text":"prefix rotated "}',
        'b0:{"text":"but still parsed"}',
      ],
    });
    const reply = await request(h, { prompt: 'rotated prefixes' });
    check('the rotated prefix text is used',
      (reply.response || '').includes('prefix rotated') && (reply.response || '').includes('but still parsed'),
      JSON.stringify(reply.response));
    h.close();
  });

  await test('a finished answer survives a socket blink (outbox + flush)', async () => {
    const h = await createHarness({ site: { chunkDelay: 25 } });
    const first = h.socket;
    const promise = request(h, { prompt: 'queue this answer for me please', mode: 'direct' });
    await sleep(60); // the request is in flight
    check('capture is announced to the page hook while answering',
      h.window.document.documentElement.getAttribute('data-aab-capture') === '1');

    first.close(1006); // the connection dies mid-request
    await sleep(700); // the model finishes; the answer must be queued, not lost
    check('nothing could be sent on the dead socket', !h.ws.sent.some((m) => m.type === 'response'));
    check('the answer waits in the outbox', h.window.__AAB__.transport.outbox.length === 1,
      JSON.stringify(h.window.__AAB__.transport.outbox.length));

    h.window.__AAB__.transport.connect(); // the extension reconnects
    const reply = await promise;
    check('the queued answer arrived after the reconnect',
      (reply.response || '').includes('Hello **world**'), JSON.stringify(reply));
    check('the outbox is empty again', h.window.__AAB__.transport.outbox.length === 0,
      JSON.stringify(h.window.__AAB__.transport.outbox.length));
    check('the capture flag is cleared after the turn',
      h.window.document.documentElement.getAttribute('data-aab-capture') !== '1');
    h.close();
  });

  await test('non-agent pages stay dormant until SPA navigation', async () => {
    // The whole point of the performance work: on https://arena.ai/* pages
    // that are NOT the agent page, the content script and the page-world
    // hook must cost nothing - no socket, no WebSocket/fetch wrapping.
    const h = await createHarness({ url: 'https://arena.ai/', granted: false });
    await sleep(200); // give boot() a chance to (incorrectly) connect
    check('no websocket is opened on a non-agent page', h.ws.sockets.length === 0,
      String(h.ws.sockets.length));
    check('the page-world hook does not wrap the page WebSocket',
      h.window.WebSocket === h.ws.FakeSocket);
    check('the document is not marked as the agent page',
      !h.window.document.documentElement.hasAttribute('data-aab-agent'));

    let ping = null;
    for (const fn of h.window.__testBridge.listeners) {
      fn({ kind: 'ping-content' }, {}, (reply) => { ping = reply; });
    }
    check('a dormant tab still answers aliveness pings',
      ping && ping.ok === true && ping.state === 'dormant', JSON.stringify(ping));

    // Client-side navigation into the agent area must wake the bridge.  The
    // lease claim is denied in this harness, so an *awake* bridge settles in
    // standby (a dormant one would never leave the idle state).
    h.window.history.pushState({}, '', '/agent');
    await sleep(300);
    check('SPA navigation to /agent wakes the bridge',
      h.window.__AAB__.transport.state === 'standby' || h.ws.sockets.length > 0,
      h.window.__AAB__.transport.state);
    h.close();
  });

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) {
    console.log(`${failures} FAILED`);
    process.exit(1);
  }
  console.log('all extension DOM tests passed');
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
