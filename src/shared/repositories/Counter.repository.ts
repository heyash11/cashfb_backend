import type { Model } from 'mongoose';
import { CounterModel, type CounterAttrs } from '../models/Counter.model.js';
import { BaseRepository, type WriteOpts } from './_base.repository.js';

export class CounterRepository extends BaseRepository<CounterAttrs> {
  constructor(model: Model<CounterAttrs> = CounterModel) {
    super(model);
  }

  /**
   * Atomic monotonic counter. Returns the NEW value after increment.
   * Used for sequential GST invoice numbering (key='invoice:<FY>')
   * per PAYMENTS.md §6. Upserts on first use.
   */
  async incrementAndGet(key: string, opts: WriteOpts = {}): Promise<number> {
    const updated = await this.model
      .findOneAndUpdate({ key }, { $inc: { value: 1 } }, { ...opts, upsert: true, new: true })
      .lean<{ value: number }>()
      .exec();
    if (!updated) {
      throw new Error(`Counter '${key}' upsert returned null`);
    }
    return updated.value;
  }
}
