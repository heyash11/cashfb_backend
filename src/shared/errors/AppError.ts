/**
 * AppError hierarchy per docs/CONVENTIONS.md §Errors.
 *
 * Every subclass carries a stable `code` (matches docs/API.md §12),
 * an `httpStatus`, a `message`, and optional `details`. Sentry tags
 * events by `code`. Services throw these; the error handler renders
 * them into the success:false envelope.
 */
export abstract class AppError extends Error {
  abstract readonly httpStatus: number;
  abstract readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  readonly httpStatus = 400;
  readonly code = 'VALIDATION_FAILED';
}

export class BadRequestError extends AppError {
  readonly httpStatus = 400;
  readonly code: string;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message, details);
    this.code = code;
  }
}

export class UnauthorizedError extends AppError {
  readonly httpStatus = 401;
  readonly code = 'UNAUTHORIZED';
}

export class PaymentRequiredError extends AppError {
  readonly httpStatus = 402;
  readonly code: string;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message, details);
    this.code = code;
  }
}

export class ForbiddenError extends AppError {
  readonly httpStatus = 403;
  readonly code: string;
  constructor(
    code: string = 'FORBIDDEN',
    message: string = 'Forbidden',
    details?: Record<string, unknown>,
  ) {
    super(message, details);
    this.code = code;
  }
}

export class NotFoundError extends AppError {
  readonly httpStatus = 404;
  readonly code = 'NOT_FOUND';
}

export class ConflictError extends AppError {
  readonly httpStatus = 409;
  readonly code: string;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message, details);
    this.code = code;
  }
}

export class UnprocessableError extends AppError {
  readonly httpStatus = 422;
  readonly code: string;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message, details);
    this.code = code;
  }
}

export class RateLimitedError extends AppError {
  readonly httpStatus = 429;
  readonly code = 'RATE_LIMITED';
}

export class GeoBlockedError extends AppError {
  readonly httpStatus = 451;
  readonly code = 'GEO_BLOCKED';
}

/**
 * Phase 8 §KYC+TDS gate on prize-winner claim path. Thrown when a
 * user's cumulative FY prize value exceeds `AppConfig.kycThresholdAmount`
 * AND their KYC status is not `VERIFIED`. 451 matches the legal-
 * reasons semantic already used by GeoBlockedError; client maps to
 * "PAN required to claim this prize."
 */
export class KycRequiredError extends AppError {
  readonly httpStatus = 451;
  readonly code = 'KYC_REQUIRED';
}

export class InternalError extends AppError {
  readonly httpStatus = 500;
  readonly code: string;
  constructor(
    code: string = 'INTERNAL',
    message: string = 'Internal server error',
    details?: Record<string, unknown>,
  ) {
    super(message, details);
    this.code = code;
  }
}
