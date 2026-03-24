import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { CommissionStatus } from '@prisma/client';
import * as nodemailer from 'nodemailer';

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  // ── Weekly report cron (every Monday 07:00 Riyadh = 04:00 UTC) ────────────
  @Cron('0 4 * * MON', { timeZone: 'Asia/Riyadh' })
  async sendWeeklyReport() {
    this.logger.log('Generating weekly platform report…');
    try {
      const report = await this.buildWeeklyReport();
      await this.emailReport(report);
      this.logger.log('Weekly report sent successfully');
    } catch (err) {
      this.logger.error(`Weekly report failed: ${err}`);
    }
  }

  // ── Build report data ──────────────────────────────────────────────────────
  async buildWeeklyReport() {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [
      newUsers,
      newProviders,
      requestsCreated,
      requestsCompleted,
      revenue,
      tenderCommissions,
      openDisputes,
      topServices,
    ] = await Promise.all([
      this.prisma.user.count({
        where: { createdAt: { gte: weekAgo }, role: 'CUSTOMER', deletedAt: null },
      }),
      this.prisma.user.count({
        where: { createdAt: { gte: weekAgo }, role: 'PROVIDER', deletedAt: null },
      }),
      this.prisma.serviceRequest.count({ where: { createdAt: { gte: weekAgo } } }),
      this.prisma.serviceRequest.count({
        where: { completedAt: { gte: weekAgo }, status: 'COMPLETED' },
      }),
      this.prisma.escrow.aggregate({
        where: { releasedAt: { gte: weekAgo }, status: 'RELEASED' },
        _sum: { platformFee: true, amount: true },
      }),
      this.prisma.tenderCommission.aggregate({
        where: { paidAt: { gte: weekAgo }, status: { in: [CommissionStatus.PAID] } },
        _sum: { commissionAmount: true },
      }),
      this.prisma.dispute.count({ where: { status: 'OPEN' } }),
      this.prisma.serviceRequest.groupBy({
        by: ['serviceId'],
        where: { createdAt: { gte: weekAgo } },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 5,
      }),
    ]);

    const homeRevenue = Number(revenue._sum.platformFee || 0);
    const tenderRevenue = Number(tenderCommissions._sum.commissionAmount || 0);
    const totalRevenue = homeRevenue + tenderRevenue;
    const gmv = Number(revenue._sum.amount || 0);

    return {
      period: { from: weekAgo.toISOString(), to: now.toISOString() },
      users: { newCustomers: newUsers, newProviders },
      requests: { created: requestsCreated, completed: requestsCompleted },
      revenue: { homeServices: homeRevenue, tenders: tenderRevenue, total: totalRevenue, gmv },
      openDisputes,
      topServices,
      generatedAt: now.toISOString(),
    };
  }

  // ── Email report ───────────────────────────────────────────────────────────
  private async emailReport(data: Awaited<ReturnType<typeof this.buildWeeklyReport>>) {
    const smtpHost = this.config.get('SMTP_HOST');
    if (!smtpHost) {
      this.logger.warn('SMTP_HOST not configured — skipping report email');
      return;
    }

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: this.config.get<number>('SMTP_PORT', 587),
      secure: this.config.get('SMTP_SECURE', 'false') === 'true',
      auth: {
        user: this.config.get('SMTP_USER'),
        pass: this.config.get('SMTP_PASS'),
      },
    });

    const html = this._buildEmailHtml(data);

    await transporter.sendMail({
      from: `Khedmah Platform <${this.config.get('SMTP_FROM', 'noreply@khedmah.sa')}>`,
      to: this.config.get('ADMIN_EMAIL', 'admin@khedmah.sa'),
      subject: `📊 تقرير خدمة الأسبوعي — ${new Date().toLocaleDateString('ar-SA')}`,
      html,
    });
  }

  private _buildEmailHtml(d: any): string {
    return `
<!DOCTYPE html><html dir="rtl" lang="ar">
<head><meta charset="UTF-8">
<style>
  body { font-family: 'Segoe UI', Arial, sans-serif; background: #f8f9fa; color: #333; }
  .card { background: #fff; border-radius: 12px; padding: 24px; margin: 16px; box-shadow: 0 2px 8px rgba(0,0,0,.08); }
  h1 { color: #1abc9c; } h2 { color: #2c3e50; border-bottom: 2px solid #1abc9c; padding-bottom: 8px; }
  .metric { display: inline-block; padding: 12px 20px; background: #f0fdf9; border-radius: 8px; margin: 8px; text-align: center; }
  .metric strong { display: block; font-size: 28px; color: #1abc9c; }
  .metric span { font-size: 13px; color: #666; }
  .revenue { color: #2ecc71 !important; }
  .alert { background: #fef9c3; border-left: 4px solid #f59e0b; padding: 12px; border-radius: 4px; }
</style></head>
<body>
<div class="card">
  <h1>📊 تقرير خدمة الأسبوعي</h1>
  <p>الفترة: ${new Date(d.period.from).toLocaleDateString('ar-SA')} — ${new Date(d.period.to).toLocaleDateString('ar-SA')}</p>
</div>

<div class="card">
  <h2>👥 المستخدمون الجدد</h2>
  <div class="metric"><strong>${d.users.newCustomers}</strong><span>عميل جديد</span></div>
  <div class="metric"><strong>${d.users.newProviders}</strong><span>مزود خدمة جديد</span></div>
</div>

<div class="card">
  <h2>📋 الطلبات</h2>
  <div class="metric"><strong>${d.requests.created}</strong><span>طلب جديد</span></div>
  <div class="metric"><strong>${d.requests.completed}</strong><span>طلب مكتمل</span></div>
</div>

<div class="card">
  <h2>💰 الإيرادات</h2>
  <div class="metric"><strong class="revenue">${d.revenue.total.toLocaleString()} ريال</strong><span>إجمالي الإيرادات</span></div>
  <div class="metric"><strong>${d.revenue.gmv.toLocaleString()} ريال</strong><span>GMV</span></div>
  <div class="metric"><strong>${d.revenue.homeServices.toLocaleString()} ريال</strong><span>الخدمات المنزلية</span></div>
  <div class="metric"><strong>${d.revenue.tenders.toLocaleString()} ريال</strong><span>عمولات المناقصات</span></div>
</div>

${
  d.openDisputes > 0
    ? `
<div class="card">
  <div class="alert">⚠️ يوجد <strong>${d.openDisputes}</strong> نزاع مفتوح يحتاج متابعة</div>
</div>`
    : ''
}

<div class="card" style="text-align:center;color:#999;font-size:12px">
  تم الإنشاء تلقائيًا بواسطة منصة خدمة — ${d.generatedAt}
</div>
</body></html>`;
  }

  // ── On-demand weekly report (for admin API) ──────────────────────────────
  async getWeeklyReportData() {
    return this.buildWeeklyReport();
  }

  // ── Live platform overview — current totals + last 24h activity ───────────
  async getOverviewData() {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [
      totalCustomers,
      totalProviders,
      activeProviders,
      requestsToday,
      completedToday,
      revenueWeek,
      openDisputes,
      pendingVerifications,
    ] = await Promise.all([
      this.prisma.user.count({ where: { role: 'CUSTOMER', deletedAt: null } }),
      this.prisma.user.count({ where: { role: 'PROVIDER', deletedAt: null } }),
      this.prisma.providerProfile.count({ where: { verificationStatus: 'APPROVED' } }),
      this.prisma.serviceRequest.count({ where: { createdAt: { gte: dayAgo } } }),
      this.prisma.serviceRequest.count({
        where: { completedAt: { gte: dayAgo }, status: 'COMPLETED' },
      }),
      this.prisma.escrow.aggregate({
        where: { releasedAt: { gte: weekAgo }, status: 'RELEASED' },
        _sum: { platformFee: true },
      }),
      this.prisma.dispute.count({ where: { status: 'OPEN' } }),
      this.prisma.providerProfile.count({
        where: { verificationStatus: { in: ['PENDING_REVIEW', 'UNDER_REVIEW'] } },
      }),
    ]);

    return {
      snapshot: {
        totalCustomers,
        totalProviders,
        activeProviders,
      },
      last24h: {
        requestsCreated: requestsToday,
        requestsCompleted: completedToday,
      },
      last7d: {
        platformRevenue: Number(revenueWeek._sum.platformFee || 0),
      },
      alerts: {
        openDisputes,
        pendingVerifications,
      },
      generatedAt: now.toISOString(),
    };
  }
}
