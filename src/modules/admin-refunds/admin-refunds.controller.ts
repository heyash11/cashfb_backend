import type { Request } from 'express';
import { Types } from 'mongoose';
import type { AuditCaptureContext } from '../../shared/middleware/audit-log.js';
import type { InitiateRefundInput, RefundService } from '../refunds/refunds.service.js';
import { AdminInitiateRefundBodySchema } from './admin-refunds.schemas.js';

/**
 * The refund path calls Razorpay twice (refund + cancel subscription)
 * before control returns. RefundService does NOT write local state —
 * the webhook handler is authoritative. The audit log therefore
 * captures (a) the SubscriptionPayment snapshot as `before` and
 * (b) the Razorpay refundId as `after`. The webhook will add its
 * own audit entry when the refund actually lands.
 */
export class AdminRefundsController {
  constructor(private readonly service: RefundService) {}

  initiate = async (req: Request): Promise<AuditCaptureContext> => {
    const body = AdminInitiateRefundBodySchema.parse(req.body);
    const actorId = new Types.ObjectId(req.admin!.adminId);
    const input: InitiateRefundInput = {
      paymentId: new Types.ObjectId(body.paymentId),
      reason: body.reason,
      actorId,
    };
    if (body.amountPaise !== undefined) input.amountPaise = body.amountPaise;
    if (body.cancelSubscription !== undefined) {
      input.cancelSubscription = body.cancelSubscription;
    }

    const result = await this.service.initiateRefund(input);
    return {
      before: { paymentId: body.paymentId, reason: body.reason },
      after: { razorpayRefundId: result.razorpayRefundId },
      resourceKind: 'SubscriptionPayment',
      resourceId: input.paymentId,
    };
  };
}
