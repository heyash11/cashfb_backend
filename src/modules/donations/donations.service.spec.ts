import { createHmac } from 'node:crypto';
import { Types } from 'mongoose';
import type Razorpay from 'razorpay';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { DonationModel } from '../../shared/models/Donation.model.js';
import { MODELS } from '../../shared/models/index.js';
import { TopDonorRankingModel } from '../../shared/models/TopDonorRanking.model.js';
import { DonationService } from './donations.service.js';

type AnyModel = { syncIndexes(): Promise<string[]> };

const TEST_KEY_ID = 'rzp_test_SgpIOTC11CLap6';
const TEST_KEY_SECRET = 'unit-test-key-secret-0000';

/**
 * Minimal structural fake satisfying the Razorpay shape the service
 * uses. Cast via `as unknown as Razorpay` at the call site; the SDK
 * surface is much wider but we only touch `orders.create` in this
 * chunk.
 */
function mkFakeRazorpay(
  orderOverrides: Partial<{ id: string; amount: number; currency: string }> = {},
): { rzp: Razorpay; createSpy: ReturnType<typeof vi.fn> } {
  const createSpy = vi.fn(
    async (params: { amount: number; currency: string }) =>
      ({
        id: orderOverrides.id ?? `order_${Date.now()}`,
        amount: orderOverrides.amount ?? params.amount,
        currency: orderOverrides.currency ?? params.currency,
        status: 'created',
      }) as { id: string; amount: number; currency: string; status: string },
  );
  const rzp = { orders: { create: createSpy } } as unknown as Razorpay;
  return { rzp, createSpy };
}

function mkSvc(
  overrides: Partial<ConstructorParameters<typeof DonationService>[0]> = {},
): DonationService {
  const { rzp } = mkFakeRazorpay();
  return new DonationService({
    razorpay: rzp,
    keyId: TEST_KEY_ID,
    keySecret: TEST_KEY_SECRET,
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

describe('DonationService.createOrder', () => {
  it('creates a Razorpay order and persists a CREATED Donation with the returned order id', async () => {
    const { rzp, createSpy } = mkFakeRazorpay({ id: 'order_test_111', amount: 50000 });
    const svc = new DonationService({
      razorpay: rzp,
      keyId: TEST_KEY_ID,
      keySecret: TEST_KEY_SECRET,
    });
    const userId = new Types.ObjectId();

    const result = await svc.createOrder({
      userId,
      amountInRupees: 500,
      displayName: 'Alice',
      message: 'Keep it up',
    });

    expect(result).toEqual({ orderId: 'order_test_111', amount: 50000, keyId: TEST_KEY_ID });
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 50000, currency: 'INR' }),
    );

    const saved = await DonationModel.findOne({ razorpayOrderId: 'order_test_111' });
    expect(saved).toBeTruthy();
    expect(saved?.status).toBe('CREATED');
    expect(saved?.amount).toBe(50000);
    expect(String(saved?.userId)).toBe(String(userId));
    expect(saved?.displayName).toBe('Alice');
    expect(saved?.message).toBe('Keep it up');
  });

  it('accepts anonymous donations with no userId and isAnonymous=true', async () => {
    const { rzp } = mkFakeRazorpay({ id: 'order_anon_1', amount: 10000 });
    const svc = new DonationService({
      razorpay: rzp,
      keyId: TEST_KEY_ID,
      keySecret: TEST_KEY_SECRET,
    });

    await svc.createOrder({ userId: null, amountInRupees: 100, isAnonymous: true });

    const saved = await DonationModel.findOne({ razorpayOrderId: 'order_anon_1' });
    expect(saved).toBeTruthy();
    expect(saved?.userId).toBeUndefined();
    expect(saved?.isAnonymous).toBe(true);
    expect(saved?.displayName).toBeUndefined();
  });
});

