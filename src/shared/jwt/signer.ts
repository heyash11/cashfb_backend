import { generateKeyPairSync, createHash, type KeyObject } from 'node:crypto';
import { SignJWT, jwtVerify, importPKCS8, importSPKI, type CryptoKey } from 'jose';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

const JWT_ALG = 'RS256' as const;
const KEY_ID = 'v1';
const ISSUER = 'cashfb';

export const ACCESS_TTL_SEC = 15 * 60; // 15 min
export const REFRESH_TTL_SEC = 30 * 24 * 60 * 60; // 30 days

type Tier = 'PUBLIC' | 'PRO' | 'PRO_MAX';
type JoseKey = CryptoKey | KeyObject;

export interface AccessClaims {
  sub: string;
  tier: Tier;
  jti: string;
  /** Unix seconds at issuance. Populated by `jose` via setIssuedAt() and
   *  extracted by verifyAccessToken so force-logout middleware can
   *  compare against the per-user cutoff in Redis. */
  iat: number;
}

export interface RefreshClaims {
  sub: string;
  jti: string;
  family: string;
  /** Unix seconds at issuance. Same semantics as AccessClaims.iat —
   *  refresh endpoint uses it against the force-logout cutoff. */
  iat: number;
}

/**
 * Keys are module-private and initialised at boot via `initJwtKeys()`.
 * Signing/verify functions throw before init completes.
 */
let privateKey: JoseKey | null = null;
let publicKey: JoseKey | null = null;
let usingEphemeral = false;

/** Pure-observability counters, active only in ephemeral mode. */
let accessIssued = 0;
let refreshIssued = 0;

/**
 * Load JWT keys.
 *
 * Production: both `JWT_PRIVATE_KEY_PEM` and `JWT_PUBLIC_KEY_PEM` must
 * be present. Hard-fail otherwise.
 *
 * Dev/test: if either is missing, generate an ephemeral RSA pair
 * (2048-bit). WARN on stderr so Ashhu knows sessions will not survive
 * a restart.
 */
export async function initJwtKeys(): Promise<void> {
  if (env.JWT_PRIVATE_KEY_PEM && env.JWT_PUBLIC_KEY_PEM) {
    privateKey = await importPKCS8(env.JWT_PRIVATE_KEY_PEM, JWT_ALG);
    publicKey = await importSPKI(env.JWT_PUBLIC_KEY_PEM, JWT_ALG);
    usingEphemeral = false;
    return;
  }

  if (env.NODE_ENV === 'production') {
    throw new Error('JWT_PRIVATE_KEY_PEM and JWT_PUBLIC_KEY_PEM are required in production');
  }

  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;
  usingEphemeral = true;
  accessIssued = 0;
  refreshIssued = 0;

  logger.warn(
    '[jwt] EPHEMERAL KEYS — not loaded from env. All sessions invalidated on process restart. Do not use in production.',
  );
}

export function isEphemeralMode(): boolean {
  return usingEphemeral;
}

export function ephemeralStats(): { accessIssued: number; refreshIssued: number } {
  return { accessIssued, refreshIssued };
}

/** Exposed for tests that need to swap in a fresh pair. */
export function __resetJwtKeysForTesting(): void {
  privateKey = null;
  publicKey = null;
  usingEphemeral = false;
  accessIssued = 0;
  refreshIssued = 0;
}

function requirePrivateKey(): JoseKey {
  if (!privateKey) throw new Error('JWT keys not initialised — call initJwtKeys() at boot');
  return privateKey;
}

function requirePublicKey(): JoseKey {
  if (!publicKey) throw new Error('JWT keys not initialised — call initJwtKeys() at boot');
  return publicKey;
}

/**
 * Input to signAccessToken. `iat` is NOT accepted here — it is set
 * by jose via setIssuedAt() at signing time. It resurfaces on the
 * verified AccessClaims so middleware can check the force-logout
 * cutoff.
 */
export type SignAccessInput = Omit<AccessClaims, 'iat'>;
export type SignRefreshInput = Omit<RefreshClaims, 'iat'>;

export async function signAccessToken(claims: SignAccessInput): Promise<string> {
  accessIssued += 1;
  return new SignJWT({ tier: claims.tier })
    .setProtectedHeader({ alg: JWT_ALG, kid: KEY_ID })
    .setSubject(claims.sub)
    .setJti(claims.jti)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_SEC}s`)
    .sign(requirePrivateKey());
}

export async function signRefreshToken(claims: SignRefreshInput): Promise<string> {
  refreshIssued += 1;
  return new SignJWT({ family: claims.family })
    .setProtectedHeader({ alg: JWT_ALG, kid: KEY_ID })
    .setSubject(claims.sub)
    .setJti(claims.jti)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${REFRESH_TTL_SEC}s`)
    .sign(requirePrivateKey());
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, requirePublicKey(), {
    algorithms: [JWT_ALG],
    issuer: ISSUER,
  });
  if (!payload.sub || !payload.jti) throw new Error('access token missing sub/jti');
  if (typeof payload.iat !== 'number') throw new Error('access token missing iat');
  const tier = payload['tier'];
  if (tier !== 'PUBLIC' && tier !== 'PRO' && tier !== 'PRO_MAX') {
    throw new Error('access token has invalid tier claim');
  }
  return { sub: payload.sub, jti: payload.jti, tier, iat: payload.iat };
}

export async function verifyRefreshToken(token: string): Promise<RefreshClaims> {
  const { payload } = await jwtVerify(token, requirePublicKey(), {
    algorithms: [JWT_ALG],
    issuer: ISSUER,
  });
  if (!payload.sub || !payload.jti) throw new Error('refresh token missing sub/jti');
  if (typeof payload.iat !== 'number') throw new Error('refresh token missing iat');
  const family = payload['family'];
  if (typeof family !== 'string') throw new Error('refresh token missing family claim');
  return { sub: payload.sub, jti: payload.jti, family, iat: payload.iat };
}

/**
 * SHA-256 hex digest of a refresh token. Stored on
 * `login_sessions.refreshTokenHash` so token lookup never touches the
 * raw token value.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
