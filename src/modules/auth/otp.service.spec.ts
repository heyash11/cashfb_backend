import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConflictError, UnauthorizedError } from '../../shared/errors/AppError.js';
import { OtpVerificationModel } from '../../shared/models/OtpVerification.model.js';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { InMemoryLockoutStore } from './lockout.store.js';
import { OtpServiceImpl } from './otp.service.js';
import type { OtpPurpose, OtpSender } from './otp.types.js';

type Sent = { phone: string; otp: string; purpose: OtpPurpose };

beforeAll(async () => {
  await connectTestMongo();
  await OtpVerificationModel.syncIndexes();
}, 120_000);

afterAll(async () => {
  await disconnectTestMongo();
});

const PHONE = '+919999999999';

describe('OtpServiceImpl', () => {
  let sent: Sent[];
  let sender: OtpSender;
  let lockout: InMemoryLockoutStore;
  let svc: OtpServiceImpl;

  beforeEach(async () => {
    await clearAllCollections();
    sent = [];
    sender = {
      async send(phone, otp, purpose) {
        sent.push({ phone, otp, purpose });
      },
    };
    lockout = new InMemoryLockoutStore();
    svc = new OtpServiceImpl({ sender, lockoutStore: lockout });
  });

  async function sendOne(phone = PHONE, purpose: OtpPurpose = 'LOGIN'): Promise<string> {
    await svc.send({ phone, purpose, ipAddress: '1.1.1.1', deviceFingerprint: null });
    const last = sent[sent.length - 1];
    if (!last) throw new Error('sender was not called');
    return last.otp;
  }

  describe('send', () => {
    it('dispatches via sender and writes an otp_verifications row', async () => {
      await svc.send({
        phone: PHONE,
        purpose: 'SIGNUP',
        ipAddress: '1.1.1.1',
        deviceFingerprint: 'fp',
      });
      expect(sent).toHaveLength(1);
      expect(sent[0]?.phone).toBe(PHONE);
      expect(sent[0]?.otp).toMatch(/^\d{6}$/);

      const row = await OtpVerificationModel.findOne({ destination: PHONE });
      expect(row).toBeTruthy();
      expect(row?.otpHash).toBeTruthy();
      expect(row?.salt).toBeTruthy();
      expect(row?.purpose).toBe('SIGNUP');
    });

    it('throws OTP_LOCKED when phone is in lockout', async () => {
      await lockout.lock(PHONE, 1800);
      await expect(
        svc.send({ phone: PHONE, purpose: 'LOGIN', ipAddress: '1.1.1.1', deviceFingerprint: null }),
      ).rejects.toThrow(ConflictError);
      expect(sent).toHaveLength(0);
    });
  });

  describe('verify — success paths', () => {
    it('marks consumedAt and clears phone fail counter on correct OTP', async () => {
      const otp = await sendOne();
      // Poison the fail counter to prove clear-on-success semantics.
      await lockout.incrementFails(PHONE, 1800);

      await svc.verify({ phone: PHONE, otp, purpose: 'LOGIN' });

      const row = await OtpVerificationModel.findOne({ destination: PHONE });
      expect(row?.consumedAt).toBeTruthy();

      // clearFails → next increment restarts at 1.
      const next = await lockout.incrementFails(PHONE, 1800);
      expect(next).toBe(1);
    });
  });

  describe('verify — failure paths', () => {
    it('increments attempts and throws UnauthorizedError on wrong OTP', async () => {
      await sendOne();
      await expect(svc.verify({ phone: PHONE, otp: '000000', purpose: 'LOGIN' })).rejects.toThrow(
        UnauthorizedError,
      );

      const row = await OtpVerificationModel.findOne({ destination: PHONE });
      expect(row?.attempts).toBe(1);
    });

    it('third failed verify triggers phone lockout; further calls get OTP_LOCKED', async () => {
      const otp = await sendOne();

      // Two failed verifies — still below the 3-fail trigger.
      for (let i = 0; i < 2; i++) {
        await expect(svc.verify({ phone: PHONE, otp: '000000', purpose: 'LOGIN' })).rejects.toThrow(
          UnauthorizedError,
        );
      }

      // The third failed verify both throws OTP_LOCKED and sets the flag.
      await expect(svc.verify({ phone: PHONE, otp: '000000', purpose: 'LOGIN' })).rejects.toThrow(
        ConflictError,
      );

      // Even the correct OTP now gets OTP_LOCKED.
      await expect(svc.verify({ phone: PHONE, otp, purpose: 'LOGIN' })).rejects.toThrow(
        ConflictError,
      );

      // And send() refuses.
      await expect(
        svc.send({ phone: PHONE, purpose: 'LOGIN', ipAddress: '1.1.1.1', deviceFingerprint: null }),
      ).rejects.toThrow(ConflictError);
    });

    it('per-row attempts cap (5) kills the row even if the OTP is correct', async () => {
      const otp = await sendOne();

      // Bypass the 3-fail lockout trigger: bump attempts directly
      // to the per-row cap and clear the phone fail counter.
      await OtpVerificationModel.updateOne({ destination: PHONE }, { $set: { attempts: 5 } });
      await lockout.clearFails(PHONE);

      await expect(svc.verify({ phone: PHONE, otp, purpose: 'LOGIN' })).rejects.toThrow(
        UnauthorizedError,
      );
    });

    it('consumed OTP cannot be verified again', async () => {
      const otp = await sendOne();
      await svc.verify({ phone: PHONE, otp, purpose: 'LOGIN' });

      await expect(svc.verify({ phone: PHONE, otp, purpose: 'LOGIN' })).rejects.toThrow(
        UnauthorizedError,
      );
    });

    it('expired OTP cannot be verified', async () => {
      const otp = await sendOne();
      await OtpVerificationModel.updateOne(
        { destination: PHONE },
        { $set: { expiresAt: new Date(Date.now() - 1000) } },
      );
      await expect(svc.verify({ phone: PHONE, otp, purpose: 'LOGIN' })).rejects.toThrow();
    });

    it('verify with no active OTP still counts toward phone lockout (anti-enumeration)', async () => {
      // No send() before the verifies.
      await expect(svc.verify({ phone: PHONE, otp: '123456', purpose: 'LOGIN' })).rejects.toThrow(
        UnauthorizedError,
      );
      await expect(svc.verify({ phone: PHONE, otp: '123456', purpose: 'LOGIN' })).rejects.toThrow(
        UnauthorizedError,
      );
      await expect(svc.verify({ phone: PHONE, otp: '123456', purpose: 'LOGIN' })).rejects.toThrow(
        ConflictError,
      );
    });
  });
});
