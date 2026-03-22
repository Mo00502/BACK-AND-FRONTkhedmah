import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import * as Sentry from '@sentry/node';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = (request.headers['x-request-id'] as string) || uuidv4();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let errors: any[] | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse() as any;
      message =
        typeof exceptionResponse === 'string'
          ? exceptionResponse
          : exceptionResponse.message || exception.message;
      errors = Array.isArray(exceptionResponse.message) ? exceptionResponse.message : undefined;
    }

    if (status >= 500) {
      this.logger.error(`${request.method} ${request.url} ${status}`, (exception as Error)?.stack);
      // Capture 5xx errors in Sentry (no-ops if Sentry DSN not configured)
      Sentry.captureException(exception, {
        extra: { requestId, method: request.method, url: request.url, status },
      });
    }

    response.status(status).json({
      success: false,
      statusCode: status,
      message,
      errors,
      requestId,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}
