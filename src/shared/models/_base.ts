/**
 * Shared schema options applied to every model per CONVENTIONS.md §Mongoose:
 * - timestamps: true
 * - versionKey: false
 * - toJSON: strip _id / __v, add string `id`.
 *
 * We deliberately DO NOT annotate these as `SchemaOptions`. That widening
 * defeats Mongoose's schema inference and produces nonsense `InferSchemaType`
 * results (e.g. a `name: String` field typed as `{ type?: string | null; ... }`
 * instead of `string`). Letting TS infer the literal shape keeps inference
 * tight through the `new Schema(..., baseSchemaOptions)` call.
 */
export const baseSchemaOptions = {
  timestamps: true,
  versionKey: false,
  toJSON: {
    virtuals: true,
    transform(_doc: unknown, ret: unknown) {
      const obj = ret as Record<string, unknown>;
      if (obj['_id'] != null) {
        obj['id'] = String(obj['_id']);
        delete obj['_id'];
      }
      delete obj['__v'];
      return obj;
    },
  },
} as const;

/**
 * Same as baseSchemaOptions, but without automatic createdAt/updatedAt.
 * Use for collections that either maintain their own timestamps
 * (top_donor_rankings.computedAt) or are lookup-only.
 */
export const baseSchemaOptionsNoTimestamps = {
  ...baseSchemaOptions,
  timestamps: false,
} as const;
