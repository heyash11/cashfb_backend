import { describe, expect, it } from 'vitest';
import {
  adminSessionCount,
  bullmqQueueDepth,
  httpRequestDurationSeconds,
  httpRequestsTotal,
  mongoConnectionPoolSize,
  mongoConnectionReady,
  redisConnectionState,
  registry,
} from './registry.js';

/**
 * Phase 9 Chunk 3 — unit coverage for the shared Prometheus
 * registry. We're verifying three things:
 *   1. every named metric is registered against the shared
 *      registry (not a per-metric anonymous one)
 *   2. `registry.metrics()` renders Prometheus exposition text
 *      with the expected names
 *   3. the default Node runtime metrics are bundled in too (so
 *      ops dashboards don't have to chase two endpoints)
 */
describe('metrics registry', () => {
  it('renders Prometheus text with every named metric + default Node metrics', async () => {
    // Exercise each metric once so series show up (a Histogram
    // with no observations still renders its _bucket rows, but
    // counter/gauge series only appear after the first write).
    httpRequestDurationSeconds.observe({ method: 'GET', route: '/x', status_code: '200' }, 0.01);
    httpRequestsTotal.inc({ method: 'GET', route: '/x', status_code: '200' });
    bullmqQueueDepth.set({ queue: 'cron', state: 'waiting' }, 0);
    mongoConnectionReady.set(1);
    mongoConnectionPoolSize.set(10);
    redisConnectionState.set(1);
    adminSessionCount.set(0);

    const text = await registry.metrics();
    for (const name of [
      'http_request_duration_seconds',
      'http_requests_total',
      'bullmq_queue_depth',
      'mongo_connection_ready',
      'mongo_connection_pool_size',
      'redis_connection_state',
      'admin_session_count',
      // prom-client defaults
      'process_cpu_user_seconds_total',
      'nodejs_heap_size_total_bytes',
    ]) {
      expect(text).toContain(name);
    }
  });

  it('httpRequestDurationSeconds uses the label set {method, route, status_code}', async () => {
    httpRequestDurationSeconds.observe({ method: 'POST', route: '/test', status_code: '201' }, 0.1);
    const text = await registry.metrics();
    expect(text).toMatch(/http_request_duration_seconds_bucket\{[^}]*method="POST"/);
    expect(text).toMatch(/http_request_duration_seconds_bucket\{[^}]*route="\/test"/);
    expect(text).toMatch(/http_request_duration_seconds_bucket\{[^}]*status_code="201"/);
  });
});
