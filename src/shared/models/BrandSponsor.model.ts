import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';
import { baseSchemaOptions } from './_base.js';

export interface BrandSponsorAttrs {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  slot: number;
  imageUrl: string;
  linkUrl?: string;
  title?: string;
  priority: number;
  startAt?: Date;
  endAt?: Date;
  status: 'ACTIVE' | 'PAUSED' | 'EXPIRED';
}

const BrandSponsorSchema = new Schema(
  {
    slot: { type: Number, min: 1, max: 3, required: true, index: true },
    imageUrl: { type: String, required: true },
    linkUrl: String,
    title: String,
    priority: { type: Number, default: 0 },
    startAt: Date,
    endAt: Date,
    status: {
      type: String,
      enum: ['ACTIVE', 'PAUSED', 'EXPIRED'],
      default: 'ACTIVE',
      index: true,
    },
  },
  baseSchemaOptions,
);

BrandSponsorSchema.index({ slot: 1, status: 1, priority: -1 }); // home sponsor resolution

export type BrandSponsorDoc = HydratedDocument<BrandSponsorAttrs>;
export const BrandSponsorModel: Model<BrandSponsorAttrs> = model<BrandSponsorAttrs>(
  'BrandSponsor',
  BrandSponsorSchema,
  'brand_sponsors',
);
export { BrandSponsorSchema };
