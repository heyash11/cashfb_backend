import type { Request, RequestHandler } from 'express';
import rateLimit, { ipKeyGenerator, type Options } from 'express-rate-limit';
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
  /**
   * Optional short-circuit — returning `true` skips rate-limit
   * accounting for that request. Used by load-test paths (Phase 9
   * Chunk 5) so 100-user signup bursts don't trip the 10/IP/15min
   * OTP verify limiter. The predicate itself is responsible for
   * triple-gating (dev-mode + phone pattern + flag).
   */
  skip?: (req: Request) => boolean;
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
/**
 * `ipKeyGenerator` collapses IPv6 addresses to a /64 prefix so a
 * single malicious host on an IPv6 /64 can't bypass the limiter by
 * rotating through the 2^64 addresses it owns. express-rate-limit
 * v7+ emits `ERR_ERL_KEY_GEN_IPV6` when a custom keyGenerator reads
 * req.ip without this wrapper — ignoring it would silently accept
 * per-host bypass. Applied to every branch: 'ip' always, and the
 * fallback path on 'phone' / 'user' when the primary selector is
 * missing.
 */
function fallbackIpKey(req: Request): string {
  return ipKeyGenerator(req.ip ?? '');
}

export function makeRateLimiter(spec: RateLimitSpec): RequestHandler {
  const keyGenerator: Options['keyGenerator'] = (req) => {
    if (spec.keyFn) return spec.keyFn(req);

    switch (spec.keyKind) {
      case 'ip':
        return fallbackIpKey(req);
      case 'phone':
        return extractPhone(req) ?? fallbackIpKey(req);
      case 'user':
        return extractUserId(req) ?? fallbackIpKey(req);
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
    ...(spec.skip ? { skip: spec.skip } : {}),
    handler: (_req, _res, next) => {
      next(new RateLimitedError('Too many requests'));
    },
  });
}
