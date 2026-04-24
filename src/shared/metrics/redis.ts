import { redis } from '../../config/redis.js';
import { redisConnectionState } from './registry.js';

/**
 * Redis connection health gauge. ioredis tracks connection state as
 * a string: 'wait' | 'reconnecting' | 'connecting' | 'connect' |
 * 'ready' | 'close' | 'end'. Only 'ready' is considered up — the
 * rest indicate either pre-handshake or broken connections.
 *
 * Called on each scrape. No I/O — reads the local ioredis status
 * field synchronously.
 */
export function collectRedisGauges(): void {
  redisConnectionState.set(redis.status === 'ready' ? 1 : 0);
}
