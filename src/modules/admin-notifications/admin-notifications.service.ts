import { randomUUID } from 'node:crypto';
import type { FilterQuery, Types } from 'mongoose';
import { ValidationError } from '../../shared/errors/AppError.js';
import {
  NotificationModel,
  type NotificationAttrs,
} from '../../shared/models/Notification.model.js';
import { UserModel, type UserAttrs } from '../../shared/models/User.model.js';

export interface BroadcastTargetAll {
  mode: 'all';
}
export interface BroadcastTargetTier {
  mode: 'tier';
  tier: 'PUBLIC' | 'PRO' | 'PRO_MAX';
}
export interface BroadcastTargetUser {
  mode: 'user';
  userId: Types.ObjectId;
}
export type BroadcastTarget = BroadcastTargetAll | BroadcastTargetTier | BroadcastTargetUser;

export interface BroadcastInput {
  target: BroadcastTarget;
  title?: string;
  body?: string;
  payload?: Record<string, unknown>;
  /** Override for tests. Prod path derives this from randomUUID. */
  broadcastId?: string;
}

export interface BroadcastResult {
  broadcastId: string;
  inserted: number;
}

/**
 * Admin broadcast dispatcher. Resolves the target selector to a set
 * of userIds, then bulk-inserts a Notification row per recipient
 * with `type: 'CUSTOM'` and a shared `payload.broadcastId` UUID so
 * an operator can correlate all rows from one broadcast.
 *
 * TODO(phase-10+): move fan-out to a BullMQ worker if broadcast
 * latency exceeds 2 s for all-users target. At MVP scale (< 50k
 * users) inline fan-out is fine; the HTTP handler stays responsive
 * because inserts batch via insertMany under the hood.
 *
 * FCM delivery is Phase 10 work. The Notification.fcmMessageId
 * field is already present on the model and will be populated by
 * a future dispatcher against this same collection.
 */
export class AdminNotificationsService {
  async broadcast(input: BroadcastInput, _actorId: Types.ObjectId): Promise<BroadcastResult> {
    const broadcastId = input.broadcastId ?? randomUUID();
    const userIds = await this.resolveRecipients(input.target);
    if (userIds.length === 0) {
      return { broadcastId, inserted: 0 };
    }

    const mergedPayload: Record<string, unknown> = {
      ...(input.payload ?? {}),
      broadcastId,
    };

    const docs: Partial<NotificationAttrs>[] = userIds.map((uid) => {
      const doc: Partial<NotificationAttrs> = {
        userId: uid,
        type: 'CUSTOM',
        payload: mergedPayload,
      };
      if (input.title !== undefined) doc.title = input.title;
      if (input.body !== undefined) doc.body = input.body;
      return doc;
    });
    const inserted = await NotificationModel.insertMany(docs);
    return { broadcastId, inserted: inserted.length };
  }

  private async resolveRecipients(target: BroadcastTarget): Promise<Types.ObjectId[]> {
    if (target.mode === 'user') {
      const exists = await UserModel.exists({ _id: target.userId });
      if (!exists) throw new ValidationError('Target user not found');
      return [target.userId];
    }
    const q: FilterQuery<UserAttrs> = {};
    if (target.mode === 'tier') q.tier = target.tier;
    const users = await UserModel.find(q, { _id: 1 }).lean<Pick<UserAttrs, '_id'>[]>();
    return users.map((u) => u._id);
  }
}
