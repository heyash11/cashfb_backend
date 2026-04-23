import { createHmac, timingSafeEqual } from 'node:crypto';
import mongoose, { type Types } from 'mongoose';
import type Razorpay from 'razorpay';
import { env } from '../../config/env.js';
import { getRazorpayClient } from '../../config/razorpay.js';
import { logger } from '../../config/logger.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../shared/errors/AppError.js';
import { enqueueInvoice } from '../../shared/jobs/enqueue.js';
import type { SubscriptionAttrs } from '../../shared/models/Subscription.model.js';
import { SubscriptionModel } from '../../shared/models/Subscription.model.js';
import { SubscriptionPaymentModel } from '../../shared/models/SubscriptionPayment.model.js';
import { AppConfigRepository } from '../../shared/repositories/AppConfig.repository.js';
import { SubscriptionRepository } from '../../shared/repositories/Subscription.repository.js';
import { SubscriptionPaymentRepository } from '../../shared/repositories/SubscriptionPayment.repository.js';
import { UserRepository } from '../../shared/repositories/User.repository.js';

export type Tier = 'PRO' | 'PRO_MAX';

/**
 * Plan pricing baked in at the service level per PAYMENTS.md §2.
 * Amounts are incl. 18% GST, in paise.
 */
const PLAN_PRICING: Record<Tier, { total: number; base: number; gst: number }> = {
  PRO: { total: 5900, base: 5000, gst: 900 },
  PRO_MAX: { total: 11800, base: 10000, gst: 1800 },
};

export interface PlanSummary {
  tier: Tier;
  razorpayPlanId: string;
  baseAmount: number;
  gstAmount: number;
  totalAmount: number;
  billingCycle: 'MONTHLY';
}

export interface CreateSubscriptionInput {
  userId: Types.ObjectId;
  tier: Tier;
}

export interface CreateSubscriptionResult {
  subscriptionId: string;
}

export interface VerifySubscriptionInput {
  razorpay_payment_id: string;
  razorpay_subscription_id: string;
  razorpay_signature: string;
}

export interface CancelInput {
  userId: Types.ObjectId;
  subscriptionId: Types.ObjectId;
  atCycleEnd: boolean;
}

export interface InvoiceListItem {
  invoiceNumber: string;
  pdfUrl: string;
  createdAt: Date;
}

export interface SubscriptionServiceDeps {
  subRepo?: SubscriptionRepository;
  subPaymentRepo?: SubscriptionPaymentRepository;
  userRepo?: UserRepository;
  appConfigRepo?: AppConfigRepository;
  /**
   * Phase 7: invoice generation moved out of the critical path.
   * `onCharged` calls this helper to enqueue an invoice job.
   * Default wires the real BullMQ `invoice` queue (see
   * `src/shared/jobs/enqueue.ts`). Tests inject a spy to avoid
   * opening Redis.
   */
  enqueueInvoice?: (payload: { paymentId: string }) => Promise<void>;
  razorpay?: Razorpay;
  keySecret?: string;
  clock?: () => Date;
}

/**
 * Razorpay subscription webhook payloads. Narrow subset — Razorpay's
 * wire format is wider. Cast at boundary.
 */
export interface RazorpaySubEntity {
  id: string;
  plan_id?: string;
  status?: string;
  current_start?: number; // unix seconds
  current_end?: number;
  paid_count?: number;
  remaining_count?: number;
  total_count?: number;
  charge_at?: number;
  customer_id?: string;
  notes?: Record<string, unknown> & { cancel_at_cycle_end?: number | string };
}

export interface RazorpaySubPayload {
  subscription: { entity: RazorpaySubEntity };
}

export interface RazorpayChargedPayload extends RazorpaySubPayload {
  payment: {
    entity: {
      id: string;
      order_id?: string;
      invoice_id?: string;
      amount: number;
      method?: string;
      status?: string;
    };
  };
}

export class SubscriptionService {
  private readonly subRepo: SubscriptionRepository;
  private readonly subPaymentRepo: SubscriptionPaymentRepository;
  private readonly userRepo: UserRepository;
  private readonly appConfigRepo: AppConfigRepository;
  private readonly enqueueInvoiceFn: (payload: { paymentId: string }) => Promise<void>;
  private readonly keySecret: string;
  private readonly clock: () => Date;
  private _razorpay?: Razorpay;

  constructor(deps: SubscriptionServiceDeps = {}) {
    this.subRepo = deps.subRepo ?? new SubscriptionRepository();
    this.subPaymentRepo = deps.subPaymentRepo ?? new SubscriptionPaymentRepository();
    this.userRepo = deps.userRepo ?? new UserRepository();
    this.appConfigRepo = deps.appConfigRepo ?? new AppConfigRepository();
    this.enqueueInvoiceFn = deps.enqueueInvoice ?? enqueueInvoice;
    this.keySecret = deps.keySecret ?? env.RAZORPAY_KEY_SECRET ?? 'test-secret-unconfigured';
    this.clock = deps.clock ?? (() => new Date());
    if (deps.razorpay) this._razorpay = deps.razorpay;
  }

