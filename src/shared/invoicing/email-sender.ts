import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';
import { logger } from '../../config/logger.js';

export interface EmailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  bodyText: string;
  attachments?: EmailAttachment[];
}

/**
 * EmailSender is `SesEmailSender` in prod, `LogOnlyEmailSender` in
 * dev/test. Deferred-implementations seam per CONVENTIONS.md.
 * Selection is env-gated (SES_FROM_EMAIL + AWS_REGION).
 */
export interface EmailSender {
  send(input: SendEmailInput): Promise<void>;
}

export interface SesEmailSenderOptions {
  region: string;
  fromEmail: string;
  replyToEmail?: string;
}

/**
 * Wraps a base64 string to 76 chars per line with CRLF terminators
 * per RFC 2045 §6.8. Gmail / Outlook / SES tolerate longer lines in
 * practice, but strict MIME parsers (some corporate gateways,
 * Thunderbird with strict mode) reject them silently. Line-wrapping
 * is cheap — always do it.
 */
export function wrapBase64Rfc2045(base64: string): string {
  const chunks: string[] = [];
  for (let i = 0; i < base64.length; i += 76) {
    chunks.push(base64.slice(i, i + 76));
  }
  return chunks.join('\r\n');
}

/**
 * Minimal MIME builder — the SES SDK's simple `SendEmailCommand`
 * does NOT support attachments, so we build a multipart/mixed blob
 * and hand it to `SendRawEmailCommand`. Boundaries are random hex so
 * they can't appear in attachment content.
 *
 * Exported (not just a private helper) so `buildMime` can be
 * unit-tested directly without constructing a real `SesEmailSender`
 * or hitting the SES client.
 */
export function buildMime(
  from: string,
  replyTo: string | undefined,
  input: SendEmailInput,
  boundary: string,
): Buffer {
  const lines: string[] = [];
  lines.push(`From: ${from}`);
  lines.push(`To: ${input.to}`);
  if (replyTo) lines.push(`Reply-To: ${replyTo}`);
  lines.push(`Subject: ${input.subject}`);
  lines.push('MIME-Version: 1.0');
  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  lines.push('');
  lines.push(`--${boundary}`);
  lines.push('Content-Type: text/plain; charset=UTF-8');
  lines.push('Content-Transfer-Encoding: 7bit');
  lines.push('');
  lines.push(input.bodyText);
  lines.push('');
  for (const att of input.attachments ?? []) {
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: ${att.contentType}; name="${att.filename}"`);
    lines.push('Content-Transfer-Encoding: base64');
    lines.push(`Content-Disposition: attachment; filename="${att.filename}"`);
    lines.push('');
    lines.push(wrapBase64Rfc2045(att.content.toString('base64')));
    lines.push('');
  }
  lines.push(`--${boundary}--`);
  return Buffer.from(lines.join('\r\n'), 'utf8');
}

export class SesEmailSender implements EmailSender {
  private readonly ses: SESClient;
  private readonly fromEmail: string;
  private readonly replyToEmail: string | undefined;

  constructor(opts: SesEmailSenderOptions) {
    this.ses = new SESClient({ region: opts.region });
    this.fromEmail = opts.fromEmail;
    this.replyToEmail = opts.replyToEmail;
  }

  async send(input: SendEmailInput): Promise<void> {
    const boundary = `boundary_${Date.now().toString(16)}_${Math.random().toString(16).slice(2, 10)}`;
    const mime = buildMime(this.fromEmail, this.replyToEmail, input, boundary);
    await this.ses.send(
      new SendRawEmailCommand({
        RawMessage: { Data: new Uint8Array(mime) },
        Source: this.fromEmail,
        Destinations: [input.to],
      }),
    );
  }
}

/**
 * Dev/test fallback. Logs the envelope (redacted) and discards the
 * body + attachments. Never a network call.
 */
export class LogOnlyEmailSender implements EmailSender {
  async send(input: SendEmailInput): Promise<void> {
    logger.info(
      {
        to: input.to,
        subject: input.subject,
        attachmentCount: input.attachments?.length ?? 0,
      },
      '[email] (log-only) would-send',
    );
  }
}
