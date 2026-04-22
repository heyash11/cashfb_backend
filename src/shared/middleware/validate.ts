import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';
import { ValidationError } from '../errors/AppError.js';

/**
 * Body-only Zod validator. All seven auth endpoints are POSTs with a
 * JSON body, so Phase 2 does not validate `query` or `params`. Add a
 * source argument later if needed.
 *
 * On success, `req.body` is replaced with the parsed output (coerced
 * values + defaults applied), so handlers see the exact shape the
 * schema describes.
 */
export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      next(
        new ValidationError('Request body failed validation', {
          issues: result.error.issues.map((i) => ({
            path: i.path.join('.') || '(root)',
            message: i.message,
          })),
        }),
      );
      return;
    }
    req.body = result.data;
    next();
  };
}
