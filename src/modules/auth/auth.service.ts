import { randomUUID } from 'node:crypto';
import mongoose, { type ClientSession, type Types } from 'mongoose';
import { env } from '../../config/env.js';
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
import type { LoginSessionAttrs } from '../../shared/models/LoginSession.model.js';
import type { UserAttrs } from '../../shared/models/User.model.js';
import { CoinTransactionRepository } from '../../shared/repositories/CoinTransaction.repository.js';
import { DeviceFingerprintRepository } from '../../shared/repositories/DeviceFingerprint.repository.js';
import { isDuplicateKeyError } from '../../shared/repositories/_base.repository.js';
import { LoginSessionRepository } from '../../shared/repositories/LoginSession.repository.js';
import { UserRepository } from '../../shared/repositories/User.repository.js';
import { ForceLogoutStore } from '../../shared/services/force-logout.js';
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
  forceLogoutStore?: ForceLogoutStore;
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
 * Phase 9 Chunk 5 — load-test OTP bypass predicate. Triply-gated:
 *   - NODE_ENV strictly 'development'
 *   - phone matches the reserved load-test prefix
 *     (/^\+919999990\d{3}$/ → `+919999990000` to `+919999990999`)
 *   - caller opted in with `_devBypassOtp === true`
 *
 * Any one failing returns false → caller runs the normal OTP verify.
 * Exported for unit tests; not part of the service class so the
 * behaviour is a pure function of its inputs (env included).
 *
 * Prefix rationale: the spec used `+919999LOAD0001` as the shape,
 * but IndianPhoneSchema strips non-digits before matching — letters
 * in the phone would silently reshape to a real-looking number. A
 * pure-digit reserved prefix preserves the spirit (clearly distinct
 * from real Indian mobiles, fixed range for all 100 test users) and
 * survives the schema transformer unchanged.
 *
 * Security posture: exists specifically so load tests (load/) can
 * sign up 100 synthetic users without hitting the OTP path. The
 * NODE_ENV gate ensures production refuses every attempt regardless
 * of phone pattern.
 */
const LOAD_TEST_PHONE_PATTERN = /^\+919999990\d{3}$/;
export function shouldBypassSignupOtp(input: { phone: string; _devBypassOtp?: true }): boolean {
  if (env.NODE_ENV !== 'development') return false;
  if (!LOAD_TEST_PHONE_PATTERN.test(input.phone)) return false;
  return input._devBypassOtp === true;
}

export class AuthService {
  private readonly otpService: OtpService;
  private readonly userRepo: UserRepository;
  private readonly sessionRepo: LoginSessionRepository;
  private readonly coinTxRepo: CoinTransactionRepository;
  private readonly deviceRepo: DeviceFingerprintRepository;
  private readonly forceLogoutStore: ForceLogoutStore;

