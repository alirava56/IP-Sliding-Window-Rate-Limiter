# راهنمای نصب، اجرا و انتشار در ویندوز

پوشهٔ پروژه را در Visual Studio Code باز کنید و از **Terminal → New Terminal** یک ترمینال PowerShell بگیرید. Git و آخرین نسخهٔ اصلاح‌شدهٔ Node.js 22 یا 24 را نصب کنید. حداقل نسخه در شاخهٔ ۲۲، نسخهٔ 22.23.5 و در شاخهٔ ۲۴، نسخهٔ 24.22.3 است. در PowerShell از `npm.cmd` استفاده کنید تا دستور درگیر سیاست اجرای فایل‌های `ps1` نشود.

```powershell
node --version
npm.cmd ci
npm.cmd run dev
```

در ترمینال دوم وضعیت سرویس و مسیر نمونه را بررسی کنید. سهمیهٔ پیش‌فرض ۱۰ درخواست API در هر ۶۰ ثانیه برای هر IP است. پاسخ درخواست مسدودشده کد `429` و هدر `Retry-After` دارد.

```powershell
curl.exe -i http://localhost:3000/health
curl.exe -i http://localhost:3000/api/demo
```

برای تغییر سهمیه، اجرای سرور را با Ctrl+C متوقف کنید و در همان ترمینال مقدار را تنظیم کنید. فایل `.env.example` مرجع تنظیمات محیطی است. برای استقرار پشت پراکسی، فقط نشانی‌های مبدأ پراکسی‌های مورداعتماد را در `TRUSTED_PROXY_CIDRS` قرار دهید. [تنظیمات و شرایط شبکه](README.md#استقرار-پشت-پراکسی)

```powershell
$env:RATE_LIMIT_MAX_REQUESTS = '3'
npm.cmd run dev
```

## آزمون و اجرای نسخهٔ کامپایل‌شده

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
npm.cmd test
npm.cmd run test:core
npm.cmd run test:coverage
npm.cmd run smoke
npm.cmd run build
npm.cmd start
```

آزمون `smoke` سرور موقت خودش را روی یک پورت آزاد راه می‌اندازد. برای اجرای `npm.cmd start` روی پورت پیش‌فرض، ابتدا سرور توسعه را متوقف کنید.

## انتشار در GitHub

در GitHub مخزنی خالی با نام `ip-sliding-window-limiter` بسازید و گزینه‌های ایجاد README، مجوز و `.gitignore` را غیرفعال بگذارید. اگر نسخهٔ محلی هنوز مخزن Git ندارد، دستورهای زیر را اجرا کنید. `git status` باید فقط فایل‌های مورد انتظار از جمله `package-lock.json` را نشان دهد. فایل‌های تنظیمات واقعی، اطلاعات محرمانه و وابستگی‌های نصب‌شده را در کامیت قرار ندهید.

```powershell
git init -b main
git add --all
git status --short
git diff --cached --check
git commit -m "Prepare IP sliding-window limiter for publication"
```

اگر کامیت محلی از قبل وجود دارد، از مرحلهٔ زیر ادامه دهید. `YOUR_USERNAME` را با نام کاربری خود جایگزین کنید. پس از انتشار، نتیجهٔ اولین اجرای workflow را در برگهٔ **Actions** بررسی کنید.

```powershell
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/ip-sliding-window-limiter.git
git push -u origin main
```
