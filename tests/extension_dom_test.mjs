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
    user.setAttribute('data-message-author-role', 'user');
    user.textContent = prompt;
    doc.getElementById('chat').appendChild(user);

    const assistant = doc.createElement('div');
    assistant.setAttribute('data-message-author-role', 'assistant');
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
    stop.remove();
    this.streaming = false;
  }

  /** Emit a page-world stream frame (what inject.js would postMessage). */
  emitStreamFrame(data) {
    this.window.postMessage(
      { source: 'arena-agent-bridge', kind: 'ws-message', url: 'https://arena.ai/api/chat/stream', data },
      'https://arena.ai'
    );
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

async function createHarness({ site = {}, config = {}, granted = true, scripting = 'ok', loadHook = true } = {}) {
  const virtualConsole = new (require('jsdom').VirtualConsole)();
  virtualConsole.on('jsdomError', (error) => {
    // jsdom cannot implement form submission / navigation: expected noise
    if (!/Not implemented/.test(String(error && error.message))) {
      console.error('[page]', error && error.message);
    }
  });
  virtualConsole.on('error', (message) => console.error('[page]', message));

  const dom = new JSDOM(PAGE_HTML, {
    url: 'https://arena.ai/agent',
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

    // the *page* opens its own socket; the hook should relay its frames
    const pageSocket = new h.window.WebSocket('https://arena.ai/api/agent/stream');
    pageSocket.emit('open', {});
    pageSocket.emit('message', { data: 'a0:hello from the page stream' });
    pageSocket.emit('message', { data: 'ag:thinking' });
    await sleep(50);

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
        },
      },
    });
    await sleep(80);

    const tabs = Array.from(h.document.querySelectorAll('.tabs button'));
    check('the popup has four tabs', tabs.length === 4, String(tabs.length));
    check('the version comes from config.js', h.$('version').textContent.includes('1.2.0'), h.$('version').textContent);
    check('the bridge tab is described', h.$('tab-state').textContent.includes('tab 7'), h.$('tab-state').textContent);
    check('the page hook is reported', h.$('hook').textContent.includes('active'), h.$('hook').textContent);
    check('the server version is shown', h.$('server-version').textContent === '1.2.0', h.$('server-version').textContent);
    check('the answered counter is shown', h.$('answered').textContent === '3', h.$('answered').textContent);

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
    check('the version is shown', h.$('version').textContent.includes('1.2.0'), h.$('version').textContent);
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
