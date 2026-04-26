import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Types } from 'mongoose';
import type Razorpay from 'razorpay';
import { env } from '../../config/env.js';
import { getRazorpayClient } from '../../config/razorpay.js';
import { BadRequestError } from '../../shared/errors/AppError.js';
import type { DonationAttrs } from '../../shared/models/Donation.model.js';
import { DonationModel } from '../../shared/models/Donation.model.js';
import type { TopDonorRankingAttrs } from '../../shared/models/TopDonorRanking.model.js';
import { TopDonorRankingModel } from '../../shared/models/TopDonorRanking.model.js';
import { DonationRepository } from '../../shared/repositories/Donation.repository.js';
import { TopDonorRankingRepository } from '../../shared/repositories/TopDonorRanking.repository.js';

export interface CreateDonationOrderInput {
  userId?: Types.ObjectId | null;
  amountInRupees: number;
  displayName?: string;
  isAnonymous?: boolean;
  socialLinks?: DonationAttrs['socialLinks'];
  message?: string;
  ipAddress?: string;
}

export interface CreateDonationOrderResult {
  orderId: string;
  amount: number;
  keyId: string;
}

export interface VerifyDonationInput {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

/**
 * Minimal shape of the Razorpay payment-captured webhook payload the
 * donation handler relies on. The wider Razorpay envelope has more
 * fields; we narrow to what we actually read. Verified at runtime
 * before use.
 */
export interface RazorpayCapturedPayload {
  payment: {
    entity: {
      id: string;
      order_id: string;
      amount: number;
      status: string;
      captured?: boolean;
      method?: string;
    };
  };
}

export interface DonationServiceDeps {
  donationRepo?: DonationRepository;
  topDonorRepo?: TopDonorRankingRepository;
  razorpay?: Razorpay;
  keyId?: string;
  keySecret?: string;
}

/**
 * User-facing donation flow. Ownership of authoritative state sits
 * with the webhook handler — `verify()` is tentative-only per
 * PAYMENTS.md §3.
 */
export class DonationService {
  private readonly donationRepo: DonationRepository;
  private readonly topDonorRepo: TopDonorRankingRepository;
  private readonly keyId: string;
  private readonly keySecret: string;
  private _razorpay?: Razorpay;

  constructor(deps: DonationServiceDeps = {}) {
    this.donationRepo = deps.donationRepo ?? new DonationRepository();
    this.topDonorRepo = deps.topDonorRepo ?? new TopDonorRankingRepository();
    this.keyId = deps.keyId ?? env.RAZORPAY_KEY_ID ?? 'rzp_test_unconfigured';
    this.keySecret = deps.keySecret ?? env.RAZORPAY_KEY_SECRET ?? 'test-secret-unconfigured';
    if (deps.razorpay) this._razorpay = deps.razorpay;
  }

  private get razorpay(): Razorpay {
    return (this._razorpay ??= getRazorpayClient());
  }

  async createOrder(input: CreateDonationOrderInput): Promise<CreateDonationOrderResult> {
    const amountPaise = input.amountInRupees * 100;
    const receipt = `don_${Date.now()}_${input.userId ? String(input.userId) : 'anon'}`.slice(
      0,
      40,
    );

    const order = await this.razorpay.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt,
      notes: {
        donorUserId: input.userId ? String(input.userId) : '',
        purpose: 'donation',
      },
    });

    const create: Partial<DonationAttrs> = {
      amount: amountPaise,
      razorpayOrderId: order.id,
      status: 'CREATED',
      isAnonymous: input.isAnonymous ?? false,
    };
    if (input.userId) create.userId = input.userId;
    if (input.displayName !== undefined) create.displayName = input.displayName;
    if (input.socialLinks !== undefined) create.socialLinks = input.socialLinks;
    if (input.message !== undefined) create.message = input.message;
    if (input.ipAddress !== undefined) create.ipAddress = input.ipAddress;

    await this.donationRepo.create(create);

