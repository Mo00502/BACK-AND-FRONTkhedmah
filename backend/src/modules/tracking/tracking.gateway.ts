import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';

interface LocationPayload {
  requestId: string;
  lat: number;
  lng: number;
  etaMinutes?: number;
}

interface StatusPayload {
  requestId: string;
  status: 'EN_ROUTE' | 'ARRIVED' | 'STARTED' | 'COMPLETED';
}

@WebSocketGateway({ namespace: '/tracking', cors: { origin: '*' } })
export class TrackingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(TrackingGateway.name);
  private providerSocketMap = new Map<string, string>(); // userId → socketId

  constructor(
    private jwt: JwtService,
    private config: ConfigService,
    private prisma: PrismaService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth?.token as string;
      const payload = this.jwt.verify(token, { secret: this.config.getOrThrow('JWT_SECRET') });
      client.data.userId = payload.sub;
      client.data.role = payload.role;

      if (payload.role === 'PROVIDER') {
        this.providerSocketMap.set(payload.sub, client.id);
      }

      this.logger.log(`Tracking connected: ${payload.role} ${payload.sub}`);
    } catch {
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    if (client.data?.userId) {
      this.providerSocketMap.delete(client.data.userId);
    }
  }

  // ── Provider/Customer joins the tracking room for a request ───────────────
  @SubscribeMessage('join_request_room')
  async handleJoinRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { requestId: string },
  ) {
    const request = await this.prisma.serviceRequest.findUnique({
      where: { id: data.requestId },
      select: { customerId: true, providerId: true },
    });
    if (
      !request ||
      (request.customerId !== client.data.userId && request.providerId !== client.data.userId)
    ) {
      client.emit('error', { message: 'غير مصرح بالوصول إلى هذا الطلب' });
      return;
    }
    client.join(`request:${data.requestId}`);
    this.logger.log(
      `${client.data.role} ${client.data.userId} joined tracking room: ${data.requestId}`,
    );
  }

  @SubscribeMessage('leave_request_room')
  handleLeaveRoom(@ConnectedSocket() client: Socket, @MessageBody() data: { requestId: string }) {
    client.leave(`request:${data.requestId}`);
  }

  // ── Provider broadcasts their live location ────────────────────────────────
  @SubscribeMessage('provider_location')
  handleProviderLocation(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: LocationPayload,
  ) {
    if (client.data.role !== 'PROVIDER') return;
    // Must have joined the room legitimately (via handleJoinRoom which checks ownership)
    if (!client.rooms.has(`request:${payload.requestId}`)) return;

    this.server.to(`request:${payload.requestId}`).emit('location_update', {
      providerId: client.data.userId,
      lat: payload.lat,
      lng: payload.lng,
      etaMinutes: payload.etaMinutes,
      timestamp: new Date().toISOString(),
    });
  }

  // ── Provider updates job status ────────────────────────────────────────────
  @SubscribeMessage('update_job_status')
  handleStatusUpdate(@ConnectedSocket() client: Socket, @MessageBody() payload: StatusPayload) {
    if (client.data.role !== 'PROVIDER') return;
    // Must have joined the room legitimately (via handleJoinRoom which checks ownership)
    if (!client.rooms.has(`request:${payload.requestId}`)) return;

    this.server.to(`request:${payload.requestId}`).emit('job_status_update', {
      requestId: payload.requestId,
      status: payload.status,
      updatedBy: client.data.userId,
      timestamp: new Date().toISOString(),
    });
  }

  // ── Triggered from RequestsService when status changes ────────────────────
  @OnEvent('request.status_changed')
  broadcastStatusChange(event: { requestId: string; status: string; providerId?: string }) {
    this.server.to(`request:${event.requestId}`).emit('job_status_update', {
      requestId: event.requestId,
      status: event.status,
      timestamp: new Date().toISOString(),
    });
  }

  // ── Push to specific provider socket ──────────────────────────────────────
  pushToProvider(providerId: string, event: string, data: any) {
    const socketId = this.providerSocketMap.get(providerId);
    if (socketId) {
      this.server.to(socketId).emit(event, data);
    }
  }
}
