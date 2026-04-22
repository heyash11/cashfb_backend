import type { OtpSendInput, OtpService, OtpVerifyInput } from './otp.types.js';

/**
 * Chunk-2 stub. Every call throws. Lets AuthService typecheck and
 * routes wire up cleanly, while forcing Chunk 3 to swap in a real
 * implementation (DevConsole or MSG91) before endpoints are exercised.
 *
 * Deliberately does NOT implement `otp_verifications` writes here —
 * that logic belongs in the real service so the stub doesn't ship
 * silent half-behaviour.
 */
export class OtpServiceStub implements OtpService {
  async send(_input: OtpSendInput): Promise<void> {
    throw new Error(
      'TODO(chunk-3): OtpService.send not implemented. Phase 2 stub is wired only for DI + typecheck.',
    );
  }

  async verify(_input: OtpVerifyInput): Promise<void> {
    throw new Error(
      'TODO(chunk-3): OtpService.verify not implemented. Phase 2 stub is wired only for DI + typecheck.',
    );
  }
}
