import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';
import { baseSchemaOptions } from './_base.js';
import { TIER_VALUES, type Tier } from './_tier.js';

export interface CustomRoomAttrs {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  game: 'BGMI' | 'FF';
  dayKey: string;
  scheduledAt: Date;
  // Encrypted credentials (envelope helper). All optional until admin sets them.
  roomIdCt?: string;
  roomIdIv?: string;
  roomIdTag?: string;
  roomIdDekEnc?: string;
  roomPwdCt?: string;
  roomPwdIv?: string;
  roomPwdTag?: string;
  roomPwdDekEnc?: string;
  visibleFromAt?: Date;
  resultEnabledAt?: Date; // scheduledAt + 30 min
  status: 'SCHEDULED' | 'LIVE' | 'COMPLETED' | 'CANCELLED';
  pageNumber?: number;
  notice?: string;
  /**
   * Phase 11.4 — renamed from `tierRequired`. Parallel-tier scoping
   * field; list endpoints filter by exact match. Per-resource auth
   * (register, getResult) checks the user's strict subscription set
   * via `userCanAccessTier`.
   */
  tier: Tier;
  participantCount: number;
  /**
   * User IDs of registered participants. Bounded at 100 (BGMI's
   * natural custom-room cap). `participantCount` is derived from
   * the array length on every register() via `$addToSet + $size`
   * semantics. If product later needs spectators, cancellation, or
   * an audit trail of registration timestamps, migrate to a
   * dedicated `custom_room_participations` collection — the read
   * surface here is narrow (`isRegistered` check + count).
   */
  registeredParticipants: Types.ObjectId[];
  createdBy: Types.ObjectId;
}

const CustomRoomSchema = new Schema(
  {
    game: { type: String, enum: ['BGMI', 'FF'], required: true, index: true },
    dayKey: { type: String, required: true, index: true },
    scheduledAt: { type: Date, required: true, index: true },

    // Encrypted at rest (envelope helper). One set per credential.
    roomIdCt: String,
    roomIdIv: String,
    roomIdTag: String,
    roomIdDekEnc: String,
    roomPwdCt: String,
    roomPwdIv: String,
    roomPwdTag: String,
    roomPwdDekEnc: String,

    visibleFromAt: Date,
    resultEnabledAt: Date, // scheduledAt + 30 min

    status: {
      type: String,
      enum: ['SCHEDULED', 'LIVE', 'COMPLETED', 'CANCELLED'],
      default: 'SCHEDULED',
      index: true,
    },
    pageNumber: Number,
    notice: String,
    tier: { type: String, enum: TIER_VALUES, default: 'PUBLIC', required: true },
    participantCount: { type: Number, default: 0 },
    registeredParticipants: { type: [{ type: Types.ObjectId, ref: 'User' }], default: [] },
    createdBy: { type: Types.ObjectId, ref: 'AdminUser', required: true },
  },
  baseSchemaOptions,
);

CustomRoomSchema.index({ dayKey: 1, game: 1, scheduledAt: 1 }); // legacy daily feed per game (retained)
CustomRoomSchema.index({ status: 1, scheduledAt: 1 }); // status sweep
// Phase 11.4 — tier-scoped daily feed per game.
CustomRoomSchema.index({ tier: 1, dayKey: 1, game: 1, scheduledAt: 1 });

export type CustomRoomDoc = HydratedDocument<CustomRoomAttrs>;
export const CustomRoomModel: Model<CustomRoomAttrs> = model<CustomRoomAttrs>(
  'CustomRoom',
  CustomRoomSchema,
  'custom_rooms',
);
export { CustomRoomSchema };
