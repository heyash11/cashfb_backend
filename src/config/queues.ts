import { Queue, Worker, type ConnectionOptions, type Processor, type WorkerOptions } from 'bullmq';
import { env } from './env.js';
import { logger } from './logger.js';

/**
 * BullMQ requires connection options (host / port / password) rather
 * than the `ioredis` client the rest of the app uses. Parsing
 * REDIS_URL twice is the cleanest path — zero coupling between
 * Bull's internal blocking-read connection and the rate-limit
 * middleware's shared client.
 *
 * `maxRetriesPerRequest: null` + `enableReadyCheck: false` are the
 * BullMQ-recommended flags (https://docs.bullmq.io/guide/connections).
 */
function parseRedisConnection(): ConnectionOptions {
  const url = new URL(env.REDIS_URL);
  const opts: ConnectionOptions = {
    host: url.hostname,
    port: Number(url.port || 6379),
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
  if (url.password) opts.password = decodeURIComponent(url.password);
  if (url.username) opts.username = decodeURIComponent(url.username);
  if (url.pathname && url.pathname !== '/') {
    const db = Number(url.pathname.slice(1));
    if (Number.isFinite(db)) opts.db = db;
  }
  return opts;
}

export const bullConnection: ConnectionOptions = parseRedisConnection();

/**
 * LAZY Queue registry. First call for a given name instantiates +
 * caches; subsequent calls return the same instance. Tests that
 * never touch queues don't open Redis handles — import cost is
 * effectively zero.
 *
 * Contract: Chunk 1 sign-off picked this over eager construction
 * per the "most specs don't enqueue" argument.
 */
const queueRegistry = new Map<string, Queue>();

export function getQueue<T = unknown>(name: string): Queue<T> {
  let q = queueRegistry.get(name) as Queue<T> | undefined;
  if (!q) {
    q = new Queue<T>(name, { connection: bullConnection });
    q.on('error', (err: Error) => {
      logger.error({ err, queue: name }, '[bullmq] queue error');
    });
    queueRegistry.set(name, q as Queue);
  }
  return q;
}

export async function closeAllQueues(): Promise<void> {
  for (const q of queueRegistry.values()) {
    await q.close();
  }
  queueRegistry.clear();
}

/**
 * Worker factory with defaults. Prod worker.ts uses this; tests
 * never instantiate a real Worker — they call the handler function
 * directly with a POJO job payload.
 */
export function makeWorker<T, R>(
  queueName: string,
  processor: Processor<T, R>,
  opts: Partial<WorkerOptions> & { concurrency?: number } = {},
): Worker<T, R> {
  return new Worker<T, R>(queueName, processor, {
    connection: bullConnection,
    concurrency: opts.concurrency ?? env.WORKER_CONCURRENCY,
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
    ...opts,
  });
}
