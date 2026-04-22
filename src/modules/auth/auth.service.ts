import { randomUUID } from 'node:crypto';
import mongoose, { type ClientSession, type Types } from 'mongoose';
import { logger } from '../../config/logger.js';
import {
  ConflictError,
  ForbiddenError,
  InternalError,
  UnauthorizedError,
} from '../../shared/errors/AppError.js';
import {
  ACCESS_TTL_SEC,
  REFRESH_TTL_SEC,
  hashRefreshToken,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../../shared/jwt/signer.js';
import type { UserAttrs } from '../../shared/models/User.model.js';
import { CoinTransactionRepository } from '../../shared/repositories/CoinTransaction.repository.js';
import { DeviceFingerprintRepository } from '../../shared/repositories/DeviceFingerprint.repository.js';
import { isDuplicateKeyError } from '../../shared/repositories/_base.repository.js';
import { LoginSessionRepository } from '../../shared/repositories/LoginSession.repository.js';
import { UserRepository } from '../../shared/repositories/User.repository.js';
import { ageInYearsIst } from '../../shared/utils/date.js';
import { generateReferralCode } from '../../shared/utils/referralCode.js';
import type { OtpService } from './otp.types.js';

// ---- Public DTOs ----

export interface AuthTokens {
  access: string;
  refresh: string;
  accessExpiresIn: number;
}

export interface AuthedUserDto {
  id: string;
  phone: string;
  tier: 'PUBLIC' | 'PRO' | 'PRO_MAX';
  coinBalance: number;
  displayName: string | undefined;
}

export interface RequestOtpResult {
  requestedAt: Date;
  resendAllowedAt: Date;
}

// ---- DI bag ----

export interface AuthServiceDeps {
  otpService: OtpService;
  userRepo?: UserRepository;
  sessionRepo?: LoginSessionRepository;
  coinTxRepo?: CoinTransactionRepository;
  deviceRepo?: DeviceFingerprintRepository;
}

// ---- Tunables (would move to app_config in a later phase) ----

const OTP_RESEND_MIN_INTERVAL_MS = 60 * 1000; // 60 s
const SIGNUP_BONUS_COINS = 3;
const REFERRAL_CODE_MAX_RETRIES = 5;
const LINKED_USERS_SUSPICIOUS_THRESHOLD = 3;
const SUSPICIOUS_SCORE_BUMP = 10;

function maskPhone(phone: string): string {
  if (phone.length <= 7) return '****';
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

/**
 * Pull `_id` off a lean Mongoose row.
 *
 * Widened to `unknown` because Mongoose 8's `InferSchemaType` does not
 * attach `_id` to the derived attrs type. All lean reads from the
 * repo carry an ObjectId in practice — cast once here so callers
 * don't sprinkle assertions.
 *
 * TODO(schema-types): Remove this helper after OPEN_DECISIONS #15
 * lands; explicit interfaces will expose `_id: Types.ObjectId` on
 * every *Attrs type and callers can access `row._id` directly.
 */
function leanId(row: unknown): Types.ObjectId {
  if (!row || typeof row !== 'object') {
    throw new InternalError('INVARIANT', 'lean row is not an object');
  }
  const id = (row as { _id?: unknown })._id;
  if (!id) {
    throw new InternalError('INVARIANT', 'lean row missing _id');
  }
  return id as Types.ObjectId;
}

/**
 * Strict shape of what `verifySignupOtp` actually writes into the
 * users collection. We use this instead of `Partial<UserAttrs>` to
 * sidestep InferSchemaType's quirky output for ObjectId refs in
 * Mongoose 8 (which produces a class-metadata shape, not `ObjectId`).
 *
 * TODO(schema-types): Remove this local interface after
 * OPEN_DECISIONS #15 lands. Hand-written `UserAttrs` will accept
 * `Types.ObjectId` for `referredBy` directly.
 */
interface SignupUserInput {
  phone: string;
  dob: Date;
  declaredState: string;
  coinBalance: number;
  totalCoinsEarned: number;
  signupBonusGranted: boolean;
  tier: 'PUBLIC';
  primaryDeviceFingerprint: string;
  lastLoginIp: string;
  lastLoginAt: Date;
  referralCode: string;
  consentVersion: string;
  consentAcceptedAt: Date;
  privacyPolicyVersion: string;
  referredBy?: Types.ObjectId;
}

export class AuthService {
  private readonly otpService: OtpService;
  private readonly userRepo: UserRepository;
  private readonly sessionRepo: LoginSessionRepository;
  private readonly coinTxRepo: CoinTransactionRepository;
  private readonly deviceRepo: DeviceFingerprintRepository;

  constructor(deps: AuthServiceDeps) {
    this.otpService = deps.otpService;
    this.userRepo = deps.userRepo ?? new UserRepository();
    this.sessionRepo = deps.sessionRepo ?? new LoginSessionRepository();
    this.coinTxRepo = deps.coinTxRepo ?? new CoinTransactionRepository();
    this.deviceRepo = deps.deviceRepo ?? new DeviceFingerprintRepository();
  }

  // ---------------------------------------------------------------
  // Signup OTP request
  // ---------------------------------------------------------------

  async requestSignupOtp(input: {
    phone: string;
    deviceId: string;
    deviceFingerprint: string;
    ipAddress: string;
  }): Promise<RequestOtpResult> {
    await this.enforceDeviceNotBlocked(input.deviceFingerprint);

    const requestedAt = new Date();
    const resendAllowedAt = new Date(requestedAt.getTime() + OTP_RESEND_MIN_INTERVAL_MS);

    // Enumeration defence: if phone is already registered, return the
    // same shape without dispatching SMS. Log masked so Ashhu can
    // audit suppression locally.
    const existing = await this.userRepo.findByPhone(input.phone);
    if (existing) {
      logger.info(
        { phoneMasked: maskPhone(input.phone), purpose: 'SIGNUP' },
        'OTP send suppressed: phone already registered',
      );
      return { requestedAt, resendAllowedAt };
    }

    await this.otpService.send({
      phone: input.phone,
      purpose: 'SIGNUP',
      ipAddress: input.ipAddress,
      deviceFingerprint: input.deviceFingerprint,
    });

    return { requestedAt, resendAllowedAt };
  }

  // ---------------------------------------------------------------
  // Signup verify + user create + 3-coin bonus (transactional)
  // ---------------------------------------------------------------

  async verifySignupOtp(input: {
    phone: string;
    otp: string;
    dob: Date;
    declaredState: string;
    referralCode: string | undefined;
    consentVersion: string;
    consentAcceptedAt: Date;
    privacyPolicyVersion: string;
    deviceId: string;
    deviceFingerprint: string;
    ipAddress: string;
    userAgent: string;
  }): Promise<{ user: AuthedUserDto; tokens: AuthTokens }> {
    // 18+ gate (IST).
    if (ageInYearsIst(input.dob) < 18) {
      throw new ForbiddenError('UNDERAGE', 'Must be 18 or older');
    }
    await this.enforceDeviceNotBlocked(input.deviceFingerprint);

    await this.otpService.verify({
      phone: input.phone,
      otp: input.otp,
      purpose: 'SIGNUP',
    });

    // Resolve referrer, track-only (ambiguity #5). Unknown code is silent.
    let referredBy: Types.ObjectId | undefined;
    if (input.referralCode) {
      const referrer = await this.userRepo.findByReferralCode(input.referralCode);
      if (referrer) referredBy = leanId(referrer);
    }

    const referralCode = await this.pickUniqueReferralCode();

    const mongoSession = await mongoose.startSession();
    try {
      const result = await mongoSession.withTransaction(async () =>
        this.doSignup(mongoSession, input, referralCode, referredBy),
      );
      if (!result) {
        throw new InternalError('SIGNUP_FAILED', 'signup transaction produced no result');
      }

      // Post-transaction, best-effort: bump suspicious score on heavy
      // multi-account devices. Not in the transaction because this is
      // a fraud signal, not a business invariant.
      await this.maybeBumpSuspicion(input.deviceFingerprint);

      return result;
    } finally {
      await mongoSession.endSession();
    }
  }

  private async doSignup(
    session: ClientSession,
    input: {
      phone: string;
      dob: Date;
      declaredState: string;
      consentVersion: string;
      consentAcceptedAt: Date;
      privacyPolicyVersion: string;
      deviceId: string;
      deviceFingerprint: string;
      ipAddress: string;
      userAgent: string;
    },
    referralCode: string,
    referredBy: Types.ObjectId | undefined,
  ): Promise<{ user: AuthedUserDto; tokens: AuthTokens }> {
    // 1. Create user with signup bonus applied atomically.
    const userData: SignupUserInput = {
      phone: input.phone,
      dob: input.dob,
      declaredState: input.declaredState,
      coinBalance: SIGNUP_BONUS_COINS,
      totalCoinsEarned: SIGNUP_BONUS_COINS,
      signupBonusGranted: true,
      tier: 'PUBLIC',
      primaryDeviceFingerprint: input.deviceFingerprint,
      lastLoginIp: input.ipAddress,
      lastLoginAt: new Date(),
      referralCode,
      consentVersion: input.consentVersion,
      consentAcceptedAt: input.consentAcceptedAt,
      privacyPolicyVersion: input.privacyPolicyVersion,
    };
    if (referredBy) userData.referredBy = referredBy;

    let userDoc;
    try {
      // TODO(schema-types): remove `as unknown as Partial<UserAttrs>` after #15.
      userDoc = await this.userRepo.create(userData as unknown as Partial<UserAttrs>, { session });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw new ConflictError('PHONE_ALREADY_REGISTERED', 'This phone is already registered');
      }
      throw err;
    }

    const userId = leanId(userDoc);

    // 2. Corresponding coin_transactions SIGNUP_BONUS row.
    // TODO(schema-types): remove cast after #15 (CoinTransactionAttrs
    // will accept Types.ObjectId for userId + reference.id directly).
    await this.coinTxRepo.create(
      {
        userId,
        type: 'SIGNUP_BONUS',
        amount: SIGNUP_BONUS_COINS,
        balanceAfter: SIGNUP_BONUS_COINS,
        reference: { kind: 'System' },
        note: 'signup bonus',
      } as unknown as Partial<Parameters<typeof this.coinTxRepo.create>[0]>,
      { session },
    );

    // 3. Upsert device fingerprint + link new user.
    await this.deviceRepo.upsertAndLinkUser(input.deviceFingerprint, userId, {
      session,
    });

    // 4. Issue tokens + login session.
    const tokens = await this.issueTokensAndSession(
      {
        userId,
        tier: 'PUBLIC',
        deviceId: input.deviceId,
        deviceFingerprint: input.deviceFingerprint,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      },
      session,
    );

    return {
      user: {
        id: String(userId),
        phone: input.phone,
        tier: 'PUBLIC',
        coinBalance: SIGNUP_BONUS_COINS,
        displayName: undefined,
      },
      tokens,
    };
  }

  // ---------------------------------------------------------------
  // Login OTP request
  // ---------------------------------------------------------------

  async requestLoginOtp(input: { phone: string; ipAddress: string }): Promise<RequestOtpResult> {
    const requestedAt = new Date();
    const resendAllowedAt = new Date(requestedAt.getTime() + OTP_RESEND_MIN_INTERVAL_MS);

    const user = await this.userRepo.findByPhone(input.phone);
    if (!user) {
      logger.info(
        { phoneMasked: maskPhone(input.phone), purpose: 'LOGIN' },
        'OTP send suppressed: phone not registered',
      );
      return { requestedAt, resendAllowedAt };
    }
    if (user.blocked?.isBlocked) {
      logger.info(
        { phoneMasked: maskPhone(input.phone), purpose: 'LOGIN' },
        'OTP send suppressed: user blocked',
      );
      return { requestedAt, resendAllowedAt };
    }

    await this.otpService.send({
      phone: input.phone,
      purpose: 'LOGIN',
      ipAddress: input.ipAddress,
      deviceFingerprint: null,
    });

    return { requestedAt, resendAllowedAt };
  }

  // ---------------------------------------------------------------
  // Login verify
  // ---------------------------------------------------------------

  async verifyLoginOtp(input: {
    phone: string;
    otp: string;
    deviceId: string;
    deviceFingerprint: string;
    ipAddress: string;
    userAgent: string;
  }): Promise<{ user: AuthedUserDto; tokens: AuthTokens }> {
    await this.otpService.verify({
      phone: input.phone,
      otp: input.otp,
      purpose: 'LOGIN',
    });

    const user = await this.userRepo.findByPhone(input.phone);
    if (!user) {
      // Reachable only if user was deleted between OTP send and verify.
      // Surface as UNAUTHORIZED to keep the error generic.
      throw new UnauthorizedError('Invalid credentials');
    }
    if (user.blocked?.isBlocked) {
      throw new ForbiddenError('USER_BLOCKED', 'Account is blocked');
    }
    const userTier = user.tier;
    if (userTier !== 'PUBLIC' && userTier !== 'PRO' && userTier !== 'PRO_MAX') {
      throw new InternalError('INVARIANT', 'user has invalid tier');
    }

    const userId = leanId(user);
    const tokens = await this.issueTokensAndSession({
      userId,
      tier: userTier,
      deviceId: input.deviceId,
      deviceFingerprint: input.deviceFingerprint,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });

    // Update last-login markers (not in a transaction — non-critical).
    await this.userRepo.updateOne(
      { _id: userId },
      { $set: { lastLoginIp: input.ipAddress, lastLoginAt: new Date() } },
    );

    return {
      user: {
        id: String(userId),
        phone: user.phone,
        tier: userTier,
        coinBalance: user.coinBalance ?? 0,
        displayName: user.displayName ?? undefined,
      },
      tokens,
    };
  }

  // ---------------------------------------------------------------
  // Refresh: device-bound rotation with reuse detection
  // ---------------------------------------------------------------

  async refresh(input: {
    refreshToken: string;
    deviceId: string;
    ipAddress: string;
    userAgent: string;
  }): Promise<AuthTokens> {
    // Step 1-2: parse + signature + expiry verified in one call.
    let claims;
    try {
      claims = await verifyRefreshToken(input.refreshToken);
    } catch {
      throw new UnauthorizedError('Invalid or expired refresh token');
    }

    // Step 3: active-session lookup.
    const hash = hashRefreshToken(input.refreshToken);
    const session = await this.sessionRepo.findActiveByRefreshHash(hash);

    // Step 4: branch.
    if (!session) {
      // Case C/D: no active session with this hash.
      const familyHasAny = await this.sessionRepo.exists({ family: claims.family });
      if (familyHasAny) {
        // Case C: reuse detected. Revoke entire family.
        await this.sessionRepo.revokeFamily(claims.family);
        logger.warn(
          { userId: claims.sub, family: claims.family },
          'refresh token reuse detected — family revoked',
        );
      }
      // Case D: no sessions in family either. Just 401.
      throw new UnauthorizedError('Invalid or expired refresh token');
    }

    const sessionFamily = session.family;
    if (!sessionFamily) {
      throw new InternalError('INVARIANT', 'active session has no family');
    }
    const sessionJti = session.jti;
    if (!sessionJti) {
      throw new InternalError('INVARIANT', 'active session has no jti');
    }

    if (session.deviceId !== input.deviceId) {
      // Case B: device mismatch on a valid refresh. Family revoke.
      await this.sessionRepo.revokeFamily(sessionFamily);
      logger.warn(
        { userId: claims.sub, family: sessionFamily },
        'refresh device mismatch — family revoked',
      );
      throw new ForbiddenError('DEVICE_MISMATCH', 'Token does not match device');
    }

    // Case A: normal rotation. Fetch user for current tier + block state.
    const user = await this.userRepo.findById(claims.sub);
    if (!user) throw new UnauthorizedError('User not found');
    if (user.blocked?.isBlocked) {
      throw new ForbiddenError('USER_BLOCKED', 'Account is blocked');
    }
    const userTier = user.tier;
    if (userTier !== 'PUBLIC' && userTier !== 'PRO' && userTier !== 'PRO_MAX') {
      throw new InternalError('INVARIANT', 'user has invalid tier');
    }

    const userId = leanId(user);
    const mongoSession = await mongoose.startSession();
    /**
     * Concurrency note: when two refreshes race with the same token,
     * exactly one wins the atomic revoke below (modifiedCount === 1).
     * The loser sees modifiedCount === 0 and signals a race via the
     * `raceDetected` flag. The race-loser's family-wide revoke MUST
     * run *outside* its transaction — otherwise the transaction
     * aborts and the revoke rolls back with it, leaving the winner's
     * fresh session alive. See Case C in SECURITY.md §1 and the
     * refresh state-machine sign-off.
     */
    let raceDetected = false;
    try {
      const tokens = await mongoSession.withTransaction(async () => {
        const revokeResult = await this.sessionRepo.updateOne(
          { jti: sessionJti, revokedAt: { $exists: false } },
          { $set: { revokedAt: new Date() } },
          { session: mongoSession },
        );
        if (revokeResult.modifiedCount !== 1) {
          raceDetected = true;
          return null;
        }

        const rotatedInput: {
          userId: Types.ObjectId;
          tier: 'PUBLIC' | 'PRO' | 'PRO_MAX';
          deviceId: string;
          deviceFingerprint: string | null;
          ipAddress: string;
          userAgent: string;
          family?: string;
        } = {
          userId,
          tier: userTier,
          deviceId: session.deviceId ?? input.deviceId,
          deviceFingerprint: session.deviceFingerprint ?? null,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
          family: sessionFamily,
        };
        return this.issueTokensAndSession(rotatedInput, mongoSession);
      });

      if (raceDetected) {
        // Family revoke runs outside the aborted-or-noop transaction
        // so it actually persists. Invalidates the winner's fresh
        // session too — strict reuse-detection posture.
        await this.sessionRepo.revokeFamily(sessionFamily);
        logger.warn(
          { userId: claims.sub, family: sessionFamily },
          'concurrent refresh rotation detected — family revoked',
        );
        throw new UnauthorizedError('Invalid or expired refresh token');
      }
      if (!tokens) {
        throw new InternalError('REFRESH_FAILED', 'refresh transaction produced no result');
      }
      return tokens;
    } finally {
      await mongoSession.endSession();
    }
  }

  // ---------------------------------------------------------------
  // Logout (single session)
  // ---------------------------------------------------------------

  async logout(input: { refreshToken: string; userId: string }): Promise<void> {
    const hash = hashRefreshToken(input.refreshToken);
    await this.sessionRepo.updateOne(
      { refreshTokenHash: hash, userId: input.userId },
      { $set: { revokedAt: new Date() } },
    );
    // No error if not found — idempotent logout.
  }

  // ---------------------------------------------------------------
  // Logout-all (every session for user)
  // ---------------------------------------------------------------

  async logoutAll(input: { userId: string }): Promise<{ revokedCount: number }> {
    const result = await this.sessionRepo.updateMany(
      { userId: input.userId, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date() } },
    );
    return { revokedCount: result.modifiedCount };
  }

  // ---------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------

  private async enforceDeviceNotBlocked(fingerprint: string): Promise<void> {
    const device = await this.deviceRepo.findByFingerprint(fingerprint);
    if (!device) return;
    if (device.blocked) {
      throw new ForbiddenError('DEVICE_BLOCKED', 'Device is blocked');
    }
    const links = device.linkedUserIds ?? [];
    if (links.length === 0) return;

    // Any linked user blocked? If yes, propagate block to new signup.
    // TODO(schema-types): remove `(links as unknown[])` + `String(id)`
    // after #15. `linkedUserIds` will be typed `Types.ObjectId[]`.
    const linkedIds = (links as unknown[]).map((id) => String(id));
    const linkedUsers = await Promise.all(linkedIds.map((id) => this.userRepo.findById(id)));
    if (linkedUsers.some((u) => u?.blocked?.isBlocked)) {
      throw new ForbiddenError('DEVICE_BLOCKED', 'Device is linked to a blocked account');
    }
  }

  private async pickUniqueReferralCode(): Promise<string> {
    for (let attempt = 0; attempt < REFERRAL_CODE_MAX_RETRIES; attempt++) {
      const candidate = generateReferralCode();
      const existing = await this.userRepo.findByReferralCode(candidate);
      if (!existing) return candidate;
    }
    throw new InternalError(
      'REFERRAL_CODE_EXHAUSTED',
      'Could not mint a unique referralCode after retries',
    );
  }

  private async issueTokensAndSession(
    input: {
      userId: Types.ObjectId;
      tier: 'PUBLIC' | 'PRO' | 'PRO_MAX';
      deviceId: string;
      deviceFingerprint: string | null;
      ipAddress: string;
      userAgent: string;
      family?: string;
    },
    session?: ClientSession,
  ): Promise<AuthTokens> {
    const jti = randomUUID();
    const family = input.family ?? randomUUID();
    const sub = String(input.userId);

    const access = await signAccessToken({ sub, tier: input.tier, jti });
    const refresh = await signRefreshToken({ sub, jti, family });

    const sessionData: Record<string, unknown> = {
      userId: input.userId,
      jti,
      deviceId: input.deviceId,
      userAgent: input.userAgent,
      ip: input.ipAddress,
      refreshTokenHash: hashRefreshToken(refresh),
      family,
      expiresAt: new Date(Date.now() + REFRESH_TTL_SEC * 1000),
    };
    if (input.deviceFingerprint) {
      sessionData['deviceFingerprint'] = input.deviceFingerprint;
    }

    const writeOpts = session ? { session } : {};
    // TODO(schema-types): remove eslint-disable + `as any` after #15.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await this.sessionRepo.create(sessionData as any, writeOpts);

    return { access, refresh, accessExpiresIn: ACCESS_TTL_SEC };
  }

  private async maybeBumpSuspicion(fingerprint: string): Promise<void> {
    const device = await this.deviceRepo.findByFingerprint(fingerprint);
    const linkCount = device?.linkedUserIds?.length ?? 0;
    if (linkCount > LINKED_USERS_SUSPICIOUS_THRESHOLD) {
      await this.deviceRepo.incrementSuspiciousScore(fingerprint, SUSPICIOUS_SCORE_BUMP);
      logger.warn(
        { fingerprint, linkCount },
        'device linked to more than threshold users — suspicious score bumped',
      );
    }
  }
}
