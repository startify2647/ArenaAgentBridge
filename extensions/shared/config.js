/**
 * ArenaAgentBridge - extensions/shared/config.js
 * ---------------------------------------------------------------------------
 * THE ONLY FILE YOU NEED TO EDIT WHEN THE WEBSITE CHANGES.
 *
 * Everything site-specific lives here: the WebSocket address of the local
 * server, the DOM selectors, the stability thresholds and the debug flags.
 * A content script runs at document_start, so this file is loaded before the
 * page exists (same reason the "shared" defaults are plain functions).
 *
 * You can also override anything at runtime from DevTools on the arena.ai tab:
 *     __AAB_CONFIG__.BEHAVIOR.STABLE_MS = 1500;
 *     __AAB_CONFIG__.selectors.input[0] = 'textarea.my-new-class';
 */
(function () {
  'use strict';

  const DEFAULTS = {
    /** Local bridge server (FastAPI). Loopback only - never point this at a remote host. */
    SERVER_WS_URL: 'ws://127.0.0.1:8000/ws/browser',
    SERVER_HTTP_URL: 'http://127.0.0.1:8000',
    /**
     * Optional shared secret for the extension socket: the content script appends
     * it as `?token=…` and the server (AAB_WS_TOKEN) must accept it.  Empty =
     * the server's origin check alone decides who may connect.
     */
    WS_TOKEN: '',
    /**
     * Where the content script is allowed to automate.  On every OTHER
     * arena.ai page the script stays dormant (no socket, no observers, no
     * badge) so normal browsing costs (almost) nothing.
     */
    SITE_MATCH: 'https://arena.ai/agent',
    AGENT_PATH: '/agent',

    /**
     * 'lease'  = the background worker picks ONE arena.ai tab to own the bridge
     *            connection (recommended: the server is single-client anyway)
     * 'direct' = every tab connects on its own; the server keeps the newest one
     *            (fine if you only ever open a single tab)
     */
    TRANSPORT_MODE: 'lease',

    /**
     * DOM selectors, tried in order. Each entry is a CSS selector *or* an object
     * `{css: '…', text: 'Send', tag: 'button'}` to also filter on text content.
     */
    selectors: {
      /** The prompt box. First visible hit wins. */
      input: [
        'textarea[name="message"]',
        '[data-testid="chat-input"]',
        '[data-testid="prompt-input"]',
        'form textarea',
        'textarea[placeholder]',
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"].ProseMirror',
        '[role="textbox"]',
        '[contenteditable="true"]',
        'textarea',
      ],
      /** The submit button (clicked when it is not disabled). */
      sendButton: [
        { css: 'button[aria-label="Send message"]' },
        { css: 'button[aria-label="Send"]' },
        { css: 'button[data-testid="send-button"]' },
        { css: 'button[type="submit"]', text: ['send', 'ask', 'run'] },
        { css: 'form button', text: ['send', 'ask', 'run'] },
        { css: '[data-testid*="send"]' },
        { css: 'button', text: ['send', 'ask', 'run'], tag: 'button' },
        { css: '[role="button"]', text: ['send', 'ask', 'run'] },
      ],
      /** Present only while the site is still generating -> used as "still streaming". */
      stopButton: [
        { css: 'button[aria-label="Stop generating"]' },
        { css: 'button[aria-label="Stop"]' },
        { css: 'button[data-testid="stop-button"]' },
        { css: 'button', text: ['stop generating', 'stop response', 'stop'] },
      ],
      /** "New chat" button - used by the reset-between-turns option. */
      newChat: [
        { css: 'button[aria-label="New chat"]' },
        { css: '[data-testid="new-chat"]' },
        { css: 'a[href="/agent"]', text: ['new'] },
        { css: 'button', text: ['new chat', 'new conversation', 'new task'] },
      ],
      /** Every message, when the site exposes a role attribute. */
      messageRoleAny: [
        '[data-agent-transcript-message]',
        '[data-message-author-role]',
        '[data-role="assistant"], [data-role="user"]',
        '.message[data-author]',
      ],
      /** Assistant messages, most specific first. */
      assistantMessage: [
        // arena.ai agent transcript: every turn is [data-agent-transcript-message];
        // roleOf() keeps only the turns WITHOUT [data-user-message-layout].
        '[data-agent-transcript-message]',
        '[data-message-author-role="assistant"]',
        '[data-role="assistant"]',
        '[data-author="assistant"]',
        '[class*="assistant"][class*="message"]',
        '[class*="message"][class*="assistant"]',
        '[class*="Message"][class*="assistant"]',
      ],
      /** Fallback: generic message container (assumed in order user, assistant, ...). */
      messageGeneric: [
        '[data-testid="message"]',
        '[class*="chat-message"]',
        '[class*="ChatMessage"]',
        'main article',
        'main li[class*="message"]',
        'main [class*="turn"]',
        'main [class*="bubble"]',
        'main [class*="markdown"]',
      ],
      /**
       * The "how did I do?" poll the site shows in the composer after an
       * *agent-mode* answer (usually three buttons: Keep working / something
       * else).  The bridge clicks "Keep working" so the next prompt still has a
       * free chat box - in `direct` mode this survey does not exist.
       */
      keepWorking: [
        { css: '[data-testid="keep-working"]' },
        { css: '[data-testid*="keep-working"]' },
        { css: 'button[aria-label*="keep working" i]' },
        { css: 'button[aria-label*="keep going" i]' },
        { css: 'button', text: ['keep working', 'keep going', 'continue working'] },
        { css: '[role="button"]', text: ['keep working', 'keep going'] },
      ],
      /** The poll container itself (only used to recognise the survey). */
      survey: [
        '[data-testid*="survey"]',
        '[data-testid*="feedback"]',
        '[data-testid*="poll"]',
        '[class*="survey"]',
        '[class*="Survey"]',
      ],
      /** Login walls - the bridge never logs in for you. */
      loginWall: [
        'button[data-testid="login"]',
        'a[href*="/login"]',
        'a[href*="/signin"]',
        'button',
      ],
      /** Captcha / bot-check widgets - reported, never solved. */
      captcha: [
        'iframe[src*="recaptcha"]',
        'iframe[src*="hcaptcha"]',
        'iframe[src*="turnstile"]',
        'iframe[title*="captcha" i]',
        '[class*="captcha"]',
        '#captcha',
        '[data-testid*="captcha"]',
      ],
      /** Nodes removed from the extracted text (buttons, toolbars, icon spam). */
      ignoreInside: [
        'button',
        'svg',
        'nav',
        'script',
        'style',
        'noscript',
        '[role="toolbar"]',
        '[aria-hidden="true"]',
        '[class*="copy"]',
        '[class*="toolbar"]',
        '[class*="feedback"]',
        '[class*="citation"]',
      ],
    },

    behavior: {
      /** --- prompt injection ------------------------------------------------ */
      /** Characters typed per tick when "human typing" is used for short prompts. */
      TYPE_CHUNK_CHARS: 12,
      TYPE_DELAY_MS: 25,
      /** Above this length the prompt is inserted in one shot (typing would be slow). */
      MAX_TYPED_CHARS: 6000,
      SUBMIT_DELAY_MS: 250,
      /** Wait for the UI to register the submit before failing with `submit_failed`. */
      START_CONFIRM_MS: 15000,
      /** How long to wait for the chat box to exist (SPA hydration / navigation). */
      INPUT_WAIT_MS: 20000,

      /** --- answer capture --------------------------------------------------- */
      POLL_INTERVAL_MS: 300,
      /**
       * Adaptive capture tick: while the answer is actively growing the loop
       * wakes every TICK_FAST_MS (the end of the stream is caught up to half
       * a second sooner); when it is settled the loop keeps the normal
       * POLL_INTERVAL_MS rate - but each quiet tick now costs almost nothing
       * (cached text, cached probes, the fast selector path), which is what
       * used to make the tab feel heavy while it sat idle.  DOM/stream
       * events wake the loop early either way.  `false` restores the old
       * fixed-interval behaviour.
       */
      ADAPTIVE_TICK: true,
      TICK_FAST_MS: 150,
      /** Text unchanged for this long => the answer is finished. */
      STABLE_MS: 3000,
      /** Never accept an answer before this (protects against a 1-token flash). */
      MIN_ANSWER_WAIT_MS: 1500,
      /** Streaming network + DOM both silent for this long => finished (fast path). */
      SSE_IDLE_MS: 1200,
      /** Text unchanged for this long while the site still shows a Stop button
       *  => assume it hung and return what we have. */
      STALL_MS: 25000,
      /** Nothing at all after this long => error `no_output`. */
      NO_OUTPUT_MS: 60000,
      /** Hard cap per request, mirrors AAB_REQUEST_TIMEOUT on the server. */
      MAX_WAIT_MS: 300000,
      /**
       * Safety margin subtracted from the per-request budget: the decision
       * (and the answer) must reach the server BEFORE its own deadline, because
       * a throttled background tab may only wake once a minute.  Without the
       * margin the model can answer, the tab delivers late, and the client
       * still sees a timeout.
       */
      ANSWER_SEND_MARGIN_MS: 15000,
      /**
       * The *site activity* watchdog: neither the DOM nor the captured stream
       * changed for this long while the request is running => the page stopped
       * working (hung generation, dropped socket, frozen tab).  A stoppage is
       * reported straight away instead of waiting for the server's timeout.
       */
      IDLE_STALL_MS: 45000,
      /** At MAX_WAIT, return the partial answer instead of throwing it away. */
      PARTIAL_ON_TIMEOUT: true,
      /** Sample DOM for the "site silently ignores empty prompts" guard. */
      MIN_PROMPT_CHARS: 1,
      /** Start a new chat for every bridge request (clean context, slower, less
       *  likely to hit context limits). Off by default: keep the tab's context. */
      RESET_BEFORE_REQUEST: false,
      /** Press Escape / click Stop when the answer is accepted, so the tab is
       *  idle for the next request. */
      STOP_AFTER_CAPTURE: false,

      /** --- hand-off & keepalive -------------------------------------------- */
      /**
       * Agent mode ends every answer with a small poll in the composer
       * ("Keep working" / …).  Clicking "Keep working" is what makes the tab
       * ready for the next prompt.  Off = leave the survey alone (the next
       * request then has to deal with it).  Never used in `direct` mode.
       */
      AUTO_KEEP_WORKING: true,
      /** How long to keep looking for that survey after the answer goes quiet. */
      KEEP_WORKING_WAIT_MS: 4000,
      /** The answer must be quiet this long before the survey ends the turn. */
      SURVEY_SETTLE_MS: 700,
      /**
       * Keepalive while the site is busy: a heartbeat is sent at most this
       * often, driven by DOM/stream activity, so a throttled background tab
       * does not lose the socket to the server's ping timeout.
       */
      HEARTBEAT_MIN_MS: 5000,
      /** Show a small on-page badge with the bridge state. */
      SHOW_BADGE: true,
    },

    capture: {
      /** Parse the site's internal SSE stream (via an injected WebSocket hook) in
       *  addition to the DOM. Speeds up completion detection a lot; if the page
       *  changes the prefix format it degrades gracefully to DOM-only. */
      ENABLED: true,
      /**
       * How inject.js gets into the page world:
       *   'manifest'  the browser injects it (Chrome 111+ / Firefox 128+), best
       *               case: it runs before any page script
       *   'runtime'   the content script calls scripting.executeScript(world:'MAIN')
       *               and falls back to a <script src> tag
       * The hook is optional: without it capture reports DOM-only, which is
       * slower but still correct. Firefox may block page-world injection when the
       * site ships a strict Content-Security-Policy.
       */
      INJECTION: 'manifest',
      /**
       * The hook only forwards the site's traffic while a bridge request is
       * running (the content script marks the document with
       * `data-aab-capture`); idle browsing costs nothing.
       */
      CAPTURE_FLAG: 'data-aab-capture',
      /** stream payload prefixes: 'a0:' main text, 'ag:' reasoning, 'ad:' data.
       *  If the site rotates them (a1:/b0:/…), the first letter+digit prefix
       *  seen during a request is adopted automatically. */
      PREFIX_MAIN: 'a0:',
      PREFIX_REASONING: 'ag:',
      PREFIX_DATA: 'ad:',
      /** Ring buffer size for captured frames (parsed once, on arrival). */
      MAX_FRAMES: 200,
      /** Frames kept while idle, for the popup's "Diagnose DOM" view. */
      IDLE_TAIL_FRAMES: 16,
      /** Ignore streams not matching these (regex, as string). */
      URL_FILTER: 'arena\\.ai|/api/|/chat|completion|stream',
      /** Give the page hook this long to announce itself before trying again. */
      HOOK_TIMEOUT_MS: 2500,
    },

    debug: {
      VERBOSE: true,
      /** Log the prompt/answer lengths (never the content) to the page console. */
      LOG_LENGTHS: true,
      MAX_LOG_CHARS: 500,
    },
  };

  // `window` exists in the content script / popup, but a Manifest V3 service
  // worker only has `self` - stay compatible with both.
  const glob = typeof window !== 'undefined' ? window : self;

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const CONFIG = glob.__AAB_CONFIG__ ? deepMerge(clone(DEFAULTS), glob.__AAB_CONFIG__) : clone(DEFAULTS);

  function deepMerge(base, override) {
    if (!override || typeof override !== 'object') return base;
    for (const key of Object.keys(override)) {
      const value = override[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        base[key] = deepMerge(base[key] && typeof base[key] === 'object' ? base[key] : {}, value);
      } else if (value !== undefined) {
        base[key] = value;
      }
    }
    return base;
  }

  CONFIG.version = '1.5.0';
  CONFIG.VERSION = CONFIG.version; // convenience alias used by the popup / background

  // Content scripts, the background worker and the popup all read
  // `window.__AAB_CONFIG__` (or `self.__AAB_CONFIG__` in a service worker).
  glob.__AAB_CONFIG__ = CONFIG;
})();