  private get razorpay(): Razorpay {
    return (this._razorpay ??= getRazorpayClient());
  }

  // --- user-facing ----------------------------------------------------

  async listPlans(): Promise<PlanSummary[]> {
    const cfg = await this.appConfigRepo.findOne({ key: 'default' });
    const planIds = cfg?.razorpayPlanIds ?? {};
    const out: PlanSummary[] = [];
    for (const tier of ['PRO', 'PRO_MAX'] as const) {
      const planId = planIds[tier];
      if (!planId) continue; // plan not migrated yet
      const p = PLAN_PRICING[tier];
      out.push({
        tier,
        razorpayPlanId: planId,
        baseAmount: p.base,
        gstAmount: p.gst,
        totalAmount: p.total,
        billingCycle: 'MONTHLY',
      });
    }
    return out;
  }

  async create(input: CreateSubscriptionInput): Promise<CreateSubscriptionResult> {
    const cfg = await this.appConfigRepo.findOne({ key: 'default' });
    const planId = cfg?.razorpayPlanIds?.[input.tier];
    if (!planId) {
      throw new BadRequestError(
        'PLAN_NOT_CONFIGURED',
        `Razorpay plan for ${input.tier} is not set — run pnpm migrate:plans.`,
      );
    }

    const sub = await this.razorpay.subscriptions.create({
      plan_id: planId,
      total_count: 360,
      customer_notify: 1,
      notes: { internal_user_id: String(input.userId) },
    });

    const p = PLAN_PRICING[input.tier];
    await this.subRepo.create({
      userId: input.userId,
      tier: input.tier,
      razorpaySubscriptionId: sub.id,
      razorpayPlanId: planId,
      status: 'CREATED',
      billingCycle: 'MONTHLY',
      baseAmount: p.base,
      gstAmount: p.gst,
      totalAmount: p.total,
      autoRenew: true,
      paidCount: 0,
    });

    return { subscriptionId: sub.id };
  }

  /**
   * Tentative local verify. The signature format is
   * `HMAC-SHA256(keySecret, "${payment_id}|${subscription_id}")` —
   * note the order differs from donation verify (order|payment).
   * See PAYMENTS.md §4.
   */
  async verify(input: VerifySubscriptionInput): Promise<{ tentativeStatus: 'PENDING_WEBHOOK' }> {
    const payload = `${input.razorpay_payment_id}|${input.razorpay_subscription_id}`;
    const generated = createHmac('sha256', this.keySecret).update(payload).digest('hex');
    const sigBuf = Buffer.from(input.razorpay_signature, 'hex');
    const genBuf = Buffer.from(generated, 'hex');
    if (sigBuf.length !== genBuf.length || !timingSafeEqual(sigBuf, genBuf)) {
      throw new BadRequestError('INVALID_SIGNATURE', 'Subscription signature did not verify');
    }
    return { tentativeStatus: 'PENDING_WEBHOOK' };
  }

  async cancel(input: CancelInput): Promise<void> {
    const sub = await this.subRepo.findById(input.subscriptionId);
    if (!sub) throw new NotFoundError('Subscription not found');
    if (String(sub.userId) !== String(input.userId)) {
      throw new ForbiddenError('FORBIDDEN', 'Subscription belongs to another user');
    }

    await this.razorpay.subscriptions.cancel(sub.razorpaySubscriptionId, input.atCycleEnd);

    await this.subRepo.updateOne(
      { _id: sub._id },
      {
        $set: {
          cancelledAt: this.clock(),
          ...(input.atCycleEnd ? {} : { status: 'CANCELLED' as const }),
        },
      },
    );
  }

  async listMine(userId: Types.ObjectId): Promise<SubscriptionAttrs[]> {
    return this.subRepo.find({ userId }, { sort: { createdAt: -1 } });
  }

  /**
   * Invoice generation is async as of Phase 7 — after a charge
   * captures, `onCharged` enqueues an `invoice-generate` job rather
   * than computing inline. There is a window (typically seconds,
   * occasionally up to ~1 minute under worker backlog) where the
   * payment row exists but `invoiceNumber` / `invoicePdfUrl` are
   * not yet populated. This list filters out those in-flight rows
   * so the user's invoice history never includes half-written
   * entries. See API.md §6 for the user-facing contract.
   */
  async listInvoices(
    userId: Types.ObjectId,
    subscriptionId: Types.ObjectId,
  ): Promise<InvoiceListItem[]> {
    const sub = await this.subRepo.findById(subscriptionId);
    if (!sub) throw new NotFoundError('Subscription not found');
    if (String(sub.userId) !== String(userId)) {
      throw new ForbiddenError('FORBIDDEN', 'Subscription belongs to another user');
    }
    const payments = await this.subPaymentRepo.find(
      { subscriptionId },
      { sort: { createdAt: -1 } },
    );
    return payments
      .filter((p) => p.invoiceNumber && p.invoicePdfUrl)
      .map((p) => ({
        invoiceNumber: p.invoiceNumber as string,
        pdfUrl: p.invoicePdfUrl as string,
        createdAt: p.createdAt,
      }));
  }

