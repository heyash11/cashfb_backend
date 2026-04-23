import type { FilterQuery, Types } from 'mongoose';
import type { SubscriptionAttrs } from '../../shared/models/Subscription.model.js';
import type { SubscriptionPaymentAttrs } from '../../shared/models/SubscriptionPayment.model.js';
import { SubscriptionRepository } from '../../shared/repositories/Subscription.repository.js';
import { SubscriptionPaymentRepository } from '../../shared/repositories/SubscriptionPayment.repository.js';

export interface AdminListSubscriptionsFilter {
  tier?: 'PRO' | 'PRO_MAX';
  status?: SubscriptionAttrs['status'];
}

export interface AdminListSubscriptionsResult {
  items: SubscriptionAttrs[];
  nextCursor?: string;
}

export interface RevenueReport {
  totalPaise: number;
  byTier: Record<'PRO' | 'PRO_MAX', number>;
  count: number;
}

export interface AdminSubscriptionServiceDeps {
  subRepo?: SubscriptionRepository;
  subPaymentRepo?: SubscriptionPaymentRepository;
}

/**
 * Admin-facing subscription operations. Class-only in Phase 5;
 * HTTP + RBAC + audit wiring land in Phase 8. Refund flow lives
 * in `RefundService` (see refunds.service.ts for the reasoning).
 *
 * `getRevenueReport` returns GROSS revenue. Refund deductions are
 * reported separately in Phase 8's refund report; this keeps the
 * two numbers independently audit-able and avoids double-accounting
 * surprises.
 */
export class AdminSubscriptionService {
  private readonly subRepo: SubscriptionRepository;
  private readonly subPaymentRepo: SubscriptionPaymentRepository;

  constructor(deps: AdminSubscriptionServiceDeps = {}) {
    this.subRepo = deps.subRepo ?? new SubscriptionRepository();
    this.subPaymentRepo = deps.subPaymentRepo ?? new SubscriptionPaymentRepository();
  }

  async listAll(
    filter: AdminListSubscriptionsFilter,
    _cursor?: string,
    limit = 50,
  ): Promise<AdminListSubscriptionsResult> {
    const q: FilterQuery<SubscriptionAttrs> = {};
    if (filter.tier) q.tier = filter.tier;
    if (filter.status) q.status = filter.status;
    const items = await this.subRepo.find(q, {
      sort: { createdAt: -1, _id: -1 },
      limit: Math.max(1, Math.min(200, limit)),
    });
    return { items };
  }

  /**
   * Sum of `SubscriptionPayment.amount` over the date window,
   * grouped by tier. Uses the captured-at timestamp (not createdAt)
   * so the report reflects when money actually landed, not when the
   * row was written.
   */
  async getRevenueReport(from: Date, to: Date): Promise<RevenueReport> {
    const payments = await this.subPaymentRepo.find({
      status: { $in: ['CAPTURED', 'PARTIAL_REFUND'] },
      capturedAt: { $gte: from, $lte: to },
    });

    // Tier lives on Subscription, not on SubscriptionPayment — fetch
    // the parent subs in a single batched query to avoid N+1.
    const subIds = [...new Set(payments.map((p) => String(p.subscriptionId)))];
    const subs = await this.subRepo.find({ _id: { $in: subIds } });
    const tierBySubId = new Map<string, SubscriptionAttrs['tier']>();
    for (const s of subs) tierBySubId.set(String(s._id), s.tier);

    let totalPaise = 0;
    const byTier: Record<'PRO' | 'PRO_MAX', number> = { PRO: 0, PRO_MAX: 0 };
    for (const p of payments as SubscriptionPaymentAttrs[]) {
      const amt = p.amount ?? 0;
      totalPaise += amt;
      const tier = tierBySubId.get(String(p.subscriptionId));
      if (tier === 'PRO' || tier === 'PRO_MAX') byTier[tier] += amt;
    }

    return { totalPaise, byTier, count: payments.length };
  }

  /** Audit before-snapshot helper used by the Phase 8 auditLog middleware. */
  async getForAudit(subId: Types.ObjectId | string): Promise<SubscriptionAttrs | null> {
    return this.subRepo.findById(subId);
  }
}
