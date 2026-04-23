import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildMime, wrapBase64Rfc2045 } from './email-sender.js';

describe('wrapBase64Rfc2045', () => {
  it('leaves strings shorter than 76 chars untouched', () => {
    expect(wrapBase64Rfc2045('AAAA')).toBe('AAAA');
    expect(wrapBase64Rfc2045('A'.repeat(76))).toBe('A'.repeat(76));
  });

  it('splits strings longer than 76 chars on exact 76-char boundaries joined by CRLF', () => {
    const input = 'A'.repeat(76) + 'B'.repeat(76) + 'C'.repeat(40);
    const wrapped = wrapBase64Rfc2045(input);
    const parts = wrapped.split('\r\n');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('A'.repeat(76));
    expect(parts[1]).toBe('B'.repeat(76));
    expect(parts[2]).toBe('C'.repeat(40));
    // Every non-terminal line is exactly 76 chars.
    for (const p of parts.slice(0, -1)) expect(p).toHaveLength(76);
  });
});

describe('buildMime — RFC 2045 compliance', () => {
  it('attachment base64 has every non-terminal line ≤ 76 chars, separated by CRLF', () => {
    // A 10 KB attachment encodes to ~13,660 base64 chars — ~180 lines.
    const content = randomBytes(10_000);
    const mime = buildMime(
      'noreply@cashfb.test',
      undefined,
      {
        to: 'user@example.com',
        subject: 'Invoice CF/2026-27/000001',
        bodyText: 'PDF attached.',
        attachments: [{ filename: 'invoice.pdf', contentType: 'application/pdf', content }],
      },
      'boundary_test',
    );

    const mimeStr = mime.toString('utf8');
    // Isolate the attachment section: between the attachment's blank
    // separator and the closing boundary marker.
    const attachStart = mimeStr.indexOf('Content-Disposition: attachment; filename="invoice.pdf"');
    expect(attachStart).toBeGreaterThan(-1);
    const closingBoundary = '--boundary_test--';
    const closingIdx = mimeStr.indexOf(closingBoundary);
    expect(closingIdx).toBeGreaterThan(attachStart);

    // The body of the attachment sits between the blank line after the
    // disposition header and the closing boundary.
    const afterHeaders = mimeStr.indexOf('\r\n\r\n', attachStart) + 4;
    const base64Body = mimeStr.slice(afterHeaders, closingIdx).trimEnd();
    const base64Lines = base64Body.split('\r\n');

    // Should be multiple lines for a 10 KB attachment.
    expect(base64Lines.length).toBeGreaterThan(50);
    // Every non-terminal line exactly 76 chars; terminal ≤ 76.
    for (const line of base64Lines.slice(0, -1)) expect(line).toHaveLength(76);
    const last = base64Lines[base64Lines.length - 1] ?? '';
    expect(last.length).toBeLessThanOrEqual(76);
    expect(last.length).toBeGreaterThan(0);

    // Round-trip: join lines, base64-decode, compare to original bytes.
    const decoded = Buffer.from(base64Lines.join(''), 'base64');
    expect(decoded.equals(content)).toBe(true);
  });
});
