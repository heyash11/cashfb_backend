import { redis } from '../../config/redis.js';
import { logger } from '../../config/logger.js';
import { adminSessionCount } from './registry.js';

/**
 * Active-admin-session count via non-blocking SCAN.
 *
 * Why SCAN not KEYS: KEYS blocks the Redis single-thread for the
 * full pass and will stall every other client during the walk.
 * SCAN is cursor-based, guarantees bounded work per round-trip,
 * and is safe to run from the metrics path. Redis docs:
 * https://redis.io/commands/scan/.
 *
 * Key-space layout (see admin-session.store.ts):
 *   admin:session:<sessionId>              — the value we count
 *   admin:session:by-admin:<adminId>       — secondary index, skip
 *
 * We use a broad MATCH pattern (`admin:session:*`) and filter
 * 'by-admin:' keys in-application per the Chunk 3 sign-off. The
 * tighter pattern `admin:session:[!by-admin]*` doesn't exist in
 * Redis glob syntax, and multiple narrower SCANs would double the
 * round-trip cost.
 */
const SESSION_PREFIX = 'admin:session:';
const BY_ADMIN_PREFIX = 'admin:session:by-admin:';
const SCAN_COUNT_HINT = 500;

export async function collectAdminSessionCount(): Promise<void> {
  try {
    let cursor = '0';
    let total = 0;
    do {
      const [nextCursor, keys] = (await redis.scan(
        cursor,
        'MATCH',
        `${SESSION_PREFIX}*`,
        'COUNT',
        SCAN_COUNT_HINT,
      )) as [string, string[]];
      cursor = nextCursor;
      for (const key of keys) {
        if (key.startsWith(BY_ADMIN_PREFIX)) continue;
        total++;
      }
    } while (cursor !== '0');
    adminSessionCount.set(total);
  } catch (err) {
    logger.warn({ err }, '[metrics] admin session SCAN failed');
    // Preserve the last-known value on failure. Flipping to 0 would
    // look like a mass-logout in dashboards.
  }
}
