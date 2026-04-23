import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { InMemoryEncryptor } from '../../shared/encryption/in-memory.js';
import { AppConfigModel } from '../../shared/models/AppConfig.model.js';
import { CustomRoomModel } from '../../shared/models/CustomRoom.model.js';
import { MODELS } from '../../shared/models/index.js';
import { AdminCustomRoomsService } from './custom-rooms.admin.service.js';
import { CustomRoomsService } from './custom-rooms.service.js';

type AnyModel = { syncIndexes(): Promise<string[]> };

async function seedTournamentsFlag(enabled: boolean): Promise<void> {
  await AppConfigModel.updateOne(
    { key: 'default' },
    { $set: { featureFlags: { tournaments: enabled } } },
    { upsert: true },
  );
}

async function mkRoom(
  encryptor: InMemoryEncryptor,
  overrides: Partial<{
    game: 'BGMI' | 'FF';
    status: 'SCHEDULED' | 'LIVE' | 'COMPLETED' | 'CANCELLED';
    tierRequired: 'PUBLIC' | 'PRO' | 'PRO_MAX';
    visibleFromAt: Date;
    resultEnabledAt: Date;
    roomCredPlain?: { roomId: string; roomPwd: string };
    participants: Types.ObjectId[];
  }> = {},
): Promise<{ _id: Types.ObjectId }> {
  const encRoom = overrides.roomCredPlain
    ? await encryptor.encryptField(overrides.roomCredPlain.roomId)
    : null;
  const encPwd = overrides.roomCredPlain
    ? await encryptor.encryptField(overrides.roomCredPlain.roomPwd)
    : null;

  const room = await CustomRoomModel.create({
    game: overrides.game ?? 'BGMI',
    dayKey: '2026-04-23',
    scheduledAt: new Date('2026-04-23T12:00:00Z'),
    visibleFromAt: overrides.visibleFromAt ?? new Date('2026-04-23T11:55:00Z'),
    resultEnabledAt: overrides.resultEnabledAt ?? new Date('2026-04-23T12:30:00Z'),
    status: overrides.status ?? 'SCHEDULED',
    tierRequired: overrides.tierRequired ?? 'PUBLIC',
    participantCount: (overrides.participants ?? []).length,
    registeredParticipants: overrides.participants ?? [],
    createdBy: new Types.ObjectId(),
    ...(encRoom && encPwd
      ? {
          roomIdCt: encRoom.ct,
          roomIdIv: encRoom.iv,
          roomIdTag: encRoom.tag,
          roomIdDekEnc: encRoom.dekEnc,
          roomPwdCt: encPwd.ct,
          roomPwdIv: encPwd.iv,
          roomPwdTag: encPwd.tag,
          roomPwdDekEnc: encPwd.dekEnc,
        }
      : {}),
  });
  return { _id: room._id };
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

describe('CustomRoomsService.listForDay', () => {
  it('non-registered user sees status-only rows; no credentials even when LIVE + visibleFromAt passed; FEATURE_DISABLED when flag is off', async () => {
    const encryptor = new InMemoryEncryptor();
    const svc = new CustomRoomsService({ encryptor });
    await seedTournamentsFlag(true);
    await mkRoom(encryptor, {
      status: 'LIVE',
      roomCredPlain: { roomId: 'R-NONREG', roomPwd: 'PW' },
    });
    const userId = new Types.ObjectId();

    const items = await svc.listForDay({
      userId,
      userTier: 'PUBLIC',
      game: 'BGMI',
      now: new Date('2026-04-23T12:00:00Z'),
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.isRegistered).toBe(false);
    expect(items[0]?.credentials).toBeUndefined();

    // Flip the flag off — request throws FEATURE_DISABLED.
    await seedTournamentsFlag(false);
    await expect(
      svc.listForDay({ userId, userTier: 'PUBLIC', game: 'BGMI' }),
    ).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });
  });

  it('registered user on LIVE room with now ≥ visibleFromAt and tier ≥ required returns decrypted credentials', async () => {
    const encryptor = new InMemoryEncryptor();
    const svc = new CustomRoomsService({ encryptor });
    await seedTournamentsFlag(true);
    const userId = new Types.ObjectId();
    await mkRoom(encryptor, {
      status: 'LIVE',
      tierRequired: 'PRO',
      visibleFromAt: new Date('2026-04-23T11:55:00Z'),
      roomCredPlain: { roomId: 'ROOM-XYZ', roomPwd: 'PWD-123' },
      participants: [userId],
    });

    const items = await svc.listForDay({
      userId,
      userTier: 'PRO',
      game: 'BGMI',
      now: new Date('2026-04-23T12:00:00Z'),
    });
    expect(items[0]?.isRegistered).toBe(true);
    expect(items[0]?.credentials).toEqual({ roomId: 'ROOM-XYZ', roomPwd: 'PWD-123' });
  });

  it('registered user with now < visibleFromAt OR tier < required gets credentials undefined', async () => {
    const encryptor = new InMemoryEncryptor();
    const svc = new CustomRoomsService({ encryptor });
    await seedTournamentsFlag(true);
    const userId = new Types.ObjectId();
    await mkRoom(encryptor, {
      status: 'LIVE',
      tierRequired: 'PRO',
      visibleFromAt: new Date('2026-04-23T12:00:00Z'),
      roomCredPlain: { roomId: 'ROOM-HIDDEN', roomPwd: 'PWD' },
      participants: [userId],
    });

    // Too early: before visibleFromAt.
    const early = await svc.listForDay({
      userId,
      userTier: 'PRO',
      game: 'BGMI',
      now: new Date('2026-04-23T11:59:00Z'),
    });
    expect(early[0]?.isRegistered).toBe(true);
    expect(early[0]?.credentials).toBeUndefined();

    // Wrong tier: PUBLIC viewer on a PRO-required room.
    const wrongTier = await svc.listForDay({
      userId,
      userTier: 'PUBLIC',
      game: 'BGMI',
      now: new Date('2026-04-23T12:05:00Z'),
    });
    expect(wrongTier[0]?.credentials).toBeUndefined();
  });
});

