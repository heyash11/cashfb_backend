import { createHash, randomBytes, randomInt } from 'node:crypto';
import { ConflictError, UnauthorizedError } from '../../shared/errors/AppError.js';
import type { OtpVerificationAttrs } from '../../shared/models/OtpVerification.model.js';
import { OtpVerificationRepository } from '../../shared/repositories/OtpVerification.repository.js';
import type { LockoutStore } from './lockout.store.js';
import type { OtpSendInput, OtpSender, OtpService, OtpVerifyInput } from './otp.types.js';

// ---- Tunables (SECURITY.md §1 + ambiguity #2 / #3 resolutions) ----

const OTP_LENGTH = 6;
const OTP_TTL_SEC = 5 * 60;
const HASH_SALT_BYTES = 16;
const MAX_ATTEMPTS = 5;

/** 3 failed verifies → lock. 30-minute lockout window. */
const LOCKOUT_TRIGGER_FAILS = 3;
const LOCKOUT_WINDOW_SEC = 30 * 60;

export interface OtpServiceImplDeps {
  sender: OtpSender;
  lockoutStore: LockoutStore;
  repo?: OtpVerificationRepository;
}

function hashOtp(otp: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${otp}`).digest('hex');
}

function generateOtp(): string {
  // [100000, 999999] — 6 digits, uniform.
  return String(randomInt(10 ** (OTP_LENGTH - 1), 10 ** OTP_LENGTH));
}

/**
 * Concrete OtpService wiring the `otp_verifications` row lifecycle
 * to a pluggable SMS sender and the lockout store.
 *
 * Lockout semantics (docs/SECURITY.md §1 + ambiguity #3):
 *   - OTP_LOCKED is raised on both `send` and `verify` when the
 *     phone's lockout flag is set in the store.
 *   - The flag is set after LOCKOUT_TRIGGER_FAILS failed verifies in
 *     the rolling LOCKOUT_WINDOW_SEC window.
 *   - A successful verify clears the fail counter.
 *
 * Per-row attempt cap (ambiguity #2): every verify increments
 * `attempts`; a row is dead when `attempts >= maxAttempts` OR
 * `consumedAt` is set. Success sets `consumedAt`.
 */
export class OtpServiceImpl implements OtpService {
  private readonly sender: OtpSender;
  private readonly lockoutStore: LockoutStore;
  private readonly repo: OtpVerificationRepository;

  constructor(deps: OtpServiceImplDeps) {
    this.sender = deps.sender;
    this.lockoutStore = deps.lockoutStore;
    this.repo = deps.repo ?? new OtpVerificationRepository();
  }

  async send(input: OtpSendInput): Promise<void> {
    if (await this.lockoutStore.isLocked(input.phone)) {
      throw new ConflictError(
        'OTP_LOCKED',
        'Phone is locked after too many failed attempts. Try again later.',
      );
    }

    const otp = generateOtp();
    const salt = randomBytes(HASH_SALT_BYTES).toString('hex');
    const otpHash = hashOtp(otp, salt);

    const row: Partial<OtpVerificationAttrs> = {
      channel: 'SMS',
      destination: input.phone,
      otpHash,
      salt,
      attempts: 0,
      maxAttempts: MAX_ATTEMPTS,
      purpose: input.purpose,
      ipAddress: input.ipAddress,
      expiresAt: new Date(Date.now() + OTP_TTL_SEC * 1000),
    };
    if (input.deviceFingerprint) row.deviceFingerprint = input.deviceFingerprint;
    await this.repo.create(row);

    await this.sender.send(input.phone, otp, input.purpose);
  }

  async verify(input: OtpVerifyInput): Promise<void> {
    if (await this.lockoutStore.isLocked(input.phone)) {
      throw new ConflictError(
        'OTP_LOCKED',
        'Phone is locked after too many failed attempts. Try again later.',
      );
    }

    const row = await this.repo.findActive(input.phone);
    if (!row) {
      // No active OTP for this phone. Still count as a failed verify
      // so we can lock out phone-enumeration / replay probes.
      await this.recordFailAndMaybeLock(input.phone);
      throw new UnauthorizedError('Invalid OTP');
    }

    const attempts = row.attempts ?? 0;
    const max = row.maxAttempts ?? MAX_ATTEMPTS;
    if (attempts >= max) {
      // Per-row cap hit. The row is dead and will not become active
      // again (consumedAt unset but findActive filters on !expired).
      await this.recordFailAndMaybeLock(input.phone);
      throw new UnauthorizedError('Invalid OTP');
    }

    const salt = row.salt ?? '';
    const expectedHash = row.otpHash;
    if (!expectedHash) {
      throw new UnauthorizedError('Invalid OTP');
    }

    const provided = hashOtp(input.otp, salt);
    if (provided !== expectedHash) {
      await this.repo.updateOne({ _id: row._id }, { $inc: { attempts: 1 } });
      await this.recordFailAndMaybeLock(input.phone);
      throw new UnauthorizedError('Invalid OTP');
    }

    // Success: flip consumedAt, clear phone-level fail counter.
    await this.repo.updateOne({ _id: row._id }, { $set: { consumedAt: new Date() } });
    await this.lockoutStore.clearFails(input.phone);
  }

  private async recordFailAndMaybeLock(phone: string): Promise<void> {
    const fails = await this.lockoutStore.incrementFails(phone, LOCKOUT_WINDOW_SEC);
    if (fails >= LOCKOUT_TRIGGER_FAILS) {
      await this.lockoutStore.lock(phone, LOCKOUT_WINDOW_SEC);
      throw new ConflictError(
        'OTP_LOCKED',
        `Phone locked for ${LOCKOUT_WINDOW_SEC / 60} minutes after ${LOCKOUT_TRIGGER_FAILS} failed attempts.`,
      );
    }
  }
}
