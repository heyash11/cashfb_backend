import type { Model } from 'mongoose';
import { CmsContentModel, type CmsContentAttrs } from '../models/CmsContent.model.js';
import { BaseRepository } from './_base.repository.js';

type CmsKey = 'TERMS' | 'HOW_DISTRIBUTE' | 'FAQ' | 'PRIVACY' | 'GRIEVANCE';

export class CmsContentRepository extends BaseRepository<CmsContentAttrs> {
  constructor(model: Model<CmsContentAttrs> = CmsContentModel) {
    super(model);
  }

  getByKey(key: CmsKey): Promise<CmsContentAttrs | null> {
    return this.findOne({ key });
  }
}
