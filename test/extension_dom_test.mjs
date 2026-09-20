/**
 * ArenaAgentBridge - test/extension_dom_test.mjs
 * ---------------------------------------------------------------------------
 * Runs extension/content.js inside jsdom against a *simulated* arena.ai chat
 * page and checks the automation pipeline end to end:
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
const EXT = path.join(ROOT, 'extension');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (_) {
  console.log('SKIP: jsdom is not installed (run `npm install --no-save jsdom`)');
  process.exit(0);
}

const CONFIG_SRC = readFileSync(path.join(EXT, 'config.js'), 'utf8');
const CONTENT_SRC = readFileSync(path.join(EXT, 'content.js'), 'utf8');

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
function installChromeStub(window, { granted = true } = {}) {
  const sent = [];
  const listeners = [];
  const runtime = {
    lastError: undefined,
    getManifest: () => ({ version: '1.0.0' }),
    getURL: (file) => `chrome-extension://aabtest/${file}`,
    connect: () => ({ postMessage() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} } }),
    sendMessage: (message, callback) => {
      sent.push(message);
      if (callback) {
        if (message.kind === 'claim') callback({ granted, ownerTabId: granted ? 7 : 3, leaseMs: 60000 });
        else if (message.kind === 'popup-state') callback({ ok: true });
        else callback({ ok: true });
      }
      return Promise.resolve({ ok: true });
    },
    onMessage: { addListener: (fn) => listeners.push(fn) },
  };
  window.chrome = { runtime, storage: { local: { get: (keys, cb) => cb({}) } } };
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

async function createHarness({ site = {}, config = {}, granted = true } = {}) {
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

  const chrome = installChromeStub(window, { granted });
  const ws = installWebSocketStub(window);

  window.__AAB_CONFIG__ = { ...FAST_CONFIG, ...config };
  window.eval(CONFIG_SRC);
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
