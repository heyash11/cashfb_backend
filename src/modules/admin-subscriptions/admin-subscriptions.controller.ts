import type { Request, Response } from 'express';
import type {
  AdminListSubscriptionsFilter,
  AdminSubscriptionService,
} from '../subscriptions/subscriptions.admin.service.js';
import {
  AdminSubscriptionsListQuerySchema,
  AdminSubscriptionsRevenueQuerySchema,
} from './admin-subscriptions.schemas.js';

export class AdminSubscriptionsController {
  constructor(private readonly service: AdminSubscriptionService) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const q = AdminSubscriptionsListQuerySchema.parse(req.query);
    const filter: AdminListSubscriptionsFilter = {};
    if (q.tier) filter.tier = q.tier;
    if (q.status) filter.status = q.status;
    const result = await this.service.listAll(filter, q.cursor, q.limit);
    res.json({ success: true, data: result });
  };

  revenue = async (req: Request, res: Response): Promise<void> => {
    const q = AdminSubscriptionsRevenueQuerySchema.parse(req.query);
    const report = await this.service.getRevenueReport(q.from, q.to);
    res.json({ success: true, data: report });
  };
}