describe('DonationService.verify', () => {
  it('returns tentativeStatus PENDING_WEBHOOK on a valid signature and DOES NOT mutate the donation', async () => {
    const svc = mkSvc();
    const orderId = 'order_verify_1';
    const paymentId = 'pay_verify_1';
    await DonationModel.create({
      amount: 10000,
      razorpayOrderId: orderId,
      status: 'CREATED',
    });

    const sig = createHmac('sha256', TEST_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    const result = await svc.verify({
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: sig,
    });
    expect(result).toEqual({ tentativeStatus: 'PENDING_WEBHOOK' });

    // Webhook is authoritative — verify must not move status to CAPTURED.
    const after = await DonationModel.findOne({ razorpayOrderId: orderId });
    expect(after?.status).toBe('CREATED');
    expect(after?.razorpayPaymentId).toBeUndefined();
  });

  it('throws INVALID_SIGNATURE when the HMAC does not match', async () => {
    const svc = mkSvc();
    await expect(
      svc.verify({
        razorpay_order_id: 'order_x',
        razorpay_payment_id: 'pay_x',
        // Valid hex but wrong value; same length as real HMAC so we
        // exercise the timingSafeEqual path rather than the
        // length-mismatch short-circuit.
        razorpay_signature: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
  });

  it('signature format is HMAC-SHA256 of `${orderId}|${paymentId}` with the key secret', async () => {
    const svc = mkSvc();
    const orderId = 'order_fmt';
    const paymentId = 'pay_fmt';
    const expected = createHmac('sha256', TEST_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    // If this call resolves, the service computed the same HMAC.
    await svc.verify({
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: expected,
    });
  });
});

describe('DonationService.getTopDonor / listTopDonors', () => {
  it('getTopDonor returns the rank 1 entry from top_donor_rankings', async () => {
    const svc = mkSvc();
    await TopDonorRankingModel.create([
      { rank: 1, displayName: 'Alice', totalDonated: 500000 },
      { rank: 2, displayName: 'Bob', totalDonated: 200000 },
    ]);

    const donor = await svc.getTopDonor();
    expect(donor?.displayName).toBe('Alice');
  });

  it('listTopDonors returns ascending by rank up to the limit', async () => {
    const svc = mkSvc();
    await TopDonorRankingModel.create([
      { rank: 3, displayName: 'C', totalDonated: 100 },
      { rank: 1, displayName: 'A', totalDonated: 300 },
      { rank: 2, displayName: 'B', totalDonated: 200 },
    ]);

    const list = await svc.listTopDonors(2);
    expect(list).toHaveLength(2);
    expect(list[0]?.displayName).toBe('A');
    expect(list[1]?.displayName).toBe('B');
  });
});

describe('DonationService.refreshTopDonorRanking', () => {
  it('aggregates CAPTURED donations per user, sorts by total desc, overwrites top_donor_rankings', async () => {
    const svc = mkSvc();
    const alice = new Types.ObjectId();
    const bob = new Types.ObjectId();
    const carol = new Types.ObjectId();

    // Alice: 3 captured totaling 50000. Bob: 1 × 30000. Carol: 2 × 10000.
    // One FAILED donation for Alice that must NOT count.
    await DonationModel.create([
      { userId: alice, amount: 20000, razorpayOrderId: 'a1', status: 'CAPTURED' },
      { userId: alice, amount: 20000, razorpayOrderId: 'a2', status: 'CAPTURED' },
      { userId: alice, amount: 10000, razorpayOrderId: 'a3', status: 'CAPTURED' },
      { userId: alice, amount: 99999, razorpayOrderId: 'a_failed', status: 'FAILED' },
      { userId: bob, amount: 30000, razorpayOrderId: 'b1', status: 'CAPTURED' },
      { userId: carol, amount: 5000, razorpayOrderId: 'c1', status: 'CAPTURED' },
      { userId: carol, amount: 5000, razorpayOrderId: 'c2', status: 'CAPTURED' },
    ]);

    // Stale ranking row that must be overwritten.
    await TopDonorRankingModel.create({
      rank: 1,
      userId: new Types.ObjectId(),
      totalDonated: 999999,
    });

    const result = await svc.refreshTopDonorRanking();
    expect(result.rankingCount).toBe(3);

    const rows = await TopDonorRankingModel.find({}).sort({ rank: 1 }).lean();
    expect(rows).toHaveLength(3);

    expect(rows[0]?.rank).toBe(1);
    expect(String(rows[0]?.userId)).toBe(String(alice));
    expect(rows[0]?.totalDonated).toBe(50000);
    expect(rows[0]?.donationCount).toBe(3);

    expect(rows[1]?.rank).toBe(2);
    expect(String(rows[1]?.userId)).toBe(String(bob));
    expect(rows[1]?.totalDonated).toBe(30000);

    expect(rows[2]?.rank).toBe(3);
    expect(String(rows[2]?.userId)).toBe(String(carol));
    expect(rows[2]?.totalDonated).toBe(10000);
    expect(rows[2]?.donationCount).toBe(2);
  });
});

describe('DonationService.onCaptured (webhook-driven)', () => {
  it('flips a CREATED donation to CAPTURED with paymentId + capturedAt', async () => {
    const svc = mkSvc();
    const orderId = 'order_capt_1';
    await DonationModel.create({ amount: 10000, razorpayOrderId: orderId, status: 'CREATED' });

    await svc.onCaptured({
      payment: {
        entity: {
          id: 'pay_capt_1',
          order_id: orderId,
          amount: 10000,
          status: 'captured',
        },
      },
    });

    const after = await DonationModel.findOne({ razorpayOrderId: orderId });
    expect(after?.status).toBe('CAPTURED');
    expect(after?.razorpayPaymentId).toBe('pay_capt_1');
    expect(after?.capturedAt).toBeInstanceOf(Date);
  });

  it('second onCaptured for the same order is a no-op (idempotent via status predicate)', async () => {
    const svc = mkSvc();
    const orderId = 'order_capt_dup';
    await DonationModel.create({ amount: 10000, razorpayOrderId: orderId, status: 'CREATED' });

    const payload = {
      payment: {
        entity: { id: 'pay_1', order_id: orderId, amount: 10000, status: 'captured' },
      },
    };

    await svc.onCaptured(payload);
    const firstCapturedAt = (await DonationModel.findOne({ razorpayOrderId: orderId }))?.capturedAt;

    // Simulate a redelivery with a different payment id — the predicate
    // on `status: 'CREATED'` blocks the second update.
    await svc.onCaptured({
      payment: {
        entity: { id: 'pay_2_evil', order_id: orderId, amount: 10000, status: 'captured' },
      },
    });

    const after = await DonationModel.findOne({ razorpayOrderId: orderId });
    expect(after?.status).toBe('CAPTURED');
    expect(after?.razorpayPaymentId).toBe('pay_1'); // unchanged
    expect(after?.capturedAt).toEqual(firstCapturedAt);
  });
});
