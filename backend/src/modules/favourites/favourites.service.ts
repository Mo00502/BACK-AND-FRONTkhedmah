import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

type RefType = 'PROVIDER' | 'EQUIPMENT' | 'TENDER';

@Injectable()
export class FavouritesService {
  constructor(private prisma: PrismaService) {}

  private assertValidRefType(refType: string): asserts refType is RefType {
    const VALID_REF_TYPES: RefType[] = ['PROVIDER', 'EQUIPMENT', 'TENDER'];
    if (!VALID_REF_TYPES.includes(refType as RefType)) {
      throw new BadRequestException('Invalid refType. Must be one of: PROVIDER, EQUIPMENT, TENDER');
    }
  }

  async toggle(userId: string, refType: RefType, refId: string) {
    this.assertValidRefType(refType);
    const existing = await this.prisma.favourite.findUnique({
      where: { userId_refType_refId: { userId, refType, refId } },
    });

    if (existing) {
      await this.prisma.favourite.delete({ where: { id: existing.id } });
      return { saved: false };
    }

    await this.prisma.favourite.create({ data: { userId, refType, refId } });
    return { saved: true };
  }

  async listMine(userId: string, refType?: RefType) {
    const where: any = { userId };
    if (refType) {
      this.assertValidRefType(refType);
      where.refType = refType;
    }

    const favs = await this.prisma.favourite.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    // Enrich with actual entity data
    const enriched = await Promise.all(
      favs.map(async (fav) => {
        let entity: any = null;
        try {
          if (fav.refType === 'PROVIDER') {
            entity = await this.prisma.providerProfile.findUnique({
              where: { id: fav.refId },
              include: { user: { include: { profile: true } } },
            });
          } else if (fav.refType === 'EQUIPMENT') {
            entity = await this.prisma.equipment.findUnique({
              where: { id: fav.refId },
              select: {
                id: true,
                name: true,
                category: true,
                dayPrice: true,
                region: true,
                rating: true,
              },
            });
          } else if (fav.refType === 'TENDER') {
            entity = await this.prisma.tender.findUnique({
              where: { id: fav.refId },
              select: { id: true, title: true, budgetMin: true, budgetMax: true, deadline: true, status: true },
            });
          }
        } catch {
          /* entity may have been deleted */
        }
        return { ...fav, entity };
      }),
    );

    return enriched.filter((f) => f.entity !== null);
  }

  async isSaved(userId: string, refType: RefType, refId: string) {
    this.assertValidRefType(refType);
    const fav = await this.prisma.favourite.findUnique({
      where: { userId_refType_refId: { userId, refType, refId } },
    });
    return { saved: Boolean(fav) };
  }

  async countForRef(refType: RefType, refId: string) {
    this.assertValidRefType(refType);
    const count = await this.prisma.favourite.count({ where: { refType, refId } });
    return { count };
  }
}
