import type { Request, RequestHandler } from 'express';
import rateLimit, { type Options } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { redis } from '../../config/redis.js';
import { RateLimitedError } from '../errors/AppError.js';

type KeyKind = 'ip' | 'phone' | 'user';

export interface RateLimitSpec {
  /** Unique name used as the Redis key prefix. Example: 'otp_request'. */
  name: string;
  windowMs: number;
  max: number;
  keyKind: KeyKind;
  /** Optional override; receives the Request, returns the key to count. */
  keyFn?: (req: Request) => string;
}

function extractPhone(req: Request): string | undefined {
  const body = req.body as { phone?: unknown } | undefined;
  return typeof body?.phone === 'string' ? body.phone : undefined;
}

function extractUserId(req: Request): string | undefined {
  return req.user?.sub;
}

/**
 * Build an express-rate-limit middleware backed by the shared Redis
 * client.
 *
 * Keying strategies map to SECURITY.md §6:
 *   - 'ip'    → fallback for anonymous endpoints
 *   - 'phone' → OTP request + verify limiters (SECURITY.md §1)
 *   - 'user'  → refresh + logout limiters for authenticated users
 *
 * On exhaustion we throw `RateLimitedError` so the global error
 * handler renders the standard envelope and Sentry tags it by code.
 */
export function makeRateLimiter(spec: RateLimitSpec): RequestHandler {
  const keyGenerator: Options['keyGenerator'] = (req) => {
    if (spec.keyFn) return spec.keyFn(req);

    switch (spec.keyKind) {
      case 'ip':
        return req.ip ?? 'unknown-ip';
      case 'phone':
        return extractPhone(req) ?? req.ip ?? 'unknown-phone';
      case 'user':
        return extractUserId(req) ?? req.ip ?? 'unknown-user';
    }
  };

  return rateLimit({
    windowMs: spec.windowMs,
    max: spec.max,
    standardHeaders: true,
    legacyHeaders: false,
    store: new RedisStore({
      sendCommand: async (...args: string[]): Promise<RedisReply> => {
        const [cmd, ...rest] = args;
        if (!cmd) throw new Error('sendCommand received empty command');
        return (await redis.call(cmd, ...rest)) as RedisReply;
      },
      prefix: `rl:${spec.name}:`,
    }),
    keyGenerator,
    handler: (_req, _res, next) => {
      next(new RateLimitedError('Too many requests'));
    },
  });
}
