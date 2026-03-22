import { utilities as nestWinstonModuleUtilities } from 'nest-winston';
import * as winston from 'winston';

/**
 * Winston logger configuration for Khedmah API.
 *
 * - Development: human-readable coloured console output
 * - Production:  structured JSON to stdout (ingested by log aggregator)
 *
 * Log levels:  error > warn > info > http > verbose > debug
 * In prod:     info and above only
 * In dev/test: debug and above
 */
export function buildWinstonConfig(nodeEnv: string): winston.LoggerOptions {
  const isProd = nodeEnv === 'production';

  const transports: winston.transport[] = [
    isProd
      ? // JSON to stdout — suitable for CloudWatch, Datadog, Loki, etc.
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.errors({ stack: true }),
            winston.format.json(),
          ),
        })
      : // Pretty-printed, coloured output for local development
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.timestamp({ format: 'HH:mm:ss' }),
            winston.format.errors({ stack: true }),
            nestWinstonModuleUtilities.format.nestLike('Khedmah', {
              colors: true,
              prettyPrint: true,
              processId: true,
            }),
          ),
        }),
  ];

  return {
    level: isProd ? 'info' : 'debug',
    transports,
    // Never throw on logger errors — app must keep running even if log write fails
    exitOnError: false,
  };
}
