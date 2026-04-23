import { describe, expect, it } from 'vitest';
import { InMemoryEncryptor } from './in-memory.js';

describe('InMemoryEncryptor', () => {
  it('two encrypts of the same plaintext produce different dekEnc values (per-field DEK isolation)', async () => {
    const enc = new InMemoryEncryptor();
    const a = await enc.encryptField('same plaintext');
    const b = await enc.encryptField('same plaintext');

    expect(a.dekEnc).not.toBe(b.dekEnc);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
    expect(a.tag).not.toBe(b.tag);

    // Sanity: both still decrypt cleanly (envelope round-trip under
    // per-field DEKs wrapped by the shared master key).
    expect(await enc.decryptField(a)).toBe('same plaintext');
    expect(await enc.decryptField(b)).toBe('same plaintext');
  });
});
