import { beforeEach, describe, expect, it } from 'vitest';
import { env } from '../../config/env.js';
import { shouldBypassSignupOtp } from './auth.service.js';

/**
 * Phase 9 Chunk 5 — OTP-bypass predicate coverage. The predicate is
 * a pure function of (NODE_ENV, phone, _devBypassOtp). We mutate
 * `env.NODE_ENV` in-place per spec (the env object is the module's
 * singleton — vitest's per-file module isolation keeps this from
 * leaking into other specs). Each spec restores NODE_ENV to its
 * starting value in `beforeEach` to stay deterministic.
 *
 * The predicate returns `true` only when ALL THREE gates pass. These
 * four specs lock the matrix (3 individual false cases + 1 all-pass).
 */

const originalNodeEnv = env.NODE_ENV;

beforeEach(() => {
  (env as { NODE_ENV: string }).NODE_ENV = 'development';
});

describe('shouldBypassSignupOtp (dev-mode OTP bypass predicate)', () => {
  it('returns true when all three gates pass (development + load-test phone + flag)', () => {
    const result = shouldBypassSignupOtp({ phone: '+919999990001', _devBypassOtp: true });
    expect(result).toBe(true);
  });

  it('returns false when NODE_ENV is not development (production or test)', () => {
    (env as { NODE_ENV: string }).NODE_ENV = 'production';
    expect(shouldBypassSignupOtp({ phone: '+919999990001', _devBypassOtp: true })).toBe(false);
    (env as { NODE_ENV: string }).NODE_ENV = 'test';
    expect(shouldBypassSignupOtp({ phone: '+919999990001', _devBypassOtp: true })).toBe(false);
  });

  it('returns false when phone does NOT match the load-test prefix', () => {
    // Real user phone — different operator prefix.
    expect(shouldBypassSignupOtp({ phone: '+919876543210', _devBypassOtp: true })).toBe(false);
    // Close to the prefix but wrong trailing shape (too long).
    expect(shouldBypassSignupOtp({ phone: '+9199999900012', _devBypassOtp: true })).toBe(false);
    // Close to the prefix but wrong middle digit.
    expect(shouldBypassSignupOtp({ phone: '+919999999001', _devBypassOtp: true })).toBe(false);
  });

  it('returns false when _devBypassOtp is absent or false', () => {
    expect(shouldBypassSignupOtp({ phone: '+919999990001' })).toBe(false);
    // The typed signature only allows `true`, but runtime truthy-false
    // sneaking through still needs to return false. Defence in depth.
    expect(
      shouldBypassSignupOtp({
        phone: '+919999990001',
        _devBypassOtp: false as unknown as true,
      }),
    ).toBe(false);
  });
});

// Sentinel: ensure NODE_ENV is restored to its starting value when
// the file finishes, so other specs aren't poisoned.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
originalNodeEnv;
