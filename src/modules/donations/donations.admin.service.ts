import type { FilterQuery, Types } from 'mongoose';
import { NotFoundError } from '../../shared/errors/AppError.js';
import type { DonationAttrs } from '../../shared/models/Donation.model.js';
import { DonationRepository } from '../../shared/repositories/Donation.repository.js';

export interface AdminListDonationsFilter {
  userId?: Types.ObjectId;
  status?: DonationAttrs['status'];
  from?: Date;
  to?: Date;
}

export interface AdminListDonationsResult {
  items: DonationAttrs[];
  nextCursor?: string;
}

export interface AdminDonationServiceDeps {
  donationRepo?: DonationRepository;
}

/**
 * Admin-facing donation operations. Class-only in Phase 5; HTTP
 * routes + RBAC + audit-log middleware land in Phase 8.
 * `actorId` is accepted on mutating methods so the Phase 8 audit
 * wiring is a signature-compatible upgrade.
 */
export class AdminDonationService {
  private readonly donationRepo: DonationRepository;

  constructor(deps: AdminDonationServiceDeps = {}) {
    this.donationRepo = deps.donationRepo ?? new DonationRepository();
  }

  async listAll(
    filter: AdminListDonationsFilter,
    _cursor?: string,
    limit = 50,
  ): Promise<AdminListDonationsResult> {
    const q: FilterQuery<DonationAttrs> = {};
    if (filter.userId) q.userId = filter.userId;
    if (filter.status) q.status = filter.status;
    if (filter.from || filter.to) {
      const range: Record<string, Date> = {};
      if (filter.from) range['$gte'] = filter.from;
      if (filter.to) range['$lte'] = filter.to;
      q.createdAt = range;
    }
    const items = await this.donationRepo.find(q, {
      sort: { createdAt: -1, _id: -1 },
      limit: Math.max(1, Math.min(200, limit)),
    });
    return { items };
  }

  /**
   * Mark a donation as featured on the home-feed / top-donor surface.
   * Uses `notes.featured` (no schema churn; `notes` is Mixed on the
   * Donation model). Idempotent — repeat calls are no-ops.
   */
  async markFeatured(donationId: Types.ObjectId, _actorId: Types.ObjectId): Promise<void> {
    const res = await this.donationRepo.updateOne(
      { _id: donationId },
      { $set: { 'notes.featured': true } },
    );
    if (res.matchedCount === 0) {
      throw new NotFoundError('Donation not found');
    }
  }

  /** Audit before-snapshot helper used by the Phase 8 auditLog middleware. */
  async getForAudit(donationId: Types.ObjectId | string): Promise<DonationAttrs | null> {
    return this.donationRepo.findById(donationId);
  }
}
