import type { NextFunction, Request, Response } from 'express';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { __resetJwtKeysForTesting, initJwtKeys, signAccessToken } from '../jwt/signer.js';
import { UserModel } from '../models/User.model.js';
import { requireUser, type AuthedReqUser } from './auth.middleware.js';

/**
 * Phase 11.5 — middleware tokenVersion check. Pairs with the four
 * refresh-path specs in auth.service.spec.ts; proves the parallel
 * check at the per-request access-token gate.
 */
beforeAll(async () => {
  await connectTestMongo();
  __resetJwtKeysForTesting();
  await initJwtKeys();
}, 30_000);

afterAll(async () => {
  await disconnectTestMongo();
});

beforeEach(async () => {
  await clearAllCollections();
});

interface FakeReq {
  header(name: string): string | undefined;
  user?: AuthedReqUser;
}

function mkReq(authHeader?: string): FakeReq {
  return {
    header(name: string) {
      if (name.toLowerCase() === 'authorization') return authHeader;
      return undefined;
    },
  };
}

async function invoke(req: FakeReq): Promise<Error | null> {
  return new Promise((resolve) => {
    const next: NextFunction = (err) => {
      resolve((err ?? null) as Error | null);
    };
    void requireUser(req as unknown as Request, {} as Response, next);
  });
}

describe('requireUser — Phase 11.5 tokenVersion check', () => {
  it('attaches subscriptions[] and passes through when tokenVersion matches', async () => {
    const user = await UserModel.create({
      phone: '+919800001111',
      dob: new Date('1995-01-01'),
      declaredState: 'IN-MH',
      subscriptions: [{ tier: 'PRO', status: 'ACTIVE' }],
    });

    const token = await signAccessToken({
      sub: String(user._id),
      jti: 'jti-mw-1',
      tokenVersion: 1,
    });
    const req = mkReq(`Bearer ${token}`);

    const err = await invoke(req);
    expect(err).toBeNull();
    expect(req.user?.sub).toBe(String(user._id));
    expect(req.user?.tokenVersion).toBe(1);
    expect(req.user?.subscriptions).toHaveLength(1);
    expect(req.user?.subscriptions[0]?.tier).toBe('PRO');
  });

  it('rejects with 401 TOKEN_VERSION_MISMATCH when access token tokenVersion lags User.tokenVersion', async () => {
    const user = await UserModel.create({
      phone: '+919800002222',
      dob: new Date('1995-01-01'),
      declaredState: 'IN-MH',
    });
    // Simulate an admin force-logout bump after the access token was issued.
    await UserModel.updateOne({ _id: user._id }, { $set: { tokenVersion: 5 } });

    const token = await signAccessToken({
      sub: String(user._id),
      jti: 'jti-mw-2',
      tokenVersion: 1,
    });
    const req = mkReq(`Bearer ${token}`);

    const err = await invoke(req);
    expect(err).not.toBeNull();
    expect(err).toMatchObject({ message: 'TOKEN_VERSION_MISMATCH' });
    expect(req.user).toBeUndefined();
  });

  it('rejects with 401 when the User row is missing (e.g. anonymized)', async () => {
    const orphanId = new Types.ObjectId();
    const token = await signAccessToken({
      sub: String(orphanId),
      jti: 'jti-mw-3',
      tokenVersion: 1,
    });
    const req = mkReq(`Bearer ${token}`);

    const err = await invoke(req);
    expect(err).not.toBeNull();
    expect((err as Error).message).toMatch(/User not found/);
  });
});
