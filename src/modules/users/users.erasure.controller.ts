import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { requireAuthedUser } from '../../shared/middleware/auth.middleware.js';
import type { UserErasureService } from './users.erasure.service.js';

/**
 * HTTP edge for `/me/account/erasure` (Phase 9 Chunk 4).
 *
 * Three verbs on a single resource:
 *   POST   → request erasure (idempotent)
 *   DELETE → cancel during grace
 *   GET    → status (requested + daysRemaining)
 */
export class UserErasureController {
  constructor(private readonly service: UserErasureService) {}

  request = async (req: Request, res: Response): Promise<void> => {
    const claims = requireAuthedUser(req);
    const userId = new Types.ObjectId(claims.sub);
    const status = await this.service.request(userId);
    res.json({ success: true, data: status });
  };

  cancel = async (req: Request, res: Response): Promise<void> => {
    const claims = requireAuthedUser(req);
    const userId = new Types.ObjectId(claims.sub);
    const status = await this.service.cancel(userId);
    res.json({ success: true, data: status });
  };

  status = async (req: Request, res: Response): Promise<void> => {
    const claims = requireAuthedUser(req);
    const userId = new Types.ObjectId(claims.sub);
    const status = await this.service.status(userId);
    res.json({ success: true, data: status });
  };
}
