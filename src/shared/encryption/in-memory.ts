import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { EncryptedField, Encryptor } from './envelope.js';

/**
 * In-process `Encryptor` with a real per-field DEK envelope. Matches
 * `KmsEncryptor` byte-for-byte at the `EncryptedField` level — the
 * only difference is that the DEK is wrapped under a process-local
 * master key via AES-256-GCM instead of round-tripped through KMS.
 *
 * Used in tests and local dev. Selected at service wiring time when
 * `env.KMS_KEY_ID` is not set. Do NOT use in production — master key
 * lives in process memory, does not persist across restarts, and has
 * no rotation or audit. See CONVENTIONS.md §Deferred implementations.
 */
interface WrappedDekPayload {
  wrappedDek: string; // base64 ciphertext of the DEK, wrapped under masterKey
  dekIv: string; // base64, 12-byte IV used for the wrap call
  dekTag: string; // base64, GCM tag of the wrap call
}

function isWrappedDekPayload(x: unknown): x is WrappedDekPayload {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as Record<string, unknown>)['wrappedDek'] === 'string' &&
    typeof (x as Record<string, unknown>)['dekIv'] === 'string' &&
    typeof (x as Record<string, unknown>)['dekTag'] === 'string'
  );
}

export class InMemoryEncryptor implements Encryptor {
  private readonly masterKey: Buffer;

  constructor() {
    this.masterKey = randomBytes(32);
  }

  async encryptField(plaintext: string): Promise<EncryptedField> {
    // 1. Fresh per-field DEK.
    const dek = randomBytes(32);

    // 2. Encrypt plaintext under the DEK.
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', dek, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    // 3. Wrap the DEK under the instance master key (separate IV + tag).
    const dekIv = randomBytes(12);
    const wrapCipher = createCipheriv('aes-256-gcm', this.masterKey, dekIv);
    const wrappedDek = Buffer.concat([wrapCipher.update(dek), wrapCipher.final()]);
    const dekTag = wrapCipher.getAuthTag();

    const payload: WrappedDekPayload = {
      wrappedDek: wrappedDek.toString('base64'),
      dekIv: dekIv.toString('base64'),
      dekTag: dekTag.toString('base64'),
    };

    return {
      ct: ct.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      dekEnc: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
    };
  }

  async decryptField(field: EncryptedField): Promise<string> {
    // 1. Parse the wrapped-DEK payload out of dekEnc.
    const raw = Buffer.from(field.dekEnc, 'base64').toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('InMemoryEncryptor: dekEnc is not valid JSON');
    }
    if (!isWrappedDekPayload(parsed)) {
      throw new Error('InMemoryEncryptor: dekEnc shape is invalid');
    }

    // 2. Unwrap the DEK under the master key.
    const unwrap = createDecipheriv(
      'aes-256-gcm',
      this.masterKey,
      Buffer.from(parsed.dekIv, 'base64'),
    );
    unwrap.setAuthTag(Buffer.from(parsed.dekTag, 'base64'));
    const dek = Buffer.concat([
      unwrap.update(Buffer.from(parsed.wrappedDek, 'base64')),
      unwrap.final(),
    ]);

    // 3. Decrypt the payload ciphertext under the unwrapped DEK.
    const decipher = createDecipheriv('aes-256-gcm', dek, Buffer.from(field.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(field.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(field.ct, 'base64')),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  }
}
