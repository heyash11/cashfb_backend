import { DecryptCommand, GenerateDataKeyCommand, type KMSClient } from '@aws-sdk/client-kms';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createEncryptor, type EncryptedField } from './envelope.js';

type KmsCommand = GenerateDataKeyCommand | DecryptCommand;

interface FakeKms {
  client: KMSClient;
  callLog: string[];
}

/**
 * Hand-rolled KMS fake. Not aws-sdk-client-mock, per the Phase 1
 * plan. Implements just `send()` for the two commands we use.
 */
function createFakeKms(): FakeKms {
  const callLog: string[] = [];
  const wrapStore = new Map<string, Buffer>();

  async function send(command: KmsCommand): Promise<unknown> {
    if (command instanceof GenerateDataKeyCommand) {
      callLog.push('GenerateDataKey');
      const dek = randomBytes(32);
      const wrap = randomBytes(32);
      wrapStore.set(wrap.toString('base64'), dek);
      return { Plaintext: dek, CiphertextBlob: wrap };
    }
    if (command instanceof DecryptCommand) {
      callLog.push('Decrypt');
      const blob = command.input.CiphertextBlob as Uint8Array;
      const key = Buffer.from(blob).toString('base64');
      const dek = wrapStore.get(key);
      if (!dek) throw new Error('fake KMS: unknown wrapped DEK');
      return { Plaintext: dek };
    }
    throw new Error('fake KMS: unexpected command');
  }

  const client = { send } as unknown as KMSClient;
  return { client, callLog };
}

describe('envelope encryptor', () => {
  it('round-trips plaintext through encrypt and decrypt', async () => {
    const fake = createFakeKms();
    const enc = createEncryptor({ kms: fake.client, keyId: 'arn:fake' });

    const secret = 'ABCD-EFGH-JKLM-NPQR';
    const field = await enc.encryptField(secret);
    const recovered = await enc.decryptField(field);

    expect(recovered).toBe(secret);
  });

  it('generates a unique wrapped DEK for each encrypt call', async () => {
    const fake = createFakeKms();
    const enc = createEncryptor({ kms: fake.client, keyId: 'arn:fake' });

    const a = await enc.encryptField('same plaintext');
    const b = await enc.encryptField('same plaintext');

    expect(a.dekEnc).not.toBe(b.dekEnc);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it('rejects ciphertext with a tampered GCM auth tag', async () => {
    const fake = createFakeKms();
    const enc = createEncryptor({ kms: fake.client, keyId: 'arn:fake' });

    const field = await enc.encryptField('top-secret');
    const tampered: EncryptedField = {
      ...field,
      tag: randomBytes(16).toString('base64'),
    };

    await expect(enc.decryptField(tampered)).rejects.toThrow();
  });

  it('caches decrypted DEKs so a repeat decrypt makes zero KMS calls', async () => {
    const fake = createFakeKms();
    const enc = createEncryptor({ kms: fake.client, keyId: 'arn:fake' });

    const field = await enc.encryptField('cache-me');
    expect(fake.callLog).toEqual(['GenerateDataKey']);

    const first = await enc.decryptField(field);
    expect(first).toBe('cache-me');
    expect(fake.callLog).toEqual(['GenerateDataKey', 'Decrypt']);

    const second = await enc.decryptField(field);
    expect(second).toBe('cache-me');
    expect(fake.callLog).toEqual(['GenerateDataKey', 'Decrypt']);
  });
});
