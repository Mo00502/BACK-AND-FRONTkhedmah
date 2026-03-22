import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Query,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery, ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { RegisterCustomerDto } from './dto/register-customer.dto';
import { RegisterProviderDto } from './dto/register-provider.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { Public } from '../../common/decorators/public.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  ThrottleAuth,
  ThrottleDefault,
  ThrottleStrict,
  SkipThrottle,
} from '../../common/decorators/throttle.decorator';

class ResendVerificationDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email: string;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  // ── Registration ─────────────────────────────────────────────────────────────

  @Public()
  @Post('register/customer')
  @HttpCode(HttpStatus.CREATED)
  @ThrottleAuth() // 5/min — prevent bulk registration
  @ApiOperation({ summary: 'Register a new customer account (email + password)' })
  registerCustomer(@Body() dto: RegisterCustomerDto) {
    return this.auth.registerCustomer(dto);
  }

  @Public()
  @Post('register/provider')
  @HttpCode(HttpStatus.CREATED)
  @ThrottleAuth()
  @ApiOperation({
    summary: 'Register a new provider account — requires email verification + admin approval',
  })
  registerProvider(@Body() dto: RegisterProviderDto) {
    return this.auth.registerProvider(dto);
  }

  // ── Email Verification ────────────────────────────────────────────────────────

  @Public()
  @Get('verify-email')
  @HttpCode(HttpStatus.OK)
  @SkipThrottle() // link clicks should never be throttled
  @ApiOperation({ summary: 'Verify email address using the link token' })
  @ApiQuery({ name: 'token', required: true, description: 'Token from verification email' })
  verifyEmail(@Query('token') token: string) {
    return this.auth.verifyEmail(token);
  }

  @Public()
  @Post('verify-email/resend')
  @HttpCode(HttpStatus.OK)
  @ThrottleAuth() // 5/min — prevent flooding
  @ApiOperation({ summary: 'Re-send the email verification link' })
  resendVerification(@Body() dto: ResendVerificationDto) {
    return this.auth.resendVerificationEmail(dto.email);
  }

  // ── Login ─────────────────────────────────────────────────────────────────────

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ThrottleAuth() // 5/min — brute-force guard
  @ApiOperation({ summary: 'Login with email or username + password' })
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto, req.ip);
  }

  // ── Password Reset ────────────────────────────────────────────────────────────

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ThrottleAuth() // 5/min — prevent email flooding
  @ApiOperation({ summary: 'Request a password reset email' })
  forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    dto.ip = req.ip;
    return this.auth.forgotPassword(dto);
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ThrottleStrict() // 10/min — token guessing guard
  @ApiOperation({ summary: 'Reset password using the link token' })
  resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request) {
    dto.ip = req.ip;
    return this.auth.resetPassword(dto);
  }

  // ── Token Management ──────────────────────────────────────────────────────────

  @Public()
  @Post('token/refresh')
  @HttpCode(HttpStatus.OK)
  @ThrottleDefault() // 30/min
  @ApiOperation({ summary: 'Rotate refresh token and get a new access token' })
  refresh(@Body() dto: RefreshTokenDto) {
    return this.auth.refreshTokens(dto);
  }

  // ── Authenticated user endpoints ──────────────────────────────────────────

  @UseGuards(JwtAuthGuard)
  @Get('me')
  @ApiBearerAuth()
  @ThrottleDefault()
  @ApiOperation({ summary: 'Get current authenticated user profile' })
  getMe(@CurrentUser('id') userId: string) {
    return this.auth.getMe(userId);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('me/password')
  @ApiBearerAuth()
  @ThrottleStrict() // 10/min — prevent brute-force against current session
  @ApiOperation({ summary: 'Change password (requires current password)' })
  changePassword(
    @CurrentUser('id') userId: string,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.auth.changePassword(userId, dto.currentPassword, dto.newPassword);
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @SkipThrottle() // logout is idempotent — never throttle
  @ApiOperation({ summary: 'Revoke refresh token(s) and log out' })
  logout(@CurrentUser('id') userId: string, @Body() body: { tokenId?: string }) {
    return this.auth.logout(userId, body.tokenId);
  }
}
