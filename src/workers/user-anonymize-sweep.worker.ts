import mongoose, { type Types } from 'mongoose';
import { logger } from '../config/logger.js';
import { AuditLogModel } from '../shared/models/AuditLog.model.js';
import { DonationModel } from '../shared/models/Donation.model.js';
import { LoginSessionModel } from '../shared/models/LoginSession.model.js';
import { NotificationModel } from '../shared/models/Notification.model.js';
import { PrizePoolWinnerModel } from '../shared/models/PrizePoolWinner.model.js';
import { UserModel, type UserAttrs } from '../shared/models/User.model.js';
import { ForceLogoutStore } from '../shared/services/force-logout.js';
import { buildAnonymizeOps, type AnonymizeOps } from '../shared/utils/anonymize.js';

/**
 * DPDP user-anonymize sweep (Phase 9 Chunk 4 — see docs/DPDP.md §7).
 *
 * Cron fires daily at 02:10 IST. Each fire:
 *   1. Find candidates: `deletedAt <= now - 30d` AND not already
 *      anonymized AND not held.
 *   2. For each candidate, start a transaction:
 *      a. If PENDING PrizePoolWinner rows exist → write an
 *         `ERASURE_WITH_PENDING_WINNINGS` audit row FIRST (in-txn)
 *         so the audit trail is atomic with the anonymization.
 *      b. Apply anonymize.ts patch to user row ($set + $unset).
 *      c. Fan out cascades: donations + notifications.
 *      d. Delete login_sessions rows for the user.
 *   3. Outside transaction, best-effort delete the user's
 *      force-logout Redis key (the 30-day TTL would expire it
 *      anyway but the explicit delete keeps Redis tidy).
 *
 * Ordering rationale: the audit write runs first inside the
 * transaction so a mid-sweep crash can't leave a tombstoned user
 * with no trace of what happened. Crashing after the audit but
 * before the user-row $set is fine — next sweep re-runs idempotently.
 */

export interface UserAnonymizeSweepJobData {
  scheduledFor: string;
}

export interface UserAnonymizeSweepReport {
  scannedAt: string;
  candidateCount: number;
  anonymizedCount: number;
  pendingWinningsAuditCount: number;
  errors: Array<{ userId: string; message: string }>;
}

const GRACE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

export interface UserAnonymizeSweepHandlerDeps {
  forceLogoutStore?: ForceLogoutStore;
  /** Test hook: returns candidates for the sweep. Default queries Mongo. */
  findCandidates?: (now: Date) => Promise<UserAttrs[]>;
}

export function createUserAnonymizeSweepHandler(
  deps: UserAnonymizeSweepHandlerDeps = {},
): (data: UserAnonymizeSweepJobData) => Promise<UserAnonymizeSweepReport> {
  const forceLogoutStore = deps.forceLogoutStore ?? new ForceLogoutStore();
  const findCandidates =
    deps.findCandidates ??
    (async (now: Date): Promise<UserAttrs[]> => {
      const cutoff = new Date(now.getTime() - GRACE_PERIOD_MS);
      return UserModel.find({
        deletedAt: { $lte: cutoff },
        anonymizedAt: { $exists: false },
        'erasureHold.active': { $ne: true },
      }).lean<UserAttrs[]>();
    });

  return async (data: UserAnonymizeSweepJobData): Promise<UserAnonymizeSweepReport> => {
    const now = new Date(data.scheduledFor);
    const candidates = await findCandidates(now);
    const report: UserAnonymizeSweepReport = {
      scannedAt: data.scheduledFor,
      candidateCount: candidates.length,
      anonymizedCount: 0,
      pendingWinningsAuditCount: 0,
      errors: [],
    };

    for (const user of candidates) {
      try {
        const pendingWinners = await PrizePoolWinnerModel.find({
          userId: user._id,
          payoutStatus: 'PENDING',
        }).lean();

        const ops = buildAnonymizeOps(user, now);
        await anonymizeInTransaction(user, ops, pendingWinners, now);

        report.anonymizedCount++;
        if (pendingWinners.length > 0) report.pendingWinningsAuditCount++;

        // Best-effort Redis cleanup. The 30-day TTL would expire
        // this anyway but an explicit delete keeps the namespace
        // lean. Non-fatal on failure.
        try {
          await forceLogoutStore.clear(user._id.toHexString());
        } catch (err) {
          logger.warn(
            { err, userId: user._id.toHexString() },
            '[anonymize-sweep] force-logout clear failed — TTL will expire',
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        report.errors.push({ userId: user._id.toHexString(), message });
        logger.error(
          { err, userId: user._id.toHexString() },
          '[anonymize-sweep] per-user anonymization failed',
        );
      }
    }

    logger.info(
      {
        scannedAt: report.scannedAt,
        candidateCount: report.candidateCount,
        anonymizedCount: report.anonymizedCount,
        pendingWinningsAuditCount: report.pendingWinningsAuditCount,
        errorCount: report.errors.length,
      },
      '[anonymize-sweep] pass complete',
    );
    return report;
  };
}

async function anonymizeInTransaction(
  user: UserAttrs,
  ops: AnonymizeOps,
  pendingWinners: Array<{
    dayKey: string;
    finalAmount?: number;
    tdsDeducted: number;
    _id: Types.ObjectId;
  }>,
  now: Date,
): Promise<void> {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      if (pendingWinners.length > 0) {
        const pendingTotalPaise = pendingWinners.reduce((acc, w) => acc + (w.finalAmount ?? 0), 0);
        const tdsAccruedPaise = pendingWinners.reduce((acc, w) => acc + (w.tdsDeducted ?? 0), 0);
        const pendingDayKeys = Array.from(new Set(pendingWinners.map((w) => w.dayKey))).sort();

        await AuditLogModel.create(
          [
            {
              actorId: user._id,
              actorEmail: 'system:anonymize-sweep',
              action: 'ERASURE_WITH_PENDING_WINNINGS',
              resource: { kind: 'User', id: user._id },
              before: null,
              after: {
                userId: user._id.toHexString(),
                gracePeriodStartedAt: user.deletedAt,
                anonymizedAt: now,
                pendingWinnerCount: pendingWinners.length,
                pendingTotalPaise,
                tdsAccruedPaise,
                pendingDayKeys,
              },
            },
          ],
          { session },
        );
      }

      await UserModel.updateOne(
        { _id: user._id },
        {
          $set: ops.userPatch,
          ...(ops.userUnsets.length > 0
            ? {
                $unset: Object.fromEntries(ops.userUnsets.map((p) => [p, ''])),
              }
            : {}),
        },
        { session },
      );

      for (const cascade of ops.cascades) {
        if (cascade.collection === 'donations') {
          await DonationModel.updateMany(cascade.filter, cascade.update, { session });
        } else if (cascade.collection === 'notifications') {
          await NotificationModel.updateMany(cascade.filter, cascade.update, { session });
        }
      }

      await LoginSessionModel.deleteMany({ userId: user._id }, { session });
    });
  } finally {
    await session.endSession();
  }
}
