import type { Request } from 'express';
import { Types } from 'mongoose';
import type { AuditCaptureContext } from '../../shared/middleware/audit-log.js';
import type { AdminNotificationsService, BroadcastInput } from './admin-notifications.service.js';
import { AdminBroadcastBodySchema } from './admin-notifications.schemas.js';

export class AdminNotificationsController {
  constructor(private readonly service: AdminNotificationsService) {}

  broadcast = async (req: Request): Promise<AuditCaptureContext> => {
    const body = AdminBroadcastBodySchema.parse(req.body);
    const actorId = new Types.ObjectId(req.admin!.adminId);
    const input: BroadcastInput =
      body.target.mode === 'user'
        ? { target: { mode: 'user', userId: new Types.ObjectId(body.target.userId) } }
        : body.target.mode === 'tier'
          ? { target: { mode: 'tier', tier: body.target.tier } }
          : { target: { mode: 'all' } };
    if (body.title !== undefined) input.title = body.title;
    if (body.body !== undefined) input.body = body.body;
    if (body.payload !== undefined) input.payload = body.payload;

    const result = await this.service.broadcast(input, actorId);
    return {
      before: null,
      after: {
        broadcastId: result.broadcastId,
        inserted: result.inserted,
        targetMode: body.target.mode,
      },
      resourceKind: 'Notification',
    };
  };
}
