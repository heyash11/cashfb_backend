import Redis from 'ioredis';
import { env } from './env.js';
import { logger } from './logger.js';

/**
 * ioredis singleton. Shared by:
 *  - rate-limit-redis stores in `src/shared/middleware/rateLimit.ts`
 *  - OTP lockout flag (key: `otp:lockout:{phone}`) in the auth service
 *  - Future: Redis-backed session cache, home feed cache, BullMQ.
 *
 * `maxRetriesPerRequest: null` + `enableReadyCheck: true` is the
 * BullMQ-recommended shape; keeps commands queued while reconnecting.
 */
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  lazyConnect: false,
});

redis.on('error', (err: unknown) => {
  logger.error({ err }, 'redis error');
});
redis.on('connect', () => {
  logger.info('redis connected');
});
redis.on('close', () => {
  logger.warn('redis connection closed');
});
