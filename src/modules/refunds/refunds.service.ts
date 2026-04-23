import type { Types } from 'mongoose';
import type Razorpay from 'razorpay';
import { getRazorpayClient } from '../../config/razorpay.js';
import { logger } from '../../config/logger.js';
import { NotFoundError } from '../../shared/errors/AppError.js';
import { SubscriptionRepository } from '../../shared/repositories/Subscription.repository.js';
import { SubscriptionPaymentRepository } from '../../shared/repositories/SubscriptionPayment.repository.js';

/**
 * RefundService owns BOTH sides of the refund state machine:
 *   - `initiateRefund` — admin-triggered, drives the Razorpay API.
 *   - `onRefundProcessed` — webhook-driven, finalises local state.
 *
 * It does NOT live on `AdminSubscriptionService` on purpose. Webhook
 * handlers are not admin operations: they have no `actorId`, no RBAC
 * context, and they're invoked by the dispatcher regardless of who
 * (or what) is logged in. Hanging `onRefundProcessed` off an Admin
 * class would force every admin method to tolerate an
 * `actorId?: undefined` exception that every other admin method
 * prohibits. Keeping refunds on their own domain class matches the
 * pattern set by `DonationService.onCaptured` and
 * `SubscriptionService.onCharged/onHalted/onCancelled` — webhook
 * handlers live on the domain class that owns the entity.
 *
 * Phase 7's refund-retry cron and Phase 8's refund report compose
 * cleanly against this surface without dragging in admin semantics.
 */

export interface InitiateRefundInput {
  paymentId: Types.ObjectId;
  reason: string;
  actorId: Types.ObjectId;
  amountPaise?: number; // omit for full refund
  cancelSubscription?: boolean; // default true (PAYMENTS.md §7)
}

export interface InitiateRefundResult {
  razorpayRefundId: string;
}

export interface RazorpayRefundEntity {
  id: string;
  payment_id: string;
  amount: number;
  status?: string;
  notes?: Record<string, unknown>;
}

export interface RazorpayRefundPayload {
  refund: { entity: RazorpayRefundEntity };
}

export interface RefundServiceDeps {
  subPaymentRepo?: SubscriptionPaymentRepository;
  subRepo?: SubscriptionRepository;
  razorpay?: Razorpay;
  clock?: () => Date;
}

export class RefundService {
  private readonly subPaymentRepo: SubscriptionPaymentRepository;
  private readonly subRepo: SubscriptionRepository;
  private readonly clock: () => Date;
  private _razorpay?: Razorpay;

  constructor(deps: RefundServiceDeps = {}) {
    this.subPaymentRepo = deps.subPaymentRepo ?? new SubscriptionPaymentRepository();
    this.subRepo = deps.subRepo ?? new SubscriptionRepository();
    this.clock = deps.clock ?? (() => new Date());
    if (deps.razorpay) this._razorpay = deps.razorpay;
  }

  private get razorpay(): Razorpay {
    return (this._razorpay ??= getRazorpayClient());
  }

  /**
   * Admin-triggered refund. Two sequential Razorpay API calls:
   *   1. payments.refund — creates the refund at Razorpay.
   *   2. subscriptions.cancel (immediate) — MANDATORY per
   *      PAYMENTS.md §7; Razorpay does NOT auto-cancel on refund.
   *
   * These can't be wrapped in a Mongo transaction (external API
   * calls). If the cancel call fails after a successful refund, the
   * admin can retry via a second initiateRefund({cancelSubscription:
   * true}) call which is a no-op on the already-refunded payment
   * and idempotent on the cancel side.
   *
   * Local state is NOT written here. The `refund.processed` webhook
   * (see `onRefundProcessed`) handles the authoritative status
   * update.
   */
  async initiateRefund(input: InitiateRefundInput): Promise<InitiateRefundResult> {
    const payment = await this.subPaymentRepo.findById(input.paymentId);
    if (!payment) throw new NotFoundError('Payment not found');

    const refundParams: Record<string, unknown> = {
      speed: 'normal',
      receipt: `ref_${Date.now()}`,
      notes: { reason: input.reason, actorId: String(input.actorId) },
    };
    if (input.amountPaise !== undefined) refundParams['amount'] = input.amountPaise;

    const refund = await this.razorpay.payments.refund(
      payment.razorpayPaymentId,
      refundParams as Parameters<Razorpay['payments']['refund']>[1],
    );

    const cancelSubscription = input.cancelSubscription ?? true;
    if (cancelSubscription) {
      const sub = await this.subRepo.findById(payment.subscriptionId);
      if (sub) {
        try {
          await this.razorpay.subscriptions.cancel(sub.razorpaySubscriptionId, false);
        } catch (err) {
          // Refund already landed; log + surface to the caller so
          // the admin can retry the cancel. Do NOT swallow.
          logger.error(
            { err, subId: sub.razorpaySubscriptionId, refundId: refund.id },
            '[refund] subscription.cancel failed after successful refund; admin must retry',
          );
          throw err;
        }
      }
    }

    return { razorpayRefundId: refund.id };
  }

  /**
   * Webhook handler for `refund.processed`. Flips the payment status
   * to REFUNDED (or PARTIAL_REFUND if the refund amount is less than
   * the original). Idempotent via the status predicate — a second
   * delivery with the same payment_id sees REFUNDED and no-ops.
   *
   * Tier downgrade is NOT handled here. The full chain is:
   * admin `initiateRefund` → Razorpay processes refund + cancels
   * subscription → `subscription.cancelled` webhook →
   * `SubscriptionService.onCancelled` handles user.tier downgrade
   * transactionally. Future readers wondering why this handler
   * doesn't touch user.tier will see the chain.
   */
  async onRefundProcessed(payload: RazorpayRefundPayload): Promise<void> {
    const entity = payload.refund.entity;
    const payment = await this.subPaymentRepo.findOne({ razorpayPaymentId: entity.payment_id });
    if (!payment) {
      logger.warn(
        { paymentId: entity.payment_id, refundId: entity.id },
        'onRefundProcessed: payment row not found, skipping',
      );
      return;
    }

    const isFull = entity.amount >= (payment.amount ?? 0);
    const nextStatus = isFull ? 'REFUNDED' : 'PARTIAL_REFUND';
    const now = this.clock();

    await this.subPaymentRepo.updateOne(
      {
        _id: payment._id,
        status: { $in: ['CAPTURED', 'PARTIAL_REFUND'] },
      },
      {
        $set: {
          status: nextStatus,
          refundedAt: now,
          refundAmount: entity.amount,
        },
      },
    );
  }
}
