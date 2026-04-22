import { describe, expect, it } from 'vitest';
import {
  AppError,
  BadRequestError,
  ConflictError,
  InternalError,
  NotFoundError,
  RateLimitedError,
  UnauthorizedError,
  ValidationError,
} from './AppError.js';

describe('AppError hierarchy', () => {
  it('ValidationError carries fixed code + details', () => {
    const err = new ValidationError('Validation failed', {
      issues: [{ path: 'phone', message: 'required' }],
    });
    expect(err).toBeInstanceOf(AppError);
    expect(err.httpStatus).toBe(400);
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.message).toBe('Validation failed');
    expect(err.details).toEqual({ issues: [{ path: 'phone', message: 'required' }] });
  });

  it('BadRequestError takes a runtime code', () => {
    const err = new BadRequestError('INVALID_SIGNATURE', 'bad signature');
    expect(err.httpStatus).toBe(400);
    expect(err.code).toBe('INVALID_SIGNATURE');
  });

  it('UnauthorizedError is fixed code, 401', () => {
    const err = new UnauthorizedError('bad token');
    expect(err.httpStatus).toBe(401);
    expect(err.code).toBe('UNAUTHORIZED');
  });

  it('NotFoundError is fixed code, 404', () => {
    const err = new NotFoundError('nope');
    expect(err.httpStatus).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
  });

  it('ConflictError takes a runtime code (VOTE_ALREADY_CAST et al.)', () => {
    const err = new ConflictError('VOTE_ALREADY_CAST', 'voted today');
    expect(err.httpStatus).toBe(409);
    expect(err.code).toBe('VOTE_ALREADY_CAST');
  });

  it('RateLimitedError is fixed code, 429', () => {
    const err = new RateLimitedError('slow down');
    expect(err.httpStatus).toBe(429);
    expect(err.code).toBe('RATE_LIMITED');
  });

  it('InternalError defaults to code INTERNAL + 500', () => {
    const err = new InternalError();
    expect(err.httpStatus).toBe(500);
    expect(err.code).toBe('INTERNAL');
    expect(err.message).toBe('Internal server error');
  });

  it('details is undefined when not passed', () => {
    const err = new UnauthorizedError('bad token');
    expect(err.details).toBeUndefined();
  });
});
