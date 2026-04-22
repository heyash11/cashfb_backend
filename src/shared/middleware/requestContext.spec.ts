import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { requestContext } from './requestContext.js';

function mkReq(headers: Record<string, string> = {}, ip = '203.0.113.5'): Request {
  return {
    header: (name: string): string | undefined => headers[name.toLowerCase()],
    ip,
    socket: { remoteAddress: ip },
  } as unknown as Request;
}

describe('requestContext middleware', () => {
  it('populates reqId, ipAddress, userAgent, deviceId, fingerprint', () => {
    const req = mkReq({
      'x-request-id': 'req-123',
      'user-agent': 'CashFB/1.0',
      'x-device-id': 'dev-abc',
      'x-device-fingerprint': 'fp-xyz',
    });
    const next = vi.fn();
    requestContext(req, {} as Response, next as NextFunction);
    expect(req.context).toEqual({
      reqId: 'req-123',
      ipAddress: '203.0.113.5',
      userAgent: 'CashFB/1.0',
      deviceId: 'dev-abc',
      deviceFingerprint: 'fp-xyz',
    });
    expect(req.id).toBe('req-123');
    expect(next).toHaveBeenCalledOnce();
  });

  it('generates a UUID reqId when header is absent', () => {
    const req = mkReq({ 'user-agent': 'test' });
    requestContext(req, {} as Response, vi.fn() as NextFunction);
    expect(req.context?.reqId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('deviceId + fingerprint default to null when headers are absent', () => {
    const req = mkReq({ 'user-agent': 'test' });
    requestContext(req, {} as Response, vi.fn() as NextFunction);
    expect(req.context?.deviceId).toBeNull();
    expect(req.context?.deviceFingerprint).toBeNull();
  });

  it('falls back to "unknown" for missing ip and user-agent', () => {
    const req = {
      header: () => undefined,
      socket: {},
    } as unknown as Request;
    requestContext(req, {} as Response, vi.fn() as NextFunction);
    expect(req.context?.ipAddress).toBe('unknown');
    expect(req.context?.userAgent).toBe('unknown');
  });
});
