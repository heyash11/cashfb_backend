import type Redis from 'ioredis';
import { redis as defaultRedis } from '../../config/redis.js';
import { UnauthorizedError } from '../errors/AppError.js';
import { REFRESH_TTL_SEC } from '../jwt/signer.js';

/**
 * Force-logout denylist (Phase 8 Chunk 3a §Q2). Admin "force logout"
 * writes a cutoff timestamp (unix SECONDS, matching JWT `iat`) under
 *   auth:force-logout:<userId>
 * Any access or refresh token with `iat <= cutoff` is treated as
 * revoked.
 *
 * Design notes:
 *   - Key value is stored in SECONDS so no per-request ms/sec
 *     conversion is needed against JWT `iat`.
 *   - TTL matches REFRESH_TTL_SEC (30 d). Any token older than that
 *     is already expired via its own exp claim, so the denylist
 *     entry becomes redundant.
 *   - Per-user cutoff (not per-jti). Single write invalidates every
 *     outstanding session for that user — matches the "sign me out
 *     everywhere" UX.
 *   - One Redis GET per authenticated request. Acceptable at MVP
 *     scale; Phase 9 can add an in-process LRU if metrics show
 *     overhead. Do NOT cache in-process without invalidation.
 */

const KEY_PREFIX = 'auth:force-logout:';

function key(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}

export interface ForceLogoutDeps {
  redis?: Redis;
  clock?: () => number; // unix seconds
}

export class ForceLogoutStore {
  private readonly redis: Redis;
  private readonly clock: () => number;

  constructor(deps: ForceLogoutDeps = {}) {
    this.redis = deps.redis ?? defaultRedis;
    this.clock = deps.clock ?? (() => Math.floor(Date.now() / 1000));
  }

  /**
   * Set the cutoff to "now" — every token whose iat is <= this value
   * is rejected. Idempotent; re-invoking simply refreshes the TTL
   * and bumps the cutoff forward by however long since the last
   * call.
   */
  async forceLogout(userId: string): Promise<number> {
    const now = this.clock();
    await this.redis.set(key(userId), String(now), 'EX', REFRESH_TTL_SEC);
    return now;
  }

  async getCutoff(userId: string): Promise<number | null> {
    const raw = await this.redis.get(key(userId));
    if (raw === null) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Rejects if the token's iat is <= cutoff (token was issued before
   * the cutoff moment). Used by both requireUser middleware and the
   * refresh endpoint. Null cutoff → always pass.
   */
  async assertNotForceLoggedOut(userId: string, iat: number): Promise<void> {
    const cutoff = await this.getCutoff(userId);
    if (cutoff !== null && iat <= cutoff) {
      throw new UnauthorizedError('Session forcibly terminated');
    }
  }
}

/** Default singleton — used by the middleware + auth service. */
export const forceLogoutStore = new ForceLogoutStore();
