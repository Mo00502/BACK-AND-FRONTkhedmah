import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Language } from '@prisma/client';

@Injectable()
export class ChatService {
  constructor(
    private prisma: PrismaService,
    private events: EventEmitter2,
  ) {}

  async getOrCreateDirect(userAId: string, userBId: string) {
    // Find existing direct conversation between two users
    const existing = await this.prisma.conversation.findFirst({
      where: {
        type: 'DIRECT',
        participants: {
          every: { userId: { in: [userAId, userBId] } },
        },
      },
      include: { participants: true },
    });

    if (existing && existing.participants.length === 2) return existing;

    return this.prisma.conversation.create({
      data: {
        type: 'DIRECT',
        participants: {
          create: [{ userId: userAId }, { userId: userBId }],
        },
      },
      include: { participants: true },
    });
  }

  async getOrCreateForRef(type: 'REQUEST' | 'TENDER', refId: string, participantIds: string[]) {
    const existing = await this.prisma.conversation.findFirst({
      where: { type, refId },
    });
    if (existing) return existing;

    return this.prisma.conversation.create({
      data: {
        type,
        refId,
        participants: {
          create: participantIds.map((userId) => ({ userId })),
        },
      },
      include: { participants: true },
    });
  }

  async sendMessage(
    conversationId: string,
    senderId: string,
    data: {
      type?: string;
      content?: string;
      mediaUrl?: string;
      langOriginal?: string;
    },
  ) {
    // Verify sender is participant
    const participant = await this.prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId: senderId } },
    });
    if (!participant) throw new ForbiddenException('Not a participant');

    const message = await this.prisma.directMessage.create({
      data: {
        conversationId,
        senderId,
        type: (data.type as any) || 'TEXT',
        content: data.content,
        mediaUrl: data.mediaUrl,
        langOriginal: (data.langOriginal as Language) || Language.AR,
        readBy: [senderId],
      },
      include: {
        sender: { select: { id: true, profile: { select: { nameAr: true, avatarUrl: true } } } },
      },
    });

    // Update conversation updatedAt
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });

    this.events.emit('chat.message.sent', { conversationId, message });
    return message;
  }

  async getMessages(conversationId: string, userId: string, page = 1, limit = 50) {
    await this.assertParticipant(conversationId, userId);

    const skip = (page - 1) * limit;
    const [messages, total] = await Promise.all([
      this.prisma.directMessage.findMany({
        where: { conversationId, deletedAt: null },
        include: {
          sender: { select: { id: true, profile: { select: { nameAr: true, avatarUrl: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.directMessage.count({ where: { conversationId, deletedAt: null } }),
    ]);

    // Mark all as read
    await this.prisma.directMessage.updateMany({
      where: {
        conversationId,
        readBy: { not: { has: userId } } as any,
      },
      data: { readBy: { push: userId } },
    });

    await this.prisma.conversationParticipant.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: { lastReadAt: new Date() },
    });

    return { messages: messages.reverse(), total, page, limit };
  }

  async myConversations(userId: string) {
    return this.prisma.conversation.findMany({
      where: {
        participants: { some: { userId } },
      },
      include: {
        participants: {
          include: {
            user: { select: { id: true, profile: { select: { nameAr: true, avatarUrl: true } } } },
          },
        },
        messages: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async unreadCount(userId: string): Promise<number> {
    const conversations = await this.prisma.conversation.findMany({
      where: { participants: { some: { userId } } },
      include: {
        participants: { where: { userId } },
        messages: { where: { deletedAt: null } },
      },
    });

    let count = 0;
    for (const conv of conversations) {
      const p = conv.participants[0];
      const lastRead = p?.lastReadAt;
      count += conv.messages.filter(
        (m) => !m.readBy.includes(userId) && (!lastRead || m.createdAt > lastRead),
      ).length;
    }
    return count;
  }

  async isParticipant(conversationId: string, userId: string): Promise<boolean> {
    const p = await this.prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
    });
    return !!p;
  }

  private async assertParticipant(conversationId: string, userId: string) {
    if (!(await this.isParticipant(conversationId, userId))) {
      throw new ForbiddenException('Not a participant in this conversation');
    }
  }
}
