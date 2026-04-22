import type Redis from 'ioredis';

/**
 * OTP lockout + failure-count store.
 *
 * Two pieces of state per phone:
 *  - lockout flag (present => locked). Ambiguity #3: per-phone,
 *    30-min TTL, blocks both send and verify.
 *  - rolling fail counter. Increments on every failed verify.
 *    Hitting the trigger threshold sets the lockout flag.
 *    Successful verify clears the counter.
 *
 * The Redis implementation (prod) and the in-memory implementation
 * (tests) live in this file so they stay in lockstep when we evolve
 * the contract.
 */
export interface LockoutStore {
  isLocked(phone: string): Promise<boolean>;
  lock(phone: string, ttlSec: number): Promise<void>;
  /** Increment counter, return new value, apply/refresh window TTL. */
  incrementFails(phone: string, windowSec: number): Promise<number>;
  /** Clear counter after a successful verify. Idempotent. */
  clearFails(phone: string): Promise<void>;
}

const lockoutKey = (phone: string): string => `otp:lockout:${phone}`;
const failKey = (phone: string): string => `otp:fail:${phone}`;

export class RedisLockoutStore implements LockoutStore {
  constructor(private readonly redis: Redis) {}

  async isLocked(phone: string): Promise<boolean> {
    const v = await this.redis.get(lockoutKey(phone));
    return v !== null;
  }

  async lock(phone: string, ttlSec: number): Promise<void> {
    await this.redis.set(lockoutKey(phone), '1', 'EX', ttlSec);
  }

  async incrementFails(phone: string, windowSec: number): Promise<number> {
    const key = failKey(phone);
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, windowSec);
    return count;
  }

  async clearFails(phone: string): Promise<void> {
    await this.redis.del(failKey(phone));
  }
}

/**
 * Test-only implementation. Uses Date.now() for TTL evaluation so
 * `vi.useFakeTimers()` + `vi.advanceTimersByTime` can exercise expiry
 * deterministically.
 */
export class InMemoryLockoutStore implements LockoutStore {
  private readonly locks = new Map<string, number>(); // phone -> expiresAtMs
  private readonly fails = new Map<string, { count: number; expiresAtMs: number }>();

  async isLocked(phone: string): Promise<boolean> {
    const until = this.locks.get(phone);
    if (until === undefined) return false;
    if (until <= Date.now()) {
      this.locks.delete(phone);
      return false;
    }
    return true;
  }

  async lock(phone: string, ttlSec: number): Promise<void> {
    this.locks.set(phone, Date.now() + ttlSec * 1000);
  }

  async incrementFails(phone: string, windowSec: number): Promise<number> {
    const existing = this.fails.get(phone);
    const now = Date.now();
    if (existing && existing.expiresAtMs > now) {
      existing.count += 1;
      return existing.count;
    }
    this.fails.set(phone, { count: 1, expiresAtMs: now + windowSec * 1000 });
    return 1;
  }

  async clearFails(phone: string): Promise<void> {
    this.fails.delete(phone);
  }
}