describe('CustomRoomsService.register', () => {
  it('is idempotent: second register returns alreadyRegistered=true; participantCount does not double', async () => {
    const encryptor = new InMemoryEncryptor();
    const svc = new CustomRoomsService({ encryptor });
    await seedTournamentsFlag(true);
    const { _id: roomId } = await mkRoom(encryptor, { status: 'SCHEDULED' });
    const userId = new Types.ObjectId();

    const first = await svc.register(roomId, userId, 'PUBLIC');
    expect(first).toEqual({ alreadyRegistered: false });

    const second = await svc.register(roomId, userId, 'PUBLIC');
    expect(second).toEqual({ alreadyRegistered: true });

    const after = await CustomRoomModel.findById(roomId);
    expect(after?.participantCount).toBe(1);
    expect(after?.registeredParticipants).toHaveLength(1);
    expect(String(after?.registeredParticipants[0])).toBe(String(userId));
  });

  it('distinguishes already-registered from ROOM_FULL: second register on the same user returns alreadyRegistered=true even when cap is full', async () => {
    const encryptor = new InMemoryEncryptor();
    const svc = new CustomRoomsService({ encryptor });
    await seedTournamentsFlag(true);

    const reusedUser = new Types.ObjectId();
    // Cap the room with 100 participants, of which reusedUser is one.
    const participants = [reusedUser, ...Array.from({ length: 99 }, () => new Types.ObjectId())];
    const { _id: roomId } = await mkRoom(encryptor, { status: 'SCHEDULED', participants });

    const res = await svc.register(roomId, reusedUser, 'PUBLIC');
    expect(res).toEqual({ alreadyRegistered: true });

    const after = await CustomRoomModel.findById(roomId);
    expect(after?.registeredParticipants).toHaveLength(100);
    expect(after?.participantCount).toBe(100); // from fixture; counter did NOT bump
  });

  it('throws ROOM_FULL when cap is reached and user is NOT already registered', async () => {
    const encryptor = new InMemoryEncryptor();
    const svc = new CustomRoomsService({ encryptor });
    await seedTournamentsFlag(true);

    const participants = Array.from({ length: 100 }, () => new Types.ObjectId());
    const { _id: roomId } = await mkRoom(encryptor, { status: 'SCHEDULED', participants });
    const newUser = new Types.ObjectId();

    await expect(svc.register(roomId, newUser, 'PUBLIC')).rejects.toMatchObject({
      code: 'ROOM_FULL',
    });
  });

  it('throws ROOM_STATE_INVALID when room is COMPLETED or CANCELLED', async () => {
    const encryptor = new InMemoryEncryptor();
    const svc = new CustomRoomsService({ encryptor });
    await seedTournamentsFlag(true);

    const { _id: completedId } = await mkRoom(encryptor, { status: 'COMPLETED' });
    await expect(svc.register(completedId, new Types.ObjectId(), 'PUBLIC')).rejects.toMatchObject({
      code: 'ROOM_STATE_INVALID',
    });

    const { _id: cancelledId } = await mkRoom(encryptor, { status: 'CANCELLED' });
    await expect(svc.register(cancelledId, new Types.ObjectId(), 'PUBLIC')).rejects.toMatchObject({
      code: 'ROOM_STATE_INVALID',
    });
  });

  it('throws NOT_FOUND when roomId does not exist', async () => {
    const svc = new CustomRoomsService({ encryptor: new InMemoryEncryptor() });
    await seedTournamentsFlag(true);

    await expect(
      svc.register(new Types.ObjectId(), new Types.ObjectId(), 'PUBLIC'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ---- admin service specs -------------------------------------------

describe('AdminCustomRoomsService', () => {
  it('create: persists with default visibleFromAt (scheduledAt − 5m) and resultEnabledAt (scheduledAt + 30m)', async () => {
    const svc = new AdminCustomRoomsService({ encryptor: new InMemoryEncryptor() });
    const actor = new Types.ObjectId();
    const scheduledAt = new Date('2026-04-23T12:00:00Z');

    const room = await svc.create({ game: 'BGMI', dayKey: '2026-04-23', scheduledAt }, actor);

    expect(room.status).toBe('SCHEDULED');
    expect(room.visibleFromAt?.toISOString()).toBe('2026-04-23T11:55:00.000Z');
    expect(room.resultEnabledAt?.toISOString()).toBe('2026-04-23T12:30:00.000Z');
    expect(room.registeredParticipants).toEqual([]);
  });

  it('setCredentials: encrypts both roomId and roomPwd; plaintext nowhere on the row; decrypt roundtrips', async () => {
    const encryptor = new InMemoryEncryptor();
    const svc = new AdminCustomRoomsService({ encryptor });
    const actor = new Types.ObjectId();
    const room = await svc.create(
      {
        game: 'BGMI',
        dayKey: '2026-04-23',
        scheduledAt: new Date('2026-04-23T12:00:00Z'),
      },
      actor,
    );

    await svc.setCredentials(
      { roomId: room._id, plaintextRoomId: 'RM-SECRET', plaintextRoomPwd: 'PW-SECRET' },
      actor,
    );

    const raw = await CustomRoomModel.findById(room._id).lean();
    expect(raw?.roomIdCt).toBeTruthy();
    expect(raw?.roomPwdCt).toBeTruthy();
    expect(JSON.stringify(raw)).not.toContain('RM-SECRET');
    expect(JSON.stringify(raw)).not.toContain('PW-SECRET');

    const roundtrip = await encryptor.decryptField({
      ct: raw!.roomIdCt!,
      iv: raw!.roomIdIv!,
      tag: raw!.roomIdTag!,
      dekEnc: raw!.roomIdDekEnc!,
    });
    expect(roundtrip).toBe('RM-SECRET');
  });

  it('startMatch: SCHEDULED → LIVE; calling on LIVE throws ROOM_STATE_INVALID', async () => {
    const svc = new AdminCustomRoomsService({ encryptor: new InMemoryEncryptor() });
    const actor = new Types.ObjectId();
    const room = await svc.create(
      {
        game: 'BGMI',
        dayKey: '2026-04-23',
        scheduledAt: new Date('2026-04-23T12:00:00Z'),
      },
      actor,
    );

    await svc.startMatch(room._id, actor);
    const live = await CustomRoomModel.findById(room._id);
    expect(live?.status).toBe('LIVE');

    await expect(svc.startMatch(room._id, actor)).rejects.toMatchObject({
      code: 'ROOM_STATE_INVALID',
    });
  });

  it('endMatch: LIVE → COMPLETED; calling on SCHEDULED throws ROOM_STATE_INVALID', async () => {
    const svc = new AdminCustomRoomsService({ encryptor: new InMemoryEncryptor() });
    const actor = new Types.ObjectId();
    const room = await svc.create(
      {
        game: 'BGMI',
        dayKey: '2026-04-23',
        scheduledAt: new Date('2026-04-23T12:00:00Z'),
      },
      actor,
    );

    await expect(svc.endMatch(room._id, actor)).rejects.toMatchObject({
      code: 'ROOM_STATE_INVALID',
    });

    await svc.startMatch(room._id, actor);
    await svc.endMatch(room._id, actor);

    const done = await CustomRoomModel.findById(room._id);
    expect(done?.status).toBe('COMPLETED');
  });

  it('enterResults: COMPLETED room creates CustomRoomResult; calling on LIVE throws ROOM_STATE_INVALID', async () => {
    const svc = new AdminCustomRoomsService({ encryptor: new InMemoryEncryptor() });
    const actor = new Types.ObjectId();
    const room = await svc.create(
      {
        game: 'BGMI',
        dayKey: '2026-04-23',
        scheduledAt: new Date('2026-04-23T12:00:00Z'),
      },
      actor,
    );
    await svc.startMatch(room._id, actor);

    await expect(
      svc.enterResults(
        {
          roomId: room._id,
          top1: { winners: [{ userId: new Types.ObjectId(), prize: 5000 }] },
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'ROOM_STATE_INVALID' });

    await svc.endMatch(room._id, actor);
    const winner = new Types.ObjectId();
    await svc.enterResults(
      {
        roomId: room._id,
        top1: { squadName: 'Alpha', winners: [{ userId: winner, prize: 10000 }] },
      },
      actor,
    );

    const result = await (
      await import('../../shared/models/CustomRoomResult.model.js')
    ).CustomRoomResultModel.findOne({ roomId: room._id });
    expect(result?.top1?.squadName).toBe('Alpha');
    expect(String(result?.top1?.winners[0]?.userId)).toBe(String(winner));
  });

  it('assignWinners: applies proMultiplier (5) and proMaxMultiplier (10) to baseAmount for finalAmount', async () => {
    const svc = new AdminCustomRoomsService({ encryptor: new InMemoryEncryptor() });
    const actor = new Types.ObjectId();

    const proUser = new Types.ObjectId();
    const proMaxUser = new Types.ObjectId();
    const publicUser = new Types.ObjectId();
    const codeA = new Types.ObjectId();
    const codeB = new Types.ObjectId();
    const codeC = new Types.ObjectId();

    const result = await svc.assignWinners(
      {
        dayKey: '2026-04-23',
        winners: [
          {
            userId: proUser,
            type: 'GIFT_CODE',
            baseAmount: 5000,
            tier: 'PRO',
            redeemCodeId: codeA,
          },
          {
            userId: proMaxUser,
            type: 'GIFT_CODE',
            baseAmount: 5000,
            tier: 'PRO_MAX',
            redeemCodeId: codeB,
          },
          {
            userId: publicUser,
            type: 'GIFT_CODE',
            baseAmount: 5000,
            tier: 'PUBLIC',
            redeemCodeId: codeC,
          },
        ],
      },
      actor,
    );
    expect(result.assigned).toBe(3);
    expect(result.skipped).toHaveLength(0);

    const { PrizePoolWinnerModel } = await import('../../shared/models/PrizePoolWinner.model.js');
    const pro = await PrizePoolWinnerModel.findOne({ userId: proUser });
    const proMax = await PrizePoolWinnerModel.findOne({ userId: proMaxUser });
    const pub = await PrizePoolWinnerModel.findOne({ userId: publicUser });
    expect(pro?.multiplier).toBe(5);
    expect(pro?.finalAmount).toBe(25_000);
    expect(proMax?.multiplier).toBe(10);
    expect(proMax?.finalAmount).toBe(50_000);
    expect(pub?.multiplier).toBe(1);
    expect(pub?.finalAmount).toBe(5_000);
  });
});
