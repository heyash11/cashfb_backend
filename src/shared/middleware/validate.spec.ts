import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ValidationError } from '../errors/AppError.js';
import { validateBody } from './validate.js';

const Schema = z.object({
  phone: z.string().min(1),
  count: z.coerce.number().int().min(1).default(1),
});

function run(body: unknown): { req: Partial<Request>; next: NextFunction; error: unknown } {
  const req = { body } as Partial<Request>;
  const res = {} as Partial<Response>;
  let captured: unknown;
  const next = vi.fn((err?: unknown) => {
    captured = err;
  });
  validateBody(Schema)(req as Request, res as Response, next);
  return { req, next, error: captured };
}

describe('validateBody middleware', () => {
  it('parses valid body and replaces req.body with parsed output', () => {
    const { req, next, error } = run({ phone: '+91...', count: '5' });
    expect(error).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
    expect(req.body).toEqual({ phone: '+91...', count: 5 }); // coerced
  });

  it('applies defaults when fields are missing', () => {
    const { req, error } = run({ phone: '+91...' });
    expect(error).toBeUndefined();
    expect((req.body as { count: number }).count).toBe(1);
  });

  it('forwards ValidationError with issues when invalid', () => {
    const { error } = run({ phone: '', count: 'not-a-number' });
    expect(error).toBeInstanceOf(ValidationError);
    const ve = error as ValidationError;
    expect(ve.code).toBe('VALIDATION_FAILED');
    expect(ve.httpStatus).toBe(400);
    const issues = (ve.details?.['issues'] ?? []) as Array<{ path: string }>;
    const paths = issues.map((i) => i.path);
    expect(paths).toContain('phone');
  });

  it('calls next without args on success', () => {
    const { next } = run({ phone: '+91...' });
    expect(next).toHaveBeenCalledWith();
  });
});
