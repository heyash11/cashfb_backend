import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { DonationModel } from '../../shared/models/Donation.model.js';
import { MODELS } from '../../shared/models/index.js';
import { AdminDonationService } from './donations.admin.service.js';

type AnyModel = { syncIndexes(): Promise<string[]> };

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

describe('AdminDonationService.listAll', () => {
  it('returns donations sorted newest-first', async () => {
    const svc = new AdminDonationService();
    const userA = new Types.ObjectId();
    await DonationModel.create([
      {
        userId: userA,
        amount: 10000,
        razorpayOrderId: 'order_old',
        status: 'CAPTURED',
        createdAt: new Date('2026-04-10T00:00:00Z'),
      },
      {
        userId: userA,
        amount: 20000,
        razorpayOrderId: 'order_new',
        status: 'CAPTURED',
        createdAt: new Date('2026-04-20T00:00:00Z'),
      },
      {
        userId: userA,
        amount: 15000,
        razorpayOrderId: 'order_mid',
        status: 'CAPTURED',
        createdAt: new Date('2026-04-15T00:00:00Z'),
      },
    ]);

    const { items } = await svc.listAll({});
    expect(items).toHaveLength(3);
    expect(items[0]?.razorpayOrderId).toBe('order_new');
    expect(items[1]?.razorpayOrderId).toBe('order_mid');
    expect(items[2]?.razorpayOrderId).toBe('order_old');
  });

  it('filters by userId, status, and date range', async () => {
    const svc = new AdminDonationService();
    const alice = new Types.ObjectId();
    const bob = new Types.ObjectId();
    await DonationModel.create([
      {
        userId: alice,
        amount: 10000,
        razorpayOrderId: 'o_alice_1',
        status: 'CAPTURED',
        createdAt: new Date('2026-04-15T00:00:00Z'),
      },
      {
        userId: alice,
        amount: 20000,
        razorpayOrderId: 'o_alice_2',
        status: 'FAILED',
        createdAt: new Date('2026-04-20T00:00:00Z'),
      },
      {
        userId: bob,
        amount: 50000,
        razorpayOrderId: 'o_bob_1',
        status: 'CAPTURED',
        createdAt: new Date('2026-04-18T00:00:00Z'),
      },
    ]);

    // Filter by user.
    const aliceOnly = await svc.listAll({ userId: alice });
    expect(aliceOnly.items.map((d) => d.razorpayOrderId).sort()).toEqual([
      'o_alice_1',
      'o_alice_2',
    ]);

    // Filter by status.
    const failedOnly = await svc.listAll({ status: 'FAILED' });
    expect(failedOnly.items).toHaveLength(1);
    expect(failedOnly.items[0]?.razorpayOrderId).toBe('o_alice_2');

    // Filter by date range.
    const midWindow = await svc.listAll({
      from: new Date('2026-04-16T00:00:00Z'),
      to: new Date('2026-04-19T00:00:00Z'),
    });
    expect(midWindow.items).toHaveLength(1);
    expect(midWindow.items[0]?.razorpayOrderId).toBe('o_bob_1');
  });
});

describe('AdminDonationService.markFeatured', () => {
  it('sets notes.featured=true on the donation; idempotent on repeat', async () => {
    const svc = new AdminDonationService();
    const donation = await DonationModel.create({
      userId: new Types.ObjectId(),
      amount: 50000,
      razorpayOrderId: 'o_feat_1',
      status: 'CAPTURED',
    });

    await svc.markFeatured(donation._id, new Types.ObjectId());
    const first = await DonationModel.findById(donation._id);
    expect((first?.notes as { featured?: boolean } | undefined)?.featured).toBe(true);

    // Repeat — still true, no throw.
    await svc.markFeatured(donation._id, new Types.ObjectId());
    const second = await DonationModel.findById(donation._id);
    expect((second?.notes as { featured?: boolean } | undefined)?.featured).toBe(true);
  });

  it('throws NOT_FOUND for a non-existent donation', async () => {
    const svc = new AdminDonationService();
    await expect(
      svc.markFeatured(new Types.ObjectId(), new Types.ObjectId()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
