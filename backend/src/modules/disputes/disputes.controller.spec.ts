import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { DisputesController } from './disputes.controller';
import { DisputesService } from './disputes.service';
import { FilesService } from '../files/files.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

const mockService = {
  listMyDisputes: jest.fn(),
  openDispute: jest.fn(),
  getDispute: jest.fn(),
  addEvidence: jest.fn(),
  escalate: jest.fn(),
};

const mockFilesService = {
  upload: jest.fn(),
};

const mockJwtGuard = { canActivate: jest.fn().mockReturnValue(true) };

/**
 * Injects a fake req.user so @CurrentUser() can extract id and role.
 */
function withUser(id = 'user-1', role = 'CUSTOMER') {
  return (req: any, _res: any, next: any) => {
    req.user = { id, role };
    next();
  };
}

describe('DisputesController (HTTP)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DisputesController],
      providers: [
        { provide: DisputesService, useValue: mockService },
        { provide: FilesService, useValue: mockFilesService },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(mockJwtGuard)
      .compile();

    app = module.createNestApplication();
    app.use(withUser());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterEach(() => app.close());

  // ── GET /disputes ───────────────────────────────────────────────────────────

  describe('GET /disputes', () => {
    it('returns 200 with a list of disputes', async () => {
      const list = { items: [{ id: 'disp-1' }], total: 1 };
      mockService.listMyDisputes.mockResolvedValue(list);

      const res = await request(app.getHttpServer()).get('/disputes').expect(200);

      expect(res.body).toEqual(list);
      expect(mockService.listMyDisputes).toHaveBeenCalledWith('user-1', 1, 20);
    });

    it('forwards page and limit query params', async () => {
      mockService.listMyDisputes.mockResolvedValue({ items: [], total: 0 });

      await request(app.getHttpServer()).get('/disputes?page=2&limit=10').expect(200);

      expect(mockService.listMyDisputes).toHaveBeenCalledWith('user-1', 2, 10);
    });
  });

  // ── POST /disputes ──────────────────────────────────────────────────────────

  describe('POST /disputes', () => {
    const validBody = {
      requestId: 'req-1',
      reason: 'Provider did not complete the work',
    };

    it('returns 201 with the created dispute on a valid body', async () => {
      const dispute = { id: 'disp-1', ...validBody };
      mockService.openDispute.mockResolvedValue(dispute);

      const res = await request(app.getHttpServer())
        .post('/disputes')
        .send(validBody)
        .expect(201);

      expect(res.body).toEqual(dispute);
      expect(mockService.openDispute).toHaveBeenCalledWith(
        'user-1',
        validBody.requestId,
        validBody.reason,
        undefined,
        undefined,
      );
    });

    it('returns 400 when requestId is missing', async () => {
      await request(app.getHttpServer())
        .post('/disputes')
        .send({ reason: 'some reason' })
        .expect(400);

      expect(mockService.openDispute).not.toHaveBeenCalled();
    });

    it('returns 400 when reason is missing', async () => {
      await request(app.getHttpServer())
        .post('/disputes')
        .send({ requestId: 'req-1' })
        .expect(400);

      expect(mockService.openDispute).not.toHaveBeenCalled();
    });

    it('returns 400 when body is entirely empty', async () => {
      await request(app.getHttpServer()).post('/disputes').send({}).expect(400);

      expect(mockService.openDispute).not.toHaveBeenCalled();
    });

    it('passes optional details and evidence through when supplied', async () => {
      const body = {
        ...validBody,
        details: 'الشرح التفصيلي للمشكلة',
        evidence: ['https://cdn.example.com/img1.jpg', 'https://cdn.example.com/img2.jpg'],
      };
      mockService.openDispute.mockResolvedValue({ id: 'disp-2', ...body });

      await request(app.getHttpServer()).post('/disputes').send(body).expect(201);

      expect(mockService.openDispute).toHaveBeenCalledWith(
        'user-1',
        body.requestId,
        body.reason,
        body.details,
        body.evidence,
      );
    });
  });

  // ── GET /disputes/:disputeId ─────────────────────────────────────────────────

  describe('GET /disputes/:disputeId', () => {
    it('returns 200 with dispute details', async () => {
      const dispute = { id: 'disp-1', reason: 'Provider did not show up' };
      mockService.getDispute.mockResolvedValue(dispute);

      const res = await request(app.getHttpServer()).get('/disputes/disp-1').expect(200);

      expect(res.body).toEqual(dispute);
      expect(mockService.getDispute).toHaveBeenCalledWith('user-1', 'disp-1', 'CUSTOMER');
    });
  });

  // ── POST /disputes/:disputeId/evidence ───────────────────────────────────────

  describe('POST /disputes/:disputeId/evidence', () => {
    const validBody = {
      fileUrls: ['https://cdn.example.com/evidence1.pdf'],
    };

    it('returns 201 on successful evidence upload', async () => {
      const updated = { id: 'disp-1', evidence: validBody.fileUrls };
      mockService.addEvidence.mockResolvedValue(updated);

      const res = await request(app.getHttpServer())
        .post('/disputes/disp-1/evidence')
        .send(validBody)
        .expect(201);

      expect(res.body).toEqual(updated);
      expect(mockService.addEvidence).toHaveBeenCalledWith('user-1', 'disp-1', validBody.fileUrls);
    });

    it('returns 400 when fileUrls is missing', async () => {
      await request(app.getHttpServer())
        .post('/disputes/disp-1/evidence')
        .send({})
        .expect(400);

      expect(mockService.addEvidence).not.toHaveBeenCalled();
    });

    it('returns 400 when fileUrls is not an array', async () => {
      await request(app.getHttpServer())
        .post('/disputes/disp-1/evidence')
        .send({ fileUrls: 'not-an-array' })
        .expect(400);

      expect(mockService.addEvidence).not.toHaveBeenCalled();
    });

    it('accepts multiple file URLs', async () => {
      const multipleUrls = {
        fileUrls: [
          'https://cdn.example.com/file1.jpg',
          'https://cdn.example.com/file2.jpg',
          'https://cdn.example.com/file3.pdf',
        ],
      };
      mockService.addEvidence.mockResolvedValue({ id: 'disp-1', evidence: multipleUrls.fileUrls });

      await request(app.getHttpServer())
        .post('/disputes/disp-1/evidence')
        .send(multipleUrls)
        .expect(201);

      expect(mockService.addEvidence).toHaveBeenCalledWith(
        'user-1',
        'disp-1',
        multipleUrls.fileUrls,
      );
    });
  });

  // ── POST /disputes/:disputeId/escalate ───────────────────────────────────────

  describe('POST /disputes/:disputeId/escalate', () => {
    it('returns 201 on successful escalation', async () => {
      const escalated = { id: 'disp-1', status: 'UNDER_REVIEW' };
      mockService.escalate.mockResolvedValue(escalated);

      const res = await request(app.getHttpServer())
        .post('/disputes/disp-1/escalate')
        .expect(201);

      expect(res.body).toEqual(escalated);
      expect(mockService.escalate).toHaveBeenCalledWith('user-1', 'disp-1');
    });
  });
});
