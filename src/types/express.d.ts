import type { RequestContext } from '../shared/middleware/requestContext.js';
import type { AccessClaims } from '../shared/jwt/signer.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by `requestContext` middleware; mirrors context.reqId. */
      id?: string;
      /** Request-scoped identity + tracing signals. Populated by `requestContext`. */
      context?: RequestContext;
      /** Populated by `requireUser` after access-token verification. */
      user?: AccessClaims;
    }
  }
}

export {};