  // --- webhook handlers -----------------------------------------------

  async onAuthenticated(payload: RazorpaySubPayload): Promise<void> {
    await this.applySubStatus(payload.subscription.entity, 'AUTHENTICATED');
  }

  async onActivated(payload: RazorpaySubPayload): Promise<void> {
    await this.applySubStatus(payload.subscription.entity, 'ACTIVE');
  }

  async onPending(payload: RazorpaySubPayload): Promise<void> {
    await this.applySubStatus(payload.subscription.entity, 'PENDING');
  }

  async onPaused(payload: RazorpaySubPayload): Promise<void> {
    await this.applySubStatus(payload.subscription.entity, 'PAUSED');
  }

  async onResumed(payload: RazorpaySubPayload): Promise<void> {
    await this.applySubStatus(payload.subscription.entity, 'ACTIVE');
  }

  async onCompleted(payload: RazorpaySubPayload): Promise<void> {
    await this.applySubStatus(payload.subscription.entity, 'COMPLETED');
  }

  /**
   * subscription.charged — the money event. Three writes
   * (SubscriptionPayment create, Subscription paidCount/tier update,
   * User tier+tierExpiresAt update) must land atomically so a mid-
   * sequence crash can't leave a user paid-but-not-upgraded. On
   * retry, the webhook re-fires and hits a race-safe idempotency gate
   * (pattern 1 upsert with $setOnInsert + branch on upsertedId) so
   * the re-run no-ops cleanly without re-running the transaction.
   *
   * Invoice generation is enqueued to the BullMQ `invoice` queue
   * AFTER the transaction commits. Phase 7 moved invoice PDF + S3
   * upload + SES email out of the critical path so a user's tier
   * upgrade lands immediately and the heavier side-effect pipeline
   * runs in a worker. API consumers see up to ~1 minute between
   * charge capture and invoice availability (see API.md §6).
   *
   * Mirrors the multi-write transaction pattern already used in
   * Phase 2 signup, Phase 3 vote cast, and Phase 3 post completion.
   */
  async onCharged(payload: RazorpayChargedPayload): Promise<void> {
    const subEntity = payload.subscription.entity;
    const payEntity = payload.payment.entity;

    const sub = await this.subRepo.findOne({ razorpaySubscriptionId: subEntity.id });
    if (!sub) {
      logger.warn({ subId: subEntity.id }, 'onCharged: subscription not found, skipping');
      return;
    }
    const user = await this.userRepo.findById(sub.userId);
    if (!user) {
      logger.warn({ userId: String(sub.userId) }, 'onCharged: user not found, skipping');
      return;
    }

    const now = this.clock();
    const currentEnd = subEntity.current_end ? new Date(subEntity.current_end * 1000) : undefined;

    // Pattern 1 per CONVENTIONS.md §Transactions: idempotent insert
    // via $setOnInsert + branch on upsertedId. Safe inside a
    // transaction because no write failure occurs on match; the
    // transaction stays alive and we return a skip flag.
    const paymentData: Record<string, unknown> = {
      subscriptionId: sub._id,
      userId: sub.userId,
      razorpayPaymentId: payEntity.id,
      amount: payEntity.amount,
      sacCode: '998439',
      status: 'CAPTURED',
      capturedAt: now,
    };
    if (payEntity.order_id !== undefined) paymentData['razorpayOrderId'] = payEntity.order_id;
    if (payEntity.invoice_id !== undefined) paymentData['razorpayInvoiceId'] = payEntity.invoice_id;
    if (payEntity.method !== undefined) paymentData['method'] = payEntity.method;

    const set: Record<string, unknown> = { status: 'ACTIVE' };
    if (subEntity.current_start) set['currentStart'] = new Date(subEntity.current_start * 1000);
    if (currentEnd) set['currentEnd'] = currentEnd;
    if (subEntity.charge_at) set['chargeAt'] = new Date(subEntity.charge_at * 1000);
    if (typeof subEntity.remaining_count === 'number') {
      set['remainingCount'] = subEntity.remaining_count;
    }
    const subUpdate: Record<string, unknown> = { $set: set };
    if (typeof subEntity.paid_count === 'number') {
      set['paidCount'] = subEntity.paid_count;
    } else {
      subUpdate['$inc'] = { paidCount: 1 };
    }

    const userUpdate: Record<string, unknown> = { tier: sub.tier };
    if (currentEnd) userUpdate['tierExpiresAt'] = currentEnd;

    const session = await mongoose.startSession();
    let paymentId: Types.ObjectId | null = null;
    try {
      const result = await session.withTransaction<{ paymentId: Types.ObjectId } | null>(
        async () => {
          const upsertRes = await SubscriptionPaymentModel.updateOne(
            { razorpayPaymentId: payEntity.id },
            { $setOnInsert: paymentData },
            { upsert: true, session },
          );
          if (!upsertRes.upsertedId) {
            // Already processed — the whole transaction commits as a
            // harmless no-op (the upsert was a no-op on match).
            return null;
          }

          await this.subRepo.updateOne({ _id: sub._id }, subUpdate, { session });
          await this.userRepo.updateOne({ _id: user._id }, { $set: userUpdate }, { session });

          return { paymentId: upsertRes.upsertedId as unknown as Types.ObjectId };
        },
      );
      if (!result) return;
      paymentId = result.paymentId;
    } finally {
      await session.endSession();
    }

    // OUTSIDE the transaction: invoice generation is now async.
    // Phase 7 moved invoice PDF + S3 + SES out of the critical path
    // by enqueueing an `invoice-generate` job. The user's tier
    // upgrade already committed inside the transaction above; the
    // invoice row is populated "eventually" by the worker (typically
    // seconds; can stretch to a minute under worker backlog).
    //
    // Best-effort enqueue (Phase 7 Chunk 2 §onCharged failure mode
    // option a): if Redis is down at this exact commit moment, we
    // log + alert but DO NOT roll back the tier upgrade. A user
    // stranded without an invoice is recoverable manually (admin
    // re-enqueue) and rare in practice. The alternative (option b,
    // invoiceQueueStatus + orphan-sweep cron) is a Phase 9 decision
    // if production shows enqueue-time Redis unavailability is a
    // real failure mode.
    if (paymentId) {
      try {
        await this.enqueueInvoiceFn({ paymentId: String(paymentId) });
      } catch (err) {
        logger.error(
          { err, paymentId: String(paymentId) },
          'onCharged: enqueueInvoice failed (Redis down?); payment captured but invoice not scheduled',
        );
      }
    }
  }

