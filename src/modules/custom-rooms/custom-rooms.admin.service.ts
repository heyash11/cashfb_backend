import type { FilterQuery, Types } from 'mongoose';
import { env } from '../../config/env.js';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors/AppError.js';
import type { Encryptor } from '../../shared/encryption/envelope.js';
import { InMemoryEncryptor } from '../../shared/encryption/in-memory.js';
import { KmsEncryptor } from '../../shared/encryption/kms.js';
import { CustomRoomModel } from '../../shared/models/CustomRoom.model.js';
import type { CustomRoomAttrs } from '../../shared/models/CustomRoom.model.js';
import type { CustomRoomResultAttrs } from '../../shared/models/CustomRoomResult.model.js';
import type { PrizePoolWinnerAttrs } from '../../shared/models/PrizePoolWinner.model.js';
import { AppConfigRepository } from '../../shared/repositories/AppConfig.repository.js';
import { CustomRoomRepository } from '../../shared/repositories/CustomRoom.repository.js';
import { CustomRoomResultRepository } from '../../shared/repositories/CustomRoomResult.repository.js';
import { PrizePoolWinnerRepository } from '../../shared/repositories/PrizePoolWinner.repository.js';
import { isDuplicateKeyError } from '../../shared/repositories/_base.repository.js';

type Tier = 'PUBLIC' | 'PRO' | 'PRO_MAX';

export interface AdminCreateRoomInput {
  game: 'BGMI' | 'FF';
  dayKey: string;
  scheduledAt: Date;
  visibleFromAt?: Date;
  resultEnabledAt?: Date;
  tierRequired?: Tier;
  pageNumber?: number;
  notice?: string;
}

export interface AdminSetCredentialsInput {
  roomId: Types.ObjectId;
  plaintextRoomId: string;
  plaintextRoomPwd: string;
}

export interface AdminEnterResultsBucket {
  imageUrl?: string;
  squadName?: string;
  winners: Array<{ userId: Types.ObjectId; prize: number }>;
}
export interface AdminEnterResultsInput {
  roomId: Types.ObjectId;
  inRoomImageUrl?: string;
  top1?: AdminEnterResultsBucket;
  top2?: AdminEnterResultsBucket;
  top3?: AdminEnterResultsBucket;
  extra?: AdminEnterResultsBucket;
}

export type WinnerType = 'GIFT_CODE' | 'CUSTOM_ROOM';

export interface AssignWinnersInputItem {
  userId: Types.ObjectId;
  type: WinnerType;
  baseAmount: number;
  tier: Tier;
  redeemCodeId?: Types.ObjectId;
  customRoomId?: Types.ObjectId;
}
export interface AssignWinnersInput {
  dayKey: string;
  winners: AssignWinnersInputItem[];
}
export interface AssignWinnersResult {
  assigned: number;
  skipped: Array<{ userId: Types.ObjectId; reason: 'DUPLICATE' }>;
}

export interface AdminListRoomsFilter {
  game?: 'BGMI' | 'FF';
  status?: CustomRoomAttrs['status'];
  dayKey?: string;
}
export interface AdminListRoomsResult {
  items: CustomRoomAttrs[];
  nextCursor?: string;
}

export interface AdminCustomRoomsServiceDeps {
  roomRepo?: CustomRoomRepository;
  resultRepo?: CustomRoomResultRepository;
  winnerRepo?: PrizePoolWinnerRepository;
  appConfigRepo?: AppConfigRepository;
  encryptor?: Encryptor;
  clock?: () => Date;
}

/**
 * Admin-facing custom-room operations. Class-only in Phase 6;
 * HTTP + RBAC + audit-log middleware land in Phase 8. Admin service
 * is NOT gated by `featureFlags.tournaments` — admins can prep
 * rooms while the user-facing path is disabled (OPEN_DECISIONS #1).
 *
 * State transitions use the advisory-predicate pattern per
 * CONVENTIONS.md: `findOneAndUpdate({status: 'PREV'}, ...)` is the
 * atomic gate; null return → ROOM_STATE_INVALID.
 */
export class AdminCustomRoomsService {
  private readonly roomRepo: CustomRoomRepository;
  private readonly resultRepo: CustomRoomResultRepository;
  private readonly winnerRepo: PrizePoolWinnerRepository;
  private readonly appConfigRepo: AppConfigRepository;
  private readonly encryptor: Encryptor;
  private readonly clock: () => Date;

