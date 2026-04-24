import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Shared Prometheus registry. Every metric in the app registers
 * here so `/metrics` can render them in one pass. Default Node
 * runtime metrics (process CPU, event-loop lag, GC, memory,
 * nodejs_heap_size_*) are auto-collected by prom-client itself.
 *
 * One module-level registry is the library convention; we don't
 * create per-feature registries. If a test spec needs isolation it
 * should call `registry.clear()` + re-register.
 */
export const registry = new Registry();

collectDefaultMetrics({ register: registry });

// ---------- HTTP server ----------

/**
 * Latency histogram keyed by method / route / status_code. Route
 * label is req.route?.path (Express matched path template) with a
 * fallback to 'unmatched' so 404s don't produce label explosion
 * across every raw URL an attacker hits.
 *
 * Buckets chosen to cover the p50..p99 band of a typical
 * Node+Mongo+Redis path: 5ms to 10s. If real traffic shows a dense
 * tail past 10s, revisit.
 */
export const httpRequestDurationSeconds = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency in seconds, labelled by method, route, status_code',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests served, labelled by method, route, status_code',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [registry],
});

// ---------- BullMQ ----------

/**
 * One gauge, four label values per queue (waiting / active /
 * delayed / failed). Prometheus prefers zero explicitly emitted to
 * missing — the poller `.set(0)` on empty states so scrapers can
 * rate() against a baseline.
 */
export const bullmqQueueDepth = new Gauge({
  name: 'bullmq_queue_depth',
  help: 'BullMQ queue depth by state, polled every 15s from the api process',
  labelNames: ['queue', 'state'] as const,
  registers: [registry],
});

// ---------- Mongo ----------

export const mongoConnectionReady = new Gauge({
  name: 'mongo_connection_ready',
  help: '1 if mongoose.connection.readyState === 1 (connected), 0 otherwise',
  registers: [registry],
});

export const mongoConnectionPoolSize = new Gauge({
  name: 'mongo_connection_pool_size',
  help: 'Configured max pool size for the active mongoose connection',
  registers: [registry],
});

// ---------- Redis ----------

export const redisConnectionState = new Gauge({
  name: 'redis_connection_state',
  help: '1 if ioredis status === "ready", 0 otherwise',
  registers: [registry],
});

// ---------- Admin sessions ----------

export const adminSessionCount = new Gauge({
  name: 'admin_session_count',
  help: 'Active admin sessions (SCAN-counted from Redis)',
  registers: [registry],
});
