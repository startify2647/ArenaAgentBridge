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

### دستشکی و احراز هویت (۱.۴.۱+)

سرور فقط *چی* میگویید را نمیبیند، *کی* می‌آمید را هم بررسی میکند:

* **بررسی Origin.** سوکت مرورگری هدر `Origin` دارد. سرور فقط مبدأ تب
  arena.ai، مبدأهای لوکال و مبدأ افزونه را میپذیرد؛ هر چیز دیگر **قبل از**
  کامل شدن ارتقا رد میشود (کد بستهشدن `4403`). با این کار وب‌صفحهٔ تصادفی
  دیگر نمی‌تواند افزونه را جعل کند، پرامپت‌های صف را بخواند یا پاسخ جعلی
  تزریق کند. کلاینتهای غیرمرورگر (CLI، `curl`، تستها) Origin نمیفرستند و
  مجازند — چون سرور ذاتاً فقط روی لوکال گوش میدهید. فهرست مجاز
  `AAB_WS_ORIGIN_REGEX` است (با الگوی نامعتبر، «بسته» میماند، نه باز).
* **راز مشترک اختیاری.** اگر `AAB_WS_TOKEN` تنظیم باشد، کلاینت باید همان
  مقدار را ارائه دهد — یا بهصورت `?token=…` در آدرس (افزونه این کار را
  خودکار از «توکن وب‌سوکت سرور» انجام میدهد) یا داخل فریم `hello`
  (`"token": "…"`). توکن گمشده/نادرست با
  `{"type":"error","error":"bad_token"}` و کد بستهشدن `4401` پاسخ میدهد.

### افزونه → سرور

```jsonc
{"type":"hello","client":"chrome-extension","version":"1.5.0","url":"https://arena.ai/agent","token":"…"}
{"type":"heartbeat","state":"idle|answering","busy":false,"url":"https://arena.ai/agent"}
{"type":"pong","ts":1712345678.9}
{"type":"response","id":"<uuid>","response":"متن یا null","error":null,
 "meta":{"duration_ms":8123,"stop_reason":"پایین را ببینید","from_stream":false,
         "kept_working":{"found":true,"clicked":true,"cleared":true,"input":true,"label":"Keep working"},
         "stream":{"frames":96,"mainChars":812,"reasoningChars":0,"sawDone":true}}}
{"type":"diag","id":"<uuid>","state":"idle|answering","busy":false,
 "url":"https://arena.ai/agent",
 "diag":{"selectorCounts":{"input":1,"sendButton":1},"captcha":false,"loggedIn":true},
 "config":{"serverUrl":"ws://127.0.0.1:8000/ws/browser","stableMs":3000,"capture":true}}
```

`diag` پاسخ فریم `diagnose` است (نسخهٔ ۱.۲.۰ به بعد)؛ دکمهٔ *Diagnose DOM* در پنل
مدیریت و اندپوینت `/admin/api/browser/diagnose` از آن استفاده می‌کنند تا وضعیت
زندهٔ صفحه را بدون دست‌زدن به صف ببینند. اکستنشن‌های قدیمی‌تر از ۱.۲.۰ این درخواست
را نادیده می‌گیرند و سرور `diagnostics_timeout` گزارش می‌کند.

`selectorCounts` همهٔ فهرست‌های سلکتور `config.js` (از جمله `keepWorking` و `survey`) را
پوشش می‌دهد و `checks` دو فیلد `surveyVisible` و `keepWorkingVisible` دارد؛ وقتی فقط مسیر
خواندنی کار می‌کند همین‌ها را ببینید.

### پایان یک نوبت

افزونه نوبت را با **اولین** شرطی که برقرار شود تمام می‌کند:

| `stop_reason` | چه شد |
| ------------- | ----- |
| `stable` | متن پاسخ به مدت `STABLE_MS` تغییر نکرد |
| `sse_done` | استریم خودِ سایت پایان را اعلام کرد |
| `sse_idle` | استریم ضبط‌شده ساکت شد و متن ثابت بود |
| `stream_text` | DOM عنصر پاسخ را نشان نمی‌داد، پس متن از فریم‌های `a0:` بازسازی شد |
| `survey` | نظرسنجی پایان پاسخ در کادر چت ظاهر شد (حالت agent) |
| `stalled` | رشد متن برای `STALL_MS` متوقف شد و دکمهٔ Stop هنوز بود - پاسخ جزئی |
| `site_idle` | نه صفحه و نه استریم سایت برای `IDLE_STALL_MS` تغییر نکرد - بدون متن *خطا*، با متن پاسخ جزئی |
| `timeout_partial` | مهلت درخواست رسید و متن در دست بود (`PARTIAL_ON_TIMEOUT=true`) |

دو مورد آخر برای این‌اند که تب فریزشده یا پس‌زمینه هیچ‌وقت درخواست را تا timeout خود سرور
معطل نگه ندارد: افزونه خودش توقف را گزارش می‌کند و سرور `site_idle` را به `504 page_timeout`
(با پاسخ جزئی، اگر باشد) نگاشت می‌کند.

دو قاعدهٔ دیگر هم برای مصرف‌کننده مهم است:

* **فقط حالت agent** - سایت بعد از پاسخ یک نظرسنجی سه‌گزینه‌ای در کادر چت نشان می‌دهد؛
  افزونه روی *Keep working* کلیک می‌کند (`AUTO_KEEP_WORKING`)، تا برگشتن کادر صبر می‌کند و
  `meta.kept_working` را گزارش می‌دهد. حالت direct نظرسنجی ندارد و چیزی کلیک نمی‌شود.
