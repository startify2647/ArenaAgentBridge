<div dir="rtl">

# افزونهها

[English](README.md) · [README پروژه](../README.fa.md)

یک کدبیس مشترک، دو بستهٔ مرورگر، یک مرحلهٔ بیلد.

```
extensions/
├── shared/                 ← تنها جایی که کد ویرایش میشود
│   ├── config.js           سلکتورها، آستانهها، آدرس سرور  (از اینجا شروع کنید)
│   ├── content.js          مالک وبسوکت؛ خودکارسازی DOM
│   ├── inject.js           هوک دنیای صفحه برای رصد استریم (اختیاری، فقط خواندن)
│   ├── background.js       اجارهٔ اتصال، keepalive، پل scripting
│   ├── settings.js         مدل تنظیمات: اعتبارسنجی، ذخیره، اعمال، ورود/خروجی
│   ├── i18n.js             رشته‌های انگلیسی/فارسی + اعمال‌کنندهٔ data-i18n
│   ├── popup.html/js       وضعیت، تست سریع، Diagnose DOM، تنظیمات، لغو
│   ├── options.html/js     صفحهٔ کامل تنظیمات افزونه
│   └── icons/              آیکونهای مشترک
├── chrome/manifest.json    service worker، هوک world:MAIN، کروم ۱۱۱+
└── firefox/manifest.json   event page، gecko id، مجوز opt-in، فایرفاکس ۱۲۸+
```

بیلد، `shared/` را بههمراه یکی از manifestها در `dist/<مرورگر>/` کپی میکند؛ همان
پوشه چیزی است که در مرورگر لود میکنید:

```bash
python scripts/build-extensions.py            # هر دو
python scripts/build-extensions.py --browser firefox
python scripts/build-extensions.py --check    # فقط اعتبارسنجی، بدون نوشتن
python scripts/build-extensions.py --zip      # فایل zip برای استور / امضا
```

هیچچیز در گیت تکرار نمیشود و بیلد از ساختن بستهٔ خراب امتناع میکند (اختلاف نسخه،
فایل گمشده، نوع background نامناسب برای مرورگر، مجوز میزبان گسترده، `eval`).

## لود کردن

| مرورگر | روش |
| --- | --- |
| کروم / اج / بریو | `chrome://extensions` → Developer mode → **Load unpacked** → پوشهٔ `dist/chrome` |
| فایرفاکس ۱۲۸+ | `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → فایل `dist/firefox/manifest.json` → سپس دادن مجوز میزبان از پاپآپ (به [`../docs/FIREFOX.fa.md`](../docs/FIREFOX.fa.md) نگاه کنید) |

بعد <https://arena.ai/agent> را باز کنید، وارد شوید و نشان گوشهٔ پایین-راست صفحه را
ببینید. پاپآپ وضعیت سرور، تبِ متصل، فعال بودن هوک اختیاری استریم و دکمهٔ
**Diagnose DOM** و یک **تست سریع** (اجرای یک پرامپت از داخل مرورگر) را نشان
می‌دهد؛ تب تنظیمات هم به صفحهٔ کامل تنظیمات (*Extension details → Extension
options*) پیوند دارد.

سمت سرور هم داشبورد خودش را دارد: <http://127.0.0.1:8000/admin> — پنل زنده با
تاریخچهٔ درخواست‌ها، Playground، کنترل مرورگر و تنظیمات زمان اجرا.
راهنما: [`../docs/WEBUI.fa.md`](../docs/WEBUI.fa.md).

## ویرایش

- **سلکتورها / آستانهها / رفتار** → `shared/config.js`. همهچیز همراه با توضیح نوشته شده
  و میتوانید در کنسول صفحه هم مقدارها را زنده تغییر دهید:
  `__AAB_CONFIG__.selectors.input.unshift('textarea.my-new-class')`.
- **منطق خودکارسازی** → `shared/content.js` (`SiteDriver` = کار با DOM، `Pipeline` =
  تایپ→ارسال→دریافت، `Transport` + `Bridge` = وبسوکت، `PageHook` = هوک اختیاری صفحه).
- **تفاوت مرورگرها** → فقط manifestها. کد مشترک موتور را از روی وجود `chrome.*` و
  `browser.runtime.getBrowserInfo` تشخیص میدهد.
* **چیزهایی که کاربر می‌تواند تغییر دهد** → `shared/settings.js` (فهرست فیلدها،
  اعتبارسنجی و بازنویسی‌های `chrome.storage.local` که پاپ‌آپ و صفحهٔ تنظیمات
  ویرایش می‌کنند).

بعد از ویرایش، دوباره بیلد کنید (`python scripts/build-extensions.py`) و افزونه را در
مرورگر ریلود کنید. پیش از بیلد هم میتوانید تست کنید:

```bash
node tests/extension_dom_test.mjs        # ۴۹ چک DOM/خودکارسازی، بدون نیاز به مرورگر
python -m pytest tests/test_extension_static.py tests/test_build.py
```

## مجوزها، عمداً حداقلی

| مجوز | چرا |
| --- | --- |
| `storage` | نگهداشتن آدرس سرور و آخرین وضعیت برای پاپآپ |
| `alarms` | بیدار نگهداشتن worker در MV3 (workerها/event pageها تخلیه میشوند) |
| `scripting` | تزریق مجدد content script در تبهایی که قبل از نصب باز بودند و هوک اختیاری صفحه |
| میزبان `https://arena.ai/*` | همان سایتی که پل خودکارسازی میکند |
| میزبان `http://127.0.0.1:8000/*` و `http://localhost:8000/*` | سرور محلی پل — فقط لوکالهاست |

مجوز `tabs` لازم نیست (فایرفاکس آن را فقط بهصورت *optional* اعلام میکند تا وقتی کاربر
اجازه داد بتواند URL تبها را ببیند). بدون `webRequest`، بدون `cookies`، بدون
`<all_urls>`، بدون میزبان راه دور، بدون تحلیل آماری و بدون `eval`.

</div>