  constructor(deps: AdminCustomRoomsServiceDeps = {}) {
    this.roomRepo = deps.roomRepo ?? new CustomRoomRepository();
    this.resultRepo = deps.resultRepo ?? new CustomRoomResultRepository();
    this.winnerRepo = deps.winnerRepo ?? new PrizePoolWinnerRepository();
    this.appConfigRepo = deps.appConfigRepo ?? new AppConfigRepository();
    this.encryptor = deps.encryptor ?? defaultEncryptor();
    this.clock = deps.clock ?? (() => new Date());
  }

  async create(input: AdminCreateRoomInput, actorId: Types.ObjectId): Promise<CustomRoomAttrs> {
    const visibleFromAt = input.visibleFromAt ?? new Date(input.scheduledAt.getTime() - 5 * 60_000);
    const resultEnabledAt =
      input.resultEnabledAt ?? new Date(input.scheduledAt.getTime() + 30 * 60_000);

    const data: Partial<CustomRoomAttrs> = {
      game: input.game,
      dayKey: input.dayKey,
      scheduledAt: input.scheduledAt,
      status: 'SCHEDULED',
      tierRequired: input.tierRequired ?? 'PUBLIC',
      participantCount: 0,
      registeredParticipants: [],
      createdBy: actorId,
      visibleFromAt,
      resultEnabledAt,
    };
    if (input.pageNumber !== undefined) data.pageNumber = input.pageNumber;
    if (input.notice !== undefined) data.notice = input.notice;

    const doc = await this.roomRepo.create(data);
    return doc.toObject();
  }

  async setCredentials(input: AdminSetCredentialsInput, _actorId: Types.ObjectId): Promise<void> {
    const room = await this.roomRepo.findById(input.roomId);
    if (!room) throw new NotFoundError('Room not found');

    const roomIdField = await this.encryptor.encryptField(input.plaintextRoomId);
    const roomPwdField = await this.encryptor.encryptField(input.plaintextRoomPwd);

    await this.roomRepo.updateOne(
      { _id: input.roomId },
      {
        $set: {
          roomIdCt: roomIdField.ct,
          roomIdIv: roomIdField.iv,
          roomIdTag: roomIdField.tag,
          roomIdDekEnc: roomIdField.dekEnc,
          roomPwdCt: roomPwdField.ct,
          roomPwdIv: roomPwdField.iv,
          roomPwdTag: roomPwdField.tag,
          roomPwdDekEnc: roomPwdField.dekEnc,
        },
      },
    );
  }

  async startMatch(roomId: Types.ObjectId, _actorId: Types.ObjectId): Promise<void> {
    const updated = await CustomRoomModel.findOneAndUpdate(
      { _id: roomId, status: 'SCHEDULED' },
      { $set: { status: 'LIVE' } },
      { new: true },
    );
    if (!updated) {
      throw new ConflictError('ROOM_STATE_INVALID', 'Room is not SCHEDULED');
    }
  }

  async endMatch(roomId: Types.ObjectId, _actorId: Types.ObjectId): Promise<void> {
    const updated = await CustomRoomModel.findOneAndUpdate(
      { _id: roomId, status: 'LIVE' },
      { $set: { status: 'COMPLETED' } },
      { new: true },
    );
    if (!updated) {
      throw new ConflictError('ROOM_STATE_INVALID', 'Room is not LIVE');
    }
  }

