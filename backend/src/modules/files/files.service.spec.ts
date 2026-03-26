import { BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { FilesService } from './files.service';

// Mock the AWS SDK modules
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  PutObjectCommand: jest.fn(),
  GetObjectCommand: jest.fn(),
  DeleteObjectCommand: jest.fn(),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://s3.example.com/presigned-url'),
}));

import { S3Client } from '@aws-sdk/client-s3';

const mockPrisma = {
  file: {
    findUnique: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
  },
};

const mockConfig = {
  get: jest.fn((key: string, fallback?: any) => {
    const cfg: Record<string, any> = {
      S3_BUCKET: 'test-bucket',
      S3_MAX_FILE_SIZE_MB: 20,
      S3_REGION: 'me-central-1',
      S3_ACCESS_KEY: 'test-key',
      S3_SECRET_KEY: 'test-secret',
    };
    return cfg[key] ?? fallback;
  }),
};

const makeFile = (overrides: Partial<Express.Multer.File> = {}): Express.Multer.File => ({
  fieldname: 'file',
  originalname: 'photo.jpg',
  encoding: '7bit',
  mimetype: 'image/jpeg',
  buffer: Buffer.from('data'),
  size: 1024,
  stream: null as any,
  destination: '',
  filename: '',
  path: '',
  ...overrides,
});

describe('FilesService', () => {
  let service: FilesService;
  let mockS3Send: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new FilesService(mockPrisma as any, mockConfig as any);
    // Get the send mock from the S3Client instance
    mockS3Send = (service as any).s3.send as jest.Mock;
    mockS3Send.mockResolvedValue({});
  });

  describe('upload()', () => {
    it('uploads a valid image file and returns id, key, url', async () => {
      mockPrisma.file.create.mockResolvedValue({ id: 'file-1', s3Key: 'uploads/u1/uuid.jpg' });

      const result = await service.upload('u1', makeFile());

      expect(mockS3Send).toHaveBeenCalled();
      expect(mockPrisma.file.create).toHaveBeenCalled();
      expect(result).toMatchObject({ id: 'file-1' });
    });

    it('throws BadRequestException for a disallowed MIME type', async () => {
      const file = makeFile({ mimetype: 'video/mp4', originalname: 'video.mp4' });

      await expect(service.upload('u1', file)).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when file extension does not match MIME type', async () => {
      const file = makeFile({ mimetype: 'image/png', originalname: 'photo.jpg' });

      await expect(service.upload('u1', file)).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when file exceeds size limit', async () => {
      const bigFile = makeFile({
        size: 21 * 1024 * 1024, // 21 MB > 20 MB limit
        originalname: 'big.jpg',
        mimetype: 'image/jpeg',
      });

      await expect(service.upload('u1', bigFile)).rejects.toThrow(BadRequestException);
    });

    it('accepts PDF files', async () => {
      mockPrisma.file.create.mockResolvedValue({ id: 'file-2', s3Key: 'uploads/u1/uuid.pdf' });
      const pdfFile = makeFile({ mimetype: 'application/pdf', originalname: 'doc.pdf' });

      const result = await service.upload('u1', pdfFile);
      expect(result).toBeDefined();
    });
  });

  describe('deleteFile()', () => {
    it('deletes file when the requesting user is the owner', async () => {
      mockPrisma.file.findUnique.mockResolvedValue({
        id: 'file-1',
        userId: 'u1',
        s3Key: 'uploads/u1/uuid.jpg',
      });
      mockPrisma.file.delete.mockResolvedValue({ id: 'file-1' });

      const result = await service.deleteFile('file-1', 'u1');

      expect(mockS3Send).toHaveBeenCalled();
      expect(mockPrisma.file.delete).toHaveBeenCalledWith({ where: { id: 'file-1' } });
      expect(result).toEqual({ message: 'File deleted' });
    });

    it('throws NotFoundException when file does not exist', async () => {
      mockPrisma.file.findUnique.mockResolvedValue(null);

      await expect(service.deleteFile('nonexistent', 'u1')).rejects.toThrow(NotFoundException);
    });

    it("throws ForbiddenException when user tries to delete another user's file", async () => {
      mockPrisma.file.findUnique.mockResolvedValue({
        id: 'file-1',
        userId: 'owner-id',
        s3Key: 'uploads/owner-id/uuid.jpg',
      });

      await expect(service.deleteFile('file-1', 'attacker-id')).rejects.toThrow(ForbiddenException);
    });
  });

  describe('getPresignedUrl()', () => {
    it('returns a presigned URL for the given key', async () => {
      const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
      (getSignedUrl as jest.Mock).mockResolvedValue('https://s3.example.com/presigned');

      const url = await service.getPresignedUrl('uploads/u1/uuid.jpg');

      expect(url).toBe('https://s3.example.com/presigned');
    });
  });
});