  constructor(deps: AuthServiceDeps) {
    this.otpService = deps.otpService;
    this.userRepo = deps.userRepo ?? new UserRepository();
    this.sessionRepo = deps.sessionRepo ?? new LoginSessionRepository();
    this.coinTxRepo = deps.coinTxRepo ?? new CoinTransactionRepository();
    this.deviceRepo = deps.deviceRepo ?? new DeviceFingerprintRepository();
    this.forceLogoutStore = deps.forceLogoutStore ?? new ForceLogoutStore();
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
    /**
     * Phase 9 Chunk 5 — load-test OTP bypass. Triply-gated inside
     * the service: `env.NODE_ENV === 'development'` AND phone
     * matches `^\+919999LOAD` AND this flag is `true`. Any one
     * failing = standard OTP verify. Unit-spec'd in
     * `auth.service.bypass.spec.ts`.
     */
    _devBypassOtp?: true;
  }): Promise<{ user: AuthedUserDto; tokens: AuthTokens }> {
    // 18+ gate (IST).
    if (ageInYearsIst(input.dob) < 18) {
      throw new ForbiddenError('UNDERAGE', 'Must be 18 or older');
    }
    await this.enforceDeviceNotBlocked(input.deviceFingerprint);

    if (shouldBypassSignupOtp(input)) {
      // Skip otpService.verify. All other invariants (18+, device
      // block, transaction, referral, signup bonus) still apply.
      logger.warn(
        { phoneMasked: maskPhone(input.phone) },
        '[auth] dev-mode OTP bypass used for signup (load-test phone pattern)',
      );
    } else {
      await this.otpService.verify({
        phone: input.phone,
        otp: input.otp,
        purpose: 'SIGNUP',
      });
    }

    // Resolve referrer, track-only (ambiguity #5). Unknown code is silent.
    let referredBy: Types.ObjectId | undefined;
    if (input.referralCode) {
      const referrer = await this.userRepo.findByReferralCode(input.referralCode);
      if (referrer) referredBy = referrer._id;
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
    const userData: Partial<UserAttrs> = {
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
      userDoc = await this.userRepo.create(userData, { session });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw new ConflictError('PHONE_ALREADY_REGISTERED', 'This phone is already registered');
      }
      throw err;
    }

    const userId = userDoc._id;

    // 2. Corresponding coin_transactions SIGNUP_BONUS row.
    await this.coinTxRepo.create(
      {
        userId,
        type: 'SIGNUP_BONUS',
        amount: SIGNUP_BONUS_COINS,
        balanceAfter: SIGNUP_BONUS_COINS,
        reference: { kind: 'System' },
        note: 'signup bonus',
      },
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
    if (user.anonymizedAt) {
      // Defensive: the sweep worker hashes the phone at anonymize
      // time so findByPhone(rawPhone) should miss. This branch covers
      // the race where anonymization lands between OTP send and OTP
      // verify. Surface the same generic error as the not-found path.
      throw new UnauthorizedError('Invalid credentials');
    }
    if (user.blocked?.isBlocked) {
      throw new ForbiddenError('USER_BLOCKED', 'Account is blocked');
    }
    const userTier = user.tier;
    if (userTier !== 'PUBLIC' && userTier !== 'PRO' && userTier !== 'PRO_MAX') {
      throw new InternalError('INVARIANT', 'user has invalid tier');
    }

    const userId = user._id;
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

    // Step 2a (Phase 8): force-logout denylist. If the admin forced
    // a logout after this token was issued, revoke the entire family
    // and refuse — a user whose access token just expired must not
    // be able to bounce back on a still-live refresh token after
    // being force-logged-out. Matches the "revoke on reuse" posture:
    // stale-iat is effectively reuse of a dead session.
    const cutoff = await this.forceLogoutStore.getCutoff(claims.sub);
    if (cutoff !== null && claims.iat <= cutoff) {
      await this.sessionRepo.revokeFamily(claims.family);
      logger.warn(
        { userId: claims.sub, family: claims.family, iat: claims.iat, cutoff },
        'refresh after force-logout — family revoked',
      );
      throw new UnauthorizedError('Session forcibly terminated');
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
    if (user.anonymizedAt) {
      // DPDP terminal state. Force-logout denylist (set at erasure
      // request) has the same 30-day TTL as the refresh token, so
      // this branch covers the narrow race where the token-TTL and
      // denylist-TTL both expire before the sweep runs. Revoke the
      // family defensively so any lingering sibling sessions die too.
      await this.sessionRepo.revokeFamily(claims.family);
      throw new UnauthorizedError('Session forcibly terminated');
    }
    if (user.blocked?.isBlocked) {
      throw new ForbiddenError('USER_BLOCKED', 'Account is blocked');
    }
    const userTier = user.tier;
    if (userTier !== 'PUBLIC' && userTier !== 'PRO' && userTier !== 'PRO_MAX') {
      throw new InternalError('INVARIANT', 'user has invalid tier');
    }

    const userId = user._id;
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
    const linkedUsers = await Promise.all(links.map((id) => this.userRepo.findById(id)));
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

    const sessionData: Partial<LoginSessionAttrs> = {
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
      sessionData.deviceFingerprint = input.deviceFingerprint;
    }

    const writeOpts = session ? { session } : {};
    await this.sessionRepo.create(sessionData, writeOpts);

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
