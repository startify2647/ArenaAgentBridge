/**
 * ArenaAgentBridge - extensions/shared/content.js
 * ---------------------------------------------------------------------------
 * Runs on https://arena.ai/* (document_start) and owns the WebSocket to the
 * local bridge (ws://127.0.0.1:8000/ws/browser).
 *
 * Per request it:
 *   1. checks that the tab is usable (logged in, no captcha),
 *   2. types the prompt the way React expects (native setter + `input` event),
 *   3. clicks Send (or presses Enter) and confirms the site accepted it,
 *   4. watches the DOM - and the site's own SSE stream, see inject.js - until
 *      the answer stops changing,
 *   5. reports `{id, response, error, meta}` back to the server.
 *
 * Everything site-specific lives in config.js (defaults) and settings.js
 * (user overrides, applied at boot and on `{kind:'reload-settings'}`); use the
 * popup's "Diagnose DOM" button - or the admin panel's Browser tab - when a
 * selector stops matching.
 *
 * Design notes
 *   - Exactly one tab may hold the bridge connection: the background worker
 *     hands out a lease (`kind:'claim'`), other tabs stay in standby.
 *   - Detection is event driven (MutationObserver + captured stream frames) with
 *     a timer as a backstop, so background tabs are not slowed down by Chrome's
 *     timer throttling.
 *   - Message text is extracted lazily and cached per element, so a very long
 *     conversation is not re-parsed on every tick.
 */
