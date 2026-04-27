import type { Types } from 'mongoose';
import {
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  UnprocessableError,
} from '../../shared/errors/AppError.js';
import { getDefaultEncryptor } from '../../shared/encryption/default.js';
import type { Encryptor } from '../../shared/encryption/envelope.js';
import { CustomRoomModel } from '../../shared/models/CustomRoom.model.js';
import type { CustomRoomAttrs } from '../../shared/models/CustomRoom.model.js';
import type { CustomRoomResultAttrs } from '../../shared/models/CustomRoomResult.model.js';
import type { UserSubscriptionEntry } from '../../shared/models/User.model.js';
import { userCanAccessTier, type Tier } from '../../shared/models/_tier.js';
import { CustomRoomRepository } from '../../shared/repositories/CustomRoom.repository.js';
import { CustomRoomResultRepository } from '../../shared/repositories/CustomRoomResult.repository.js';
import { AppConfigRepository } from '../../shared/repositories/AppConfig.repository.js';
import { dayKeyIst } from '../../shared/utils/date.js';

export interface ListRoomsInput {
  userId: Types.ObjectId;
  /**
   * Phase 11.4 — caller's `User.subscriptions[]` (parallel-tier
   * access set). Strict auth: a PRO_MAX-only user does NOT have
   * access to PRO rooms.
   */
  subscriptions: ReadonlyArray<UserSubscriptionEntry>;
  /** Tier section the caller is asking for (REQUIRED, controller-validated). */
  tier: Tier;
  game: 'BGMI' | 'FF';
  page?: number;
  dayKey?: string;
  now?: Date;
}

export interface ListRoomsItem {
  _id: Types.ObjectId;
  game: 'BGMI' | 'FF';
  scheduledAt: Date;
  status: CustomRoomAttrs['status'];
  visibleFromAt?: Date;
  resultEnabledAt?: Date;
  tier: Tier;
  pageNumber?: number;
  notice?: string;
  participantCount: number;
  isRegistered: boolean;
  credentials?: { roomId: string; roomPwd: string };
}

export interface GetResultTile {
  rank: 'top1' | 'top2' | 'top3' | 'extra';
  imageUrl?: string;
  squadName?: string;
  winners: Array<{ userId?: Types.ObjectId; prize?: number }>;
}
export interface GetResultResult {
  room: Pick<CustomRoomAttrs, '_id' | 'game' | 'scheduledAt' | 'dayKey'>;
  inRoomImageUrl?: string;
  tiles: GetResultTile[];
}

export interface CustomRoomsServiceDeps {
  roomRepo?: CustomRoomRepository;
  resultRepo?: CustomRoomResultRepository;
  appConfigRepo?: AppConfigRepository;
  encryptor?: Encryptor;
}

const PARTICIPANT_CAP = 100;

/**
 * User-facing custom-room surface.
 *
 * Phase 11.4 — auth is STRICT subscription-based. Each tier section
 * is independent: a PRO_MAX-only subscriber cannot access PRO rooms.
 * Both list filtering (Mongo-side, exact-tier match) and per-resource
 * auth (register, getResult/credentials) gate via
 * `userCanAccessTier(subscriptions, room.tier, now)`.
 *
 * PROGA feature-gated: listForDay / register / getCredentials all
 * check `appConfig.featureFlags.tournaments`. Admin service is
 * ungated — admins can prep rooms while the feature flag is off per
 * OPEN_DECISIONS #1.
 */
export class CustomRoomsService {
  private readonly roomRepo: CustomRoomRepository;
  private readonly resultRepo: CustomRoomResultRepository;
  private readonly appConfigRepo: AppConfigRepository;
  private readonly encryptor: Encryptor;

  constructor(deps: CustomRoomsServiceDeps = {}) {
    this.roomRepo = deps.roomRepo ?? new CustomRoomRepository();
    this.resultRepo = deps.resultRepo ?? new CustomRoomResultRepository();
    this.appConfigRepo = deps.appConfigRepo ?? new AppConfigRepository();
    this.encryptor = deps.encryptor ?? getDefaultEncryptor();
  }

