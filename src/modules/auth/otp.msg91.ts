import { InternalError } from '../../shared/errors/AppError.js';
import { logger } from '../../config/logger.js';
import type { OtpPurpose, OtpSender } from './otp.types.js';

/**
 * MSG91 Flow API adapter. Only dispatches when the DLT template ID
 * and auth key are registered — see OPEN_DECISIONS.md #14.
 *
 * `fetch` is injectable for tests so we can assert the exact request
 * shape and simulate non-2xx responses without real HTTP traffic.
 */
export interface Msg91SenderOptions {
  authKey: string;
  templateId: string;
  /** Optional 6-char DLT-approved sender ID. Propagates to MSG91 as `sender_id`. */
  senderId?: string;
  /** Inject for tests. Defaults to global fetch (Node 22+). */
  httpFetch?: typeof fetch;
  /** Override for tests or regional MSG91 hosts. */
  baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://api.msg91.com';

export class Msg91Sender implements OtpSender {
  private readonly authKey: string;
  private readonly templateId: string;
  private readonly senderId: string | undefined;
  private readonly httpFetch: typeof fetch;
  private readonly baseUrl: string;

  constructor(opts: Msg91SenderOptions) {
    this.authKey = opts.authKey;
    this.templateId = opts.templateId;
    this.senderId = opts.senderId;
    this.httpFetch = opts.httpFetch ?? fetch;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  }

  async send(phone: string, otp: string, purpose: OtpPurpose): Promise<void> {
    // MSG91 wants the number without the leading `+`.
    const mobile = phone.replace(/^\+/, '');
    const body: Record<string, unknown> = {
      template_id: this.templateId,
      mobiles: mobile,
      OTP: otp,
    };
    if (this.senderId) body['sender_id'] = this.senderId;

    const res = await this.httpFetch(`${this.baseUrl}/api/v5/flow/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authkey: this.authKey,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error({ status: res.status, text, phone, purpose }, 'MSG91 send failed');
      throw new InternalError('MSG91_FAILED', `MSG91 responded ${res.status}`);
    }
  }
}
