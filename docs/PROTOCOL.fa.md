<div dir="rtl">

# پروتکل پل ArenaAgentBridge

[English](PROTOCOL.md) · [README فارسی](../README.fa.md)

دو رابط وجود دارد:

۱. **HTTP** (`localhost:8000`) — زبان Hermes/OpenClaw/curl: همان Chat Completions استاندارد OpenAI.
۲. **WebSocket** (`/ws/browser`) — زبان افزونهٔ مرورگر.

---

## ۱. سطح HTTP (سازگار با OpenAI)

| متد | مسیر | توضیح |
| --- | --- | --- |
| POST | `/v1/chat/completions` | با `stream: true/false` بهعلاوهٔ فیلدهای اختصاصی پل (پایینتر) |
| GET | `/v1/models` | `arena-agent`، `arena-agent-direct` |
| GET | `/v1/bridge/status` | وضعیت اتصال، عمق صف، تأخیرها، خطاهای اخیر |
| GET | `/healthz` | سلامت سرویس (همیشه ۲۰۰) |
| GET | `/readyz` | ۲۰۰ وقتی مرورگر وصل است، در غیر این صورت ۵۰۳ |
| GET | `/` | داشبورد وضعیت تکصفحهای |
| WS | `/ws/browser` | افزونه به اینجا وصل میشود |

برای کلاینتهای سهلانگار، همان مسیرها بدون پیشوند `/v1` هم پاسخ میدهند
(`/chat/completions`، `/models`، `/bridge/status`).

### درخواست

هر چیزی که کلاینتهای OpenAI میفرستند پذیرفته میشود؛ فیلدهای ناشناخته نادیده گرفته میشوند.

```jsonc
{
  "model": "arena-agent",          // "arena-agent-direct" => بدون مقدمهٔ ایجنت
  "messages": [                     // نقشهای system/user/assistant/tool، متن یا آرایهٔ بخشها
    {"role": "system", "content": "کوتاه جواب بده"},
    {"role": "user", "content": "سلام"}
  ],
  "stream": false,

  // --- فیلدهای اختصاصی پل ------------------------------------------------
  "timeout": 300,        // چند ثانیه برای پاسخ صفحه صبر کند (به سقف AAB_* محدود میشود)
  "mode": "agent",       // "agent" یا "direct" — حالت پیشفرض را بازنویسی میکند
  "no_sanitize": false   // ایمنسازِ دستورهای مخرب را برای این درخواست خاموش میکند
}
```

پارامترهای `temperature`، `top_p`، `max_tokens`، `stop`، `tools`، `response_format` و…
پذیرفته و **نادیده گرفته** میشوند — رابط وب راهی برای دریافت آنها ندارد. مقدار `n > 1`
تنها یک choice برمیگرداند و در لاگ هشدار ثبت میشود.

### پاسخ

```jsonc
{
  "id": "chatcmpl-6a1f...",
  "object": "chat.completion",
  "created": 1712345678,
  "model": "arena-agent",
  "choices": [{"index": 0, "message": {"role": "assistant", "content": "..."},
               "finish_reason": "stop"}],
  "usage": {"prompt_tokens": 42, "completion_tokens": 17, "total_tokens": 59},
  "x_bridge": {
    "request_id": "chatcmpl-6a1f...",
    "mode": "agent",
    "browser_duration_ms": 8123,  // زمان داخل صفحه
    "total_duration_ms": 8210,    // از HTTP تا HTTP
    "queue_wait_ms": 0,
    "sanitized": true,
    "sanitize_mode": "redact",
    "sanitize_findings": [{"pattern": "rm_rf_root", "kind": "destructive-fs",
                           "severity": "block", "match": "rm -rf /", "line": 3}],
    "browser_meta": {"stop_reason": "stable", "stream": {"mainChars": 812, "frames": 96}},
    "streamed": false
  }
}
```

مقدار `usage` **تخمینی** است (حدود ۴ کاراکتر برای هر توکن)، چون رابط وب تعداد واقعی
توکن را در اختیار نمیگذارد.

### جریان (Streaming)

