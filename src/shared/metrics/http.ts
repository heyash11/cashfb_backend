import type { NextFunction, Request, Response } from 'express';
import { httpRequestDurationSeconds, httpRequestsTotal } from './registry.js';

/**
 * HTTP latency + count middleware. Attaches a `res.on('finish')`
 * listener, computes the elapsed seconds from req start, and emits
 * one labelled histogram + counter observation.
 *
 * Label posture:
 *   - method: uppercased HTTP method ('GET', 'POST', ...).
 *   - route:  `req.route?.path` (Express template, e.g.
 *     '/admin/users/:id') when a handler matched, else 'unmatched'
 *     for 404s. Using raw req.path would blow up Prometheus
 *     cardinality when attackers probe random URLs.
 *   - status_code: string form of `res.statusCode` at finish time.
 *
 * Cost: one Date.now diff + two .observe/.inc calls per request.
 * Prom-client stores histograms as in-memory counters; no I/O.
 */
export function metricsMiddleware() {
  return function httpMetrics(req: Request, res: Response, next: NextFunction): void {
    const startNs = process.hrtime.bigint();
    res.on('finish', () => {
      const elapsedSec = Number(process.hrtime.bigint() - startNs) / 1e9;
      // req.route is populated only when a handler matched. For
      // unmatched requests (404s) fall back to a sentinel so we
      // don't create a label value per raw URL.
      const route = req.route?.path ?? 'unmatched';
      const labels = {
        method: req.method,
        route,
        status_code: String(res.statusCode),
      };
      httpRequestDurationSeconds.observe(labels, elapsedSec);
      httpRequestsTotal.inc(labels);
    });
    next();
  };
}