  async listForDay(input: ListRoomsInput): Promise<ListRoomsItem[]> {
    await this.requireTournamentsEnabled();

    const now = input.now ?? new Date();
    const dayKey = input.dayKey ?? dayKeyIst(now);
    const rooms = await this.roomRepo.listForDayAndTier(
      dayKey,
      input.tier,
      input.game,
      input.page ?? 1,
    );

    const out: ListRoomsItem[] = [];
    for (const room of rooms) {
      const isRegistered = room.registeredParticipants.some(
        (id) => String(id) === String(input.userId),
      );
      const credentials = await this.maybeDecryptCreds(
        room,
        input.subscriptions,
        isRegistered,
        now,
      );
      const item: ListRoomsItem = {
        _id: room._id,
        game: room.game,
        scheduledAt: room.scheduledAt,
        status: room.status,
        tier: room.tier,
        // Prefer array length over the denormalized `participantCount`
        // counter — the counter is bumped in a second atomic op after
        // register() so it can lag the array by milliseconds under
        // concurrent writes. Array length is always accurate. The
        // counter stays useful for aggregations where touching the
        // array would be expensive.
        participantCount: room.registeredParticipants.length,
        isRegistered,
      };
      if (room.visibleFromAt !== undefined) item.visibleFromAt = room.visibleFromAt;
      if (room.resultEnabledAt !== undefined) item.resultEnabledAt = room.resultEnabledAt;
      if (room.pageNumber !== undefined) item.pageNumber = room.pageNumber;
      if (room.notice !== undefined) item.notice = room.notice;
      if (credentials) item.credentials = credentials;
      out.push(item);
    }
    return out;
  }

  /**
   * Idempotent registration. Phase 11.4 — STRICT auth: a PRO_MAX-only
   * user cannot register for a PRO room. Tier check uses the user's
   * `subscriptions[]` and `userCanAccessTier`.
   *
   * Four distinct outcomes collapsed into two return shapes + four
   * error codes:
   *   - freshly added         → `{ alreadyRegistered: false }`
   *   - already in the array  → `{ alreadyRegistered: true }`
   *   - room not found        → `NotFoundError('ROOM_NOT_FOUND')`
   *   - tier not accessible   → `ForbiddenError('TIER_NOT_ACCESSIBLE')`
   *   - wrong status          → `ConflictError('ROOM_STATE_INVALID')`
   *   - cap full              → `UnprocessableError('ROOM_FULL')`
   */
  async register(
    roomId: Types.ObjectId,
    userId: Types.ObjectId,
    subscriptions: ReadonlyArray<UserSubscriptionEntry>,
    now: Date = new Date(),
  ): Promise<{ alreadyRegistered: boolean }> {
    await this.requireTournamentsEnabled();

    // Tier gate is an advisory pre-check — the atomic update below
    // does NOT re-check tier because admins don't rotate tier mid-
    // session under normal flow. If they do, the user's registration
    // stands; admin can clean up.
    const room = await this.roomRepo.findById(roomId);
    if (!room) throw new NotFoundError('Room not found');
    if (!userCanAccessTier(subscriptions, room.tier, now)) {
      throw new ForbiddenError(
        'TIER_NOT_ACCESSIBLE',
        `Subscription required to register for a ${room.tier} room`,
      );
    }

    const pre = await CustomRoomModel.findOneAndUpdate(
      {
        _id: roomId,
        status: { $in: ['SCHEDULED', 'LIVE'] },
        [`registeredParticipants.${PARTICIPANT_CAP - 1}`]: { $exists: false },
      },
      { $addToSet: { registeredParticipants: userId } },
      { new: false },
    );

    if (!pre) {
      const nowDoc = await CustomRoomModel.findById(roomId).lean();
      if (!nowDoc) throw new NotFoundError('Room not found');
      if ((nowDoc.registeredParticipants ?? []).some((id) => String(id) === String(userId))) {
        return { alreadyRegistered: true };
      }
      if (nowDoc.status !== 'SCHEDULED' && nowDoc.status !== 'LIVE') {
        throw new ConflictError('ROOM_STATE_INVALID', `Room is ${nowDoc.status}`);
      }
      if ((nowDoc.registeredParticipants ?? []).length >= PARTICIPANT_CAP) {
        throw new UnprocessableError('ROOM_FULL', 'Room is at the participant cap');
      }
      throw new InternalError('REGISTER_FAILED', 'Registration failed for an unknown reason');
    }

    const wasAlready = pre.registeredParticipants.some((id) => String(id) === String(userId));
    if (wasAlready) return { alreadyRegistered: true };

    await CustomRoomModel.updateOne({ _id: roomId }, { $inc: { participantCount: 1 } });
    return { alreadyRegistered: false };
  }

