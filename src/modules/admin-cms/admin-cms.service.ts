import type { Types } from 'mongoose';
import { CmsContentModel, type CmsContentAttrs } from '../../shared/models/CmsContent.model.js';
import { CmsContentRepository } from '../../shared/repositories/CmsContent.repository.js';
import type { CmsKey } from './admin-cms.schemas.js';

export interface AdminCmsListResult {
  items: CmsContentAttrs[];
}

export interface AdminCmsServiceDeps {
  cmsRepo?: CmsContentRepository;
}

/**
 * Admin CRUD on the cms_content singleton-per-key collection. Five
 * allowed keys (TERMS, HOW_DISTRIBUTE, FAQ, PRIVACY, GRIEVANCE).
 * Each upsert bumps the `version` counter via $inc so the app
 * client can cache-bust on change.
 */
export class AdminCmsService {
  private readonly cmsRepo: CmsContentRepository;

  constructor(deps: AdminCmsServiceDeps = {}) {
    this.cmsRepo = deps.cmsRepo ?? new CmsContentRepository();
  }

  async list(): Promise<AdminCmsListResult> {
    const items = await this.cmsRepo.find({}, { sort: { key: 1 } });
    return { items };
  }

  async getByKey(key: CmsKey): Promise<CmsContentAttrs | null> {
    return this.cmsRepo.findOne({ key });
  }

  async getForAudit(key: CmsKey): Promise<CmsContentAttrs | null> {
    return this.getByKey(key);
  }

  /**
   * Atomic upsert + version bump. Uses the raw model (not repo) so
   * we can chain $set + $inc in one call. `findOneAndUpdate` with
   * `upsert:true` + `new:true` returns the fresh document.
   */
  async upsert(
    key: CmsKey,
    html: string | undefined,
    actorId: Types.ObjectId,
  ): Promise<CmsContentAttrs> {
    const set: Partial<CmsContentAttrs> = { updatedBy: actorId };
    if (html !== undefined) set.html = html;
    const doc = await CmsContentModel.findOneAndUpdate(
      { key },
      { $set: set, $inc: { version: 1 }, $setOnInsert: { key } },
      { upsert: true, new: true },
    ).lean<CmsContentAttrs>();
    if (!doc) {
      throw new Error('cms upsert returned no document');
    }
    return doc;
  }
}
