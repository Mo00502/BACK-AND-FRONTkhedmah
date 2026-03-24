import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class PortfolioService {
  constructor(private prisma: PrismaService) {}

  // ── Portfolio items ────────────────────────────────────────────────────────
  async getPortfolio(providerId: string, page = 1, limit = 20) {
    const safeLimit = Math.min(Math.max(1, limit), 50);
    const safePage  = Math.max(1, page);
    const skip = (safePage - 1) * safeLimit;
    const [items, total] = await Promise.all([
      this.prisma.portfolioItem.findMany({
        where: { providerId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: safeLimit,
      }),
      this.prisma.portfolioItem.count({ where: { providerId } }),
    ]);
    return { items, total, page: safePage, pages: Math.ceil(total / safeLimit) };
  }

  async addItem(
    userId: string,
    title: string,
    description: string,
    imageUrls: string[],
    serviceId?: string,
  ) {
    const profile = await this._getProfile(userId);
    return this.prisma.portfolioItem.create({
      data: { providerId: profile.id, title, description, imageUrls, serviceId },
    });
  }

  async removeItem(userId: string, itemId: string) {
    const profile = await this._getProfile(userId);
    const item = await this.prisma.portfolioItem.findUnique({ where: { id: itemId } });
    if (!item) throw new NotFoundException('Portfolio item not found');
    if (item.providerId !== profile.id) throw new ForbiddenException('Not your item');
    return this.prisma.portfolioItem.delete({ where: { id: itemId } });
  }

  // ── Certifications ─────────────────────────────────────────────────────────
  async getCertifications(providerId: string, page = 1, limit = 50) {
    const safeLimit = Math.min(Math.max(1, limit), 100);
    const safePage  = Math.max(1, page);
    const skip = (safePage - 1) * safeLimit;
    const [items, total] = await Promise.all([
      this.prisma.certification.findMany({
        where: { providerId },
        orderBy: { issuedAt: 'desc' },
        skip,
        take: safeLimit,
      }),
      this.prisma.certification.count({ where: { providerId } }),
    ]);
    return { items, total, page: safePage, pages: Math.ceil(total / safeLimit) };
  }

  async addCertification(
    userId: string,
    name: string,
    issuer: string,
    issuedAt: Date,
    expiresAt?: Date,
    fileUrl?: string,
  ) {
    const profile = await this._getProfile(userId);
    return this.prisma.certification.create({
      data: { providerId: profile.id, name, issuer, issuedAt, expiresAt, fileUrl, verified: false },
    });
  }

  async removeCertification(userId: string, certId: string) {
    const profile = await this._getProfile(userId);
    const cert = await this.prisma.certification.findUnique({ where: { id: certId } });
    if (!cert) throw new NotFoundException('Certification not found');
    if (cert.providerId !== profile.id) throw new ForbiddenException('Not your certification');
    return this.prisma.certification.delete({ where: { id: certId } });
  }

  // ── Admin: verify certification ────────────────────────────────────────────
  async verifyCertification(certId: string) {
    return this.prisma.certification.update({
      where: { id: certId },
      data: { verified: true, verifiedAt: new Date() },
    });
  }

  private async _getProfile(userId: string) {
    const profile = await this.prisma.providerProfile.findUnique({ where: { userId } });
    if (!profile) throw new NotFoundException('Provider profile not found');
    return profile;
  }
}
