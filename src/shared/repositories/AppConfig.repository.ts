import type { HydratedDocument, Model } from 'mongoose';
import { AppConfigModel, type AppConfigAttrs } from '../models/AppConfig.model.js';
import { BaseRepository, type WriteOpts } from './_base.repository.js';

export class AppConfigRepository extends BaseRepository<AppConfigAttrs> {
  constructor(model: Model<AppConfigAttrs> = AppConfigModel) {
    super(model);
  }

  /** The canonical single-doc config row. */
  getDefault(): Promise<AppConfigAttrs | null> {
    return this.findOne({ key: 'default' });
  }

  /**
   * Idempotent upsert of the default config. Seed uses this so a
   * re-run doesn't clobber live values and doesn't error on duplicate
   * key. `$setOnInsert` keeps admin edits intact.
   */
  upsertDefault(
    defaults: Partial<AppConfigAttrs>,
    opts: WriteOpts = {},
  ): Promise<HydratedDocument<AppConfigAttrs> | null> {
    return this.model.findOneAndUpdate(
      { key: 'default' },
      { $setOnInsert: { key: 'default', ...defaults } },
      { ...opts, upsert: true, new: true },
    );
  }
}
