import type { Types } from 'mongoose';
import { AdsConfigModel, type AdsConfigAttrs } from '../../shared/models/AdsConfig.model.js';
import { AdsConfigRepository } from '../../shared/repositories/AdsConfig.repository.js';
import type { AdminAdsConfigUpsertBody } from './admin-ads-config.schemas.js';

export interface AdminAdsConfigListResult {
  items: AdsConfigAttrs[];
}

export interface AdminAdsConfigServiceDeps {
  adsRepo?: AdsConfigRepository;
}

/**
 * Admin CRUD for ad-unit placement configs. Multi-row, keyed by
 * `placementKey` (unique). The model stores ad-unit IDs (which are
 * public-ish — bundled into the client anyway) plus operational
 * flags like `enabled` + `minTierToHide`. SUPER_ADMIN gate is about
 * revenue-path operational risk, not credential secrecy.
 */
export class AdminAdsConfigService {
  private readonly adsRepo: AdsConfigRepository;

  constructor(deps: AdminAdsConfigServiceDeps = {}) {
    this.adsRepo = deps.adsRepo ?? new AdsConfigRepository();
  }

  async list(): Promise<AdminAdsConfigListResult> {
    const items = await this.adsRepo.find({}, { sort: { placementKey: 1 } });
    return { items };
  }

  async getForAudit(placementKey: string): Promise<AdsConfigAttrs | null> {
    return this.adsRepo.findOne({ placementKey });
  }

  async upsert(
    placementKey: string,
    patch: AdminAdsConfigUpsertBody,
    actorId: Types.ObjectId,
  ): Promise<AdsConfigAttrs> {
    const set: Partial<AdsConfigAttrs> = {
      type: patch.type,
      network: patch.network,
      updatedBy: actorId,
    };
    if (patch.adUnitIdAndroid !== undefined) set.adUnitIdAndroid = patch.adUnitIdAndroid;
    if (patch.adUnitIdIOS !== undefined) set.adUnitIdIOS = patch.adUnitIdIOS;
    if (patch.fallbackAdUnitId !== undefined) set.fallbackAdUnitId = patch.fallbackAdUnitId;
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.minTierToHide !== undefined) set.minTierToHide = patch.minTierToHide;
    if (patch.refreshSeconds !== undefined) set.refreshSeconds = patch.refreshSeconds;

    const doc = await AdsConfigModel.findOneAndUpdate(
      { placementKey },
      { $set: set, $setOnInsert: { placementKey } },
      { upsert: true, new: true },
    ).lean<AdsConfigAttrs>();
    if (!doc) {
      throw new Error('ads-config upsert returned no document');
    }
    return doc;
  }

  async delete(placementKey: string): Promise<{ deleted: boolean }> {
    const res = await this.adsRepo.deleteOne({ placementKey });
    return { deleted: res.deletedCount === 1 };
  }
}
