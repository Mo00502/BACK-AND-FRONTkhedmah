import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

const VAT_RATE = 0.15; // Saudi Arabia 15% VAT

@Injectable()
export class InvoicesService {
  constructor(private prisma: PrismaService) {}

  // ── Home-service invoice (from escrow release) ──────────────────────────
  async getServiceInvoice(userId: string, requestId: string) {
    const request = await this.prisma.serviceRequest.findUnique({
      where: { id: requestId },
      include: {
        customer: { include: { profile: true } },
        provider: { include: { profile: true, providerProfile: true } },
        service: true,
        quotes: { where: { status: 'ACCEPTED' } },
        escrow: true,
        payments: { where: { status: 'PAID' }, take: 1 },
      },
    });
    if (!request) throw new NotFoundException('Request not found');
    if (request.customerId !== userId && request.providerId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    const quote = request.quotes[0];
    const subtotal = Number(quote?.amount || 0);
    const vat = +(subtotal * VAT_RATE).toFixed(2);
    const total = +(subtotal + vat).toFixed(2);

    return this._buildInvoice({
      invoiceType: 'HOME_SERVICE',
      invoiceRef: `HS-${requestId.slice(0, 8).toUpperCase()}`,
      issuedAt: request.escrow?.releasedAt || new Date(),
      customer: request.customer,
      provider: request.provider,
      lineItems: [
        {
          description: `خدمة: ${request.service.nameAr}`,
          quantity: 1,
          unitPrice: subtotal,
          total: subtotal,
        },
      ],
      subtotal,
      vat,
      total,
      paymentMethod: request.payments?.[0]?.method || 'UNKNOWN',
      escrowRef: request.escrow?.id,
    });
  }

  // ── Tender commission invoice ───────────────────────────────────────────
  async getTenderCommissionInvoice(userId: string, commissionId: string) {
    const commission = await this.prisma.tenderCommission.findUnique({
      where: { id: commissionId },
      include: {
        tender: {
          include: {
            company: { include: { owner: { include: { profile: true } } } },
          },
        },
        // commission.company = winning company (set at award time)
        company: { include: { owner: { include: { profile: true } } } },
      },
    });
    if (!commission) throw new NotFoundException('Commission not found');

    // Only the winning company owner, the awarding company owner, or admin can view
    const isWinner = commission.company?.ownerId === userId;
    const isOwner = commission.tender?.company?.ownerId === userId;
    if (!isWinner && !isOwner) throw new ForbiddenException('Access denied');

    const subtotal = Number(commission.commissionAmount);
    const vat = +(subtotal * VAT_RATE).toFixed(2);
    const total = +(subtotal + vat).toFixed(2);

    return this._buildInvoice({
      invoiceType: 'TENDER_COMMISSION',
      invoiceRef: `TC-${commissionId.slice(0, 8).toUpperCase()}`,
      issuedAt: commission.paidAt || new Date(),
      tenderTitle: commission.tender?.title,
      tenderBudget: Number(commission.tenderValue),
      lineItems: [
        {
          description: `عمولة منصة خدمة — مناقصة: ${commission.tender?.title}`,
          quantity: 1,
          unitPrice: subtotal,
          total: subtotal,
        },
      ],
      subtotal,
      vat,
      total,
      commissionRate: `${(Number(commission.commissionRate) * 100).toFixed(1)}%`,
    });
  }

  // ── Equipment rental invoice ────────────────────────────────────────────
  async getEquipmentInvoice(userId: string, rentalId: string) {
    const rental = await this.prisma.equipmentRental.findUnique({
      where: { id: rentalId },
      include: {
        equipment: { include: { owner: { include: { profile: true } } } },
        renter: { include: { profile: true } },
      },
    });
    if (!rental) throw new NotFoundException('Rental not found');
    if (rental.renterId !== userId && rental.equipment.ownerId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    const subtotal = Number(rental.totalPrice);
    const vat = +(subtotal * VAT_RATE).toFixed(2);
    const total = +(subtotal + vat).toFixed(2);

    return this._buildInvoice({
      invoiceType: 'EQUIPMENT_RENTAL',
      invoiceRef: `EQ-${rentalId.slice(0, 8).toUpperCase()}`,
      issuedAt: rental.completedAt || new Date(),
      customer: rental.renter,
      provider: rental.equipment.owner,
      lineItems: [
        {
          description: `إيجار معدة: ${rental.equipment.name} (${rental.days} يوم)`,
          quantity: rental.days,
          unitPrice: +(subtotal / rental.days).toFixed(2),
          total: subtotal,
        },
        ...(Number(rental.deliveryFee) > 0
          ? [
              {
                description: 'رسوم التوصيل',
                quantity: 1,
                unitPrice: Number(rental.deliveryFee),
                total: Number(rental.deliveryFee),
              },
            ]
          : []),
        ...(Number(rental.operatorFee) > 0
          ? [
              {
                description: 'رسوم المشغل',
                quantity: 1,
                unitPrice: Number(rental.operatorFee),
                total: Number(rental.operatorFee),
              },
            ]
          : []),
      ],
      subtotal,
      vat,
      total,
    });
  }

  // ── My invoices list ────────────────────────────────────────────────────
  async listMyInvoices(userId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;

    const [serviceRequests, tenderCommissions, rentals, consultations] = await Promise.all([
      this.prisma.serviceRequest.findMany({
        where: {
          OR: [{ customerId: userId }, { providerId: userId }],
          status: 'COMPLETED',
          escrow: { status: 'RELEASED' },
        },
        select: { id: true, service: { select: { nameAr: true } }, completedAt: true },
        orderBy: { completedAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.tenderCommission.findMany({
        where: {
          status: { in: ['PAID'] as any },
          OR: [
            { tender: { company: { ownerId: userId } } }, // awarding company owner
            { company: { ownerId: userId } }, // winning company owner
          ],
        },
        select: {
          id: true,
          tender: { select: { title: true } },
          commissionAmount: true,
          paidAt: true,
        },
        orderBy: { paidAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.equipmentRental.findMany({
        where: {
          OR: [{ renterId: userId }, { equipment: { ownerId: userId } }],
          status: 'COMPLETED',
        },
        select: {
          id: true,
          equipment: { select: { name: true } },
          totalPrice: true,
          completedAt: true,
        },
        orderBy: { completedAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.consultation.findMany({
        where: {
          OR: [{ customerId: userId }, { providerId: userId }],
          status: 'COMPLETED' as any,
          totalAmount: { not: null },
        },
        select: {
          id: true,
          topic: true,
          totalAmount: true,
          completedAt: true,
          provider: { select: { profile: { select: { nameAr: true, nameEn: true } } } },
        },
        orderBy: { completedAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    const homeServicesData = serviceRequests.map((r) => ({
      type: 'HOME_SERVICE',
      ref: `HS-${r.id.slice(0, 8).toUpperCase()}`,
      id: r.id,
      label: r.service.nameAr,
      date: r.completedAt,
    }));

    const tendersData = tenderCommissions.map((c) => ({
      type: 'TENDER_COMMISSION',
      ref: `TC-${c.id.slice(0, 8).toUpperCase()}`,
      id: c.id,
      label: c.tender.title,
      amount: c.commissionAmount,
      date: c.paidAt,
    }));

    const equipmentData = rentals.map((r) => ({
      type: 'EQUIPMENT_RENTAL',
      ref: `EQ-${r.id.slice(0, 8).toUpperCase()}`,
      id: r.id,
      label: r.equipment.name,
      amount: r.totalPrice,
      date: r.completedAt,
    }));

    const consultationsData = consultations.map((c) => ({
      type: 'CONSULTATION',
      ref: `CN-${c.id.slice(0, 8).toUpperCase()}`,
      id: c.id,
      label: c.topic,
      amount: c.totalAmount,
      date: c.completedAt,
      consultantName: c.provider?.profile?.nameAr ?? c.provider?.profile?.nameEn ?? null,
    }));

    const data = [
      ...homeServicesData,
      ...tendersData,
      ...equipmentData,
      ...consultationsData,
    ].sort((a, b) => {
      const da = a.date ? new Date(a.date).getTime() : 0;
      const db = b.date ? new Date(b.date).getTime() : 0;
      return db - da;
    });

    return {
      data,
      total: data.length,
      page,
      limit,
    };
  }

  // ── Consultation invoice ─────────────────────────────────────────────────
  async getConsultationInvoice(consultationId: string, userId: string) {
    const c = await this.prisma.consultation.findUnique({
      where: { id: consultationId },
      include: {
        provider: { include: { profile: true } },
        customer: { include: { profile: true } },
        service: true,
      },
    });
    if (!c) throw new NotFoundException('الاستشارة غير موجودة');
    if (c.customerId !== userId && c.providerId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    const subtotal = Number(c.totalAmount ?? 0);
    const vat = +(subtotal * VAT_RATE).toFixed(2);
    const total = +(subtotal + vat).toFixed(2);

    return this._buildInvoice({
      invoiceType: 'CONSULTATION',
      invoiceRef: `CN-${consultationId.slice(0, 8).toUpperCase()}`,
      issuedAt: c.completedAt || new Date(),
      customer: c.customer,
      provider: c.provider,
      lineItems: [
        {
          description: `استشارة: ${c.topic}`,
          quantity: 1,
          unitPrice: subtotal,
          total: subtotal,
        },
      ],
      subtotal,
      vat,
      total,
      consultationType: c.mode,
    });
  }

  // ── Private builder ─────────────────────────────────────────────────────
  private _buildInvoice(data: Record<string, any>) {
    return {
      platform: {
        name: 'منصة خدمة',
        nameEn: 'Khedmah Platform',
        vatNumber: 'SA300000000000000',
        address: 'الرياض، المملكة العربية السعودية',
        logo: '/assets/images/logo.png',
      },
      ...data,
      currency: 'SAR',
      vatRate: `${VAT_RATE * 100}%`,
      status: 'PAID',
    };
  }
}
