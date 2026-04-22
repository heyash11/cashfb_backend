import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { type CoinEventEmitter, NoopCoinEventEmitter } from '../../shared/events/coinEvents.js';
import { CoinTransactionModel } from '../../shared/models/CoinTransaction.model.js';
import { MODELS } from '../../shared/models/index.js';
import { UserModel, type UserAttrs, type UserDoc } from '../../shared/models/User.model.js';
import { VoteModel } from '../../shared/models/Vote.model.js';
import { CoinTransactionRepository } from '../../shared/repositories/CoinTransaction.repository.js';
import { UserRepository } from '../../shared/repositories/User.repository.js';
import { CastVoteBodySchema } from './votes.schemas.js';
import { VoteService } from './votes.service.js';

type AnyModel = { syncIndexes(): Promise<string[]> };

class MockEmitter implements CoinEventEmitter {
  emitCoinsUpdated = vi.fn().mockResolvedValue(undefined);
}

let phoneCounter = 0;
async function mkUser(overrides: Partial<UserAttrs> = {}): Promise<UserDoc> {
  phoneCounter += 1;
  const suffix = String(phoneCounter).padStart(8, '0');
  return UserModel.create({
    phone: `+9198${suffix}`,
    dob: new Date('1995-01-01'),
    declaredState: 'IN-MH',
    coinBalance: 3,
    ...overrides,
  });
}

beforeAll(async () => {
  await connectTestMongo();
  await Promise.all(Object.values(MODELS).map((m) => (m as unknown as AnyModel).syncIndexes()));
}, 120_000);

afterAll(async () => {
  await disconnectTestMongo();
});

