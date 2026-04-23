import type { FilterQuery, Types } from 'mongoose';
import type { PostAdsConfig, PostAttrs } from '../../shared/models/Post.model.js';
import { PostRepository } from '../../shared/repositories/Post.repository.js';

export interface AdminPostCreateInput {
  title: string;
  description?: string;
  dayKey: string;
  scheduledAt: Date;
  status?: PostAttrs['status'];
  coinReward?: number;
  tierRequired?: PostAttrs['tierRequired'];
  adsConfig?: PostAdsConfig;
}

export interface AdminPostUpdateInput {
  title?: string;
  description?: string;
  dayKey?: string;
  scheduledAt?: Date;
  status?: PostAttrs['status'];
  coinReward?: number;
  tierRequired?: PostAttrs['tierRequired'];
  adsConfig?: PostAdsConfig;
  publishedAt?: Date;
  closedAt?: Date;
}

export interface AdminPostServiceDeps {
  postRepo?: PostRepository;
}

/**
 * Admin-facing CRUD for posts. Class-only in Phase 3: HTTP routes +
 * RBAC + audit-log middleware land in Phase 8. `actorId` is accepted
 * on every mutating method so the Phase 8 audit-log wiring is a
 * signature-compatible upgrade.
 */
export class AdminPostService {
  private readonly postRepo: PostRepository;

  constructor(deps: AdminPostServiceDeps = {}) {
    this.postRepo = deps.postRepo ?? new PostRepository();
  }

  async create(input: AdminPostCreateInput, actorId: Types.ObjectId): Promise<PostAttrs> {
    const data: Partial<PostAttrs> = {
      title: input.title,
      dayKey: input.dayKey,
      scheduledAt: input.scheduledAt,
      createdBy: actorId,
    };
    if (input.description !== undefined) data.description = input.description;
    if (input.status !== undefined) data.status = input.status;
    if (input.coinReward !== undefined) data.coinReward = input.coinReward;
    if (input.tierRequired !== undefined) data.tierRequired = input.tierRequired;
    if (input.adsConfig !== undefined) data.adsConfig = input.adsConfig;
    const doc = await this.postRepo.create(data);
    return doc.toObject();
  }

  async update(
    postId: Types.ObjectId | string,
    patch: AdminPostUpdateInput,
    _actorId: Types.ObjectId,
  ): Promise<PostAttrs | null> {
    const updated = await this.postRepo.findOneAndUpdate({ _id: postId }, { $set: patch });
    return updated ? updated.toObject() : null;
  }

  async delete(postId: Types.ObjectId | string, _actorId: Types.ObjectId): Promise<boolean> {
    const result = await this.postRepo.deleteOne({ _id: postId });
    return result.deletedCount === 1;
  }

  async listByDate(dayKey: string, status?: PostAttrs['status']): Promise<PostAttrs[]> {
    const filter: FilterQuery<PostAttrs> = { dayKey };
    if (status) filter.status = status;
    return this.postRepo.find(filter);
  }

  /** Audit before-snapshot helper used by the Phase 8 auditLog middleware. */
  async getForAudit(postId: Types.ObjectId | string): Promise<PostAttrs | null> {
    return this.postRepo.findById(postId);
  }
}
