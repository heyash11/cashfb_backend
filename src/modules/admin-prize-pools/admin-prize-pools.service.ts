import type { FilterQuery, Types } from 'mongoose';
import { NotFoundError } from '../../shared/errors/AppError.js';
import type { PrizePoolAttrs } from '../../shared/models/PrizePool.model.js';
import type { PrizePoolWinnerAttrs } from '../../shared/models/PrizePoolWinner.model.js';
import { PrizePoolRepository } from '../../shared/repositories/PrizePool.repository.js';
import { PrizePoolWinnerRepository } from '../../shared/repositories/PrizePoolWinner.repository.js';

export interface AdminPrizePoolsListFilter {
  status?: PrizePoolAttrs['status'];
}

export interface AdminPrizePoolsListResult {
  items: PrizePoolAttrs[];
}

export interface AdminPrizePoolWinnersFilter {
  dayKey: string;
  payoutStatus?: PrizePoolWinnerAttrs['payoutStatus'];
}

export interface AdminPrizePoolWinnersResult {
  items: PrizePoolWinnerAttrs[];
}

export interface MarkPayoutInput {
  winnerId: Types.ObjectId;
  payoutStatus: 'RELEASED' | 'WITHHELD' | 'VOID';
  challanNo?: string;
  panLast4?: string;
  actorId: Types.ObjectId;
}

export interface AdminPrizePoolsServiceDeps {
  poolRepo?: PrizePoolRepository;
  winnerRepo?: PrizePoolWinnerRepository;
}

/**
 * Admin-facing prize-pool reads + payout ledger edits. The daily
 * compute primitive lives on PrizePoolService (Phase 6) — admin
 * triggers it via the controller, which imports the existing
 * service. This module owns the payout-status state machine
 * (PENDING → RELEASED / WITHHELD / VOID) that accountants drive
 * after TDS challans are reconciled.
 */
export class AdminPrizePoolsService {
  private readonly poolRepo: PrizePoolRepository;
  private readonly winnerRepo: PrizePoolWinnerRepository;

  constructor(deps: AdminPrizePoolsServiceDeps = {}) {
    this.poolRepo = deps.poolRepo ?? new PrizePoolRepository();
    this.winnerRepo = deps.winnerRepo ?? new PrizePoolWinnerRepository();
  }

  async list(filter: AdminPrizePoolsListFilter, limit = 50): Promise<AdminPrizePoolsListResult> {
    const q: FilterQuery<PrizePoolAttrs> = {};
    if (filter.status) q.status = filter.status;
    const items = await this.poolRepo.find(q, {
      sort: { dayKey: -1 },
      limit: Math.max(1, Math.min(200, limit)),
    });
    return { items };
  }

  async listWinners(filter: AdminPrizePoolWinnersFilter): Promise<AdminPrizePoolWinnersResult> {
    const q: FilterQuery<PrizePoolWinnerAttrs> = { dayKey: filter.dayKey };
    if (filter.payoutStatus) q.payoutStatus = filter.payoutStatus;
    const items = await this.winnerRepo.find(q, { sort: { createdAt: 1 } });
    return { items };
  }

  async getWinnerForAudit(winnerId: Types.ObjectId | string): Promise<PrizePoolWinnerAttrs | null> {
    return this.winnerRepo.findById(winnerId);
  }

  /**
   * Flip the payout-status of a single winner row. Optional challan
   * number + PAN last-4 capture regulatory fields at release time.
   * Idempotent on re-apply to the same status (no-op); transitions
   * from/to VOID are allowed so accountants can correct mistakes —
   * every action is audited upstream anyway.
   */
  async markPayout(input: MarkPayoutInput): Promise<PrizePoolWinnerAttrs> {
    const set: Partial<PrizePoolWinnerAttrs> = {
      payoutStatus: input.payoutStatus,
    };
    if (input.payoutStatus === 'RELEASED') set.releasedAt = new Date();
    if (input.challanNo !== undefined) set.tdsChallanNo = input.challanNo;
    if (input.panLast4 !== undefined) set.panAtPayout = `XXXXX${input.panLast4}`;

    const updated = await this.winnerRepo.findOneAndUpdate({ _id: input.winnerId }, { $set: set });
    if (!updated) throw new NotFoundError('Prize pool winner not found');
    return updated;
  }
}
