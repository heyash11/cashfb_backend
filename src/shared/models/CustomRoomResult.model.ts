import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';
import { baseSchemaOptions } from './_base.js';

export interface CustomRoomResultWinner {
  userId?: Types.ObjectId;
  prize?: number; // paise
}

export interface CustomRoomResultBucket {
  imageUrl?: string; // S3 key
  squadName?: string;
  winners: CustomRoomResultWinner[];
}

export interface CustomRoomResultAttrs {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  roomId: Types.ObjectId;
  inRoomImageUrl?: string;
  top1?: CustomRoomResultBucket;
  top2?: CustomRoomResultBucket;
  top3?: CustomRoomResultBucket;
  extra?: CustomRoomResultBucket;
  publishedAt?: Date;
  visibleFromAt?: Date;
  publishedBy?: Types.ObjectId;
}

// Each winner entry inside a bucket. _id: false per ambiguity #5.
const WinnerEntrySchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: 'User' },
    prize: Number, // paise
  },
  { _id: false },
);

// A single bucket (top1/top2/top3/extra). _id: false on the bucket
// itself so the embedded object doesn't carry an ObjectId.
const ResultBucketSchema = new Schema(
  {
    imageUrl: String, // S3 key
    squadName: String,
    winners: { type: [WinnerEntrySchema], default: [] },
  },
  { _id: false },
);

const CustomRoomResultSchema = new Schema(
  {
    roomId: { type: Types.ObjectId, ref: 'CustomRoom', required: true, unique: true, index: true },
    inRoomImageUrl: String, // S3 key
    top1: ResultBucketSchema,
    top2: ResultBucketSchema,
    top3: ResultBucketSchema,
    extra: ResultBucketSchema,
    publishedAt: Date,
    visibleFromAt: Date, // mirrors room.resultEnabledAt
    publishedBy: { type: Types.ObjectId, ref: 'AdminUser' },
  },
  baseSchemaOptions,
);

export type CustomRoomResultDoc = HydratedDocument<CustomRoomResultAttrs>;
export const CustomRoomResultModel: Model<CustomRoomResultAttrs> = model<CustomRoomResultAttrs>(
  'CustomRoomResult',
  CustomRoomResultSchema,
  'custom_room_results',
);
export { CustomRoomResultSchema };