با SSE و همان معناشناسی chunkهای OpenAI:

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"سلام "}}]}
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"x_bridge":{...,"streamed":true}}
data: [DONE]
```

صفحه جریان افزایشی قابل اعتمادی ارائه نمیدهد، پس پاسخ کامل گرفته و بعد بهصورت
تکهتکه پخش میشود (`AAB_STREAM_CHUNK_CHARS` / `AAB_STREAM_CHUNK_DELAY_MS`). کلاینت
یک جریان عادی میبیند؛ فیلد `x_bridge.streamed` نشان میدهد که شبیهسازیشده است.
**خطای وسط جریان** بهصورت یک فریم نهایی `data:` حاوی شیء `error` و سپس `[DONE]`
ارسال میشود.

### خطاها

کد وضعیت HTTP بههمراه بدنهٔ خطای استاندارد OpenAI:

```json
{"error": {"message": "...", "type": "bridge_error", "code": "captcha_required"}}
```

| کد | HTTP | معنا |
| --- | --- | --- |
| `invalid_messages` | 400 | مکالمهٔ خالی یا پرامپت بزرگتر از حد مجاز |
| `authentication_error` | 401 | با `AAB_REQUIRE_API_KEY=1` کلید اشتباه یا غایب است |
| `captcha_required` | 409 | کپچا روی صفحه است؛ باید دستی حل شود |
| `browser_busy` | 409 | تب از پذیرش درخواست همزمان دوم خودداری کرد |
| `queue_full` | 429 | صف پر است (`AAB_QUEUE_MAX_SIZE`) |
| `login_required` | 502 | تب از حساب خارج شده است |
| `dom_changed` | 502 | سلکتورها دیگر مطابقت نمیکنند (`config.js` را بهروز کنید) |
| `browser_disconnected` | 502 | افزونه یا تب وسط درخواست ناپدید شد |
| `browser_offline` | 503 | هیچ افزونهای وصل نیست |
| `browser_tab_missing` | 503 | افزونه وصل است ولی تب `arena.ai/agent` باز نیست |
| `page_timeout` | 504 | پاسخ در بازهٔ تعیینشده پایدار نشد |
| `server_error` | 500 | خطای غیرمنتظرهٔ پل (لاگ را ببینید) |

---

## ۲. پروتکل WebSocket (`/ws/browser`)

فریمهای متنی JSON، یک پیام در هر فریم.

### افزونه → سرور

```jsonc
{"type":"hello","client":"chrome-extension","version":"1.2.0","url":"https://arena.ai/agent"}
{"type":"heartbeat","state":"idle|answering","busy":false,"url":"https://arena.ai/agent"}
{"type":"pong","ts":1712345678.9}
{"type":"response","id":"<uuid>","response":"متن یا null","error":null,
 "meta":{"duration_ms":8123,"stop_reason":"stable|sse_done|sse_idle|stalled|captcha"}}
{"type":"diag","id":"<uuid>","state":"idle|answering","busy":false,
 "url":"https://arena.ai/agent",
 "diag":{"selectorCounts":{"input":1,"sendButton":1},"captcha":false,"loggedIn":true},
 "config":{"serverUrl":"ws://127.0.0.1:8000/ws/browser","stableMs":3000,"capture":true}}

`diag` پاسخ فریم `diagnose` است (نسخهٔ ۱.۲.۰ به بعد)؛ دکمهٔ *Diagnose DOM* در پنل
مدیریت و اندپوینت `/admin/api/browser/diagnose` از آن استفاده می‌کنند تا وضعیت
زندهٔ صفحه را بدون دست‌زدن به صف ببینند. اکستنشن‌های قدیمی‌تر از ۱.۲.۰ این درخواست
را نادیده می‌گیرند و سرور `diagnostics_timeout` گزارش می‌کند.
```

مقادیر مجاز `error`: `captcha`، `not_logged_in`، `selector_missing`، `submit_failed`،
`no_output`، `response_timeout`، `page_error`، `busy`، `empty_prompt`، `unknown_error`.

### سرور → افزونه

```jsonc
{"type":"welcome","version":"1.2.0","queue":0,"timeout_default":300}
{"type":"request","id":"<uuid>","prompt":"...","mode":"agent","timeout":300}
{"type":"ping","ts":1712345678.9}
{"type":"cancel","id":"<uuid>","reason":"timeout|operator"}
{"type":"replaced","reason":"another arena.ai tab connected"}
{"type":"diagnose","id":"<uuid>"}
{"type":"shutdown","reason":"operator disconnected the tab"}   → close code 4004

`cancel` وقتی هم می‌رسد که کسی در پنل مدیریت *Cancel* را بزند (کلاینت HTTP کد
`499 cancelled` می‌گیرد) و `shutdown` پیش از بسته‌شدن سوکت در *Disconnect* فرستاده
می‌شود — اکستنشن آن را «بعداً برمی‌گردم» می‌فهمد و با تأخیر ۱۰ ثانیه دوباره وصل می‌شود.
```

### قواعد ترتیب

- افزونه بلافاصله پس از باز شدن سوکت `hello` میفرستد و سپس حداقل هر ۳۰ ثانیه یک
  `heartbeat`. سرور هر `AAB_HEARTBEAT_INTERVAL` (پیشفرض ۲۰ ثانیه) یک `ping` میفرستد و
  کلاینتی که سه بازه ساکت بماند را حذف میکند.
- سرور در هر لحظه **فقط یک** `request` در جریان نگه میدارد؛ درخواست بعدی تنها پس از
  دریافت `response` قبلی فرستاده میشود. افزونه نباید چیزی را بافر کند.
- تبهای پسزمینه توسط مرورگر کند میشوند؛ به همین دلیل افزونه پایان پاسخ را از تغییرات
  DOM و فریمهای استریم گرفتهشده تشخیص میدهد، نه فقط با تایمر.
- اگر تب دومی وصل شود و `AAB_SINGLE_CLIENT=1` باشد، سرور به تب قبلی پیام `replaced` و
  کد بستن `4000` میفرستد.

---

## ۳. استریم شبیهسازیشده (مسیر اختیاری رصد)

افزونه ترافیک WebSocket/SSE خودِ صفحه را فقط برای فهمیدن *چه زمانی* تولید شروع و
تمام میشود رصد میکند (`extensions/shared/inject.js`). فریمها این شکل را دارند:

| پیشوند | معنا |
| --- | --- |
| `a0:` | متن اصلی پاسخ |
| `ag:` | استدلال / thinking |
| `ad:` | دادهٔ اضافه یا متادیتا |

این پیشوندها در `extensions/shared/config.js` (بخش `capture.*`) قابل تغییرند. از این
فریمها فقط طول متن و زمان آخرین فعالیت استفاده میشود — خودِ پاسخ همچنان از DOM خوانده
میشود؛ بنابراین تغییر پیشوندها سرعت را کم میکند، نه درستی را.

</div>
