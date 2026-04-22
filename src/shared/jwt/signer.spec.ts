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

  it('round-trips an access token and recovers claims', async () => {
    const token = await signAccessToken({
      sub: 'user_1',
      tier: 'PRO',
      jti: 'jti_abc',
    });
    const claims = await verifyAccessToken(token);
    expect(claims).toEqual({ sub: 'user_1', tier: 'PRO', jti: 'jti_abc' });
  });

  it('round-trips a refresh token and recovers claims', async () => {
    const token = await signRefreshToken({
      sub: 'user_1',
      jti: 'jti_refresh_xyz',
      family: 'fam_1',
    });
    const claims = await verifyRefreshToken(token);
    expect(claims).toEqual({
      sub: 'user_1',
      jti: 'jti_refresh_xyz',
      family: 'fam_1',
    });
  });

  it('rejects a tampered access token', async () => {
    const token = await signAccessToken({ sub: 'user_1', tier: 'PRO', jti: 'jti_x' });
    const parts = token.split('.');
    const tampered = `${parts[0]}.${parts[1]}.${'A'.repeat(parts[2]!.length)}`;
    await expect(verifyAccessToken(tampered)).rejects.toThrow();
  });

  it('rejects a token signed by a different issuer (wrong key)', async () => {
    const token = await signAccessToken({ sub: 'u', tier: 'PUBLIC', jti: 'j' });
    // Reset the key state and re-init. New ephemeral pair means the
    // previously-signed token no longer verifies.
    __resetJwtKeysForTesting();
    await initJwtKeys();
    await expect(verifyAccessToken(token)).rejects.toThrow();
  });

  it('increments ephemeral stats per sign call', async () => {
    __resetJwtKeysForTesting();
    await initJwtKeys();
    await signAccessToken({ sub: 'u', tier: 'PUBLIC', jti: 'j1' });
    await signAccessToken({ sub: 'u', tier: 'PUBLIC', jti: 'j2' });
    await signRefreshToken({ sub: 'u', jti: 'j3', family: 'f' });
    const stats = ephemeralStats();
    expect(stats.accessIssued).toBe(2);
    expect(stats.refreshIssued).toBe(1);
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
