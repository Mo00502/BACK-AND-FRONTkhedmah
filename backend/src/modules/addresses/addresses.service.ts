import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateAddressDto } from './dto/address.dto';

const MAX_ADDRESSES = 10;

@Injectable()
export class AddressesService {
  constructor(private prisma: PrismaService) {}

  async list(userId: string) {
    return this.prisma.savedAddress.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async create(userId: string, dto: CreateAddressDto) {
    // Enforce max 10 saved addresses per user
    const count = await this.prisma.savedAddress.count({ where: { userId } });
    if (count >= MAX_ADDRESSES) {
      throw new BadRequestException(`لا يمكن حفظ أكثر من ${MAX_ADDRESSES} عناوين`);
    }

    return this.prisma.$transaction(async (tx) => {
      // If this is the first address or isDefault=true, clear other defaults first
      if (dto.isDefault || count === 0) {
        await tx.savedAddress.updateMany({
          where: { userId, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.savedAddress.create({
        data: { ...dto, userId, isDefault: dto.isDefault ?? count === 0 },
      });
    });
  }

  async update(userId: string, id: string, dto: Partial<CreateAddressDto>) {
    const addr = await this.prisma.savedAddress.findUnique({ where: { id } });
    if (!addr) throw new NotFoundException('العنوان غير موجود');
    if (addr.userId !== userId) throw new ForbiddenException();

    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) {
        await tx.savedAddress.updateMany({
          where: { userId, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.savedAddress.update({ where: { id }, data: dto });
    });
  }

  async remove(userId: string, id: string) {
    const addr = await this.prisma.savedAddress.findUnique({ where: { id } });
    if (!addr) throw new NotFoundException('العنوان غير موجود');
    if (addr.userId !== userId) throw new ForbiddenException();
    await this.prisma.savedAddress.delete({ where: { id } });

    // If deleted was default, promote most recent to default
    if (addr.isDefault) {
      const next = await this.prisma.savedAddress.findFirst({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      });
      if (next) {
        await this.prisma.savedAddress.update({
          where: { id: next.id },
          data: { isDefault: true },
        });
      }
    }
    return { success: true };
  }

  async setDefault(userId: string, id: string) {
    const addr = await this.prisma.savedAddress.findUnique({ where: { id } });
    if (!addr) throw new NotFoundException();
    if (addr.userId !== userId) throw new ForbiddenException();

    return this.prisma.$transaction(async (tx) => {
      await tx.savedAddress.updateMany({
        where: { userId, isDefault: true },
        data: { isDefault: false },
      });
      return tx.savedAddress.update({ where: { id }, data: { isDefault: true } });
    });
  }
}
