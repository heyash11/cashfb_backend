import {
  Schema,
  model,
  Types,
  type HydratedDocument,
  type InferSchemaType,
  type Model,
} from 'mongoose';
import { baseSchemaOptions } from './_base.js';

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

export type CmsContentAttrs = InferSchemaType<typeof CmsContentSchema>;
export type CmsContentDoc = HydratedDocument<CmsContentAttrs>;
export const CmsContentModel: Model<CmsContentAttrs> = model<CmsContentAttrs>(
  'CmsContent',
  CmsContentSchema,
  'cms_content',
);
export { CmsContentSchema };
