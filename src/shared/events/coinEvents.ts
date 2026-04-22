import type { Types } from 'mongoose';

/**
 * Canonical reasons a `coins.updated` event may fire. Kept in a closed
 * union here so consumers (dashboards, clients) can narrow exhaustively.
 */
export type CoinEventReason =
  | 'SIGNUP_BONUS'
  | 'POST_REWARD'
  | 'VOTE_SPEND'
  | 'ADMIN_CREDIT'
  | 'ADMIN_DEBIT'
  | 'REFUND';

export interface CoinsUpdatedPayload {
  userId: Types.ObjectId;
  coinBalance: number;
  reason: CoinEventReason;
}

/**
 * Emitted after every mutation of `users.coinBalance`. Target room is
 * `user:<userId>` on the Socket.IO server (see docs/ARCHITECTURE.md §7).
 */
export interface CoinEventEmitter {
  emitCoinsUpdated(payload: CoinsUpdatedPayload): Promise<void>;
}

/**
 * Phase 3 default. Phase 7 swaps in a Socket.IO / Redis-adapter
 * implementation. See CONVENTIONS.md §Deferred implementations for
 * the interface-first-stub-later pattern.
 */
export class NoopCoinEventEmitter implements CoinEventEmitter {
  async emitCoinsUpdated(_payload: CoinsUpdatedPayload): Promise<void> {
    // deliberately empty; see Phase 7
  }
}
