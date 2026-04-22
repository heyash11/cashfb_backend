import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { logger } from '../../config/logger.js';
import { AppError, InternalError, ValidationError } from './AppError.js';

/**
 * Global Express error handler. Converts any thrown value into the
 * `{ success: false, error: { code, message, details? } }` envelope
 * per CONVENTIONS.md §API response shaping.
 *
 * Order of handling:
 * 1. AppError subclasses → render as-is.
 * 2. Raw ZodError (not wrapped) → wrap in ValidationError.
 * 3. Anything else → 500 InternalError, redacted message, full error
 *    logged with the request id for correlation.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let appErr: AppError;

  if (err instanceof AppError) {
    appErr = err;
  } else if (err instanceof ZodError) {
    appErr = new ValidationError('Validation failed', {
      issues: err.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  } else {
    appErr = new InternalError();
    logger.error({ err, reqId: req.id, path: req.path, method: req.method }, 'unhandled error');
  }

  const payload: {
    success: false;
    error: { code: string; message: string; details?: Record<string, unknown> };
  } = {
    success: false,
    error: {
      code: appErr.code,
      message: appErr.message,
    },
  };

  if (appErr.details) {
    payload.error.details = appErr.details;
  }

  res.status(appErr.httpStatus).json(payload);
};
