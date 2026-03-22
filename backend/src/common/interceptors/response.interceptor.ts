import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';

/**
 * ResponseInterceptor
 * - Wraps every successful response in { success, data, meta?, requestId, timestamp }
 * - Injects X-Request-ID response header so clients can correlate requests to logs
 * - Handles paginated shape (__paginated flag from PaginationDto)
 */
@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const start = Date.now();

    // Honour caller-supplied request ID or generate a fresh one
    const requestId = (req.headers['x-request-id'] as string) || uuidv4();
    req.headers['x-request-id'] = requestId;

    return next.handle().pipe(
      map((data) => {
        const duration = Date.now() - start;

        // Write response headers for observability
        res.setHeader('X-Request-ID', requestId);
        res.setHeader('X-Response-Time', `${duration}ms`);

        const base = { success: true, requestId, timestamp: new Date().toISOString() };

        // Paginated response (signalled by paginate() helper in pagination.dto.ts)
        if (data?.__paginated) {
          const { items, total, page, limit } = data;
          return {
            ...base,
            data: items,
            meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
          };
        }

        return { ...base, data };
      }),
    );
  }
}
