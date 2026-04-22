import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Model } from 'mongoose';
import { MODELS } from '../../src/shared/models/index.js';
import { connectTestMongo, disconnectTestMongo } from '../testing/mongo.js';

type IndexKey = Record<string, number | string>;
interface LiveIndex {
  key: IndexKey;
  unique?: boolean;
  name: string;
}

type AnyModel = Model<Record<string, unknown>>;

beforeAll(async () => {
  await connectTestMongo();
  // Force index creation on every model so live state reflects declarations.
  await Promise.all(Object.values(MODELS).map((m) => (m as unknown as AnyModel).syncIndexes()));
}, 120_000);

afterAll(async () => {
  await disconnectTestMongo();
});

function keysEqual(a: IndexKey, b: IndexKey): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!(k in b)) return false;
    if (a[k] !== b[k]) return false;
  }
  return true;
}

describe('declared schema indexes materialise on live collections', () => {
  for (const [collectionName, mod] of Object.entries(MODELS)) {
    const model = mod as unknown as AnyModel;
    it(`${collectionName}: every declared index is present with matching key + uniqueness`, async () => {
      // `schema.indexes()` returns BOTH field-level ({ index, unique }) and
      // schema-level (Schema.index(...)) declarations in a single tuple list.
      const declared = model.schema.indexes() as Array<
        [IndexKey, Record<string, unknown> | undefined]
      >;
      const live = (await model.collection.indexes()) as LiveIndex[];

      for (const [declaredKey, declaredOpts] of declared) {
        const wantUnique = Boolean(declaredOpts?.['unique']);
        const match = live.find(
          (l) => keysEqual(declaredKey, l.key) && Boolean(l.unique) === wantUnique,
        );
        expect(
          match,
          `[${collectionName}] missing declared index: key=${JSON.stringify(
            declaredKey,
          )} unique=${String(wantUnique)}; live indexes were ${JSON.stringify(
            live.map((l) => ({ key: l.key, unique: Boolean(l.unique) })),
          )}`,
        ).toBeDefined();
      }
    });
  }
});
