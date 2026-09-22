/**
 * ArenaAgentBridge - extensions/shared/inject.js
 * ---------------------------------------------------------------------------

 * Runs in the PAGE world (MAIN world) because content scripts cannot touch the
 * page's `window.WebSocket`.
 *
 * It only *observes* the site's own network activity - it does not send
 * anything anywhere.  While a bridge request is in flight (the content script
 * marks the document with `data-aab-capture`) every frame that looks like an
 * SSE/streaming payload is forwarded to the content script with
 * `window.postMessage`, which uses it to detect the exact moment a generation
 * starts and ends (much faster and more reliable than guessing from the DOM
 * alone).
 *
 * While no request is running the hook stays silent: the site's traffic is not
 * duplicated, parsed or forwarded, so normal browsing with the extension
 * installed costs (almost) nothing.
 */
(function () {
  'use strict';

  if (window.__AAB_INJECTED__) return;

  /**
   * DORMANT ON NON-AGENT PAGES.  The content script runs just before us (same
   * manifest order, isolated world) and marks the agent page with
   * `data-aab-agent`; we also accept the current path so runtime re-injection
   * and tests work without the marker.  On every other arena.ai page we wrap
   * nothing and announce nothing - wrapping WebSocket/EventSource/fetch there
   * would tax every single page request for a hook nobody is listening to.
   *
   * Note the deliberate order: `__AAB_INJECTED__` is set only AFTER the gate,
   * so a page that starts dormant can still be fully hooked later (SPA
   * navigation to /agent triggers a runtime re-injection of this file).
   */
  let agentPage = false;
  try {
    agentPage = document.documentElement.hasAttribute('data-aab-agent');
  } catch (_) {
    /* no DOM yet */
  }
  if (!agentPage) {
    try {
      const path = location.pathname || '';
      agentPage = path === '/agent' || path.startsWith('/agent/');
    } catch (_) {
      agentPage = true; // cannot tell: keep the old always-on behaviour
    }
  }
  if (!agentPage) return;

  window.__AAB_INJECTED__ = true;

  const CHANNEL = 'arena-agent-bridge';
  const CAPTURE_FLAG = 'data-aab-capture';
  const NativeWebSocket = window.WebSocket;
  const NativeEventSource = window.EventSource;

  let counter = 0;

  function post(kind, payload) {
    try {
      window.postMessage({ source: CHANNEL, kind, ...payload }, window.location.origin);
    } catch (_) {
      /* ignore cross-origin / cloning errors */
    }
  }

  /**
   * The content script sets <html data-aab-capture> for the duration of one
   * bridge request.  Checking an attribute is free - no listener, no polling.
   */
  function captureWanted() {
    try {
      return document.documentElement.hasAttribute(CAPTURE_FLAG);
    } catch (_) {
      return true; // cannot tell: keep the old always-on behaviour
    }
  }

  function looksInteresting(url) {
    if (!url) return false;
    const text = String(url);
    return (
      /arena\.ai/i.test(text) ||
      /\/api\//i.test(text) ||
      /\/chat/i.test(text) ||
      /completion/i.test(text) ||
      /stream/i.test(text) ||
      /\/v\d\//i.test(text)
    );
  }

  // ---------------------------------------------------------------------
  // WebSocket hook
  // ---------------------------------------------------------------------
  function attach(ws, label) {
    const id = ++counter;
    let interesting = false;

    try {
      ws.addEventListener('open', () => {
        interesting = looksInteresting(ws.url);
        if (interesting && captureWanted()) post('ws-open', { id, url: ws.url, label });
      });

      ws.addEventListener('message', (event) => {
        if (!interesting || !captureWanted()) return;
        const data = typeof event.data === 'string' ? event.data : null;
        if (!data) return;
        post('ws-message', { id, url: ws.url, label, data: data.slice(0, 20000) });
      });

      ws.addEventListener('close', () => {
        if (interesting && captureWanted()) post('ws-close', { id, url: ws.url, label });
      });

      ws.addEventListener('error', () => {
        if (interesting && captureWanted()) post('ws-error', { id, url: ws.url, label });
      });
    } catch (_) {
      /* a page could freeze/replace the object; ignore */
    }
  }

  function PatchedWebSocket(url, protocols) {
    const ws = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
    attach(ws, 'WebSocket');
    return ws;
  }

  PatchedWebSocket.prototype = NativeWebSocket.prototype;
  for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
    PatchedWebSocket[key] = NativeWebSocket[key];
  }
  window.WebSocket = PatchedWebSocket;

  // ---------------------------------------------------------------------
  // EventSource hook (some endpoints use plain SSE)
  // ---------------------------------------------------------------------
  if (typeof NativeEventSource === 'function') {
    function PatchedEventSource(url, config) {
      const source = config === undefined ? new NativeEventSource(url) : new NativeEventSource(url, config);
      const id = ++counter;
      try {
        source.addEventListener('message', (event) => {
          if (!captureWanted()) return;
          if (typeof event.data === 'string' && looksInteresting(url)) {
            post('ws-message', { id, url: String(url), label: 'EventSource', data: event.data });
          }
        });
      } catch (_) {
        /* ignore */
      }
      return source;
    }
    PatchedEventSource.prototype = NativeEventSource.prototype;
    window.EventSource = PatchedEventSource;
  }

  // ---------------------------------------------------------------------
  // fetch hook - the site may stream with fetch + ReadableStream, in which
  // case we tap the body without touching the response the page receives.
  // The page's branch of the tee()d stream is swapped into the original
  // response object (a fresh `new Response(...)` would lose `url`, `type`,
  // `redirected` and header normalisation, which real apps do depend on).
  // ---------------------------------------------------------------------
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function patchedFetch(input, init) {
      const url = typeof input === 'string' ? input : input && input.url;
      const promise = nativeFetch.apply(this, arguments);
      if (!looksInteresting(url) || !captureWanted()) return promise;

      const id = ++counter;
      return promise.then((response) => {
        try {
          if (!response || !response.body || typeof response.body.tee !== 'function') return response;
          if (!captureWanted()) return response; // the request ended meanwhile
          const [forPage, forUs] = response.body.tee();
          Object.defineProperty(response, 'body', {
            value: forPage,
            configurable: true,
            enumerable: true,
            writable: false,
          });
          const reader = forUs.getReader();
          const decoder = new TextDecoder();
          post('ws-open', { id, url: String(url), label: 'fetch' });
          (function pump() {
            reader
              .read()
              .then(({ done, value }) => {
                if (done) {
                  post('ws-close', { id, url: String(url), label: 'fetch' });
                  return;
                }
                if (!captureWanted()) {
                  // nobody is listening anymore: stop our copy of the stream
                  try {
                    reader.cancel().catch(() => {});
                  } catch (_) {
                    /* ignore */
                  }
                  return;
                }
                post('ws-message', {
                  id,
                  url: String(url),
                  label: 'fetch',
                  data: decoder.decode(value, { stream: true }).slice(0, 20000),
                });
                pump();
              })
              .catch(() => post('ws-close', { id, url: String(url), label: 'fetch' }));
          })();
          return response;
        } catch (_) {
          return response;
        }
      });
    };
  }

  post('ready', { url: location.href, captured: ['WebSocket', 'EventSource', 'fetch'] });
})();
