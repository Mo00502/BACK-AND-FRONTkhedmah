import { Controller, Get, Post, Body, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { ChatService } from './chat.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ThrottleDefault, ThrottleRelaxed } from '../../common/decorators/throttle.decorator';

@ApiTags('chat')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('chat')
export class ChatController {
  constructor(private chat: ChatService) {}

  @Get('conversations')
  @ThrottleRelaxed()
  @ApiOperation({ summary: 'Get my conversations with last message' })
  mine(@CurrentUser() user: any) {
    return this.chat.myConversations(user.id);
  }

  @Get('unread')
  @ThrottleRelaxed()
  @ApiOperation({ summary: 'Get total unread message count' })
  unread(@CurrentUser() user: any) {
    return this.chat.unreadCount(user.id).then((count) => ({ unread: count }));
  }

  @Post('direct/:userId')
  @ThrottleDefault()
  @ApiOperation({ summary: 'Start or get direct conversation with a user' })
  direct(@CurrentUser() user: any, @Param('userId') otherId: string) {
    return this.chat.getOrCreateDirect(user.id, otherId);
  }

  @Post('request/:requestId')
  @ThrottleDefault()
  @ApiOperation({ summary: 'Get or create conversation for a service request' })
  forRequest(@Param('requestId') refId: string, @Body('participantIds') ids: string[]) {
    return this.chat.getOrCreateForRef('REQUEST', refId, ids);
  }

  @Post('tender/:tenderId')
  @ThrottleDefault()
  @ApiOperation({ summary: 'Get or create conversation for a tender' })
  forTender(@Param('tenderId') refId: string, @Body('participantIds') ids: string[]) {
    return this.chat.getOrCreateForRef('TENDER', refId, ids);
  }

  @Get('conversations/:id/messages')
  @ThrottleRelaxed()
  @ApiOperation({ summary: 'Get paginated messages for a conversation' })
  messages(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Query('page') page = 1,
    @Query('limit') limit = 50,
  ) {
    return this.chat.getMessages(id, user.id, +page, +limit);
  }

  @Post('conversations/:id/messages')
  @ThrottleDefault()
  @ApiOperation({ summary: 'Send a message (REST fallback, prefer WebSocket)' })
  send(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Body() body: { content?: string; type?: string; mediaUrl?: string },
  ) {
    return this.chat.sendMessage(id, user.id, body);
  }
}
