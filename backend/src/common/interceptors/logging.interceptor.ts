import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { throwError } from 'rxjs';
import { Request, Response } from 'express';

/**
 * LoggingInterceptor
 * - Logs every HTTP request: method, path, status, duration, IP, user-id, request-id
 * - Logs errors at WARN level so they appear alongside the request line
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const start = Date.now();

    const requestId = (req.headers['x-request-id'] as string) ?? '-';
    const userId = (req as any).user?.id ?? 'anon';
    const ip = req.headers['x-forwarded-for'] ?? req.ip ?? req.socket?.remoteAddress ?? '-';

    return next.handle().pipe(
      tap(() => {
        const duration = Date.now() - start;
        this.logger.log(
          `${req.method} ${req.url} ${res.statusCode} ${duration}ms | uid:${userId} ip:${ip} rid:${requestId}`,
        );
      }),
      catchError((err) => {
        const duration = Date.now() - start;
        this.logger.warn(
          `${req.method} ${req.url} ERR:${err.status ?? 500} ${duration}ms | uid:${userId} ip:${ip} rid:${requestId} — ${err.message}`,
        );
        return throwError(() => err);
      }),
    );
  }
}
