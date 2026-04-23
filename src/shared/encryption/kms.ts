import { KMSClient } from '@aws-sdk/client-kms';
import { createEncryptor, type EncryptedField, type Encryptor } from './envelope.js';

export interface KmsEncryptorOptions {
  region: string;
  keyId: string;
}

/**
 * Thin class wrapper around `createEncryptor` with a real KMS client.
 * Selected at service-construction time when `env.KMS_KEY_ID` is set;
 * otherwise the `InMemoryEncryptor` fallback runs. See CONVENTIONS.md
 * §Deferred implementations.
 */
export class KmsEncryptor implements Encryptor {
  private readonly inner: Encryptor;

  constructor(opts: KmsEncryptorOptions) {
    const kms = new KMSClient({ region: opts.region });
    this.inner = createEncryptor({ kms, keyId: opts.keyId });
  }

  encryptField(plaintext: string): Promise<EncryptedField> {
    return this.inner.encryptField(plaintext);
  }

  decryptField(field: EncryptedField): Promise<string> {
    return this.inner.decryptField(field);
  }
}
