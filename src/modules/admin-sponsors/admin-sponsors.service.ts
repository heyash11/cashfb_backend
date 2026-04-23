import type { FilterQuery, Types } from 'mongoose';
import { NotFoundError } from '../../shared/errors/AppError.js';
import type { BrandSponsorAttrs } from '../../shared/models/BrandSponsor.model.js';
import { BrandSponsorRepository } from '../../shared/repositories/BrandSponsor.repository.js';

export interface AdminSponsorsListFilter {
  slot?: number;
  status?: BrandSponsorAttrs['status'];
}

export interface AdminSponsorsListResult {
  items: BrandSponsorAttrs[];
}

export interface AdminSponsorsServiceDeps {
  sponsorRepo?: BrandSponsorRepository;
}

/**
 * Admin CRUD for brand-sponsor slots on the home feed. Hard delete
 * is allowed here (unlike admin-admin-users) because sponsor rows
 * aren't referenced from AuditLog. Status=EXPIRED is the softer
 * alternative that keeps the row around for reporting.
 */
export class AdminSponsorsService {
  private readonly sponsorRepo: BrandSponsorRepository;

  constructor(deps: AdminSponsorsServiceDeps = {}) {
    this.sponsorRepo = deps.sponsorRepo ?? new BrandSponsorRepository();
  }

  async list(filter: AdminSponsorsListFilter): Promise<AdminSponsorsListResult> {
    const q: FilterQuery<BrandSponsorAttrs> = {};
    if (filter.slot !== undefined) q.slot = filter.slot;
    if (filter.status) q.status = filter.status;
    const items = await this.sponsorRepo.find(q, {
      sort: { slot: 1, priority: -1, _id: -1 },
    });
    return { items };
  }

  async getForAudit(id: Types.ObjectId | string): Promise<BrandSponsorAttrs | null> {
    return this.sponsorRepo.findById(id);
  }

  async create(
    input: Omit<BrandSponsorAttrs, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<BrandSponsorAttrs> {
    return this.sponsorRepo.create(input);
  }

  async update(id: Types.ObjectId, patch: Partial<BrandSponsorAttrs>): Promise<BrandSponsorAttrs> {
    const updated = await this.sponsorRepo.findOneAndUpdate({ _id: id }, { $set: patch });
    if (!updated) throw new NotFoundError('Sponsor not found');
    return updated;
  }

  async delete(id: Types.ObjectId): Promise<{ deleted: boolean }> {
    const res = await this.sponsorRepo.deleteOne({ _id: id });
    return { deleted: res.deletedCount === 1 };
  }
}