    return {
      orderId: order.id,
      amount: Number(order.amount),
      keyId: this.keyId,
    };
  }

  /**
   * Local signature verification. Returns tentative status only —
   * the webhook is the authoritative source for CAPTURED. We
   * deliberately do NOT mutate the donation row here, so a forged
   * `verify` call without a matching webhook can't move a donation
   * to CAPTURED.
   */
  async verify(input: VerifyDonationInput): Promise<{ tentativeStatus: 'PENDING_WEBHOOK' }> {
    const payload = `${input.razorpay_order_id}|${input.razorpay_payment_id}`;
    const generated = createHmac('sha256', this.keySecret).update(payload).digest('hex');

    const sigBuf = Buffer.from(input.razorpay_signature, 'hex');
    const genBuf = Buffer.from(generated, 'hex');
    if (sigBuf.length !== genBuf.length || !timingSafeEqual(sigBuf, genBuf)) {
      throw new BadRequestError('INVALID_SIGNATURE', 'Donation signature did not verify');
    }
    return { tentativeStatus: 'PENDING_WEBHOOK' };
  }

  async getTopDonor(): Promise<TopDonorRankingAttrs | null> {
    return this.topDonorRepo.findOne({ rank: 1 });
  }

  async listTopDonors(limit: number): Promise<TopDonorRankingAttrs[]> {
    return this.topDonorRepo.find({}, { sort: { rank: 1 }, limit });
  }

  /**
   * Authoritative capture transition driven by the webhook. Idempotent
   * via the `razorpayOrderId` unique index + the predicate on
   * `status: 'CREATED'` — a second delivery finds the donation already
   * CAPTURED and no-ops.
   */
  async onCaptured(payload: RazorpayCapturedPayload): Promise<void> {
    const entity = payload.payment.entity;
    await this.donationRepo.updateOne(
      { razorpayOrderId: entity.order_id, status: 'CREATED' },
      {
        $set: {
          status: 'CAPTURED',
          razorpayPaymentId: entity.id,
          capturedAt: new Date(),
        },
      },
    );
  }

  /**
   * Recompute the top-donor leaderboard from CAPTURED donations and
   * overwrite `top_donor_rankings`. Meant to run periodically as a
   * cron job (Phase 7 wires it via BullMQ at 5-minute cadence).
   *
   * No locking in Phase 5: the computation is deterministic over the
   * same input set, so two parallel refreshes produce the same
   * output with harmless last-writer-wins semantics. Phase 7's
   * BullMQ scheduler prevents concurrent cron fires via its own
   * singleton locking (scheduler.limiter + jobId dedup); do NOT
   * rely on this method being called from multiple arbitrary
   * callers in parallel.
   *
   * Partial refunds are NOT netted against totals in Phase 5 — the
   * top-donor surface is a UX signal, not a compliance report. If
   * refund accounting matters later, switch to aggregating net of
   * SubscriptionPayment refunds and reassess.
   */
  async refreshTopDonorRanking(input: { limit?: number } = {}): Promise<{ rankingCount: number }> {
    const limit = Math.max(1, Math.min(1000, input.limit ?? 50));

    // Aggregation contract:
    //   $match  — CAPTURED only, userId !== null (logged-in donors),
    //             isAnonymous !== true (donor explicitly chose to
    //             hide). Pre-aggregate filter — anonymous donations
    //             are excluded from the donor's total, not just
    //             hidden-by-name. A donor with only anonymous
    //             donations does not appear on the leaderboard.
    //   $group  — sum + count per donor
    //   $sort   — leaderboard order
    //   $limit  — top-N cap
    //   $lookup donations → most recent CAPTURED non-anonymous donation
    //             per donor, project displayName + socialLinks. The
    //             {userId, status, createdAt} index serves this directly.
    //             createdAt over capturedAt: index alignment, with
    //             rare delayed-capture orders the gap is seconds.
    //   $lookup users     → profile-level avatarUrl per donor.
    //   $project          — flatten the lookup arrays onto a row shape
    //             matching TopDonorRankingAttrs.
    const aggregated = await DonationModel.aggregate<{
      _id: Types.ObjectId;
      totalDonated: number;
      donationCount: number;
      displayName?: string;
      avatarUrl?: string;
      socialLinks?: { youtube?: string; facebook?: string; instagram?: string };
    }>([
      { $match: { status: 'CAPTURED', userId: { $ne: null }, isAnonymous: { $ne: true } } },
      {
        $group: {
          _id: '$userId',
          totalDonated: { $sum: '$amount' },
          donationCount: { $sum: 1 },
        },
      },
      { $sort: { totalDonated: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: 'donations',
          let: { donorId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$userId', '$$donorId'] },
                    { $eq: ['$status', 'CAPTURED'] },
                    { $ne: ['$isAnonymous', true] },
                  ],
                },
              },
            },
            { $sort: { createdAt: -1, _id: -1 } },
            { $limit: 1 },
            { $project: { _id: 0, displayName: 1, socialLinks: 1 } },
          ],
          as: 'latestDonation',
        },
      },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          pipeline: [{ $project: { _id: 0, avatarUrl: 1 } }],
          as: 'donor',
        },
      },
      {
        $project: {
          _id: 1,
          totalDonated: 1,
          donationCount: 1,
          displayName: { $arrayElemAt: ['$latestDonation.displayName', 0] },
          socialLinks: { $arrayElemAt: ['$latestDonation.socialLinks', 0] },
          avatarUrl: { $arrayElemAt: ['$donor.avatarUrl', 0] },
        },
      },
    ]).exec();

    await TopDonorRankingModel.deleteMany({});
    if (aggregated.length === 0) return { rankingCount: 0 };

    const now = new Date();
    const docs: Array<Partial<TopDonorRankingAttrs>> = aggregated.map((row, i) => ({
      rank: i + 1,
      userId: row._id,
      totalDonated: row.totalDonated,
      donationCount: row.donationCount,
      computedAt: now,
      // Conditional spreads: undefined / empty-string leaves are
      // omitted entirely so the document doesn't pollute reads with
      // null leaves. Falsy-omit per §A3 (whitespace-only displayName
      // is rejected at donation-creation intake, so a falsy here
      // means the donor never set one).
      ...(row.displayName ? { displayName: row.displayName } : {}),
      ...(row.avatarUrl ? { avatarUrl: row.avatarUrl } : {}),
      ...(row.socialLinks ? { socialLinks: row.socialLinks } : {}),
    }));
    await TopDonorRankingModel.insertMany(docs);
    return { rankingCount: aggregated.length };
  }
}
