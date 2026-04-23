import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { InMemoryEncryptor } from '../../shared/encryption/in-memory.js';
import { MODELS } from '../../shared/models/index.js';
import { PostModel, type PostDoc } from '../../shared/models/Post.model.js';
import { PostCompletionModel } from '../../shared/models/PostCompletion.model.js';
import { RedeemCodeModel } from '../../shared/models/RedeemCode.model.js';
import { UserModel, type UserAttrs, type UserDoc } from '../../shared/models/User.model.js';
import { AdminRedeemCodeService } from './redeem-codes.admin.service.js';
import { RedeemCodeService } from './redeem-codes.service.js';

type AnyModel = { syncIndexes(): Promise<string[]> };

const HASH_SECRET = 'unit-test-hash-secret-00000000000000000000000000';

function csvFor(codes: string[]): Buffer {
  const lines = ['code,denomination', ...codes.map((c) => `${c},5000`)];
  return Buffer.from(lines.join('\n'), 'utf8');
}

let phoneCounter = 0;
async function mkUser(overrides: Partial<UserAttrs> = {}): Promise<UserDoc> {
  phoneCounter += 1;
  const suffix = String(phoneCounter).padStart(8, '0');
  return UserModel.create({
    phone: `+9198${suffix}`,
    dob: new Date('1995-01-01'),
    declaredState: 'IN-MH',
    ...overrides,
  });
}

async function mkPost(overrides: Partial<PostDoc> = {}): Promise<PostDoc> {
  return PostModel.create({
    title: 'Redeem Host',
    dayKey: '2026-04-23',
    scheduledAt: new Date('2026-04-23T12:00:00Z'),
    status: 'LIVE',
    coinReward: 1,
    tierRequired: 'PUBLIC',
    createdBy: new Types.ObjectId(),
    ...overrides,
  });
}

async function mkCompletion(userId: Types.ObjectId, postId: Types.ObjectId): Promise<void> {
  await PostCompletionModel.create({
    userId,
    postId,
    dayKey: '2026-04-23',
    coinAwarded: 1,
  });
}

/**
 * Seed a single PUBLISHED redeem code for a post via the real admin
 * service so the encrypted fields are wired correctly. Returns the
 * code's _id + original plaintext for round-trip assertions.
 */
