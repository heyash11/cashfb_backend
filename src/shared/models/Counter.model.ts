import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';
import { baseSchemaOptions } from './_base.js';

/**
 * Monotonic counters keyed by purpose. Primary use: sequential GST
 * invoice numbers per FY, keyed as `invoice:<FY>` (see PAYMENTS.md §6).
 * Atomic via findOneAndUpdate({key}, {$inc: {value: 1}}, {upsert: true}).
 */

export interface CounterAttrs {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  key: string;
  value: number;
}

const CounterSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: Number, required: true, default: 0 },
  },
  baseSchemaOptions,
);

export type CounterDoc = HydratedDocument<CounterAttrs>;
export const CounterModel: Model<CounterAttrs> = model<CounterAttrs>(
  'Counter',
  CounterSchema,
  'counters',
);
export { CounterSchema };
