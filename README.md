# توصیف عملکرد پایه‌های اول تا ششم | Grade Descriptions Worker

یک Cloudflare Worker برای مدیریت و نمایش توصیف عملکرد دانش‌آموزان پایه‌های اول تا ششم ابتدایی.

## ✨ امکانات

- 📊 مدیریت توصیف عملکرد ۶ پایه تحصیلی
- 👨‍🏫 پنل مخصوص معلمان
- 💾 ذخیره‌سازی داده‌ها با KV Storage
- 🔗 اشتراک‌گذاری با لینک یکتا (UUID)
- 📥 دانلود فایل Word
- 📋 کپی متن توصیف‌ها
- 🎨 طراحی ریسپانسیو و فارسی (راست‌به‌چپ)

## 🔧 نصب و راه‌اندازی

### پیش‌نیازها
- حساب Cloudflare
- Wrangler CLI

### مراحل

1. **کلون کردن پروژه:**
```bash
git clone https://github.com/naderuser/tosifamoozeshi.git
cd tosifamoozeshi
```

2. **ورود به حساب Cloudflare:**
```bash
npx wrangler login
```

3. **ساخت KV Namespace:**
```bash
npx wrangler kv:namespace create DESCRIPTIONS
```

4. **آپدیت `wrangler.toml`:**
```toml
name = "tosifamoozeshi"
main = "index.js"
compatibility_date = "2024-01-01"

[[kv_namespaces]]
binding = "DESCRIPTIONS"
id = "YOUR_KV_NAMESPACE_ID"
```

5. **دیپلوی:**
```bash
npx wrangler deploy
```

## 📡 API Endpoints

### ذخیره داده‌ها
```
POST /api/save
Content-Type: application/json

{
  "uuid": "unique-id",
  "grades": [...]
}
```

### بارگذاری داده‌ها
```
GET /api/load?uuid=unique-id
```

## 🔐 امنیت

- رمز عبور پیش‌فرض معلم:nader0933
- UUID برای اشتراک‌گذاری امن

## 📝 لایسنس

MIT License

---

ساخته شده با ❤️ برای معلمان عزیز