  async getResult(roomId: Types.ObjectId, now: Date = new Date()): Promise<GetResultResult> {
    const room = await this.roomRepo.findById(roomId);
    if (!room) throw new NotFoundError('Room not found');
    if (!room.resultEnabledAt || now < room.resultEnabledAt) {
      throw new NotFoundError('Result not yet available');
    }

    const result = await this.resultRepo.findByRoom(roomId);
    const tiles: GetResultTile[] = [];
    if (result) {
      for (const rank of ['top1', 'top2', 'top3', 'extra'] as const) {
        const bucket = (result as CustomRoomResultAttrs)[rank];
        if (!bucket) continue;
        const tile: GetResultTile = { rank, winners: bucket.winners ?? [] };
        if (bucket.imageUrl !== undefined) tile.imageUrl = bucket.imageUrl;
        if (bucket.squadName !== undefined) tile.squadName = bucket.squadName;
        tiles.push(tile);
      }
    }

    const out: GetResultResult = {
      room: {
        _id: room._id,
        game: room.game,
        scheduledAt: room.scheduledAt,
        dayKey: room.dayKey,
      },
      tiles,
    };
    if (result?.inRoomImageUrl) out.inRoomImageUrl = result.inRoomImageUrl;
    return out;
  }

  // --- helpers ---------------------------------------------------------

  /**
   * Phase 11.4 — credential gating uses the strict `userCanAccessTier`
   * check. PRO_MAX-only registered user (theoretically possible under
   * an admin rotation race) cannot decrypt PRO room credentials.
   */
  private async maybeDecryptCreds(
    room: CustomRoomAttrs,
    subscriptions: ReadonlyArray<UserSubscriptionEntry>,
    isRegistered: boolean,
    now: Date,
  ): Promise<{ roomId: string; roomPwd: string } | undefined> {
    if (!isRegistered) return undefined;
    if (!userCanAccessTier(subscriptions, room.tier, now)) return undefined;
    if (!room.visibleFromAt || now < room.visibleFromAt) return undefined;
    if (!room.roomIdCt || !room.roomIdIv || !room.roomIdTag || !room.roomIdDekEnc) return undefined;
    if (!room.roomPwdCt || !room.roomPwdIv || !room.roomPwdTag || !room.roomPwdDekEnc)
      return undefined;

    const roomIdPlain = await this.encryptor.decryptField({
      ct: room.roomIdCt,
      iv: room.roomIdIv,
      tag: room.roomIdTag,
      dekEnc: room.roomIdDekEnc,
    });
    const roomPwdPlain = await this.encryptor.decryptField({
      ct: room.roomPwdCt,
      iv: room.roomPwdIv,
      tag: room.roomPwdTag,
      dekEnc: room.roomPwdDekEnc,
    });
    return { roomId: roomIdPlain, roomPwd: roomPwdPlain };
  }

  private async requireTournamentsEnabled(): Promise<void> {
    const cfg = await this.appConfigRepo.findOne({ key: 'default' });
    const enabled = Boolean(cfg?.featureFlags?.['tournaments']);
    if (!enabled) {
      throw new ForbiddenError('FEATURE_DISABLED', 'Tournaments feature is disabled');
    }
  }
}
