import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { ReportsService } from '../reports/reports.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';

// Only methods actually called by AdminController
const mockAdminService = {
  getDashboardStats: jest.fn(),
  getSystemHealth: jest.fn(),
  getMonthlyStats: jest.fn(),
  getPendingVerifications: jest.fn(),
  startReview: jest.fn(),
  approveProvider: jest.fn(),
  rejectProvider: jest.fn(),
  suspendProvider: jest.fn(),
  suspendUser: jest.fn(),
  reinstateUser: jest.fn(),
  deleteUser: jest.fn(),
  getDisputes: jest.fn(),
  getDisputeById: jest.fn(),
  resolveDispute: jest.fn(),
  getOverdueCommissions: jest.fn(),
  getConsultations: jest.fn(),
  getAuditLogs: jest.fn(),
  cancelConsultationByAdmin: jest.fn(),
};

const mockReportsService = {
  getWeeklyReportData: jest.fn(),
};

const mockJwtGuard = { canActivate: jest.fn().mockReturnValue(true) };
const mockRolesGuard = { canActivate: jest.fn().mockReturnValue(true) };

/**
 * Injects a fake admin user so @CurrentUser() decorators can resolve.
 */
function withAdminUser(id = 'admin-1', role = 'ADMIN') {
  return (req: any, _res: any, next: any) => {
    req.user = { id, role };
    next();
  };
}

