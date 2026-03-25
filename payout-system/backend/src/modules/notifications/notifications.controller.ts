import {
  Controller,
  Get,
  Patch,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 30 })
  @ApiOperation({ summary: 'Get my notifications (newest first) with unread count' })
  @ApiResponse({ status: 200, description: 'Paginated notifications with unread count' })
  async getMyNotifications(
    @CurrentUser('id') userId: string,
    @Query('page') page = 1,
    @Query('limit') limit = 30,
  ) {
    return this.notificationsService.getMyNotifications(userId, Number(page), Number(limit));
  }

  @Patch(':id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a single notification as read' })
  @ApiResponse({ status: 200, description: 'Notification marked as read' })
  @ApiResponse({ status: 403, description: 'Notification does not belong to you' })
  @ApiResponse({ status: 404, description: 'Notification not found' })
  async markRead(
    @Param('id') notificationId: string,
    @CurrentUser('id') userId: string,
  ) {
    await this.notificationsService.markRead(notificationId, userId);
    return { message: 'Notification marked as read' };
  }

  @Patch('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark all notifications as read' })
  @ApiResponse({ status: 200, description: 'All notifications marked as read' })
  async markAllRead(@CurrentUser('id') userId: string) {
    return this.notificationsService.markAllRead(userId);
  }
}
