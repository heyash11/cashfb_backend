import { Router } from 'express';
import { ipAllowlist } from '../../shared/middleware/ip-allowlist.js';
import { collectBullmqDepthOnce } from '../../shared/metrics/bullmq.js';
import { collectMongoGauges } from '../../shared/metrics/mongo.js';
import { collectRedisGauges } from '../../shared/metrics/redis.js';
import { registry } from '../../shared/metrics/registry.js';
import { collectAdminSessionCount } from '../../shared/metrics/sessions.js';

/**
 * Prometheus exposition. Gated by `ipAllowlist()` only — NOT the
 * admin session / CSRF chain. Prometheus scrapers don't carry
 * cookies and shouldn't be forced through the interactive admin
 * auth surface. The allowlist IS the auth boundary for this route;
 * staging/prod MUST populate `AppConfig.adminIpAllowlist` before
 * metrics scraping is reachable (see docs/ADMIN_OPERATIONS.md
 * §Observability).
 *
 * Collection posture:
 *   - Mongo + Redis + sessions: refreshed on every scrape. Cheap
 *     reads; no caching layer.
 *   - BullMQ depths: polled on the 15s interval started at boot
 *     (src/shared/metrics/bullmq.ts). The scrape reads whatever
 *     the last poll wrote. A scrape-time refresh is intentionally
 *     avoided — getJobCounts touches Redis and would put the
 *     entire scrape latency on the critical path if Redis hiccups.
 *
 * Format: `registry.metrics()` returns the Prometheus text format
 * (v0.0.4). Content-Type set per spec so scrapers don't attempt
 * OpenMetrics negotiation.
 */
export function createMetricsRouter(): Router {
  const router = Router();

  router.get('/', ipAllowlist(), async (_req, res, next) => {
    try {
      collectMongoGauges();
      collectRedisGauges();
      await collectAdminSessionCount();
      // Opportunistic BullMQ refresh alongside the scrape so the
      // first scrape after boot (before the 15s interval fires)
      // still sees real numbers. Failure is swallowed inside
      // collectBullmqDepthOnce — a slow Redis won't stall the
      // response.
      await collectBullmqDepthOnce();

      res.setHeader('Content-Type', registry.contentType);
      res.send(await registry.metrics());
    } catch (err) {
      next(err);
    }
  });

  return router;
}
