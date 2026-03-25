import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RegisterDto, LoginDto } from './dto/auth.dto';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { UserRole } from '@prisma/client';

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly BCRYPT_ROUNDS = 12;
  private readonly REFRESH_TOKEN_TTL_DAYS = 30;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async register(dto: RegisterDto): Promise<{ user: any; tokens: TokenPair }> {
    // Check duplicate email
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });

    if (existing) {
      throw new ConflictException('Email already registered');
    }

    const passwordHash = await bcrypt.hash(dto.password, this.BCRYPT_ROUNDS);

    const user = await this.prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          email: dto.email.toLowerCase(),
          passwordHash,
          firstName: dto.firstName,
          lastName: dto.lastName,
          phone: dto.phone,
          role: dto.role ?? UserRole.CUSTOMER,
        },
        select: {
          id: true,
          email: true,
          role: true,
          firstName: true,
          lastName: true,
          phone: true,
          isActive: true,
          createdAt: true,
        },
      });

      // Create wallet for new user
      await tx.wallet.create({
        data: {
          userId: newUser.id,
          availableBalance: 0,
          pendingBalance: 0,
          escrowBalance: 0,
        },
      });

      // If provider role, create provider profile
      if (newUser.role === UserRole.PROVIDER) {
        await tx.provider.create({
          data: { userId: newUser.id },
        });
      }

      return newUser;
    });

    const tokens = await this.generateAndStoreTokens(user.id, user.email, user.role);

    this.logger.log(`New user registered: ${user.email} [${user.role}]`);

    return { user, tokens };
  }

  async login(dto: LoginDto): Promise<{ user: any; tokens: TokenPair }> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        role: true,
        firstName: true,
        lastName: true,
        phone: true,
        isActive: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordMatch = await bcrypt.compare(dto.password, user.passwordHash);
    if (!passwordMatch) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Account is deactivated. Contact support.');
    }

    const tokens = await this.generateAndStoreTokens(user.id, user.email, user.role);

    const { passwordHash: _, ...safeUser } = user;

    this.logger.log(`User logged in: ${user.email}`);

    return { user: safeUser, tokens };
  }

  async refresh(token: string): Promise<TokenPair> {
    if (!token) {
      throw new BadRequestException('Refresh token is required');
    }

    // Find matching stored tokens
    const storedTokens = await this.prisma.refreshToken.findMany({
      where: {
        expiresAt: { gt: new Date() },
      },
      include: { user: true },
    });

    let matchedToken: typeof storedTokens[0] | null = null;

    for (const stored of storedTokens) {
      const isMatch = await bcrypt.compare(token, stored.tokenHash);
      if (isMatch) {
        matchedToken = stored;
        break;
      }
    }

    if (!matchedToken) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    if (!matchedToken.user.isActive) {
      throw new UnauthorizedException('Account is deactivated');
    }

    // Delete used token (rotation)
    await this.prisma.refreshToken.delete({ where: { id: matchedToken.id } });

    // Issue new token pair
    const newTokens = await this.generateAndStoreTokens(
      matchedToken.user.id,
      matchedToken.user.email,
      matchedToken.user.role,
    );

    return newTokens;
  }

  async logout(userId: string): Promise<void> {
    await this.prisma.refreshToken.deleteMany({ where: { userId } });
    this.logger.log(`User logged out: ${userId}`);
  }

  private async generateAndStoreTokens(
    userId: string,
    email: string,
    role: string,
  ): Promise<TokenPair> {
    const payload = { sub: userId, email, role };

    const accessToken = this.jwtService.sign(payload, {
      secret: this.configService.get<string>('JWT_SECRET'),
      expiresIn: this.configService.get<string>('JWT_EXPIRES_IN', '15m'),
    });

    const rawRefreshToken = crypto.randomBytes(64).toString('hex');
    const refreshTokenHash = await bcrypt.hash(rawRefreshToken, 10);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + this.REFRESH_TOKEN_TTL_DAYS);

    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: refreshTokenHash,
        expiresAt,
      },
    });

    return { accessToken, refreshToken: rawRefreshToken };
  }
}
