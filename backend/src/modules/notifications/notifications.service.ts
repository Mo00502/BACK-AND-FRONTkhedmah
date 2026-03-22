import { Injectable, Logger, ForbiddenException, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { OnEvent } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import axios from 'axios';
import * as nodemailer from 'nodemailer';

/**
 * Firebase Admin is initialized lazily — imported only when FIREBASE_SERVICE_ACCOUNT
 * is present in env, so the service still boots in dev without Firebase credentials.
 */
let _firebaseApp: any = null;
let _firebaseMessaging: any = null;

async function getFirebaseMessaging(serviceAccountJson: string) {
  if (_firebaseMessaging) return _firebaseMessaging;
  const admin = await import('firebase-admin');
  _firebaseApp = admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(serviceAccountJson)),
  });
  _firebaseMessaging = admin.messaging(_firebaseApp);
  return _firebaseMessaging;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    @InjectQueue('notifications') private notifQueue: Queue,
  ) {}

  // ── In-app notification ─────────────────────────────────────────────────
  async createInApp(userId: string, titleAr: string, bodyAr: string, data?: any) {
    return this.prisma.notification.create({
      data: { userId, channel: 'IN_APP', titleAr, bodyAr, data },
    });
  }

  async getMyNotifications(userId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [notifications, total, unread] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.notification.count({ where: { userId } }),
      this.prisma.notification.count({ where: { userId, read: false } }),
    ]);
    return { notifications, total, unread };
  }

  async markRead(userId: string, notificationId?: string) {
    if (notificationId) {
      const notif = await this.prisma.notification.findUnique({ where: { id: notificationId } });
      if (!notif) throw new NotFoundException('Notification not found');
      if (notif.userId !== userId)
        throw new ForbiddenException("Cannot mark another user's notification");
      await this.prisma.notification.update({
        where: { id: notificationId },
        data: { read: true },
      });
    } else {
      await this.prisma.notification.updateMany({
        where: { userId, read: false },
        data: { read: true },
      });
    }
    return { message: 'Marked as read' };
  }

  // ── FCM push notification ────────────────────────────────────────────────
  async sendPush(userId: string, title: string, body: string, data?: Record<string, string>) {
    const serviceAccount = this.config.get<string>('FIREBASE_SERVICE_ACCOUNT');
    if (!serviceAccount) {
      this.logger.warn('FIREBASE_SERVICE_ACCOUNT not set — push skipped');
      return;
    }

    // Fetch all device tokens for this user
    const tokens = await this.prisma.deviceToken.findMany({
      where: { userId, active: true },
      select: { token: true },
    });
    if (!tokens.length) return;

    try {
      const messaging = await getFirebaseMessaging(serviceAccount);
      const result = await messaging.sendEachForMulticast({
        tokens: tokens.map((t) => t.token),
        notification: { title, body },
        data: data || {},
        android: { priority: 'high' },
        apns: { payload: { aps: { sound: 'default', badge: 1 } } },
      });

      // Deactivate tokens that are no longer valid
      const invalid = result.responses
        .map((r: any, i: number) => (!r.success ? tokens[i].token : null))
        .filter(Boolean);
      if (invalid.length) {
        await this.prisma.deviceToken.updateMany({
          where: { token: { in: invalid } },
          data: { active: false },
        });
      }
    } catch (err) {
      this.logger.error(`FCM push failed for user ${userId}: ${err}`);
    }
  }

  async registerDeviceToken(userId: string, token: string, platform: 'IOS' | 'ANDROID' | 'WEB') {
    return this.prisma.deviceToken.upsert({
      where: { token },
      update: { userId, active: true, platform },
      create: { userId, token, platform, active: true },
    });
  }

  async unregisterDeviceToken(userId: string, token: string) {
    const device = await this.prisma.deviceToken.findUnique({ where: { token } });
    if (!device || device.userId !== userId) return; // silently ignore — token may already be gone
    return this.prisma.deviceToken.update({ where: { token }, data: { active: false } });
  }

  // ── Email via SMTP ────────────────────────────────────────────────────────
  async sendEmail(to: string, subject: string, html: string) {
    const host = this.config.get<string>('SMTP_HOST');
    if (!host) {
      this.logger.warn(`SMTP_HOST not set — email to ${to} skipped. Subject: ${subject}`);
      return;
    }
    try {
      const transporter = nodemailer.createTransport({
        host,
        port: this.config.get<number>('SMTP_PORT', 587),
        secure: this.config.get<boolean>('SMTP_SECURE', false),
        auth: {
          user: this.config.get<string>('SMTP_USER'),
          pass: this.config.get<string>('SMTP_PASS'),
        },
      });
      await transporter.sendMail({
        from: this.config.get<string>('SMTP_FROM', 'noreply@khedmah.sa'),
        to,
        subject,
        html,
      });
      this.logger.log(`Email sent to ${to}: ${subject}`);
    } catch (err) {
      this.logger.error(`Email failed to ${to}: ${err}`);
    }
  }

  // ── SMS via Unifonic ─────────────────────────────────────────────────────
  async sendSms(phone: string, message: string) {
    try {
      await axios.post('https://api.unifonic.com/rest/SMS/messages', {
        AppSid: this.config.getOrThrow('UNIFONIC_APP_SID'),
        SenderID: this.config.get('UNIFONIC_SENDER_ID', 'Khedmah'),
        Recipient: phone,
        Body: message,
      });
    } catch (err) {
      this.logger.error(`SMS failed to ${phone}: ${err}`);
    }
  }

  // ── Notify + push helper ─────────────────────────────────────────────────
  // In-app is written synchronously (instant). Push goes through BullMQ so
  // failures are retried automatically (up to 3 times, exponential back-off).
  async notifyUser(
    userId: string,
    titleAr: string,
    bodyAr: string,
    extra?: Record<string, string>,
  ) {
    await this.createInApp(userId, titleAr, bodyAr, extra);
    await this.notifQueue.add(
      'push',
      { userId, title: titleAr, body: bodyAr, data: extra ?? {} },
      { attempts: 3, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: true },
    );
  }

  // ── Event listeners ──────────────────────────────────────────────────────

  // Auth — email verification
  @OnEvent('auth.email_verification_requested')
  async handleEmailVerification(event: {
    userId: string;
    email: string;
    token: string;
    expiresAt: Date;
  }) {
    const baseUrl = this.config.get<string>('APP_BASE_URL', 'http://localhost:3000');
    const link = `${baseUrl}/api/v1/auth/verify-email?token=${encodeURIComponent(event.token)}`;
    await this.sendEmail(
      event.email,
      'تفعيل حسابك على منصة خدمة',
      `
        <div dir="rtl" style="font-family:Tajawal,Arial,sans-serif;max-width:560px;margin:auto;">
          <h2 style="color:#028090;">مرحباً بك في منصة خدمة 🏠</h2>
          <p>انقر على الزر أدناه لتفعيل حسابك. الرابط صالح حتى <strong>${event.expiresAt.toLocaleString('ar-SA')}</strong>.</p>
          <div style="text-align:center;margin:2rem 0;">
            <a href="${link}" style="background:#028090;color:white;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:bold;font-size:16px;">
              تفعيل الحساب
            </a>
          </div>
          <p style="color:#64748B;font-size:13px;">إذا لم تنشئ حساباً، تجاهل هذه الرسالة.</p>
        </div>
      `,
    );
  }

  // Auth — email verified
  @OnEvent('auth.email_verified')
  async handleEmailVerified(event: { userId: string }) {
    // In-app notification
    await this.createInApp(
      event.userId,
      '✅ تم تفعيل حسابك',
      'بريدك الإلكتروني تم التحقق منه. يمكنك الآن تسجيل الدخول.',
    );
  }

  // Auth — password reset requested
  @OnEvent('auth.password_reset_requested')
  async handlePasswordResetRequested(event: {
    userId: string;
    email: string;
    token: string;
    expiresAt: Date;
    ip?: string;
  }) {
    const baseUrl = this.config.get<string>('APP_BASE_URL', 'http://localhost:3000');
    const link = `${baseUrl}/reset-password?token=${encodeURIComponent(event.token)}`;
    await this.sendEmail(
      event.email,
      'إعادة تعيين كلمة المرور — خدمة',
      `
        <div dir="rtl" style="font-family:Tajawal,Arial,sans-serif;max-width:560px;margin:auto;">
          <h2 style="color:#028090;">إعادة تعيين كلمة المرور 🔑</h2>
          <p>طلبنا إعادة تعيين كلمة المرور لحسابك. انقر على الزر أدناه لاختيار كلمة مرور جديدة.</p>
          <p>الرابط صالح حتى <strong>${event.expiresAt.toLocaleString('ar-SA')}</strong>.</p>
          <div style="text-align:center;margin:2rem 0;">
            <a href="${link}" style="background:#028090;color:white;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:bold;font-size:16px;">
              إعادة تعيين كلمة المرور
            </a>
          </div>
          <p style="color:#EF4444;font-size:13px;">⚠️ إذا لم تطلب إعادة التعيين، تجاهل هذه الرسالة. حسابك آمن.${event.ip ? ` (IP: ${event.ip})` : ''}</p>
        </div>
      `,
    );
  }

  // Auth — password successfully reset
  @OnEvent('auth.password_reset')
  async handlePasswordReset(event: { userId: string; ip?: string }) {
    await this.createInApp(
      event.userId,
      '🔒 تم تغيير كلمة المرور',
      'تم تغيير كلمة مرورك بنجاح. إذا لم تكن أنت، تواصل مع الدعم فوراً.',
    );
  }

  // Provider — docs submitted
  @OnEvent('provider.docs_submitted')
  async handleDocsSubmitted(event: { userId: string; profileId: string }) {
    await this.createInApp(
      event.userId,
      '📎 تم استلام وثائقك',
      'استلمنا وثائقك وسيراجعها فريقنا خلال 2-3 أيام عمل.',
    );
    // Notify admin email
    const adminEmail = this.config.get<string>('ADMIN_EMAIL');
    if (adminEmail) {
      await this.sendEmail(
        adminEmail,
        'مزود جديد — وثائق بانتظار المراجعة',
        `<p>مزود جديد قدّم وثائقه للمراجعة. معرف الملف الشخصي: <strong>${event.profileId}</strong></p>`,
      );
    }
  }

  // Provider — approved by admin
  @OnEvent('provider.approved')
  async handleProviderApproved(event: { userId: string; email: string }) {
    await Promise.all([
      this.createInApp(
        event.userId,
        '🎉 تهانينا! تم قبول حسابك',
        'تم الموافقة على حسابك كمزود خدمة. يمكنك الآن استقبال الطلبات.',
      ),
      this.sendEmail(
        event.email,
        'تمت الموافقة على حسابك — خدمة 🎉',
        `
          <div dir="rtl" style="font-family:Tajawal,Arial,sans-serif;max-width:560px;margin:auto;">
            <h2 style="color:#10B981;">🎉 تهانينا! تمت الموافقة على حسابك</h2>
            <p>فريق خدمة راجع وثائقك ووافق عليها. يمكنك الآن تسجيل الدخول وبدء استقبال طلبات الخدمة.</p>
          </div>
        `,
      ),
    ]);
  }

  // Provider — rejected by admin
  @OnEvent('provider.rejected')
  async handleProviderRejected(event: { userId: string; email: string; reason: string }) {
    await Promise.all([
      this.createInApp(event.userId, '❌ لم يتم قبول وثائقك', `سبب الرفض: ${event.reason}`),
      this.sendEmail(
        event.email,
        'تحديث بشأن طلبك — خدمة',
        `
          <div dir="rtl" style="font-family:Tajawal,Arial,sans-serif;max-width:560px;margin:auto;">
            <h2 style="color:#EF4444;">نأسف، لم نتمكن من قبول وثائقك</h2>
            <p><strong>السبب:</strong> ${event.reason}</p>
            <p>يمكنك تعديل وثائقك وإعادة تقديمها من خلال لوحة التحكم.</p>
          </div>
        `,
      ),
    ]);
  }

  @OnEvent('request.created')
  async handleRequestCreated(event: {
    requestId: string;
    customerId: string;
    serviceId: string;
    city?: string;
  }) {
    // Find approved, active providers who offer this service (optionally in the same city)
    const providerWhere: any = {
      verificationStatus: 'APPROVED',
      suspended: false,
      user: { status: 'ACTIVE', deletedAt: null },
      services: { some: { serviceId: event.serviceId } },
    };
    if (event.city) {
      providerWhere.user = { ...providerWhere.user, profile: { city: event.city } };
    }

    const providers = await this.prisma.providerProfile.findMany({
      where: providerWhere,
      select: { userId: true },
      take: 50, // cap broadcast to avoid fan-out storms
    });

    await Promise.all(
      providers.map((p) =>
        this.notifyUser(
          p.userId,
          'طلب خدمة جديد',
          'يوجد طلب خدمة جديد في منطقتك. تحقق منه وقدّم عرض سعر.',
          { requestId: event.requestId },
        ),
      ),
    );
  }

  @OnEvent('quote.submitted')
  async handleQuoteSubmitted(event: { requestId: string; customerId: string }) {
    await this.notifyUser(event.customerId, 'عرض سعر جديد', 'وصل عرض سعر جديد لطلبك', {
      requestId: event.requestId,
    });
  }

  @OnEvent('quote.accepted')
  async handleQuoteAccepted(event: { providerId: string; requestId: string }) {
    await this.notifyUser(event.providerId, 'تم قبول عرضك', 'قام العميل بقبول عرض السعر الخاص بك', {
      requestId: event.requestId,
    });
  }

  @OnEvent('request.completed')
  async handleRequestCompleted(event: {
    requestId: string;
    customerId: string;
    providerId: string;
  }) {
    await this.notifyUser(
      event.customerId,
      '🏁 اكتملت الخدمة',
      'أعلن المزود اكتمال الخدمة. يرجى تأكيد الاستلام لتحرير الدفعة.',
      { requestId: event.requestId },
    );
  }

  @OnEvent('escrow.released')
  async handleEscrowReleased(event: { providerId: string; requestId: string }) {
    if (event.providerId) {
      await this.notifyUser(
        event.providerId,
        'تم تحويل الدفعة',
        'تم تحويل مستحقاتك بنجاح للمحفظة',
        { requestId: event.requestId },
      );
    }
  }

  // NOTE: auto-release now emits 'escrow.released' (same as manual) — no separate handler needed.

  @OnEvent('tender.awarded')
  async handleTenderAwarded(event: { winnerId: string; tenderId: string }) {
    await this.notifyUser(
      event.winnerId,
      'مبروك! فزت بالمناقصة',
      'تم اختيار شركتك فائزة بالمناقصة',
      { tenderId: event.tenderId },
    );
  }

  @OnEvent('equipment.booked')
  async handleEquipmentBooked(event: { ownerId: string; equipmentId: string; rentalId: string }) {
    await this.notifyUser(event.ownerId, 'حجز معدة جديد', 'تم حجز معدتك من قِبل مستأجر جديد', {
      rentalId: event.rentalId,
    });
  }

  @OnEvent('wallet.credited')
  async handleWalletCredited(event: { userId: string; amount: number }) {
    await this.createInApp(
      event.userId,
      'تم إضافة رصيد',
      `تم إضافة ${event.amount} ريال إلى محفظتك`,
    );
  }

  @OnEvent('referral.rewarded')
  async handleReferral(event: { referrerId: string; amount: number }) {
    await this.notifyUser(
      event.referrerId,
      'مكافأة الإحالة',
      `حصلت على ${event.amount} ريال مكافأة إحالة!`,
    );
  }

  @OnEvent('review.submitted')
  async handleReviewSubmitted(event: {
    rateeId: string;
    score: number;
    requestId: string;
    isCustomerReview: boolean;
  }) {
    if (event.isCustomerReview) {
      await this.notifyUser(
        event.rateeId,
        '⭐ تقييم جديد',
        `حصلت على تقييم جديد (${event.score}/5) بعد إتمام الخدمة.`,
        { requestId: event.requestId },
      );
    }
  }

  @OnEvent('wallet.withdrawal_requested')
  async handleWithdrawalRequested(event: { userId: string; amount: number; withdrawalId: string }) {
    await this.createInApp(
      event.userId,
      '📤 تم استلام طلب السحب',
      `طلبك لسحب ${event.amount} ريال قيد المراجعة. سيتم المعالجة خلال 1-3 أيام عمل.`,
    );
  }

  @OnEvent('wallet.withdrawal_completed')
  async handleWithdrawalCompleted(event: { userId: string; amount: number }) {
    await this.notifyUser(
      event.userId,
      '✅ تم تحويل المبلغ',
      `تم تحويل ${event.amount} ريال إلى حسابك البنكي بنجاح.`,
    );
  }

  @OnEvent('wallet.withdrawal_rejected')
  async handleWithdrawalRejected(event: { userId: string; amount: number }) {
    await this.notifyUser(
      event.userId,
      '❌ رُفض طلب السحب',
      `تم رفض طلب سحب ${event.amount} ريال. تم إعادة المبلغ إلى رصيدك المتاح.`,
    );
  }

  // ── Payment failure ───────────────────────────────────────────────────────
  @OnEvent('payment.failed')
  async handlePaymentFailed(event: { customerId: string; requestId: string }) {
    await this.notifyUser(
      event.customerId,
      '❌ فشل الدفع',
      'لم تتم عملية الدفع. يرجى المحاولة مرة أخرى أو استخدام وسيلة دفع مختلفة.',
      { requestId: event.requestId },
    );
  }

  // ── Consultation events ───────────────────────────────────────────────────
  @OnEvent('consultation.created')
  async handleConsultationCreated(event: { customerId: string; consultationId: string }) {
    await this.createInApp(
      event.customerId,
      '✅ تم إرسال طلب الاستشارة',
      'طلبك قيد المراجعة. سيرد عليك المستشار قريبًا.',
    );
  }

  @OnEvent('consultation.accepted')
  async handleConsultationAccepted(event: { customerId: string; consultationId: string }) {
    await this.notifyUser(
      event.customerId,
      '📅 تم قبول طلب استشارتك',
      'وافق المستشار على طلبك. يمكنك الآن تنسيق موعد الجلسة.',
      { consultationId: event.consultationId },
    );
  }

  @OnEvent('consultation.started')
  async handleConsultationStarted(event: { customerId: string; consultationId: string }) {
    await this.notifyUser(
      event.customerId,
      '🎙 بدأت جلسة الاستشارة',
      'المستشار متاح الآن — الجلسة جارية.',
      { consultationId: event.consultationId },
    );
  }

  @OnEvent('consultation.completed')
  async handleConsultationCompleted(event: { customerId: string; consultationId: string }) {
    await this.notifyUser(
      event.customerId,
      '🏁 اكتملت جلسة الاستشارة',
      'يرجى تقييم تجربتك مع المستشار.',
      { consultationId: event.consultationId },
    );
  }

  @OnEvent('consultation.rated')
  async handleConsultationRated(event: { providerId: string; rating: number }) {
    if (event.providerId) {
      await this.notifyUser(
        event.providerId,
        '⭐ تقييم جديد على استشارتك',
        `حصلت على تقييم ${event.rating}/5 من العميل.`,
      );
    }
  }
}
