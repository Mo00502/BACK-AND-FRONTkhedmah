import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class TrackingService {
  constructor(private prisma: PrismaService) {}

  async getOrderTracking(userId: string, requestId: string) {
    const request = await this.prisma.serviceRequest.findUnique({
      where: { id: requestId },
      include: {
        service: { select: { nameAr: true, nameEn: true, icon: true } },
        customer: { include: { profile: true } },
        provider: {
          include: {
            profile: { select: { nameAr: true, nameEn: true, avatarUrl: true } },
            providerProfile: { select: { ratingAvg: true, completedJobs: true } },
          },
        },
      },
    });

    if (!request) throw new NotFoundException('Request not found');

    const isParty = request.customerId === userId || request.providerId === userId;
    if (!isParty) throw new ForbiddenException('Access denied');

    // Build tracking timeline steps
    const steps = this._buildTimeline(request.status);

    return {
      requestId: request.id,
      status: request.status,
      service: request.service,
      provider: request.provider
        ? {
            name: request.provider.profile?.nameAr ?? request.provider.profile?.nameEn ?? null,
            avatar: request.provider.profile?.avatarUrl,
            rating: request.provider.providerProfile?.ratingAvg,
            // phone is on the User model (optional contact number for providers)
            phone: request.provider.phone,
          }
        : null,
      scheduledAt: request.scheduledAt,
      steps,
      canCancel: request.status === 'PENDING',
      trackingRoom: `request:${request.id}`,
    };
  }

  async getActiveOrders(userId: string, role: 'CUSTOMER' | 'PROVIDER') {
    const where: any = { status: { in: ['ACCEPTED', 'IN_PROGRESS'] } };
    if (role === 'CUSTOMER') where.customerId = userId;
    else where.providerId = userId;

    return this.prisma.serviceRequest.findMany({
      where,
      include: {
        service: { select: { nameAr: true, icon: true } },
        customer: { include: { profile: true } },
        provider: { include: { profile: true } },
      },
      orderBy: { scheduledAt: 'asc' },
    });
  }

  private _buildTimeline(status: string) {
    const allSteps = [
      { key: 'ACCEPTED', labelAr: 'تم قبول الطلب', icon: 'check-circle' },
      { key: 'EN_ROUTE', labelAr: 'المزود في الطريق', icon: 'map-pin' },
      { key: 'IN_PROGRESS', labelAr: 'بدأ العمل', icon: 'tool' },
      { key: 'COMPLETED', labelAr: 'اكتملت الخدمة', icon: 'star' },
    ];

    const order = ['ACCEPTED', 'EN_ROUTE', 'IN_PROGRESS', 'COMPLETED'];
    const currentIdx = order.indexOf(status);

    return allSteps.map((step, i) => ({
      ...step,
      done: i < currentIdx,
      active: i === currentIdx,
      pending: i > currentIdx,
    }));
  }
}
