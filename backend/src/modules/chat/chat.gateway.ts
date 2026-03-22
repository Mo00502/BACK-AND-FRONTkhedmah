import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { ChatService } from './chat.service';
import { OnEvent } from '@nestjs/event-emitter';

@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/chat',
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  private userSocketMap = new Map<string, string>(); // userId → socketId

  constructor(
    private jwt: JwtService,
    private config: ConfigService,
    private chat: ChatService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth?.token as string;
      const payload = this.jwt.verify(token, {
        secret: this.config.get('JWT_SECRET'),
      });
      client.data.userId = payload.sub;
      this.userSocketMap.set(payload.sub, client.id);
      client.emit('connected', { userId: payload.sub });
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    if (client.data.userId) {
      this.userSocketMap.delete(client.data.userId);
    }
  }

  @SubscribeMessage('join')
  async handleJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    const userId = client.data.userId;
    if (!userId) return { error: 'Unauthorized' };

    // Verify the user is actually a participant before subscribing to the room
    const ok = await this.chat.isParticipant(data.conversationId, userId);
    if (!ok) return { error: 'Not a participant in this conversation' };

    client.join(`conv:${data.conversationId}`);
    return { ok: true };
  }

  @SubscribeMessage('leave')
  handleLeave(@ConnectedSocket() client: Socket, @MessageBody() data: { conversationId: string }) {
    client.leave(`conv:${data.conversationId}`);
    return { ok: true };
  }

  @SubscribeMessage('send_message')
  async handleMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: { conversationId: string; content: string; type?: string; mediaUrl?: string },
  ) {
    const userId = client.data.userId;
    if (!userId) return { error: 'Unauthorized' };

    const message = await this.chat.sendMessage(data.conversationId, userId, {
      type: data.type,
      content: data.content,
      mediaUrl: data.mediaUrl,
    });

    // Broadcast to room
    this.server.to(`conv:${data.conversationId}`).emit('new_message', message);
    return { ok: true, message };
  }

  @SubscribeMessage('typing')
  handleTyping(@ConnectedSocket() client: Socket, @MessageBody() data: { conversationId: string }) {
    client.to(`conv:${data.conversationId}`).emit('user_typing', {
      userId: client.data.userId,
      conversationId: data.conversationId,
    });
  }

  @OnEvent('chat.message.sent')
  pushToOfflineUsers(payload: { conversationId: string; message: any }) {
    // Push notification to offline participants is handled by NotificationsService (FCM).
    // Do NOT re-emit to the Socket.IO room here — handleMessage already did that.
  }

  sendToUser(userId: string, event: string, data: any) {
    const socketId = this.userSocketMap.get(userId);
    if (socketId) {
      this.server.to(socketId).emit(event, data);
    }
  }
}
