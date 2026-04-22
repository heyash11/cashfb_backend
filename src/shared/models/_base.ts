import type { SchemaOptions } from 'mongoose';

/**
 * Shared schema options applied to every model per CONVENTIONS.md §Mongoose:
 * - timestamps: true
 * - versionKey: false
 * - toJSON: strip _id / __v, add string `id`.
 */
export const baseSchemaOptions: SchemaOptions = {
  timestamps: true,
  versionKey: false,
  toJSON: {
    virtuals: true,
    transform(_doc, ret) {
      const obj = ret as Record<string, unknown>;
      if (obj['_id'] != null) {
        obj['id'] = String(obj['_id']);
        delete obj['_id'];
      }
      delete obj['__v'];
      return obj;
    },
  },
};

/**
 * Same as baseSchemaOptions, but without automatic createdAt/updatedAt.
 * Use for collections that either maintain their own timestamps
 * (top_donor_rankings.computedAt) or for lookup-only tables.
 */
export const baseSchemaOptionsNoTimestamps: SchemaOptions = {
  ...baseSchemaOptions,
  timestamps: false,
};
