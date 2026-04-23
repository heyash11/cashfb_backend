import type { RequestContext } from '../shared/middleware/requestContext.js';
import type { AccessClaims } from '../shared/jwt/signer.js';
import type { AdminSession } from '../shared/sessions/admin-session.store.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by `requestContext` middleware; mirrors context.reqId. */
      id?: string;
      /** Request-scoped identity + tracing signals. Populated by `requestContext`. */
      context?: RequestContext;
      /** Populated by `requireUser` after access-token verification. */
      user?: AccessClaims;
      /** Populated by `adminSession` middleware after session validation (Phase 8). */
      admin?: AdminSession;
    }
  }
}

export {};