describe('AdminController (HTTP)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        { provide: AdminService, useValue: mockAdminService },
        { provide: ReportsService, useValue: mockReportsService },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(mockJwtGuard)
      .overrideGuard(RolesGuard)
      .useValue(mockRolesGuard)
      .compile();

    app = module.createNestApplication();
    app.use(withAdminUser());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterEach(() => app.close());

  // ── GET /admin/dashboard ─────────────────────────────────────────────────────

  describe('GET /admin/dashboard', () => {
    it('returns 200 with dashboard KPI stats', async () => {
      const stats = {
        totalUsers: 150,
        totalProviders: 30,
        totalRequests: 500,
        completedRequests: 420,
        platformRevenue: 12500,
        pendingVerifications: 5,
        recentRequests: [],
      };
      mockAdminService.getDashboardStats.mockResolvedValue(stats);

      const res = await request(app.getHttpServer()).get('/admin/dashboard').expect(200);

      expect(res.body).toEqual(stats);
      expect(mockAdminService.getDashboardStats).toHaveBeenCalledTimes(1);
    });
  });

  // ── GET /admin/health ────────────────────────────────────────────────────────

  describe('GET /admin/health', () => {
    it('returns 200 with system health snapshot', async () => {
      const health = { redisOk: true, dbOk: true, pendingJobs: 0 };
      mockAdminService.getSystemHealth.mockResolvedValue(health);

      const res = await request(app.getHttpServer()).get('/admin/health').expect(200);

      expect(res.body).toEqual(health);
      expect(mockAdminService.getSystemHealth).toHaveBeenCalledTimes(1);
    });
  });

  // ── GET /admin/stats/monthly ─────────────────────────────────────────────────

  describe('GET /admin/stats/monthly', () => {
    it('returns 200 with last-6-months stats', async () => {
      const monthly = [{ month: '2026-01', total: 80, completed: 70 }];
      mockAdminService.getMonthlyStats.mockResolvedValue(monthly);

      const res = await request(app.getHttpServer()).get('/admin/stats/monthly').expect(200);

      expect(res.body).toEqual(monthly);
      expect(mockAdminService.getMonthlyStats).toHaveBeenCalledTimes(1);
    });
  });

  // ── GET /admin/verifications/pending ────────────────────────────────────────

  describe('GET /admin/verifications/pending', () => {
    it('returns 200 with list of pending provider verifications', async () => {
      const pending = { items: [{ id: 'prov-1' }], total: 1 };
      mockAdminService.getPendingVerifications.mockResolvedValue(pending);

      const res = await request(app.getHttpServer())
        .get('/admin/verifications/pending')
        .expect(200);

      expect(res.body).toEqual(pending);
      expect(mockAdminService.getPendingVerifications).toHaveBeenCalledWith(1, 20);
    });

    it('forwards page and limit query params', async () => {
      mockAdminService.getPendingVerifications.mockResolvedValue({ items: [], total: 0 });

      await request(app.getHttpServer())
        .get('/admin/verifications/pending?page=3&limit=5')
        .expect(200);

      expect(mockAdminService.getPendingVerifications).toHaveBeenCalledWith(3, 5);
    });
  });

  // ── PATCH /admin/verifications/:providerId/start-review ──────────────────────

  describe('PATCH /admin/verifications/:providerId/start-review', () => {
    it('returns 200 when review is started', async () => {
      const updated = { id: 'prov-1', verificationStatus: 'UNDER_REVIEW' };
      mockAdminService.startReview.mockResolvedValue(updated);

      const res = await request(app.getHttpServer())
        .patch('/admin/verifications/prov-1/start-review')
        .expect(200);

      expect(res.body).toEqual(updated);
      expect(mockAdminService.startReview).toHaveBeenCalledWith('prov-1');
    });
  });

  // ── PATCH /admin/verifications/:providerId/approve ───────────────────────────

  describe('PATCH /admin/verifications/:providerId/approve', () => {
    it('returns 200 when provider is approved', async () => {
      const approved = { id: 'prov-1', verificationStatus: 'APPROVED' };
      mockAdminService.approveProvider.mockResolvedValue(approved);

      const res = await request(app.getHttpServer())
        .patch('/admin/verifications/prov-1/approve')
        .expect(200);

      expect(res.body).toEqual(approved);
      expect(mockAdminService.approveProvider).toHaveBeenCalledWith('prov-1');
    });
  });

  // ── PATCH /admin/verifications/:providerId/reject ────────────────────────────

  describe('PATCH /admin/verifications/:providerId/reject', () => {
    it('returns 200 when provider is rejected with a valid reason', async () => {
      const rejected = { id: 'prov-1', verificationStatus: 'REJECTED' };
      mockAdminService.rejectProvider.mockResolvedValue(rejected);

      const res = await request(app.getHttpServer())
        .patch('/admin/verifications/prov-1/reject')
        .send({ reason: 'الوثائق المقدمة غير واضحة أو منتهية الصلاحية' })
        .expect(200);

      expect(res.body).toEqual(rejected);
      expect(mockAdminService.rejectProvider).toHaveBeenCalledWith(
        'prov-1',
        'الوثائق المقدمة غير واضحة أو منتهية الصلاحية',
      );
    });

    it('returns 400 when reason is missing', async () => {
      await request(app.getHttpServer())
        .patch('/admin/verifications/prov-1/reject')
        .send({})
        .expect(400);

      expect(mockAdminService.rejectProvider).not.toHaveBeenCalled();
    });

    it('returns 400 when reason is shorter than 10 characters', async () => {
      await request(app.getHttpServer())
        .patch('/admin/verifications/prov-1/reject')
        .send({ reason: 'short' })
        .expect(400);

      expect(mockAdminService.rejectProvider).not.toHaveBeenCalled();
    });
  });

  // ── PATCH /admin/verifications/:providerId/suspend ───────────────────────────

  describe('PATCH /admin/verifications/:providerId/suspend', () => {
    it('returns 200 when provider is suspended with a reason', async () => {
      const suspended = { id: 'prov-1', suspended: true };
      mockAdminService.suspendProvider.mockResolvedValue(suspended);

      const res = await request(app.getHttpServer())
        .patch('/admin/verifications/prov-1/suspend')
        .send({ reason: 'مخالفة الشروط والأحكام' })
        .expect(200);

      expect(res.body).toEqual(suspended);
      expect(mockAdminService.suspendProvider).toHaveBeenCalledWith(
        'prov-1',
        'مخالفة الشروط والأحكام',
      );
    });

    it('returns 400 when reason is missing', async () => {
      await request(app.getHttpServer())
        .patch('/admin/verifications/prov-1/suspend')
        .send({})
        .expect(400);

      expect(mockAdminService.suspendProvider).not.toHaveBeenCalled();
    });
  });

  // ── POST /admin/users/:userId/suspend ────────────────────────────────────────

  describe('POST /admin/users/:userId/suspend', () => {
    it('returns 201 when a user is suspended', async () => {
      const suspended = { id: 'user-9', suspended: true };
      mockAdminService.suspendUser.mockResolvedValue(suspended);

      const res = await request(app.getHttpServer())
        .post('/admin/users/user-9/suspend')
        .send({ reason: 'سلوك مسيء' })
        .expect(201);

      expect(res.body).toEqual(suspended);
      expect(mockAdminService.suspendUser).toHaveBeenCalledWith('user-9', 'سلوك مسيء', 'admin-1');
    });

    it('returns 400 when reason is missing', async () => {
      await request(app.getHttpServer())
        .post('/admin/users/user-9/suspend')
        .send({})
        .expect(400);

      expect(mockAdminService.suspendUser).not.toHaveBeenCalled();
    });
  });

  // ── POST /admin/users/:userId/reinstate ──────────────────────────────────────

  describe('POST /admin/users/:userId/reinstate', () => {
    it('returns 201 when a user is reinstated', async () => {
      const reinstated = { id: 'user-9', suspended: false };
      mockAdminService.reinstateUser.mockResolvedValue(reinstated);

      const res = await request(app.getHttpServer())
        .post('/admin/users/user-9/reinstate')
        .expect(201);

      expect(res.body).toEqual(reinstated);
      expect(mockAdminService.reinstateUser).toHaveBeenCalledWith('user-9');
    });
  });

  // ── POST /admin/users/:userId/delete ─────────────────────────────────────────

  describe('POST /admin/users/:userId/delete', () => {
    it('returns 201 when a user is soft-deleted', async () => {
      const deleted = { id: 'user-9', deletedAt: '2026-03-26T00:00:00.000Z' };
      mockAdminService.deleteUser.mockResolvedValue(deleted);

      const res = await request(app.getHttpServer())
        .post('/admin/users/user-9/delete')
        .expect(201);

      expect(res.body).toEqual(deleted);
      expect(mockAdminService.deleteUser).toHaveBeenCalledWith('user-9');
    });
  });

  // ── GET /admin/disputes ──────────────────────────────────────────────────────

  describe('GET /admin/disputes', () => {
    it('returns 200 with list of open disputes', async () => {
      const disputes = { items: [{ id: 'disp-1' }], total: 1 };
      mockAdminService.getDisputes.mockResolvedValue(disputes);

      const res = await request(app.getHttpServer()).get('/admin/disputes').expect(200);

      expect(res.body).toEqual(disputes);
      expect(mockAdminService.getDisputes).toHaveBeenCalledWith(1, 20);
    });

    it('forwards page and limit query params', async () => {
      mockAdminService.getDisputes.mockResolvedValue({ items: [], total: 0 });

      await request(app.getHttpServer()).get('/admin/disputes?page=2&limit=5').expect(200);

      expect(mockAdminService.getDisputes).toHaveBeenCalledWith(2, 5);
    });
  });

  // ── GET /admin/disputes/:disputeId ───────────────────────────────────────────

  describe('GET /admin/disputes/:disputeId', () => {
    it('returns 200 with dispute detail', async () => {
      const dispute = { id: 'disp-1', reason: 'Provider no-show' };
      mockAdminService.getDisputeById.mockResolvedValue(dispute);

      const res = await request(app.getHttpServer()).get('/admin/disputes/disp-1').expect(200);

      expect(res.body).toEqual(dispute);
      expect(mockAdminService.getDisputeById).toHaveBeenCalledWith('disp-1');
    });
  });

  // ── POST /admin/disputes/:disputeId/resolve ───────────────────────────────────

  describe('POST /admin/disputes/:disputeId/resolve', () => {
    it('returns 201 when dispute is resolved with REFUND', async () => {
      const resolved = { id: 'disp-1', status: 'RESOLVED' };
      mockAdminService.resolveDispute.mockResolvedValue(resolved);

      const body = { resolution: 'REFUND', notes: 'Provider failed to deliver' };
      const res = await request(app.getHttpServer())
        .post('/admin/disputes/disp-1/resolve')
        .send(body)
        .expect(201);

      expect(res.body).toEqual(resolved);
      expect(mockAdminService.resolveDispute).toHaveBeenCalledWith(
        'disp-1',
        'admin-1',
        'REFUND',
        'Provider failed to deliver',
      );
    });

    it('returns 201 when dispute is resolved with RELEASE', async () => {
      mockAdminService.resolveDispute.mockResolvedValue({ id: 'disp-1', status: 'RESOLVED' });

      await request(app.getHttpServer())
        .post('/admin/disputes/disp-1/resolve')
        .send({ resolution: 'RELEASE', notes: 'Work was completed satisfactorily' })
        .expect(201);

      expect(mockAdminService.resolveDispute).toHaveBeenCalledWith(
        'disp-1',
        'admin-1',
        'RELEASE',
        'Work was completed satisfactorily',
      );
    });

    it('returns 201 when dispute is DISMISSED', async () => {
      mockAdminService.resolveDispute.mockResolvedValue({ id: 'disp-1', status: 'RESOLVED' });

      await request(app.getHttpServer())
        .post('/admin/disputes/disp-1/resolve')
        .send({ resolution: 'DISMISSED', notes: 'Insufficient evidence provided' })
        .expect(201);
    });

    it('returns 400 when resolution is missing', async () => {
      await request(app.getHttpServer())
        .post('/admin/disputes/disp-1/resolve')
        .send({ notes: 'some notes' })
        .expect(400);

      expect(mockAdminService.resolveDispute).not.toHaveBeenCalled();
    });

    it('returns 400 when notes is missing', async () => {
      await request(app.getHttpServer())
        .post('/admin/disputes/disp-1/resolve')
        .send({ resolution: 'REFUND' })
        .expect(400);

      expect(mockAdminService.resolveDispute).not.toHaveBeenCalled();
    });

    it('returns 400 when resolution is not a valid enum value', async () => {
      await request(app.getHttpServer())
        .post('/admin/disputes/disp-1/resolve')
        .send({ resolution: 'INVALID_RESOLUTION', notes: 'some notes' })
        .expect(400);

      expect(mockAdminService.resolveDispute).not.toHaveBeenCalled();
    });
  });

  // ── GET /admin/commissions/overdue ───────────────────────────────────────────

  describe('GET /admin/commissions/overdue', () => {
    it('returns 200 with overdue commissions list', async () => {
      const commissions = { items: [{ id: 'comm-1' }], total: 1 };
      mockAdminService.getOverdueCommissions.mockResolvedValue(commissions);

      const res = await request(app.getHttpServer())
        .get('/admin/commissions/overdue')
        .expect(200);

      expect(res.body).toEqual(commissions);
      expect(mockAdminService.getOverdueCommissions).toHaveBeenCalledWith(1, 20);
    });
  });

  // ── GET /admin/reports/weekly ─────────────────────────────────────────────────

  describe('GET /admin/reports/weekly', () => {
    it('returns 200 with weekly report data', async () => {
      const report = { totalBookings: 50, totalRevenue: 5000 };
      mockReportsService.getWeeklyReportData.mockResolvedValue(report);

      const res = await request(app.getHttpServer()).get('/admin/reports/weekly').expect(200);

      expect(res.body).toEqual(report);
      expect(mockReportsService.getWeeklyReportData).toHaveBeenCalledTimes(1);
    });
  });

  // ── GET /admin/consultations ─────────────────────────────────────────────────

  describe('GET /admin/consultations', () => {
    it('returns 200 with consultations list', async () => {
      const consultations = { items: [{ id: 'cons-1' }], total: 1 };
      mockAdminService.getConsultations.mockResolvedValue(consultations);

      const res = await request(app.getHttpServer()).get('/admin/consultations').expect(200);

      expect(res.body).toEqual(consultations);
      expect(mockAdminService.getConsultations).toHaveBeenCalledWith(1, 20, undefined);
    });

    it('forwards status query param', async () => {
      mockAdminService.getConsultations.mockResolvedValue({ items: [], total: 0 });

      await request(app.getHttpServer())
        .get('/admin/consultations?status=COMPLETED')
        .expect(200);

      expect(mockAdminService.getConsultations).toHaveBeenCalledWith(1, 20, 'COMPLETED');
    });
  });

  // ── PATCH /admin/consultations/:consultationId/cancel ────────────────────────

  describe('PATCH /admin/consultations/:consultationId/cancel', () => {
    it('returns 200 when consultation is force-cancelled', async () => {
      const cancelled = { id: 'cons-1', status: 'CANCELLED' };
      mockAdminService.cancelConsultationByAdmin.mockResolvedValue(cancelled);

      const res = await request(app.getHttpServer())
        .patch('/admin/consultations/cons-1/cancel')
        .send({ reason: 'Policy violation' })
        .expect(200);

      expect(res.body).toEqual(cancelled);
      expect(mockAdminService.cancelConsultationByAdmin).toHaveBeenCalledWith(
        'cons-1',
        'admin-1',
        'Policy violation',
      );
    });

    it('returns 400 when reason is missing', async () => {
      await request(app.getHttpServer())
        .patch('/admin/consultations/cons-1/cancel')
        .send({})
        .expect(400);

      expect(mockAdminService.cancelConsultationByAdmin).not.toHaveBeenCalled();
    });
  });

  // ── GET /admin/audit ─────────────────────────────────────────────────────────

  describe('GET /admin/audit', () => {
    it('returns 200 with audit log entries', async () => {
      const auditLogs = { items: [{ id: 'audit-1', action: 'user.suspended' }], total: 1 };
      mockAdminService.getAuditLogs.mockResolvedValue(auditLogs);

      const res = await request(app.getHttpServer()).get('/admin/audit').expect(200);

      expect(res.body).toEqual(auditLogs);
      expect(mockAdminService.getAuditLogs).toHaveBeenCalledWith(1, 50, {
        action: undefined,
        entityType: undefined,
        userId: undefined,
      });
    });

    it('forwards filter query params', async () => {
      mockAdminService.getAuditLogs.mockResolvedValue({ items: [], total: 0 });

      await request(app.getHttpServer())
        .get('/admin/audit?action=user.suspended&entityType=User&userId=usr-5&page=2&limit=10')
        .expect(200);

      expect(mockAdminService.getAuditLogs).toHaveBeenCalledWith(2, 10, {
        action: 'user.suspended',
        entityType: 'User',
        userId: 'usr-5',
      });
    });
  });
});
