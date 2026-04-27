import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { type CoinEventEmitter, NoopCoinEventEmitter } from '../../shared/events/coinEvents.js';
import { CoinTransactionModel } from '../../shared/models/CoinTransaction.model.js';
import { MODELS } from '../../shared/models/index.js';
import { PostCompletionModel } from '../../shared/models/PostCompletion.model.js';
import { PostModel, type PostAttrs, type PostDoc } from '../../shared/models/Post.model.js';
import { UserModel, type UserAttrs, type UserDoc } from '../../shared/models/User.model.js';
import { CoinTransactionRepository } from '../../shared/repositories/CoinTransaction.repository.js';
import { PostService } from './posts.service.js';

type AnyModel = { syncIndexes(): Promise<string[]> };

class MockEmitter implements CoinEventEmitter {
  emitCoinsUpdated = vi.fn().mockResolvedValue(undefined);
}

let phoneCounter = 0;
async function mkUser(overrides: Partial<UserAttrs> = {}): Promise<UserDoc> {
  phoneCounter += 1;
  const suffix = String(phoneCounter).padStart(8, '0');
  return UserModel.create({
    phone: `+9199${suffix}`,
    dob: new Date('1995-01-01'),
    declaredState: 'IN-MH',
    ...overrides,
  });
}