async function seedPublishedCode(
  admin: AdminRedeemCodeService,
  userSvc: RedeemCodeService,
  post: PostDoc,
  plaintext: string,
): Promise<{ codeId: Types.ObjectId; plaintext: string }> {
  void userSvc;
  const actor = new Types.ObjectId();
  const upload = await admin.uploadBatch(
    { csvBuffer: csvFor([plaintext]), supplierName: 'Xoxoday' },
    actor,
  );
  await admin.publishBatchToPost({ batchId: upload.batchId, postId: post._id, count: 1 }, actor);
  const doc = await RedeemCodeModel.findOne({ batchId: upload.batchId });
  if (!doc) throw new Error('seedPublishedCode: code not found');
  return { codeId: doc._id, plaintext };
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

describe('RedeemCodeService.claim — FCFS', () => {
  it('100 parallel claims on the same code yield exactly 1 success and 99 CODE_TAKEN', async () => {
    const encryptor = new InMemoryEncryptor();
    const admin = new AdminRedeemCodeService({ encryptor, hashSecret: HASH_SECRET });
    const svc = new RedeemCodeService({ encryptor });

    const post = await mkPost();
    const { codeId, plaintext } = await seedPublishedCode(admin, svc, post, 'FCFS-RACE-001');

    const users = await Promise.all(Array.from({ length: 100 }, () => mkUser()));
    await Promise.all(users.map((u) => mkCompletion(u._id, post._id)));

    const results = await Promise.allSettled(users.map((u) => svc.claim(codeId, u._id)));

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(99);
    for (const r of rejected) {
      if (r.status !== 'rejected') continue;
      expect((r.reason as { code?: string }).code).toBe('CODE_TAKEN');
    }

    const winner = fulfilled[0];
    if (winner?.status === 'fulfilled') {
      expect(winner.value.plaintextCode).toBe(plaintext);
    }

    const after = await RedeemCodeModel.findById(codeId);
    expect(after?.status).toBe('COPIED');
    expect(after?.copyCount).toBe(1);
  }, 60_000);

  it('rejects POST_NOT_COMPLETED when the user has not completed the post', async () => {
    const encryptor = new InMemoryEncryptor();
    const admin = new AdminRedeemCodeService({ encryptor, hashSecret: HASH_SECRET });
    const svc = new RedeemCodeService({ encryptor });

    const post = await mkPost();
    const { codeId } = await seedPublishedCode(admin, svc, post, 'NO-COMPLETE-1');
    const user = await mkUser();

    await expect(svc.claim(codeId, user._id)).rejects.toMatchObject({
      code: 'POST_NOT_COMPLETED',
    });
  });

  it('rejects CODE_TAKEN when the code is already COPIED', async () => {
    const encryptor = new InMemoryEncryptor();
    const admin = new AdminRedeemCodeService({ encryptor, hashSecret: HASH_SECRET });
    const svc = new RedeemCodeService({ encryptor });

    const post = await mkPost();
    const { codeId } = await seedPublishedCode(admin, svc, post, 'ALREADY-COPIED');
    const [first, second] = await Promise.all([mkUser(), mkUser()]);
    if (!first || !second) throw new Error('user fixtures missing');
    await mkCompletion(first._id, post._id);
    await mkCompletion(second._id, post._id);

    await svc.claim(codeId, first._id);
    await expect(svc.claim(codeId, second._id)).rejects.toMatchObject({ code: 'CODE_TAKEN' });
  });

  it('rejects CODE_TAKEN when the code is AVAILABLE (never published)', async () => {
    const encryptor = new InMemoryEncryptor();
    const admin = new AdminRedeemCodeService({ encryptor, hashSecret: HASH_SECRET });
    const svc = new RedeemCodeService({ encryptor });

    const post = await mkPost();
    const actor = new Types.ObjectId();
    const upload = await admin.uploadBatch(
      { csvBuffer: csvFor(['UNPUB-1']), supplierName: 'Xoxoday' },
      actor,
    );
    // Attach postId manually without publishing so the pre-checks
    // see a complete setup but atomicFcfsClaim sees status=AVAILABLE.
    const available = await RedeemCodeModel.findOne({ batchId: upload.batchId });
    if (!available) throw new Error('fixture');
    await RedeemCodeModel.updateOne({ _id: available._id }, { $set: { postId: post._id } });

    const user = await mkUser();
    await mkCompletion(user._id, post._id);

    await expect(svc.claim(available._id, user._id)).rejects.toMatchObject({
      code: 'CODE_TAKEN',
    });
  });

  it('rejects UNAUTHORIZED when the user is blocked', async () => {
    const encryptor = new InMemoryEncryptor();
    const admin = new AdminRedeemCodeService({ encryptor, hashSecret: HASH_SECRET });
    const svc = new RedeemCodeService({ encryptor });

    const post = await mkPost();
    const { codeId } = await seedPublishedCode(admin, svc, post, 'BLOCKED-USER-1');
    const user = await mkUser({
      blocked: { isBlocked: true, reason: 'fraud', at: new Date() },
    });
    await mkCompletion(user._id, post._id);

    await expect(svc.claim(codeId, user._id)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('encryption round-trip: decrypts to the exact plaintext from the CSV row', async () => {
    const encryptor = new InMemoryEncryptor();
    const admin = new AdminRedeemCodeService({ encryptor, hashSecret: HASH_SECRET });
    const svc = new RedeemCodeService({ encryptor });

    const post = await mkPost();
    const plaintext = 'XYZ-PLAY-7F3A-91K4';
    const { codeId } = await seedPublishedCode(admin, svc, post, plaintext);

    const user = await mkUser();
    await mkCompletion(user._id, post._id);

    const result = await svc.claim(codeId, user._id);
    expect(result.plaintextCode).toBe(plaintext.toUpperCase());
  });

  it('claim succeeds after admin CLOSED the post mid-session (earned actions stay earned)', async () => {
    const encryptor = new InMemoryEncryptor();
    const admin = new AdminRedeemCodeService({ encryptor, hashSecret: HASH_SECRET });
    const svc = new RedeemCodeService({ encryptor });

    // User completes the post while it is LIVE. Admin then CLOSES
    // the post. User should still be able to claim a code because
    // the completion record is what the claim predicate checks, not
    // the post's current status. Closing a post must not
    // retroactively revoke claim rights.
    const post = await mkPost({ status: 'LIVE' });
    const { codeId, plaintext } = await seedPublishedCode(admin, svc, post, 'LATE-CLAIM-1');
    const user = await mkUser();
    await mkCompletion(user._id, post._id);

    await PostModel.updateOne({ _id: post._id }, { $set: { status: 'CLOSED' } });

    const result = await svc.claim(codeId, user._id);
    expect(result.plaintextCode).toBe(plaintext);
  });
});

describe('RedeemCodeService.listForPost', () => {
  it('returns status-only rows and never includes codeCt/plaintext', async () => {
    const encryptor = new InMemoryEncryptor();
    const admin = new AdminRedeemCodeService({ encryptor, hashSecret: HASH_SECRET });
    const svc = new RedeemCodeService({ encryptor });

    const post = await mkPost();
    await seedPublishedCode(admin, svc, post, 'LIST-1');
    await seedPublishedCode(admin, svc, post, 'LIST-2');
    const user = await mkUser();
    await mkCompletion(user._id, post._id);

    const items = await svc.listForPost({
      postId: post._id,
      userId: user._id,
      userTier: 'PUBLIC',
    });
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.status).toBe('PUBLISHED');
      expect(Object.keys(item).sort()).toEqual(['_id', 'denomination', 'status']);
    }
  });
});

describe('RedeemCodeService.markClaimed', () => {
  it('succeeds only for firstCopiedBy; another user gets CODE_NOT_OWNED', async () => {
    const encryptor = new InMemoryEncryptor();
    const admin = new AdminRedeemCodeService({ encryptor, hashSecret: HASH_SECRET });
    const svc = new RedeemCodeService({ encryptor });

    const post = await mkPost();
    const { codeId } = await seedPublishedCode(admin, svc, post, 'OWNED-1');
    const copier = await mkUser();
    const other = await mkUser();
    await mkCompletion(copier._id, post._id);

    await svc.claim(codeId, copier._id);

    await expect(svc.markClaimed(codeId, other._id)).rejects.toMatchObject({
      code: 'CODE_NOT_OWNED',
    });
    await svc.markClaimed(codeId, copier._id);

    const after = await RedeemCodeModel.findById(codeId);
    expect(after?.status).toBe('CLAIMED');
    expect(String(after?.claimedBy)).toBe(String(copier._id));
  });

  it('markClaimed on a still-PUBLISHED code (never copied) gets CODE_NOT_OWNED', async () => {
    const encryptor = new InMemoryEncryptor();
    const admin = new AdminRedeemCodeService({ encryptor, hashSecret: HASH_SECRET });
    const svc = new RedeemCodeService({ encryptor });

    const post = await mkPost();
    const { codeId } = await seedPublishedCode(admin, svc, post, 'STILL-PUB');
    const user = await mkUser();

    await expect(svc.markClaimed(codeId, user._id)).rejects.toMatchObject({
      code: 'CODE_NOT_OWNED',
    });
  });
});
