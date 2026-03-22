import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject } from '@nestjs/common';
import { Cache } from 'cache-manager';
import axios from 'axios';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AiRecommendDto,
  AiQuoteEstimateDto,
  AiFaqDto,
  AiCategorizeDto,
} from './dto/ai-recommend.dto';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001'; // fast + affordable for real-time UX
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Service categories known to the platform (Arabic)
const SERVICE_CATEGORIES = [
  'سباكة',
  'كهرباء',
  'تكييف وتبريد',
  'نجارة',
  'دهانات',
  'تنظيف',
  'نقل عفش',
  'حراسة',
  'صيانة عامة',
  'تصميم داخلي',
  'بستنة وزراعة',
  'طاقة شمسية',
  'أجهزة منزلية',
  'أعمال حديد',
  'عزل مائي وحراري',
  'رصف وبلاط',
  'صيانة مسابح',
  'أنظمة إنذار وكاميرات',
  'ديكور',
  'زجاج وألمنيوم',
  'تمديدات شبكات',
  'أعمال جبس',
  'صيانة مطابخ',
  'أخرى',
];

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly apiKey: string | undefined;

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    @Inject(CACHE_MANAGER) private cache: Cache,
  ) {
    this.apiKey = this.config.get<string>('ANTHROPIC_API_KEY');
    if (!this.apiKey) {
      this.logger.warn('ANTHROPIC_API_KEY not set — AI endpoints will return rule-based fallbacks');
    }
  }

  // ── 1. Service recommendation ─────────────────────────────────────────────
  async recommendServices(dto: AiRecommendDto) {
    const cacheKey = `ai:recommend:${dto.query}:${dto.city ?? ''}`;
    const cached = await this.cache.get<any>(cacheKey);
    if (cached) return cached;

    // Fetch all active service categories + sample providers for context
    const [services, providers] = await Promise.all([
      this.prisma.service.findMany({
        where: { active: true },
        include: { category: { select: { nameAr: true } } },
        take: 50,
      }),
      this.prisma.providerProfile.findMany({
        where: {
          verificationStatus: 'APPROVED',
          user: {
            suspended: false,
            ...(dto.city ? { profile: { city: dto.city } } : {}),
          },
        },
        include: {
          user: { include: { profile: true } },
          services: { include: { service: { include: { category: true } } } },
        } as any,
        orderBy: [{ ratingAvg: 'desc' }, { completedJobs: 'desc' }],
        take: 20,
      }),
    ]);

    const serviceList = services
      .map((s) => `- ${s.nameAr} (${s.category.nameAr}) [id: ${s.id}]`)
      .join('\n');

    const providerList = providers
      .slice(0, 10)
      .map((p: any) => {
        const name = p.user.profile?.nameAr ?? p.user.username;
        const cats = p.services.map((ps: any) => ps.service.category.nameAr).join(', ');
        return `- ${name} | تقييم: ${p.ratingAvg} | تخصص: ${cats} [providerId: ${p.userId}]`;
      })
      .join('\n');

    const systemPrompt = `أنت مساعد ذكي لمنصة "خدمة" السعودية للخدمات المنزلية.
مهمتك: تحليل طلب المستخدم وتوصية بالخدمات ومزودي الخدمة الأنسب.
أجب دائماً بتنسيق JSON صحيح فقط بدون أي نص إضافي.`;

    const userPrompt = `طلب المستخدم: "${dto.query}"
${dto.city ? `المدينة: ${dto.city}` : ''}

قائمة الخدمات المتاحة:
${serviceList}

مزودو الخدمة المتاحون:
${providerList}

أرجع JSON بهذا الشكل:
{
  "detectedCategory": "اسم الفئة",
  "confidence": 0.95,
  "recommendedServices": [{"id": "service-id", "nameAr": "...", "reason": "..."}],
  "recommendedProviders": [{"providerId": "...", "name": "...", "reason": "..."}],
  "suggestedQuery": "عبارة بحث محسّنة",
  "tips": ["نصيحة 1", "نصيحة 2"]
}`;

    const result = await this._callClaude(systemPrompt, userPrompt, {
      fallback: {
        detectedCategory: this._ruleBasedCategory(dto.query),
        confidence: 0.6,
        recommendedServices: services.slice(0, 3).map((s) => ({
          id: s.id,
          nameAr: s.nameAr,
          reason: 'خدمة شائعة',
        })),
        recommendedProviders: [],
        suggestedQuery: dto.query,
        tips: ['قارن بين عروض متعددة قبل الاختيار'],
      },
    });

    await this.cache.set(cacheKey, result, CACHE_TTL);
    return result;
  }

  // ── 2. Quote / price estimation ───────────────────────────────────────────
  async estimateQuote(dto: AiQuoteEstimateDto) {
    // Pull last 50 completed escrows for this category to ground the estimate
    const historicalData = await this.prisma.escrow.findMany({
      where: {
        status: 'RELEASED',
        request: {
          service: {
            OR: [
              { nameAr: { contains: dto.serviceCategory, mode: 'insensitive' } },
              { category: { nameAr: { contains: dto.serviceCategory, mode: 'insensitive' } } },
            ],
          },
        },
      },
      select: { amount: true },
      orderBy: { releasedAt: 'desc' },
      take: 50,
    });

    const amounts = historicalData.map((e) => Number(e.amount));
    const hasHistory = amounts.length > 0;
    const avg = hasHistory ? amounts.reduce((a, b) => a + b, 0) / amounts.length : null;
    const min = hasHistory ? Math.min(...amounts) : null;
    const max = hasHistory ? Math.max(...amounts) : null;

    const systemPrompt = `أنت خبير تسعير خدمات منزلية في السوق السعودية.
أجب دائماً بتنسيق JSON صحيح فقط.`;

    const userPrompt = `نوع الخدمة: ${dto.serviceCategory}
الوصف: ${dto.description}
${dto.urgency ? `الأولوية: ${dto.urgency === 'urgent' ? 'عاجل' : 'عادي'}` : ''}
${dto.city ? `المدينة: ${dto.city}` : 'السوق السعودي'}

${
  hasHistory
    ? `بيانات تاريخية من المنصة (${amounts.length} طلب مكتمل):
- المتوسط: ${avg?.toFixed(0)} ريال
- المدى: ${min?.toFixed(0)} – ${max?.toFixed(0)} ريال`
    : 'لا توجد بيانات تاريخية كافية على المنصة.'
}

أرجع JSON:
{
  "estimatedMin": 0,
  "estimatedMax": 0,
  "estimatedAvg": 0,
  "currency": "SAR",
  "confidence": "high|medium|low",
  "factors": ["عامل يرفع السعر", "عامل يخفض السعر"],
  "tips": ["نصيحة للعميل عند الاتفاق على السعر"],
  "basedOnSamples": ${amounts.length}
}`;

    return this._callClaude(systemPrompt, userPrompt, {
      fallback: {
        estimatedMin: 150,
        estimatedMax: 500,
        estimatedAvg: 300,
        currency: 'SAR',
        confidence: 'low',
        factors: ['يعتمد على حجم العمل ومستوى الخبرة المطلوبة'],
        tips: ['احصل على عروض من 3 مزودين على الأقل'],
        basedOnSamples: amounts.length,
      },
    });
  }

  // ── 3. FAQ / support bot ──────────────────────────────────────────────────
  async answerFaq(dto: AiFaqDto) {
    const cacheKey = `ai:faq:${Buffer.from(dto.question).toString('base64').slice(0, 40)}`;
    const cached = await this.cache.get<any>(cacheKey);
    if (cached) return cached;

    const systemPrompt = `أنت وكيل دعم ذكي لمنصة "خدمة" السعودية للخدمات المنزلية.
معلومات المنصة:
- نظام الضمان (Escrow): المبلغ يُحجز حتى يؤكد العميل اكتمال الخدمة
- رسوم المنصة: 15% من قيمة الخدمة عند التحرير
- الخدمات: سباكة، كهرباء، تكييف، نجارة، دهانات، تنظيف، وغيرها
- المدة: تحرير تلقائي بعد 48 ساعة من الإكمال إن لم يُفتح نزاع
- التقييم: يمكن التقييم بعد اكتمال الخدمة فقط
- النزاعات: يمكن فتح نزاع خلال 48 ساعة من إكمال الخدمة
أجب بالعربية بوضوح وإيجاز. أجب دائماً بتنسيق JSON.`;

    const userPrompt = `السؤال: "${dto.question}"

أرجع JSON:
{
  "answer": "الإجابة هنا",
  "category": "دفع|خدمات|حساب|نزاعات|عام",
  "relatedLinks": [{"label": "...", "path": "/..."}],
  "needsHumanSupport": false
}`;

    const result = await this._callClaude(systemPrompt, userPrompt, {
      fallback: {
        answer: 'شكراً لتواصلك. سيتمكن فريق الدعم من مساعدتك قريباً.',
        category: 'عام',
        relatedLinks: [],
        needsHumanSupport: true,
      },
    });

    await this.cache.set(cacheKey, result, CACHE_TTL);
    return result;
  }

  // ── 4. Request categorization ─────────────────────────────────────────────
  async categorizeRequest(dto: AiCategorizeDto) {
    const cacheKey = `ai:categorize:${Buffer.from(dto.description).toString('base64').slice(0, 40)}`;
    const cached = await this.cache.get<any>(cacheKey);
    if (cached) return cached;

    const systemPrompt = `أنت نظام تصنيف تلقائي لطلبات الخدمات المنزلية السعودية.
أجب دائماً بتنسيق JSON فقط.`;

    const userPrompt = `الفئات المتاحة: ${SERVICE_CATEGORIES.join(' | ')}

الطلب: "${dto.description}"

أرجع JSON:
{
  "primaryCategory": "الفئة الرئيسية",
  "secondaryCategory": "فئة ثانوية أو null",
  "confidence": 0.9,
  "keywords": ["كلمة1", "كلمة2"],
  "urgencyDetected": false,
  "suggestedTitle": "عنوان مقترح للطلب"
}`;

    const result = await this._callClaude(systemPrompt, userPrompt, {
      fallback: {
        primaryCategory: this._ruleBasedCategory(dto.description),
        secondaryCategory: null,
        confidence: 0.5,
        keywords: [],
        urgencyDetected: dto.description.includes('عاجل') || dto.description.includes('طارئ'),
        suggestedTitle: dto.description.slice(0, 60),
      },
    });

    await this.cache.set(cacheKey, result, CACHE_TTL);
    return result;
  }

  // ── Private: call Anthropic API ───────────────────────────────────────────
  private async _callClaude(
    systemPrompt: string,
    userPrompt: string,
    options: { fallback: any },
  ): Promise<any> {
    if (!this.apiKey) return options.fallback;

    try {
      const response = await axios.post(
        ANTHROPIC_API_URL,
        {
          model: MODEL,
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        },
        {
          headers: {
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          timeout: 10_000,
        },
      );

      const text = response.data?.content?.[0]?.text ?? '';
      // Strip possible markdown code fences before parsing
      const clean = text
        .replace(/^```(?:json)?\n?/m, '')
        .replace(/\n?```$/m, '')
        .trim();
      return JSON.parse(clean);
    } catch (err: any) {
      this.logger.warn(`AI call failed: ${err.message ?? err} — returning fallback`);
      return options.fallback;
    }
  }

  // ── Rule-based category fallback ─────────────────────────────────────────
  private _ruleBasedCategory(text: string): string {
    const lower = text.toLowerCase();
    if (lower.includes('سبا') || lower.includes('تسريب') || lower.includes('حنفية')) return 'سباكة';
    if (lower.includes('كهرب') || lower.includes('كابل') || lower.includes('لمبة')) return 'كهرباء';
    if (lower.includes('تكييف') || lower.includes('مبرد') || lower.includes('مكيف'))
      return 'تكييف وتبريد';
    if (lower.includes('نجار') || lower.includes('خشب') || lower.includes('باب')) return 'نجارة';
    if (lower.includes('دهان') || lower.includes('طلاء') || lower.includes('جدار')) return 'دهانات';
    if (lower.includes('تنظيف') || lower.includes('نظافة') || lower.includes('غسيل'))
      return 'تنظيف';
    if (lower.includes('نقل') || lower.includes('عفش') || lower.includes('أثاث')) return 'نقل عفش';
    return 'صيانة عامة';
  }
}