* **Keepalive** - تب پس‌زمینه `setInterval` را throttle می‌کند، پس هر تغییر DOM یا فریم
  ضبط‌شده یک ضربان هم می‌فرستد (`HEARTBEAT_MIN_MS`)؛ بدون آن سرور کلاینتی را که مشغول
  پاسخ دادن است حذف می‌کند.
* `request` تکراری با همان `id` (اتصال دوبارهٔ سمت سرور) تا وقتی همان نوبت در جریان است
  نادیده گرفته می‌شود، نه این‌که با `busy` پاسخ بگیرد.

مقادیر مجاز `error`: `captcha`، `not_logged_in`، `selector_missing`، `submit_failed`،
`no_output`، `response_timeout`، `page_error`، `busy`، `empty_prompt`، `unknown_error`.

### سرور → افزونه

```jsonc
{"type":"welcome","version":"1.3.0","queue":0,"timeout_default":300}
{"type":"request","id":"<uuid>","prompt":"...","mode":"agent","timeout":300}
{"type":"ping","ts":1712345678.9}
{"type":"cancel","id":"<uuid>","reason":"timeout|operator"}
{"type":"replaced","reason":"another arena.ai tab connected"}
{"type":"diagnose","id":"<uuid>"}
{"type":"shutdown","reason":"operator disconnected the tab"}   → close code 4004
```

`cancel` وقتی هم می‌رسد که کسی در پنل مدیریت *Cancel* را بزند (کلاینت HTTP کد
`499 cancelled` می‌گیرد) و `shutdown` پیش از بسته‌شدن سوکت در *Disconnect* فرستاده
می‌شود — اکستنشن آن را «بعداً برمی‌گردم» می‌فهمد و با تأخیر ۱۰ ثانیه دوباره وصل می‌شود.

### قواعد ترتیب

- افزونه بلافاصله پس از باز شدن سوکت `hello` میفرستد و سپس حداقل هر ۳۰ ثانیه یک
  `heartbeat`. سرور هر `AAB_HEARTBEAT_INTERVAL` (پیشفرض ۲۰ ثانیه) یک `ping` میفرستد و
  کلاینتی که سه بازه ساکت بماند را حذف میکند.
- سرور در هر لحظه **فقط یک** `request` در جریان نگه میدارد؛ درخواست بعدی تنها پس از
  دریافت `response` قبلی فرستاده میشود. افزونه نباید چیزی را بافر کند.
- تبهای پسزمینه توسط مرورگر کند میشوند؛ به همین دلیل افزونه پایان پاسخ را از تغییرات
  DOM و فریمهای استریم گرفتهشده تشخیص میدهد، نه فقط با تایمر — و به همین دلیل
  کارِ خود را `ANSWER_SEND_MARGIN_MS` (۱۵ ثانیه) *قبل از* مهلت سرور تمام میکند تا
  تبی که فقط یکبار در دقیقه بیدار میشود هم پاسخ را به‌موقع برساند.
- `response`ای که در لحظهٔ تحویل قابل ارسال نبود (سوکت همین لحظه قطع بود) در یک صف
  خروجی کوچک نگه داشته و پس از بازگشت سوکت ارسال میشود.
- اگر سوکت افزونه در میانهٔ درخواست قطع شود، سرور درخواستِ در جریان را تا
  `AAB_RECONNECT_GRACE` (۸ ثانیه) زنده نگه میدارد: کلاینتِ دوباره وصلشده همان
  `request` (با همان id) را دوباره دریافت میکند — افزونه‌ای که هنوز مشغول پاسخ
  دادن به آن است نسخهٔ تکراری را نادیده میگیرد و تبِ تازه هم ساده پاسخ میدهد.
  فقط تبی که برنگردد به `browser_disconnected` منجر میشود.
- اگر تب دومی وصل شود و `AAB_SINGLE_CLIENT=1` باشد، سرور به تب قبلی پیام `replaced` و
  کد بستن `4000` میفرستد؛ درخواست در جریان آن تب نیز همان‌طور به تب جدید دوباره
  فرستاده میشود.
- اگر کلاینت HTTPِ مالک یک درخواست از بین برود (قطع SSE یا لغو درخواست)، سرور آن
  درخواست را روی پل **لغو** میکند به‌جای اینکه تب برای جوابِ کسی که دیگر منتظر
  نیست زحمت بکشد: سمت HTTP `499 client_disconnected` میبیند و وقتی پرامپت
  تایپ شده باشد، فریم `cancel` با `reason: client_disconnected` به صفحه میرسد.

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

مدل هزینه در نسخهٔ ۱.۴: هوک فقط **هنگام اجرای یک درخواست پل** ترافیک را منتقل میکند
— اسکریپت محتوا برای مدت یک نوبت `<html data-aab-capture>` را علامت میزند و
`inject.js` پیش از هر کاری آن ویژگی را بررسی میکند (درخواستی که بیرون از نوبت شروع
شود هرگز tee نمیشود). هر فریم فقط یک‌بار، در لحظهٔ رسیدن، در یک تجمیعگرِ مختص همان
درخواست پردازش میشود؛ هر تیکِ رصد فقط عکسِ فوری از وضعیت را میخواند. اگر سایت
پیشوندها را عوض کند (`a0:` به `b0:` و…)، اولین پیشوندِ حرف+عددِ دیده‌شده در همان
درخواست به‌طور خودکار پذیرفته میشود. و وقتی حتی استریم هم چیزی ندهد، اسکریپت محتوا
به «رهگیری رشد متن صفحه» برمیگردد: متن خوانای ناحیهٔ گفتگو را قبل از تایپ ثبت
میکند و پس از حذف اکوی پرامپت خودمان، هر متن تازه‌ای را که دیگر تغییر نکند
برمیگرداند — کندتر، ولی مقاوم به بازطراحی.

</div>