async function mkPost(overrides: Partial<PostAttrs> = {}): Promise<PostDoc> {
  return PostModel.create({
    title: 'Test Post',
    dayKey: '2026-04-23',
    scheduledAt: new Date('2026-04-23T12:00:00Z'),
    status: 'LIVE',
    coinReward: 1,
    tier: 'PUBLIC',
    createdBy: new Types.ObjectId(),
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

// ---------------------------------------------------------------
// completePost — happy path
// ---------------------------------------------------------------

describe('PostService.completePost — happy path', () => {
  it('awards the coin, writes one completion + one POST_REWARD tx, emits coin event', async () => {
    const emitter = new MockEmitter();
    const svc = new PostService({ coinEvents: emitter });
    const user = await mkUser();
    const post = await mkPost();

    const result = await svc.completePost({
      postId: post._id,
      userId: user._id,
      subscriptions: [],
    });

    expect(result.alreadyCompleted).toBe(false);
    expect(result.coinBalance).toBe(1);

    const completions = await PostCompletionModel.find({ userId: user._id });
    expect(completions).toHaveLength(1);
    expect(String(completions[0]?.postId)).toBe(String(post._id));
    expect(completions[0]?.coinAwarded).toBe(1);

    const txs = await CoinTransactionModel.find({ userId: user._id });
    expect(txs).toHaveLength(1);
    expect(txs[0]?.type).toBe('POST_REWARD');
    expect(txs[0]?.amount).toBe(1);
    expect(txs[0]?.balanceAfter).toBe(1);

    const refreshed = await UserModel.findById(user._id);
    expect(refreshed?.coinBalance).toBe(1);

    expect(emitter.emitCoinsUpdated).toHaveBeenCalledOnce();
    expect(emitter.emitCoinsUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'POST_REWARD', coinBalance: 1 }),
    );
  });
});

// ---------------------------------------------------------------
// completePost — idempotency (sequential)
// ---------------------------------------------------------------

describe('PostService.completePost — idempotency', () => {
  it('second sequential call returns alreadyCompleted: true, no extra coin, no extra emit', async () => {
    const emitter = new MockEmitter();
    const svc = new PostService({ coinEvents: emitter });
    const user = await mkUser();
    const post = await mkPost();

    const first = await svc.completePost({
      postId: post._id,
      userId: user._id,
      subscriptions: [],
    });
    expect(first.alreadyCompleted).toBe(false);

    const second = await svc.completePost({
      postId: post._id,
      userId: user._id,
      subscriptions: [],
    });
    expect(second.alreadyCompleted).toBe(true);
    expect(second.coinBalance).toBe(1);

    const txs = await CoinTransactionModel.find({ userId: user._id });
    expect(txs).toHaveLength(1);
    const completions = await PostCompletionModel.find({ userId: user._id });
    expect(completions).toHaveLength(1);
    expect(emitter.emitCoinsUpdated).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------
// completePost — reject paths
// ---------------------------------------------------------------

describe('PostService.completePost — reject paths', () => {
  it('non-existent post → NotFoundError 404', async () => {
    const svc = new PostService({ coinEvents: new NoopCoinEventEmitter() });
    const user = await mkUser();

    await expect(
      svc.completePost({
        postId: new Types.ObjectId(),
        userId: user._id,
        subscriptions: [],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
  });

  it('CLOSED post → POST_NOT_LIVE 409', async () => {
    const svc = new PostService({ coinEvents: new NoopCoinEventEmitter() });
    const user = await mkUser();
    const post = await mkPost({ status: 'CLOSED' });

    await expect(
      svc.completePost({ postId: post._id, userId: user._id, subscriptions: [] }),
    ).rejects.toMatchObject({ code: 'POST_NOT_LIVE', httpStatus: 409 });
  });

  it('DRAFT post → POST_NOT_LIVE', async () => {
    const svc = new PostService({ coinEvents: new NoopCoinEventEmitter() });
    const user = await mkUser();
    const post = await mkPost({ status: 'DRAFT' });

    await expect(
      svc.completePost({ postId: post._id, userId: user._id, subscriptions: [] }),
    ).rejects.toMatchObject({ code: 'POST_NOT_LIVE' });
  });

  it('SCHEDULED post → POST_NOT_LIVE', async () => {
    const svc = new PostService({ coinEvents: new NoopCoinEventEmitter() });
    const user = await mkUser();
    const post = await mkPost({ status: 'SCHEDULED' });

    await expect(
      svc.completePost({ postId: post._id, userId: user._id, subscriptions: [] }),
    ).rejects.toMatchObject({ code: 'POST_NOT_LIVE' });
  });

  it('Phase 11.4 — PRO post + no PRO subscription → TIER_NOT_ACCESSIBLE 403 (strict subscription auth)', async () => {
    const svc = new PostService({ coinEvents: new NoopCoinEventEmitter() });
    const user = await mkUser();
    const post = await mkPost({ tier: 'PRO' });

    await expect(
      svc.completePost({ postId: post._id, userId: user._id, subscriptions: [] }),
    ).rejects.toMatchObject({ code: 'TIER_NOT_ACCESSIBLE', httpStatus: 403 });
  });

  it('Phase 11.4 — PRO post + PRO_MAX-only subscription → TIER_NOT_ACCESSIBLE 403 (strict, NOT hierarchical)', async () => {
    const svc = new PostService({ coinEvents: new NoopCoinEventEmitter() });
    const user = await mkUser();
    const post = await mkPost({ tier: 'PRO' });

    // PRO_MAX subscription does NOT grant access to PRO content under
    // the strict subscription model.
    const proMaxOnly = [
      { tier: 'PRO_MAX' as const, status: 'ACTIVE' as const, expiresAt: new Date('2027-01-01') },
    ];

    await expect(
      svc.completePost({ postId: post._id, userId: user._id, subscriptions: proMaxOnly }),
    ).rejects.toMatchObject({ code: 'TIER_NOT_ACCESSIBLE', httpStatus: 403 });
  });

  it('Phase 11.4 — PRO post + active PRO subscription → succeeds', async () => {
    const svc = new PostService({ coinEvents: new NoopCoinEventEmitter() });
    const user = await mkUser();
    const post = await mkPost({ tier: 'PRO' });
    const proSub = [
      { tier: 'PRO' as const, status: 'ACTIVE' as const, expiresAt: new Date('2027-01-01') },
    ];

    const result = await svc.completePost({
      postId: post._id,
      userId: user._id,
      subscriptions: proSub,
    });
    expect(result.alreadyCompleted).toBe(false);
  });
});

// ---------------------------------------------------------------
// completePost — concurrency
// ---------------------------------------------------------------

describe('PostService.completePost — concurrency', () => {
  it('two parallel completions award exactly 1 coin, 1 completion, 1 coin_tx', async () => {
    const emitter = new MockEmitter();
    const svc = new PostService({ coinEvents: emitter });
    const user = await mkUser();
    const post = await mkPost();

    const [a, b] = await Promise.allSettled([
      svc.completePost({ postId: post._id, userId: user._id, subscriptions: [] }),
      svc.completePost({ postId: post._id, userId: user._id, subscriptions: [] }),
    ]);

    expect(a.status).toBe('fulfilled');
    expect(b.status).toBe('fulfilled');

    const fulfilled = [a, b].filter(
      (r): r is PromiseFulfilledResult<{ alreadyCompleted: boolean; coinBalance: number }> =>
        r.status === 'fulfilled',
    );
    const freshCount = fulfilled.filter((r) => !r.value.alreadyCompleted).length;
    const dupCount = fulfilled.filter((r) => r.value.alreadyCompleted).length;
    expect(freshCount).toBe(1);
    expect(dupCount).toBe(1);

    const completions = await PostCompletionModel.find({ userId: user._id });
    expect(completions).toHaveLength(1);
    const txs = await CoinTransactionModel.find({ userId: user._id });
    expect(txs).toHaveLength(1);
    const refreshed = await UserModel.findById(user._id);
    expect(refreshed?.coinBalance).toBe(1);
  });
});

// ---------------------------------------------------------------
// completePost — transaction rollback
// ---------------------------------------------------------------

describe('PostService.completePost — rollback', () => {
  it('rolls back completion + coin increment if coinTxRepo.create throws', async () => {
    const coinTxRepo = new CoinTransactionRepository();
    vi.spyOn(coinTxRepo, 'create').mockRejectedValue(new Error('simulated coin_tx failure'));
    const svc = new PostService({
      coinEvents: new MockEmitter(),
      coinTxRepo,
    });
    const user = await mkUser();
    const post = await mkPost();

    await expect(
      svc.completePost({ postId: post._id, userId: user._id, subscriptions: [] }),
    ).rejects.toThrow(/simulated/);

    expect(await PostCompletionModel.countDocuments({ userId: user._id })).toBe(0);
    expect(await CoinTransactionModel.countDocuments({ userId: user._id })).toBe(0);
    const refreshed = await UserModel.findById(user._id);
    expect(refreshed?.coinBalance).toBe(0);
  });
});

// ---------------------------------------------------------------
// listForDate
// ---------------------------------------------------------------

describe('PostService.listForDate', () => {
  it('marks completed correctly based on user completions', async () => {
    const svc = new PostService({ coinEvents: new NoopCoinEventEmitter() });
    const user = await mkUser();

    const postA = await mkPost({ title: 'A' });
    await mkPost({ title: 'B' });
    await mkPost({ title: 'C' });

    await svc.completePost({ postId: postA._id, userId: user._id, subscriptions: [] });

    const list = await svc.listForDate('2026-04-23', user._id, 'PUBLIC');
    expect(list).toHaveLength(3);
    const completed = list.filter((p) => p.completed).map((p) => p.title);
    const notCompleted = list
      .filter((p) => !p.completed)
      .map((p) => p.title)
      .sort();
    expect(completed).toEqual(['A']);
    expect(notCompleted).toEqual(['B', 'C']);
  });

  it('excludes DRAFT posts from user view', async () => {
    const svc = new PostService({ coinEvents: new NoopCoinEventEmitter() });
    const user = await mkUser();
    await mkPost({ title: 'Live', status: 'LIVE' });
    await mkPost({ title: 'Scheduled', status: 'SCHEDULED' });
    await mkPost({ title: 'Closed', status: 'CLOSED' });
    await mkPost({ title: 'Draft', status: 'DRAFT' });

    const list = await svc.listForDate('2026-04-23', user._id, 'PUBLIC');
    const titles = list.map((p) => p.title).sort();
    expect(titles).toEqual(['Closed', 'Live', 'Scheduled']);
  });

  it('Phase 11.4 — listForDate is STRICT-scoped: tier query returns ONLY that tier (no hierarchy)', async () => {
    const svc = new PostService({ coinEvents: new NoopCoinEventEmitter() });
    const user = await mkUser();
    await mkPost({ title: 'Free', tier: 'PUBLIC' });
    await mkPost({ title: 'Pro', tier: 'PRO' });
    await mkPost({ title: 'Max', tier: 'PRO_MAX' });

    const asPublic = await svc.listForDate('2026-04-23', user._id, 'PUBLIC');
    expect(asPublic.map((p) => p.title).sort()).toEqual(['Free']);

    const asPro = await svc.listForDate('2026-04-23', user._id, 'PRO');
    // Strict: only PRO posts. NO 'Free' inclusion.
    expect(asPro.map((p) => p.title).sort()).toEqual(['Pro']);

    const asProMax = await svc.listForDate('2026-04-23', user._id, 'PRO_MAX');
    // Strict: only PRO_MAX posts. NO 'Free' or 'Pro' inclusion.
    expect(asProMax.map((p) => p.title).sort()).toEqual(['Max']);
  });

  it('Phase 11.4 — behavior-reversal proof: PRO_MAX user querying tier=PUBLIC sees only PUBLIC posts', async () => {
    // Auth check happens at controller layer; service-level listForDate
    // simply applies the strict tier filter. The semantic flip from
    // hierarchical inclusion to parallel scoping is the headline
    // change.
    const svc = new PostService({ coinEvents: new NoopCoinEventEmitter() });
    const user = await mkUser();
    await mkPost({ title: 'Free', tier: 'PUBLIC' });
    await mkPost({ title: 'Pro', tier: 'PRO' });
    await mkPost({ title: 'Max', tier: 'PRO_MAX' });

    const result = await svc.listForDate('2026-04-23', user._id, 'PUBLIC');
    expect(result.map((p) => p.title)).toEqual(['Free']);
  });
});

// ---------------------------------------------------------------
// getById
// ---------------------------------------------------------------

describe('PostService.getById', () => {
  it('returns dto with completed: false when user has not completed', async () => {
    const svc = new PostService({ coinEvents: new NoopCoinEventEmitter() });
    const user = await mkUser();
    const post = await mkPost();

    const dto = await svc.getById(post._id, user._id, []);
    expect(dto?.title).toBe('Test Post');
    expect(dto?.completed).toBe(false);
  });

  it('returns dto with completed: true after user completes the post', async () => {
    const svc = new PostService({ coinEvents: new NoopCoinEventEmitter() });
    const user = await mkUser();
    const post = await mkPost();

    await svc.completePost({ postId: post._id, userId: user._id, subscriptions: [] });

    const dto = await svc.getById(post._id, user._id, []);
    expect(dto?.completed).toBe(true);
  });

  it('returns null for non-existent post', async () => {
    const svc = new PostService({ coinEvents: new NoopCoinEventEmitter() });
    const user = await mkUser();
    expect(await svc.getById(new Types.ObjectId(), user._id, [])).toBeNull();
  });

  it('Phase 11.4 — returns null for tier-restricted post the user cannot access (strict subscription)', async () => {
    const svc = new PostService({ coinEvents: new NoopCoinEventEmitter() });
    const user = await mkUser();
    const post = await mkPost({ tier: 'PRO_MAX' });
    // Empty subscriptions[] → no PRO_MAX access → null.
    expect(await svc.getById(post._id, user._id, [])).toBeNull();
  });

  it('Phase 11.4 — PRO_MAX-only subscription → cannot access PRO post via deep link (strict, NOT hierarchical)', async () => {
    const svc = new PostService({ coinEvents: new NoopCoinEventEmitter() });
    const user = await mkUser();
    const post = await mkPost({ tier: 'PRO' });
    const proMaxOnly = [
      { tier: 'PRO_MAX' as const, status: 'ACTIVE' as const, expiresAt: new Date('2027-01-01') },
    ];
    expect(await svc.getById(post._id, user._id, proMaxOnly)).toBeNull();
  });
});
