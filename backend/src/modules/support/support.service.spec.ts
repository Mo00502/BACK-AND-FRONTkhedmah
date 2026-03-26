import { Test, TestingModule } from '@nestjs/testing';
import { SupportService } from './support.service';
import { PrismaService } from '../../prisma/prisma.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';

const mockPrisma = {
  supportTicket: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
  },
  supportMessage: {
    create: jest.fn(),
  },
  $transaction: jest.fn(),
};

const mockEvents = { emit: jest.fn() };

describe('SupportService', () => {
  let service: SupportService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupportService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EventEmitter2, useValue: mockEvents },
      ],
    }).compile();
    service = module.get<SupportService>(SupportService);
  });

  // ── openTicket ───────────────────────────────────────────────────────────
  describe('openTicket', () => {
    it('creates a ticket and emits support.ticket_opened', async () => {
      const ticket = {
        id: 'ticket-1',
        userId: 'user-1',
        subject: 'مشكلة في الدفع',
        status: 'OPEN',
        category: 'PAYMENT',
        priority: 'HIGH',
      };
      mockPrisma.supportTicket.create.mockResolvedValue(ticket);

      const result = await service.openTicket(
        'user-1',
        'مشكلة في الدفع',
        'لم يتم خصم المبلغ بشكل صحيح',
        'PAYMENT',
        'HIGH',
        [],
      );

      expect(mockPrisma.supportTicket.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 'user-1',
            status: 'OPEN',
            category: 'PAYMENT',
            priority: 'HIGH',
          }),
        }),
      );
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'support.ticket_opened',
        expect.objectContaining({ ticketId: 'ticket-1', userId: 'user-1', category: 'PAYMENT', priority: 'HIGH' }),
      );
      expect(result.id).toBe('ticket-1');
    });

    it('uses MEDIUM as the default priority', async () => {
      mockPrisma.supportTicket.create.mockResolvedValue({ id: 'ticket-2', status: 'OPEN' });

      await service.openTicket('user-1', 'subject', 'desc', 'OTHER');

      expect(mockPrisma.supportTicket.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ priority: 'MEDIUM' }),
        }),
      );
    });

    it('throws BadRequestException when more than 10 attachments are provided', async () => {
      const tooManyAttachments = Array.from(
        { length: 11 },
        (_, i) => `https://cdn.example.com/file${i}.pdf`,
      );

      await expect(
        service.openTicket('user-1', 'subject', 'desc', 'TECHNICAL', 'LOW', tooManyAttachments),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when any attachment is not an HTTPS URL', async () => {
      const badAttachments = ['https://cdn.example.com/ok.pdf', 'http://insecure.example.com/file.pdf'];

      await expect(
        service.openTicket('user-1', 'subject', 'desc', 'ACCOUNT', 'LOW', badAttachments),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── addMessage (replyToTicket) ───────────────────────────────────────────
  describe('addMessage', () => {
    const makeTicket = (status: string, userId = 'user-1') => ({
      id: 'ticket-1',
      userId,
      status,
      resolvedAt: status === 'RESOLVED' ? new Date() : null,
    });

    it('appends a message to an open ticket', async () => {
      mockPrisma.supportTicket.findUnique.mockResolvedValue(makeTicket('OPEN'));
      const message = { id: 'msg-1', content: 'test reply', ticketId: 'ticket-1' };
      mockPrisma.$transaction.mockResolvedValue([message, {}]);

      const result = await service.addMessage('user-1', 'ticket-1', 'test reply');

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(result).toBe(message);
    });

    it('throws NotFoundException when ticket does not exist', async () => {
      mockPrisma.supportTicket.findUnique.mockResolvedValue(null);
      await expect(service.addMessage('user-1', 'non-existent', 'hi')).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when non-owner non-admin tries to reply', async () => {
      mockPrisma.supportTicket.findUnique.mockResolvedValue(makeTicket('OPEN', 'user-1'));
      await expect(service.addMessage('stranger-99', 'ticket-1', 'hi')).rejects.toThrow(ForbiddenException);
    });

    it('throws BadRequestException when replying to a CLOSED ticket', async () => {
      mockPrisma.supportTicket.findUnique.mockResolvedValue(makeTicket('CLOSED'));
      await expect(service.addMessage('user-1', 'ticket-1', 'hi')).rejects.toThrow(BadRequestException);
    });

    it('auto-reopens a RESOLVED ticket when customer replies and emits support.ticket_reopened', async () => {
      mockPrisma.supportTicket.findUnique.mockResolvedValue(makeTicket('RESOLVED'));
      const message = { id: 'msg-2', content: 'still broken', ticketId: 'ticket-1' };
      mockPrisma.$transaction.mockResolvedValue([message, {}]);

      const result = await service.addMessage('user-1', 'ticket-1', 'still broken');

      // Verify the transaction includes status revert to OPEN
      const txCall = mockPrisma.$transaction.mock.calls[0][0];
      // The second element in the transaction array should be the ticket update
      // We verify that the event was emitted
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'support.ticket_reopened',
        expect.objectContaining({ ticketId: 'ticket-1', userId: 'user-1' }),
      );
      expect(result).toBe(message);
    });

    it('does not emit ticket_reopened when an admin replies to a RESOLVED ticket', async () => {
      mockPrisma.supportTicket.findUnique.mockResolvedValue(makeTicket('RESOLVED', 'user-1'));
      mockPrisma.$transaction.mockResolvedValue([{ id: 'msg-3' }, {}]);

      await service.addMessage('admin-1', 'ticket-1', 'admin note', /* isAdmin */ true);

      expect(mockEvents.emit).not.toHaveBeenCalledWith('support.ticket_reopened', expect.anything());
    });
  });

  // ── updateStatus (closeTicket) ───────────────────────────────────────────
  describe('updateStatus', () => {
    it('sets CLOSED status and populates closedAt', async () => {
      const ticket = { id: 'ticket-1', status: 'RESOLVED', resolvedAt: new Date() };
      mockPrisma.supportTicket.findUnique.mockResolvedValue(ticket);
      mockPrisma.supportTicket.update.mockResolvedValue({ ...ticket, status: 'CLOSED' });

      await service.updateStatus('ticket-1', 'CLOSED');

      expect(mockPrisma.supportTicket.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ticket-1' },
          data: expect.objectContaining({ status: 'CLOSED', closedAt: expect.any(Date) }),
        }),
      );
    });

    it('sets resolvedAt when closing a ticket that was never resolved', async () => {
      const ticket = { id: 'ticket-1', status: 'IN_PROGRESS', resolvedAt: null };
      mockPrisma.supportTicket.findUnique.mockResolvedValue(ticket);
      mockPrisma.supportTicket.update.mockResolvedValue({ ...ticket, status: 'CLOSED' });

      await service.updateStatus('ticket-1', 'CLOSED');

      expect(mockPrisma.supportTicket.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ resolvedAt: expect.any(Date) }),
        }),
      );
    });

    it('sets resolvedAt when transitioning to RESOLVED', async () => {
      const ticket = { id: 'ticket-1', status: 'IN_PROGRESS', resolvedAt: null };
      mockPrisma.supportTicket.findUnique.mockResolvedValue(ticket);
      mockPrisma.supportTicket.update.mockResolvedValue({ ...ticket, status: 'RESOLVED' });

      await service.updateStatus('ticket-1', 'RESOLVED');

      expect(mockPrisma.supportTicket.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ resolvedAt: expect.any(Date) }),
        }),
      );
    });

    it('throws NotFoundException when ticket does not exist', async () => {
      mockPrisma.supportTicket.findUnique.mockResolvedValue(null);
      await expect(service.updateStatus('non-existent', 'CLOSED')).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException for an invalid status value', async () => {
      await expect(service.updateStatus('ticket-1', 'BOGUS')).rejects.toThrow(BadRequestException);
    });
  });

  // ── adminList (getTickets) ───────────────────────────────────────────────
  describe('adminList', () => {
    it('returns paginated tickets with no filters applied', async () => {
      const tickets = [{ id: 'ticket-1', status: 'OPEN' }];
      mockPrisma.supportTicket.findMany.mockResolvedValue(tickets);
      mockPrisma.supportTicket.count.mockResolvedValue(1);

      const result = await service.adminList();

      expect(mockPrisma.supportTicket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: {}, skip: 0, take: 20 }),
      );
      expect(result.total).toBe(1);
      expect(result.tickets).toHaveLength(1);
    });

    it('applies status and priority filters to the query', async () => {
      mockPrisma.supportTicket.findMany.mockResolvedValue([]);
      mockPrisma.supportTicket.count.mockResolvedValue(0);

      await service.adminList({ status: 'OPEN', priority: 'URGENT' });

      expect(mockPrisma.supportTicket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'OPEN', priority: 'URGENT' }),
        }),
      );
    });

    it('caps limit at 100 even when a larger value is requested', async () => {
      mockPrisma.supportTicket.findMany.mockResolvedValue([]);
      mockPrisma.supportTicket.count.mockResolvedValue(0);

      await service.adminList({ limit: 999 });

      expect(mockPrisma.supportTicket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 }),
      );
    });
  });

  // ── listMine ─────────────────────────────────────────────────────────────
  describe('listMine', () => {
    it('throws UnprocessableEntityException for an invalid status filter', async () => {
      await expect(service.listMine('user-1', 'INVALID_STATUS')).rejects.toThrow(UnprocessableEntityException);
    });

    it('returns user tickets filtered by userId', async () => {
      mockPrisma.supportTicket.findMany.mockResolvedValue([{ id: 'ticket-1' }]);
      mockPrisma.supportTicket.count.mockResolvedValue(1);

      const result = await service.listMine('user-1');

      expect(mockPrisma.supportTicket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ userId: 'user-1' }) }),
      );
      expect(result.tickets).toHaveLength(1);
    });
  });
});
