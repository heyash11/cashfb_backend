import { describe, expect, it } from 'vitest';
import { REDACTED_PLACEHOLDER, redactSensitive } from './redact.js';

describe('redactSensitive', () => {
  it('redacts leaf-key matches at any nesting depth (passwordHash, codeCt)', () => {
    const input = {
      email: 'x@cashfb.test',
      passwordHash: '$2b$12$real-hash',
      nested: { passwordHash: '$2b$12$nested-hash', codeCt: 'ct-bytes' },
      arr: [{ codeCt: 'ct-in-array' }],
    };
    const out = redactSensitive(input) as typeof input;

    expect(out.email).toBe('x@cashfb.test');
    expect(out.passwordHash).toBe(REDACTED_PLACEHOLDER);
    expect(out.nested.passwordHash).toBe(REDACTED_PLACEHOLDER);
    expect(out.nested.codeCt).toBe(REDACTED_PLACEHOLDER);
    expect(out.arr[0]?.codeCt).toBe(REDACTED_PLACEHOLDER);
  });

  it('redacts dotted-path matches (twoFactor.secret, twoFactor.recoveryCodes)', () => {
    const input = {
      email: 'x@cashfb.test',
      twoFactor: {
        enabled: true,
        secret: 'JBSWY3DPEHPK3PXP',
        recoveryCodes: ['abc-111', 'def-222'],
      },
    };
    const out = redactSensitive(input) as typeof input;

    expect(out.twoFactor.enabled).toBe(true);
    expect(out.twoFactor.secret as unknown).toBe(REDACTED_PLACEHOLDER);
    expect(out.twoFactor.recoveryCodes as unknown).toBe(REDACTED_PLACEHOLDER);
  });

  it('does NOT redact `secret` at an unrelated path (dotted-path scoping)', () => {
    // A hypothetical collection that uses `secret` for a benign
    // field — must not be accidentally redacted by the dotted-path
    // entry for twoFactor.secret.
    const input = { webhook: { name: 'razorpay', secret: 'webhook-hmac-key' } };
    const out = redactSensitive(input) as typeof input;
    expect(out.webhook.secret).toBe('webhook-hmac-key');
  });

  it('passes scalars, null, and undefined through unchanged', () => {
    expect(redactSensitive(42)).toBe(42);
    expect(redactSensitive('hello')).toBe('hello');
    expect(redactSensitive(null)).toBe(null);
    expect(redactSensitive(undefined)).toBe(undefined);
    expect(redactSensitive(true)).toBe(true);
  });

  it('passes non-plain objects (ObjectId, Date, Buffer) through by reference', async () => {
    // Lean-doc shape from Mongoose: _id is an ObjectId instance,
    // createdAt is a Date. The redactor must NOT walk their
    // internal fields — doing so would serialise an ObjectId's
    // buffer bytes as a POJO and break downstream re-parsing.
    const { Types } = await import('mongoose');
    const id = new Types.ObjectId();
    const createdAt = new Date('2026-04-24T00:00:00.000Z');
    const input = {
      _id: id,
      passwordHash: 'secret-hash',
      createdAt,
      codeCt: 'cipher-bytes',
    };
    const out = redactSensitive(input) as typeof input;

    expect(out.passwordHash).toBe(REDACTED_PLACEHOLDER);
    expect(out.codeCt).toBe(REDACTED_PLACEHOLDER);
    // ObjectId instance preserved by reference — same hex string
    // on both sides (round-trips unchanged).
    expect(out._id).toBe(id);
    expect(out._id.toHexString()).toBe(id.toHexString());
    // Date preserved by reference.
    expect(out.createdAt).toBe(createdAt);
  });
});
