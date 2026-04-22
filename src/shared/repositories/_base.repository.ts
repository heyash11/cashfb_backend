import type {
  ClientSession,
  DeleteResult,
  FilterQuery,
  HydratedDocument,
  Model,
  QueryOptions,
  Types,
  UpdateQuery,
  UpdateWriteOpResult,
} from 'mongoose';

/**
 * Repository-level write options. Deliberately narrow.
 *
 * Every write method accepts this. Callers running inside a Mongo
 * transaction pass the ClientSession they opened; callers outside
 * a transaction pass {} (the default).
 *
 * We DO NOT accept Mongoose's full `QueryOptions<T>` because its
 * `readPreference: string` property collides with the MongoDB
 * driver's `UpdateOptions.readPreference: ReadPreferenceLike` under
 * `exactOptionalPropertyTypes: true`. Nothing in the repository
 * contract needs those extras.
 */
export interface WriteOpts {
  session?: ClientSession;
  upsert?: boolean;
}

/**
 * Base class for all repositories.
 * - Reads use `.lean<T>().exec()` and return plain objects.
 * - Writes return hydrated Mongoose documents so service code can
 *   chain `.save({ session })` inside a transaction if needed.
 * - `findOneAndUpdate` pins `new: true` at the END of the options
 *   spread so callers cannot override it. The returned doc is always
 *   the post-update state.
 * - Model is injected via constructor (default is the module's
 *   canonical model) so tests can swap in mongodb-memory-server
 *   models or mocks.
 */
export class BaseRepository<T extends object> {
  constructor(protected readonly model: Model<T>) {}

  // ---- Reads: plain objects only ----
  async findById(id: Types.ObjectId | string): Promise<T | null> {
    return this.model.findById(id).lean<T>().exec();
  }

  async findOne(filter: FilterQuery<T>): Promise<T | null> {
    return this.model.findOne(filter).lean<T>().exec();
  }

  async find(filter: FilterQuery<T> = {}, opts: QueryOptions<T> = {}): Promise<T[]> {
    return this.model.find(filter, null, opts).lean<T[]>().exec();
  }

  async count(filter: FilterQuery<T> = {}): Promise<number> {
    return this.model.countDocuments(filter).exec();
  }

  async exists(filter: FilterQuery<T>): Promise<boolean> {
    const hit = await this.model.exists(filter).exec();
    return hit !== null;
  }

  // ---- Writes: hydrated docs ----
  async create(data: Partial<T>, opts: WriteOpts = {}): Promise<HydratedDocument<T>> {
    const created = await this.model.create([data], opts);
    const doc = created[0];
    if (!doc) {
      throw new Error(`${this.model.modelName}.create returned no document`);
    }
    return doc;
  }

  async findOneAndUpdate(
    filter: FilterQuery<T>,
    update: UpdateQuery<T>,
    opts: WriteOpts = {},
  ): Promise<HydratedDocument<T> | null> {
    return this.model.findOneAndUpdate(filter, update, { ...opts, new: true });
  }

  async updateOne(
    filter: FilterQuery<T>,
    update: UpdateQuery<T>,
    opts: WriteOpts = {},
  ): Promise<UpdateWriteOpResult> {
    return this.model.updateOne(filter, update, opts);
  }

  async updateMany(
    filter: FilterQuery<T>,
    update: UpdateQuery<T>,
    opts: WriteOpts = {},
  ): Promise<UpdateWriteOpResult> {
    return this.model.updateMany(filter, update, opts);
  }

  async deleteOne(filter: FilterQuery<T>, opts: WriteOpts = {}): Promise<DeleteResult> {
    return this.model.deleteOne(filter, opts);
  }

  async deleteMany(filter: FilterQuery<T>, opts: WriteOpts = {}): Promise<DeleteResult> {
    return this.model.deleteMany(filter, opts);
  }
}

/**
 * True if the given error is a MongoDB duplicate-key error (code 11000).
 * Exported here so concrete repositories (Vote, PostCompletion, etc.)
 * can convert unique-index collisions into typed `null` returns.
 */
export function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: number }).code === 11000
  );
}