beforeEach(async () => {
  await clearAllCollections();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------

describe('CastVoteBodySchema', () => {
  it('rejects whitespace-only target', () => {
    const result = CastVoteBodySchema.safeParse({ target: '    ' });
    expect(result.success).toBe(false);
  });

  it('rejects target longer than 100 characters', () => {
    const result = CastVoteBodySchema.safeParse({ target: 'a'.repeat(101) });
    expect(result.success).toBe(false);
  });

  it('trims leading/trailing whitespace and accepts the inner string', () => {
    const result = CastVoteBodySchema.safeParse({ target: '  option-alpha  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.target).toBe('option-alpha');
  });
});

// ---------------------------------------------------------------
// castVote — happy path
// ---------------------------------------------------------------

describe('VoteService.castVote — happy path', () => {
  it('balance 3 → succeeds, balance 0, dayKey returned, lastVoteDate set, totalVotesCast bumped, VOTE_SPEND row references the vote', async () => {
    const emitter = new MockEmitter();
    const svc = new VoteService({ coinEvents: emitter });
    const user = await mkUser();

    const result = await svc.castVote({
      userId: user._id,
      target: 'option-alpha',
      ipAddress: '1.2.3.4',
      deviceFingerprint: 'fp-1',
    });

    expect(result.coinBalance).toBe(0);
    expect(result.dayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const votes = await VoteModel.find({ userId: user._id });
    expect(votes).toHaveLength(1);
    expect(votes[0]?.dayKey).toBe(result.dayKey);
    expect(votes[0]?.target).toBe('option-alpha');
    expect(votes[0]?.coinsSpent).toBe(3);
    expect(votes[0]?.device).toBe('fp-1');

    const refreshed = await UserModel.findById(user._id);
    expect(refreshed?.coinBalance).toBe(0);
    expect(refreshed?.totalVotesCast).toBe(1);
    expect(refreshed?.lastVoteDate).toBe(result.dayKey);

    const txs = await CoinTransactionModel.find({ userId: user._id });
    expect(txs).toHaveLength(1);
    expect(txs[0]?.type).toBe('VOTE_SPEND');
    expect(txs[0]?.amount).toBe(-3);
    expect(txs[0]?.balanceAfter).toBe(0);
    expect(txs[0]?.reference?.kind).toBe('Vote');
    expect(String(txs[0]?.reference?.id)).toBe(String(votes[0]?._id));

    expect(emitter.emitCoinsUpdated).toHaveBeenCalledOnce();
    expect(emitter.emitCoinsUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'VOTE_SPEND', coinBalance: 0 }),
    );
  });
});

// ---------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------

describe('VoteService.castVote — concurrency', () => {
  it('two parallel casts same user same day → exactly 1 fulfilled, 1 rejected VOTE_ALREADY_CAST', async () => {
    const svc = new VoteService({ coinEvents: new NoopCoinEventEmitter() });
    const user = await mkUser({ coinBalance: 3 });

    const [a, b] = await Promise.allSettled([
      svc.castVote({
        userId: user._id,
        target: 'alpha',
        ipAddress: '1.1.1.1',
        deviceFingerprint: null,
      }),
      svc.castVote({
        userId: user._id,
        target: 'beta',
        ipAddress: '1.1.1.1',
        deviceFingerprint: null,
      }),
    ]);

    const fulfilled = [a, b].filter((r) => r.status === 'fulfilled');
    const rejected = [a, b].filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'VOTE_ALREADY_CAST',
    });

    const votes = await VoteModel.find({ userId: user._id });
    expect(votes).toHaveLength(1);
    const txs = await CoinTransactionModel.find({ userId: user._id });
    expect(txs).toHaveLength(1);
    const refreshed = await UserModel.findById(user._id);
    expect(refreshed?.coinBalance).toBe(0);
    expect(refreshed?.totalVotesCast).toBe(1);
  });
});

// ---------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------

describe('VoteService.castVote — rollback', () => {
  it('rolls back the vote when coinTxRepo.create throws', async () => {
    const coinTxRepo = new CoinTransactionRepository();
    vi.spyOn(coinTxRepo, 'create').mockRejectedValue(new Error('simulated coin_tx failure'));
    const svc = new VoteService({
      coinEvents: new MockEmitter(),
      coinTxRepo,
    });
    const user = await mkUser({ coinBalance: 3 });

    await expect(
      svc.castVote({
        userId: user._id,
        target: 'alpha',
        ipAddress: '1.1.1.1',
        deviceFingerprint: null,
      }),
    ).rejects.toThrow(/simulated/);

    expect(await VoteModel.countDocuments({ userId: user._id })).toBe(0);
    expect(await CoinTransactionModel.countDocuments({ userId: user._id })).toBe(0);
    const refreshed = await UserModel.findById(user._id);
    expect(refreshed?.coinBalance).toBe(3);
    expect(refreshed?.totalVotesCast).toBe(0);
  });
});

// ---------------------------------------------------------------
// Admin-block race (compound-filter guard)
// ---------------------------------------------------------------

describe('VoteService.castVote — admin-block race', () => {
  it('user blocked between pre-read and transaction: compound filter catches it, vote rolled back', async () => {
    const user = await mkUser({ coinBalance: 3 });
    const unblockedSnapshot = user.toObject();

    const userRepo = new UserRepository();
    // Simulate admin blocking the user mid-flow: spy returns the
    // still-unblocked snapshot (so the pre-read passes), but mutates
    // the live doc to blocked=true before returning. The transaction's
    // findOneAndUpdate then sees blocked=true and fails the compound
    // filter.
    vi.spyOn(userRepo, 'findById').mockImplementationOnce(async () => {
      await UserModel.updateOne({ _id: user._id }, { $set: { 'blocked.isBlocked': true } });
      return unblockedSnapshot;
    });

    const svc = new VoteService({
      coinEvents: new NoopCoinEventEmitter(),
      userRepo,
    });

    await expect(
      svc.castVote({
        userId: user._id,
        target: 'alpha',
        ipAddress: '1.1.1.1',
        deviceFingerprint: null,
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_COINS' });

    // Vote rolled back because the transaction aborted.
    expect(await VoteModel.countDocuments({ userId: user._id })).toBe(0);
    expect(await CoinTransactionModel.countDocuments({ userId: user._id })).toBe(0);
    const refreshed = await UserModel.findById(user._id);
    // Balance unchanged; the user is now blocked (admin mutation persisted).
    expect(refreshed?.coinBalance).toBe(3);
    expect(refreshed?.blocked.isBlocked).toBe(true);
  });
});

// ---------------------------------------------------------------
// Sequential rejects
// ---------------------------------------------------------------

describe('VoteService.castVote — sequential rejects', () => {
  it('second vote same user same day → VOTE_ALREADY_CAST, no extra coin spend', async () => {
    const svc = new VoteService({ coinEvents: new NoopCoinEventEmitter() });
    const user = await mkUser({ coinBalance: 6 });

    await svc.castVote({
      userId: user._id,
      target: 'alpha',
      ipAddress: '1.1.1.1',
      deviceFingerprint: null,
    });

    await expect(
      svc.castVote({
        userId: user._id,
        target: 'beta',
        ipAddress: '1.1.1.1',
        deviceFingerprint: null,
      }),
    ).rejects.toMatchObject({ code: 'VOTE_ALREADY_CAST' });

    const votes = await VoteModel.find({ userId: user._id });
    expect(votes).toHaveLength(1);
    expect(votes[0]?.target).toBe('alpha');
    const refreshed = await UserModel.findById(user._id);
    expect(refreshed?.coinBalance).toBe(3);
  });

  it('balance < 3 → INSUFFICIENT_COINS, no state change', async () => {
    const svc = new VoteService({ coinEvents: new NoopCoinEventEmitter() });
    const user = await mkUser({ coinBalance: 2 });

    await expect(
      svc.castVote({
        userId: user._id,
        target: 'alpha',
        ipAddress: '1.1.1.1',
        deviceFingerprint: null,
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_COINS' });

    expect(await VoteModel.countDocuments({ userId: user._id })).toBe(0);
    const refreshed = await UserModel.findById(user._id);
    expect(refreshed?.coinBalance).toBe(2);
  });

  it('already-blocked user → USER_BLOCKED, no state change', async () => {
    const svc = new VoteService({ coinEvents: new NoopCoinEventEmitter() });
    const user = await mkUser({
      coinBalance: 3,
      blocked: { isBlocked: true, reason: 'test' },
    });

    await expect(
      svc.castVote({
        userId: user._id,
        target: 'alpha',
        ipAddress: '1.1.1.1',
        deviceFingerprint: null,
      }),
    ).rejects.toMatchObject({ code: 'USER_BLOCKED' });

    expect(await VoteModel.countDocuments({ userId: user._id })).toBe(0);
    const refreshed = await UserModel.findById(user._id);
    expect(refreshed?.coinBalance).toBe(3);
  });

  it('missing user (token outlived user) → UNAUTHORIZED', async () => {
    const svc = new VoteService({ coinEvents: new NoopCoinEventEmitter() });
    await expect(
      svc.castVote({
        userId: new Types.ObjectId(),
        target: 'alpha',
        ipAddress: '1.1.1.1',
        deviceFingerprint: null,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

// ---------------------------------------------------------------
// Day-key rollover
// ---------------------------------------------------------------

describe('VoteService.castVote — day-key rollover', () => {
  it('votes at 23:59:59 IST and 00:00:01 IST both succeed with different dayKeys', async () => {
    // 2026-04-22 18:29:59 UTC = 2026-04-22 23:59:59 IST (+5:30).
    vi.useFakeTimers({
      now: new Date(Date.UTC(2026, 3, 22, 18, 29, 59)),
      toFake: ['Date'],
    });

    const svc = new VoteService({ coinEvents: new NoopCoinEventEmitter() });
    const user = await mkUser({ coinBalance: 6 });

    const first = await svc.castVote({
      userId: user._id,
      target: 'alpha',
      ipAddress: '1.1.1.1',
      deviceFingerprint: null,
    });
    expect(first.dayKey).toBe('2026-04-22');

    // 2026-04-22 18:30:01 UTC = 2026-04-23 00:00:01 IST.
    vi.setSystemTime(new Date(Date.UTC(2026, 3, 22, 18, 30, 1)));

    const second = await svc.castVote({
      userId: user._id,
      target: 'beta',
      ipAddress: '1.1.1.1',
      deviceFingerprint: null,
    });
    expect(second.dayKey).toBe('2026-04-23');

    const votes = await VoteModel.find({ userId: user._id }).sort({ dayKey: 1 });
    expect(votes).toHaveLength(2);
    expect(votes[0]?.dayKey).toBe('2026-04-22');
    expect(votes[1]?.dayKey).toBe('2026-04-23');

    const txs = await CoinTransactionModel.find({ userId: user._id });
    expect(txs).toHaveLength(2);
    expect(txs.every((t) => t.type === 'VOTE_SPEND')).toBe(true);

    const refreshed = await UserModel.findById(user._id);
    expect(refreshed?.coinBalance).toBe(0);
    expect(refreshed?.totalVotesCast).toBe(2);
  });
});

// ---------------------------------------------------------------
// getTodayStatus
// ---------------------------------------------------------------

describe('VoteService.getTodayStatus', () => {
  it('returns canVote: false with usedAt + dayKey when user voted today', async () => {
    const svc = new VoteService({ coinEvents: new NoopCoinEventEmitter() });
    const user = await mkUser({ coinBalance: 3 });
    const before = Date.now();
    await svc.castVote({
      userId: user._id,
      target: 'alpha',
      ipAddress: '1.1.1.1',
      deviceFingerprint: null,
    });

    const status = await svc.getTodayStatus(user._id);
    expect(status.canVote).toBe(false);
    expect(status.usedAt).toBeInstanceOf(Date);
    expect(status.usedAt && status.usedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(status.dayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('returns canVote: true when user voted yesterday but not today', async () => {
    const svc = new VoteService({ coinEvents: new NoopCoinEventEmitter() });
    const user = await mkUser({ coinBalance: 3 });

    // Manually insert a vote for yesterday's dayKey so no unique-index collision today.
    const today = await svc.getTodayStatus(user._id); // dayKey today
    const yesterday = new Date(new Date(today.dayKey + 'T00:00:00Z').getTime() - 86_400_000)
      .toISOString()
      .slice(0, 10);

    await VoteModel.create({
      userId: user._id,
      dayKey: yesterday,
      target: 'alpha',
      coinsSpent: 3,
    });

    const status = await svc.getTodayStatus(user._id);
    expect(status.canVote).toBe(true);
    expect(status.usedAt).toBeUndefined();
    expect(status.dayKey).toBe(today.dayKey);
  });

  it('returns canVote: true for a user who has never voted', async () => {
    const svc = new VoteService({ coinEvents: new NoopCoinEventEmitter() });
    const user = await mkUser({ coinBalance: 3 });

    const status = await svc.getTodayStatus(user._id);
    expect(status.canVote).toBe(true);
    expect(status.usedAt).toBeUndefined();
  });
});
