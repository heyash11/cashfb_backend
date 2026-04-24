import mongoose from 'mongoose';
import { mongoConnectionPoolSize, mongoConnectionReady } from './registry.js';

/**
 * Mongo connection metrics. Called from the `/metrics` route on
 * each scrape (cheap — no Mongo I/O, reads from mongoose internals).
 *
 * Semantics:
 *   - mongo_connection_ready: 1 when readyState === 1 (connected),
 *     0 for any other state (disconnected/connecting/disconnecting).
 *   - mongo_connection_pool_size: the configured `maxPoolSize` on
 *     the active connection. Static post-boot but useful for
 *     correlating request queuing against config.
 *
 * No attempt to count in-use / available pool connections here —
 * mongoose doesn't expose those directly and the node-mongodb
 * driver's monitoring events require a separate subscription. If
 * pool-saturation visibility becomes load-bearing, upgrade to
 * driver PoolMonitoring events in a follow-up.
 */
export function collectMongoGauges(): void {
  const conn = mongoose.connection;
  mongoConnectionReady.set(conn.readyState === 1 ? 1 : 0);
  // `getClient()` throws if the client has never connected. Guard.
  try {
    const maxPoolSize = conn.getClient().options.maxPoolSize ?? 0;
    mongoConnectionPoolSize.set(maxPoolSize);
  } catch {
    mongoConnectionPoolSize.set(0);
  }
}
