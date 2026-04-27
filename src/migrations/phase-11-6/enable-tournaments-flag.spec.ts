import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { AppConfigModel } from '../../shared/models/AppConfig.model.js';
import { runEnableTournamentsDev } from './enable-tournaments-flag.js';

beforeAll(async () => {
  await connectTestMongo();
}, 30_000);

afterAll(async () => {
  await disconnectTestMongo();
});

beforeEach(async () => {
  await clearAllCollections();
});

describe('runEnableTournamentsDev — Phase 11.6 dev-only flag flip', () => {
  it('upserts the default config row and sets featureFlags.tournaments=true', async () => {
    const before = await AppConfigModel.findOne({ key: 'default' });
    expect(before).toBeNull();

    const report = await runEnableTournamentsDev();
    expect(report.upserted).toBe(true);

    const after = await AppConfigModel.findOne({ key: 'default' });
    expect(after).not.toBeNull();
    expect(after?.featureFlags?.['tournaments']).toBe(true);
  });

  it('idempotent: re-running against an already-flipped config does not insert a new doc', async () => {
    await runEnableTournamentsDev();
    const report = await runEnableTournamentsDev();
    // The critical idempotency guarantee: no second doc is created.
    // modifiedCount under dot-notation $set may report 1 even when
    // the value is unchanged; that's acceptable — what matters is
    // upserted=false and the resulting value still being true.
    expect(report.upserted).toBe(false);
    expect(report.matched).toBe(1);

    const cfg = await AppConfigModel.findOne({ key: 'default' });
    expect(cfg?.featureFlags?.['tournaments']).toBe(true);
    expect(await AppConfigModel.countDocuments({})).toBe(1);
  });

  it('preserves other featureFlags when flipping tournaments', async () => {
    await AppConfigModel.create({
      key: 'default',
      featureFlags: { tournaments: false, proContestAccess: false, otherFlag: 'preserved' },
    });

    await runEnableTournamentsDev();

    const cfg = await AppConfigModel.findOne({ key: 'default' });
    expect(cfg?.featureFlags?.['tournaments']).toBe(true);
    expect(cfg?.featureFlags?.['proContestAccess']).toBe(false);
    expect(cfg?.featureFlags?.['otherFlag']).toBe('preserved');
  });
});