  /**
   * Mandate failed its retry cycle — downgrade the user immediately.
   * Two writes (Subscription status + User tier) wrapped in one
   * transaction so a mid-sequence crash can't leave a halted
   * subscription paired with an un-downgraded user.
   */
  async onHalted(payload: RazorpaySubPayload): Promise<void> {
    const entity = payload.subscription.entity;
    const sub = await this.subRepo.findOne({ razorpaySubscriptionId: entity.id });
    if (!sub) return;
    const now = this.clock();
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await this.subRepo.updateOne({ _id: sub._id }, { $set: { status: 'HALTED' } }, { session });
        await this.userRepo.updateOne(
          { _id: sub.userId },
          { $set: { tier: 'PUBLIC', tierExpiresAt: now } },
          { session },
        );
      });
    } finally {
      await session.endSession();
    }
  }

  /**
   * Cancellation. Razorpay sends `cancel_at_cycle_end` in the
   * entity's notes. atCycleEnd=true → user.tier persists to
   * tierExpiresAt (already set by prior `charged`). atCycleEnd=false
   * → downgrade immediately. Both writes (Subscription status + User
   * tier, when applicable) in one transaction.
   */
  async onCancelled(payload: RazorpaySubPayload): Promise<void> {
    const entity = payload.subscription.entity;
    const sub = await this.subRepo.findOne({ razorpaySubscriptionId: entity.id });
    if (!sub) return;

    const atCycleEnd =
      entity.notes?.cancel_at_cycle_end === 1 || entity.notes?.cancel_at_cycle_end === '1';

    const now = this.clock();
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await this.subRepo.updateOne(
          { _id: sub._id },
          { $set: { status: 'CANCELLED', cancelledAt: now } },
          { session },
        );
        if (!atCycleEnd) {
          await this.userRepo.updateOne(
            { _id: sub.userId },
            { $set: { tier: 'PUBLIC', tierExpiresAt: now } },
            { session },
          );
        }
      });
    } finally {
      await session.endSession();
    }
  }

  // --- helpers ---------------------------------------------------------

  private async applySubStatus(
    entity: RazorpaySubEntity,
    status: SubscriptionAttrs['status'],
  ): Promise<void> {
    await SubscriptionModel.updateOne({ razorpaySubscriptionId: entity.id }, { $set: { status } });
  }
}
