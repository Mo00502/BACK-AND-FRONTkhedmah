import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Param,
  Query,
  Body,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsString, IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ThrottleRelaxed, ThrottleDefault } from '../../common/decorators/throttle.decorator';

class RegisterTokenDto {
  @ApiProperty() @IsString() token: string;
  @ApiProperty({ enum: ['IOS', 'ANDROID', 'WEB'] }) @IsEnum(['IOS', 'ANDROID', 'WEB']) platform:
    | 'IOS'
    | 'ANDROID'
    | 'WEB';
}

@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private notif: NotificationsService) {}

  @ThrottleRelaxed()
  @Get()
  @ApiOperation({ summary: 'Get my notifications (paginated)' })
  getAll(@CurrentUser('id') userId: string, @Query('page') page = 1, @Query('limit') limit = 20) {
    return this.notif.getMyNotifications(userId, +page, +limit);
  }

  @ThrottleDefault()
  @Patch('read-all')
  @ApiOperation({ summary: 'Mark all notifications as read' })
  markAllRead(@CurrentUser('id') userId: string) {
    return this.notif.markRead(userId);
  }

  @ThrottleDefault()
  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark a single notification as read' })
  markOneRead(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.notif.markRead(userId, id);
  }

  @ThrottleDefault()
  @Post('device-token')
  @ApiOperation({ summary: 'Register FCM device token for push notifications' })
  registerToken(@CurrentUser('id') userId: string, @Body() dto: RegisterTokenDto) {
    return this.notif.registerDeviceToken(userId, dto.token, dto.platform);
  }

  @ThrottleDefault()
  @Delete('device-token/:token')
  @ApiOperation({ summary: 'Unregister FCM device token (on logout)' })
  unregisterToken(@Param('token') token: string, @CurrentUser('id') userId: string) {
    return this.notif.unregisterDeviceToken(userId, token);
  }
}
