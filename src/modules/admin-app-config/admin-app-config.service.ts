import { AppConfigModel, type AppConfigAttrs } from '../../shared/models/AppConfig.model.js';
import { AppConfigRepository } from '../../shared/repositories/AppConfig.repository.js';
import type { AdminAppConfigPatchBody } from './admin-app-config.schemas.js';

export interface AdminAppConfigServiceDeps {
  appConfigRepo?: AppConfigRepository;
}

/**
 * Read/write the app_config singleton. PATCH semantics: only the
 * supplied fields are $set. Unsupplied fields keep their current
 * values. Nested subdocs (`voteWindowIst`, `razorpayPlanIds`) are
 * replaced atomically when present, not merged — callers must
 * supply the full subdoc if they want to update it.
 */
export class AdminAppConfigService {
  private readonly appConfigRepo: AppConfigRepository;

  constructor(deps: AdminAppConfigServiceDeps = {}) {
    this.appConfigRepo = deps.appConfigRepo ?? new AppConfigRepository();
  }

  async get(): Promise<AppConfigAttrs | null> {
    return this.appConfigRepo.findOne({ key: 'default' });
  }

  async getForAudit(): Promise<AppConfigAttrs | null> {
    return this.get();
  }

  async update(patch: AdminAppConfigPatchBody): Promise<AppConfigAttrs> {
    // Build $set object from only the defined keys — leaves the rest
    // of the document untouched. Zod .strict() ensures there are no
    // unknown keys to worry about.
    const set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) set[k] = v;
    }

    // Empty patch → no-op; return current doc (or the freshly
    // upserted default if somehow missing).
    if (Object.keys(set).length === 0) {
      const existing = await this.appConfigRepo.findOne({ key: 'default' });
      if (existing) return existing;
    }

    const doc = await AppConfigModel.findOneAndUpdate(
      { key: 'default' },
      { $set: set, $setOnInsert: { key: 'default' } },
      { upsert: true, new: true },
    ).lean<AppConfigAttrs>();
    if (!doc) {
      throw new Error('app-config update returned no document');
    }
    return doc;
  }
}
