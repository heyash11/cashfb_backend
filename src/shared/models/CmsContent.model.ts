import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';
import { baseSchemaOptions } from './_base.js';

export interface CmsContentAttrs {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  key: 'TERMS' | 'HOW_DISTRIBUTE' | 'FAQ' | 'PRIVACY' | 'GRIEVANCE';
  html?: string;
  version: number;
  updatedBy?: Types.ObjectId;
}

const CmsContentSchema = new Schema(
  {
    key: {
      type: String,
      enum: ['TERMS', 'HOW_DISTRIBUTE', 'FAQ', 'PRIVACY', 'GRIEVANCE'],
      required: true,
      unique: true,
    },
    html: String,
    version: { type: Number, default: 1 },
    updatedBy: { type: Types.ObjectId, ref: 'AdminUser' },
  },
  baseSchemaOptions,
);

export type CmsContentDoc = HydratedDocument<CmsContentAttrs>;
export const CmsContentModel: Model<CmsContentAttrs> = model<CmsContentAttrs>(
  'CmsContent',
  CmsContentSchema,
  'cms_content',
);
export { CmsContentSchema };
