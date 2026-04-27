import type { RequestContext } from '../shared/middleware/requestContext.js';
import type { AuthedReqUser } from '../shared/middleware/auth.middleware.js';
import type { AdminSession } from '../shared/sessions/admin-session.store.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by `requestContext` middleware; mirrors context.reqId. */
      id?: string;
      /** Request-scoped identity + tracing signals. Populated by `requestContext`. */
      context?: RequestContext;
      /**
       * Populated by `requireUser` after access-token verification +
       * tokenVersion check + User fetch (Phase 11.5). Carries the
       * AccessClaims plus `subscriptions[]` from the User row so
       * downstream controllers don't re-fetch.
       */
      user?: AuthedReqUser;
      /** Populated by `adminSession` middleware after session validation (Phase 8). */
      admin?: AdminSession;
    }
  }
}

export {};
