# مشروع Khedmah — ملخص شامل

## نظرة عامة

**Khedmah** — منصة سعودية لربط العملاء بمزودي الخدمات المنزلية، مع دعم المناقصات وتأجير المعدات.

---

## الصفحات المكتملة (27 صفحة HTML)

### المصادقة (5 صفحات)
| الملف | الوصف |
|-------|-------|
| `login.html` | تسجيل الدخول — يدعم الإيميل والاسم |
| `register-customer.html` | تسجيل عميل جديد |
| `register-provider.html` | تسجيل مزود خدمة جديد |
| `forgot-password.html` | طلب إعادة تعيين كلمة المرور |
| `reset-password.html` | تعيين كلمة مرور جديدة |

### واجهة العميل (8 صفحات)
| الملف | الوصف |
|-------|-------|
| `home.html` | الصفحة الرئيسية — Landing page |
| `search-services.html` | بحث وفلترة مزودي الخدمات |
| `provider-profile.html` | ملف مزود الخدمة العام |
| `quote-request.html` | معالج طلب عرض السعر (3 خطوات) |
| `payment-escrow.html` | الدفع الآمن عبر Moyasar + Escrow |
| `customer-dashboard.html` | لوحة تحكم العميل |
| `service-confirmation.html` | تأكيد اكتمال الخدمة وإطلاق الدفع |
| `customer-invoice.html` | فاتورة الخدمة (طباعة + PDF) |

### أدوات مشتركة (4 صفحات)
| الملف | الوصف |
|-------|-------|
| `chat.html` | محادثة مباشرة مع جهات الاتصال |
| `order-tracking.html` | تتبع الطلب في الوقت الفعلي |
| `rate-service.html` | تقييم الخدمة + صور + تاغات |
| `customer-notifications.html` | مركز الإشعارات (تبويبات + تحديد مقروء) |

### واجهة مزود الخدمة (6 صفحات)
| الملف | الوصف |
|-------|-------|
| `provider-dashboard.html` | لوحة تحكم مزود الخدمة |
| `provider-profile.html` | الملف الشخصي العام |
| `provider-rate-customer.html` | تقييم العميل (نظام مزدوج) |
| `provider-bank-settings.html` | إعدادات الحساب البنكي + المحفظة |
| `provider-manage-services.html` | إدارة الخدمات والأسعار |
| `provider-availability.html` | جدول التوفر الأسبوعي + الإجازات |

### البرامج والنمو (2 صفحة)
| الملف | الوصف |
|-------|-------|
| `referral-program.html` | برنامج الإحالة + مشاركة اجتماعية |
| `gantt-chart.html` | خطة المشروع (مخطط جانت) |

### لوحة الإدارة (2 صفحة)
| الملف | الوصف |
|-------|-------|
| `admin-login.html` | تسجيل دخول الإدارة |
| `admin-dashboard.html` | لوحة تحكم المشرف |

---

## الواجهة الخلفية (Backend)

**المسار:** `/Users/msalemaldossary/Downloads/khedmah-backend/`

### التقنيات
- **NestJS 10** + TypeScript + **Prisma 5** + **PostgreSQL 16**
- **BullMQ** (Redis) للطوابير — `@nestjs/bull`
- **Socket.IO** للوقت الفعلي (تتبع + محادثة)
- **Moyasar** لبوابة الدفع السعودية
- **Firebase Admin** للإشعارات الفورية (FCM)
- **AWS S3** (أو Cloudflare R2) لرفع الملفات
- **Unifonic** للرسائل النصية

### الوحدات (33 وحدة)
| الوحدة | الوصف |
|--------|-------|
| `auth` | تسجيل + توثيق JWT + إعادة التعيين |
| `users` | إدارة المستخدمين |
| `providers` | ملفات مزودي الخدمات + الوثائق |
| `requests` | طلبات الخدمة + عروض الأسعار |
| `payments` | Moyasar webhook + Escrow |
| `materials-payment` | ميزانية المواد + المطابقة |
| `wallet` | محفظة + سحب + إحالات |
| `invoices` | فواتير الخدمات + المناقصات + المعدات |
| `tenders` | المناقصات + العطاءات + العمولات |
| `equipment` | تأجير المعدات |
| `disputes` | نظام النزاعات |
| `reviews` | تقييم مزدوج (عميل ↔ مزود) |
| `notifications` | إشعارات داخل التطبيق + FCM + SMTP + SMS |
| `chat` | محادثات مباشرة + WebSocket |
| `tracking` | تتبع الطلبات في الوقت الفعلي + WebSocket |
| `schedule` | جدول التوفر الأسبوعي للمزود |
| `scheduler` | مهام مجدولة (cron): إطلاق Escrow، تنظيف الرموز |
| `search` | بحث موحد عبر جميع الكيانات + Autocomplete |
| `files` | رفع الملفات إلى S3 |
| `health` | فحص صحة النظام (DB + Redis + Memory + Disk) |
| `admin` | إدارة المنصة + حل النزاعات |
| `analytics` | إحصائيات وتقارير |
| `audit` | سجل المراجعة للعمليات الحساسة |
| `events` | مستمع الأحداث المركزي |

### قواعد العمل الرئيسية
- رسوم المنصة: 15% من إجمالي الضمان عند الإطلاق
- عمولة المناقصات: 2% من قيمة العطاء الفائز
- رسوم المعدات: 10% من قيمة الإيجار
- ضريبة القيمة المضافة: 15% على جميع الفواتير
- إطلاق تلقائي للضمان: 48 ساعة بعد الاكتمال
- رابط التحقق من الإيميل: صالح 24 ساعة
- رابط إعادة تعيين كلمة المرور: صالح 60 دقيقة
- JWT Access Token: 15 دقيقة، Refresh Token: 30 يوماً

### بيانات الاختبار
| المستخدم | الإيميل | كلمة المرور |
|----------|---------|------------|
| Admin | admin@khedmah.sa | Demo@12345 |
| عميل | customer@demo.sa | Demo@12345 |
| مزود 1 | khalid@demo.sa | Demo@12345 |
| مزود 2 | salem@demo.sa | Demo@12345 |
| مزود 3 | fahad@demo.sa | Demo@12345 |

---

## التقنيات — الواجهة الأمامية

- **Bootstrap 5 RTL** — تصميم متجاوب للعربية
- **Alpine.js v3** — تفاعل بدون بناء
- **Font Awesome 6** — أيقونات
- **Tajawal** — خط عربي من Google Fonts
- جميع المكتبات عبر CDN — لا build tools
- توثيق تجريبي: `localStorage.khedmah_demo` (عملاء/مزودون)، `sessionStorage.adminLoggedIn` (مشرفون)

---

## رحلة المستخدم الكاملة

```
home.html → search-services.html → provider-profile.html → quote-request.html
→ payment-escrow.html → customer-dashboard.html
→ order-tracking.html / chat.html
→ service-confirmation.html → rate-service.html / customer-invoice.html
```

---

**الحالة:** ✅ الواجهة الأمامية مكتملة (27 صفحة) | ✅ الواجهة الخلفية مكتملة
**آخر تحديث:** مارس 2026