  /**
   * Predicate-gated on `status: 'COMPLETED'`. A CustomRoomResult row
   * is created (never updated) — the unique index on `roomId`
   * prevents duplicate results.
   */
  async enterResults(input: AdminEnterResultsInput, actorId: Types.ObjectId): Promise<void> {
    const room = await CustomRoomModel.findOne({ _id: input.roomId, status: 'COMPLETED' }).lean();
    if (!room) {
      throw new ConflictError('ROOM_STATE_INVALID', 'Room is not COMPLETED');
    }

    const data: Partial<CustomRoomResultAttrs> = {
      roomId: input.roomId,
      publishedAt: this.clock(),
      publishedBy: actorId,
    };
    if (room.resultEnabledAt !== undefined) data.visibleFromAt = room.resultEnabledAt;
    if (input.inRoomImageUrl !== undefined) data.inRoomImageUrl = input.inRoomImageUrl;
    for (const rank of ['top1', 'top2', 'top3', 'extra'] as const) {
      const bucket = input[rank];
      if (!bucket) continue;
      data[rank] = {
        winners: bucket.winners,
        ...(bucket.imageUrl !== undefined ? { imageUrl: bucket.imageUrl } : {}),
        ...(bucket.squadName !== undefined ? { squadName: bucket.squadName } : {}),
      };
    }

    try {
      await this.resultRepo.create(data);
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw new ConflictError('RESULT_ALREADY_ENTERED', 'Result already exists for this room');
      }
      throw err;
    }
  }

  /**
   * Per CONVENTIONS.md §Duplicate-key writes inside transactions,
   * this is pattern 2 (terminal throw on duplicate) performed
   * OUTSIDE a transaction — each winner is independent, no
   * cross-winner invariants to protect. E11000 per winner is
   * reported as `skipped`, not fatal.
   *
   * Multiplier per OPEN_DECISIONS #4 (Option A): winner's
   * `finalAmount = baseAmount × multiplier` where multiplier is
   * read from AppConfig (`proMultiplier` / `proMaxMultiplier`,
   * defaults 5 / 10; PUBLIC is 1).
   */
  async assignWinners(
    input: AssignWinnersInput,
    _actorId: Types.ObjectId,
  ): Promise<AssignWinnersResult> {
    const cfg = await this.appConfigRepo.findOne({ key: 'default' });
    const proMultiplier = cfg?.proMultiplier ?? 5;
    const proMaxMultiplier = cfg?.proMaxMultiplier ?? 10;

    let assigned = 0;
    const skipped: AssignWinnersResult['skipped'] = [];

    for (const w of input.winners) {
      const multiplier =
        w.tier === 'PRO_MAX' ? proMaxMultiplier : w.tier === 'PRO' ? proMultiplier : 1;

      const data: Partial<PrizePoolWinnerAttrs> = {
        dayKey: input.dayKey,
        userId: w.userId,
        type: w.type,
        tier: w.tier,
        baseAmount: w.baseAmount,
        multiplier,
        finalAmount: w.baseAmount * multiplier,
        payoutStatus: 'PENDING',
        tdsDeducted: 0,
      };
      if (w.redeemCodeId) data.redeemCodeId = w.redeemCodeId;
      if (w.customRoomId) data.customRoomId = w.customRoomId;

      if (w.type === 'GIFT_CODE' && !w.redeemCodeId) {
        throw new ValidationError('redeemCodeId is required for GIFT_CODE winners');
      }
      if (w.type === 'CUSTOM_ROOM' && !w.customRoomId) {
        throw new ValidationError('customRoomId is required for CUSTOM_ROOM winners');
      }

      try {
        await this.winnerRepo.create(data);
        assigned += 1;
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          skipped.push({ userId: w.userId, reason: 'DUPLICATE' });
          continue;
        }
        throw err;
      }
    }

    return { assigned, skipped };
  }

  async listAll(
    filter: AdminListRoomsFilter,
    _cursor?: string,
    limit = 50,
  ): Promise<AdminListRoomsResult> {
    const q: FilterQuery<CustomRoomAttrs> = {};
    if (filter.game) q.game = filter.game;
    if (filter.status) q.status = filter.status;
    if (filter.dayKey) q.dayKey = filter.dayKey;
    const items = await this.roomRepo.find(q, {
      sort: { scheduledAt: -1, _id: -1 },
      limit: Math.max(1, Math.min(200, limit)),
    });
    return { items };
  }

  /** Audit before-snapshot helper used by the Phase 8 auditLog middleware. */
  async getForAudit(roomId: Types.ObjectId | string): Promise<CustomRoomAttrs | null> {
    return this.roomRepo.findById(roomId);
  }
}

function defaultEncryptor(): Encryptor {
  if (env.KMS_KEY_ID && env.AWS_REGION) {
    return new KmsEncryptor({ region: env.AWS_REGION, keyId: env.KMS_KEY_ID });
  }
  return new InMemoryEncryptor();
}
