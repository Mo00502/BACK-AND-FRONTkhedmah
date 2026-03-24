import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

@Injectable()
export class FilesService {
  private s3: S3Client;
  private bucket: string;
  private maxBytes: number;

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {
    this.bucket = config.get<string>('S3_BUCKET', 'khedmah-uploads');
    this.maxBytes = config.get<number>('S3_MAX_FILE_SIZE_MB', 20) * 1024 * 1024;

    this.s3 = new S3Client({
      region: config.get('S3_REGION', 'me-central-1'),
      endpoint: config.get<string>('S3_ENDPOINT') || undefined,
      credentials: {
        accessKeyId: config.get<string>('S3_ACCESS_KEY', ''),
        secretAccessKey: config.get<string>('S3_SECRET_KEY', ''),
      },
    });
  }

  async upload(userId: string, file: Express.Multer.File) {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      throw new BadRequestException(`File type ${file.mimetype} not allowed`);
    }

    const MIME_TO_EXT: Record<string, string[]> = {
      'image/jpeg': ['jpg', 'jpeg'],
      'image/png': ['png'],
      'image/webp': ['webp'],
      'image/gif': ['gif'],
      'application/pdf': ['pdf'],
    };
    const allowedExts = MIME_TO_EXT[file.mimetype] ?? [];
    const ext = (file.originalname.split('.').pop() ?? '').toLowerCase();
    if (allowedExts.length > 0 && !allowedExts.includes(ext)) {
      throw new BadRequestException(`File extension .${ext} does not match MIME type ${file.mimetype}`);
    }

    if (file.size > this.maxBytes) {
      const limitMb = this.config.get<number>('S3_MAX_FILE_SIZE_MB', 20);
      throw new BadRequestException(`File size exceeds ${limitMb} MB limit`);
    }

    const key = `uploads/${userId}/${uuidv4()}.${ext}`;

    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
        ServerSideEncryption: 'AES256',
      }),
    );

    const fileType = file.mimetype.startsWith('image/') ? 'IMAGE' : 'DOCUMENT';
    const region = this.config.get('S3_REGION', 'me-central-1');
    const endpoint = this.config.get<string>('S3_ENDPOINT');
    const url = endpoint
      ? `${endpoint}/${this.bucket}/${key}`
      : `https://${this.bucket}.s3.${region}.amazonaws.com/${key}`;

    const record = await this.prisma.file.create({
      data: {
        userId,
        type: fileType as any,
        s3Key: key,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        url,
      },
    });

    return { id: record.id, key, url };
  }

  async getPresignedUrl(key: string) {
    const expiresIn = this.config.get<number>('S3_SIGNED_URL_EXPIRY', 3600);
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.s3, command, { expiresIn });
  }

  async deleteFile(fileId: string, requestingUserId: string) {
    const file = await this.prisma.file.findUnique({ where: { id: fileId } });
    if (!file) throw new NotFoundException('File not found');
    if (file.userId !== requestingUserId)
      throw new ForbiddenException("Cannot delete another user's file");

    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: file.s3Key }));
    await this.prisma.file.delete({ where: { id: fileId } });
    return { message: 'File deleted' };
  }
}
