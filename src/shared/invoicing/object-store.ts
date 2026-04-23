import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/**
 * Opaque key-addressable object store. Per CONVENTIONS.md §Deferred
 * implementations — `S3ObjectStore` in prod, `InMemoryObjectStore`
 * in dev/test. Selection at service-construction time via
 * `env.S3_INVOICES_BUCKET` + `env.AWS_REGION`.
 */
export interface ObjectStore {
  put(key: string, body: Buffer, contentType: string): Promise<{ url: string }>;
  /** Tests may inspect by key. Prod impl does NOT implement this. */
  get?(key: string): Buffer | undefined;
}

export interface S3ObjectStoreOptions {
  region: string;
  bucket: string;
}

export class S3ObjectStore implements ObjectStore {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(opts: S3ObjectStoreOptions) {
    this.s3 = new S3Client({ region: opts.region });
    this.bucket = opts.bucket;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<{ url: string }> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    return { url: `s3://${this.bucket}/${key}` };
  }
}

/**
 * Process-local store keyed by object key. Used in dev and tests.
 * Returns a `memory://<key>` URL so callers can tell provenance
 * apart from a real S3 key.
 */
export class InMemoryObjectStore implements ObjectStore {
  private readonly store = new Map<string, Buffer>();

  async put(key: string, body: Buffer, _contentType: string): Promise<{ url: string }> {
    this.store.set(key, body);
    return { url: `memory://${key}` };
  }

  get(key: string): Buffer | undefined {
    return this.store.get(key);
  }
}
