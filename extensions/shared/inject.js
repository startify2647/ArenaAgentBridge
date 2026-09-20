/**
 * ArenaAgentBridge - extensions/shared/inject.js
 * ---------------------------------------------------------------------------
 * Runs in the PAGE world (MAIN world) because content scripts cannot touch the
 * page's `window.WebSocket`.
 *
 * It only *observes* the site's own network activity - it does not send
 * anything anywhere. Every frame that looks like an SSE/streaming payload is
 * forwarded to the content script with `window.postMessage`, which uses it to
 * detect the exact moment a generation starts and ends (much faster and more
 * reliable than guessing from the DOM alone).
 */
(function () {
  'use strict';

  if (window.__AAB_INJECTED__) return;
  window.__AAB_INJECTED__ = true;

  const CHANNEL = 'arena-agent-bridge';
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
        if (interesting) post('ws-open', { id, url: ws.url, label });
      });

      ws.addEventListener('message', (event) => {
        if (!interesting) return;
        const data = typeof event.data === 'string' ? event.data : null;
        if (!data) return;
        post('ws-message', { id, url: ws.url, label, data: data.slice(0, 20000) });
      });

      ws.addEventListener('close', () => {
        if (interesting) post('ws-close', { id, url: ws.url, label });
      });

      ws.addEventListener('error', () => {
        if (interesting) post('ws-error', { id, url: ws.url, label });
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
  // ---------------------------------------------------------------------
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function patchedFetch(input, init) {
      const url = typeof input === 'string' ? input : input && input.url;
      const promise = nativeFetch.apply(this, arguments);
      if (!looksInteresting(url)) return promise;

      const id = ++counter;
      return promise.then((response) => {
        try {
          if (!response || !response.body || typeof response.body.tee !== 'function') return response;
          const [forPage, forUs] = response.body.tee();
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
          return new Response(forPage, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        } catch (_) {
          return response;
        }
      });
    };
  }

  post('ready', { url: location.href, captured: ['WebSocket', 'EventSource', 'fetch'] });
})();
