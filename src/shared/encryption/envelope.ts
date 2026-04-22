import { DecryptCommand, GenerateDataKeyCommand, type KMSClient } from '@aws-sdk/client-kms';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { LRUCache } from 'lru-cache';

/**
 * Shape persisted on any encrypted field. Mirrors the
 * `{codeCt, codeIv, codeTag, codeDekEnc}`-prefixed columns used
 * across users.kyc.pan*, redeem_codes.code*, custom_rooms.roomId*,
 * and custom_rooms.roomPwd* in docs/DATA_MODEL.md.
 */
export interface EncryptedField {
  ct: string;
  iv: string;
  tag: string;
  dekEnc: string;
}

export interface Encryptor {
  encryptField(plaintext: string): Promise<EncryptedField>;
  decryptField(field: EncryptedField): Promise<string>;
}

export interface EncryptorDeps {
  kms: KMSClient;
  keyId: string;
  dekCache?: LRUCache<string, Buffer>;
}

const DEFAULT_DEK_CACHE_MAX = 1000;
const DEFAULT_DEK_CACHE_TTL_MS = 5 * 60 * 1000;

export function createEncryptor(deps: EncryptorDeps): Encryptor {
  const cache =
    deps.dekCache ??
    new LRUCache<string, Buffer>({
      max: DEFAULT_DEK_CACHE_MAX,
      ttl: DEFAULT_DEK_CACHE_TTL_MS,
    });

  async function encryptField(plaintext: string): Promise<EncryptedField> {
    const { Plaintext, CiphertextBlob } = await deps.kms.send(
      new GenerateDataKeyCommand({ KeyId: deps.keyId, KeySpec: 'AES_256' }),
    );
    if (!Plaintext || !CiphertextBlob) {
      throw new Error('KMS GenerateDataKey returned empty Plaintext or CiphertextBlob');
    }

    const dek = Buffer.from(Plaintext);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', dek, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      ct: ct.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      dekEnc: Buffer.from(CiphertextBlob).toString('base64'),
    };
  }

  async function decryptField(field: EncryptedField): Promise<string> {
    let dek = cache.get(field.dekEnc);
    if (!dek) {
      const { Plaintext } = await deps.kms.send(
        new DecryptCommand({ CiphertextBlob: Buffer.from(field.dekEnc, 'base64') }),
      );
      if (!Plaintext) {
        throw new Error('KMS Decrypt returned empty Plaintext');
      }
      dek = Buffer.from(Plaintext);
      cache.set(field.dekEnc, dek);
    }

    const decipher = createDecipheriv('aes-256-gcm', dek, Buffer.from(field.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(field.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(field.ct, 'base64')),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  }

  return { encryptField, decryptField };
}
