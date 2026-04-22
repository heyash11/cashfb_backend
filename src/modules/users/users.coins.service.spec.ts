import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { CoinTransactionModel } from '../../shared/models/CoinTransaction.model.js';
import { MODELS } from '../../shared/models/index.js';
import { UserModel, type UserAttrs, type UserDoc } from '../../shared/models/User.model.js';
import { UserCoinsService } from './users.coins.service.js';

type AnyModel = { syncIndexes(): Promise<string[]> };

let phoneCounter = 0;
async function mkUser(overrides: Partial<UserAttrs> = {}): Promise<UserDoc> {
  phoneCounter += 1;
  const suffix = String(phoneCounter).padStart(8, '0');
  return UserModel.create({
    phone: `+9197${suffix}`,
    dob: new Date('1995-01-01'),
    declaredState: 'IN-MH',
    ...overrides,
  });
}

async function seedTxs(userId: Types.ObjectId, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await CoinTransactionModel.create({
      userId,
      type: 'POST_REWARD',
      amount: 1,
      balanceAfter: i + 1,
      reference: { kind: 'System' },
    });
  }
}

beforeAll(async () => {
  await connectTestMongo();
  await Promise.all(Object.values(MODELS).map((m) => (m as unknown as AnyModel).syncIndexes()));
}, 120_000);

afterAll(async () => {
  await disconnectTestMongo();
});

beforeEach(async () => {
  await clearAllCollections();
});

// ---------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------

describe('UserCoinsService.listTransactions', () => {
  it('returns an empty page + no cursor when the user has no transactions', async () => {
    const svc = new UserCoinsService();
    const user = await mkUser();
    const result = await svc.listTransactions({ userId: user._id });
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
  });

  it('returns newest-first up to the limit plus a nextCursor when more exist', async () => {
    const svc = new UserCoinsService();
    const user = await mkUser();
    await seedTxs(user._id, 10);

    const page = await svc.listTransactions({ userId: user._id, limit: 5 });
    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).toBeTruthy();
    // Newest-first: the first item's balanceAfter corresponds to the
    // latest seeded tx (n=10 ⇒ last seeded had balanceAfter=10).
    expect(page.items[0]?.balanceAfter).toBe(10);
  });

  it('applies the default limit of 50 when omitted', async () => {
    const svc = new UserCoinsService();
    const user = await mkUser();
    await seedTxs(user._id, 75);

    const page = await svc.listTransactions({ userId: user._id });
    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).toBeTruthy();
  });

  it('paginates through a full 150-row dataset with no duplicates or gaps', async () => {
    const svc = new UserCoinsService();
    const user = await mkUser();
    await seedTxs(user._id, 150);

    const seenIds = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;

    while (true) {
      const input: { userId: Types.ObjectId; limit: number; cursor?: string } = {
        userId: user._id,
        limit: 50,
      };
      if (cursor !== undefined) input.cursor = cursor;
      const page = await svc.listTransactions(input);
      pages += 1;
      for (const item of page.items) {
        const id = String(item._id);
        expect(seenIds.has(id)).toBe(false);
        seenIds.add(id);
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
      if (pages > 10) throw new Error('pagination did not terminate');
    }

    expect(seenIds.size).toBe(150);
    expect(pages).toBe(3);
  });

  it("does not leak another user's transactions", async () => {
    const svc = new UserCoinsService();
    const alice = await mkUser();
    const bob = await mkUser();
    await seedTxs(alice._id, 5);
    await seedTxs(bob._id, 3);

    const alicePage = await svc.listTransactions({ userId: alice._id, limit: 50 });
    expect(alicePage.items).toHaveLength(5);
    for (const item of alicePage.items) {
      expect(String(item.userId)).toBe(String(alice._id));
    }

    const bobPage = await svc.listTransactions({ userId: bob._id, limit: 50 });
    expect(bobPage.items).toHaveLength(3);
    for (const item of bobPage.items) {
      expect(String(item.userId)).toBe(String(bob._id));
    }
  });

  it('cursor round-trip integrity: decode reveals {t: number, i: 24-char hex}; re-encoded cursor paginates correctly', async () => {
    const svc = new UserCoinsService();
    const user = await mkUser();
    await seedTxs(user._id, 10);

    const page1 = await svc.listTransactions({ userId: user._id, limit: 5 });
    expect(page1.items).toHaveLength(5);
    expect(page1.nextCursor).toBeTruthy();

    // Decode, assert shape, re-encode, pass back.
    const decoded = JSON.parse(
      Buffer.from(page1.nextCursor as string, 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    expect(typeof decoded['t']).toBe('number');
    expect(typeof decoded['i']).toBe('string');
    expect(decoded['i']).toMatch(/^[0-9a-f]{24}$/);

    const reencoded = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64');
    const page2 = await svc.listTransactions({
      userId: user._id,
      cursor: reencoded,
      limit: 5,
    });
    expect(page2.items).toHaveLength(5);
    expect(page2.nextCursor).toBeUndefined();

    // Combined set is exactly the 10 seeded rows.
    const idsA = new Set(page1.items.map((x) => String(x._id)));
    const idsB = new Set(page2.items.map((x) => String(x._id)));
    const intersection = [...idsA].filter((x) => idsB.has(x));
    expect(intersection).toHaveLength(0);
    expect(idsA.size + idsB.size).toBe(10);
  });
});

// ---------------------------------------------------------------
// Cursor validation
// ---------------------------------------------------------------

describe('UserCoinsService.listTransactions — cursor validation', () => {
  it('cursor that is not valid base64 → INVALID_CURSOR', async () => {
    const svc = new UserCoinsService();
    const user = await mkUser();
    // Pass a string with characters outside base64 alphabet.
    await expect(
      svc.listTransactions({ userId: user._id, cursor: '!!! not base64 !!!' }),
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });

  it('cursor that is base64 but not JSON → INVALID_CURSOR', async () => {
    const svc = new UserCoinsService();
    const user = await mkUser();
    const bad = Buffer.from('not json', 'utf8').toString('base64');
    await expect(svc.listTransactions({ userId: user._id, cursor: bad })).rejects.toMatchObject({
      code: 'INVALID_CURSOR',
    });
  });

  it('cursor with missing or wrong-type fields → INVALID_CURSOR', async () => {
    const svc = new UserCoinsService();
    const user = await mkUser();
    const bad = Buffer.from(JSON.stringify({ t: 'not-a-number', i: 'x' }), 'utf8').toString(
      'base64',
    );
    await expect(svc.listTransactions({ userId: user._id, cursor: bad })).rejects.toMatchObject({
      code: 'INVALID_CURSOR',
    });
  });

  it('cursor with malformed ObjectId hex → INVALID_CURSOR', async () => {
    const svc = new UserCoinsService();
    const user = await mkUser();
    const bad = Buffer.from(JSON.stringify({ t: 1700000000000, i: 'zzzz' }), 'utf8').toString(
      'base64',
    );
    await expect(svc.listTransactions({ userId: user._id, cursor: bad })).rejects.toMatchObject({
      code: 'INVALID_CURSOR',
    });
  });
});

// ---------------------------------------------------------------
// getBalance
// ---------------------------------------------------------------

describe('UserCoinsService.getBalance', () => {
  it('returns user.coinBalance', async () => {
    const svc = new UserCoinsService();
    const user = await mkUser({ coinBalance: 42 });
    const balance = await svc.getBalance(user._id);
    expect(balance).toBe(42);
  });

  it('throws UnauthorizedError when the user is not found', async () => {
    const svc = new UserCoinsService();
    await expect(svc.getBalance(new Types.ObjectId())).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});