(function () {
  'use strict';

  const CFG = window.__AAB_CONFIG__ || {};
  const LOG_PREFIX = '[ArenaAgentBridge]';

  // -------------------------------------------------------------------------
  // utilities
  // -------------------------------------------------------------------------
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function log(...args) {
    if (CFG.debug && CFG.debug.VERBOSE) console.log(LOG_PREFIX, ...args);
  }

  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }

  function truncate(text, max) {
    if (typeof text !== 'string') return text;
    const limit = max || (CFG.debug && CFG.debug.MAX_LOG_CHARS) || 300;
    return text.length > limit ? `${text.slice(0, limit)}…(${text.length} chars)` : text;
  }

  const escapeRegExp = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.offsetWidth === 0 && el.offsetHeight === 0) {
      const rect = el.getBoundingClientRect && el.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return false;
    }
    // checkVisibility() is the cheap, engine-side test (no style recalc);
    // the manual fallback keeps very old browsers - and jsdom - working.
    if (typeof el.checkVisibility === 'function') {
      try {
        return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      } catch (_) {
        /* fall through to the computed style */
      }
    }
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
    return true;
  }

  function isEnabled(el) {
    return !(el.disabled || el.getAttribute('aria-disabled') === 'true');
  }

  function matchesText(el, needles) {
    if (!needles || !needles.length) return true;
    // textContent (not innerText): innerText forces layout, and this runs on
    // every button of the page several times per capture tick.
    const text = String(el.getAttribute('aria-label') || el.textContent || '')
      .trim()
      .toLowerCase()
      .slice(0, 200);
    return needles.some((needle) => text.includes(String(needle).toLowerCase()));
  }

  /** Resolve one selector entry (`'css'` or `{css, text, tag}`). */
  function querySelectorEntry(entry, { visible = true, enabled = false } = {}) {
    const spec = typeof entry === 'string' ? { css: entry } : entry || {};
    if (!spec.css) return null;
    let nodes;
    try {
      nodes = document.querySelectorAll(spec.css);
    } catch (_) {
      return null;
    }
    for (const el of nodes) {
      if (spec.tag && el.tagName.toLowerCase() !== String(spec.tag).toLowerCase()) continue;
      // cheap text match first, visibility (style/layout) only for survivors
      if (!matchesText(el, spec.text)) continue;
      if (visible && !isVisible(el)) continue;
      if (enabled && !isEnabled(el)) continue;
      return el;
    }
    return null;
  }

  function findFirst(entries, options) {
    for (const entry of entries || []) {
      const el = querySelectorEntry(entry, options);
      if (el) return el;
    }
    return null;
  }

  function countMatches(entries) {
    let total = 0;
    for (const entry of entries || []) {
      const css = typeof entry === 'string' ? entry : entry && entry.css;
      if (!css) continue;
      try {
        total += document.querySelectorAll(css).length;
      } catch (_) {
        /* runtime override with an invalid selector */
      }
    }
    return total;
  }

  async function waitFor(predicate, { timeout = 5000, interval = 150 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = predicate();
      if (value) return value;
      await sleep(interval);
    }
    return null;
  }

  function sendToBackground(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (reply) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(reply || null);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  // -------------------------------------------------------------------------
  // DOM -> markdown
  // -------------------------------------------------------------------------
  function shouldIgnore(el) {
    for (const css of (CFG.selectors && CFG.selectors.ignoreInside) || []) {
      try {
        if (el.matches && el.matches(css)) return true;
      } catch (_) {
        /* bad selector in a runtime override */
      }
    }
    return false;
  }

  function matchesAny(el, list) {
    for (const css of list || []) {
      try {
        if (el.matches && el.matches(css)) return true;
      } catch (_) {
        /* bad selector in a runtime override */
      }
    }
    return false;
  }

  function nodeToMarkdown(node, depth = 0) {
    if (!node) return '';
    if (depth > 60) return '';
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const el = node;
    if (shouldIgnore(el)) return '';

    const tag = el.tagName.toLowerCase();
    const children = () =>
      Array.from(el.childNodes)
        .map((child) => nodeToMarkdown(child, depth + 1))
        .join('');

    switch (tag) {
      case 'br':
        return '\n';
      case 'hr':
        return '\n---\n';
      case 'script':
      case 'style':
      case 'noscript':
      case 'svg':
      case 'button':
        return '';
      case 'pre': {
        const codeEl = el.querySelector('code') || el;
        const className = String(codeEl.className || '');
        const match = className.match(/language-([\w+#.-]+)/);
        const code = (codeEl.innerText || codeEl.textContent || '').replace(/\n+$/, '');
        return `\n\`\`\`${match ? match[1] : ''}\n${code}\n\`\`\`\n\n`;
      }
      case 'code': {
        const text = el.textContent || '';
        return text.includes('\n') ? `\n\`\`\`\n${text}\n\`\`\`\n` : `\`${text}\``;
      }
      case 'kbd':
        return `\`${el.textContent || ''}\``;
      case 'strong':
      case 'b': {
        const text = children().trim();
        return text ? `**${text}**` : '';
      }
      case 'em':
      case 'i': {
        const text = children().trim();
        return text ? `*${text}*` : '';
      }
      case 'del':
      case 's': {
        const text = children().trim();
        return text ? `~~${text}~~` : '';
      }
      case 'a': {
        const text = children().trim();
        const href = el.getAttribute('href') || '';
        if (!text) return href ? `<${href}>` : '';
        return href && /^https?:/i.test(href) && !text.includes(href) ? `[${text}](${href})` : text;
      }
      case 'img':
        return `![${el.getAttribute('alt') || 'image'}]()`;
      case 'li': {
        const text = children().trim();
        const ordered = el.parentElement && el.parentElement.tagName.toLowerCase() === 'ol';
        return text ? `${ordered ? '1.' : '-'} ${text}\n` : '';
      }
      case 'ul':
      case 'ol':
        return `\n${children()}\n`;
      case 'blockquote': {
        const text = children().trim();
        return text ? `\n${text.split('\n').map((line) => `> ${line}`).join('\n')}\n\n` : '';
      }
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        const text = children().trim();
        return text ? `\n${'#'.repeat(Number(tag[1]))} ${text}\n\n` : '';
      }
      case 'tr': {
        const cells = Array.from(el.children).map((cell) => nodeToMarkdown(cell, depth + 1).trim());
        return `| ${cells.join(' | ')} |\n`;
      }
      case 'table':
      case 'p':
      case 'div':
      case 'section':
      case 'article':
      case 'main': {
        // children() walks the whole subtree: compute it once, never twice.
        const text = children();
        const trimmed = text.trim();
        return trimmed ? `${trimmed}\n\n` : '';
      }
      case 'span':
      case 'label':
      case 'td':
      case 'th':
        return children();
      default:
        return children();
    }
  }

  /** First plausible text field of a stream payload (tolerant to shape). */
  function firstTextField(value, depth) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if ((depth || 0) > 6) return '';
    if (Array.isArray(value)) {
      return value.map((item) => firstTextField(item, (depth || 0) + 1)).join('');
    }
    const keys = ['text', 'content', 'delta', 'value', 'message', 'answer', 'data'];
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const found = firstTextField(value[key], (depth || 0) + 1);
        if (found) return found;
      }
    }
    return '';
  }

  function normaliseMarkdown(text) {
    return String(text || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .split('\n')
      .map((line) => line.replace(/[ \t]{2,}/g, ' ').replace(/\s+$/, ''))
      .join('\n')
      .trim();
  }

  function extractText(el) {
    if (!el) return '';
    try {
      const markdown = normaliseMarkdown(nodeToMarkdown(el));
      if (markdown) return markdown;
    } catch (error) {
      warn('markdown extraction failed, falling back to innerText', error);
    }
    return normaliseMarkdown(el.innerText || el.textContent || '');
  }

  /** Lazily convert a message element, cached until its raw text changes. */
  const textCache = new WeakMap();
  function messageText(el) {
    const raw = el.textContent || '';
    const cached = textCache.get(el);
    if (cached && cached.raw === raw) return cached.text;
    const text = extractText(el);
    textCache.set(el, { raw, text });
    return text;
  }

  // -------------------------------------------------------------------------
  // Stream capture (fed by inject.js in the page world)
  //
  // Cost model: every frame is parsed exactly once, when it arrives, and the
  // per-request aggregate is updated incrementally.  A capture tick therefore
  // reads a snapshot instead of re-parsing the whole frame buffer - the old
  // behaviour was O(frames x text) per tick and made long answers burn CPU on
  // every poll, which the page visibly felt as lag.
  //
  // While no bridge request is in flight the page hook stops forwarding the
  // site's traffic entirely (see the `data-aab-capture` flag in inject.js), and
  // only a short diagnostic tail of frames is kept in memory.
  // -------------------------------------------------------------------------
  const StreamCapture = {
    frames: [],
    lastActivityAt: 0,
    lastRelevantAt: 0,
    installed: false,
    urlPattern: null,
    hookReady: false,
    hookReadyAt: 0,
    hookSource: null,
    /** aggregate of the request currently in flight (null while idle) */
    active: null,
    /** DOM attribute the page-world hook checks before forwarding traffic */
    FLAG: (CFG.capture && CFG.capture.CAPTURE_FLAG) || 'data-aab-capture',

    install() {
      if (this.installed) return;
      this.installed = true;
      try {
        this.urlPattern = new RegExp((CFG.capture && CFG.capture.URL_FILTER) || '.', 'i');
      } catch (_) {
        this.urlPattern = /.*/i;
      }
      window.addEventListener('message', (event) => {
        const data = event.data;
        // `event.source` is the posting window; Chrome sets it for same-window
        // postMessage, other environments (test harnesses) may leave it null.
        if (!data || data.source !== 'arena-agent-bridge') return;
        if (event.source && event.source !== window) return; // ignore other frames
        if (data.kind === 'ws-message') {
          this.push(data.url, data.data, data.label);
        } else if (data.kind === 'ws-open') {
          this.lastActivityAt = Date.now();
          Signal.notify();
        } else if (data.kind === 'ready') {
          this.hookReady = true;
          this.hookReadyAt = Date.now();
          this.hookSource = data.captured ? data.captured.join('+') : 'unknown';
          log('page-world stream hook ready', data.url);
          Signal.notify();
        }
      });
    },

    isRelevant(url) {
      if (!url) return false;
      return this.urlPattern ? this.urlPattern.test(String(url)) : true;
    },

    /** True while a bridge request is in flight (the page hook asks the same). */
    capturing() {
      return Boolean(this.active);
    },

    setFlag(on) {
      try {
        const root = document.documentElement;
        if (!root) return;
        if (on) root.setAttribute(this.FLAG, '1');
        else root.removeAttribute(this.FLAG);
      } catch (_) {
        /* not a DOM environment */
      }
    },

    /**
     * Pull the answer text out of one frame body (without its `a0:` prefix).
     *
     * The site sends one text chunk per frame; the payload is either plain text
     * or a small JSON object.  We do not depend on the exact schema: known
     * shapes are unwrapped, anything else is used verbatim.
     */
    frameText(body, prefixMain) {
      let payload = body.slice(prefixMain.length).trim();
      if (!payload) return '';
      if (payload.charAt(0) === '{' || payload.charAt(0) === '[') {
        try {
          const parsed = JSON.parse(payload);
          payload = firstTextField(parsed);
        } catch (_) {
          /* not JSON after all - use it as it came */
        }
      }
      return payload === null || payload === undefined ? '' : String(payload);
    },

    /**
     * Parse one captured frame once.  The result is cached on the frame, so
     * even a re-parse (only possible after a prefix re-lock) is one pass.
     */
    parseFrame(frame, agg) {
      const capture = CFG.capture || {};
      let prefixMain = (agg && agg.prefixMain) || capture.PREFIX_MAIN || 'a0:';
      if (frame.parsed && frame.parsed.prefix === prefixMain) return frame.parsed.result;
      const prefixReason = capture.PREFIX_REASONING || 'ag:';
      const prefixData = capture.PREFIX_DATA || 'ad:';
      const lines = String(frame.data || '').split(/\r?\n/);

      // The site may rotate its stream prefixes (`a0:` -> `a1:`/`b0:`/…).
      // While nothing matched the configured main prefix yet, adopt the first
      // letter+digit prefix that carries a recognisable text payload.
      if (agg && !agg.prefixLocked) {
        let hasConfigured = false;
        let candidate = '';
        for (const line of lines) {
          const body = line.replace(/^data:\s*/, '').trim();
          if (!body) continue;
          if (body.startsWith(prefixMain)) {
            hasConfigured = true;
            break;
          }
          const found = /^([a-z]\d):/i.exec(body);
          if (found && !body.startsWith(prefixReason) && !body.startsWith(prefixData) && !candidate) {
            const rest = body.slice(found[0].length).trim();
            if (rest.charAt(0) === '{' || rest.charAt(0) === '[') {
              try {
                if (firstTextField(JSON.parse(rest))) candidate = found[1] + ':';
              } catch (_) {
                /* not a JSON text frame - not a candidate either */
              }
            } else if (rest) {
              candidate = found[1] + ':';
            }
          }
        }
        if (hasConfigured || candidate) {
          if (!hasConfigured && candidate) {
            agg.prefixMain = candidate;
            prefixMain = candidate;
          }
          agg.prefixLocked = true;
        }
      }

      let mainChars = 0;
      let reasoningChars = 0;
      let text = '';
      let sawDone = false;
      let sawError = false;
      for (const line of lines) {
        const body = line.replace(/^data:\s*/, '').trim();
        if (!body) continue;
        if (body === '[DONE]' || /"type"\s*:\s*"done"|"finish_reason"\s*:\s*"(stop|end_turn)"/.test(body)) {
          sawDone = true;
        }
        if (/"error\s*":/.test(body)) sawError = true;
        if (body.startsWith(prefixMain)) {
          mainChars += body.length - prefixMain.length;
          const piece = this.frameText(body, prefixMain);
          if (piece) {
            // A chunk can be a rewrite (the site re-sends the whole text) or an
            // append; `startsWith` tells them apart without the DOM.
            if (text && piece.startsWith(text)) text = piece;
            else text += piece;
          }
        } else if (body.startsWith(prefixReason)) {
          reasoningChars += body.length - prefixReason.length;
        }
      }
      const result = { mainChars, reasoningChars, text, sawDone, sawError };
      frame.parsed = { prefix: prefixMain, result };
      return result;
    },

    /** Fold one frame into the running request aggregate. */
    absorb(frame, agg) {
      const parsed = this.parseFrame(frame, agg);
      const limit = (CFG.capture && CFG.capture.MAX_TEXT_CHARS) || 200000;
      agg.frames += 1;
      agg.mainChars += parsed.mainChars;
      agg.reasoningChars += parsed.reasoningChars;
      if (!agg.firstAt) agg.firstAt = frame.at;
      agg.lastAt = frame.at;
      if (parsed.sawDone) agg.sawDone = true;
      if (parsed.sawError) agg.sawError = true;
      if (parsed.text) {
        if (agg.text.length < limit) {
          if (agg.text && parsed.text.startsWith(agg.text)) agg.text = parsed.text;
          else agg.text += parsed.text;
        } else {
          agg.textTruncated = true;
        }
      }
    },

    push(url, data, label) {
      if (!this.isRelevant(url)) return;
      const now = Date.now();
      const frame = { at: now, url: String(url), label: label || '', data: String(data || '').slice(0, 20000) };
      const agg = this.active;
      if (agg) this.absorb(frame, agg);
      this.frames.push(frame);
      const max = agg
        ? (CFG.capture && CFG.capture.MAX_FRAMES) || 200
        : (CFG.capture && CFG.capture.IDLE_TAIL_FRAMES) || 16;
      if (this.frames.length > max) this.frames.splice(0, this.frames.length - max);
      this.lastActivityAt = now;
      this.lastRelevantAt = now;
      Signal.notify();
    },

    /** Start the per-request aggregate; returns the mark for this request. */
    beginRequest() {
      const capture = CFG.capture || {};
      const now = Date.now();
      const agg = {
        beganAt: now,
        prefixMain: capture.PREFIX_MAIN || 'a0:',
        prefixLocked: false,
        frames: 0,
        mainChars: 0,
        reasoningChars: 0,
        text: '',
        textTruncated: false,
        firstAt: 0,
        lastAt: 0,
        sawDone: false,
        sawError: false,
      };
      // Absorb frames that arrived just before the request (submit slop), the
      // way the old `framesSince(mark)` filter did with its 500 ms window.
      for (const frame of this.frames) {
        if (frame.at < now - 500) continue;
        this.absorb(frame, agg);
      }
      this.active = agg;
      this.setFlag(true);
      return { at: now, index: this.frames.length };
    },

    /** End the request: stop the page hook, keep only a diagnostic tail. */
    endRequest() {
      this.active = null;
      this.setFlag(false);
      const tail = (CFG.capture && CFG.capture.IDLE_TAIL_FRAMES) || 16;
      if (this.frames.length > tail) this.frames.splice(0, this.frames.length - tail);
    },

    mark() {
      return { at: Date.now(), index: this.frames.length };
    },

    /**
     * Snapshot of the stream belonging to the request in flight (or, when
     * idle, of the retained diagnostic tail).
     *
     * `text` is the answer as the site's own stream reported it.  It is the
     * fallback when the DOM does not expose the answer element (markup change,
     * shadow DOM): without it the bridge would wait forever while the answer
     * visibly streams in the page.
     */
    summary(mark) {
      const agg = this.active;
      if (agg) {
        return {
          frames: agg.frames,
          mainChars: agg.mainChars,
          reasoningChars: agg.reasoningChars,
          text: agg.text,
          textTruncated: agg.textTruncated,
          firstAt: agg.firstAt,
          lastAt: agg.lastAt,
          idleMs: agg.lastAt ? Date.now() - agg.lastAt : null,
          sawDone: agg.sawDone,
          sawError: agg.sawError,
        };
      }
      // diagnostics: aggregate whatever is retained (no request running)
      const frames = this.frames.slice(-20);
      const summary = {
        frames: frames.length,
        mainChars: 0,
        reasoningChars: 0,
        text: '',
        textTruncated: false,
        firstAt: 0,
        lastAt: 0,
        idleMs: null,
        sawDone: false,
        sawError: false,
      };
      for (const frame of frames) {
        const parsed = this.parseFrame(frame, null);
        summary.mainChars += parsed.mainChars;
        summary.reasoningChars += parsed.reasoningChars;
        if (parsed.text) summary.text += parsed.text;
        if (parsed.sawDone) summary.sawDone = true;
        if (parsed.sawError) summary.sawError = true;
        if (!summary.firstAt) summary.firstAt = frame.at;
        summary.lastAt = frame.at;
      }
      if (summary.lastAt) summary.idleMs = Date.now() - summary.lastAt;
      return summary;
    },
  };

  // -------------------------------------------------------------------------
  // Signal: event-driven wake-ups (DOM mutations + stream frames) with a timer
  // backstop, so nothing depends on a 300 ms poll being throttled-proof.
  // -------------------------------------------------------------------------
  const Signal = {
    observer: null,
    waiters: [],
    lastNotifyAt: 0,
    trailingTimer: null,
    minInterval: 150,

    start() {
      if (this.observer) return;
      try {
        this.observer = new MutationObserver(() => this.notify());
        this.observer.observe(document.documentElement || document, {
          subtree: true,
          childList: true,
          characterData: true,
        });
      } catch (error) {
        warn('MutationObserver unavailable', error);
      }
    },

    stop() {
      if (this.observer) {
        this.observer.disconnect();
        this.observer = null;
      }
      if (this.trailingTimer) {
        clearTimeout(this.trailingTimer);
        this.trailingTimer = null;
      }
      this.waiters.length = 0;
    },

    notify() {
      const now = Date.now();
      const elapsed = now - this.lastNotifyAt;
      if (elapsed < this.minInterval) {
        if (!this.trailingTimer) {
          this.trailingTimer = setTimeout(() => {
            this.trailingTimer = null;
            this.flush();
          }, this.minInterval - elapsed);
        }
        return;
      }
      this.flush();
    },

    flush() {
      this.lastNotifyAt = Date.now();
      // DOM activity is site activity: keep the bridge socket alive even when
      // the tab's timers are throttled (see Transport.touch).
      try {
        Bridge.touch('dom');
      } catch (_) {
        /* Bridge is not constructed yet during boot */
      }
      const waiters = this.waiters.splice(0, this.waiters.length);
      for (const resolve of waiters) resolve();
    },

    /** Wait for the next DOM/stream event, or `timeout` ms, whichever first. */
    wait(timeout) {
      return new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, timeout);
        this.waiters.push(finish);
      });
    },
  };

  // -------------------------------------------------------------------------
  // Site driver
  // -------------------------------------------------------------------------
  const SiteDriver = {
    selectors() {
      return CFG.selectors || {};
    },

    findInput() {
      // Prefer a visible box, but fall back to any match: some layouts keep the
      // real editor at zero size until it is focused.
      return (
        findFirst(this.selectors().input, { visible: true }) ||
        findFirst(this.selectors().input, { visible: false })
      );
    },

    findSendButton() {
      const entries = this.selectors().sendButton || [];
      return findFirst(entries, { visible: true, enabled: true }) || findFirst(entries, { visible: true });
    },

    findStopButton() {
      return findFirst(this.selectors().stopButton, { visible: true });
    },

    findNewChatButton() {
      return findFirst(this.selectors().newChat, { visible: true });
    },

    /** The "Keep working" button of the post-answer survey (agent mode). */
    findKeepWorking() {
      return findFirst(this.selectors().keepWorking, { visible: true, enabled: true }) ||
        findFirst(this.selectors().keepWorking, { visible: true });
    },

    /** The poll container - only used to know that a survey is on screen. */
    findSurvey() {
      const own = findFirst(this.selectors().survey, { visible: true });
      if (own) return own;
      return this.findKeepWorking();
    },

    hasSurvey() {
      return Boolean(this.findKeepWorking() || findFirst(this.selectors().survey, { visible: true }));
    },

    /**
     * Click "Keep working" so the composer is free for the next prompt.
     *
     * @param {{waitMs?: number}} options
     * @returns {Promise<{found: boolean, clicked: boolean, waitedMs: number}>}
     */
    async acceptKeepWorking(options) {
      const opts = options || {};
      const waitMs = Math.max(0, opts.waitMs || 0);
      const startedAt = Date.now();
      let button = this.findKeepWorking();
      while (!button && Date.now() - startedAt < waitMs) {
        await sleep(200);
        button = this.findKeepWorking();
      }
      if (!button) return { found: false, clicked: false, waitedMs: Date.now() - startedAt };

      const label = truncate(messageText(button) || button.getAttribute('aria-label') || 'keep working', 40);
      this.click(button);
      log('clicked the survey option "%s"', label);

      // Wait until the survey is gone (the site usually swaps the composer back).
      const gone = await waitFor(() => !this.findKeepWorking(), { timeout: 6000, interval: 200 });
      return { found: true, clicked: true, cleared: Boolean(gone), label };
    },

    hasCaptcha() {
      return Boolean(findFirst(this.selectors().captcha));
    },

    isLoggedOut() {
      for (const entry of this.selectors().loginWall || []) {
        const spec = typeof entry === 'string' ? { css: entry } : entry || {};
        if (!spec.css) continue;
        let nodes;
        try {
          nodes = document.querySelectorAll(spec.css);
        } catch (_) {
          continue;
        }
        for (const el of nodes) {
          if (!isVisible(el)) continue;
          const text = (el.innerText || el.textContent || '').trim().toLowerCase().slice(0, 80);
          if (/^(sign in|log in|login|sign up|continue with (google|github|email))$/.test(text)) return true;
        }
      }
      return false;
    },

    /** Every message node in document order, with a best-effort role (no text). */
    readMessages() {
      const s = this.selectors();
      const joined = []
        .concat(s.messageRoleAny || [])
        .concat(s.assistantMessage || [])
        .concat(s.messageGeneric || [])
        .map((entry) => (typeof entry === 'string' ? entry : entry && entry.css))
        .filter(Boolean)
        .join(', ');
      if (!joined) return [];

      let nodes;
      try {
        nodes = Array.from(document.querySelectorAll(joined));
      } catch (_) {
        return [];
      }

      const set = new Set(nodes);
      const filtered = nodes.filter((el) => {
        let parent = el.parentElement;
        while (parent) {
          if (set.has(parent)) return false; // nested duplicate
          parent = parent.parentElement;
        }
        return true;
      });

      return filtered.map((el) => ({ el, role: this.roleOf(el) }));
    },

    roleOf(el) {
      // arena.ai agent transcript markup: every turn is a
      // `[data-agent-transcript-message]` node (`data-chat-message-id`); user
      // turns wrap their body in `[data-user-message-layout]` /
      // `[data-user-message-body-row]`, assistant turns do not (their text is
      // animated in through `[data-agent-word]` spans).
      if (el.querySelector && el.querySelector('[data-user-message-layout], [data-user-message-body-row]')) {
        return 'user';
      }
      if (el.hasAttribute && el.hasAttribute('data-agent-transcript-message')) return 'assistant';
      const attr =
        el.getAttribute('data-message-author-role') ||
        el.getAttribute('data-role') ||
        el.getAttribute('data-author') ||
        el.getAttribute('data-testid');
      if (attr) {
        const value = String(attr).toLowerCase();
        if (value.includes('assistant') || value.includes('agent') || value.includes('model')) return 'assistant';
        if (value.includes('user') || value.includes('human')) return 'user';
      }
      const className = String(el.className || '');
      if (/assistant|agent-response|model-response|bot-?message/i.test(className)) return 'assistant';
      if (/user|human|prompt/i.test(className)) return 'user';
      if (el.querySelector('[data-message-author-role="assistant"], [data-role="assistant"]')) return 'assistant';
      return 'unknown';
    },

    /**
     * Short probes of the typed prompt used to recognise the site echoing it
     * back.  Agent mode pastes the whole built transcript, so both its head
     * and its tail appear in the user bubble; direct mode short prompts are
     * deliberately not fingerprinted (too short to be unambiguous).
     */
    promptFingerprints(promptText) {
      const text = String(promptText || '').trim();
      if (text.length < 24) return [];
      const out = [text.slice(0, 160)];
      const tail = text.slice(-160);
      if (tail.length >= 24 && tail !== out[0]) out.push(tail);
      return out;
    },

    /**
     * Assistant message elements.
     *
     * Fast path (hot - runs on every capture tick): query ONLY the dedicated
     * assistant/role selectors and test non-emptiness in O(1)
     * (`childElementCount`), so an idle tab costs two selector passes instead
     * of the old full three-selector join plus a `textContent` scan of every
     * message on the page.  That old scan of a long conversation several
     * times a second is what made the extension feel heavy (especially in
     * Firefox, where layout/text work is pricier).
     *
     * Slow path (only when the fast selectors hit nothing - e.g. a redesigned
     * markup): the old behaviour, including the fingerprint fallback.
     */
    assistantElements(promptText) {
      const s = this.selectors();
      const fast = []
        .concat(s.assistantMessage || [])
        .concat(s.messageRoleAny || [])
        .map((entry) => (typeof entry === 'string' ? entry : entry && entry.css))
        .filter(Boolean)
        .join(', ');
      if (fast) {
        let nodes = null;
        try {
          nodes = Array.from(document.querySelectorAll(fast));
        } catch (_) {
          nodes = null; // a runtime override with an invalid selector
        }
        if (nodes && nodes.length) {
          const set = new Set(nodes);
          const assistants = nodes
            .filter((el) => {
              let parent = el.parentElement;
              while (parent) {
                if (set.has(parent)) return false; // nested duplicate
                parent = parent.parentElement;
              }
              return true;
            })
            .filter((el) => this.roleOf(el) === 'assistant')
            .filter((el) => el.childElementCount > 0 || (el.textContent || '').trim());
          if (assistants.length) return assistants.map((el) => ({ el, role: 'assistant' }));
        }
      }

      const messages = this.readMessages();
      const assistants = messages.filter((m) => m.role === 'assistant' && (m.el.textContent || '').trim());
      if (assistants.length) return assistants;

      const fingerprints = this.promptFingerprints(promptText);
      // The exclusion check runs on every message every tick, so it uses the
      // raw textContent - never the markdown conversion.
      return messages
        .filter((m) => m.role !== 'user')
        .filter((m) => (m.el.textContent || '').trim())
        .filter((m) => !fingerprints.length || !fingerprints.some((f) => (m.el.textContent || '').includes(f)));
    },

    /**
     * Markdown extraction cache for the element currently being read, driven
     * by a MutationObserver on THAT element (not the whole document).
     *
     * The hot path used to rebuild the raw `textContent` of the answer on
     * every tick just to ask "did it change?" - a 100k-char answer meant a
     * 100k-char string allocation several times a second, for as long as the
     * page stayed open.  Now the observer flags the text dirty only on real
     * changes; quiet ticks read nothing.  A 2 s fallback re-read keeps it
     * correct when no observer can be installed.
     */
    textState: { el: null, observer: null, raw: null, text: '', dirty: true, lastReadAt: 0 },

    watchText(el) {
      const st = this.textState;
      if (st.el === el && st.observer) return;
      if (st.observer) {
        try {
          st.observer.disconnect();
        } catch (_) {
          /* element already gone */
        }
      }
      st.el = el;
      st.raw = null;
      st.text = '';
      st.dirty = true; // force one real read of the new element
      st.lastReadAt = Date.now();
      try {
        st.observer = new MutationObserver(() => {
          st.dirty = true;
        });
        st.observer.observe(el, { subtree: true, childList: true, characterData: true });
      } catch (_) {
        st.observer = null; // the 2 s fallback in watchedText() keeps it correct
      }
    },

    /** Extracted text of `el` - recomputed only when it actually changed. */
    watchedText(el) {
      if (!el) return '';
      this.watchText(el);
      const st = this.textState;
      const now = Date.now();
      if (!st.dirty && now - st.lastReadAt < 2000) return st.text;
      const raw = el.textContent || '';
      if (!st.dirty && raw === st.raw) {
        st.lastReadAt = now; // the observer already told us: nothing new
        return st.text;
      }
      const text = extractText(el);
      st.raw = raw;
      st.text = text;
      st.dirty = false;
      st.lastReadAt = now;
      return text;
    },

    snapshot(promptText) {
      const assistants = this.assistantElements(promptText);
      const last = assistants[assistants.length - 1];
      return {
        count: assistants.length,
        lastText: last ? messageText(last.el) : '',
        /** text of the chat region before typing, for the growth fallback */
        growthBase: assistants.length ? null : this.growthText(),
      };
    },

    // -------- redesign-proof fallback -------------------------------------
    // When no known message selector matches (the site was redesigned, roles
    // and classes moved), the answer still has to *be* somewhere in the page -
    // the user can read it.  Track how the readable text of the main region
    // grows and hand back whatever appeared after our own prompt echo.  It is
    // the last resort, not the primary path: selectors stay preferable.

    /** Containers whose text never counts as "the answer grew". */
    growthSkip: [
      'form',
      'textarea',
      'input',
      'button',
      'select',
      'nav',
      'aside',
      'header',
      'footer',
      'script',
      'style',
      'noscript',
      'svg',
      '[contenteditable]',
      '[role="textbox"]',
      '[aria-hidden="true"]',
    ],

    regionElement() {
      for (const css of ['main', '[role="main"]', '#__next', '#root', '#app']) {
        try {
          const el = document.querySelector(css);
          if (el) return el;
        } catch (_) {
          /* bad selector in a runtime override */
        }
      }
      return document.body || document.documentElement;
    },

    /** Visible-ish text of the chat region (no layout access, no markdown). */
    growthText() {
      const root = this.regionElement();
      if (!root) return '';
      const skip = this.growthSkip.concat((this.selectors().ignoreInside) || []);
      let out = '';
      const walk = (node) => {
        for (const child of node.childNodes) {
          if (out.length > 500000) return; // hard safety bound
          if (child.nodeType === Node.TEXT_NODE) {
            out += child.nodeValue || '';
            continue;
          }
          if (child.nodeType !== Node.ELEMENT_NODE) continue;
          if (matchesAny(child, skip)) continue;
          walk(child);
        }
      };
      try {
        walk(root);
      } catch (error) {
        warn('growth fallback could not read the page', error);
        return '';
      }
      return out;
    },

    /**
     * Cut the echoed prompt off the front of a growth delta.  The site renders
     * what we typed as the user bubble, so the delta usually starts (or, in
     * agent mode, ends) with our own prompt - and a delta that is *only* the
     * echo is not an answer at all.
     */
    stripPromptEcho(delta, promptText, rewritten) {
      const prompt = String(promptText || '').trim();
      const trimmed = String(delta || '').trim();
      if (!prompt || trimmed === prompt) return ''; // just our own echo
      if (!trimmed) return '';

      // 1. long prompts: the answer begins right after the last occurrence of
      //    the prompt's tail (whitespace may differ between the textarea and
      //    the rendered bubble, so runs match flexibly; window is bounded).
      if (prompt.length >= 24) {
        const tail = prompt.slice(-240);
        const window = trimmed.slice(0, Math.min(trimmed.length, prompt.length + 4000));
        try {
          const finder = new RegExp(tail.split(/\s+/).map(escapeRegExp).join('\\s+'), 'g');
          let end = -1;
          let match;
          while ((match = finder.exec(window)) !== null) end = match.index + match[0].length;
          if (end !== -1) return trimmed.slice(end).trim();
        } catch (_) {
          /* pathological prompt - fall through */
        }
      }

      // 2. any prompt length: a plain prefix echo.
      if (trimmed.startsWith(prompt)) return trimmed.slice(prompt.length).trim();
      const normalised = trimmed.replace(/\s+/g, ' ');
      const normalisedPrompt = prompt.replace(/\s+/g, ' ');
      if (normalisedPrompt.length >= 8 && normalised.startsWith(normalisedPrompt)) {
        return trimmed.slice(prompt.length).trim();
      }

      // 3. nothing recognisable: in rewritten mode do not invent an answer.
      if (rewritten) return '';
      return delta.length > prompt.length + 16 ? trimmed : '';
    },

    /**
     * Answer text for the current turn.
     * @returns {{text: string, isNew: boolean, total: string, rewritten?: boolean, growth?: boolean}}
     */
    answerText(baseline, promptText, options) {
      const assistants = this.assistantElements(promptText);
      if (!assistants.length) {
        if (options && options.allowGrowth === false) return { text: '', isNew: false, total: '' };
        return this.growthAnswer(baseline, promptText);
      }
      const last = assistants[assistants.length - 1];
      const total = this.watchedText(last.el);
      const baselineText = (baseline && baseline.lastText) || '';

      if (assistants.length > (baseline ? baseline.count : 0)) return { text: total, isNew: true, total };
      if (!baselineText) return { text: total, isNew: false, total };
      if (total === baselineText) return { text: '', isNew: false, total };
      if (total.startsWith(baselineText)) {
        return { text: total.slice(baselineText.length).trim(), isNew: false, total };
      }
      // The UI rewrote the element instead of appending to it.
      return { text: total, isNew: false, total, rewritten: true };
    },

    /** Last resort: the answer as "text that appeared in the page". */
    growthAnswer(baseline, promptText) {
      const base = baseline && baseline.growthBase;
      if (typeof base !== 'string') return { text: '', isNew: false, total: '' };
      const current = this.growthText();
      if (!current || current === base) return { text: '', isNew: false, total: current };
      let delta;
      let rewritten = false;
      if (current.startsWith(base)) delta = current.slice(base.length);
      else {
        // the page rewrote/re-rendered (or dropped old turns): fall back to
        // "everything after our prompt echo", which is still just the answer
        delta = current;
        rewritten = true;
      }
      const text = this.stripPromptEcho(delta, promptText, rewritten);
      return { text, isNew: Boolean(text), total: current, growth: true, rewritten };
    },

    // -------- input -------------------------------------------------------
    setNativeValue(el, value) {
      const prototype =
        el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
      if (descriptor && descriptor.set) descriptor.set.call(el, value);
      else el.value = value;
    },

    async typePrompt(el, text, behavior) {
      const config = behavior || CFG.behavior || {};
      el.focus();

      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        this.setNativeValue(el, text);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return 'native-setter';
      }

      // contenteditable
      try {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
      } catch (_) {
        /* selection is best effort */
      }

      const typeable = text.length <= (config.MAX_TYPED_CHARS || 6000);
      const chunk = Math.max(1, config.TYPE_CHUNK_CHARS || 12);

      if (!typeable) {
        if (document.execCommand) document.execCommand('selectAll', false, null);
        const inserted = document.execCommand && document.execCommand('insertText', false, text);
        if (!inserted) el.textContent = text;
      } else {
        if (!document.execCommand || !document.execCommand('insertText', false, '')) el.textContent = '';
        for (let index = 0; index < text.length; index += chunk) {
          const piece = text.slice(index, index + chunk);
          if (!document.execCommand || !document.execCommand('insertText', false, piece)) el.textContent += piece;
          await sleep(config.TYPE_DELAY_MS || 20);
        }
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text.slice(-64) }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return typeable ? 'simulated-typing' : 'bulk-insert';
    },

    pressEnter(el) {
      const options = {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
        composed: true,
      };
      el.dispatchEvent(new KeyboardEvent('keydown', options));
      el.dispatchEvent(new KeyboardEvent('keypress', options));
      el.dispatchEvent(new KeyboardEvent('keyup', options));
    },

    click(el) {
      if (!el) return false;
      try {
        el.scrollIntoView({ block: 'center', inline: 'center' });
      } catch (_) {
        /* ignore */
      }
      const options = { bubbles: true, cancelable: true, composed: true, view: window };
      el.dispatchEvent(new PointerEvent('pointerdown', options));
      el.dispatchEvent(new MouseEvent('mousedown', options));
      el.dispatchEvent(new PointerEvent('pointerup', options));
      el.dispatchEvent(new MouseEvent('mouseup', options));
      el.dispatchEvent(new MouseEvent('click', options));
      return true;
    },

    currentInputText(el) {
      if (!el) return '';
      return String(el.value !== undefined ? el.value : el.innerText || el.textContent || '').trim();
    },

    diagnose(promptText) {
      const s = this.selectors();
      let lastMessageSample = '';
      let lastRole = '';
      let messageCount = 0;
      try {
        const messages = this.readMessages();
        messageCount = messages.length;
        const last = messages[messages.length - 1];
        if (last) {
          lastRole = last.role;
          lastMessageSample = truncate(messageText(last.el), 240);
        }
      } catch (error) {
        lastMessageSample = `error: ${error && error.message}`;
      }
      const input = this.findInput();
      return {
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        messageCount,
        lastRole,
        lastMessageSample,
        selectorCounts: {
          input: countMatches(s.input),
          sendButton: countMatches(s.sendButton),
          stopButton: countMatches(s.stopButton),
          assistantMessage: countMatches(s.assistantMessage),
          messageRoleAny: countMatches(s.messageRoleAny),
          messageGeneric: countMatches(s.messageGeneric),
          keepWorking: countMatches(s.keepWorking),
          survey: countMatches(s.survey),
          captcha: countMatches(s.captcha),
        },
        checks: {
          input: Boolean(input),
          inputTag: input ? input.tagName.toLowerCase() : null,
          inputTextLength: input ? this.currentInputText(input).length : 0,
          sendButton: Boolean(this.findSendButton()),
          stopButton: Boolean(this.findStopButton()),
          newChatButton: Boolean(this.findNewChatButton()),
          captcha: this.hasCaptcha(),
          loggedOut: this.isLoggedOut(),
          surveyVisible: this.hasSurvey(),
          keepWorkingVisible: Boolean(this.findKeepWorking()),
        },
        stream: StreamCapture.summary(null),
        pageHook: {
          enabled: Boolean(CFG.capture && CFG.capture.ENABLED),
          ready: StreamCapture.hookReady,
          source: StreamCapture.hookSource,
          mode: (CFG.capture && CFG.capture.INJECTION) || 'manifest',
        },
        promptSample: truncate(promptText || '', 120),
      };
    },
  };

  // -------------------------------------------------------------------------
  // on-page badge
  // -------------------------------------------------------------------------
  const Badge = {
    label: null,

    mount() {
      if (!CFG.behavior || !CFG.behavior.SHOW_BADGE || this.label) return;
      try {
        const host = document.createElement('div');
        host.id = 'aab-badge-host';
        host.style.cssText = 'position:fixed;z-index:2147483647;bottom:12px;right:12px;';
        const shadow = host.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = `
          .badge{font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:#0d1117;
                 background:#8b949e;padding:3px 8px;border-radius:999px;opacity:.85;
                 pointer-events:none;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:background .2s}
          .badge[data-state="connected"]{background:#3fb950}
          .badge[data-state="busy"]{background:#d29922}
          .badge[data-state="error"]{background:#f85149;color:#fff}
          .badge[data-state="standby"]{background:#8b949e}
        `;
        const badge = document.createElement('div');
        badge.className = 'badge';
        badge.dataset.state = 'connecting';
        badge.textContent = 'bridge: connecting';
        shadow.append(style, badge);
        (document.body || document.documentElement).appendChild(host);
        this.label = badge;
      } catch (error) {
        warn('could not mount the badge', error);
      }
    },

    set(state, text) {
      if (!this.label) this.mount();
      if (!this.label) return;
      this.label.dataset.state = state;
      this.label.textContent = `bridge: ${text || state}`;
    },
  };

  // -------------------------------------------------------------------------
  // Transport: the WebSocket to the local bridge (owned by this tab)
  // -------------------------------------------------------------------------
  const Transport = {
    socket: null,
    state: 'idle',
    attempts: 0,
    reconnectTimer: null,
    standbyTimer: null,
    handshakeDone: false,
    serverVersion: null,
    override: null,
    /** answers/diagnostics that could not be sent yet (socket was down) */
    outbox: [],
    outboxTimer: null,
    OUTBOX_MAX: 8,
    OUTBOX_TTL_MS: 120000,

    async loadOverride() {
      try {
        const stored = await chrome.storage.local.get(['serverUrl']);
        if (stored && stored.serverUrl) this.override = stored.serverUrl;
      } catch (_) {
        /* storage unavailable */
      }
    },

    url() {
      let url = this.override || (CFG && CFG.SERVER_WS_URL) || 'ws://127.0.0.1:8000/ws/browser';
      const token = (CFG && CFG.WS_TOKEN) || '';
      if (token && url.indexOf('token=') === -1) {
        url += (url.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(token);
      }
      return url;
    },

    async start() {
      const granted = await this.claimLease();
      if (!granted) {
        this.setState('standby', 'another arena.ai tab owns the bridge');
        clearTimeout(this.standbyTimer);
        this.standbyTimer = setTimeout(() => this.start(), 5000);
        return;
      }
      this.connect();
    },

    async claimLease() {
      if (CFG.TRANSPORT_MODE === 'direct') return true;
      const reply = await sendToBackground({ kind: 'claim' });
      if (!reply) {
        log('no background worker - falling back to a direct connection');
        return true;
      }
      return Boolean(reply.granted);
    },

    connect() {
      if (
        this.socket &&
        (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
      ) {
        return;
      }
      let socket;
      try {
        socket = new WebSocket(this.url());
      } catch (error) {
        this.setState('error', error && error.message);
        this.scheduleReconnect();
        return;
      }
      this.socket = socket;
      this.setState('connecting');

      socket.addEventListener('open', () => {
        this.attempts = 0;
        this.setState('connected');
        log('connected to', this.url());
        this.send({
          type: 'hello',
          client: 'chrome-extension',
          version: (chrome.runtime && chrome.runtime.getManifest && chrome.runtime.getManifest().version) || CFG.VERSION,
          url: location.href,
        });
        this.sendHeartbeat();
        this.flushOutbox();
      });

      socket.addEventListener('message', (event) => {
        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch (_) {
          return;
        }
        Bridge.onMessage(payload);
      });

      socket.addEventListener('close', (event) => {
        this.socket = null;
        this.setState('disconnected', event && event.code === 4000 ? 'replaced' : null);
        if (event && event.code === 4000) {
          // the server handed the connection to another tab: release the lease
          sendToBackground({ kind: 'release' });
          setTimeout(() => this.start(), 3000);
          return;
        }
        this.scheduleReconnect();
      });

      socket.addEventListener('error', () => {
        this.setState('error', 'is `python -m server` running?');
      });
    },

    scheduleReconnect() {
      if (this.reconnectTimer) return;
      this.attempts += 1;
      const delay = Math.min(15000, Math.round(1000 * Math.pow(1.6, Math.min(this.attempts, 6))));
      this.setState('disconnected', `retry in ${Math.round(delay / 1000)}s`);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.start();
      }, delay);
    },

    close() {
      try {
        if (this.socket) this.socket.close();
      } catch (_) {
        /* ignore */
      }
      this.socket = null;
    },

    send(payload) {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
      try {
        this.socket.send(JSON.stringify(payload));
        return true;
      } catch (_) {
        return false;
      }
    },

    /**
     * Send a message that must survive a socket blink (a finished answer, a
     * diagnostics reply).  If the socket is down it is kept in a small outbox
     * and flushed when the connection is back - an answer must never be lost
     * just because the WebSocket reconnected at the wrong moment.  `opts.ttlAt`
     * (a timestamp) is the moment the server stops caring about it.
     */
    sendCritical(payload, opts) {
      if (this.send(payload)) return true;
      const now = Date.now();
      const ttlAt = (opts && opts.ttlAt) || now + this.OUTBOX_TTL_MS;
      this.outbox = this.outbox.filter((item) => now < (item.ttlAt || item.at + this.OUTBOX_TTL_MS));
      if (this.outbox.length >= this.OUTBOX_MAX) this.outbox.shift();
      this.outbox.push({ payload, at: now, ttlAt });
      log('socket closed - queued a %s frame (%d waiting)', payload && payload.type, this.outbox.length);
      this.scheduleOutbox();
      return false;
    },

    scheduleOutbox() {
      if (this.outboxTimer || !this.outbox.length) return;
      this.outboxTimer = setTimeout(() => {
        this.outboxTimer = null;
        this.flushOutbox();
      }, 1000);
    },

    flushOutbox() {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        this.scheduleOutbox();
        return;
      }
      const now = Date.now();
      const kept = [];
      for (const item of this.outbox) {
        if (now >= (item.ttlAt || item.at + this.OUTBOX_TTL_MS)) continue; // the server moved on
        if (this.send(item.payload)) continue;
        kept.push(item);
      }
      this.outbox = kept;
      if (this.outbox.length) this.scheduleOutbox();
    },

    lastHeartbeatAt: 0,

    sendHeartbeat() {
      this.lastHeartbeatAt = Date.now();
      this.send({
        type: 'heartbeat',
        state: Bridge.busy ? 'answering' : this.state,
        busy: Bridge.busy,
        url: location.href,
      });
    },

    /**
     * Activity-driven keepalive.
     *
     * The server drops a client it has not heard from for a few ping intervals
     * (`AAB_HEARTBEAT_INTERVAL` × 3).  A background tab has its `setInterval`
     * throttled to once a minute (or frozen), so the periodic heartbeat alone is
     * not enough while a long answer is being captured - but DOM mutations and
     * captured stream frames still arrive.  Those call `touch()`, which keeps
     * the socket alive without depending on timers.
     */
    touch(reason) {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
      const min = (CFG.behavior && CFG.behavior.HEARTBEAT_MIN_MS) || 5000;
      if (Date.now() - this.lastHeartbeatAt < min) return false;
      this.sendHeartbeat();
      if (CFG.debug && CFG.debug.VERBOSE) log('keepalive (%s)', reason || 'activity');
      return true;
    },

    setState(state, note) {
      this.state = state;
      if (state === 'error' && note) Bridge.lastError = note;
      const label = state === 'busy' ? 'answering…' : note ? `${state} (${note})` : state;
      Badge.set(state, label);
      Bridge.reportState();
    },
  };

  // -------------------------------------------------------------------------
  // Keepalive port: opened while a request runs, closed when idle.
  //
  // Holding a runtime port open with a 20 s message interval keeps the MV3
  // service worker (and Firefox's event page) alive *indefinitely* - that was
  // a permanent memory/CPU cost just to have the door open.  The port now
  // exists only while the tab is actually answering.
  // -------------------------------------------------------------------------
  const KeepalivePort = {
    port: null,
    timer: null,
    set(on) {
      if (on && !this.timer) {
        try {
          this.port = chrome.runtime.connect({ name: 'aab-keepalive' });
        } catch (_) {
          this.port = null; // not an extension context (tests) - the alarm ping covers it
        }
        this.timer = setInterval(() => {
          try {
            this.port && this.port.postMessage({ kind: 'keepalive', state: Transport.state, busy: Bridge.busy });
          } catch (_) {
            /* the worker went away mid-request */
          }
        }, 20000);
      } else if (!on && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
        try {
          this.port && this.port.disconnect && this.port.disconnect();
        } catch (_) {
          /* already gone */
        }
        this.port = null;
      }
    },
  };

  // -------------------------------------------------------------------------
  // Bridge
  // -------------------------------------------------------------------------
  const Bridge = {
    state: 'idle',
    busy: false,
    cancelReason: null,
    lastError: null,
    lastRequestAt: 0,
    lastAnswerMs: null,
    answeredCount: 0,
    lastAction: null,
    lastActionAt: 0,
    currentRequest: null,
    heartbeatTimer: null,

    start() {
      StreamCapture.install();
      Transport.start();
      this.heartbeatTimer = setInterval(() => {
        Transport.sendHeartbeat();
        this.reportState();
      }, 30000);
      window.addEventListener('beforeunload', () => {
        sendToBackground({ kind: 'release' });
        Transport.close();
      });
    },

    /** Keepalive hook - see `Transport.touch` for why this is activity-driven. */
    touch(reason) {
      return Transport.touch(reason);
    },

    /**
     * Remember the last meaningful thing the bridge did.  The popup shows it,
     * so a user who reports "nothing works" can say what the bridge last saw.
     */
    note(action) {
      this.lastAction = action;
      this.lastActionAt = Date.now();
      this.reportState();
    },

    lastStateJson: '',
    reportState(force) {
      this.state = Transport.state;
      const payload = {
        kind: 'state',
        state: this.busy ? 'busy' : Transport.state,
        busy: this.busy,
        lastError: this.lastError,
        lastRequestAt: this.lastRequestAt,
        lastAnswerMs: this.lastAnswerMs,
        answered: this.answeredCount,
        lastAction: this.lastAction,
        url: location.href,
        serverVersion: Transport.serverVersion,
        pageHook: {
          enabled: Boolean(CFG.capture && CFG.capture.ENABLED),
          ready: StreamCapture.hookReady,
          source: StreamCapture.hookSource,
          mode: (CFG.capture && CFG.capture.INJECTION) || 'manifest',
        },
      };
      // The heartbeat re-sends the snapshot every 30 s; when nothing changed
      // (the common case while idle) the background would only rewrite the
      // session storage and ping the popup - so skip it.
      const json = JSON.stringify(payload);
      if (!force && json === this.lastStateJson) return;
      this.lastStateJson = json;
      sendToBackground(payload);
    },

    async onMessage(payload) {
      switch (payload.type) {
        case 'ping':
          Transport.send({ type: 'pong', ts: Date.now() / 1000 });
          return;
        case 'welcome':
          Transport.serverVersion = payload.version;
          log('server welcome', payload);
          this.note(`connected to server ${payload.version || ''}`.trim());
          return;
        case 'replaced':
          warn('another arena.ai tab took over the bridge connection');
          this.note('another tab took over the connection');
          Transport.close();
          setTimeout(() => Transport.start(), 3000);
          return;
        case 'cancel':
          this.cancelReason = payload.reason || 'cancelled';
          this.note(`cancel requested (${this.cancelReason})`);
          return;
        case 'diagnose':
          // The admin panel asks for a snapshot of the live page.
          this.note('diagnose snapshot requested');
          Transport.sendCritical({
            type: 'diag',
            id: payload.id,
            state: Transport.state,
            busy: this.busy,
            injected: Boolean(window.__AAB_INJECTED__),
            url: location.href,
            diag: SiteDriver.diagnose(''),
            config: {
              serverUrl: Transport.url(),
              stableMs: (CFG.behavior || {}).STABLE_MS,
              capture: Boolean(CFG.capture && CFG.capture.ENABLED),
              overrides: Boolean(UserSettings.ready),
            },
          });
          return;
        case 'shutdown':
          // The operator disconnected us from the panel: come back, but slowly.
          warn('disconnected from the server (%s) - reconnecting in 10s', payload.reason || 'shutdown');
          Transport.close();
          Badge.set('standby', 'bridge: disconnected');
          clearTimeout(this.standbyTimer);
          this.standbyTimer = setTimeout(() => this.start(), 10000);
          return;
        case 'request':
          await this.handleRequest(payload);
          return;
        default:
          log('unknown message from server', payload);
      }
    },

    async handleRequest(payload) {
      if (this.busy) {
        // After a reconnect the server re-sends the request it never got an
        // answer for.  If it is the one we are already answering, ignore the
        // duplicate instead of failing it (or the answer would be lost).
        if (this.currentRequest && payload.id === this.currentRequest.id) {
          log('ignoring the re-sent request %s (already answering it)', String(payload.id).slice(0, 8));
          this.reportState();
          return;
        }
        this.note('busy: refused a second request');
        Transport.sendCritical({
          type: 'response',
          id: payload.id,
          error: 'busy',
          meta: { message: 'the tab is already answering another request' },
        });
        return;
      }
      this.busy = true;
      this.cancelReason = null;
      this.currentRequest = payload;
      this.lastRequestAt = Date.now();
      this.lastAction = `answering: ${String((payload.prompt || '').trim()).slice(0, 60)}`;
      Badge.set('busy', 'answering…');
      this.reportState();
      // Keep the MV3 worker alive only while actually working (a port held
      // open forever with a 20 s interval is what kept the worker - and a
      // chunk of its memory - resident all the time).
      KeepalivePort.set(true);

      const started = Date.now();
      // The server keeps waiting for this id until its own deadline; a queued
      // answer must survive in the outbox exactly that long, no longer.
      // (+20s mirrors the worker's `timeout + 20` margin on the server side.)
      const serverDeadline = started + (Number(payload.timeout) || 300) * 1000 + 20000;
      try {
        const result = await Pipeline.run(payload);
        this.lastAnswerMs = Date.now() - started;
        this.answeredCount += 1;
        this.lastAction = `answer sent in ${(this.lastAnswerMs / 1000).toFixed(1)}s (${result.stopReason})`;
        Transport.sendCritical(
          {
            type: 'response',
            id: payload.id,
            response: result.text,
            error: null,
            meta: {
              duration_ms: Date.now() - started,
              stop_reason: result.stopReason,
              from_stream: Boolean(result.fromStream),
              stream: result.stream,
              url: location.href,
              mode: payload.mode || 'agent',
              kept_working: result.keptWorking || null,
            },
          },
          { ttlAt: serverDeadline }
        );
        log('answered %s in %d ms (%s)', String(payload.id).slice(0, 8), Date.now() - started, result.stopReason);
      } catch (error) {
        const code = (error && error.code) || 'unknown_error';
        this.lastError = `${code}: ${(error && error.message) || error}`;
        this.lastAction = `failed: ${code}`;
        warn('request failed:', this.lastError);
        Transport.sendCritical(
          {
            type: 'response',
            id: payload.id,
            response: null,
            error: code,
            meta: {
              message: String((error && error.message) || error),
              duration_ms: Date.now() - started,
              url: location.href,
            },
          },
          { ttlAt: serverDeadline }
        );
      } finally {
        this.busy = false;
        this.currentRequest = null;
        Badge.set(Transport.state, Transport.state === 'connected' ? 'connected' : Transport.state);
        this.reportState();
        KeepalivePort.set(false);
      }
    },
  };

  // -------------------------------------------------------------------------
  // Pipeline
  // -------------------------------------------------------------------------
  class BridgeFailure extends Error {
    constructor(code, message) {
      super(message || code);
      this.code = code;
    }
  }

  const Pipeline = {
    async run(payload) {
      const behavior = CFG.behavior || {};
      const prompt = String(payload.prompt || '');
      if (prompt.trim().length < (behavior.MIN_PROMPT_CHARS || 1)) {
        throw new BridgeFailure('empty_prompt', 'the prompt is empty');
      }
      if (SiteDriver.isLoggedOut()) {
        throw new BridgeFailure('not_logged_in', 'the arena.ai tab is not signed in');
      }
      if (SiteDriver.hasCaptcha()) {
        throw new BridgeFailure('captcha', 'a captcha is displayed; solve it manually in this tab');
      }

      if (behavior.RESET_BEFORE_REQUEST) {
        const reset = SiteDriver.findNewChatButton();
        if (reset) {
          SiteDriver.click(reset);
          await sleep(800);
        }
      }

      const input = await waitFor(() => SiteDriver.findInput(), {
        timeout: behavior.INPUT_WAIT_MS || 20000,
        interval: 250,
      });
      if (!input) {
        throw new BridgeFailure(
          'selector_missing',
          'chat input not found - the markup probably changed; update extensions/shared/config.js (popup -> Diagnose DOM)'
        );
      }
      if (SiteDriver.isLoggedOut()) {
        throw new BridgeFailure('not_logged_in', 'the arena.ai tab is not signed in');
      }

      const baseline = SiteDriver.snapshot(prompt);
      // The aggregate (and the page hook's capture flag) lives for the whole
      // turn: frames from the submit window belong to this request.
      const mark = StreamCapture.beginRequest();
      try {
        const method = await SiteDriver.typePrompt(input, prompt, behavior);
        log('prompt inserted via %s (%d chars)', method, prompt.length);
        await sleep(behavior.SUBMIT_DELAY_MS || 200);

        await this.submit(input, prompt);

        const result = await this.capture(payload, baseline, prompt, mark);

        // Agent mode ends with a poll in the composer - answer it so the next
        // request finds a free chat box (direct mode has no survey).
        if ((payload.mode || 'agent') !== 'direct') {
          result.keptWorking = await this.handOff();
        }
        return result;
      } finally {
        StreamCapture.endRequest();
      }
    },

    /**
     * Make sure the tab is ready for the next prompt.
     *
     * The post-answer survey ("Keep working" / …) replaces the composer, so an
     * unanswered survey is exactly what makes the *next* request fail.  This
     * clicks it, then waits (briefly) for the input box to come back.
     */
    async handOff() {
      const behavior = CFG.behavior || {};
      if (behavior.AUTO_KEEP_WORKING === false) return { found: false, skipped: true };

      const survey = await SiteDriver.acceptKeepWorking({
        waitMs: behavior.KEEP_WORKING_WAIT_MS || 4000,
      });
      if (survey.clicked) {
        const inputBack = await waitFor(() => SiteDriver.findInput(), { timeout: 5000, interval: 200 });
        return { found: true, clicked: true, cleared: Boolean(survey.cleared), input: Boolean(inputBack), label: survey.label };
      }
      return { found: survey.found, clicked: false };
    },

    /**
     * Click Send (preferred) or press Enter, then wait for evidence that the
     * site accepted the prompt: cleared input box, a visible Stop button, new
     * assistant text or an active stream.
     */
    async submit(input, prompt) {
      const behavior = CFG.behavior || {};
      const startedAt = Date.now();
      const timeout = behavior.START_CONFIRM_MS || 15000;

      const button = SiteDriver.findSendButton();
      const clicked = button && isEnabled(button) ? SiteDriver.click(button) : false;
      if (clicked) log('clicked the send button');
      else {
        log('pressing Enter in the input');
        SiteDriver.pressEnter(input);
      }

      const accepted = await waitFor(
        () => {
          const text = SiteDriver.currentInputText(input);
          if (!text || text.length < Math.min(8, prompt.trim().length)) return true; // box cleared
          if (SiteDriver.findStopButton()) return true;
          if (StreamCapture.lastActivityAt >= startedAt) return true; // stream answered
          const answer = SiteDriver.answerText(
            { count: Number.MAX_SAFE_INTEGER, lastText: '', growthBase: '' },
            prompt,
            { allowGrowth: false }
          );
          return Boolean(answer && answer.text.length > 2);
        },
        { timeout, interval: 200 }
      );

      if (!accepted) {
        warn('no submit confirmation, retrying with Enter');
        SiteDriver.pressEnter(input);
        const retried = await waitFor(
          () =>
            !SiteDriver.currentInputText(input) ||
            Boolean(SiteDriver.findStopButton()) ||
            StreamCapture.lastActivityAt >= startedAt,
          { timeout: Math.min(8000, timeout), interval: 250 }
        );
        if (!retried) {
          throw new BridgeFailure(
            'submit_failed',
            'the prompt was typed but the site never started answering (send button missing/disabled or markup changed?)'
          );
        }
      }
      return startedAt;
    },

    async capture(payload, baseline, prompt, mark) {
      const behavior = CFG.behavior || {};
      const mode = payload.mode || 'agent';
      // The server gives up on this request at `timeout + 30s`.  A background
      // tab can have its timers throttled to one wake per minute, so the
      // decision (and the send) must happen a safe margin BEFORE that
      // deadline - otherwise the model's answer is produced and still lost.
      const budgetMs = Math.min((Number(payload.timeout) || 300) * 1000, behavior.MAX_WAIT_MS || 300000);
      const margin = Math.min(
        behavior.ANSWER_SEND_MARGIN_MS === undefined ? 15000 : behavior.ANSWER_SEND_MARGIN_MS,
        Math.max(0, budgetMs - 2000)
      );
      const ctx = {
        poll: behavior.POLL_INTERVAL_MS || 300,
        stableMs: behavior.STABLE_MS || 3000,
        sseIdleMs: behavior.SSE_IDLE_MS || 1200,
        stallMs: behavior.STALL_MS || 25000,
        noOutputMs: behavior.NO_OUTPUT_MS || 60000,
        minAnswerWait: behavior.MIN_ANSWER_WAIT_MS || 1500,
        startConfirmMs: behavior.START_CONFIRM_MS || 15000,
        /** site-activity watchdog (DOM changes + captured stream frames) */
        idleStallMs: behavior.IDLE_STALL_MS || 45000,
        /** the survey is an agent-mode only end-of-turn marker */
        survey: Boolean(behavior.AUTO_KEEP_WORKING) && mode !== 'direct',
        surveySettleMs: behavior.SURVEY_SETTLE_MS || 700,
        partialOnTimeout: behavior.PARTIAL_ON_TIMEOUT !== false,
        maxWait: Math.max(2000, budgetMs - margin),
        startedAt: Date.now(),
        lastText: '',
        stableSince: Date.now(),
        lastChangeAt: Date.now(),
        lastStreamAt: 0,
        lastIdleWarnAt: 0,
        sawActivity: false,
        lastSummary: null,
        /**
         * Cached page probes (timestamps + values).  The old code re-ran
         * ~20 selector scans (stop button, survey, captcha, login wall) on
         * EVERY tick - the dominant fixed cost while a long answer streamed.
         * Now each probe is re-checked on its own (short) TTL; a fresh
         * captcha still trips within 2 s, a removed Stop button within 300 ms.
         */
        probes: { stop: 0, survey: 0, captcha: 0, login: 0, values: {} },
      };

      const adaptive = behavior.ADAPTIVE_TICK !== false;
      const fastMs = Math.max(60, Math.min(ctx.poll, behavior.TICK_FAST_MS || 150));

      Signal.start();
      // A mutation storm must not turn the tick into a busy loop: evaluate at
      // most every `minStepMs`, no matter how often the observers fire.
      const minStepMs = Math.max(50, Math.min(ctx.poll, 200));
      let lastStepAt = 0;
      let active = true;
      try {
        for (;;) {
          if (Date.now() - lastStepAt >= minStepMs) {
            lastStepAt = Date.now();
            const before = { text: ctx.lastText, stream: ctx.lastStreamAt };
            const decision = this.captureStep(ctx, baseline, prompt, mark);
            if (decision) return decision;
            // "active" = the answer grew or a stream frame arrived since the
            // previous tick.  Active -> tick fast (catch the end of the
            // stream sooner); settled -> the normal poll rate.  The win in
            // the quiet phase is not a lower rate but a MUCH cheaper tick
            // (watchedText + cached probes + the fast selector path); real
            // DOM/stream events still wake the loop early through Signal.
            active = ctx.lastText !== before.text || ctx.lastStreamAt > before.stream;
          }
          await Signal.wait(adaptive && active ? fastMs : ctx.poll);
        }
      } finally {
        Signal.stop();
      }
    },

    /** Run `fn` at most every `ttlMs` while this capture is alive. */
    probe(ctx, name, ttlMs, fn) {
      const now = Date.now();
      if (now - (ctx.probes[name] || 0) >= ttlMs) {
        ctx.probes[name] = now;
        ctx.probes.values[name] = fn();
      }
      return ctx.probes.values[name];
    },

    /**
     * A capture tick means the tab is alive: nudge the keepalive so the server
     * does not drop a client whose `setInterval` heartbeat is being throttled.
     */
    touchTick() {
      try {
        Bridge.touch('tick');
      } catch (_) {
        /* the socket is gone - the reconnect logic owns that case */
      }
    },

    /** One evaluation tick; returns the answer once it looks complete. */
    captureStep(ctx, baseline, prompt, mark) {
      if (Bridge.cancelReason) throw new BridgeFailure(Bridge.cancelReason, 'cancelled by the server');

      const elapsed = Date.now() - ctx.startedAt;
      if (elapsed > ctx.maxWait) {
        // A partial answer beats losing the whole turn: the server's own timeout
        // is usually longer, so this is the last chance to hand something back.
        if ((ctx.lastText || ctx.lastSummary && ctx.lastSummary.text) && ctx.partialOnTimeout) {
          return {
            text: ctx.lastText || ctx.lastSummary.text,
            stopReason: 'timeout_partial',
            stream: ctx.lastSummary,
          };
        }
        throw new BridgeFailure('response_timeout', `no stable answer within ${Math.round(ctx.maxWait / 1000)}s`);
      }
      if (this.probe(ctx, 'login', 2000, () => SiteDriver.isLoggedOut())) {
        throw new BridgeFailure('not_logged_in', 'the session was logged out mid-request');
      }
      if (this.probe(ctx, 'captcha', 2000, () => SiteDriver.hasCaptcha())) {
        if (ctx.lastText) return { text: ctx.lastText, stopReason: 'captcha', stream: ctx.lastSummary };
        throw new BridgeFailure('captcha', 'a captcha appeared; solve it manually in this tab');
      }

      // The stream snapshot is O(1) now (incremental aggregate); it comes first
      // because the growth fallback must stay off while the site's own stream
      // already carries the answer text.
      const summary = StreamCapture.summary(mark);
      ctx.lastSummary = summary;

      const answer = SiteDriver.answerText(baseline, prompt, { allowGrowth: !summary.text });
      const text = (answer.text || '').trim();
      if (text && text !== ctx.lastText) {
        if (!ctx.lastText || text.length > ctx.lastText.length) {
          ctx.lastChangeAt = Date.now();
          ctx.sawActivity = true;
        }
        ctx.lastText = text;
        ctx.stableSince = Date.now();
      }

      this.touchTick();
      const stopVisible = Boolean(this.probe(ctx, 'stop', 300, () => SiteDriver.findStopButton()));
      const idleFor = Date.now() - ctx.stableSince;
      const streamIdle = summary.lastAt ? Date.now() - summary.lastAt : null;
      const streamActive = Boolean(summary.lastAt && !summary.sawDone && streamIdle !== null && streamIdle < ctx.sseIdleMs);
      const silentFor = Date.now() - ctx.lastChangeAt;

      // Activity = the DOM grew *or* the site's own stream sent a frame.  This
      // is the signal the timeout logic keys off: a tab can be throttled to
      // 1 tick/minute and still be "active" because frames keep arriving.
      const now = Date.now();
      if (summary.lastAt && summary.lastAt > ctx.lastStreamAt) ctx.lastStreamAt = summary.lastAt;
      const lastActivityAt = Math.max(ctx.lastChangeAt, ctx.lastStreamAt, mark && mark.at ? mark.at : 0);
      const idleSiteFor = now - lastActivityAt;

      if (CFG.debug && CFG.debug.LOG_LENGTHS) {
        log(
          `waiting: dom=${ctx.lastText.length} chars, stream=${summary.mainChars} chars, ` +
            `stop=${stopVisible}, domIdle=${idleFor}ms, streamIdle=${streamIdle}ms, siteIdle=${idleSiteFor}ms`
        );
      }

      // 0. The DOM did not give us an answer element (markup change, shadow
      //    DOM, virtualised list) but the site's own stream carries the text:
      //    use it as soon as the stream has settled, instead of waiting for a
      //    timeout and losing the turn.
      if (!ctx.lastText && summary.text) {
        const streamQuietFor = summary.lastAt ? now - summary.lastAt : Infinity;
        if (summary.sawDone || streamQuietFor >= ctx.sseIdleMs) {
          return { text: summary.text, stopReason: 'stream_text', stream: summary, fromStream: true };
        }
      }

      // 1. The survey after an agent-mode answer *is* the end-of-turn marker.
      //    Never end the turn on an empty capture though: a feedback widget
      //    that merely *looks* like the survey (broad `survey` selectors) must
      //    not abort a running answer with a silent empty "success", and the
      //    stream text is a valid answer when the DOM exposes no message node.
      if (
        ctx.survey &&
        elapsed >= ctx.minAnswerWait &&
        !streamActive &&
        this.probe(ctx, 'survey', 500, () => SiteDriver.hasSurvey()) &&
        idleFor >= ctx.surveySettleMs
      ) {
        const surveyText = ctx.lastText || (summary.text || '').trim();
        if (surveyText) {
          return {
            text: surveyText,
            stopReason: 'survey',
            stream: summary,
            fromStream: !ctx.lastText && Boolean(summary.text),
          };
        }
        // The end-of-turn marker is on screen but neither the DOM selectors
        // nor the stream hook produced any text: fail loudly (once the answer
        // should have arrived) instead of returning an empty answer.
        if (elapsed > ctx.startConfirmMs) {
          throw new BridgeFailure(
            'empty_answer',
            'the turn ended (survey visible) but no answer text was captured - the markup or ' +
              'stream format probably changed; run Diagnose DOM and check selectors.assistantMessage ' +
              'and the capture prefixes'
          );
        }
      }

      if (ctx.lastText && elapsed >= ctx.minAnswerWait) {
        if (!stopVisible && idleFor >= ctx.stableMs) {
          return { text: ctx.lastText, stopReason: 'stable', stream: summary };
        }
        if (summary.sawDone && idleFor >= 700) {
          return { text: ctx.lastText, stopReason: 'sse_done', stream: summary };
        }
        if (streamIdle !== null && summary.mainChars > 0 && streamIdle >= ctx.sseIdleMs && idleFor >= 700) {
          return { text: ctx.lastText, stopReason: 'sse_idle', stream: summary };
        }
        if (silentFor >= ctx.stallMs) {
          return { text: ctx.lastText, stopReason: 'stalled', stream: summary };
        }
      }

      // 2. Site-activity watchdog: nothing moved on the page and no frame
      //    arrived -> report the stoppage now instead of hanging until the
      //    server's (much longer) timeout.
      if (elapsed > ctx.startConfirmMs && idleSiteFor >= ctx.idleStallMs) {
        if (ctx.lastText) {
          return { text: ctx.lastText, stopReason: 'site_idle', stream: summary };
        }
        throw new BridgeFailure(
          'site_idle',
          `the site stopped updating ${Math.round(idleSiteFor / 1000)}s ago (no DOM change, no stream ` +
            'frame, no answer) - the generation was probably dropped; check the tab'
        );
      }
      if (elapsed > ctx.startConfirmMs + ctx.idleStallMs / 2 && idleSiteFor >= ctx.idleStallMs / 2 && !ctx.lastIdleWarnAt) {
        ctx.lastIdleWarnAt = now;
        warn('site has been idle for %dms while a request is running', Math.round(idleSiteFor));
      }

      if (!ctx.lastText && !ctx.sawActivity && !stopVisible && elapsed > ctx.startConfirmMs + 4000) {
        const input = SiteDriver.findInput();
        if (SiteDriver.currentInputText(input).length > 0) {
          throw new BridgeFailure('submit_failed', 'the prompt is still in the box; the site never submitted it');
        }
      }
      // Nothing from the DOM *and* the stream is empty or itself silent for
      // the whole window (an active stream suppresses the error).
      const streamSilent = !summary.text || (summary.lastAt && now - summary.lastAt > ctx.noOutputMs);
      if (!ctx.lastText && streamSilent && elapsed > ctx.noOutputMs) {
        if (summary.sawError) {
          throw new BridgeFailure('page_error', 'the site reported an error for this request');
        }
        throw new BridgeFailure(
          'no_output',
          `no assistant output after ${Math.round(ctx.noOutputMs / 1000)}s - the model may be queued, the tab may be ` +
            'throttled in the background, or a selector no longer matches'
        );
      }
      return null;
    },
  };

  // -------------------------------------------------------------------------
  // popup messaging
  // -------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.kind) return undefined;
    switch (message.kind) {
      case 'ping-content':
        // A dormant tab still answers the background's aliveness ping - it is
        // a fine tab, it just has nothing to bridge.
        sendResponse({
          ok: true,
          state: booted ? Transport.state : 'dormant',
          busy: booted && Bridge.busy,
          url: location.href,
        });
        return false;
      case 'diagnose':
        sendResponse({
          ok: true,
          state: booted ? Transport.state : 'dormant',
          busy: booted && Bridge.busy,
          injected: Boolean(window.__AAB_INJECTED__),
          diag: SiteDriver.diagnose(''),
          config: {
            serverUrl: Transport.url(),
            stableMs: (CFG.behavior || {}).STABLE_MS,
            capture: Boolean(CFG.capture && CFG.capture.ENABLED),
          },
        });
        return false;
      case 'cancel':
        if (booted) Bridge.cancelReason = message.reason || 'cancelled';
        sendResponse({ ok: true });
        return false;
      case 'reconnect':
        if (!booted) {
          // A dormant tab cannot be "reconnected"; only wake it when the page
          // really is the agent page (the popup may target a tab the user
          // thinks is the bridge tab).
          if (isAgentPage()) boot();
          else {
            sendResponse({ ok: false, dormant: true });
            return false;
          }
        }
        Bridge.cancelReason = null;
        Transport.close();
        Transport.start();
        Bridge.note('reconnecting on request');
        sendResponse({ ok: true });
        return false;
      case 'reload-settings':
        UserSettings.reload().then(
          () => {
            if (!booted && isAgentPage()) boot(); // the agent path may have been retargeted
            sendResponse({ ok: true, serverUrl: Transport.url() });
          },
          () => sendResponse({ ok: false })
        );
        return true; // async
      default:
        return undefined;
    }
  });

  // -------------------------------------------------------------------------
  // boot
  // -------------------------------------------------------------------------
  /**
   * Page-world stream hook (`inject.js`).
   *
   * The browser normally injects it for us (manifest `content_scripts` entry
   * with `world: "MAIN"`, Chrome 111+ / Firefox 128+), which is the only way to
   * run *before* the page patches or uses WebSocket itself.
   *
   * If that did not happen - older browser, page CSP, an already-open tab - the
   * hook is optional and we degrade to DOM-only capture, so the fallbacks below
   * are best effort and never fatal:
   *   1. `chrome.scripting.executeScript({world: 'MAIN'})` (runtime file)
   *   2. a `<script src=chrome-extension://.../inject.js>` tag (needs the page
   *      CSP to allow the extension origin)
   */
  const PageHook = {
    async ensure() {
      if (!CFG.capture || !CFG.capture.ENABLED) return false;
      if (StreamCapture.hookReady) return true;

      const timeout = (CFG.capture && CFG.capture.HOOK_TIMEOUT_MS) || 2500;
      const ready = await waitFor(() => StreamCapture.hookReady, { timeout, interval: 100 });
      if (ready) return true;

      if (((CFG.capture && CFG.capture.INJECTION) || 'manifest') === 'runtime') {
        await this.injectRuntime();
      }
      await this.injectScriptTag();

      const late = await waitFor(() => StreamCapture.hookReady, { timeout: 1500, interval: 100 });
      if (late) return true;
      if (CFG.debug && CFG.debug.VERBOSE) {
        warn(
          'page-world stream hook unavailable (page CSP or browser version) - ' +
            'falling back to DOM-only completion detection'
        );
      }
      return false;
    },

    async injectRuntime() {
      // The background worker owns chrome.scripting; a content script cannot
      // build a valid `target.tabId` on its own.
      const reply = await sendToBackground({ kind: 'inject-page-hook' });
      if (reply && reply.ok) {
        log('injected the page hook via scripting.executeScript (MAIN world)');
        return true;
      }
      if (reply && reply.error) log('runtime page-hook injection unavailable:', reply.error);
      return false;
    },

    injectScriptTag() {
      try {
        const script = document.createElement('script');
        script.src = chrome.runtime.getURL('inject.js');
        script.async = false;
        script.onload = () => script.remove();
        script.onerror = () => script.remove();
        (document.head || document.documentElement).appendChild(script);
        return true;
      } catch (error) {
        warn('could not inject the page-world stream hook (DOM-only mode)', error);
        return false;
      }
    },
  };

  /**
   * Apply the user overrides stored by the popup / the options page.
   *
   * `settings.js` owns the schema and the validation; it is optional here so the
   * jsdom suite (which loads config.js + content.js only) keeps working.
   */
  const UserSettings = {
    ready: false,
    async load() {
      const api = window.__AAB_SETTINGS__;
      if (!api || typeof api.load !== 'function') return false;
      try {
        const overrides = await api.load();
        api.apply(overrides, CFG);
        this.ready = true;
        return true;
      } catch (error) {
        warn('could not read the stored settings', error);
        return false;
      }
    },
    async reload() {
      const before = Transport.url();
      await this.load();
      const after = Transport.url();
      // A dormant tab must not open its socket on a settings change: boot()
      // will pick the new url up when (and if) the page becomes the agent page.
      if (after !== before && booted) {
        log('server url changed to %s - reconnecting', after);
        Transport.close();
        Transport.start();
      }
      if (this.ready && booted) Bridge.reportState();
      if (booted) Badge.set(Bridge.busy ? 'busy' : Transport.state, Bridge.busy ? 'answering…' : 'bridge: ' + Transport.state);
      return after;
    },
  };

  /**
   * Only the agent page is automatable.  The manifest can only match the
   * whole site (`https://arena.ai/*`), so on every OTHER page the script
   * stays DORMANT: no WebSocket, no document-wide MutationObserver, no
   * badge, no page-world stream hook, no timers, no lease claim.  That is
   * the difference between "an extension is installed" and "an extension is
   * running" - and it is what used to keep arena.ai (and its memory) heavy
   * while the user was just reading docs or profile pages.
   */
  let booted = false;
  function isAgentPage() {
    const prefix = String(CFG.AGENT_PATH || '/agent').replace(/\/+$/, '');
    if (!prefix) return true;
    const path = location.pathname || '';
    return path === prefix || path.startsWith(prefix + '/');
  }

  async function boot() {
    if (booted) return;
    if (!isAgentPage()) {
      log('dormant on a non-agent page:', location.href);
      watchForAgentPath();
      return;
    }
    booted = true;
    try {
      // SPA navigation reached the agent page after load: make sure the hook
      // re-injected through scripting.executeScript sees the marker too.
      (document.documentElement || document).setAttribute('data-aab-agent', '1');
    } catch (_) {
      /* ignore */
    }
    if (document.body) Badge.mount();
    else document.addEventListener('DOMContentLoaded', () => Badge.mount(), { once: true });
    await UserSettings.load();
    await Transport.loadOverride();
    Bridge.start();
    log('content script ready on', location.href, '- server:', Transport.url());
    // Do not block the bridge on the optional stream hook.
    PageHook.ensure().then((ok) => {
      Bridge.reportState();
      if (ok) log('page hook active (%s)', StreamCapture.hookSource);
    });
  }

  /**
   * While dormant, follow client-side (SPA) navigation so a user who opened
   * `arena.ai/` and then routed to `/agent` still gets the bridge:
   * pushState/replaceState and popstate are covered immediately, and a slow
   * 10 s check is the backstop for navigations that fire neither.  A full
   * page load re-injects the script from the manifest, so this only serves
   * the in-page case (and costs one string comparison per 10 s while away).
   */
  function watchForAgentPath() {
    if (window.__AAB_PATH_WATCH__) return;
    window.__AAB_PATH_WATCH__ = true;
    const check = () => {
      if (!booted && isAgentPage()) boot();
    };
    try {
      const wrap = (name) => {
        const original = history[name];
        if (typeof original !== 'function') return;
        history[name] = function patchedHistoryMethod() {
          const result = original.apply(this, arguments);
          check();
          return result;
        };
      };
      wrap('pushState');
      wrap('replaceState');
      window.addEventListener('popstate', check);
      setInterval(check, 10000);
    } catch (_) {
      /* not a DOM environment (tests) - boot() has already decided */
    }
  }

  window.__AAB__ = {
    config: CFG,
    bridge: Bridge,
    transport: Transport,
    driver: SiteDriver,
    capture: StreamCapture,
    pageHook: PageHook,
    signal: Signal,
    pipeline: Pipeline,
    diagnose: () => SiteDriver.diagnose(''),
  };

  boot();
})();
