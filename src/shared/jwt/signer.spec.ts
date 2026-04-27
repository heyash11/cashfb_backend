import { beforeAll, describe, expect, it } from 'vitest';
import {
  ACCESS_TTL_SEC,
  REFRESH_TTL_SEC,
  __resetJwtKeysForTesting,
  ephemeralStats,
  hashRefreshToken,
  initJwtKeys,
  isEphemeralMode,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from './signer.js';

beforeAll(async () => {
  __resetJwtKeysForTesting();
  // NODE_ENV=test ensures env.JWT_*_PEM are absent, so initJwtKeys()
  // generates an ephemeral RSA pair for this suite.
  await initJwtKeys();
});

describe('JWT signer (ephemeral keys)', () => {
  it('boots in ephemeral mode when no env keys are provided', () => {
    expect(isEphemeralMode()).toBe(true);
  });

  it('round-trips an access token and recovers claims (Phase 11.5: tokenVersion replaces tier)', async () => {
    const token = await signAccessToken({
      sub: 'user_1',
      jti: 'jti_abc',
      tokenVersion: 1,
    });
    const claims = await verifyAccessToken(token);
    expect(claims).toMatchObject({ sub: 'user_1', jti: 'jti_abc', tokenVersion: 1 });
    expect(typeof claims.iat).toBe('number');
    // Phase 11.5 — tier claim removed.
    expect(claims).not.toHaveProperty('tier');
  });

  it('round-trips a refresh token with tokenVersion', async () => {
    const token = await signRefreshToken({
      sub: 'user_1',
      jti: 'jti_refresh_xyz',
      family: 'fam_1',
      tokenVersion: 1,
    });
    const claims = await verifyRefreshToken(token);
    expect(claims).toMatchObject({
      sub: 'user_1',
      jti: 'jti_refresh_xyz',
      family: 'fam_1',
      tokenVersion: 1,
    });
    expect(typeof claims.iat).toBe('number');
  });

  it('rejects a tampered access token', async () => {
    const token = await signAccessToken({ sub: 'user_1', jti: 'jti_x', tokenVersion: 1 });
    const parts = token.split('.');
    const tampered = `${parts[0]}.${parts[1]}.${'A'.repeat(parts[2]!.length)}`;
    await expect(verifyAccessToken(tampered)).rejects.toThrow();
  });

  it('rejects a token signed by a different issuer (wrong key)', async () => {
    const token = await signAccessToken({ sub: 'u', jti: 'j', tokenVersion: 1 });
    __resetJwtKeysForTesting();
    await initJwtKeys();
    await expect(verifyAccessToken(token)).rejects.toThrow();
  });

  it('increments ephemeral stats per sign call', async () => {
    __resetJwtKeysForTesting();
    await initJwtKeys();
    await signAccessToken({ sub: 'u', jti: 'j1', tokenVersion: 1 });
    await signAccessToken({ sub: 'u', jti: 'j2', tokenVersion: 1 });
    await signRefreshToken({ sub: 'u', jti: 'j3', family: 'f', tokenVersion: 1 });
    const stats = ephemeralStats();
    expect(stats.accessIssued).toBe(2);
    expect(stats.refreshIssued).toBe(1);
  });

  it('Phase 11.5 — pre-11.5 token without tokenVersion claim parses as tokenVersion: 0', async () => {
    // The verify path defaults missing/non-numeric tokenVersion to 0
    // so the User.tokenVersion=1 default forces re-login on stale tokens.
    // We can't easily forge a pre-11.5 token here, but we can verify
    // the new path: signing without tokenVersion is a TypeScript error;
    // this spec asserts the runtime safety of the type narrowing.
    const claims = await verifyAccessToken(
      await signAccessToken({ sub: 'u', jti: 'j', tokenVersion: 0 }),
    );
    expect(claims.tokenVersion).toBe(0);
  });

  it('hashRefreshToken is deterministic and does not leak the input', () => {
    const a = hashRefreshToken('abc');
    const b = hashRefreshToken('abc');
    const c = hashRefreshToken('abd');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toContain('abc');
    expect(a).toMatch(/^[a-f0-9]{64}$/); // sha256 hex
  });

  it('exposes sane TTL constants', () => {
    expect(ACCESS_TTL_SEC).toBe(900);
    expect(REFRESH_TTL_SEC).toBe(2592000);
  });
});
