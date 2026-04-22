import { Types } from 'mongoose';
import { BadRequestError, UnauthorizedError } from '../../shared/errors/AppError.js';
import type { CoinTransactionAttrs } from '../../shared/models/CoinTransaction.model.js';
import { CoinTransactionRepository } from '../../shared/repositories/CoinTransaction.repository.js';
import { UserRepository } from '../../shared/repositories/User.repository.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export interface ListCoinTransactionsInput {
  userId: Types.ObjectId;
  cursor?: string;
  limit?: number;
}

export interface ListCoinTransactionsResult {
  items: CoinTransactionAttrs[];
  nextCursor?: string;
}

interface CursorPayload {
  t: number; // createdAt milliseconds
  i: string; // ObjectId hex (24 chars)
}

function encodeCursor(doc: { createdAt: Date; _id: Types.ObjectId }): string {
  const payload: CursorPayload = {
    t: doc.createdAt.getTime(),
    i: doc._id.toHexString(),
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

/**
 * Cursor validation lives in the service (not Zod) because the
 * internal `{t, i}` shape is a service-owned encoding. A bad cursor
 * surfaces as the dedicated `INVALID_CURSOR` (400) rather than a
 * generic `VALIDATION_FAILED`.
 */
function decodeCursor(raw: string): CursorPayload {
  let decoded: string;
  try {
    // Defensive: Node 22 Buffer.from('...', 'base64') silently strips
    // invalid chars rather than throwing. Downstream JSON.parse handles
    // malformed input. Try/catch kept against future Node versions.
    decoded = Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    throw new BadRequestError('INVALID_CURSOR', 'Cursor is not valid base64');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new BadRequestError('INVALID_CURSOR', 'Cursor is not valid JSON');
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as Record<string, unknown>)['t'] !== 'number' ||
    typeof (parsed as Record<string, unknown>)['i'] !== 'string'
  ) {
    throw new BadRequestError('INVALID_CURSOR', 'Cursor shape is invalid');
  }

  const i = (parsed as Record<string, unknown>)['i'] as string;
  if (!/^[0-9a-f]{24}$/i.test(i)) {
    throw new BadRequestError('INVALID_CURSOR', 'Cursor id is not a valid ObjectId');
  }

  return parsed as CursorPayload;
}

export interface UserCoinsServiceDeps {
  userRepo?: UserRepository;
  coinTxRepo?: CoinTransactionRepository;
}

export class UserCoinsService {
  private readonly userRepo: UserRepository;
  private readonly coinTxRepo: CoinTransactionRepository;

  /**
   * Default-fallback deps are for test ergonomics only. The awilix
   * composition root (Phase 7+) MUST inject the repos explicitly so
   * prod wiring doesn't silently depend on the `new X()` fallbacks.
   */
  constructor(deps: UserCoinsServiceDeps = {}) {
    this.userRepo = deps.userRepo ?? new UserRepository();
    this.coinTxRepo = deps.coinTxRepo ?? new CoinTransactionRepository();
  }

  /**
   * Paginated coin-transaction history, newest first.
   *
   * Cursor-invalidation note: if new transactions arrive while a
   * client holds a cursor, the newly-inserted rows have later
   * `createdAt` timestamps and therefore sit on a page the cursor has
   * already traversed past — they will NOT appear mid-walk. The
   * client must re-query from page 1 to see them. Acceptable for
   * this view (history, not a live feed).
   */
  async listTransactions(input: ListCoinTransactionsInput): Promise<ListCoinTransactionsResult> {
    const limit = Math.max(1, Math.min(MAX_LIMIT, input.limit ?? DEFAULT_LIMIT));

    const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;

    // Served by the compound index {userId: 1, createdAt: -1} declared
    // in CoinTransaction.model.ts. Do NOT remove that index without
    // updating this query.
    const filter = cursor
      ? {
          userId: input.userId,
          $or: [
            { createdAt: { $lt: new Date(cursor.t) } },
            {
              createdAt: new Date(cursor.t),
              _id: { $lt: new Types.ObjectId(cursor.i) },
            },
          ],
        }
      : { userId: input.userId };

    const fetched = await this.coinTxRepo.find(filter, {
      sort: { createdAt: -1, _id: -1 },
      limit: limit + 1,
    });

    const hasMore = fetched.length > limit;
    const items = hasMore ? fetched.slice(0, limit) : fetched;

    const result: ListCoinTransactionsResult = { items };
    if (hasMore) {
      const last = items[items.length - 1];
      if (last) {
        result.nextCursor = encodeCursor({
          createdAt: last.createdAt,
          _id: last._id,
        });
      }
    }
    return result;
  }

  /**
   * Current coin balance read from `users.coinBalance`. Does NOT sum
   * `coin_transactions` rows — that collection is audit history, not
   * the balance source of truth (CONVENTIONS.md §Money).
   *
   * Throws UnauthorizedError for missing users (mirrors Phase 2
   * auth-service behaviour; the caller's access token should always
   * resolve to a real user).
   */
  async getBalance(userId: Types.ObjectId | string): Promise<number> {
    const user = await this.userRepo.findById(userId);
    if (!user) throw new UnauthorizedError('User not found');
    return user.coinBalance;
  }
}
