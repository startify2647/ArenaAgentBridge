<div dir="rtl">

# اتصال فریمورکهای ایجنت

[English](HERMES_OPENCLAW.md) · [README فارسی](../README.fa.md)

پل عمداً «کسلکننده» است: با `POST /v1/chat/completions`، یک توکن Bearer و پاسخ
JSON استاندارد Chat Completions کار میکند. هر چیزی که بتواند با OpenAI (یا دروازههایی
مثل LiteLLM/OpenRouter) حرف بزند، با این هم حرف میزند.

| تنظیم | مقدار |
| --- | --- |
| Base URL / Endpoint | `http://127.0.0.1:8000/v1` |
| حالت سازگاری | **Chat Completions** (نه Responses API) |
| API key | هر مقداری، مثلاً `sk-arena` (فقط محلی) |
| Model ID | `arena-agent` (یا `arena-agent-direct`) |
| Streaming | پشتیبانی میشود (`stream: true`، SSE) |

> `arena-agent-direct` مقدمهٔ پل را حذف میکند و متن را همانطور که هست میفرستد؛ برای
> آزمایش دستی و پرامپتهای خیلی کوتاه مناسب است.

---

## Hermes

Hermes (و بیشتر رابطهای ایجنت محلی) بخش «Custom OpenAI-compatible provider» دارند:

```
Provider name : arena-bridge
Base URL      : http://127.0.0.1:8000/v1
API key       : sk-arena
Model         : arena-agent
Mode          : Chat Completions
Streaming     : on
```

سپس یک system prompt بدهید که به ایجنت بگوید از پل حرف میزند:

```
You are an autonomous coding agent. Your model endpoint is a bridge to a web UI,
so tools/function-calling are NOT available: never emit tool_calls, ask for the
result in plain text instead.
```

نکتهها:

- **Function/tool calling پشتیبانی نمیشود.** اگر ابزار شما اصرار دارد، برای این
  provider آن را خاموش کنید یا پل را بهعنوان یک مدل متنی ساده استفاده کنید.
- همزمانی را روی ۱ نگه دارید. سرور بقیه را صف میکند، ولی ایجنت شما فقط منتظر میماند؛
  صفحه هر چقدر طول بکشد، همان است.
- `usage` تخمینی است، پس حسابداری بودجهٔ توکن تقریبی خواهد بود.

## OpenClaw

همان شکل — *Settings → Models → Add custom provider*:

```
Type     : openai-compatible
Base URL : http://127.0.0.1:8000/v1
API Key  : sk-arena
Model    : arena-agent
Timeout  : 600   # اگر رابط چنین گزینهای دارد؛ وگرنه AAB_REQUEST_TIMEOUT=600 بگذارید
```

اگر OpenClaw هنگام شروع `/v1/models` را صدا بزند، `arena-agent` و
`arena-agent-direct` را میبیند و عادی فهرست میکند.

## Open WebUI / LibreChat / Anything-LLM

یک اتصال «OpenAI» با base URL برابر `http://127.0.0.1:8000/v1` و هر کلیدی بسازید. چون
پل فیلدهای ناشناخته را نادیده میگیرد، امکانات چندرسانهای/پیوست میتوانند روشن بمانند —
تصاویر بهجای شکستن درخواست، با `[image omitted by bridge]` جایگزین میشوند.

## کلاینت پایتونی عمومی

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8000/v1", api_key="sk-arena")

answer = client.chat.completions.create(
    model="arena-agent",
    messages=[
        {"role": "system", "content": "کوتاه جواب بده."},
        {"role": "user", "content": "race condition را در دو خط توضیح بده."},
    ],
    timeout=600,
)
print(answer.choices[0].message.content)
print(answer.model_extra["x_bridge"]["browser_duration_ms"], "ms inside the page")
```

## پروکسی LiteLLM جلوی آن

```yaml
model_list:
  - model_name: arena
    litellm_params:
      model: openai/arena-agent
      api_base: http://127.0.0.1:8000/v1
      api_key: sk-arena
      timeout: 600
```

## نکات پایداری برای ایجنتها

۱. بگذارید پل مالک مکالمه باشد: هر بار کل تاریخچه را بفرستید. صفحه خودش هم زمینهٔ
   جداگانهای نگه میدارد؛ اگر برای هر درخواست زمینهٔ تازه میخواهید، در تنظیمات افزونه
   `behavior.RESET_BEFORE_REQUEST = true` را روشن کنید.
۲. فقط یک منتظر داشته باشید. زیرایجنتهای موازی باید پل را به اشتراک بگذارند، نه اینکه
   چند تب مرورگر باز کنند — `AAB_SINGLE_CLIENT=1` یک تب را مرجع نگه میدارد.
۳. پاسخها را غیرقابل اعتماد بدانید: از یک صفحهٔ وب میآیند، پس ایمنساز سرور بهطور
   پیشفرض دستورهای مخرب شل را بیاثر میکند. اگر ایجنت شما میتواند دستور اجرا کند،
   `AAB_SANITIZE_MODE=redact` را نگه دارید و `x_bridge.sanitize_findings` را بخوانید.
۴. برای ۵۰۲/۵۰۳/۵۰۴ (`browser_offline`، `dom_changed`، `page_timeout`) با backoff
   دوباره تلاش کنید، ولی هرگز برای `captcha_required` تلاش مجدد نکنید — آن به دخالت
   انسان نیاز دارد.


## فراخوانی ابزار (tool calling) — حالت کارگزارِ پل

پل مثل `api.openai.com` استاندارد function calling را کامل پیاده می‌کند:

1. کلاینت آرایهٔ `tools` (قالب OpenAI) را در `/v1/chat/completions` می‌فرستد؛
2. پل متن پرامپت را با فهرست ابزارها + پروتکل JSON سخت‌گیرانه می‌سازد و مدلِ سایت را وادار به برنامه‌ریزی می‌کند؛
3. پاسخ به شکل `message.tool_calls` + `finish_reason: "tool_calls"` برمی‌گردد (بدنهٔ `content` معمولاً `null`)؛
4. **خودِ کلاینت ابزارها را اجرا می‌کند** (مثلاً terminal هرمس روی سیستم شما) و نتیجه را در نوبت بعد با پیام `role: "tool"` + `tool_call_id` برمی‌گرداند؛
5. حلقه تا پیام `{"final": ...}` ادامه می‌یابد که پل آن را به یک پاسخ معمولیِ `assistant` تبدیل می‌کند.

نکته‌ها:

- `stream: true` هم کار می‌کند (tool_calls در یک chunk و سپس `finish_reason`)؛
- `tool_choice`: `auto` (پیش‌فرض)، `none` (غیرفعال کردن کارگزار)، `required` و انتخاب یک تابع مشخص؛
- نام ابزارهای ناشناخته حذف می‌شوند؛ اگر پاسخ مدل JSON نباشد، پل همان متن را به‌صورت پاسخ معمولی برمی‌گرداند (بدون شکستن حلقه)؛
- پیام‌های `assistant` دارای `tool_calls` و پیام‌های `tool` در تاریخچه به‌شکل خوانا به مدل سایت می‌رسند؛
- سیاستِ سانسورِ دستورات مخرب (`AAB_SANITIZE_MODE`) روی آرگومانِ ابزارها هم اعمال می‌شود (و اگر JSON را خراب کند، آرگومان اصلی حفظ می‌شود).

</div>
