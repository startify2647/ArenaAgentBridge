<div dir="rtl">

# فایرفاکس

[English](FIREFOX.md) · [README فارسی](../README.fa.md)

پل همان کد مشترک را در کروم/اج و فایرفاکس اجرا میکند؛ تنها تفاوت در manifest است
(`extensions/firefox/manifest.json`). این صفحه نکات خاص فایرفاکس را توضیح میدهد.

## نصب

۱. افزونهها را بسازید (هیچچیز در گیت تکرار نشده است):

   ```bash
   python scripts/build-extensions.py        # یا: make build
   ```

۲. `about:debugging#/runtime/this-firefox` را باز کنید.
۳. **Load Temporary Add-on…** و انتخاب `dist/firefox/manifest.json`.
۴. <https://arena.ai> را باز کنید (صفحهٔ کار `/agent` است)، وارد شوید و روی آیکون
   افزونه کلیک کنید.

### دادن مجوز میزبان (یکبار)

در MV3 فایرفاکس مجوزهای میزبان **opt-in** هستند؛ ممکن است افزونهٔ تازهنصب اجازهٔ
ارتباط با `ws://127.0.0.1:8000` را نداشته باشد. در این حالت پاپآپ یک کارت زرد
**Grant permissions** نشان میدهد؛ یک بار بزنید و به درخواست اجازه (برای
`127.0.0.1:8000`، `localhost:8000` و `arena.ai`) پاسخ مثبت بدهید. مسیر دستی معادل:
`about:addons` → ArenaAgentBridge → تب **Permissions**.

بدون این مجوز در پاپآپ `browser_offline` میبینید و نشان خاکستری میماند؛ خودکارسازی
DOM کار میکند، ولی وبسوکت به سرور محلی مسدود است.

### حفظ افزونه پس از بستن مرورگر

افزونههای موقت با بسته شدن فایرفاکس حذف میشوند. در نسخههای Release/ESR فقط
افزونههای **امضاشده** دائمی نصب میشوند و `xpinstall.signatures.required` تنها در
Firefox Developer Edition، Nightly یا ESR با سیاستهای سازمانی قابل خاموشکردن است.
گزینهها:

| گزینه | روش |
| --- | --- |
| توسعهٔ روزمره | هر جلسه Temporary Add-on را لود کنید (۱۰ ثانیه) |
| Developer Edition / Nightly | `about:config` → `xpinstall.signatures.required = false`، سپس `python scripts/build-extensions.py --zip` و نصب فایل `.zip` از `dist/` |
| نصب دائمی روی Release | امضای شخصی در [addons.mozilla.org](https://addons.mozilla.org/developers/) (حالت unlisted/self-distribution رایگان است) با `web-ext sign` |
| بدون نصب | همان افزونهٔ موقت کافی است؛ سرور بین جلسات چیزی به خاطر نمیسپارد |

## چرخهٔ توسعه

```bash
./scripts/firefox-dev.sh          # web-ext run: فایرفاکس را با افزونه بالا میآورد
./scripts/firefox-dev.sh --lint   # اعتبارسنج موزیلا (در CI هم اجرا میشود)
```

`web-ext run` به فایرفاکس نصبشده و `npx` نیاز دارد؛ یک پروفایل موقت با افزونهٔ لودشده
باز میکند و با هر تغییر فایل، افزونه را دوباره بارگذاری میکند.

چرخهٔ دستی بدون `web-ext`:

۱. `python scripts/build-extensions.py --browser firefox`
۲. `about:debugging` → **Reload** کنار افزونه پس از هر تغییر
۳. لاگ content script در کنسول صفحه (`[ArenaAgentBridge]`) و لاگ background در
   `about:debugging` → **Inspect**.

## تفاوت با کروم

| بخش | کروم | فایرفاکس |
| --- | --- | --- |
| Background | service worker در MV3 (`background.service_worker`) | event page (`background.scripts: [config.js, background.js]`) |
| `importScripts` | موجود و برای لود `config.js` استفاده میشود | **وجود ندارد** — بهجایش manifest اول `config.js` را فهرست میکند |
| مجوز میزبان | هنگام نصب اعطا میشود | **opt-in**، با `chrome.permissions.request` از پاپآپ |
| کمینهٔ `alarms` | ۳۰ ثانیه | ۱ دقیقه (`PING_PERIOD_MINUTES = 1` در هر دو) |
| هوک دنیای صفحه | `content_scripts.world: "MAIN"` (کروم ۱۱۱+) | همان کلید (فایرفاکس ۱۲۸+)، ولی تابع CSP سایت → ممکن است به DOM-only برگردد |
| `chrome.scripting` از content script | مجاز | مجاز، ولی نیازمند مجوز میزبان؛ در هر دو مرورگر worker تزریق را انجام میدهد |
| دیدن URL تبها | همیشه | تا اعطای مجوز میزبان (یا مجوز optional `tabs`) پنهان است — پاپآپ بدون خطا کنار میآید |
| کمینهٔ نسخه | کروم/اج ۱۱۱ | فایرفاکس ۱۲۸ |

بقیهٔ چیزها — خودکارسازی DOM، هوک استریم، قالب درخواست/پاسخ و سرور سازگار با OpenAI —
یکسان است و تستها **همان جاوااسکریپت مشترک** را برای هر دو مرورگر اجرا میکنند.

## اعتبارسنجی

```bash
python scripts/build-extensions.py --check          # اعتبار هر دو manifest
npx --yes web-ext lint --source-dir dist/firefox    # ۰ خطا / ۰ هشدار
node tests/extension_dom_test.mjs                   # خط لولهٔ DOM (۴۹ چک)
```

CI هر سه را بهعلاوهٔ مجموعهٔ تست پایتون اجرا میکند.

## محدودیتهای شناختهشدهٔ فایرفاکس

- **کندشدن تب پسزمینه.** فایرفاکس تایمرهای تب پسزمینه را محدود میکند؛ به همین دلیل
  تشخیص پایان پاسخ رویدادمحور است (MutationObserver + فریمهای استریم) و نه فقط تایمر.
  برای کارهای طولانی تب را در پنجرهٔ جدا نگه دارید.
- **CSP سختگیرانه.** اگر سایت CSPای داشته باشد که اسکریپت `moz-extension:` را ممنوع
  کند، هوک دنیای صفحه اجرا نمیشود و افزونه به حالت فقط-DOM برمیگردد. این فقط تشخیص
  پایان را کمی کندتر میکند؛ در پاپآپ → *Diagnose DOM* وضعیت
  `page hook: inactive` دیده میشود.
- **تبهای کانتینری / پنجرهٔ خصوصی.** پنجرهٔ خصوصی زمینهٔ افزونهٔ جدایی دارد؛ اتصال پل از
  همان تبی پیروی میکند که اجارهٔ اتصال را دارد، پس یک تب کاری نگه دارید و بقیه را ببندید.
- **فایرفاکس اندروید** آزمایش نشده است؛ پاپآپ و خودکارسازی برای دسکتاپ طراحی شدهاند.

</div>
