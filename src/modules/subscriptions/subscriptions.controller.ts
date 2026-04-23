import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { requireAuthedUser } from '../../shared/middleware/auth.middleware.js';
import {
  CancelSubscriptionBodySchema,
  CreateSubscriptionBodySchema,
  SubscriptionIdParamsSchema,
  VerifySubscriptionBodySchema,
} from './subscriptions.schemas.js';
import type { SubscriptionService } from './subscriptions.service.js';

export class SubscriptionsController {
  constructor(private readonly service: SubscriptionService) {}

  listPlans = async (_req: Request, res: Response): Promise<void> => {
    const plans = await this.service.listPlans();
    res.json({ success: true, data: { plans } });
  };

  create = async (req: Request, res: Response): Promise<void> => {
    const body = CreateSubscriptionBodySchema.parse(req.body);
    const authed = requireAuthedUser(req);
    const result = await this.service.create({
      userId: new Types.ObjectId(authed.sub),
      tier: body.tier,
    });
    res.json({ success: true, data: result });
  };

  verify = async (req: Request, res: Response): Promise<void> => {
    const body = VerifySubscriptionBodySchema.parse(req.body);
    const result = await this.service.verify(body);
    res.json({ success: true, data: result });
  };

  cancel = async (req: Request, res: Response): Promise<void> => {
    const { id } = SubscriptionIdParamsSchema.parse(req.params);
    const body = CancelSubscriptionBodySchema.parse(req.body);
    const authed = requireAuthedUser(req);
    await this.service.cancel({
      userId: new Types.ObjectId(authed.sub),
      subscriptionId: id,
      atCycleEnd: body.atCycleEnd,
    });
    res.json({ success: true, data: { ok: true } });
  };

  listMine = async (req: Request, res: Response): Promise<void> => {
    const authed = requireAuthedUser(req);
    const items = await this.service.listMine(new Types.ObjectId(authed.sub));
    res.json({ success: true, data: { items } });
  };

  listInvoices = async (req: Request, res: Response): Promise<void> => {
    const { id } = SubscriptionIdParamsSchema.parse(req.params);
    const authed = requireAuthedUser(req);
    const items = await this.service.listInvoices(new Types.ObjectId(authed.sub), id);
    res.json({ success: true, data: { items } });
  };
}
